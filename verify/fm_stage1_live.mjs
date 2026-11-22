// 1단계 완성도 검증 — 밸런스·전술 UI·경기 중 조작 (데스크톱 1440 + 모바일 390)
// 사용: BASE=https://bmrgoodway.github.io/fm/ node verify/fm_stage1_live.mjs
//   · 전술 보드가 역할·성향에 따라 실제로 움직이는지
//   · GK 칩 ↔ '우리 골문' 라벨 겹침 0, 토스트 ↔ 푸터 겹침 0, 상단 탭 클릭 가능
//   · 경기 중 전술 시트가 화면 안(스크롤) + 자동 일시정지 + 포지션별 역할 + aria-pressed
//   · 후반 시작 뒤에도 4x 유지, 콘솔·페이지 오류 0
import { chromium } from 'playwright';
import { writeFileSync, mkdirSync } from 'node:fs';

const BASE = (process.env.BASE || 'https://bmrgoodway.github.io/fm/') + (process.env.BASE ? '' : `?verify=${Date.now()}`);
const EXE = '/workspace/.pw/chromium_headless_shell-1255/chrome-headless-shell-linux64/chrome-headless-shell';
const OUT = process.env.OUT || '/workspace/tmp/fmtest/fm_stage1_live.json';
const SHOT_DIR = process.env.SHOT_DIR || '/workspace/downloads';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const out = { base: BASE, checks: [], errors: [], metrics: {} };
const ok = (c, label, detail) => {
  out.checks.push({ ok: !!c, label, detail });
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
  await sleep(600);
}
const chips = (page) => page.$$eval('.chip', (els) => els.map((e) => [e.dataset.px, e.dataset.py]));

/* ───────────── 데스크톱 1440 ───────────── */
console.log('\n[데스크톱 1440×900]');
{
  const { page } = await open({ width: 1440, height: 900 });
  await startCareer(page);
  await page.locator('.tabs [data-act="tab"][data-tab="squad"]').click();
  await page.waitForSelector('.pitchboard');
  await sleep(350);

  // GK 칩 ↔ '우리 골문' 라벨
  const gkGap = await page.evaluate(() => {
    const gk = document.querySelector('.chip.gk');
    const lab = document.querySelector('.pb-goal.bottom');
    const a = gk.getBoundingClientRect(), b = lab.getBoundingClientRect();
    const ox = Math.max(0, Math.min(a.right, b.right) - Math.max(a.left, b.left));
    const oy = Math.max(0, Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top));
    return { overlap: Math.round(ox * oy), gap: Math.round(b.top - a.bottom) };
  });
  ok(gkGap.overlap === 0, 'GK 칩과 \'우리 골문\' 라벨이 겹치지 않습니다', `겹친 면적 ${gkGap.overlap}px² · 간격 ${gkGap.gap}px`);

  const before = await chips(page);
  await page.locator('button.chip-pos').first().click();
  await sleep(300);
  const afterRole = await chips(page);
  ok(JSON.stringify(before) !== JSON.stringify(afterRole), '역할을 바꾸면 전술 보드 칩이 움직입니다');

  await page.locator('[data-act="mentality"][data-val="-1"]').click();
  await sleep(300);
  const lockPos = await chips(page);
  await page.locator('[data-act="mentality"][data-val="1"]').click();
  await sleep(300);
  const allPos = await chips(page);
  const moved = lockPos.filter((p, i) => p[0] !== allPos[i][0]).length;
  ok(moved >= 8 && JSON.stringify(lockPos) !== JSON.stringify(allPos), '팀 성향을 바꾸면 전술 보드 칩이 움직입니다', `${moved}/11 자리 이동`);
  out.metrics.board = { lock: lockPos.slice(0, 3), attack: allPos.slice(0, 3) };
  await page.screenshot({ path: `${SHOT_DIR}/fm-tactics-role.png` });

  // 다음 경기 카드가 내 라인업을 읽는가
  await page.locator('.tabs [data-act="tab"][data-tab="schedule"]').click();
  await sleep(300);
  const card = await page.evaluate(() => {
    const tac = document.querySelector('.next .tac')?.innerText || '';
    const form = document.querySelector('.next .mini-pitch')?.getAttribute('aria-label') || '';
    const saved = JSON.parse(localStorage.getItem('fm:career') || '{}');
    return { tac, form, formation: saved.myLineup?.formation, ment: saved.myLineup?.tactic?.mentality };
  });
  ok(card.form.includes(card.formation) && card.ment === 1 && card.tac.includes('총공세'), '다음 경기 카드가 내 포메이션·전술을 그대로 보여줍니다',
    `${card.form.split(' ')[1]} · ${card.tac.replace(/\n/g, ' ')}`);

  // 경기 중 전술 시트
  await page.getByRole('button', { name: /경기 시작/ }).first().click();
  await page.waitForSelector('#pitch');
  await sleep(900);
  await page.locator('.spd[data-speed="4"]').click();
  await sleep(250);
  await page.locator('[data-mact="tactics"]').click();
  await sleep(300);
  const box = await page.locator('#drawer').boundingBox();
  const vh = await page.evaluate(() => window.innerHeight);
  ok(box.y >= -1 && box.y + box.height <= vh + 1, '경기 중 전술 시트가 화면 안에 있습니다', `bottom ${Math.round(box.y + box.height)} / ${vh}`);
  const sc = await page.evaluate(() => { const d = document.getElementById('drawer'); return { sh: d.scrollHeight, ch: d.clientHeight, ov: getComputedStyle(d).overflowY }; });
  ok(['auto', 'scroll'].includes(sc.ov), '전술 시트 안에서 스크롤됩니다', `${sc.ov} ${sc.sh}/${sc.ch}`);
  const paused = await page.evaluate(() => window.__fm.speed().paused);
  ok(paused, '전술 시트를 열면 경기가 자동으로 멈춥니다');
  const roleRows = await page.locator('#drawer .role-row').count();
  ok(roleRows >= 10, '경기 중 포지션별 역할 변경', `${roleRows}개 자리`);
  const role1 = await page.locator('#drawer .role-row .rr-role').first().innerText();
  await page.locator('#drawer .role-row').first().click();
  await sleep(250);
  const role2 = await page.locator('#drawer .role-row .rr-role').first().innerText();
  ok(role1 !== role2, '경기 중 역할이 실제로 바뀝니다', `${role1.trim()} → ${role2.trim()}`);
  const pressed = await page.$$eval('#drawer [data-mment]', (els) => els.map((e) => e.getAttribute('aria-pressed')));
  ok(pressed.filter((v) => v === 'true').length === 1, '성향 버튼 aria-pressed', pressed.join(','));
  await page.screenshot({ path: `${SHOT_DIR}/fm-playtest-desktop-ingame.png` });
  await page.locator('#drawer [data-mact="close"]').click();
  await sleep(250);
  const resumed = await page.evaluate(() => window.__fm.speed());
  ok(!resumed.paused && resumed.speed === 4, '시트를 닫으면 이전 배속(4x)으로 돌아옵니다', JSON.stringify(resumed));

  // 하프타임 → 후반 배속 유지
  for (let i = 0; i < 50; i++) {
    if (await page.evaluate(() => window.__fm.speed().phase) === 'half') break;
    await sleep(500);
  }
  const htRows = await page.locator('#ht-body .role-row').count();
  ok(htRows >= 10, '라커룸에서도 포지션별 역할', `${htRows}개`);
  await page.locator('#ht-start').click();
  await sleep(700);
  const s2 = await page.evaluate(() => window.__fm.speed());
  ok(s2.speed === 4 && s2.half === 2, '후반에도 배속이 1x로 돌아가지 않습니다', JSON.stringify(s2));
}

/* ───────────── 모바일 390 ───────────── */
console.log('\n[모바일 390×844]');
{
  const { page } = await open({ width: 390, height: 844 }, { deviceScaleFactor: 2, isMobile: true, hasTouch: true });
  await startCareer(page);
  await page.locator('.tabs [data-act="tab"][data-tab="squad"]').click();
  await page.waitForSelector('.pitchboard');
  await sleep(400);
  const hs = await page.evaluate(() => ({ sw: document.documentElement.scrollWidth, cw: document.documentElement.clientWidth }));
  ok(hs.sw <= hs.cw + 1, '가로 스크롤이 없습니다', `${hs.sw} ≤ ${hs.cw}`);

  await page.locator('button.chip-pos').first().scrollIntoViewIfNeeded();
  await sleep(200);
  const hit = await page.evaluate(() => {
    const el = document.querySelector('button.chip-pos');
    const r = el.getBoundingClientRect();
    const cx = r.left + r.width / 2;
    const probe = (dy) => {
      const t = document.elementFromPoint(cx, r.top + r.height / 2 + dy);
      return t === el || el.contains(t);
    };
    return { w: Math.round(r.width), h: Math.round(r.height), up: probe(-14), down: probe(+16) };
  });
  ok(hit.up && hit.down, '모바일 역할 배지 터치 영역(≥44px)', `보임 ${hit.w}×${hit.h}px · 히트 위/아래 ${hit.up}/${hit.down}`);

  const gkGap = await page.evaluate(() => {
    const gk = document.querySelector('.chip.gk');
    const lab = document.querySelector('.pb-goal.bottom');
    const a = gk.getBoundingClientRect(), b = lab.getBoundingClientRect();
    const ox = Math.max(0, Math.min(a.right, b.right) - Math.max(a.left, b.left));
    const oy = Math.max(0, Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top));
    return Math.round(ox * oy);
  });
  ok(gkGap === 0, '모바일에서도 GK 칩과 골문 라벨이 겹치지 않습니다', `${gkGap}px²`);

  await page.evaluate(() => window.scrollTo(0, 500));
  await sleep(250);
  const tabHit = await page.evaluate(() => {
    const tab = document.querySelector('.tabs .tab');
    const r = tab.getBoundingClientRect();
    const t = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
    return { hit: t === tab || tab.contains(t), top: Math.round(r.top) };
  });
  ok(tabHit.hit, '스크롤 상태에서도 상단 탭을 누를 수 있습니다', `탭 top ${tabHit.top}`);
  await page.evaluate(() => window.scrollTo(0, 0));

  await page.screenshot({ path: `${SHOT_DIR}/fm-mobile.png` });

  await page.locator('.tabs [data-act="tab"][data-tab="schedule"]').click();
  await sleep(250);
  await page.getByRole('button', { name: /경기 시작/ }).first().click();
  await page.waitForSelector('#pitch');
  await sleep(900);
  await page.locator('.spd[data-speed="4"]').click();
  await sleep(200);
  await page.locator('[data-mact="tactics"]').click();
  await sleep(350);
  const mbox = await page.locator('#drawer').boundingBox();
  const mvh = await page.evaluate(() => window.innerHeight);
  ok(mbox.y >= -1 && mbox.y + mbox.height <= mvh + 2, '모바일 전술 시트가 화면 밖으로 잘리지 않습니다', `top ${Math.round(mbox.y)} bottom ${Math.round(mbox.y + mbox.height)} / ${mvh}`);
  await page.screenshot({ path: `${SHOT_DIR}/fm-tactics-mobile.png` });
  await page.locator('#drawer [data-mact="close"]').click();
  await sleep(250);

  // 토스트 ↔ 푸터
  await page.evaluate(() => { const t = document.getElementById('toast'); t.textContent = '검증 토스트'; t.classList.add('on'); window.scrollTo(0, 100000); });
  await sleep(300);
  const tf = await page.evaluate(() => {
    const t = document.getElementById('toast').getBoundingClientRect();
    const f = document.querySelector('.foot p').getBoundingClientRect();
    return { overlap: !(t.bottom < f.top || t.top > f.bottom), toastTop: Math.round(t.top), footBottom: Math.round(f.bottom) };
  });
  ok(!tf.overlap, '토스트가 푸터 글자와 겹치지 않습니다', JSON.stringify(tf));
}

ok(out.errors.length === 0, '콘솔·페이지 오류 0건', out.errors.slice(0, 3).join(' | ') || '없음');
await browser.close();
const fails = out.checks.filter((c) => !c.ok).length;
mkdirSync(OUT.replace(/\/[^/]+$/, ''), { recursive: true });
writeFileSync(OUT, JSON.stringify(out, null, 2));
console.log(`\n${fails ? `❌ ${fails}개 실패` : '✅ 모든 항목 통과'} (${out.checks.length}개 점검) → ${OUT}`);
process.exit(fails ? 1 : 0);
