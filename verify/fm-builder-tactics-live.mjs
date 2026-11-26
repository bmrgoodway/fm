// 커스텀 매치업 — ① 저장 중복 버그 수정 · ② 팀 만들기 탭 안의 전술 설정 실서버 점검
//   사용: node verify/fm-builder-tactics-live.mjs https://bmrgoodway.github.io/fm/
//         node verify/fm-builder-tactics-live.mjs local          (dist/ 를 로컬에서 서빙해 점검)
//   · 저장 3회 반복해도 「내 팀 N개」가 늘지 않는지 (localStorage 목록까지 확인)
//   · 팀 만들기 탭 전술 카드(대형 보드·자유 대형·성향·4축·역할·세트피스)와 저장/복원
//   · 공유 코드 왕복(tactic.coords·mentality 포함) — 운영 표에는 아무것도 남기지 않음(응답을 브라우저 안에서 대신 만듦)
//   · 같은 공유 링크(?team=)를 여러 번 열어도 팀 사본이 쌓이지 않는지
//   · 모바일 390px 가로 넘침 · 콘솔 오류
import { chromium } from 'playwright';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';

const ARG = process.argv[2] || 'https://bmrgoodway.github.io/fm/';
const EXE = '/workspace/.pw/chromium_headless_shell-1255/chrome-headless-shell-linux64/chrome-headless-shell';
const SHOT = process.env.SHOT_DIR || '/workspace/downloads';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const errs = [];
let fails = 0;
const ok = (c, l, d = '') => { console.log(`${c ? '  ✅' : '  ❌'} ${l}${d ? ` — ${d}` : ''}`); if (!c) fails += 1; };

/* ── 로컬 서빙(dist/) — 배포 전에 같은 점검을 돌려 봅니다 ───────────── */
let server = null;
let BASE = ARG;
if (ARG === 'local') {
  const ROOT = '/workspace/repos/fm/dist';
  const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.woff2': 'font/woff2', '.png': 'image/png', '.svg': 'image/svg+xml', '.json': 'application/json' };
  server = createServer(async (req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    let p = decodeURIComponent(url.pathname).replace(/^\/fm/, '');
    if (p === '' || p === '/') p = '/index.html';
    const file = normalize(join(ROOT, p));
    if (!file.startsWith(ROOT)) { res.writeHead(403).end(); return; }
    try {
      const body = await readFile(file);
      res.writeHead(200, { 'content-type': MIME[extname(file)] || 'application/octet-stream' }).end(body);
    } catch {
      try { res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end(await readFile(join(ROOT, 'index.html'))); }
      catch { res.writeHead(404).end(); }
    }
  });
  await new Promise((r) => server.listen(4179, '127.0.0.1', r));
  BASE = 'http://127.0.0.1:4179/fm/';
}
console.log(`점검 주소: ${BASE}`);

const browser = await chromium.launch({ executablePath: EXE, args: ['--no-sandbox', '--disable-dev-shm-usage', '--hide-scrollbars'] });
const watch = (p) => {
  p.on('pageerror', (e) => errs.push(`pageerror: ${e.message}`));
  p.on('console', (m) => { if (m.type() === 'error') errs.push(`console: ${m.text()}`); });
};
const clearFm = (p) => p.evaluate(() => { for (const k of Object.keys(localStorage)) if (k.startsWith('fm:')) localStorage.removeItem(k); });
const teams = (p) => p.evaluate(() => JSON.parse(localStorage.getItem('fm:customTeams') || '{"list":[]}').list);
const teamCountText = (p) => p.locator('.cm-head-stats > div').first().innerText();

const ctx = await browser.newContext({ viewport: { width: 1440, height: 1000 }, locale: 'ko-KR' });
const page = await ctx.newPage();
watch(page);
await page.goto(BASE, { waitUntil: 'networkidle', timeout: 60000 });
await clearFm(page);
await page.reload({ waitUntil: 'networkidle' });
await page.locator('.mode-tab[data-mode="matchup"]').click();
await sleep(400);

/* ── 1) 팀 만들기 탭의 전술 카드 ───────────────────────────── */
console.log('\n[1] 「🛠 팀 만들기」 탭 전술 카드');
await page.locator('[data-act="cm-new"]').first().click();
await sleep(400);
await page.locator('[data-cm="name"]').fill('전술 점검 FC');
await page.locator('[data-act="cm-autofill"]').click();
await sleep(500);
ok(await page.locator('.cm-tactics').count() === 1, '팀 만들기 탭에 전술 카드가 있습니다');
ok(await page.locator('.cm-tactics [data-board]').count() === 1, '팀 만들기 탭에서 대형 보드를 바로 쓸 수 있습니다');
ok(await page.locator('.cm-tactics .cp-chip').count() === 11, '보드에 선수 칩 11개가 그려집니다', `${await page.locator('.cm-tactics .cp-chip').count()}개`);
ok(await page.locator('.cm-tactics [data-act="cm-formation"]').count() === 0, '보드 안에는 포메이션 버튼을 중복해 두지 않습니다(위 팀 정보에서 변경)');
ok(await page.locator('[data-act="cm-mentality"]').count() === 5, '팀 성향 5단계를 팀 만들기 탭에서 고를 수 있습니다');
ok(await page.locator('.cm-tactics [data-act="cm-tactic"]').count() === 20, '전술 4축(축마다 5단계) 버튼이 있습니다', `${await page.locator('.cm-tactics [data-act="cm-tactic"]').count()}개`);
ok(await page.locator('.cm-tactics .role-row').count() >= 10, '포지션별 역할 버튼이 있습니다', `${await page.locator('.cm-tactics .role-row').count()}개`);
ok(await page.locator('.cm-tactics [data-act="cm-setpiece"]').count() === 6, '세트피스 지시(코너 3·프리킥 3)가 있습니다', `${await page.locator('.cm-tactics [data-act="cm-setpiece"]').count()}개`);

/* ── 2) 저장 반복 — 팀 개수가 늘지 않는지 ─────────────────── */
console.log('\n[2] 저장 3회 반복 — 같은 팀이 업데이트되는지');
const before = (await teams(page)).length;
for (let i = 1; i <= 3; i += 1) {
  await page.locator('[data-cm="name"]').fill(`전술 점검 FC v${i}`);
  await page.locator('[data-act="cm-save"]').click();
  await sleep(350);
  const n = (await teams(page)).length;
  ok(n === before, `저장 ${i}회째에도 팀 개수가 그대로입니다`, `${await teamCountText(page)} · 목록 ${n}개`);
}
const saved1 = (await teams(page))[0];
ok(saved1.name === '전술 점검 FC v3' && saved1.id === (await teams(page))[0].id, '이름이 최신 내용으로 바뀌었습니다', saved1.name);
ok(/내 팀\s*1개/.test(await teamCountText(page)), '머리말의 「내 팀 N개」도 1개입니다', (await teamCountText(page)).replace(/\n/g, ' '));

/* ── 3) 자유 대형 + 성향 + 역할 + 세트피스 → 저장 → 다시 열기 ── */
console.log('\n[3] 팀 만들기에서 전술 정하고 저장');
async function dragChip(p, i, x, y, scope = '.cm-tactics') {
  const chip = p.locator(`${scope} .cp-chip[data-chip="${i}"]`);
  const cb = await chip.boundingBox();
  const bb = await p.locator(`${scope} [data-board]`).boundingBox();
  const sx = cb.x + cb.width / 2, sy = cb.y + cb.height / 2;
  const tx = bb.x + bb.width * x, ty = bb.y + bb.height * y;
  await p.mouse.move(sx, sy);
  await p.mouse.down();
  for (let k = 1; k <= 10; k += 1) {
    await p.mouse.move(sx + (tx - sx) * (k / 10), sy + (ty - sy) * (k / 10));
    await sleep(18);
  }
  await p.mouse.up();
  await sleep(320);
}
await page.locator('.cm-tactics').scrollIntoViewIfNeeded();
await dragChip(page, 8, 0.52, 0.44);
await dragChip(page, 10, 0.8, 0.2);
await page.locator('.cm-tactics [data-act="cm-mentality"][data-val="-1"]').click();
await sleep(300);
await page.locator('.cm-tactics [data-act="cm-tactic"][data-axis="press"][data-val="1"]').click();
await sleep(300);
const roleBefore = (await teams(page))[0].roles[9];
await page.locator('.cm-tactics .role-row[data-i="9"]').click();
await sleep(300);
await page.locator('.cm-tactics [data-act="cm-setpiece"][data-type="corner"]').nth(1).click();
await sleep(300);
await page.locator('[data-act="cm-save"]').click();
await sleep(400);

const t3 = (await teams(page))[0];
ok(Array.isArray(t3.customCoords) && t3.customCoords.length === 11, '자유 대형 좌표가 팀에 저장됩니다', `${t3.customCoords?.length}개`);
ok(Math.abs(t3.customCoords[8].x - 0.52) < 0.04 && Math.abs(t3.customCoords[8].y - 0.44) < 0.04, '끌어 놓은 자리 그대로 저장됩니다', `x ${t3.customCoords[8].x} · y ${t3.customCoords[8].y}`);
ok(t3.tactic.mentality === -1, '팀 성향이 저장됩니다', `mentality ${t3.tactic.mentality}`);
ok(t3.tactic.press === 1, '전술 4축 값이 저장됩니다', `press ${t3.tactic.press}`);
ok(t3.roles[9] !== roleBefore, '포지션별 역할 변경이 저장됩니다', `${roleBefore} → ${t3.roles[9]}`);
ok(!!t3.setpiece.corner, '세트피스 지시가 저장됩니다', `corner ${t3.setpiece.corner}`);
ok((await teams(page)).length === 1, '이 과정에서도 팀은 1개 그대로입니다');
await page.locator('.cm-tactics').scrollIntoViewIfNeeded();
await sleep(200);
await page.screenshot({ path: `${SHOT}/fm-builder-tactics.png`, fullPage: true });

/* 다시 열었을 때 */
const keepId = t3.id;
await page.reload({ waitUntil: 'networkidle' });
await page.locator('.mode-tab[data-mode="matchup"]').click();
await sleep(500);
const t3b = (await teams(page))[0];
ok(t3b.id === keepId && (await teams(page)).length === 1, '새로고침 뒤에도 같은 팀 하나입니다', `${t3b.id}`);
ok(await page.locator('.cm-tactics').count() === 1 && await page.locator('.cm-tactics .cpb-custom').count() === 1, '다시 열면 자유 대형이 그대로 보입니다');
ok(await page.locator('.cm-tactics [data-act="cm-mentality"][data-val="-1"].on').count() === 1, '다시 열면 고른 팀 성향이 켜져 있습니다');

/* 매치업 탭에서도 같은 전술 */
await page.locator('[data-act="cm-tab"][data-tab="match"]').click();
await sleep(400);
ok(await page.locator('.cpb-custom').count() === 1, '매치업 탭 보드에도 자유 대형이 표시됩니다');
ok(await page.locator('[data-act="cm-mentality"][data-val="-1"].on').count() === 1, '매치업 탭에서도 같은 팀 성향입니다');
ok(await page.locator('.role-row').count() >= 10 && await page.locator('[data-act="cm-setpiece"]').count() === 6, '매치업 탭의 역할·세트피스 조정도 그대로 있습니다');
await page.locator('.cpb').scrollIntoViewIfNeeded();
await sleep(200);
await page.locator('.cpb').screenshot({ path: `${SHOT}/fm-builder-tactics-match.png` });

/* ── 4) 공유 코드 왕복 — 전술·자유 대형이 함께 오가는지 ────── */
console.log('\n[4] 공유 코드 — 전술·자유 대형이 함께 담기는지');
const rows = new Map();
const posted = [];
async function mockSupabase(route) {
  const req = route.request();
  const u = new URL(req.url());
  if (req.method() === 'POST') {
    const body = JSON.parse(req.postData() || '{}');
    posted.push(body);
    rows.set(body.code, body);
    return route.fulfill({ status: 201, contentType: 'application/json', body: '' });
  }
  if (req.method() === 'GET') {
    const code = String(u.searchParams.get('code') || '').replace(/^eq\./, '');
    const row = rows.get(code);
    const wantObject = String(req.headers()['accept'] || '').includes('vnd.pgrst.object');
    if (wantObject) {
      return row
        ? route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ...row, created_at: '2026-11-26T12:00:00Z' }) })
        : route.fulfill({ status: 406, contentType: 'application/json', body: JSON.stringify({ code: 'PGRST116', message: 'no rows' }) });
    }
    return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(row ? [{ ...row, created_at: '2026-11-26T12:00:00Z' }] : []) });
  }
  return route.fulfill({ status: 200, contentType: 'application/json', body: '[]' });
}
await page.route('**/rest/v1/custom_teams*', mockSupabase);
await page.locator('[data-act="cm-tab"][data-tab="share"]').click();
await sleep(300);
await page.locator('[data-act="cm-publish"]').click();
await sleep(600);
await page.waitForSelector('.cm-code-val', { timeout: 20000 }).catch(async () => {
  const msg = await page.locator('.cm-msg').innerText().catch(() => '');
  console.log(`    (공유 실패 안내: ${msg.replace(/\n/g, ' ').slice(0, 120)})`);
});
const code = (await page.locator('.cm-code-val').textContent().catch(() => '')).trim();
if (!/^[A-Z0-9]{6,8}$/.test(code)) { console.log('  ❌ 공유 코드를 발급하지 못했습니다'); fails += 1; }
else console.log(`  ✅ 공유 코드를 발급했습니다 — ${code}`);
const ins = posted[0];
ok(ins && ins.tactic && Array.isArray(ins.tactic.coords) && ins.tactic.coords.length === 11, '서버로 가는 행에 자유 대형 좌표(tactic.coords)가 실립니다', ins ? `${ins.tactic?.coords?.length}개` : '없음');
ok(ins && ins.tactic.mentality === -1 && ins.tactic.press === 1, '전술 값(성향·4축)도 함께 올라갑니다', ins ? `mentality ${ins.tactic.mentality} · press ${ins.tactic.press}` : '없음');
ok(ins && ins.players.length === 11 && !('customCoords' in ins), '선수 11명이 함께 가고 표에 없는 필드는 보내지 않습니다');

/* 친구 브라우저 — 코드로 불러오기 (두 번 불러도 사본이 쌓이지 않아야) */
if (/^[A-Z0-9]{6,8}$/.test(code)) {
const ctx2 = await browser.newContext({ viewport: { width: 1440, height: 1000 }, locale: 'ko-KR' });
const page2 = await ctx2.newPage();
watch(page2);
await page2.route('**/rest/v1/custom_teams*', mockSupabase);
await page2.goto(BASE, { waitUntil: 'networkidle', timeout: 60000 });
await clearFm(page2);
await page2.reload({ waitUntil: 'networkidle' });
await page2.locator('.mode-tab[data-mode="matchup"]').click();
await sleep(400);
await page2.locator('[data-act="cm-tab"][data-tab="share"]').click();
await sleep(250);
await page2.locator('[data-cm="code"]').fill(code);
await page2.locator('[data-act="cm-load"]').click();
await page2.waitForFunction((c) => (document.body.innerText || '').includes(c), code, { timeout: 20000 }).catch(() => {});
await sleep(900);
const f1 = await teams(page2);
ok(f1.length === 1 && f1[0].customCoords?.[8] && Math.abs(f1[0].customCoords[8].x - t3.customCoords[8].x) < 1e-6, '코드로 불러온 팀에 자유 대형이 그대로입니다', `${f1.length}개 · x ${f1[0]?.customCoords?.[8]?.x}`);
ok(f1[0].tactic.mentality === -1 && f1[0].setpiece.corner === t3.setpiece.corner, '불러온 팀에 성향·세트피스도 그대로입니다');
await page2.locator('[data-act="cm-tab"][data-tab="share"]').click();
await sleep(200);
await page2.locator('[data-cm="code"]').fill(code);
await page2.locator('[data-act="cm-load"]').click();
await sleep(1200);
ok((await teams(page2)).length === 1, '같은 코드를 다시 불러와도 팀 사본이 생기지 않습니다', `${(await teams(page2)).length}개`);
ok(await page2.locator('.cm-msg').innerText().then((t) => /업데이트|저장했습니다/.test(t)).catch(() => false), '다시 불러오면 「업데이트했다」고 알려 줍니다', (await page2.locator('.cm-msg').innerText().catch(() => '')).slice(0, 60));
}

/* ── 5) 같은 공유 링크(?team=) 여러 번 열기 ──────────────────── */
console.log('\n[5] 같은 공유 링크(?team=)를 여러 번 열어도 사본이 쌓이지 않는지');
await page.locator('[data-act="cm-tab"][data-tab="share"]').click();
await sleep(250);
await page.locator('[data-act="cm-longlink"]').click();
await sleep(500);
const longLink = (await page.locator('.cm-longlink code').textContent()).trim();
ok(longLink.startsWith(BASE) && longLink.includes('?team=Z'), '긴 링크를 만들었습니다', `${longLink.length}자`);
const ctx3 = await browser.newContext({ viewport: { width: 1440, height: 1000 }, locale: 'ko-KR' });
const page3 = await ctx3.newPage();
watch(page3);
await page3.goto(BASE, { waitUntil: 'networkidle', timeout: 60000 });
await clearFm(page3);
for (let i = 1; i <= 3; i += 1) {
  await page3.goto(longLink, { waitUntil: 'networkidle', timeout: 60000 });
  await sleep(1200);
  const n = (await teams(page3)).length;
  ok(n === 1, `링크를 ${i}번째 열어도 팀은 1개입니다`, `${n}개`);
}
if ((await teams(page3)).length === 1) ok(!page3.url().includes('?team='), '불러온 뒤 주소창의 공유 값은 지워집니다', page3.url().slice(0, 60));

/* ── 6) 모바일 390px ────────────────────────────────────────── */
console.log('\n[6] 모바일 390px — 전술 카드 · 가로 넘침');
const mctx = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true, locale: 'ko-KR' });
const mp = await mctx.newPage();
watch(mp);
await mp.goto(BASE, { waitUntil: 'networkidle', timeout: 60000 });
await clearFm(mp);
await mp.reload({ waitUntil: 'networkidle' });
await mp.locator('.mode-tab[data-mode="matchup"]').click();
await sleep(400);
await mp.locator('[data-act="cm-new"]').first().click();
await sleep(400);
await mp.locator('[data-cm="name"]').fill('모바일 전술 FC');
await mp.locator('[data-act="cm-autofill"]').click();
await sleep(500);
ok(await mp.locator('.cm-tactics').count() === 1 && await mp.locator('.cm-tactics .cp-chip').count() === 11, '모바일에서도 전술 카드·보드가 그려집니다');
const w1 = await mp.evaluate(() => ({ sw: document.documentElement.scrollWidth, cw: document.documentElement.clientWidth }));
ok(w1.sw <= w1.cw + 1, '전술 카드가 있는 팀 만들기 화면이 390px에서 가로로 넘치지 않습니다', `${w1.sw}/${w1.cw}`);
// 터치로 칩 옮기기
const cdp = await mctx.newCDPSession(mp);
await mp.locator('.cm-tactics').scrollIntoViewIfNeeded();
await sleep(250);
const chip = await mp.locator('.cm-tactics .cp-chip[data-chip="4"]').boundingBox();
const board = await mp.locator('.cm-tactics [data-board]').boundingBox();
const sx = chip.x + chip.width / 2, sy = chip.y + chip.height / 2;
const tx = board.x + board.width * 0.66, ty = board.y + board.height * 0.3;
await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: sx, y: sy, id: 1 }] });
for (let k = 1; k <= 10; k += 1) {
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: sx + (tx - sx) * (k / 10), y: sy + (ty - sy) * (k / 10), id: 1 }] });
  await sleep(25);
}
await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
await sleep(500);
const mob = (await teams(mp))[0];
ok(mob.customCoords && Math.abs(mob.customCoords[4].x - 0.66) < 0.05, '모바일에서도 팀 만들기 탭 보드에서 칩이 끌려 저장됩니다', mob.customCoords?.[4] ? `x ${mob.customCoords[4].x} · y ${mob.customCoords[4].y}` : '없음');
const w2 = await mp.evaluate(() => ({ sw: document.documentElement.scrollWidth, cw: document.documentElement.clientWidth }));
ok(w2.sw <= w2.cw + 1, '드래그 뒤에도 가로 넘침이 없습니다', `${w2.sw}/${w2.cw}`);
await mp.locator('.cm-tactics').scrollIntoViewIfNeeded();
await sleep(200);
await mp.locator('.cm-tactics').screenshot({ path: `${SHOT}/fm-builder-tactics-mobile.png` });

console.log('\n[콘솔 오류]');
ok(errs.length === 0, '콘솔·페이지 오류가 없습니다', errs.slice(0, 4).join(' | ') || '0건');

await browser.close();
if (server) await new Promise((r) => server.close(r));
console.log(`\n${fails ? `❌ ${fails}개 실패` : '✅ 모든 점검 통과'}\n`);
process.exit(fails ? 1 : 0);
