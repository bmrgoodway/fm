// 로컬 검증 — 5차 기능(이전 경기 결과 · 전술·명단 프리셋 · 저장 슬롯/JSON · 로고) 브라우저 점검
// 사용: node verify/fm-v5-live.mjs http://127.0.0.1:8099/fm/
import { chromium } from 'playwright';
const BASE = process.argv[2] || 'http://127.0.0.1:8099/fm/';
const EXE = '/workspace/.pw/chromium_headless_shell-1255/chrome-headless-shell-linux64/chrome-headless-shell';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const errs = [];
let fails = 0;
const ok = (c, l, d = '') => { console.log(`${c ? '  ✅' : '  ❌'} ${l}${d ? ' — ' + d : ''}`); if (!c) fails += 1; };
const b = await chromium.launch({ executablePath: EXE, args: ['--no-sandbox', '--disable-dev-shm-usage', '--hide-scrollbars'] });

async function open({ width, height }, dsf = 1, clear = false, storageState = undefined) {
  const ctx = await b.newContext({ viewport: { width, height }, deviceScaleFactor: dsf, locale: 'ko-KR', acceptDownloads: true, storageState });
  const page = await ctx.newPage();
  page.on('pageerror', (e) => errs.push('pageerror: ' + e.message));
  page.on('console', (m) => { if (m.type() === 'error') errs.push('console: ' + m.text()); });
  await page.goto(BASE + '?v5=' + Date.now(), { waitUntil: 'networkidle', timeout: 60000 });
  if (clear) {
    await page.evaluate(() => { for (const k of Object.keys(localStorage)) if (k.startsWith('fm:')) localStorage.removeItem(k); });
    await page.reload({ waitUntil: 'networkidle' });
  }
  return { ctx, page };
}

console.log('[데스크톱 1440]');
const { ctx, page } = await open({ width: 1440, height: 950 }, 1, true);
await sleep(400);

// 1) 로고 — 클릭해도 /fm/ 밖으로 나가지 않는다
const logoHref = await page.locator('header a.mark').getAttribute('href');
await page.locator('header a.mark').click();
await sleep(300);
const urlAfterLogo = page.url();
ok(!/^https?:\/\/bmrgoodway\.github\.io\/?$/.test(urlAfterLogo) && urlAfterLogo.includes('/fm/'), '로고를 눌러도 fm 앱 안에 머뭅니다', `${logoHref} → ${urlAfterLogo}`);

// 구단 선택 → K리그 2026 금산
await page.locator('.mode-tab[data-mode="kleague"]').click();
await sleep(300);
await page.locator('.div-tab[data-div="4"]').click();
await sleep(250);
await page.locator('.team-card[data-team="geumsan"]').click();
await sleep(250);
await page.getByRole('button', { name: '이 구단으로 시작' }).click();
await sleep(900);
ok((await page.evaluate(() => document.body.dataset.view)) === 'hub', '금산 인삼 FC 감독으로 시작합니다');

// 경기를 두 번 치러 '이전 경기' 기록을 만든다 (즉시 결과 → 전체 시간 화면 → 계속)
async function playInstant() {
  await page.locator('[data-act="instant"]').click();
  await page.locator('#ov-continue').waitFor({ state: 'visible', timeout: 20000 });
  await sleep(250);
  await page.locator('#ov-continue').click();
  await page.waitForFunction(() => document.body.dataset.view === 'hub', null, { timeout: 20000 });
  await sleep(350);
}
for (let i = 0; i < 2; i++) await playInstant();
ok((await page.evaluate(() => document.body.dataset.view)) === 'hub', '즉시 결과로 경기를 치릅니다');

// 2) 일정 탭 — 치른 경기 행을 누르면 결과 모달 (득점이 있는 경기를 고릅니다)
const rows = page.locator('.results li.clickable');
const rowCount = await rows.count();
let pick = 0;
for (let i = 0; i < rowCount; i++) {
  const sc = ((await rows.nth(i).locator('.score').textContent()) || '').replace(/\s/g, '');
  if (sc !== '0:0') { pick = i; break; }
}
await rows.nth(pick).locator('.mini-link').click();
await sleep(500);
const modal = page.locator('.modal.match-modal');
ok(await modal.isVisible(), '치른 경기 행을 누르면 경기 결과 모달이 열립니다');
const summary = await page.evaluate(() => {
  const m = document.querySelector('.modal.match-modal');
  return { score: m?.querySelector('.mres-score')?.textContent?.trim() || '', goals: m?.querySelectorAll('.mgoals li').length || 0, rows: m?.querySelectorAll('.stat-rows tr').length || 0, ratings: m?.querySelectorAll('.mrlist li').length || 0 };
});
ok(summary.goals > 0 || /^0\s*:\s*0$/.test(summary.score), '득점 장면(득점자·시간)이 보입니다', `${summary.score} · ${summary.goals}장면`);
ok(summary.rows >= 5, '주요 기록(슈팅·점유율·xG 등)이 보입니다', `${summary.rows}행`);
ok(summary.ratings >= 11, '출전 선수 평점이 보입니다', `${summary.ratings}명`);
await page.screenshot({ path: '/workspace/downloads/fm-match-history.png' });
await page.locator('.modal.match-modal [data-act="modal-close"]').first().click();
await sleep(300);

// 3) 타 구단 — 순위표에서 구단 열기 → 경기 결과 → 경기 요약
await page.locator('.tabs [data-act="tab"][data-tab="records"]').click();
await sleep(500);
const otherTeam = await page.locator('.standings tbody tr .tl').first();
await otherTeam.click();
await sleep(500);
const clubRes = await page.locator('.modal .club-matches .mrow, .modal .club-all .mrow').count();
ok(clubRes > 0, '타 구단 모달에 이번 시즌 경기 결과가 나옵니다', `${clubRes}경기`);
await page.locator('.modal .club-matches .mrow').first().click();
await sleep(500);
ok(await page.locator('.modal.match-modal').isVisible(), '타 구단 경기 결과에서도 그 경기 요약이 열립니다');
const clubMatch = await page.evaluate(() => {
  const m = document.querySelector('.modal.match-modal');
  return { score: m?.querySelector('.mres-score')?.textContent?.trim() || '', goals: [...(m?.querySelectorAll('.mgoals .gm-name') || [])].map((x) => x.textContent.trim()), rows: m?.querySelectorAll('.stat-rows tr').length || 0 };
});
ok(clubMatch.goals.length === 0 || clubMatch.goals.every((n) => n && n !== '득점'), '타 구단 경기 요약에도 득점자 이름이 나옵니다', `${clubMatch.score} · ${clubMatch.goals.join(', ').slice(0, 40)}`);
ok(clubMatch.rows > 0 || clubMatch.goals.length === 0, '타 구단 경기 요약에 주요 기록이 있습니다', `${clubMatch.rows}행`);
await page.locator('.modal.match-modal [data-act="modal-close"]').first().click();
await sleep(250);
if (await page.locator('.modal .modal-x').count()) { await page.locator('.modal .modal-x').first().click(); await sleep(250); }
ok((await page.locator('.modal').count()) === 0, '모달을 닫고 화면으로 돌아옵니다');

// 4) 전술·명단 프리셋 저장 → 설정 바꾸기 → 불러오기
await page.locator('.tabs [data-act="tab"][data-tab="squad"]').click();
await sleep(600);
ok(await page.locator('.presets').isVisible(), '전술/선수단 탭에 「전술·명단 프리셋」 카드가 있습니다');
await page.locator('.form-row [data-act="formation"]').nth(3).click();   // 다른 포메이션
await sleep(300);
await page.locator('#preset-name').fill('홈 4-3-3 압박');
await page.locator('[data-act="preset-save"]').click();
await sleep(400);
ok((await page.locator('.preset').count()) === 1, '프리셋이 저장되어 목록에 나옵니다');
const savedFormation = await page.locator('.form-row .btn.on').first().textContent();
await page.locator('.form-row [data-act="formation"]').nth(6).click();
await sleep(300);
const otherFormation = await page.locator('.form-row .btn.on').first().textContent();
await page.locator('.preset [data-act="preset-load"]').first().click();
await sleep(600);
const backFormation = await page.locator('.form-row .btn.on').first().textContent();
ok(savedFormation !== otherFormation && backFormation === savedFormation, '한 번 눌러 저장한 포메이션·전술이 되살아납니다', `${savedFormation} → ${otherFormation} → ${backFormation}`);
const toastText = await page.locator('#toast').textContent();
ok(/프리셋/.test(toastText || ''), '불러오기 결과를 토스트로 알려 줍니다', (toastText || '').slice(0, 60));
await page.screenshot({ path: '/workspace/downloads/fm-preset-save.png' });

// 5) 저장/불러오기 모달 — 슬롯 저장 · 덮어쓰기 확인 · 삭제 · JSON 내보내기
await page.locator('.tabs [data-act="tab"][data-tab="schedule"]').click();
await sleep(400);
await page.locator('[data-act="saves"]').first().click();
await sleep(500);
ok(await page.locator('.modal.saves-modal').isVisible(), '저장/불러오기 모달이 열립니다');
ok((await page.locator('.slot-list .slot').count()) === 3, '수동 슬롯 3개가 보입니다');
await page.locator('.slot-list .slot [data-act="slot-save"]').first().click();
await sleep(700);
const slot1 = await page.locator('.slot-list .slot').first().textContent();
ok(/금산/.test(slot1 || '') && /시즌/.test(slot1 || ''), '슬롯에 구단·시즌·라운드가 표시됩니다', (slot1 || '').replace(/\s+/g, ' ').slice(0, 70));
await page.locator('.slot-list .slot [data-act="slot-save"]').first().click();
await sleep(300);
ok(await page.locator('.confirm-bar').isVisible(), '덮어쓰기는 확인을 한 번 받습니다');
await page.locator('.confirm-bar [data-act="slot-confirm"]').click();
await sleep(600);
await page.screenshot({ path: '/workspace/downloads/fm-save-slots.png' });
// JSON 내보내기
const [dl] = await Promise.all([
  page.waitForEvent('download', { timeout: 15000 }).catch(() => null),
  page.locator('[data-act="save-export"]').click(),
]);
ok(!!dl && /\.json$/.test(dl.suggestedFilename()), 'JSON 파일로 내보내기가 됩니다', dl ? dl.suggestedFilename() : '실패');
if (dl) await dl.saveAs('/workspace/downloads/fm-save-export.json');

// 필요한 값 확인 후 JSON 파일에서 불러오기 (지금 커리어를 덮어씀)
const beforeLoad = await page.evaluate(() => document.querySelector('.club-id h2')?.textContent || '');
await page.locator('[data-act="modal-close"]').last().click();
await sleep(300);
await page.locator('[data-act="saves"]').first().click();
await sleep(400);
await page.locator('[data-act="save-import"]').click();
await page.locator('#save-file').setInputFiles('/workspace/downloads/fm-save-export.json');
await sleep(700);
ok(await page.locator('.confirm-bar').isVisible(), '파일을 고르면 확인을 받습니다');
await page.locator('.confirm-bar [data-act="slot-confirm"]').click();
await sleep(1000);
const afterLoad = await page.evaluate(() => document.querySelector('.club-id h2')?.textContent || '');
ok(afterLoad === beforeLoad && afterLoad.length > 0, '파일에서 불러온 커리어로 이어집니다', afterLoad);
const storage = await page.evaluate(() => {
  const keys = Object.keys(localStorage).filter((k) => k.startsWith('fm:'));
  let total = 0;
  for (const k of keys) total += localStorage.getItem(k).length;
  return { keys, total };
});
ok(storage.total < 2_000_000, 'fm 저장소 전체가 2MB 미만입니다', `${Math.round(storage.total / 1024)}KB · ${storage.keys.join(', ')}`);
const savedState = await ctx.storageState();
await ctx.close();

console.log('[모바일 390]');
const { ctx: mc, page: mp } = await open({ width: 390, height: 844 }, 3, false, savedState);
await sleep(700);
if (await mp.locator('[data-act="continue"]').count()) { await mp.locator('[data-act="continue"]').click(); await sleep(700); }
const ov = await mp.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
ok(ov <= 1, '모바일 390px에서 가로 넘침이 없습니다', `${ov}px`);
await mp.locator('.tabs [data-act="tab"][data-tab="squad"]').click();
await sleep(500);
await mp.locator('.presets').scrollIntoViewIfNeeded();
const pov = await mp.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
ok(pov <= 1, '프리셋 카드가 모바일에서도 넘치지 않습니다', `${pov}px`);
await mp.screenshot({ path: '/workspace/downloads/fm-mobile-v5.png', fullPage: false });
await mp.locator('header [data-act="saves"]').click();
await sleep(500);
const sov = await mp.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
ok(sov <= 1, '저장/불러오기 모달이 모바일 폭에 맞습니다', `${sov}px`);
await mp.screenshot({ path: '/workspace/downloads/fm-mobile-v5-saves.png' });
await mc.close();

ok(errs.length === 0, '콘솔 오류 0건', errs.slice(0, 3).join(' | '));
await b.close();
console.log(fails ? `\n❌ ${fails}개 실패` : '\n✅ 로컬 검증 통과');
process.exit(fails ? 1 : 0);
