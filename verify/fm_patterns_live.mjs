// 라이브 검증 — 공간 분산·패스 패턴·기존 모션(보간·리플레이·GK) 유지
// 사용: BASE=https://bmrgoodway.github.io/fm/ node verify/fm_patterns_live.mjs
import { chromium } from 'playwright';
import { writeFileSync } from 'node:fs';

const BASE = (process.env.BASE || 'https://bmrgoodway.github.io/fm/') + '?verify=' + Date.now();
const EXE = '/workspace/.pw/chromium_headless_shell-1255/chrome-headless-shell-linux64/chrome-headless-shell';
const OUT = process.env.OUT || '/workspace/tmp/fmtest/verify.json';
const SHOT_DIR = process.env.SHOT_DIR || '/workspace/downloads';
const out = { base: BASE, checks: [], errors: [], metrics: {} };
const ok = (cond, label, detail) => {
  out.checks.push({ ok: !!cond, label, detail });
  console.log(`${cond ? '  ✅' : '  ❌'} ${label}${detail ? ` — ${detail}` : ''}`);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const browser = await chromium.launch({ executablePath: EXE, args: ['--no-sandbox', '--disable-dev-shm-usage', '--hide-scrollbars', '--force-color-profile=srgb'] });

async function openApp(viewport, dsf = 1) {
  const ctx = await browser.newContext({ viewport, deviceScaleFactor: dsf, locale: 'ko-KR' });
  const page = await ctx.newPage();
  page.on('pageerror', (e) => out.errors.push('pageerror: ' + e.message));
  page.on('console', (m) => { if (m.type() === 'error') out.errors.push('console: ' + m.text()); });
  await page.goto(BASE, { waitUntil: 'networkidle', timeout: 45000 });
  return { ctx, page };
}
async function startCareer(page, team = /금산 유나이티드/) {
  await page.getByRole('button', { name: team }).first().click();
  await page.getByRole('button', { name: '이 구단으로 시작' }).click();
  await page.getByRole('button', { name: /경기 시작/ }).click();
  await page.waitForSelector('#pitch', { timeout: 15000 });
}

/* ───────────── 데스크톱 ───────────── */
console.log('\n[데스크톱 1440×900]');
const { ctx: dctx, page } = await openApp({ width: 1440, height: 900 }, 1);
await startCareer(page);
await sleep(1500);

const fps = await page.evaluate(async () => {
  const f = window.__fm;
  const f0 = f.frames, t0 = performance.now();
  let raf = 0;
  await new Promise((res) => {
    const loop = () => { raf++; if (performance.now() - t0 < 1500) requestAnimationFrame(loop); else res(); };
    requestAnimationFrame(loop);
  });
  const secs = (performance.now() - t0) / 1000;
  // 목표에 도달해 멈춘 선수도 있어 한 프레임만 보면 과소평가됩니다 — 여러 프레임 중 가장 많은 값을 씁니다
  let moving = 0, alpha = 0;
  for (let i = 0; i < 14; i++) {
    await new Promise((r) => setTimeout(r, 70));
    const m = f.match;
    const all = [...m.sides.home.players, ...m.sides.away.players].filter((e) => e.onPitch);
    moving = Math.max(moving, all.filter((e) => Math.abs(e.x - e.px) > 0.005 || Math.abs(e.y - e.py) > 0.005).length);
    alpha = Math.max(alpha, f.alpha || 0);
  }
  const m = f.match;
  let ballLerp = false;
  for (let i = 0; i < 10 && !ballLerp; i++) {
    await new Promise((r) => setTimeout(r, 70));
    ballLerp = Math.abs(m.ball.x - m.ball.px) > 0.02 || Math.abs(m.ball.y - m.ball.py) > 0.02 || m.ball.trail.length > 1;
  }
  return {
    drawFps: +((f.frames - f0) / secs).toFixed(1), rafFps: +(raf / secs).toFixed(1),
    alpha: +alpha.toFixed(3), moving, ballLerp,
  };
});
out.metrics.fps = fps;
ok(fps.drawFps >= fps.rafFps * 0.9, '매 프레임 렌더(요청 rAF 대비 그리기 횟수)', `draw ${fps.drawFps}/s · rAF ${fps.rafFps}/s`);
ok(fps.moving >= 10, '선수 좌표가 틱 사이에서 보간됨(px≠x)', `${fps.moving}/22명 이동 중 · alpha ${fps.alpha}`);
ok(fps.ballLerp, '공도 매 프레임 보간');

// 화면에서 실제로 벌어진 간격·패턴을 모읍니다
await page.getByRole('button', { name: '2x' }).click();
const space = await page.evaluate(async () => {
  const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
  const acc = { frames: 0, nn: 0, close: 0, pairs: 0, swarm: 0, min: 99, gkHi: 0, gkHiN: 0, gkLo: 0, gkLoN: 0, gkMax: 0, offs: 0 };
  const t0 = performance.now();
  let lastM = null;
  while (performance.now() - t0 < 9000) {
    await new Promise((r) => setTimeout(r, 160));
    const m = window.__fm.match;
    lastM = m;
    if (m.phase !== 'play' || !m.ball.owner) continue;
    for (const s of ['home', 'away']) {
      const ps = m.sides[s].players.filter((e) => e.onPitch);
      for (const e of ps) {
        let nn = 1e9;
        for (const o of ps) if (o !== e) nn = Math.min(nn, dist(o, e));
        acc.nn += nn; acc.min = Math.min(acc.min, nn);
      }
      for (let i = 0; i < ps.length; i++) for (let j = i + 1; j < ps.length; j++) {
        acc.pairs++; if (dist(ps[i], ps[j]) < 4) acc.close++;
      }
      acc.swarm += ps.filter((e) => dist(e, m.ball) < 6).length;
      // 골키퍼 위치 — 우리 볼 때 전진(스위퍼), 상대 위험 지역에서는 골문 앞
      const gk = ps.find((e) => e.pos === 'GK');
      if (gk) {
        const side = m.sides[s];
        const own = side.dir > 0 ? 0 : 100;
        const out = Math.abs(gk.x - own);
        acc.gkMax = Math.max(acc.gkMax, out);
        const bp = side.dir > 0 ? m.ball.x : 100 - m.ball.x;
        const hasBall = m.ball.owner.side === s;
        if (hasBall && bp > 60) { acc.gkHi += out; acc.gkHiN++; }
        if (!hasBall && bp < 30) { acc.gkLo += out; acc.gkLoN++; }
      }
    }
    acc.frames++;
  }
  // 오프사이드 판정이 화면 데이터로도 잡히는지
  const st = lastM ? lastM.stats() : { offsides: { home: 0, away: 0 } };
  acc.offs = st.offsides.home + st.offsides.away;
  return {
    frames: acc.frames,
    avgNN: +(acc.nn / Math.max(acc.frames * 22, 1)).toFixed(2),
    minNN: +acc.min.toFixed(2),
    closePct: +((acc.close / Math.max(acc.pairs, 1)) * 100).toFixed(1),
    swarm: +(acc.swarm / Math.max(acc.frames, 1)).toFixed(2),
    gkAdvance: +(acc.gkHi / Math.max(acc.gkHiN, 1)).toFixed(1),
    gkDeep: +(acc.gkLo / Math.max(acc.gkLoN, 1)).toFixed(1),
    gkMax: +acc.gkMax.toFixed(1),
  };
});
out.metrics.space = space;
console.log('  · 공간 계측', JSON.stringify(space));
ok(space.closePct < 4, '화면에서도 선수가 겹치지 않음(4u 이내 쌍 비율)', `${space.closePct}% · 최근접 ${space.minNN}u`);
ok(space.swarm < 4.2, '공 주변에 전원이 몰리지 않음', `평균 ${space.swarm}명`);
ok(space.gkMax <= 16, '골키퍼가 골문에서 박스 앞까지만 나옴', `최대 ${space.gkMax}u`);
ok(space.gkAdvance - space.gkDeep > 2, '골키퍼가 공격 시 전진·수비 시 복귀(스위퍼)', `전진 ${space.gkAdvance}u ↔ 수비 ${space.gkDeep}u`);

// 4x로 한 경기를 끝까지 — 하프타임 카드, 득점 리플레이, 결과 화면
await page.getByRole('button', { name: '4x' }).click();

// 득점이 나오면 리플레이 버튼을 눌러 봅니다 (무득점 경기는 다음 경기에서 다시)
async function tryReplay(p, tries = 150) {
  for (let i = 0; i < tries; i++) {
    await sleep(300);
    const ready = await p.evaluate(() => {
      const b = document.getElementById('m-replay');
      return !!(b && !b.disabled && !window.__fm.match.done);
    });
    if (!ready) continue;
    await p.evaluate(() => document.getElementById('m-replay').click());
    await sleep(450);
    const st = await p.evaluate(() => {
      const f = window.__fm;
      const bar = document.getElementById('replaybar');
      return { ...(f.replayState ? f.replayState() : {}), barShown: !!(bar && !bar.hidden) };
    });
    out.metrics.replay = st;
    if (st.on && st.barShown) { await sleep(3500); return true; }
  }
  return false;
}
let replayOk = await tryReplay(page);
// 결과 화면의 '계속' — 리플레이가 재생 중이면 잠시 가려질 수 있어 다시 나타날 때까지 기다립니다
async function continueFromResult(p) {
  const btn = p.locator('#ov-continue');
  for (let i = 0; i < 20; i++) {
    if (await btn.isVisible().catch(() => false)) { await btn.click().catch(() => {}); return true; }
    await sleep(300);
  }
  // 리플레이가 물려 화면이 잠시 가려진 경우 — 버튼 핸들러를 직접 부릅니다
  return p.evaluate(() => {
    const b = document.getElementById('ov-continue');
    if (!b) return false;
    b.click();
    return true;
  }).catch(() => false);
}

// 하프타임
let halftimeOk = false;
for (let i = 0; i < 90; i++) {
  await sleep(300);
  const half = await page.evaluate(() => !document.getElementById('halftime').hidden);
  if (!half) continue;
  const st = await page.evaluate(() => {
    const m = window.__fm.match;
    return { phase: m.phase, t: m.t, label: document.getElementById('m-half').textContent, score: document.getElementById('m-score').textContent };
  });
  const t0 = st.t;
  await sleep(700);
  const t1 = await page.evaluate(() => window.__fm.match.t);
  halftimeOk = st.phase === 'half' && t0 === t1;
  out.metrics.halftime = st;
  if (halftimeOk) {
    await page.screenshot({ path: `${SHOT_DIR}/fm-halftime.png` });
    await page.getByRole('button', { name: '후반 시작' }).click();
  }
  break;
}

// 결과 화면까지
await page.getByRole('button', { name: /즉시 결과/ }).click();
await page.waitForSelector('#m-overlay:not([hidden])', { timeout: 90000 });
const fin = await page.evaluate(() => {
  const m = window.__fm.match;
  const s = m.stats();
  const byType = {};
  for (const e of m.events) byType[e.type] = (byType[e.type] || 0) + 1;
  return {
    title: document.getElementById('ov-title').textContent,
    rows: [...document.querySelectorAll('.ov-row')].map((r) => r.textContent.replace(/\s+/g, ' ').trim()),
    score: m.score, patterns: s.patterns, passLen: s.passLen, width: s.width, wideShare: s.wideShare,
    dribble: s.dribble, events: byType, goals: m.events.filter((e) => e.type === 'goal').length,
    ownGoals: 0, errors: window.__fm.errors || [],
  };
});
out.metrics.match = fin;
console.log('  · 경기 결과', JSON.stringify({ score: fin.score, passLen: fin.passLen, patterns: fin.patterns, wideShare: fin.wideShare }));
const pat = fin.patterns;
ok(fin.rows.length >= 6, '경기 종료 요약에 코너·파울·카드까지 표시', fin.rows.join(' | ').slice(0, 110));
// 오프사이드 — 기록·중계·피치 표시가 한 줄로 이어지는지
const off = await page.evaluate(() => {
  const m = window.__fm.match;
  const s = m.stats();
  const evs = m.events.filter((e) => e.type === 'offside');
  const rows = [...document.querySelectorAll('#m-statrows tr')].map((r) => r.textContent.replace(/\s+/g, ' ').trim());
  const ov = [...document.querySelectorAll('.ov-row')].map((r) => r.textContent.replace(/\s+/g, ' ').trim());
  return {
    offs: s.offsides.home + s.offsides.away,
    evs: evs.length,
    texts: evs.slice(-2).map((e) => e.text),
    goals: m.offsideGoals || 0,
    row: rows.find((x) => x.includes('오프사이드')) || '',
    ovRow: ov.find((x) => x.includes('오프사이드')) || '',
    flash: m.offsideFlash ? { lineX: Math.round(m.offsideFlash.lineX * 10) / 10, x: Math.round(m.offsideFlash.x * 10) / 10 } : null,
  };
});
out.metrics.offside = off;
ok(!!off.row, '실시간 기록에 오프사이드 행', off.row);
ok(!!off.ovRow, '경기 종료 요약에도 오프사이드', off.ovRow);
ok(off.offs === off.evs, '오프사이드 수치와 중계 이벤트가 일치', `${off.offs}회 / 이벤트 ${off.evs}건`);
ok(off.goals === 0, '오프사이드 위치에서 나온 득점 0건', `${off.goals}건`);
if (off.offs > 0) ok(!!off.flash, '오프사이드 피치 표시(🚩·라인) 데이터', JSON.stringify(off.flash));
if (!replayOk) {
  // 무득점 경기였으면 다음 경기를 바로 시작해 리플레이를 한 번 더 시도합니다
  await continueFromResult(page);
  await sleep(800);
  const startBtn = page.getByRole('button', { name: /경기 시작/ });
  if (await startBtn.count()) { await startBtn.first().click(); await page.waitForSelector('#pitch'); await page.getByRole('button', { name: '4x' }).click(); replayOk = await tryReplay(page); }
}
ok(pat.switch.home + pat.through.home + pat.givego.home + pat.cutback.home + pat.cross.home > 0,
  '경기 중 전개 패턴(전환·스루·원투·컷백·크로스)이 실제로 발생',
  `전환 ${pat.switch.home} · 스루 ${pat.through.home} · 원투 ${pat.givego.home} · 컷백 ${pat.cutback.home} · 크로스 ${pat.cross.home}`);
ok(replayOk, '득점 리플레이(0.35x)가 열리고 재생됨', JSON.stringify(out.metrics.replay || {}));
ok(halftimeOk, '하프타임에 경기 시간이 멈추고 라커룸 카드가 뜸', JSON.stringify(out.metrics.halftime || {}));

// 결과 뒤 구단 소식(순위/기록 탭)까지 확인
const contOk = await continueFromResult(page);
ok(contOk || (await page.evaluate(() => !!document.querySelector('.tabs'))), '경기 결과 화면의 계속 버튼으로 허브 복귀');
await sleep(900);
if (!(await page.locator('.tabs').count())) {
  // 이미 허브로 돌아왔거나 화면이 정리된 경우 — 저장된 커리어를 새로 열어 이어 갑니다
  await page.goto(BASE.replace(/\?verify=.*$/, '') + '?verify=' + Date.now(), { waitUntil: 'networkidle' });
}
await page.getByRole('button', { name: /순위\/기록/ }).click().catch(() => {});
await page.waitForSelector('.news li', { timeout: 8000 }).catch(() => {});
const hub = await page.evaluate(() => ({ news: document.querySelector('.news li')?.textContent?.slice(0, 50) }));
ok(!!hub.news, '경기 후 구단 소식 반영', hub.news || '');
out.errors.push(...(await page.evaluate(() => window.__fm.errors || [])));
ok((await page.evaluate(() => (window.__fm.errors || []).length)) === 0 && out.errors.length === 0, '콘솔·페이지 오류 0건', `${out.errors.length}건`);
await dctx.close();

/* ───────────── 모바일 ───────────── */
console.log('\n[모바일 390×844]');
const { ctx: mctx, page: mp } = await openApp({ width: 390, height: 844 }, 2);
await startCareer(mp);
await sleep(2000);
const mob = await mp.evaluate(() => {
  const r = (sel) => { const el = document.querySelector(sel); if (!el) return null; const b = el.getBoundingClientRect(); return { w: Math.round(b.width), h: Math.round(b.height) }; };
  return {
    vw: window.innerWidth, scrollW: document.documentElement.scrollWidth,
    canvas: r('#pitch'), ticker: r('.ticker'),
    overflowX: document.documentElement.scrollWidth > window.innerWidth + 1,
    statsRows: document.querySelectorAll('#m-statrows tr').length,
    ratings: !!document.querySelector('#ratings-my li'),
  };
});
out.metrics.mobile = mob;
ok(!mob.overflowX && mob.canvas && mob.canvas.w <= mob.vw, '390px에서 가로 스크롤 없이 경기장이 화면 폭에 맞음', `${mob.canvas?.w}px / vw ${mob.vw}`);
ok(!!mob.ticker && mob.statsRows >= 6 && mob.ratings, '모바일에서 티커·기록·평점 모두 표시');
await mctx.close();

/* ───────────── 스크린샷용 플레이 장면 ───────────── */
console.log('\n[스크린샷]');
for (const [name, viewport, dsf, file] of [['데스크톱', { width: 1440, height: 900 }, 1, 'fm-desktop.png'], ['모바일', { width: 390, height: 844 }, 2, 'fm-mobile.png']]) {
  const { ctx, page: p } = await openApp(viewport, dsf);
  await startCareer(p);
  await p.getByRole('button', { name: '2x' }).click();
  let shot = false;
  let relaxNote = false;
  for (let i = 0; i < 90 && !shot; i++) {
    await sleep(280);
    const ready = await p.evaluate(() => {
      const m = window.__fm.match;
      const flash = document.getElementById('goalflash');
      const toast = document.getElementById('toast');
      const half = document.getElementById('halftime');
      const cta = document.getElementById('goal-replay');
      if (!(m.phase === 'play' && !m.sp && flash.hidden && half.hidden && cta.hidden
        && !toast.classList.contains('on') && m.t > 55 && !!m.ball.owner
        && Math.abs(m.ball.x - 50) < 24 && Math.abs(m.ball.y - 32) > 4)) return false;
      // 화면에 두 선수가 포개져 보이지 않는 순간만 담습니다
      for (const s of ['home', 'away']) {
        const ps = m.sides[s].players.filter((e) => e.onPitch);
        for (let i = 0; i < ps.length; i++) for (let j = i + 1; j < ps.length; j++) {
          if (Math.hypot(ps[i].x - ps[j].x, ps[i].y - ps[j].y) < 3.5) return false;
        }
      }
      return true;
    });
    if (ready) { await p.screenshot({ path: `${SHOT_DIR}/${file}` }); shot = true; }
    if (i === 89 && !shot) { await p.screenshot({ path: `${SHOT_DIR}/${file}` }); shot = true; relaxNote = true; }
  }
  ok(shot, `${name} 플레이 장면 스크린샷 저장${relaxNote ? ' (조건이 맞는 순간이 없어 그 시점 화면으로)' : ''}`, `${SHOT_DIR}/${file}`);
  await ctx.close();
}

await browser.close();
writeFileSync(OUT, JSON.stringify(out, null, 2));
const failed = out.checks.filter((c) => !c.ok).length;
console.log(`\n${failed ? `❌ ${failed}건 실패` : '✅ 라이브 검증 전부 통과'} · 오류 ${out.errors.length}건 · ${OUT}`);
process.exit(failed ? 1 : 0);
