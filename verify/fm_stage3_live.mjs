// 3단계 검증 — 새 포메이션 3종 · 세트피스 지시 · 피치 위 체력 바/카드 (데스크톱 1440 + 모바일 390)
// 사용: BASE=https://bmrgoodway.github.io/fm/ node verify/fm_stage3_live.mjs
//   · 전술 탭의 포메이션 7종(4-1-4-1·3-4-3·4-3-1-2)과 전술 보드 11명이 실제로 바뀌는지
//   · 코너킥·프리킥 지시 6개가 전술 탭·경기 중 시트·하프타임 라커룸에서 바뀌고 저장되는지
//   · Canvas 피치에 미니 체력 바(초록/노랑)가 실제로 그려지는지(픽셀 검사), 지시 라벨이 뜨는지
//   · 390px 레이아웃(가로 스크롤·겹침), 콘솔·페이지 오류 0
import { chromium } from 'playwright';
import { writeFileSync, mkdirSync } from 'node:fs';

const BASE = (process.env.BASE || 'https://bmrgoodway.github.io/fm/') + (process.env.BASE ? '' : `?verify=${Date.now()}`);
const EXE = '/workspace/.pw/chromium_headless_shell-1255/chrome-headless-shell-linux64/chrome-headless-shell';
const OUT = process.env.OUT || '/workspace/tmp/fmtest/fm_stage3_live.json';
const SHOT_DIR = process.env.SHOT_DIR || '/workspace/downloads';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const out = { base: BASE, checks: [], errors: [], metrics: {} };
const ok = (c, label, detail) => {
  out.checks.push({ ok: !!c, label, detail: detail || '' });
  console.log(`${c ? '  ✅' : '  ❌'} ${label}${detail ? ' — ' + detail : ''}`);
};
mkdirSync(SHOT_DIR, { recursive: true });

const browser = await chromium.launch({ executablePath: EXE, args: ['--no-sandbox', '--disable-dev-shm-usage', '--hide-scrollbars', '--force-color-profile=srgb'] });

async function open(viewport, opts = {}) {
  const ctx = await browser.newContext({ viewport, locale: 'ko-KR', ...opts });
  const page = await ctx.newPage();
  page.on('pageerror', (e) => out.errors.push('pageerror: ' + e.message));
  page.on('console', (m) => { if (m.type() === 'error') out.errors.push('console: ' + m.text()); });
  await page.goto(BASE, { waitUntil: 'networkidle', timeout: 45000 });
  return { ctx, page };
}
async function startCareer(page) {
  const cont = page.locator('[data-act="continue"]');
  if (await cont.count()) { await cont.first().click(); await sleep(500); return; }
  await page.locator('[data-act="team"][data-team="gs"]').click();
  await sleep(300);
  await page.getByRole('button', { name: /이 구단으로 시작/ }).click();
  await sleep(700);
}
async function toastGone(page) {
  await page.waitForFunction(() => {
    const t = document.getElementById('toast');
    return !t || !t.classList.contains('on');
  }, null, { timeout: 8000 }).catch(() => {});
}
/* 스크린샷용 — 토스트를 숨기고 대상 카드를 머리·탭바 아래로 가져옵니다 */
async function prepShot(page, selector, offset = 130) {
  await toastGone(page);
  await page.evaluate(({ sel, off }) => {
    const t = document.getElementById('toast');
    if (t) { t.classList.remove('on'); t.style.display = 'none'; }
    const el = document.querySelector(sel);
    if (!el) return;
    const y = el.getBoundingClientRect().top + window.scrollY - off;
    window.scrollTo(0, Math.max(0, y));
  }, { sel: selector, off: offset });
  await sleep(700);
}
const saved = (page) => page.evaluate(() => {
  const w = JSON.parse(localStorage.getItem('fm:career') || 'null');
  return w ? { formation: w.myLineup?.formation, setpiece: w.myLineup?.setpiece, roles: w.myLineup?.roles } : null;
});
/* Canvas 에 실제로 그려진 색을 셉니다 — 체력 바(초록 #2fe36b / 노랑 #ffdc1a)·코너 지시 라벨 */
const barPixels = (page) => page.evaluate(() => {
  const c = document.getElementById('pitch');
  if (!c) return null;
  const ctx = c.getContext('2d');
  const d = ctx.getImageData(0, 0, c.width, c.height).data;
  const near = (r, g, b, R, G, B) => Math.abs(r - R) < 14 && Math.abs(g - G) < 14 && Math.abs(b - B) < 14;
  let green = 0, yellow = 0, coral = 0, total = 0;
  for (let i = 0; i < d.length; i += 4) {
    if (d[i + 3] < 40) continue;
    total += 1;
    if (near(d[i], d[i + 1], d[i + 2], 47, 227, 107)) green += 1;
    else if (near(d[i], d[i + 1], d[i + 2], 255, 220, 26)) yellow += 1;
    else if (near(d[i], d[i + 1], d[i + 2], 255, 97, 74)) coral += 1;
  }
  return { green, yellow, coral, total, w: c.width, h: c.height };
});
/* 화면이 계산한 체력 바 좌표에서 실제 캔버스 픽셀을 읽어 색이 맞는지 확인합니다 */
const barCheck = (page) => page.evaluate(() => {
  const info = window.__fm?.bars?.();
  const c = document.getElementById('pitch');
  if (!info || !c) return null;
  const ctx = c.getContext('2d');
  const hex = (h) => [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)];
  let match = 0, miss = 0, sampled = 0;
  const colors = [];
  for (const b of info.list) {
    // b.x 는 바의 '가운데' 좌표 — 바 높이의 한가운데를 읽습니다
    const sx = Math.round(b.x * info.dpr);
    const sy = Math.round((b.y + b.h * 0.5) * info.dpr);
    if (sx < 1 || sy < 1 || sx >= c.width - 1 || sy >= c.height - 1) continue;
    const d = ctx.getImageData(sx, sy, 1, 1).data;
    const [R, G, B] = hex(b.color);
    sampled += 1;
    if (Math.abs(d[0] - R) < 26 && Math.abs(d[1] - G) < 26 && Math.abs(d[2] - B) < 26) match += 1;
    else miss += 1;
    colors.push({ num: b.num, side: b.side, stamina: b.stamina, want: b.color, got: `#${[d[0], d[1], d[2]].map((v) => v.toString(16).padStart(2, '0')).join('')}` });
  }
  const bands = info.list.reduce((m, b) => { const k = b.stamina >= 70 ? 'good' : b.stamina >= 45 ? 'warn' : 'low'; m[k] = (m[k] || 0) + 1; return m; }, {});
  return { sampled, match, miss, bands, bad: colors.filter((c2) => c2.want !== c2.got).slice(0, 4), scale: info.scale };
});

const matchState = (page) => page.evaluate(() => {
  const m = window.__fm?.match;
  if (!m) return null;
  const side = m.sides[m.userSide];
  return {
    minute: m.minute(), phase: m.phase, formation: side.formation,
    setpiece: side.setpiece, oppSetpiece: m.sides[m.userSide === 'home' ? 'away' : 'home'].setpiece,
    onPitch: side.players.filter((e) => e.onPitch).length,
    stamina: side.players.filter((e) => e.onPitch).map((e) => Math.round(e.stamina)),
    yellow: side.players.filter((e) => e.onPitch && e.st.yellow > 0).length,
    errors: (window.__fm?.errors || []).slice(-3),
  };
});

/* ───────────── 데스크톱 1440 ───────────── */
console.log('\n[데스크톱 1440×900]');
{
  const { page } = await open({ width: 1440, height: 900 });
  await startCareer(page);
  await page.locator('nav.tabs [data-act="tab"][data-tab="squad"]').click();
  await sleep(500);

  // ① 포메이션 7종
  const forms = await page.evaluate(() => [...document.querySelectorAll('[data-act="formation"]')].map((b) => b.dataset.formation));
  ok(forms.length === 7 && ['4-1-4-1', '3-4-3', '4-3-1-2'].every((f) => forms.includes(f)),
    '전술 탭에 포메이션 7종이 있습니다', forms.join(' · '));
  await page.locator('[data-act="formation"][data-formation="3-4-3"]').click();
  await sleep(600);
  const board = await page.evaluate(() => {
    const chips = [...document.querySelectorAll('.pitchboard .chip')];
    return {
      n: chips.length,
      labels: [...document.querySelectorAll('.pitchboard .chip-pos')].map((b) => b.textContent.trim().replace(/\s+/g, ' ')),
      inside: chips.every((c) => {
        const r = c.getBoundingClientRect(), b = c.closest('.pitchboard').getBoundingClientRect();
        return r.left >= b.left - 1 && r.right <= b.right + 1 && r.top >= b.top - 1 && r.bottom <= b.bottom + 1;
      }),
    };
  });
  const savedF = await saved(page);
  ok(board.n === 11, '전술 보드에 11명 칩이 그려집니다', `${board.n}명`);
  ok(/LWB/.test(board.labels.join(' ')) && /RWB/.test(board.labels.join(' ')) && /LW/.test(board.labels.join(' ')),
    '3-4-3 보드 — 윙백·윙어 자리가 나옵니다', board.labels.slice(0, 5).join(' / '));
  ok(board.inside, '보드 칩이 피치 밖으로 나가지 않습니다');
  ok(savedF.formation === '3-4-3', '고른 포메이션이 세이브에 저장됩니다', savedF.formation);

  // ② 세트피스 지시 6개 — 코너 3 + 프리킥 3
  const spBtns = await page.evaluate(() => [...document.querySelectorAll('[data-act="setpiece"]')].map((b) => `${b.dataset.type}:${b.dataset.key}`));
  ok(spBtns.length === 6 && spBtns.includes('corner:near') && spBtns.includes('freekick:box'),
    '전술 탭에 세트피스 지시 6개(코너 3·프리킥 3)가 있습니다', spBtns.join(' '));
  await page.locator('[data-act="setpiece"][data-type="corner"][data-key="near"]').click();
  await sleep(200);
  await page.locator('[data-act="setpiece"][data-type="freekick"][data-key="box"]').click();
  await sleep(400);
  const savedSp = await saved(page);
  ok(savedSp.setpiece?.corner === 'near' && savedSp.setpiece?.freekick === 'box',
    '고른 지시가 myLineup.setpiece 에 저장됩니다', JSON.stringify(savedSp.setpiece));
  const spActive = await page.evaluate(() => ({
    corner: document.querySelector('[data-act="setpiece"][data-type="corner"].on')?.textContent.trim(),
    free: document.querySelector('[data-act="setpiece"][data-type="freekick"].on')?.textContent.trim(),
    eff: document.querySelector('.sp-row .axis-eff')?.textContent.trim().slice(0, 24),
  }));
  ok(spActive.corner === '니어 포스트' && spActive.free === '박스 투입', '선택 상태가 버튼에 표시됩니다',
    `${spActive.corner} / ${spActive.free}`);
  await prepShot(page, '.sp-axes', 150);
  await page.screenshot({ path: `${SHOT_DIR}/fm-stage3-tactics.png` });
  out.metrics.tacticsShot = `${SHOT_DIR}/fm-stage3-tactics.png`;

  // ③ 새로고침해도 유지
  await page.reload({ waitUntil: 'networkidle' });
  await page.locator('[data-act="continue"]').first().click();
  await sleep(500);
  await page.locator('nav.tabs [data-act="tab"][data-tab="squad"]').click();
  await sleep(400);
  const after = await saved(page);
  const formOn = await page.evaluate(() => document.querySelector('[data-act="formation"].on')?.dataset.formation);
  ok(after.setpiece?.corner === 'near' && formOn === '3-4-3', '새로고침 후에도 포메이션·세트피스 지시가 유지됩니다',
    `${formOn} · ${JSON.stringify(after.setpiece)}`);

  // ④ 경기 시작 — 하프타임 라커룸에서 포메이션·세트피스 변경
  await page.locator('nav.tabs [data-act="tab"][data-tab="schedule"]').click();
  await sleep(300);
  await page.getByRole('button', { name: /경기 시작/ }).first().click();
  await page.waitForSelector('#pitch');
  await sleep(1200);
  const atStart = await matchState(page);
  ok(atStart && atStart.setpiece.corner === 'near' && atStart.setpiece.freekick === 'box',
    '경기 엔진이 저장된 세트피스 지시로 시작합니다', JSON.stringify(atStart?.setpiece));
  ok(atStart && atStart.formation === '3-4-3' && atStart.onPitch === 11, '경기가 3-4-3 · 11명으로 시작합니다',
    `${atStart?.formation} · ${atStart?.onPitch}명`);

  // 하프타임까지 엔진을 직접 돌립니다 (화면 루프는 그대로)
  await page.evaluate(() => {
    const m = window.__fm.match;
    let g = 0;
    while (!m.done && m.phase !== 'half' && g < 400) { m.tick(); g++; }
  });
  await page.waitForSelector('#halftime:not([hidden])', { timeout: 8000 }).catch(() => {});
  await sleep(500);
  const ht = await page.evaluate(() => ({
    shown: !document.getElementById('halftime').hidden,
    forms: document.querySelectorAll('#ht-body [data-htform]').length,
    sp: document.querySelectorAll('#ht-body [data-htsp]').length,
    rows: [...document.querySelectorAll('#ht-body .ht-sub')].map((h) => h.textContent.trim()),
  }));
  ok(ht.shown, '전반 종료 후 하프타임 라커룸이 열립니다');
  ok(ht.forms === 7, '라커룸에서 포메이션 7종을 바꿀 수 있습니다', `${ht.forms}개`);
  ok(ht.sp === 6, '라커룸에서 세트피스 지시 6개를 바꿀 수 있습니다', `${ht.sp}개`);
  if (ht.shown) {
    await page.locator('#ht-body [data-htform="4-3-1-2"]').click();
    await sleep(250);
    await page.locator('#ht-body [data-htsp="corner"][data-key="short"]').click();
    await sleep(250);
    const htState = await matchState(page);
    ok(htState.formation === '4-3-1-2' && htState.setpiece.corner === 'short',
      '라커룸에서 바꾼 포메이션·지시가 엔진에 들어갑니다', `${htState.formation} · ${JSON.stringify(htState.setpiece)}`);
    await page.locator('#ht-start').click();
    await sleep(900);
  }
  const second = await matchState(page);
  ok(second && second.minute >= 45 && second.phase !== 'half', '후반이 시작됩니다', `${second?.minute}' · ${second?.phase}`);

  // ⑤ 후반 중반까지 진행 — 체력이 빠진 상태에서 피치 체력 바 확인
  await page.evaluate(() => {
    const m = window.__fm.match;
    let g = 0;
    while (!m.done && m.phase !== 'half' && m.t < 300 && g < 900) { m.tick(); g++; }
  });
  await sleep(600);
  // 화면 갱신과 상태가 같은 순간을 재도록 잠깐 멈춥니다
  await page.locator('#m-pause').click();
  await sleep(400);
  const mid = await matchState(page);
  const px = await barPixels(page);
  const bars = await barCheck(page);
  out.metrics.bars = px;
  out.metrics.barCheck = bars;
  out.metrics.stamina = mid?.stamina;
  ok(px && px.green > 150, '피치에 체력 바가 그려집니다(캔버스 초록 픽셀 확인)', `초록 ${px?.green}px · 노랑 ${px?.yellow}px`);
  ok(bars && bars.sampled >= 20 && bars.match >= Math.ceil(bars.sampled * 0.9),
    '선수마다 체력 바가 제 색(70%+ 초록·45~70% 노랑·45% 미만 빨강)으로 그려집니다',
    `${bars?.match}/${bars?.sampled}명 일치 · 구간 ${JSON.stringify(bars?.bands)}`);
  ok(mid && mid.stamina.every((v) => v > 0 && v <= 100), '모든 선수의 체력이 0~100 범위입니다', `최저 ${Math.min(...(mid?.stamina || [0]))}%`);
  await toastGone(page);
  await page.screenshot({ path: `${SHOT_DIR}/fm-stage3-pitch.png` });
  out.metrics.pitchShot = `${SHOT_DIR}/fm-stage3-pitch.png`;
  await page.locator('#m-pause').click();
  await sleep(200);

  // ⑥ 경기 중 시트 — 세트피스 지시 변경
  await page.locator('[data-mact="tactics"]').click();
  await sleep(500);
  const drawer = await page.evaluate(() => ({
    open: !document.getElementById('drawer').hidden,
    sp: document.querySelectorAll('#drawer [data-msp]').length,
    forms: document.querySelectorAll('#drawer [data-mform]').length,
    paused: window.__fm.speed().paused,
  }));
  ok(drawer.open && drawer.sp === 6 && drawer.forms === 7, '경기 중 시트에 포메이션 7종·세트피스 6개가 있습니다',
    `포메이션 ${drawer.forms} · 세트피스 ${drawer.sp}`);
  ok(drawer.paused, '시트를 열면 경기가 멈춥니다');
  await page.locator('#drawer [data-msp="corner"][data-key="near"]').click();
  await sleep(300);
  const afterSp = await matchState(page);
  ok(afterSp.setpiece.corner === 'near', '경기 중 시트에서 바꾼 지시가 엔진에 들어갑니다', JSON.stringify(afterSp.setpiece));
  await page.locator('#drawer [data-mact="close"]').click();
  await sleep(400);

  // ⑦ 세트피스 화면 라벨 — 일시정지 상태에서 코너를 열어 지시 라벨이 뜨는지
  await page.locator('#m-pause').click();
  await sleep(300);
  await page.evaluate(() => {
    const m = window.__fm.match;
    m.pause = 0; m.phase = 'setpiece';
    m.setPiece('corner', m.userSide, m.sides[m.userSide].dir > 0 ? 99.1 : 0.9, 1.1);
    m.pause = 0;
  });
  await sleep(700);
  const spLabel = await barPixels(page);
  const spState = await page.evaluate(() => {
    const m = window.__fm.match;
    return { sp: m.sp ? { type: m.sp.type, key: m.spDirective(m.sp.type, m.sp.side) } : null };
  });
  ok(spState.sp?.type === 'corner' && spState.sp?.key === 'near', '세트피스가 열리면 지금 지시를 읽습니다', JSON.stringify(spState.sp));
  ok(spLabel && spLabel.yellow > (px?.yellow || 0), '코너 지점·지시 라벨(노랑)이 피치에 그려집니다',
    `${px?.yellow}px → ${spLabel?.yellow}px`);
  out.metrics.barsAtCorner = spLabel;
  await page.locator('#m-pause').click();
  await sleep(200);

  const errs = await page.evaluate(() => window.__fm?.errors || []);
  ok(errs.length === 0, '데스크톱 콘솔·페이지 오류 0건', errs.slice(0, 2).join(' / '));
  const scroll = await page.evaluate(() => ({ sw: document.documentElement.scrollWidth, cw: document.documentElement.clientWidth }));
  ok(scroll.sw <= scroll.cw + 1, '데스크톱 가로 스크롤 없음', `${scroll.sw} / ${scroll.cw}`);
}

/* ───────────── 모바일 390 ───────────── */
console.log('\n[모바일 390×844]');
{
  const { page } = await open({ width: 390, height: 844 }, { isMobile: true, hasTouch: true, deviceScaleFactor: 2 });
  await startCareer(page);
  await page.locator('nav.tabs [data-act="tab"][data-tab="squad"]').click();
  await sleep(500);
  const forms = await page.evaluate(() => document.querySelectorAll('[data-act="formation"]').length);
  const sp = await page.evaluate(() => document.querySelectorAll('[data-act="setpiece"]').length);
  ok(forms === 7 && sp === 6, '모바일 전술 탭 — 포메이션 7종·세트피스 6개', `${forms} / ${sp}`);
  // 버튼이 잘리거나 겹치지 않는지 (폭 안에 들어오는지)
  const fit = await page.evaluate(() => {
    const row = document.querySelector('.form-row');
    const btns = [...row.querySelectorAll('button')];
    const rr = row.getBoundingClientRect();
    return {
      overflow: btns.filter((b) => b.getBoundingClientRect().right > rr.right + 1).length,
      clipped: btns.filter((b) => b.scrollWidth > b.clientWidth + 1).length,
      lines: new Set(btns.map((b) => Math.round(b.getBoundingClientRect().top))).size,
    };
  });
  ok(fit.overflow === 0 && fit.clipped === 0, '포메이션 버튼이 잘리지 않고 줄 안에 들어갑니다', `${fit.lines}줄`);
  const segFit = await page.evaluate(() => [...document.querySelectorAll('.sp-row .seg')].map((s) => {
    const r = s.getBoundingClientRect();
    return [...s.querySelectorAll('button')].every((b) => b.getBoundingClientRect().right <= r.right + 1 && b.scrollWidth <= b.clientWidth + 1);
  }));
  ok(segFit.length === 2 && segFit.every(Boolean), '세트피스 3분할 버튼이 모바일 폭에 맞습니다');
  await page.locator('[data-act="formation"][data-formation="4-1-4-1"]').click();
  await sleep(300);
  await page.locator('[data-act="setpiece"][data-type="corner"][data-key="short"]').click();
  await sleep(400);
  await prepShot(page, '.card:has(.sp-axes)', 120);
  await page.screenshot({ path: `${SHOT_DIR}/fm-mobile.png` });
  out.metrics.mobileShot = `${SHOT_DIR}/fm-mobile.png`;

  // 모바일 경기 화면 — 체력 바가 작은 피치에서도 보이는지
  await page.locator('nav.tabs [data-act="tab"][data-tab="schedule"]').click();
  await sleep(300);
  await page.getByRole('button', { name: /경기 시작/ }).first().click();
  await page.waitForSelector('#pitch');
  await sleep(1000);
  await page.evaluate(() => {
    const m = window.__fm.match;
    let g = 0;
    while (!m.done && m.phase !== 'half' && m.t < 260 && g < 900) { m.tick(); g++; }
  });
  await sleep(1000);
  const px = await barPixels(page);
  const mstate = await matchState(page);
  out.metrics.mobileBars = px;
  ok(px && px.green > 60, '모바일 피치에도 체력 바가 그려집니다', `초록 ${px?.green}px · 노랑 ${px?.yellow}px`);
  ok(mstate && mstate.formation === '4-1-4-1', '모바일에서도 고른 포메이션으로 경기합니다', mstate?.formation);
  const scroll2 = await page.evaluate(() => ({ sw: document.documentElement.scrollWidth, cw: document.documentElement.clientWidth }));
  ok(scroll2.sw <= scroll2.cw + 1, '모바일 가로 스크롤 없음', `${scroll2.sw} / ${scroll2.cw}`);
  const errs2 = await page.evaluate(() => window.__fm?.errors || []);
  ok(errs2.length === 0, '모바일 콘솔·페이지 오류 0건', errs2.slice(0, 2).join(' / '));
}

await browser.close();
const passed = out.checks.filter((c) => c.ok).length;
out.summary = { total: out.checks.length, passed, failed: out.checks.length - passed };
mkdirSync('/workspace/tmp/fmtest', { recursive: true });
writeFileSync(OUT, JSON.stringify(out, null, 2));
console.log(`\n${out.summary.failed ? `❌ ${out.summary.failed}개 실패` : '✅ 모든 항목 통과'} (${passed}/${out.summary.total}) · 오류 ${out.errors.length}건`);
if (out.errors.length) console.log(out.errors.slice(0, 6).join('\n'));
process.exit(out.summary.failed || out.errors.length ? 1 : 0);
