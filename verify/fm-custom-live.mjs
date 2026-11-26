// 커스텀 매치업 실서버 점검 — 팀 빌더 · 공유 코드/링크 · 2D 가상 경기 · 커리어 분리 · 모바일 폭
// 사용: node verify/fm-custom-live.mjs https://bmrgoodway.github.io/fm/
import { chromium } from 'playwright';

const BASE = (process.argv[2] || 'https://bmrgoodway.github.io/fm/').replace(/\/?$/, '/');
const EXE = '/workspace/.pw/chromium_headless_shell-1255/chrome-headless-shell-linux64/chrome-headless-shell';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const errs = [];
let fails = 0;
const ok = (c, l, d = '') => { console.log(`${c ? '  ✅' : '  ❌'} ${l}${d ? ` — ${d}` : ''}`); if (!c) fails += 1; };

const browser = await chromium.launch({ executablePath: EXE, args: ['--no-sandbox', '--disable-dev-shm-usage', '--hide-scrollbars'] });

function watch(page) {
  page.on('pageerror', (e) => errs.push(`pageerror: ${e.message}`));
  page.on('console', (m) => { if (m.type() === 'error') errs.push(`console: ${m.text()}`); });
}

async function open(opts = {}, path = '') {
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 950 }, locale: 'ko-KR', acceptDownloads: true });
  const page = await ctx.newPage();
  watch(page);
  await page.goto(BASE + path, { waitUntil: 'networkidle', timeout: 60000 });
  return { ctx, page };
}

const clearFm = (page) => page.evaluate(() => { for (const k of Object.keys(localStorage)) if (k.startsWith('fm:')) localStorage.removeItem(k); });

/* ── 1) 팀 빌더 ─────────────────────────────────────────────── */
console.log('\n[1] 팀 빌더 — 5인제 풋살 팀 만들기');
const { ctx, page } = await open();
await clearFm(page);
await page.reload({ waitUntil: 'networkidle' });

ok(await page.locator('.mode-tab[data-mode="matchup"]').count() === 1, '시작 화면에 「커스텀 매치업」 탭이 있습니다');
await page.locator('.mode-tab[data-mode="matchup"]').click();
await sleep(300);
ok(await page.locator('.cm-head h1').count() === 1, '커스텀 매치업 화면이 열립니다',
  (await page.locator('.cm-head h1').textContent())?.trim());

await page.locator('[data-act="cm-new"]').first().click();
await sleep(300);
ok(await page.locator('.cp-row').count() === 11, '새 팀은 11인제 11자리로 시작합니다', `행 ${await page.locator('.cp-row').count()}`);

// 팀 이름·5인제·포메이션
await page.locator('[data-cm="name"]').fill('별무리 풋살단');
await page.locator('[data-cm="short"]').fill('별풋');
await page.locator('[data-act="cm-size"][data-size="5"]').click();
await sleep(250);
ok(await page.locator('.cp-row').count() === 5, '5인제로 바꾸면 선수 자리가 5개가 됩니다', `${await page.locator('.cp-row').count()}자리`);
await page.locator('[data-act="cm-formation"][data-formation="2-2"]').click();
await sleep(200);
const slots = await page.locator('.cp-row select[data-cp="slot"]').evaluateAll((els) => els.map((e) => e.value));
ok(slots.join(',') === 'GK,CB,CB,ST,ST', '2-2 포메이션 자리(GK·CB·CB·ST·ST)로 바뀝니다', slots.join(','));

// 일괄 입력
await page.locator('[data-act="cm-bulk-open"]').click();
await sleep(150);
await page.locator('[data-cm="bulk"]').fill('김철수 ST 84\n이영희 CB 79\n박민수,ST,76');
await page.locator('[data-act="cm-bulk-apply"]').click();
await sleep(300);
const names = await page.locator('[data-cp="name"]').evaluateAll((els) => els.map((e) => e.value));
ok(names.filter(Boolean).length === 3 && names.includes('김철수'), '붙여넣은 3명이 명단에 들어갑니다', names.join(', '));

// 자동 채우기
await page.locator('[data-act="cm-autofill"]').click();
await sleep(300);
const allNamed = await page.locator('[data-cp="name"]').evaluateAll((els) => els.every((e) => e.value.trim().length > 0));
const filled = await page.locator('.cp-ovr-val').evaluateAll((els) => els.map((e) => e.textContent.trim()));
ok(allNamed, '빈 자리 2곳을 기본 선수로 채웁니다');
ok(filled.every((v) => Number(v) >= 40 && Number(v) <= 95), '모든 선수에게 종합이 계산됩니다', filled.join(' · '));

// 저장
await page.locator('[data-act="cm-save"]').click();
await sleep(300);
const saved = await page.evaluate(() => JSON.parse(localStorage.getItem('fm:customTeams') || '{}'));
ok(Array.isArray(saved.list) && saved.list.length === 1 && saved.list[0].size === 5 && saved.list[0].players.length === 5,
  '팀이 브라우저(localStorage)에 저장됩니다', `${saved.list?.[0]?.name} · ${saved.list?.[0]?.size}인제`);

// 삭제는 한 번 더 확인 (실수 방지)
await page.locator('.cm-picker [data-act="cm-delete"]').click();
await sleep(250);
ok(await page.locator('.cm-confirm').count() === 1, '팀 삭제는 한 번 더 확인합니다');
await page.locator('[data-act="cm-delete-cancel"]').click();
await sleep(250);
ok(await page.locator('.cm-confirm').count() === 0 && await page.locator('.cp-row').count() === 5, '삭제를 취소하면 팀이 그대로 남습니다');

/* ── 2) 공유 코드 ───────────────────────────────────────────── */
console.log('\n[2] 공유 — 6자리 코드 발급 · 코드로 불러오기');
await page.locator('[data-act="cm-tab"][data-tab="share"]').click();
await sleep(200);
await page.locator('[data-act="cm-publish"]').click();
await page.waitForSelector('.cm-code-val', { timeout: 20000 });
const code = (await page.locator('.cm-code-val').textContent()).trim();
ok(/^[A-Z0-9]{6,8}$/.test(code), '6~8자리 공유 코드를 받습니다', code);
const link = await page.locator('.cm-code p.sm').first().textContent();
ok(link.includes(`?team=${code}`), '공유 링크가 ?team=CODE 모양입니다', link.trim());

// 새 브라우저(친구) — 코드로 불러오기
const { ctx: ctx2, page: page2 } = await open();
await clearFm(page2);
await page2.reload({ waitUntil: 'networkidle' });
await page2.locator('.mode-tab[data-mode="matchup"]').click();
await sleep(250);
await page2.locator('[data-act="cm-new"]').first().click();
await sleep(200);
await page2.locator('[data-act="cm-tab"][data-tab="share"]').click();
await sleep(150);
await page2.locator('[data-cm="code"]').fill(code);
await page2.locator('[data-act="cm-load"]').click();
await page2.waitForFunction((c) => (document.body.innerText || '').includes(c), code, { timeout: 20000 }).catch(() => {});
await sleep(500);
const friendTeams = await page2.evaluate(() => JSON.parse(localStorage.getItem('fm:customTeams') || '{}'));
ok(friendTeams.list?.some((t) => t.name === '별무리 풋살단' && t.size === 5 && t.players.length === 5),
  '친구(새 브라우저)가 코드로 팀을 불러와 저장합니다', `${friendTeams.list?.length}개 팀`);

// 링크(?team=)로 바로 열기
const { ctx: ctx3, page: page3 } = await open({}, `?team=${code}`);
await sleep(1200);
const linkOpened = await page3.locator('.cm-head h1').count() === 1;
const linkTeam = await page3.evaluate(() => JSON.parse(localStorage.getItem('fm:customTeams') || '{}').list?.[0]?.name || '');
ok(linkOpened && linkTeam === '별무리 풋살단', '공유 링크(?team=)로 열면 그 팀이 바로 불러와집니다', linkTeam);

// 두 팀을 함께 여는 ?match=A:B — 친구 쪽에서 받은 팀을 그대로 공유해 코드를 하나 더 받습니다
await page2.locator('[data-act="cm-tab"][data-tab="share"]').click();
await sleep(250);
await page2.locator('[data-act="cm-publish"]').first().click();
await page2.waitForSelector('.cm-code-val', { timeout: 20000 });
const code2 = (await page2.locator('.cm-code-val').textContent()).trim();
ok(/^[A-Z0-9]{6,8}$/.test(code2), '친구도 받은 팀을 그대로 다시 공유할 수 있습니다', code2);
const { ctx: ctx4, page: page4 } = await open({}, `?match=${code}:${code2}`);
await sleep(2000);
const matchOpened = await page4.evaluate(() => (document.querySelector('.cm-msg')?.textContent || '').trim());
ok(await page4.locator('[data-act="mu-start"]').count() === 2 && /vs/.test(matchOpened),
  '매치업 링크(?match=A:B)로 두 팀이 함께 열립니다', `${code}:${code2} · ${matchOpened.slice(0, 40)}`);

/* ── 3) K리그 커리어 세이브와 분리 ───────────────────────────── */
console.log('\n[3] 커스텀 매치업 — 커리어 세이브를 건드리지 않는지');
await page.locator('[data-act="cm-tab"][data-tab="build"]').click();
await sleep(150);
await page.locator('[data-act="home"]').click();
await sleep(300);
await page.locator('.mode-tab[data-mode="kleague"]').click().catch(() => {});
await sleep(200);
if (await page.locator('.div-tab[data-div="4"]').count()) await page.locator('.div-tab[data-div="4"]').click();
await sleep(200);
await page.locator('.team-card[data-team="geumsan"]').click();
await sleep(400);
await page.locator('[data-act="team-sign"]').click();
await sleep(600);
ok(await page.locator('.clubbar').count() === 1, 'K리그 2026 커리어를 시작합니다(금산 인삼 FC)');
const careerBefore = await page.evaluate(() => localStorage.getItem('fm:career'));
const seasonBefore = (await page.locator('.club-stats b').first().textContent() || '').trim();

// 커리어 화면에서 바로 커스텀 매치업으로
ok(await page.locator('[data-act="pick-mode"][data-mode="matchup"]').count() === 1, '허브에서도 커스텀 매치업으로 갈 수 있습니다');
await page.locator('[data-act="pick-mode"][data-mode="matchup"]').click();
await sleep(300);
await page.locator('[data-act="cm-tab"][data-tab="match"]').click();
await sleep(250);
ok(await page.locator('[data-act="mu-start"]').count() === 2, '매치업 준비 화면(중계/즉시)이 그려집니다');
ok(await page.locator('[data-act="cm-setpiece"]').count() === 6, '코너·프리킥 세트피스 지시를 경기 전에 고를 수 있습니다');
await page.locator('[data-act="cm-setpiece"][data-type="corner"][data-key="short"]').click();
await sleep(250);
const spSaved = await page.evaluate(() => JSON.parse(localStorage.getItem('fm:customTeams') || '{}').list?.find((t) => t.size === 5)?.setpiece?.corner);
ok(spSaved === 'short', '고른 세트피스 지시가 팀에 저장됩니다', String(spSaved));

// K리그 구단과 5:5 (즉시 결과)
await page.locator('[data-mu="kl"]').selectOption('seoul');
await sleep(200);
await page.locator('[data-act="mu-start"][data-instant="1"]').click();
await page.waitForSelector('.matchview', { timeout: 20000 });
await sleep(800);
const matchDiag = await page.evaluate(() => ({ home: window.__fm?.match?.sides?.home?.players?.length, away: window.__fm?.match?.sides?.away?.players?.length, offside: window.__fm?.match?.offsideOn }));
ok(matchDiag.home === 5 && matchDiag.away === 5, '5인제 커스텀 팀 vs K리그 구단이 5:5로 붙습니다', `${matchDiag.home}:${matchDiag.away}`);
ok(matchDiag.offside === false, '풋살 경기에는 오프사이드가 꺼집니다');
await page.locator('#ov-continue').click();
await sleep(600);
const scoreText = (await page.locator('.cm-score-num').textContent() || '').replace(/\s+/g, ' ').trim();
ok(/^\d+\s*:\s*\d+/.test(scoreText), '경기 종료 뒤 커스텀 결과 요약이 열립니다', scoreText);
ok(await page.locator('.cm-goals li, .cm-goals').count() >= 1, '득점 목록이 결과에 표시됩니다');
ok(await page.locator('.cm-mom').count() === 1, 'MOM(최우수 선수)이 표시됩니다', (await page.locator('.cm-mom').textContent() || '').replace(/\s+/g, ' ').trim().slice(0, 40));
ok(await page.locator('.cm-stats').count() === 1, '경기 기록 표(점유율·슈팅 등)가 표시됩니다');

// 재대결 버튼이 실제로 경기를 다시 연다
await page.locator('[data-act="mu-rematch"]').click();
await sleep(800);
ok(await page.locator('.matchview').count() === 1, '재대결을 누르면 같은 상대와 다시 경기합니다');

// 즉시 진행(배속 0)으로 끝내기
await page.locator('[data-speed="0"]').click();
await sleep(1500);
await page.locator('#ov-continue').click();
await sleep(500);
await page.locator('[data-act="cm-back"]').click();
await sleep(300);
ok(await page.locator('.cm-head h1').count() === 1, '「커스텀 매치업으로」를 누르면 빌더로 돌아옵니다');

// 커리어 세이브 확인
const careerAfter = await page.evaluate(() => localStorage.getItem('fm:career'));
ok(careerBefore && careerAfter === careerBefore, '커스텀 경기가 K리그 커리어 세이브를 덮어쓰지 않았습니다', `${careerBefore?.length}자`);
await page.locator('[data-act="home"]').click();
await sleep(400);
const seasonAfter = (await page.locator('.club-stats b').first().textContent() || '').trim();
ok(await page.locator('.clubbar').count() === 1 && seasonAfter === seasonBefore, '커리어로 돌아오면 시즌·구단이 그대로입니다', seasonAfter);

/* ── 4) 11인제 커스텀 vs 커스텀 ──────────────────────────────── */
console.log('\n[4] 11인제 — 커스텀 팀 vs 친구 팀');
await page.locator('[data-act="pick-mode"][data-mode="matchup"]').click();
await sleep(200);
await page.locator('[data-act="cm-new"]').first().click();
await sleep(200);
await page.locator('[data-act="cm-size"][data-size="11"]').click();
await sleep(200);
await page.locator('[data-cm="name"]').fill('커리어 옆 11인제');
await page.locator('[data-act="cm-autofill"]').click();
await sleep(300);
await page.locator('[data-act="cm-save"]').click();
await sleep(200);
// 두 번째 팀을 만들어 상대로
await page.locator('[data-act="cm-new"]').first().click();
await sleep(200);
await page.locator('[data-act="cm-size"][data-size="11"]').click();
await sleep(200);
await page.locator('[data-cm="name"]').fill('친구 11인제');
await page.locator('[data-act="cm-autofill"]').click();
await sleep(300);
await page.locator('[data-act="cm-save"]').click();
await sleep(200);
await page.locator('[data-act="cm-tab"][data-tab="match"]').click();
await sleep(200);
await page.locator('[data-act="mu-oppkind"][data-kind="custom"]').click();
await sleep(200);
const oppOptions = await page.locator('[data-mu="opp"] option').evaluateAll((els) => els.map((e) => e.value).filter(Boolean));
ok(oppOptions.length >= 1, '내 팀 목록에서 상대를 고를 수 있습니다', `${oppOptions.length}개`);
await page.locator('[data-act="mu-start"][data-instant="0"]').click();
await page.waitForSelector('.matchview', { timeout: 20000 });
await sleep(2500);
const live = await page.evaluate(() => ({ frames: window.__fm?.frames || 0, t: window.__fm?.match?.t || 0, players: window.__fm?.match?.sides?.home?.players?.length, offside: window.__fm?.match?.offsideOn }));
ok(live.frames > 10 && live.t > 0, '2D 중계가 실제로 프레임을 그리며 진행됩니다', `${live.frames}프레임 · ${live.t}틱`);
ok(live.players === 11 && live.offside === true, '11인제 경기는 11명·오프사이드 판정 그대로입니다', `${live.players}명`);
await page.locator('[data-speed="0"]').click();
await sleep(2000);
await page.locator('#ov-continue').click();
await sleep(600);
ok(await page.locator('.cm-score-num').count() === 1, '11인제 커스텀 vs 커스텀 결과도 요약 화면으로 나옵니다');

/* ── 5) 모바일 390px ────────────────────────────────────────── */
console.log('\n[5] 모바일 390px — 가로 넘침');
const { ctx: mctx, page: mp } = await open();
await mp.setViewportSize({ width: 390, height: 844 });
await clearFm(mp);
await mp.reload({ waitUntil: 'networkidle' });
await mp.locator('.mode-tab[data-mode="matchup"]').click();
await sleep(250);
await mp.locator('[data-act="cm-new"]').first().click();
await sleep(200);
await mp.locator('[data-act="cm-autofill"]').click();
await sleep(300);
const widthBuild = await mp.evaluate(() => ({ sw: document.documentElement.scrollWidth, cw: document.documentElement.clientWidth }));
ok(widthBuild.sw <= widthBuild.cw + 1, '빌더 화면이 390px에서 가로로 넘치지 않습니다', `${widthBuild.sw}/${widthBuild.cw}`);
await mp.locator('[data-act="cm-tab"][data-tab="match"]').click();
await sleep(250);
const widthMatch = await mp.evaluate(() => ({ sw: document.documentElement.scrollWidth, cw: document.documentElement.clientWidth }));
ok(widthMatch.sw <= widthMatch.cw + 1, '매치업 준비 화면이 390px에서 넘치지 않습니다', `${widthMatch.sw}/${widthMatch.cw}`);
await mp.locator('[data-act="mu-start"][data-instant="1"]').click();
await mp.waitForSelector('.matchview', { timeout: 20000 });
await sleep(800);
await mp.locator('#ov-continue').click();
await sleep(500);
const widthResult = await mp.evaluate(() => ({ sw: document.documentElement.scrollWidth, cw: document.documentElement.clientWidth }));
ok(widthResult.sw <= widthResult.cw + 1, '결과 화면도 390px에서 넘치지 않습니다', `${widthResult.sw}/${widthResult.cw}`);

/* ── 정리 ─────────────────────────────────────────────────── */
console.log('\n[콘솔 오류]');
ok(errs.length === 0, '콘솔·페이지 오류가 없습니다', errs.slice(0, 3).join(' | ') || '0건');

await browser.close();
console.log(`\n${fails ? `❌ ${fails}개 실패` : '✅ 모든 점검 통과'}\n`);
process.exit(fails ? 1 : 0);
