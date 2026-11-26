// 커스텀 매치업 자유 대형(드래그 배치) 실서버 점검
//   · 전술 패널의 대형 보드 · 마우스·터치 드래그 · 칩 클릭(역할) · 기본 대형 되돌리기
//   · 공유 코드 왕복(자유 대형 좌표가 DB 행의 tactic.coords 로 오감) · 390px 가로 넘침 · 콘솔 오류
// 사용: node verify/fm-free-formation-live.mjs https://bmrgoodway.github.io/fm/
//
// 공유 코드 점검은 PostgREST 응답을 브라우저 안에서 대신 만들어 줍니다:
//   운영 표(fm.custom_teams)는 anon 에게 SELECT·INSERT 만 열려 있어(삭제 정책 없음) 점검용 팀을 지울 수 없기 때문입니다.
//   앱이 실제로 보내는 INSERT 본문(tactic.coords 포함)과 불러오기 경로는 그대로 검사하고, 표에는 아무것도 남기지 않습니다.
//   운영 서버 읽기 경로는 '없는 코드'를 넣어 오류 안내가 오는지로 따로 확인합니다.
import { chromium } from 'playwright';

const BASE = (process.argv[2] || 'https://bmrgoodway.github.io/fm/').replace(/\/?$/, '/');
const EXE = '/workspace/.pw/chromium_headless_shell-1255/chrome-headless-shell-linux64/chrome-headless-shell';
const SHOT = process.env.SHOT_DIR || '/workspace/downloads';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const errs = [];
let fails = 0;
const ok = (c, l, d = '') => { console.log(`${c ? '  ✅' : '  ❌'} ${l}${d ? ` — ${d}` : ''}`); if (!c) fails += 1; };

const browser = await chromium.launch({ executablePath: EXE, args: ['--no-sandbox', '--disable-dev-shm-usage', '--hide-scrollbars'] });
const watch = (p) => {
  p.on('pageerror', (e) => errs.push(`pageerror: ${e.message}`));
  p.on('console', (m) => { if (m.type() === 'error') errs.push(`console: ${m.text()}`); });
};
const clearFm = (p) => p.evaluate(() => { for (const k of Object.keys(localStorage)) if (k.startsWith('fm:')) localStorage.removeItem(k); });

/* ── 한 팀 만들기 (이름·자동 채우기·저장) ───────────────────── */
async function makeTeam(p, name, size = 11) {
  await p.locator('[data-act="cm-tab"][data-tab="build"]').click().catch(() => {});
  await sleep(200);
  await p.locator('[data-act="cm-new"]').first().click();
  await sleep(250);
  if (size !== 11) { await p.locator(`[data-act="cm-size"][data-size="${size}"]`).click(); await sleep(250); }
  await p.locator('[data-cm="name"]').fill(name);
  await p.locator('[data-act="cm-autofill"]').click();
  await sleep(350);
  await p.locator('[data-act="cm-save"]').click();
  await sleep(250);
  await p.locator('[data-act="cm-tab"][data-tab="match"]').click();
  await sleep(350);
}
const teamIn = (p) => p.evaluate((n) => JSON.parse(localStorage.getItem('fm:customTeams')).list.find((t) => t.name === n), '자유 대형 FC');

/* ── 보드 좌표로 칩 끌기 (마우스) ──────────────────────────── */
async function dragChip(p, i, x, y) {
  const chip = p.locator(`.cp-chip[data-chip="${i}"]`);
  const cb = await chip.boundingBox();
  const bb = await p.locator('[data-board]').boundingBox();
  const sx = cb.x + cb.width / 2, sy = cb.y + cb.height / 2;
  const tx = bb.x + bb.width * x, ty = bb.y + bb.height * y;
  await p.mouse.move(sx, sy);
  await p.mouse.down();
  for (let k = 1; k <= 10; k += 1) {
    await p.mouse.move(sx + (tx - sx) * (k / 10), sy + (ty - sy) * (k / 10));
    await sleep(20);
  }
  await p.mouse.up();
  await sleep(300);
}

const ctx = await browser.newContext({ viewport: { width: 1440, height: 950 }, locale: 'ko-KR' });
const page = await ctx.newPage();
watch(page);
await page.goto(BASE, { waitUntil: 'networkidle', timeout: 60000 });
await clearFm(page);
await page.reload({ waitUntil: 'networkidle' });
await page.locator('.mode-tab[data-mode="matchup"]').click();
await sleep(300);

/* ── 1) 보드 그리기 ────────────────────────────────────────── */
console.log('\n[1] 대형 보드 — 「⚔ 매치업」 전술 패널');
await makeTeam(page, '자유 대형 FC', 11);
ok(await page.locator('.custom-pitchboard').count() === 1, '전술 패널에 피치 대형 보드가 있습니다');
ok(await page.locator('.custom-pitchboard .cp-chip').count() === 11, '11인제 팀은 칩 11개를 그립니다', `${await page.locator('.custom-pitchboard .cp-chip').count()}개`);
ok(await page.locator('.cpb-custom').count() === 0, '처음에는 「커스텀 대형」 배지가 없습니다');
ok(await page.locator('[data-act="cm-formation"]').count() === 7, '보드 위에서 11인제 기본 포메이션 7종을 고를 수 있습니다', `${await page.locator('[data-act="cm-formation"]').count()}개`);
const align = await page.evaluate(() => {
  const chips = [...document.querySelectorAll('.cp-chip')];
  const b = document.querySelector('[data-board]').getBoundingClientRect();
  return chips.map((el) => { const r = el.getBoundingClientRect(); return { fx: (r.x + r.width / 2 - b.x) / b.width, fy: (r.y + r.height / 2 - b.y) / b.height }; });
});
ok(align.every((c) => c.fx > 0 && c.fx < 1 && c.fy > 0 && c.fy < 1), '칩 11개가 피치 안에 흩어져 그려집니다');
await page.locator('.cpb').scrollIntoViewIfNeeded();
await sleep(200);
await page.locator('.cpb').screenshot({ path: `${SHOT}/fm-custom-free-formation-before.png` });

/* ── 2) 마우스 드래그 ──────────────────────────────────────── */
console.log('\n[2] 마우스로 칩 끌기 — 좌표 저장 · 커스텀 대형 배지');
const rolesBefore = (await teamIn(page)).roles.slice();
await dragChip(page, 8, 0.52, 0.42);           // 4-3-3 LW → 중앙
let t = await teamIn(page);
const c8 = t.customCoords?.[8];
ok(Array.isArray(t.customCoords) && t.customCoords.length === 11, '드래그하면 팀에 자유 대형 좌표(customCoords)가 저장됩니다', `${t.customCoords?.length}개`);
ok(c8 && Math.abs(c8.x - 0.52) < 0.03 && Math.abs(c8.y - 0.42) < 0.03, '끌어 놓은 자리 그대로 좌표가 잡힙니다', `x ${c8?.x} · y ${c8?.y}`);
ok(JSON.stringify(rolesBefore) === JSON.stringify(t.roles), '끌기만 해서는 역할이 바뀌지 않습니다');
ok(await page.locator('.cpb-custom').count() === 1, '보드 상단에 「커스텀 대형」 배지가 뜹니다', (await page.locator('.cpb-custom').textContent())?.trim());
const chipAt = await page.evaluate(() => {
  const el = document.querySelector('.cp-chip[data-chip="8"]');
  const b = document.querySelector('[data-board]').getBoundingClientRect();
  const r = el.getBoundingClientRect();
  return { fx: (r.x + r.width / 2 - b.x) / b.width, fy: (r.y + r.height / 2 - b.y) / b.height };
});
ok(Math.abs(chipAt.fx - c8.x) < 0.02 && Math.abs(chipAt.fy - c8.y) < 0.02, '칩이 옮긴 자리에 그대로 다시 그려집니다', `화면 ${chipAt.fx.toFixed(2)},${chipAt.fy.toFixed(2)}`);
const stored = await page.evaluate(() => JSON.parse(localStorage.getItem('fm:customTeams')).list.find((x) => x.name === '자유 대형 FC'));
ok(stored.customCoords[8].x === c8.x, 'localStorage 에도 같은 좌표가 남습니다');

/* 보기 좋은 대형으로 몇 명 더 옮겨 둡니다 (스크린샷·경기 확인용) */
for (const [i, x, y] of [[1, 0.42, 0.2], [4, 0.42, 0.8], [8, 0.8, 0.2], [10, 0.8, 0.8], [9, 0.62, 0.35]]) await dragChip(page, i, x, y);

/* ── 3) 칩 클릭 = 역할 변경 ────────────────────────────────── */
console.log('\n[3] 칩 클릭 — 역할 변경');
await sleep(900);   // 끌고 난 직후 0.8초 동안은 같은 칩의 click 을 무시합니다
const roleBefore = (await teamIn(page)).roles[9];
await page.locator('.cp-chip[data-chip="9"]').click();
await sleep(350);
const roleAfter = (await teamIn(page)).roles[9];
ok(roleAfter !== roleBefore, '칩을 누르면 그 선수 역할이 바뀝니다', `${roleBefore} → ${roleAfter}`);
ok((await teamIn(page)).customCoords[9].x === 0.62, '역할을 바꿔도 옮긴 자리는 그대로입니다');

/* ── 4) 기본 대형으로 되돌리기 / 포메이션 변경 ─────────────── */
console.log('\n[4] 되돌리기·포메이션 변경');
await page.locator('.cpb').scrollIntoViewIfNeeded();
await page.locator('.cpb').screenshot({ path: `${SHOT}/fm-custom-free-formation.png` });
const resetBtn = page.locator('[data-act="cm-board-reset"]');
ok(await resetBtn.count() === 1 && await resetBtn.isEnabled(), '「기본 대형으로 되돌리기」 버튼이 있습니다');
await resetBtn.click();
await sleep(400);
ok((await teamIn(page)).customCoords === null && await page.locator('.cpb-custom').count() === 0, '되돌리면 좌표가 지워지고 기본 대형이 됩니다');
await dragChip(page, 8, 0.5, 0.5);
await page.locator('[data-act="cm-formation"][data-formation="4-4-2"]').click();
await sleep(400);
t = await teamIn(page);
ok(t.formation === '4-4-2' && t.customCoords === null, '보드에서 포메이션을 바꾸면 자유 대형이 그 포메이션 기본값으로 돌아갑니다', `${t.formation} · coords ${t.customCoords}`);
await page.locator('[data-act="cm-formation"][data-formation="4-3-3"]').click();
await sleep(350);

/* ── 5) 공유 코드 — 자유 대형이 DB 행(tactic.coords)에 실려 오감 ── */
console.log('\n[5] 공유 코드 — tactic jsonb 의 coords 로 자유 대형 유지');
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
        : route.fulfill({ status: 406, contentType: 'application/json', body: JSON.stringify({ code: 'PGRST116', message: 'JSON object requested, multiple (or no) rows returned' }) });
    }
    return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(row ? [{ ...row, created_at: '2026-11-26T12:00:00Z' }] : []) });
  }
  return route.fulfill({ status: 200, contentType: 'application/json', body: '[]' });
}
for (const [i, x, y] of [[8, 0.8, 0.2], [10, 0.8, 0.8], [9, 0.62, 0.35]]) await dragChip(page, i, x, y);
const mine = await teamIn(page);
await page.route('**/rest/v1/custom_teams*', mockSupabase);
await page.locator('[data-act="cm-tab"][data-tab="share"]').click();
await sleep(250);
await page.locator('[data-act="cm-publish"]').click();
await page.waitForSelector('.cm-code-val', { timeout: 20000 });
const code = (await page.locator('.cm-code-val').textContent()).trim();
ok(/^[A-Z0-9]{6,8}$/.test(code), '공유 코드를 발급했습니다', code);
const ins = posted[0];
ok(ins && ins.tactic && Array.isArray(ins.tactic.coords) && ins.tactic.coords.length === 11
  && Math.abs(ins.tactic.coords[8][0] - mine.customCoords[8].x) < 1e-6,
  '서버로 가는 행의 tactic.coords 에 자유 대형이 실립니다', ins ? JSON.stringify(ins.tactic.coords[8]) : '없음');
ok(ins && ins.tactic.line === 0 && ins.tactic.coords.length === 11 && ins.players.length === 11 && !('customCoords' in ins),
  '전술 값·선수 11명이 함께 올라가고 표에 없는 필드는 보내지 않습니다');

// 친구 브라우저 — 코드로 불러오기
const ctx2 = await browser.newContext({ viewport: { width: 1440, height: 950 }, locale: 'ko-KR' });
const page2 = await ctx2.newPage();
watch(page2);
await page2.route('**/rest/v1/custom_teams*', mockSupabase);
await page2.goto(BASE, { waitUntil: 'networkidle', timeout: 60000 });
await clearFm(page2);
await page2.reload({ waitUntil: 'networkidle' });
await page2.locator('.mode-tab[data-mode="matchup"]').click();
await sleep(300);
await page2.locator('[data-act="cm-new"]').first().click();
await sleep(200);
await page2.locator('[data-act="cm-tab"][data-tab="share"]').click();
await sleep(200);
await page2.locator('[data-cm="code"]').fill(code);
await page2.locator('[data-act="cm-load"]').click();
await page2.waitForFunction((c) => (document.body.innerText || '').includes(c), code, { timeout: 20000 });
await sleep(800);
const friend = await page2.evaluate(() => JSON.parse(localStorage.getItem('fm:customTeams')).list.find((x) => x.name === '자유 대형 FC'));
ok(friend && friend.customCoords && Math.abs(friend.customCoords[8].x - mine.customCoords[8].x) < 1e-6
  && Math.abs(friend.customCoords[8].y - mine.customCoords[8].y) < 1e-6,
  '코드로 불러온 친구 팀에도 자유 대형이 그대로입니다', friend?.customCoords?.[8] ? `x ${friend.customCoords[8].x} · y ${friend.customCoords[8].y}` : '없음');
ok(!('coords' in (friend?.tactic || {})), '불러온 팀의 전술 값에는 좌표가 섞이지 않습니다');
await page2.locator('[data-act="cm-tab"][data-tab="match"]').click();
await sleep(350);
ok(await page2.locator('.cpb-custom').count() === 1, '친구 화면의 보드에도 「커스텀 대형」이 표시됩니다');
await page2.locator('.cpb').scrollIntoViewIfNeeded();
await sleep(200);
await page2.locator('.cpb').screenshot({ path: `${SHOT}/fm-custom-free-shared.png` });

/* 운영 서버 읽기 — 없는 코드는 친절한 안내로 돌아옵니다 (쓰기 없음) */
const ctx3 = await browser.newContext({ viewport: { width: 1440, height: 950 }, locale: 'ko-KR' });
const page3 = await ctx3.newPage();
watch(page3);
await page3.goto(BASE, { waitUntil: 'networkidle', timeout: 60000 });
await clearFm(page3);
await page3.reload({ waitUntil: 'networkidle' });
await page3.locator('.mode-tab[data-mode="matchup"]').click();
await sleep(300);
await page3.locator('[data-act="cm-new"]').first().click();
await sleep(200);
await page3.locator('[data-act="cm-tab"][data-tab="share"]').click();
await sleep(200);
await page3.locator('[data-cm="code"]').fill('ZZZZ99');
await page3.locator('[data-act="cm-load"]').click();
await page3.waitForFunction(() => /찾지 못했습니다|불러오지 못했습니다/.test(document.querySelector('.cm-msg')?.textContent || ''), null, { timeout: 20000 }).catch(() => {});
const realMsg = (await page3.locator('.cm-msg').textContent().catch(() => '')) || '';
ok(/찾지 못했습니다/.test(realMsg), '운영 표에 실제로 조회해 없는 코드를 안내합니다 (읽기 경로 정상)', realMsg.trim().slice(0, 50));

/* ── 6) 그 대형으로 2D 경기 — 경기장 안 기준 위치 ───────────── */
console.log('\n[6] 자유 대형으로 2D 경기');
await page.locator('[data-act="cm-tab"][data-tab="match"]').click();
await sleep(300);
const before = await teamIn(page);
await page.locator('[data-act="mu-start"][data-instant="0"]').click();
await page.waitForSelector('.matchview', { timeout: 20000 });
await sleep(150);
const live = await page.evaluate(() => {
  const m = window.__fm?.match;
  if (!m) return null;
  return {
    t: m.t, frames: window.__fm.frames,
    home: m.sides.home.players.map((e) => ({ num: e.num, pos: e.pos, x: e.x, y: e.y, sx: e.slot.x, sy: e.slot.y })),
  };
});
ok(live && live.frames > 0, '2D 중계가 열립니다', `${live?.frames}프레임 · ${live?.t}틱`);
ok(live.home.every((e, i) => Math.abs(e.sx - before.customCoords[i].x) < 1e-9 && Math.abs(e.sy - before.customCoords[i].y) < 1e-9),
  '경기장의 모든 홈 선수 기준 위치가 자유 대형 좌표입니다',
  live.home.map((e) => `${e.num}:${e.sx.toFixed(2)},${e.sy.toFixed(2)}`).join(' '));
// 경기장 좌표계: x 0~100, y 0~64 (W·H)
const onSpot = live.home.filter((e) => Math.abs(e.x - e.sx * 100) < 1.5 && Math.abs(e.y - e.sy * 64) < 1.5);
ok(onSpot.length >= 10, '킥오프 순간 선수들이 그 자리에 실제로 서 있습니다', `${onSpot.length}/11명`);
await page.locator('.matchview').screenshot({ path: `${SHOT}/fm-custom-free-match.png` });
await page.locator('[data-speed="0"]').click();
await sleep(1600);
await page.locator('#ov-continue').click();
await sleep(700);
ok(await page.locator('.cm-score-num').count() === 1, '경기가 끝까지 진행되고 결과 요약이 나옵니다');

/* ── 7) 모바일 390px — 터치 드래그·가로 넘침 ─────────────────── */
console.log('\n[7] 모바일 390px — 터치 드래그');
const mctx = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true, locale: 'ko-KR' });
const mp = await mctx.newPage();
watch(mp);
await mp.goto(BASE, { waitUntil: 'networkidle', timeout: 60000 });
await clearFm(mp);
await mp.reload({ waitUntil: 'networkidle' });
await mp.locator('.mode-tab[data-mode="matchup"]').click();
await sleep(300);
await makeTeam(mp, '모바일 풋살', 5);
ok(await mp.locator('.cp-chip').count() === 5, '5인제 팀은 칩 5개입니다');
const w1 = await mp.evaluate(() => ({ sw: document.documentElement.scrollWidth, cw: document.documentElement.clientWidth }));
ok(w1.sw <= w1.cw + 1, '보드가 있는 매치업 화면이 390px에서 가로로 넘치지 않습니다', `${w1.sw}/${w1.cw}`);
await mp.locator('.cpb').scrollIntoViewIfNeeded();
await sleep(200);
await mp.locator('.cpb').screenshot({ path: `${SHOT}/fm-custom-free-mobile.png` });

const cdp = await mctx.newCDPSession(mp);
const mchip = await mp.locator('.cp-chip[data-chip="3"]').boundingBox();
const mboard = await mp.locator('[data-board]').boundingBox();
const sx = mchip.x + mchip.width / 2, sy = mchip.y + mchip.height / 2;
const mx = mboard.x + mboard.width * 0.3, my = mboard.y + mboard.height * 0.35;
await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: sx, y: sy, id: 1 }] });
for (let k = 1; k <= 10; k += 1) {
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: sx + (mx - sx) * (k / 10), y: sy + (my - sy) * (k / 10), id: 1 }] });
  await sleep(25);
}
await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
await sleep(450);
const mob = await mp.evaluate(() => JSON.parse(localStorage.getItem('fm:customTeams')).list[0]);
ok(mob.customCoords && Math.abs(mob.customCoords[3].x - 0.3) < 0.05 && Math.abs(mob.customCoords[3].y - 0.35) < 0.05,
  '터치로도 칩이 끌려 좌표가 저장됩니다', mob.customCoords?.[3] ? `x ${mob.customCoords[3].x} · y ${mob.customCoords[3].y}` : '없음');
ok(await mp.locator('.cpb-custom').count() === 1, '모바일에서도 「커스텀 대형」 배지가 뜹니다');
// 골키퍼는 골문 앞으로만 — GK 를 중앙으로 끌어 본다
const gk = await mp.locator('.cp-chip[data-chip="0"]').boundingBox();
const bx = gk.x + gk.width / 2, by = gk.y + gk.height / 2;
await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: bx, y: by, id: 2 }] });
for (let k = 1; k <= 8; k += 1) {
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: bx + (mboard.x + mboard.width * 0.6 - bx) * (k / 8), y: by + (mboard.y + mboard.height * 0.5 - by) * (k / 8), id: 2 }] });
  await sleep(25);
}
await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
await sleep(400);
const gkC = (await mp.evaluate(() => JSON.parse(localStorage.getItem('fm:customTeams')).list[0])).customCoords?.[0];
ok(gkC && gkC.x <= 0.14 + 1e-9, '골키퍼는 골문 앞(x ≤ 0.14)을 벗어나지 않습니다', gkC ? `x ${gkC.x} · y ${gkC.y}` : '없음');
const w2 = await mp.evaluate(() => ({ sw: document.documentElement.scrollWidth, cw: document.documentElement.clientWidth }));
ok(w2.sw <= w2.cw + 1, '드래그 뒤에도 390px 가로 넘침이 없습니다', `${w2.sw}/${w2.cw}`);
await mp.locator('.cpb').screenshot({ path: `${SHOT}/fm-custom-free-mobile-after.png` });

console.log('\n[콘솔 오류]');
ok(errs.length === 0, '콘솔·페이지 오류가 없습니다', errs.slice(0, 4).join(' | ') || '0건');

await browser.close();
console.log(`\n${fails ? `❌ ${fails}개 실패` : '✅ 모든 점검 통과'}\n`);
process.exit(fails ? 1 : 0);
