// 짧은 공유 링크(?t=·?m=) + 공유 탭 팀 선택·두 팀 매치업 링크 실서버 점검
// 사용: node verify/fm-share-short-links-live.mjs https://bmrgoodway.github.io/fm/
// 주의: 공유 코드 발급(INSERT)은 누르지 않습니다 — 이미 있는 두 팀(4GT4F5·NUCAD9)만 씁니다.
import { chromium } from 'playwright';

const BASE = (process.argv[2] || 'https://bmrgoodway.github.io/fm/').replace(/\/?$/, '/');
const EXE = '/workspace/.pw/chromium_headless_shell-1255/chrome-headless-shell-linux64/chrome-headless-shell';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const errs = [];
let fails = 0;
const ok = (c, l, d = '') => { console.log(`${c ? '  ✅' : '  ❌'} ${l}${d ? ` — ${d}` : ''}`); if (!c) fails += 1; };

const browser = await chromium.launch({ executablePath: EXE, args: ['--no-sandbox', '--disable-dev-shm-usage', '--hide-scrollbars'] });

function watch(page, tag = '') {
  page.on('pageerror', (e) => errs.push(`${tag}pageerror: ${e.message}`));
  page.on('console', (m) => { if (m.type() === 'error') errs.push(`${tag}console: ${m.text()}`); });
}

async function open(path = '', viewport = { width: 1440, height: 950 }) {
  const ctx = await browser.newContext({ viewport, locale: 'ko-KR', permissions: ['clipboard-read', 'clipboard-write'] });
  const page = await ctx.newPage();
  watch(page, path ? `[${path.slice(0, 16)}] ` : '');
  await page.goto(BASE + path, { waitUntil: 'networkidle', timeout: 60000 });
  return { ctx, page };
}
const teamsOf = (page) => page.evaluate(() => JSON.parse(localStorage.getItem('fm:customTeams') || '{}').list || []);

/* ── 1) 짧은 팀 링크 ?t=CODE ───────────────────────────────── */
console.log('\n[1] 짧은 팀 링크 ?t=NUCAD9');
{
  const { ctx, page } = await open('?t=NUCAD9');
  await sleep(1500);
  const list = await teamsOf(page);
  ok(list.length === 1 && list[0].code === 'NUCAD9', '?t=NUCAD9 로 그 팀이 바로 불러와집니다', `${list[0]?.name} · ${list[0]?.code}`);
  ok(!page.url().includes('?t='), '주소창은 정리됩니다', page.url());
  await ctx.close();
}

/* ── 2) 짧은 매치업 링크 ?m=A:B ────────────────────────────── */
console.log('\n[2] 짧은 매치업 링크 ?m=NUCAD9:4GT4F5');
{
  const { ctx, page } = await open('?m=NUCAD9:4GT4F5');
  await sleep(2500);
  const list = await teamsOf(page);
  const msg = (await page.locator('.cm-msg').first().textContent().catch(() => '')) || '';
  ok(list.some((t) => t.code === 'NUCAD9') && list.some((t) => t.code === '4GT4F5'), '두 팀이 함께 불러와집니다', `${list.length}개 팀`);
  ok((await page.locator('[data-act="cm-tab"][data-tab="match"]').getAttribute('aria-selected')) === 'true', '매치업 탭이 열린 채로 시작합니다');
  ok(/vs/.test(msg), '「A vs B」 안내가 뜹니다', msg.trim().slice(0, 60));
  ok(!page.url().includes('?m='), '주소창은 정리됩니다', page.url());
  const myName = (await page.locator('.cm-vs-team').first().textContent().catch(() => '')).replace(/\s+/g, ' ').trim();
  const oppName = await page.locator('[data-mu="opp"]').evaluate((el) => el.options[el.selectedIndex]?.textContent || '').catch(() => '');
  ok(/11학년/.test(myName) && /교사팀/.test(oppName), '앞 팀은 내 팀, 뒤 팀은 상대로 자동으로 앉습니다', `${myName.slice(0, 24)} vs ${oppName.trim()}`);
  await ctx.close();
}

/* ── 3) 예전 링크 호환 ─────────────────────────────────────── */
console.log('\n[3] 예전 링크 ?team= · ?match= 호환');
{
  const a = await open('?team=4GT4F5');
  await sleep(1500);
  const la = await teamsOf(a.page);
  ok(la.length === 1 && la[0].code === '4GT4F5', '예전 ?team=4GT4F5 링크도 그대로 열립니다', la[0]?.name);
  await a.ctx.close();
  const b = await open('?match=NUCAD9:4GT4F5');
  await sleep(2500);
  ok((await teamsOf(b.page)).length === 2 && (await b.page.locator('[data-act="mu-start"]').count()) === 2, '예전 ?match=A:B 링크도 그대로 열립니다');
  await b.ctx.close();
}

/* ── 4) 공유 탭 — 팀 선택 · 코드 배지 · 두 팀 링크 생성기 ──── */
console.log('\n[4] 공유·불러오기 탭 — 팀 선택·코드 배지·매치업 링크 생성기');
const { ctx, page } = await open('?m=NUCAD9:4GT4F5');
await sleep(2500);                       // 두 팀을 내 브라우저에 저장 (사용자 상황과 같게)
await page.locator('[data-act="cm-tab"][data-tab="share"]').click();
await sleep(400);

const shareOpts = await page.locator('[data-cm="share-pick"] option').allTextContents();
ok(shareOpts.length === 2, '공유 카드의 팀 드롭다운에 내 팀 2개가 다 나옵니다', shareOpts.join(' / '));

const badges = await page.locator('.cm-tl-code').allTextContents();
ok(badges.includes('NUCAD9') && badges.includes('4GT4F5'), '「내 팀」 목록에 두 팀의 6자리 코드가 모두 보입니다', badges.join(' / '));

const copyBtns = await page.locator('.cm-tl-acts button').allTextContents();
ok(copyBtns.filter((t) => t.trim() === '코드 복사').length === 2 && copyBtns.filter((t) => t.trim() === '링크 복사').length === 2,
  '팀마다 「코드 복사」·「링크 복사」 버튼이 있습니다', copyBtns.join(' / '));

const vsLink0 = (await page.locator('.cm-vs-out code').first().textContent().catch(() => '')).trim();
const vsFull0 = (await page.locator('.cm-vs-full').first().textContent().catch(() => '')).trim();
ok(/^\?m=[A-Z0-9]{6}:[A-Z0-9]{6}$/.test(vsLink0) && /^https:\/\/bmrgoodway\.github\.io\/fm\/\?m=[A-Z0-9]{6}:[A-Z0-9]{6}$/.test(vsFull0),
  '팀 A vs 팀 B 기본값으로 ?m=A:B 짧은 링크가 만들어집니다', `${vsLink0} → ${vsFull0}`);

// 팀 A 를 드롭다운으로 바꾸면 링크도 바뀌는지 (탭 이동 없이)
const curA = await page.locator('[data-cm="vs"][data-side="a"]').inputValue();
const otherA = (await page.locator('[data-cm="vs"][data-side="a"] option').evaluateAll((els) => els.map((e) => e.value))).find((v) => v !== curA);
await page.locator('[data-cm="vs"][data-side="a"]').selectOption(otherA);
await sleep(300);
const vsLink1 = (await page.locator('.cm-vs-out code').first().textContent().catch(() => '')).trim();
const vsFull1 = (await page.locator('.cm-vs-full').first().textContent().catch(() => '')).trim();
ok(vsLink1 !== vsLink0 && /^\?m=/.test(vsLink1), '팀 A 를 바꾸면 ?m 링크가 바로 다시 만들어집니다', vsLink1);

// 복사 버튼 → 클립보드에 실제로 들어가는지 (복사되는 값은 전체 주소)
await page.locator('.cm-vs-out [data-act="cm-copy"]').click();
await sleep(400);
const clip = await page.evaluate(() => navigator.clipboard.readText().catch(() => ''));
ok(clip === vsFull1 && /^https:\/\/bmrgoodway\.github\.io\/fm\/\?m=/.test(clip), '「복사」를 누르면 매치업 링크가 클립보드에 들어갑니다', clip);
const toastText = (await page.locator('#toast').textContent().catch(() => '')).trim();
ok(/복사/.test(toastText), '복사 안내 토스트가 뜹니다', toastText);

// 공유 카드에서 팀 전환 → 코드 상자가 그 팀 코드로 바뀌는지
const sharePick = page.locator('[data-cm="share-pick"]');
const curPick = await sharePick.inputValue();
const otherPick = (await sharePick.locator('option').evaluateAll((els) => els.map((e) => e.value))).find((v) => v !== curPick);
await sharePick.selectOption(otherPick);
await sleep(400);
const codeBox = (await page.locator('.cm-code-val').textContent().catch(() => '')).trim();
const expected = (await teamsOf(page)).find((t) => t.id === otherPick)?.code;
ok(codeBox === expected, '공유할 팀을 바꾸면 그 팀의 공유 코드·링크가 바로 나옵니다', `${codeBox} (기대 ${expected})`);
const linkLine = (await page.locator('.cm-code p.sm').textContent().catch(() => '')).trim();
ok(linkLine === `https://bmrgoodway.github.io/fm/?t=${expected}`, '공유 링크가 ?t=CODE 짧은 모양입니다', linkLine);

// 「내 팀」에서 코드 복사 버튼도 동작
await page.locator('.cm-tl-acts [data-act="cm-copy"]').first().click();
await sleep(300);
const clip2 = await page.evaluate(() => navigator.clipboard.readText().catch(() => ''));
ok(/^([A-Z0-9]{6}|https:\/\/bmrgoodway\.github\.io\/fm\/\?t=)/.test(clip2), '「내 팀」의 복사 버튼도 코드/링크를 복사합니다', clip2);

// 데스크톱 스크린샷 — 두 팀이 코드 배지와 함께 다 보이는 상태
await page.screenshot({ path: '/workspace/downloads/fm-share-short-links.png', fullPage: true });

// 코드가 없는 팀은 그 자리에서 발급 안내 (발급은 누르지 않음 — 서버에 행을 남기지 않기 위해)
await page.locator('[data-act="cm-tab"][data-tab="build"]').click();
await sleep(300);
await page.locator('[data-act="cm-new"]').first().click();
await sleep(400);
await page.locator('[data-act="cm-tab"][data-tab="share"]').click();
await sleep(400);
const nocode = await page.locator('.cm-tl-nocode').count();
ok(nocode >= 1, '공유하지 않은 팀은 「공유 안 함」으로 구분해 보여 줍니다', `${nocode}개`);

// 두 팀 매치업 링크 카드에서 코드 없는 팀을 고르면 발급 안내
const noCodeVal = await page.locator('[data-cm="vs"][data-side="b"] option').evaluateAll((els) => (els.find((e) => /코드 없음/.test(e.textContent)) || {}).value || '');
if (noCodeVal) {
  await page.locator('[data-cm="vs"][data-side="b"]').selectOption(noCodeVal);
  await sleep(400);
  const vsNote = (await page.locator('.cm-vs-out.off').textContent().catch(() => '')).replace(/\s+/g, ' ').trim();
  const fixBtn = await page.locator('.cm-vs-out.off [data-act="cm-publish"]').count();
  ok(/공유 코드가 없습니다/.test(vsNote) && fixBtn === 1, '코드가 없는 팀은 링크 대신 그 자리 발급 버튼이 뜹니다', vsNote.slice(0, 70));
} else {
  ok(false, '코드가 없는 팀이 매치업 선택지에 나옵니다');
}

/* ── 5) 모바일 390px 가로 넘침 ────────────────────────────── */
console.log('\n[5] 모바일 390px — 가로 넘침·버튼 배치');
const m = await open('?m=NUCAD9:4GT4F5', { width: 390, height: 844 });
await sleep(2500);
await m.page.locator('[data-act="cm-tab"][data-tab="share"]').click();
await sleep(500);
const overflow = await m.page.evaluate(() => ({
  doc: document.documentElement.scrollWidth - document.documentElement.clientWidth,
  wide: [...document.querySelectorAll('.cm-team-row, .cm-vs-pick, .cm-code, .cm-team-list')]
    .map((el) => Math.round(el.getBoundingClientRect().right - document.documentElement.clientWidth))
    .filter((x) => x > 1),
}));
ok(overflow.doc <= 0, '390px 에서 가로 넘침이 없습니다', `넘침 ${overflow.doc}px`);
ok(overflow.wide.length === 0, '카드·매치업 선택 줄이 화면 밖으로 나가지 않습니다', `${overflow.wide.join(',')}`);
const vsVis = await m.page.locator('.cm-vs-side select').count();
ok(vsVis === 2, '모바일에서도 팀 A·팀 B 선택이 두 칸 다 보입니다');
const mLinks = (await m.page.locator('.cm-vs-out code').first().textContent().catch(() => '')).trim();
ok(/^\?m=[A-Z0-9]{6}:[A-Z0-9]{6}$/.test(mLinks), '모바일에서도 ?m 짧은 링크가 만들어집니다', mLinks);

/* ── 6) 긴 링크(?t=Z…) — 서버 없이 팀 전체를 링크에 ── */
console.log('\n[6] 긴 링크 — ?t=Z… 로 팀 전체 담기');
{
  const a = await open('?m=NUCAD9:4GT4F5');
  await sleep(2500);
  await a.page.locator('[data-act="cm-tab"][data-tab="share"]').click();
  await sleep(400);
  await a.page.locator('[data-act="cm-longlink"]').click();
  await sleep(600);
  const long = (await a.page.locator('[data-cm="longlink"] code').textContent().catch(() => '')).trim();
  ok(/^https:\/\/bmrgoodway\.github\.io\/fm\/\?t=Z.{40,}$/.test(long), '긴 링크도 ?t=Z… 형식입니다', `${long.length}자`);
  await a.ctx.close();
  const b = await open(long.slice(long.indexOf('?')));
  await sleep(2000);
  const firstName = await b.page.locator('.cp-name').first().inputValue().catch(() => '');
  const loadedMsg = await b.page.evaluate(() => (document.querySelector('.cm-msg')?.textContent || '').trim());
  ok(/공유받은|불러왔|업데이트/.test(loadedMsg) && !!firstName, '긴 링크를 열면 그 팀이 서버 없이 열립니다', `${firstName} · ${loadedMsg.slice(0, 40)}`);
  await b.ctx.close();
}


/* ── 6) 스크린샷 ──────────────────────────────────────────── */
await m.page.screenshot({ path: '/workspace/downloads/fm-share-short-links-mobile.png', fullPage: true });
console.log('\n스크린샷: downloads/fm-share-short-links.png (데스크톱·[4]) · downloads/fm-share-short-links-mobile.png');

ok(errs.length === 0, '콘솔 오류 0건', errs.slice(0, 3).join(' | ') || '오류 없음');

await ctx.close();
await m.ctx.close();
await browser.close();
console.log(`\n${fails ? `❌ ${fails}개 점검 실패` : '✅ 모든 점검 통과'}\n`);
process.exit(fails ? 1 : 0);
