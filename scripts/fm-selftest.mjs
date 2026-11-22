#!/usr/bin/env node
// 매치 엔진 자체 점검 — 브라우저 없이 node 로 돌립니다.
//   1) 전술 4축이 선수 좌표를 실제로 얼마나 바꾸는지
//   2) 하프타임 정지·후반 진영 교대
//   3) 세트피스(코너) 배치와 전개
//   4) 경고 누적 퇴장 · 부상 · 10명 수적 열세
//   5) 프레임 보간용 이전 좌표(px,py) 기록
//   6) 다경기 밸런스(득점·xG·코너·프리킥·골킥·파울·카드·부상)
//   7~10) 오픈 플레이 공간 · 전술별 전개 패턴 · 골키퍼 · 오프사이드
//   11) 팀 성향(멘탈리티) 5단계 — 평균 라인·가담 인원·슈팅·득점/실점
//   12) 포지션별 역할(Role) — 좌표·크로스/스루패스 선택·압박 반경·개인 슈팅/침투
//   13) 역할·팀 성향이 없는 기존 세이브 호환
// 사용: node scripts/fm-selftest.mjs [경기수]
import { createWorld, loadWorld, saveWorld, autoLineup, setFormation, setRole, lineupInfo, fillLineup, mySetup } from '../src/world.js';
import { Match, lineupFor, applyResult, CY, W, aiMentalityPlan } from '../src/match.js';
import { FORMATIONS } from '../src/data.js';
import { roleFor, resolveRoles, defaultRole, ROLE_TUNING, MENTALITY, tacticWords, mentalityOf } from '../src/tactics.js';
import { boardPos } from '../src/views.js';
import { scoutReport, threatOf } from '../src/scout.js';

const N = Number(process.argv[2] || 24);
const prog = (x, dir) => (dir > 0 ? x : 100 - x);   // 공격 방향 기준 진행도
let fails = 0;
const ok = (cond, label, detail = '') => {
  console.log(`${cond ? '  ✅' : '  ❌'} ${label}${detail ? ` — ${detail}` : ''}`);
  if (!cond) fails += 1;
};

const world = createWorld('gs', 20261122);
const ids = Object.keys(world.teams);

function newMatch(homeId = 'gs', awayId = 'dj', seed = 'selftest') {
  const m = new Match({
    world, homeId, awayId,
    homeLineup: lineupFor(world, homeId),
    awayLineup: lineupFor(world, awayId),
    seed, cup: false, userSide: 'home',
  });
  m.holdHalf = true;
  return m;
}

/* ── 1. 전술 → 좌표 ── */
// 공을 중앙에 고정하고 '목표 좌표'만 계산해 네 축의 효과를 정확히 잽니다.
function shapeProbe(tactic, hasBall = true, w = world) {
  const m = new Match({ world: w, homeId: 'gs', awayId: 'dj', homeLineup: lineupFor(w, 'gs'), awayLineup: lineupFor(w, 'dj'), seed: 'shape', cup: false, userSide: 'home' });
  m.holdHalf = true;
  m.sides.home.tactic = { line: 0, pass: 0, press: 0, route: 0, ...tactic };
  const side = m.sides.home;
  const gk = side.players.find((e) => e.onPitch && e.pos === 'GK');
  m.ball.x = 50; m.ball.y = 32;
  m.ball.owner = hasBall ? gk : m.sides.away.players.find((e) => e.onPitch && e.pos === 'MF');
  side._shape = m.computeShape(side, hasBall);
  side._pressers = hasBall ? [] : side.players.filter((e) => e.onPitch && e.pos !== 'GK')
    .sort((a, b) => Math.hypot(a.x - m.ball.x, a.y - m.ball.y) - Math.hypot(b.x - m.ball.x, b.y - m.ball.y));
  // 지원 패스 옵션(가장 가까운 두 명)은 공 옆으로 붙으므로 평균에서 제외합니다
  const mates = side.players.filter((e) => e.onPitch && e.pos !== 'GK' && e !== m.ball.owner)
    .sort((a, b) => Math.hypot(a.x - m.ball.x, a.y - m.ball.y) - Math.hypot(b.x - m.ball.x, b.y - m.ball.y));
  const skip = new Set(hasBall ? mates.slice(0, 2) : []);
  const out = { df: 0, mf: 0, fw: 0, wing: 0, pressN: side._shape.pressCount, shape: side._shape };
  const c = { df: 0, mf: 0, fw: 0, wing: 0 };
  for (const e of side.players) {
    if (!e.onPitch || e.pos === 'GK' || e === m.ball.owner || skip.has(e)) continue;
    const t = m.targetFor(e, side, hasBall);
    if (e.pos === 'DF') { out.df += t.x; c.df += 1; }
    if (e.pos === 'MF') { out.mf += t.x; c.mf += 1; }
    if (e.pos === 'FW') { out.fw += t.x; c.fw += 1; }
    if (e.pos === 'FW' && Math.abs(e.slot.y - 0.5) > 0.3) { out.wing += Math.abs(t.y - 32); c.wing += 1; }
  }
  for (const k of ['df', 'mf', 'fw', 'wing']) out[k] /= Math.max(c[k], 1);
  return out;
}

// 수비 블록이 실제로 어느 높이에 서는지 — 상대 미드필더가 우리 진영에서 공을 소유한 채 블록을 마주하게 두고,
// 가장 깊은 수비수 두 명(=실제 수비 라인)의 평균 x 를 잽니다. (경기 중 전환 국면의 잡음 없이 라인만 측정)
function blockProbe(tactic, ticks = 90) {
  // 상대 미드필더가 우리 진영(x=34)에 공을 가진 채 블록을 마주하게 고정하고,
  // 가장 깊은 수비수 두 명(= 실제 수비 라인)의 평균 x 를 여러 판본으로 재어 평균합니다.
  let sum = 0, n = 0;
  for (const seed of ['b1', 'b2', 'b3']) {
    const m = newMatch('gs', 'dj', `${seed}-${JSON.stringify(tactic)}`);
    m.sides.home.tactic = { line: 0, pass: 0, press: 0, route: 0, ...tactic };
    m.sides.away.tactic = { line: 0, pass: 0, press: 0, route: 0 };
    for (let i = 0; i < ticks; i++) {
      const away = m.sides.away.players.find((e) => e.onPitch && e.pos === 'MF');
      if (away) {
        m.phase = 'play'; m.pause = 0; m.sp = null;
        m.ball.owner = away; m.ball.mode = 'carry';
        away.x = 34; away.y = CY; away.px = 34; away.py = CY; away.warp = null; away.decCd = 99;
        m.ball.x = 34.9; m.ball.y = CY;
      }
      m.tick();
      // 전환 국면(공이 우리 골문 쪽으로 밀리거나 소유가 바뀐 순간)은 빼고 블록이 선 상태만 잽니다
      if (m.phase !== 'play' || !m.ball.owner || m.ball.owner.side !== 'away' || m.ball.x > 42) continue;
      const dfs = m.sides.home.players.filter((e) => e.onPitch && e.pos === 'DF').map((e) => e.x).sort((a, b) => a - b);
      sum += (dfs[0] + (dfs[1] ?? dfs[0])) / 2; n += 1;
    }
  }
  return sum / Math.max(n, 1);
}

// 경기 중에도 실제로 그렇게 서는지 (압박 인원·라인 높이)
function liveProbe(tactic, ticks = 120) {
  const m = newMatch('gs', 'dj', `live-${JSON.stringify(tactic)}`);
  m.sides.home.tactic = { line: 0, pass: 0, press: 0, route: 0, ...tactic };
  m.sides.away.tactic = { line: 0, pass: 0, press: 0, route: 0 };
  let df = 0, press = 0, n = 0, pn = 0;
  for (let i = 0; i < ticks; i++) {
    m.tick();
    if (m.phase !== 'play') continue;
    const s = m.sides.home;
    if (Math.abs(m.ball.x - 50) < 16) df += s.players.filter((e) => e.onPitch && e.pos === 'DF').reduce((a, e) => a + e.x, 0) / 4;
    if (m.ball.owner && m.ball.owner.side === 'away') {
      // 실제로 '압박하러 달려든' 선수 수
      press += s.players.filter((e) => e.onPitch && e.press).length;
      pn += 1;
    }
    if (Math.abs(m.ball.x - 50) < 16) n += 1;
  }
  return { df: df / Math.max(n, 1), press: press / Math.max(pn, 1) };
}

/* ── 팀 성향·역할 점검 도우미 ── */
// 포메이션 슬롯 라벨별로 역할·성향을 바꿔 라인업을 만듭니다 (예: { roles: { LW: 'inside' }, tactic: { mentality: 1 } })
function lineupWith(w, teamId, { tactic = {}, roles = {} } = {}) {
  const base = lineupFor(w, teamId);
  const slots = FORMATIONS[base.formation].slots;
  const cur = resolveRoles(base.roles, slots);
  return {
    ...base,
    tactic: { line: 0, pass: 0, press: 0, route: 0, mentality: 0, ...(base.tactic || {}), ...tactic },
    roles: slots.map((s, i) => roleFor(s.label, roles[s.label] || cur[i])),
  };
}

// 공 하나를 고정한 '한 장면'에서 특정 자리 선수의 목표 좌표를 잽니다 (오프더볼 자리 비교)
function slotProbe({ w = world, slotLabel, role, tactic = {}, ball = { x: 50, y: CY }, hasBall = true }) {
  const m = new Match({ world: w, homeId: 'gs', awayId: 'dj', homeLineup: lineupFor(w, 'gs'), awayLineup: lineupFor(w, 'dj'), seed: `slot-${slotLabel}-${role}-${ball.x}-${ball.y}-${JSON.stringify(tactic)}`, cup: false, userSide: 'home' });
  m.holdHalf = true;
  m.sides.home.tactic = { line: 0, pass: 0, press: 0, route: 0, mentality: 0, ...tactic };
  const side = m.sides.home;
  const idx = FORMATIONS[side.formation].slots.findIndex((s) => s.label === slotLabel);
  const e = side.players[idx];
  if (role) e.role = roleFor(slotLabel, role);
  m.ball.x = ball.x; m.ball.y = ball.y;
  m.ball.owner = hasBall ? side.players.find((x) => x.pos === 'GK')
    : m.sides.away.players.find((x) => x.onPitch && x.pos === 'MF');
  m.ball.mode = 'carry';
  side._shape = m.computeShape(side, hasBall);
  side._pressers = side.players.filter((x) => x.onPitch && x.pos !== 'GK')
    .sort((a, b) => Math.hypot(a.x - m.ball.x, a.y - m.ball.y) - Math.hypot(b.x - m.ball.x, b.y - m.ball.y));
  const t = m.targetFor(e, side, hasBall);
  return { x: prog(t.x, side.dir), y: t.y, e, m };
}

// 한 장면에서 '어느 동료에게 어떤 종류로 패스하는가'를 잽니다 (역할별 패스 선택 비교)
function passProbe({ w = world, slotLabel, role, carrier, mates = [], pressure = 1.2, seed = null }) {
  const m = new Match({ world: w, homeId: 'gs', awayId: 'dj', homeLineup: lineupFor(w, 'gs'), awayLineup: lineupFor(w, 'dj'), seed: seed || `pass-${slotLabel}-${role}-${carrier.x}-${carrier.y}`, cup: false, userSide: 'home' });
  m.sides.home.tactic = { line: 0, pass: 0, press: 0, route: 0, mentality: 0 };
  const side = m.sides.home;
  const slots = FORMATIONS[side.formation].slots;
  const c = side.players[slots.findIndex((s) => s.label === slotLabel)];
  for (const e of side.players) { e.x = e.slot.x * W; e.y = e.slot.y * 64; e.decCd = 99; }
  c.role = roleFor(slotLabel, role);
  c.x = carrier.x; c.y = carrier.y;
  for (const spec of mates) {
    const e = side.players[slots.findIndex((s) => s.label === spec.label)];
    if (!e) continue;
    if (spec.role) e.role = roleFor(spec.label, spec.role);
    e.x = spec.x; e.y = spec.y; e.decCd = 99;
    if (spec.run) e.runT = spec.run;
  }
  m.ball.owner = c; m.ball.mode = 'carry'; m.ball.x = c.x + side.dir * 0.9; m.ball.y = c.y;
  side._shape = m.computeShape(side, true);
  const best = m.bestPass(c, pressure, side._shape);
  return { kind: best ? best.kind : null, to: best ? best.mate.label : null, score: best ? best.score : 0 };
}

// 같은 장면을 여러 난수로 돌려 '어떤 패스를 고르는지' 비율을 잽니다
function passRateProbe({ w = world, slotLabel, role, carrier, mates = [], trials = 24 }) {
  const out = { through: 0, cross: 0, other: 0, kinds: {}, score: 0 };
  for (let i = 0; i < trials; i++) {
    const r = passProbe({ w, slotLabel, role, carrier, mates, seed: `pr-${slotLabel}-${role}-${i}` });
    out.kinds[r.kind] = (out.kinds[r.kind] || 0) + 1;
    out.score += r.score;
    if (r.kind === 'through') out.through += 1;
    else if (r.kind === 'cross') out.cross += 1;
    else out.other += 1;
  }
  out.avg = out.score / trials;
  return out;
}

// 같은 자리에서 '슛을 고르는 비율'을 잽니다 — 역할의 슈팅 성향 차이 (난수 300회)
function shootProbe({ w = world, slotLabel, role, at = { x: 76, y: CY }, trials = 300 }) {
  const m = new Match({ world: w, homeId: 'gs', awayId: 'dj', homeLineup: lineupFor(w, 'gs'), awayLineup: lineupFor(w, 'dj'), seed: `shoot-${slotLabel}-${role}-${at.x}`, cup: false, userSide: 'home' });
  const side = m.sides.home;
  const slots = FORMATIONS[side.formation].slots;
  const e = side.players[slots.findIndex((s) => s.label === slotLabel)];
  e.role = roleFor(slotLabel, role);
  for (const o of m.sides.away.players) if (o.onPitch) { o.x = 8; o.y = CY; }
  for (const mate of side.players) if (mate !== e) { mate.x = 30; mate.y = CY; }
  let shots = 0;
  for (let i = 0; i < trials; i++) {
    m.phase = 'play'; m.sp = null; m.pause = 0; m.t = 200;
    m.ball.mode = 'carry'; m.ball.owner = e; m.ball.x = at.x; m.ball.y = at.y;
    e.x = at.x; e.y = at.y; e.decCd = 0;
    m.thinkCarrier();
    if (m.ball.mode === 'shot') shots += 1;
  }
  return shots / trials;
}

// 실제 경기 여러 판 — 라인·공 뒤에 남는 인원·슈팅·득점, 그리고 지정한 자리 선수의 개인 기록
function statsProbe({ w = world, home = {}, n = 6, prefix = 'st', track = [] } = {}) {
  const agg = { line: 0, lineN: 0, join: 0, joinN: 0, fw: 0, fwN: 0, behind: 0, behindN: 0, gf: 0, ga: 0, shots: 0, oppShots: 0, xg: 0, oppXg: 0 };
  agg.slots = {};
  for (const lab of track) agg.slots[lab] = { x: 0, y: 0, n: 0, high: 0, shots: 0, crosses: 0, runs: 0 };
  for (let i = 0; i < n; i++) {
    const homeLineup = lineupWith(w, 'gs', home);
    const awayLineup = lineupWith(w, 'dj', {});
    const m = new Match({ world: w, homeId: 'gs', awayId: 'dj', homeLineup, awayLineup, seed: `${prefix}-${i}`, cup: false, userSide: 'home' });
    m.holdHalf = false;
    let g = 0;
    while (!m.done && g < 5000) {
      m.tick(); g++;
      if (m.phase !== 'play') continue;
      const s = m.sides.home;
      // 세트피스·킥오프 직후(자리로 모이는 중)는 빼고 '자리를 잡고 뛰는' 장면만 잽니다
      if (m.t - (m.lastSetPieceT ?? -99) < 8 || m.t - (m.lastKickoffT ?? -99) < 8) continue;
      const ours = m.ball.owner && m.ball.owner.side === 'home';
      const theirs = m.ball.owner && m.ball.owner.side === 'away';
      if (theirs) {
        const dfs = s.players.filter((e) => e.onPitch && e.pos === 'DF' && !e.press).map((e) => prog(e.x, s.dir));
        if (dfs.length) { agg.line += dfs.reduce((a, b) => a + b, 0) / dfs.length; agg.lineN += 1; }
        const ballP = prog(m.ball.x, s.dir);
        agg.behind += s.players.filter((e) => e.onPitch && e.pos !== 'GK' && prog(e.x, s.dir) < ballP).length; agg.behindN += 1;
      }
      if (ours) {
        const out = s.players.filter((e) => e.onPitch && e.pos !== 'GK');
        agg.join += out.filter((e) => prog(e.x, s.dir) > 62).length; agg.joinN += 1;
        const fws = s.players.filter((e) => e.onPitch && e.pos === 'FW');
        if (fws.length) { agg.fw += fws.reduce((a, e) => a + prog(e.x, s.dir), 0) / fws.length; agg.fwN += 1; }
        for (const lab of track) {
          const idx = FORMATIONS[s.formation].slots.findIndex((q) => q.label === lab);
          const e = s.players[idx];
          if (!e || !e.onPitch) continue;
          const slot = agg.slots[lab];
          slot.x += prog(e.x, s.dir); slot.y += Math.abs(e.y - CY); slot.n += 1;
          if (prog(e.x, s.dir) > 50) slot.high += 1;
          if (e.runT > 0) slot.runs += 1;
        }
      }
    }
    if (!m.done) m.finish();
    const st = m.stats();
    agg.gf += m.score.home; agg.ga += m.score.away;
    agg.shots += st.shots.home; agg.oppShots += st.shots.away;
    agg.xg += st.xg.home; agg.oppXg += st.xg.away;
    for (const lab of track) {
      const idx = FORMATIONS[m.sides.home.formation].slots.findIndex((q) => q.label === lab);
      const e = m.sides.home.players[idx];
      if (!e) continue;
      agg.slots[lab].shots += e.st.shots; agg.slots[lab].crosses += e.st.crosses || 0;
    }
  }
  agg.line /= Math.max(agg.lineN, 1);
  agg.join /= Math.max(agg.joinN, 1);
  agg.fw /= Math.max(agg.fwN, 1);
  agg.behind /= Math.max(agg.behindN, 1);
  for (const lab of track) {
    const s = agg.slots[lab];
    s.x /= Math.max(s.n, 1); s.y /= Math.max(s.n, 1);
  }
  agg.per = (v) => v / n;
  agg.n = n;
  return agg;
}

console.log('\n[1] 전술 4축 → 좌표 변화');
{
  const low = shapeProbe({ line: -1 }), high = shapeProbe({ line: 1 });
  ok(high.df - low.df > 8, '높은 라인 vs 낮은 라인 — 수비 라인이 눈에 띄게 전진', `DF 목표 x ${low.df.toFixed(1)} → ${high.df.toFixed(1)} (Δ${(high.df - low.df).toFixed(1)})`);
  ok(high.mf - low.mf > 8, '높은 라인 — 미드필더도 함께 올라감', `MF 목표 x ${low.mf.toFixed(1)} → ${high.mf.toFixed(1)} (Δ${(high.mf - low.mf).toFixed(1)})`);
  const lowDef = shapeProbe({ line: -1 }, false), highDef = shapeProbe({ line: 1 }, false);
  ok(highDef.df - lowDef.df > 8, '수비 시에도 라인 높이 차이 유지(블록 형성)', `수비 DF ${lowDef.df.toFixed(1)} → ${highDef.df.toFixed(1)}`);
  const central = shapeProbe({ route: -1 }), wide = shapeProbe({ route: 1 });
  ok(wide.wing - central.wing > 5, '측면 집중 vs 중앙 — 윙어가 터치라인까지 벌어짐', `윙어 중앙이탈 ${central.wing.toFixed(1)} → ${wide.wing.toFixed(1)} (Δ${(wide.wing - central.wing).toFixed(1)})`);
  ok(central.fw - central.mf > 0 && wide.fw > central.fw - 12, '중앙 집중 시 공격수는 좁게, 측면 집중 시 폭을 씀');
  const pl = shapeProbe({ press: -1 }, false), ph = shapeProbe({ press: 1 }, false);
  ok(ph.pressN - pl.pressN >= 2, '강한 압박 — 볼 주변 압박 인원 1명 → 3명 이상', `${pl.pressN}명 → ${ph.pressN}명`);
  const passShort = shapeProbe({ pass: -1 }), passLong = shapeProbe({ pass: 1 });
  ok(Math.abs(passLong.fw - passShort.fw) > 3, '롱볼 vs 짧은 패스 — 최전방 높이 차이', `FW x ${passShort.fw.toFixed(1)} → ${passLong.fw.toFixed(1)}`);
  // 경기 안에서도 실제 좌표가 달라지는지 (수비 블록의 실제 라인)
  const b1 = blockProbe({ line: -1 }), b2 = blockProbe({ line: 1 });
  ok(b2 - b1 > 3, '경기 중 실제 수비 라인 위치도 달라짐', `수비 라인 x ${b1.toFixed(1)} → ${b2.toFixed(1)} (Δ${(b2 - b1).toFixed(1)})`);
  const p1 = liveProbe({ press: -1 }), p2 = liveProbe({ press: 1 });
  ok(p2.press - p1.press > 0.5, '경기 중 볼 주변 압박 인원 차이', `${p1.press.toFixed(2)}명 → ${p2.press.toFixed(2)}명`);
}

/* ── 2. 하프타임 · 진영 교대 ── */
console.log('\n[2] 하프타임 · 진영 교대');
{
  const m = newMatch('gs', 'dj', 'half');
  let g = 0;
  while (m.phase !== 'half' && g < 2000) { m.tick(); g++; }
  ok(m.phase === 'half', '전반 종료 시 하프타임 진입', `${m.t}틱 / ${m.minute()}분`);
  const t0 = m.t;
  m.tick(); m.tick();
  ok(m.t === t0, '하프타임에는 경기 시간이 멈춤(감독이 전술·교체 정비)', `${t0} → ${m.t}`);
  const before = m.sides.home.dir;
  m.startSecondHalf();
  ok(m.half === 2 && m.sides.home.dir === -before && m.sides.away.dir === before, '후반 시작 시 양 팀 공격 방향 교대',
    `home ${before} → ${m.sides.home.dir}`);
  const dfX = m.sides.home.players.filter((e) => e.onPitch && e.pos === 'DF').reduce((a, e) => a + e.x, 0) / 4;
  ok(dfX > 100 - dfX, '후반 좌표가 실제로 반대편으로 이동', `home DF 평균 x ${dfX.toFixed(1)}`);
  ok(m.phase === 'play' && !!m.ball.owner, '후반 킥오프로 재개');
}

/* ── 3. 세트피스 ── */
console.log('\n[3] 세트피스');
{
  const m = newMatch('gs', 'dj', 'setpiece');
  for (let i = 0; i < 10; i++) m.tick();
  m.setPiece('corner', 'home', 99, 1);
  ok(m.phase === 'setpiece', '코너킥 선언');
  for (let i = 0; i < 3; i++) m.tick();
  const inBox = m.sides.home.players.filter((e) => e.onPitch && e.x > 84 && Math.abs(e.y - 32) < 23).length;
  ok(inBox >= 3, '코너 시 공격수들이 박스로 모임', `박스 안 ${inBox}명`);
  const defInBox = m.sides.away.players.filter((e) => e.onPitch && e.x > 82).length;
  ok(defInBox >= 5, '수비수들도 문전에 배치', `수비 ${defInBox}명`);
  // 배치가 끝나면 실제로 차서 흐름이 이어져야 합니다 (수비 걷어내기·파울로 새 세트피스가 나올 수 있음)
  let g = 0;
  while (m.phase === 'setpiece' && m.sp && m.sp.type === 'corner' && g < 20) { m.tick(); g++; }
  ok(!(m.phase === 'setpiece' && m.sp && m.sp.type === 'corner'), '준비 후 킥 전개', `phase=${m.phase}${m.sp ? ' · ' + m.sp.type : ''} · ${g}틱`);
}
{
  const m = newMatch('gs', 'dj', 'gk');
  for (let i = 0; i < 8; i++) m.tick();
  const s = m.stats();
  const before = s.goalKicks.home + s.goalKicks.away;
  const gk = m.goalKickSpot('away');
  m.setPiece('goalkick', 'away', gk.x, gk.y);
  for (let i = 0; i < 6; i++) m.tick();
  const after = m.stats().goalKicks.home + m.stats().goalKicks.away;
  ok(after === before + 1, '골킥 집계', `${before} → ${after}`);
}

/* ── 4. 카드 · 퇴장 · 부상 ── */
console.log('\n[4] 경고 · 퇴장 · 부상');
{
  const m = newMatch('gs', 'dj', 'cards');
  for (let i = 0; i < 10; i++) m.tick();
  const side = m.sides.home;
  const p = side.players.find((e) => e.onPitch && e.pos !== 'GK');
  m.giveCard(p, 'yellow');
  ok(p.st.yellow === 1 && p.onPitch, '옐로카드 1장 — 계속 출전');
  m.giveCard(p, 'yellow');
  ok(p.sentOff && !p.onPitch && side.players.filter((e) => e.onPitch).length === 10, '경고 누적 2장 → 퇴장·10명', `${side.players.filter((e) => e.onPitch).length}명`);
  ok(side.reds === 1 && side.stats.red === 1, '퇴장 기록 집계');
  const q = side.players.find((e) => e.onPitch && e.pos !== 'GK');
  const before = q.factor;
  m.injure(q, side, 'test');
  ok(q.injured && q.factor < before && side.stats.injuries === 1, '부상 — 능력치 저하와 부상 집계', `factor ${before.toFixed(2)} → ${q.factor.toFixed(2)}`);
  ok(m.events.some((e) => e.type === 'injury') && m.events.some((e) => e.type === 'card'), '중계 기록에 부상·카드 이벤트');
}

/* ── 4-2. 다음 경기 출전 정지 · 부상 결장 연결 ── */
console.log('\n[4-2] 다음 경기 출전 정지 · 부상');
{
  const m = newMatch('gs', 'dj', 'susp');
  for (let i = 0; i < 6; i++) m.tick();
  const side = m.sides[m.userSide];
  const victim = side.players.find((e) => e.onPitch && e.pos === 'DF');
  const hurt = side.players.find((e) => e.onPitch && e !== victim && e.pos === 'MF');
  m.giveCard(victim, 'red');
  m.injure(hurt, side, 'test');
  let g = 0;
  while (!m.done && g < 4000) { m.tick(); g++; }
  if (!m.done) m.finish();
  applyResult(world, m);
  const pv = world.players[victim.id], ph = world.players[hurt.id];
  ok(pv.bans === 1, '퇴장 → 다음 경기 출전 정지 1경기', `${pv.name} bans=${pv.bans}`);
  ok(ph.inj >= 1, '부상 → 결장 경기 수 기록', `${ph.name} inj=${ph.inj}`);
  const l = lineupFor(world, world.myTeamId);
  ok(!l.starters.includes(pv.id), '정지 선수는 다음 경기 선발에서 빠짐', `${pv.name}`);
  ok(!l.starters.includes(ph.id), '부상 선수도 선발에서 빠짐', `${ph.name}`);
}

/* ── 5. 보간용 이전 좌표 ── */
console.log('\n[5] 프레임 보간 데이터');
{
  const m = newMatch('gs', 'dj', 'lerp');
  for (let i = 0; i < 6; i++) m.tick();
  let moving = 0, total = 0;
  for (const s of ['home', 'away']) for (const e of m.sides[s].players) {
    if (!e.onPitch) continue;
    total += 1;
    if (Math.hypot(e.x - e.px, e.y - e.py) > 0.01) moving += 1;
  }
  ok(moving >= Math.min(10, total), '선수마다 이전 좌표(px,py)와 현재 좌표가 다름', `${moving}/${total}명 이동`);
  const b = m.ball;
  ok(Number.isFinite(b.px) && Number.isFinite(b.py), '공도 이전 좌표를 남김', `ball ${b.px.toFixed(2)},${b.py.toFixed(2)} → ${b.x.toFixed(2)},${b.y.toFixed(2)}`);
}

/* ── 6. 다경기 밸런스 ── */
console.log(`\n[6] 다경기 시뮬레이션 밸런스 (${N}경기)`);
{
  const acc = { goals: 0, xg: 0, shots: 0, onTarget: 0, corners: 0, fouls: 0, fk: 0, gk: 0, yellow: 0, red: 0, inj: 0, saves: 0 };
  const gd = [];
  for (let i = 0; i < N; i++) {
    const home = ids[i % ids.length];
    const away = ids[(i * 3 + 1) % ids.length];
    const m = new Match({
      world, homeId: home, awayId: away,
      homeLineup: lineupFor(world, home), awayLineup: lineupFor(world, away),
      seed: `bal-${i}`, cup: i % 6 === 0, userSide: 'home',
    });
    let g = 0;
    while (!m.done && g < 5000) { m.tick(); g++; }
    if (!m.done) m.finish();
    const s = m.stats(), sum = (k) => s[k].home + s[k].away;
    acc.goals += m.score.home + m.score.away;
    acc.xg += s.xg.home + s.xg.away;
    acc.shots += sum('shots'); acc.onTarget += sum('onTarget');
    acc.corners += sum('corners'); acc.fouls += sum('fouls');
    acc.fk += sum('freeKicks'); acc.gk += sum('goalKicks');
    acc.yellow += sum('yellow'); acc.red += sum('red'); acc.inj += sum('injuries');
    acc.saves += sum('saves');
    gd.push(m.score.home + m.score.away);
  }
  const avg = (k) => acc[k] / N;
  const show = (label, v, lo, hi) => ok(v >= lo && v <= hi, `${label} ${v.toFixed(2)} (현실 ${lo}~${hi})`);
  show('경기당 득점', avg('goals'), 2.2, 3.6);
  show('경기당 xG', avg('xg'), 2.0, 3.4);
  show('경기당 슈팅', avg('shots'), 16, 32);
  show('경기당 유효슈팅', avg('onTarget'), 6, 13);
  show('경기당 코너킥', avg('corners'), 6, 14);
  show('경기당 파울', avg('fouls'), 10, 28);
  show('경기당 프리킥', avg('fk'), 10, 28);
  show('경기당 골킥', avg('gk'), 6, 20);
  show('경기당 경고', avg('yellow'), 1.5, 6);
  show('경기당 퇴장', avg('red'), 0, 0.45);
  show('경기당 부상', avg('inj'), 0, 0.9);
  console.log(`  · 득점 분포: ${gd.join(', ')}`);
}

/* ── 7. 오픈 플레이 공간 분포 (중앙 과밀 해소) ── */
console.log('\n[7] 오픈 플레이 공간 분포');
{
  const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
  const acc = { frames: 0, nn: 0, nnN: 0, close: 0, pairN: 0, swarm: 0, cluster: 0 };
  for (let i = 0; i < 6; i++) {
    const m = newMatch('gs', 'dj', `space-${i}`);
    m.holdHalf = false;      // 전·후반 전체를 재야 공간 분포가 대표성을 가집니다
    let g = 0;
    while (!m.done && g < 4000) {
      m.tick(); g++;
      if (m.phase !== 'play' || !m.ball.owner) continue;
      for (const s of ['home', 'away']) {
        const ps = m.sides[s].players.filter((e) => e.onPitch);
        const out = ps.filter((e) => e.pos !== 'GK');
        for (const e of ps) {
          let nn = 1e9;
          for (const o of ps) if (o !== e) nn = Math.min(nn, dist(o, e));
          acc.nn += nn; acc.nnN += 1;
        }
        for (let a = 0; a < out.length; a++) for (let b = a + 1; b < out.length; b++) {
          acc.pairN += 1;
          if (dist(out[a], out[b]) < 4) acc.close += 1;
        }
        acc.swarm += ps.filter((e) => dist(e, m.ball) < 6).length;
        let worst = 0;
        for (const e of out) worst = Math.max(worst, out.filter((o) => o !== e && dist(o, e) < 5).length);
        acc.cluster += worst;
      }
      acc.frames += 1;
    }
  }
  const nn = acc.nn / Math.max(acc.nnN, 1);
  const closePct = (acc.close / Math.max(acc.pairN, 1)) * 100;
  const swarm = acc.swarm / Math.max(acc.frames, 1);
  const cluster = acc.cluster / Math.max(acc.frames, 1);
  ok(closePct < 2.5, '같은 팀 선수가 4u 안에 겹치는 비율 낮음', `${closePct.toFixed(1)}% (개선 전 5%대)`);
  ok(nn > 8, '최근접 동료와의 간격 충분', `평균 ${nn.toFixed(2)}u`);
  ok(swarm < 3.2, '공 주변에 몰리는 선수가 적당', `평균 ${swarm.toFixed(2)}명`);
  ok(cluster < 3.2, '한 선수 주변 5u 안에 동료가 몰리지 않음', `최대 ${cluster.toFixed(2)}명`);
}

/* ── 8. 전술별 전개 패턴·공간 분포 차이 ── */
console.log('\n[8] 전술별 패스 패턴·공간');
{
  const mix = (preset, n = 12) => {
    const a = { len: 0, sw: 0, th: 0, gg: 0, cb: 0, cr: 0, width: 0, depth: 0, wide: 0, pass: 0, goals: 0 };
    for (let i = 0; i < n; i++) {
      const m = newMatch('gs', 'dj', `mix-${JSON.stringify(preset)}-${i}`);
      if (preset) m.sides.home.tactic = { line: 0, pass: 0, press: 0, route: 0, ...preset };
      m.holdHalf = false;
      let g = 0;
      while (!m.done && g < 4000) { m.tick(); g++; }
      if (!m.done) m.finish();
      const s = m.stats();
      const nAtt = s.passAtt.home || 1;
      a.len += s.passLen.home / n;
      a.sw += (s.patterns.switch.home / nAtt) * 100 / n;
      a.th += (s.patterns.through.home / nAtt) * 100 / n;
      a.gg += (s.patterns.givego.home / nAtt) * 100 / n;
      a.cb += (s.patterns.cutback.home / nAtt) * 100 / n;
      a.cr += (s.patterns.cross.home / nAtt) * 100 / n;
      a.width += s.width.home / n;
      a.depth += s.depth.home / n;
      a.wide += s.wideShare.home / n;
      a.pass += nAtt / n;
      a.goals += (m.score.home + m.score.away) / n;
    }
    return a;
  };
  const bal = mix(null);
  const shortC = mix({ pass: -1, route: -1 });
  const longW = mix({ pass: 1, route: 1 });
  const highP = mix({ line: 1, press: 1 });
  const lowP = mix({ line: -1, press: -1 });
  const f = (v) => v.toFixed(1);
  ok(longW.len - shortC.len > 8, '롱볼 vs 짧은 패스 — 평균 패스 거리가 뚜렷이 다름', `${f(shortC.len)}u → ${f(longW.len)}u`);
  ok(longW.sw - shortC.sw > 8, '롱볼·측면은 사이드 전환이 훨씬 많음', `전환 ${f(shortC.sw)}% → ${f(longW.sw)}%`);
  ok(shortC.gg >= bal.gg * 0.6, '짧은 패스 축은 원투(원-투) 연계를 유지', `원투 ${f(shortC.gg)}% (기준 ${f(bal.gg)}%)`);
  ok(longW.cb + longW.cr > shortC.cb + shortC.cr, '측면 루트는 크로스·컷백이 더 많음', `크로스+컷백 ${f(shortC.cb + shortC.cr)}% → ${f(longW.cb + longW.cr)}%`);
  ok(longW.width - shortC.width > 1.0, '측면 루트는 선수 평균 폭이 넓음', `폭 ${f(shortC.width)}u → ${f(longW.width)}u`);
  ok(longW.wide - shortC.wide > 8, '측면 루트는 공이 측면에 머무는 시간이 길다', `측면 점유 ${f(shortC.wide)}% → ${f(longW.wide)}%`);
  ok(highP.depth - lowP.depth > 3, '높은 라인은 평균 깊이(진행도)가 높음', `깊이 ${f(lowP.depth)}u → ${f(highP.depth)}u`);
  ok(bal.th > 2, '기본 전개에도 스루패스가 나옴', `스루 ${f(bal.th)}%`);
  // 네 축을 바꿨을 때 득점이 한쪽으로 무너지지 않는지
  const gl = [bal, shortC, longW, highP, lowP].map((x) => x.goals);
  ok(Math.max(...gl) - Math.min(...gl) < 2.2, '전술별 득점 편차가 과하지 않음', gl.map(f).join(' / '));
}

/* ── 9. 골키퍼 포지셔닝 ── */
console.log('\n[9] 골키퍼 포지셔닝 (각도·스위퍼·복귀)');
{
  const m = newMatch('gs', 'dj', 'gkpose');
  m.holdHalf = false;
  let ang = 0, angN = 0, lat = 0, latN = 0, latSign = 0;
  let hi = 0, hiN = 0, lo = 0, loN = 0, outMax = 0;
  let g = 0;
  while (!m.done && g < 4000) {
    m.tick(); g++;
    if (m.phase !== 'play') continue;
    for (const s of ['home', 'away']) {
      const side = m.sides[s];
      const e = side.players.find((p) => p.onPitch && p.pos === 'GK');
      if (!e) continue;
      const own = side.dir > 0 ? 0 : W;
      const vx = m.ball.x - own, vy = m.ball.y - CY;
      const L = Math.hypot(vx, vy) || 1;
      // 골문 중앙 → 공 직선까지의 수직 거리 (각도선 위에 서 있는가)
      ang += Math.abs((e.x - own) * vy - (e.y - CY) * vx) / L; angN += 1;
      const out = Math.abs(e.x - own);
      if (out > outMax) outMax = out;
      if (Math.abs(vy) > 12) {
        lat += Math.abs(e.y - CY); latN += 1;
        if (Math.sign(e.y - CY) === Math.sign(vy)) latSign += 1;
      }
      const ballP = prog(m.ball.x, side.dir);
      const hasBall = !!m.ball.owner && m.ball.owner.side === s;
      if (hasBall && ballP > 60) { hi += out; hiN += 1; }
      if (!hasBall && ballP < 30) { lo += out; loN += 1; }
    }
  }
  const f1 = (v, n) => (v / Math.max(n, 1)).toFixed(1);
  ok(ang / Math.max(angN, 1) < 2.5, '골키퍼가 공-골문 각도선 위에 서서 각도를 좁힘', `각도선 이탈 평균 ${(ang / Math.max(angN, 1)).toFixed(2)}u`);
  ok(latSign / Math.max(latN, 1) > 0.85, '공이 측면에 있으면 같은 쪽으로 따라 이동', `같은 쪽 ${Math.round((latSign / Math.max(latN, 1)) * 100)}% · 평균 ${f1(lat, latN)}u`);
  ok(hi / Math.max(hiN, 1) > 5.5, '우리 공격 시 페널티 박스 앞까지 전진(스위퍼)', `${f1(hi, hiN)}u (n=${hiN})`);
  ok(lo / Math.max(loN, 1) < 4.5, '상대가 위험 지역에 들어오면 골문 앞으로 내려섬', `${f1(lo, loN)}u (n=${loN})`);
  ok(hi / Math.max(hiN, 1) - lo / Math.max(loN, 1) > 3, '전진 폭과 복귀 폭이 실제로 구분됨', `${f1(lo, loN)}u ↔ ${f1(hi, hiN)}u`);
  ok(outMax <= 15.6, '골키퍼가 골문에서 너무 멀리 나가지 않음', `최대 ${outMax.toFixed(1)}u`);
}
{
  // 우리 공격 → 전진한 키퍼, 상대 역습 → 몇 틱 만에 골문 앞으로 복귀
  const m = newMatch('gs', 'dj', 'gkret');
  m.holdHalf = false;
  m.sides.home.tactic = { line: 1, pass: 0, press: 0, route: 0 };
  const gk = m.sides.home.players.find((e) => e.onPitch && e.pos === 'GK');
  // 공을 잡은 공격수가 패스·슈팅을 고르지 않게(decCd 99) 붙잡아 '우리 팀 소유' 상태를 유지합니다.
  // (역할 도입 뒤 포처가 슛을 고르면 소유가 끊겨 키퍼 위치를 재는 국면이 흐트러집니다)
  for (let i = 0; i < 44; i++) {
    m.tick();
    if (i % 4 === 0 && m.phase === 'play') {
      const f = m.sides.home.players.find((e) => e.onPitch && e.pos === 'FW');
      if (f) { m.phase = 'play'; m.pause = 0; m.sp = null; m.ball.owner = f; m.ball.mode = 'carry'; f.x = 82; f.y = 32; m.ball.x = 82.9; m.ball.y = 32; f.decCd = 99; }
    }
  }
  // 측정 직전에는 '우리 팀 소유' 상태를 매 틱 고정해, 키퍼가 스위퍼 자리로 올라선 위치를 잽니다
  for (let i = 0; i < 10; i++) {
    const f = m.sides.home.players.find((e) => e.onPitch && e.pos === 'FW');
    if (f) { m.phase = 'play'; m.pause = 0; m.sp = null; m.ball.owner = f; m.ball.mode = 'carry'; f.x = 82; f.y = 32; m.ball.x = 82.9; m.ball.y = 32; f.decCd = 99; }
    m.tick();
  }
  const adv = gk.x;
  for (let i = 0; i < 6; i++) {
    const a = m.sides.away.players.find((e) => e.onPitch && e.pos === 'FW');
    if (a) { m.phase = 'play'; m.pause = 0; m.ball.owner = a; m.ball.mode = 'carry'; a.x = 26; a.y = 32; m.ball.x = 26; m.ball.y = 32; a.decCd = 9; }
    m.tick();
  }
  const back = gk.x;
  ok(adv > 7 && back < adv - 4, '상대 역습 시 골문 앞으로 빠르게 복귀', `전진 ${adv.toFixed(1)}u → 복귀 ${back.toFixed(1)}u`);
}
{
  // 다이빙 중에는 몸이 공으로 뻗은 상태 — 발로 미끄러지지 않아야 합니다
  const m = newMatch('gs', 'dj', 'gkdive');
  m.holdHalf = false;
  const gk = m.sides.home.players.find((e) => e.onPitch && e.pos === 'GK');
  m.phase = 'play'; m.pause = 0;
  // 슛이 날아가는 국면을 만들어 둔 뒤 다이빙을 겁니다 (판정 전 2틱)
  m.ball.owner = null; m.ball.mode = 'shot'; m.ball.from = { x: 60, y: 32 }; m.ball.to = { x: 0, y: 30 };
  m.ball.t = 0; m.ball.dur = 6; m.ball.x = 60; m.ball.y = 32; m.ball.px = 60; m.ball.py = 32;
  gk.dive = { at: m.t, dur: 6, to: 5, save: false, landAt: null };
  gk.y = 40;
  const x0 = gk.x, y0 = gk.y;
  m.tick(); m.tick();
  ok(Math.abs(gk.x - x0) < 0.05 && Math.abs(gk.y - y0) < 0.05, '다이빙 중에는 골키퍼가 미끄러지지 않음', `Δ ${Math.hypot(gk.x - x0, gk.y - y0).toFixed(2)}u`);
  ok(gk.dive && gk.dive.landAt == null, '다이빙 자세가 판정 전에 풀리지 않음');
}

/* ── 10. 오프사이드 ── */
console.log('\n[10] 오프사이드 판정 · 라인 타기');
{
  // 상대 수비 라인을 한 줄로 세우고, 리시버를 라인 앞/뒤에 두고 패스를 냅니다
  const setup = (beyond) => {
    const m = newMatch('gs', 'dj', `off-${beyond}`);
    m.holdHalf = false;
    for (let i = 0; i < 6; i++) m.tick();
    m.phase = 'play'; m.pause = 0; m.sp = null;
    const side = m.sides.home, opp = m.sides.away;
    const passer = side.players.find((e) => e.onPitch && e.pos === 'MF');
    const recv = side.players.find((e) => e.onPitch && e.pos === 'FW');
    const ys = [4, 10, 16, 22, 44, 50, 56, 62];
    let k = 0;
    for (const e of opp.players) {
      if (!e.onPitch || e.pos === 'GK') continue;
      e.x = 70 + (k % 2) * 1; e.y = ys[k % ys.length]; e.px = e.x; e.py = e.y; e.warp = null; k += 1;
    }
    passer.x = 60; passer.y = 32; passer.px = 60; passer.py = 32; passer.warp = null;
    recv.warp = null;
    const line = m.offsideLineDepth('home');
    recv.x = line + (beyond ? 3 : -1); recv.y = 32;
    recv.px = recv.x; recv.py = recv.y;
    m.ball.owner = passer; m.ball.mode = 'carry'; m.ball.x = 60.9; m.ball.y = 32; passer.decCd = 0;
    return { m, passer, recv, line };
  };
  const off = setup(true);
  off.m.passTo(off.passer, off.recv, 'pass');
  ok(!!off.m.ball.offside, '패스 출발 순간 라인 뒤 리시버 → 오프사이드 플래그', `라인 ${off.line.toFixed(1)} · 리시버 ${off.recv.x.toFixed(1)}`);
  off.m.ball.t = off.m.ball.dur;
  off.m.resolvePass();
  const st = off.m.stats();
  ok(st.offsides.home === 1, '오프사이드 기록(통계) 반영', `오프사이드 ${st.offsides.home}`);
  ok(off.m.phase === 'setpiece' && off.m.sp && off.m.sp.type === 'freekick' && off.m.sp.side === 'away', '상대 프리킥으로 재개', `${off.m.phase}${off.m.sp ? ' · ' + off.m.sp.type + ' · ' + off.m.sp.side : ''}`);
  ok(off.m.events.some((e) => e.type === 'offside' && /오프사이드/.test(e.text)), '중계 멘트에 오프사이드', off.m.events.filter((e) => e.type === 'offside').map((e) => e.text).slice(-1)[0] || '');
  ok(!!off.m.offsideFlash && off.m.offsideFlash.lineX != null, '피치 표시(🚩 오프사이드·라인) 데이터', `lineX ${off.m.offsideFlash ? off.m.offsideFlash.lineX.toFixed(1) : '-'}`);
  const on = setup(false);
  on.m.passTo(on.passer, on.recv, 'pass');
  ok(!on.m.ball.offside, '라인 안(온사이드) 리시버 → 판정 없음', `라인 ${on.line.toFixed(1)} · 리시버 ${on.recv.x.toFixed(1)}`);
  // 코너킥·골킥은 오프사이드가 없습니다
  const ck = setup(true);
  ck.m.passTo(ck.passer, ck.recv, 'cross');
  ok(!ck.m.ball.offside, '크로스(코너킥)는 오프사이드로 잡지 않음');
  const gk2 = setup(true);
  gk2.m.passTo(gk2.passer, gk2.recv, false, { safe: true });
  ok(!gk2.m.ball.offside, '골킥 패스는 오프사이드 예외');
  // 공격수는 패스 전에 라인을 타고, 러닝 목표도 라인을 넘지 않습니다
  const run = setup(false);
  const runner = run.m.sides.home.players.find((e) => e.onPitch && e.pos === 'FW' && e !== run.recv);
  runner.runT = 12; runner.runOff = false;
  run.m.sides.home._shape = run.m.computeShape(run.m.sides.home, true);
  const tgt = run.m.targetFor(runner, run.m.sides.home, true);
  const lim = run.m.onsideLimit(runner);
  ok(tgt.x <= lim + 0.01, '침투 러닝 목표가 오프사이드 라인을 넘지 않음(라인 타기)', `목표 ${tgt.x.toFixed(1)} ≤ 한계 ${lim.toFixed(1)}`);
}
{
  // 경기당 빈도와 오프사이드 득점
  let offSum = 0, offGoals = 0, maxOff = 0;
  const n = Math.min(N, 24);
  for (let i = 0; i < n; i++) {
    const home = ids[i % ids.length], away = ids[(i * 3 + 1) % ids.length];
    const m = new Match({
      world, homeId: home, awayId: away,
      homeLineup: lineupFor(world, home), awayLineup: lineupFor(world, away),
      seed: `off-bal-${i}`, cup: false, userSide: 'home',
    });
    m.holdHalf = false;
    let g = 0;
    while (!m.done && g < 5000) { m.tick(); g++; }
    if (!m.done) m.finish();
    const s = m.stats();
    const o = s.offsides.home + s.offsides.away;
    offSum += o; maxOff = Math.max(maxOff, o);
    offGoals += m.offsideGoals || 0;
  }
  const avgOff = offSum / n;
  ok(avgOff >= 1 && avgOff <= 6, `경기당 오프사이드 ${avgOff.toFixed(1)}회 (현실 1~6)`, `${n}경기 · 최대 ${maxOff}회`);
  ok(maxOff <= 8, '오프사이드가 한 경기에 몰려 나오지 않음', `최대 ${maxOff}회`);
  ok(offGoals === 0, '오프사이드 위치에서 나온 득점 0건', `${offGoals}건`);
}

/* ── 11. 팀 성향(멘탈리티) 5단계 ── */
console.log('\n[11] 팀 성향(멘탈리티) — 잠그기 ↔ 총공세');
{
  // 앞선 점검들이 선수 정지·부상으로 라인업을 바꿔 두었으므로, 이 구간은 깨끗한 세계로 잽니다
  const W2 = createWorld('gs', 20261122);
  const lockA = shapeProbe({ mentality: -1 }, true, W2), atkA = shapeProbe({ mentality: 1 }, true, W2);
  ok(atkA.df - lockA.df > 8, '보유 시 수비 라인 — 총공세가 눈에 띄게 전진', `DF 목표 x ${lockA.df.toFixed(1)} → ${atkA.df.toFixed(1)} (Δ${(atkA.df - lockA.df).toFixed(1)})`);
  ok(atkA.mf - lockA.mf > 15, '보유 시 미드필더 — 전원이 함께 올라감', `MF 목표 x ${lockA.mf.toFixed(1)} → ${atkA.mf.toFixed(1)} (Δ${(atkA.mf - lockA.mf).toFixed(1)})`);
  ok(atkA.fw - lockA.fw > 10, '보유 시 최전방 — 총공세는 문전까지 붙습니다', `FW x ${lockA.fw.toFixed(1)} → ${atkA.fw.toFixed(1)}`);
  const lockD = shapeProbe({ mentality: -1 }, false, W2), atkD = shapeProbe({ mentality: 1 }, false, W2);
  ok(atkD.df - lockD.df > 8, '수비 시 블록 높이 차이', `수비 DF ${lockD.df.toFixed(1)} → ${atkD.df.toFixed(1)}`);
  ok(lockD.fw < atkD.fw - 12, '잠그기는 공격수까지 내려와 10명이 공 뒤에 섭니다', `수비 FW ${lockD.fw.toFixed(1)} → ${atkD.fw.toFixed(1)}`);
  const ladder = MENTALITY.map((mt) => shapeProbe({ mentality: mt.v }, true, W2).mf);
  ok(ladder.every((v, i) => i === 0 || v > ladder[i - 1] + 2), '5단계가 한 칸씩 라인을 올립니다', ladder.map((v) => v.toFixed(1)).join(' → '));
  const cb0 = slotProbe({ w: W2, slotLabel: 'CB', role: 'cover', ball: { x: 80, y: CY } });
  const cb1 = slotProbe({ w: W2, slotLabel: 'CB', role: 'cover', tactic: { mentality: 1 }, ball: { x: 80, y: CY } });
  const cbL = slotProbe({ w: W2, slotLabel: 'CB', role: 'cover', tactic: { mentality: -1 }, ball: { x: 80, y: CY } });
  ok(cb1.x - cb0.x > 30, '총공세 — 센터백까지 문전으로 올라갑니다', `CB 목표 x 균형 ${cb0.x.toFixed(1)} → 총공세 ${cb1.x.toFixed(1)}`);
  ok(cbL.x < cb0.x - 3, '잠그기 — 센터백은 골문 앞에 남습니다', `CB x 잠그기 ${cbL.x.toFixed(1)}`);

  const L = statsProbe({ w: W2, home: { tactic: { mentality: -1 } }, n: 20, prefix: 'mentL' });
  const A = statsProbe({ w: W2, home: { tactic: { mentality: 1 } }, n: 20, prefix: 'mentA' });
  const per = (r, k) => (r[k] / r.n);
  ok(A.line - L.line > 3, '경기 중에도 수비 라인이 총공세에서 높습니다', `상대 볼 때 라인 ${L.line.toFixed(1)} → ${A.line.toFixed(1)}`);
  ok(L.behind - A.behind > 1.5, '잠그기는 공 뒤에 남는 선수가 많습니다', `공 뒤 인원 ${L.behind.toFixed(2)}명 → ${A.behind.toFixed(2)}명`);
  ok(A.join - L.join > 0.15, '총공세는 공격 가담 인원이 많습니다', `상대 진영 인원 ${L.join.toFixed(2)}명 → ${A.join.toFixed(2)}명`);
  ok(per(A, 'shots') > per(L, 'shots') * 1.15, '총공세는 슈팅이 확실히 많습니다',
    `경기당 슛 ${per(L, 'shots').toFixed(1)} → ${per(A, 'shots').toFixed(1)} · xG ${per(L, 'xg').toFixed(2)} → ${per(A, 'xg').toFixed(2)}`);
  ok(per(A, 'ga') > per(L, 'ga'), '대신 총공세는 뒷공간을 내줘 실점이 늘어납니다',
    `실점 ${per(L, 'ga').toFixed(1)} → ${per(A, 'ga').toFixed(1)} · 득점 ${per(L, 'gf').toFixed(1)} → ${per(A, 'gf').toFixed(1)} · 공 뒤 인원 ${L.behind.toFixed(1)} ↔ ${A.behind.toFixed(1)}`);
}

/* ── 12. 포지션별 역할(Role) ── */
console.log('\n[12] 포지션별 역할(Role) — 자리·패스 선택·압박');
{
  const W3 = createWorld('gs', 20261122);
  const weak = (role) => slotProbe({ w: W3, slotLabel: 'LW', role, ball: { x: 58, y: 44 } });
  const winger = weak('winger'), inside = weak('inside');
  ok(Math.abs(winger.y - CY) - Math.abs(inside.y - CY) > 8, '윙어는 터치라인, 인사이드 포워드는 안쪽으로 접습니다',
    `|y-CY| 윙어 ${Math.abs(winger.y - CY).toFixed(1)} ↔ 인사이드 ${Math.abs(inside.y - CY).toFixed(1)}`);
  const lane = (role) => slotProbe({ w: W3, slotLabel: 'LW', role, ball: { x: 70, y: 28 } });
  const wl = lane('winger'), il = lane('inside');
  ok(Math.abs(wl.y - CY) > Math.abs(il.y - CY) + 2, '공이 측면에 있어도 인사이드 포워드는 하프스페이스에 섭니다',
    `|y-CY| 윙어 ${Math.abs(wl.y - CY).toFixed(1)} ↔ 인사이드 ${Math.abs(il.y - CY).toFixed(1)}`);
  const fb = slotProbe({ w: W3, slotLabel: 'LB', role: 'fullback', ball: { x: 62, y: 14 } });
  const wb = slotProbe({ w: W3, slotLabel: 'LB', role: 'wingback', ball: { x: 62, y: 14 } });
  ok(wb.x - fb.x > 12, '윙백은 오버래핑해 전진, 풀백은 뒤에 남습니다', `LB 목표 x 풀백 ${fb.x.toFixed(1)} → 윙백 ${wb.x.toFixed(1)}`);
  const cov = slotProbe({ w: W3, slotLabel: 'CB', role: 'cover', ball: { x: 40, y: 20 }, hasBall: false });
  const sto = slotProbe({ w: W3, slotLabel: 'CB', role: 'stopper', ball: { x: 40, y: 20 }, hasBall: false });
  ok(sto.x - cov.x > 5, '스토퍼는 올라서서 먼저 끊고, 커버는 한 발 물러서 덮습니다', `CB x 커버 ${cov.x.toFixed(1)} → 스토퍼 ${sto.x.toFixed(1)}`);
  ok(ROLE_TUNING.stopper.press - ROLE_TUNING.cover.press >= 4, '압박 반경도 역할이 정합니다',
    `커버 ${ROLE_TUNING.cover.press}u ↔ 스토퍼 +${ROLE_TUNING.stopper.press}u`);
  const hold = slotProbe({ w: W3, slotLabel: 'CM', role: 'holding', ball: { x: 55, y: 32 } });
  const play = slotProbe({ w: W3, slotLabel: 'CM', role: 'playmaker', ball: { x: 55, y: 32 } });
  ok(play.x - hold.x > 4, '플레이메이커는 라인 사이로 올라가고, 홀딩은 수비 라인 앞을 지킵니다', `CM x 홀딩 ${hold.x.toFixed(1)} → 플메 ${play.x.toFixed(1)}`);

  // 패스 선택 — 같은 장면에서 역할만 바꿉니다
  const crossScene = (role) => passProbe({ w: W3, slotLabel: 'LW', role, carrier: { x: 70, y: 10 }, mates: [{ label: 'ST', x: 80, y: 32 }, { label: 'CM', x: 58, y: 34 }, { label: 'RB', x: 52, y: 52 }] });
  const cw = crossScene('winger'), ci = crossScene('inside');
  ok(cw.kind === 'cross' && ci.kind !== 'cross', '윙어는 크로스를 올리고 인사이드 포워드는 반대편으로 돌립니다',
    `윙어 → ${cw.kind}(${cw.score.toFixed(2)}) · 인사이드 → ${ci.kind}(${ci.score.toFixed(2)})`);
  const throughScene = (role) => passProbe({ w: W3, slotLabel: 'CM', role, carrier: { x: 52, y: 30 }, mates: [{ label: 'ST', x: 70, y: 30, run: 12 }, { label: 'LW', x: 64, y: 12 }] });
  const tp = passRateProbe({ w: W3, slotLabel: 'CM', role: 'playmaker', carrier: { x: 52, y: 30 }, mates: [{ label: 'ST', x: 70, y: 30, run: 12 }, { label: 'LW', x: 64, y: 12 }] });
  const th = passRateProbe({ w: W3, slotLabel: 'CM', role: 'holding', carrier: { x: 52, y: 30 }, mates: [{ label: 'ST', x: 70, y: 30, run: 12 }, { label: 'LW', x: 64, y: 12 }] });
  ok(tp.avg - th.avg > 0.2, '플레이메이커는 킬패스(스루)를 더 높게 봅니다', `스루 점수 평균 홀딩 ${th.avg.toFixed(2)} → 플메 ${tp.avg.toFixed(2)} (24회)`);

  // 경기 중 지표
  const FB = statsProbe({ w: W3, home: { roles: { LB: 'fullback', RB: 'fullback' } }, n: 8, prefix: 'rf', track: ['LB'] });
  const WB = statsProbe({ w: W3, home: { roles: { LB: 'wingback', RB: 'wingback' } }, n: 8, prefix: 'rW', track: ['LB'] });
  const fbHigh = FB.slots.LB.high / Math.max(FB.slots.LB.n, 1), wbHigh = WB.slots.LB.high / Math.max(WB.slots.LB.n, 1);
  ok(wbHigh - fbHigh > 0.1, '경기 중 윙백은 풀백보다 훨씬 높이 올라갑니다',
    `하프라인 위 시간 ${Math.round(fbHigh * 100)}% → ${Math.round(wbHigh * 100)}% · LB 평균 x ${FB.slots.LB.x.toFixed(1)} → ${WB.slots.LB.x.toFixed(1)}`);
  const WG = statsProbe({ w: W3, home: { roles: { LW: 'winger', RW: 'winger' } }, n: 8, prefix: 'rw', track: ['LW'] });
  const IF = statsProbe({ w: W3, home: { roles: { LW: 'inside', RW: 'inside' } }, n: 8, prefix: 'ri', track: ['LW'] });
  const shootW = shootProbe({ w: W3, slotLabel: 'LW', role: 'winger' }), shootI = shootProbe({ w: W3, slotLabel: 'LW', role: 'inside' });
  ok(shootI > shootW * 1.15, '같은 자리에서도 인사이드 포워드가 슈팅을 더 고릅니다',
    `박스 앞 슛 선택 ${Math.round(shootW * 100)}% → ${Math.round(shootI * 100)}% (300회)`);
  const shootP = shootProbe({ w: W3, slotLabel: 'ST', role: 'poacher' }), shootT = shootProbe({ w: W3, slotLabel: 'ST', role: 'target' });
  ok(shootP > shootT * 1.15, '포처가 타깃맨보다 먼저 슈팅을 고릅니다', `ST 슛 선택 ${Math.round(shootT * 100)}% → ${Math.round(shootP * 100)}%`);
  ok(WG.slots.LW.crosses > IF.slots.LW.crosses, '경기 중에도 윙어는 크로스를 올리고 인사이드 포워드는 올리지 않습니다',
    `LW 크로스 ${WG.slots.LW.crosses} → ${IF.slots.LW.crosses} · 측면 폭 |y-CY| ${WG.slots.LW.y.toFixed(1)} → ${IF.slots.LW.y.toFixed(1)}`);
  const PO = statsProbe({ w: W3, home: { roles: { ST: 'poacher' } }, n: 8, prefix: 'rp', track: ['ST'] });
  const TG = statsProbe({ w: W3, home: { roles: { ST: 'target' } }, n: 8, prefix: 'rt', track: ['ST'] });
  ok(PO.slots.ST.runs > 60 && TG.slots.ST.runs === 0, '포처는 뒷공간 침투 러닝을 하고 타깃맨은 버팁니다',
    `침투 틱 ${PO.slots.ST.runs} ↔ ${TG.slots.ST.runs}`);
}

/* ── 13. 기존 세이브 호환 ── */
console.log('\n[13] 역할·팀 성향이 없는 기존 세이브 호환');
{
  const slots = FORMATIONS[world.myLineup.formation].slots;
  const fallback = resolveRoles(undefined, slots);
  ok(fallback.length === 11 && fallback.every((k, i) => k === defaultRole(slots[i].label)), '역할 배열이 없으면 포지션 기본값이 적용됩니다',
    fallback.map((k, i) => `${slots[i].label}:${k}`).slice(0, 5).join(' '));
  ok(fallback.includes('fullback') && fallback.includes('cover') && fallback.includes('winger') && fallback.includes('poacher'), '기본값: 풀백·커버·윙어·포처');
  // 역할이 없는 라인업으로 경기를 만들어도 기본 역할이 붙습니다
  const legacy = { ...lineupFor(world, 'gs') };
  delete legacy.roles;
  const m = new Match({ world, homeId: 'gs', awayId: 'dj', homeLineup: legacy, awayLineup: lineupFor(world, 'dj'), seed: 'legacy', cup: false, userSide: 'home' });
  const allHaveRole = m.sides.home.players.every((e) => !!e.role);
  ok(allHaveRole, '역할 없는 세이브의 라인업도 기본 역할로 경기를 뛸 수 있습니다', m.sides.home.players.map((e) => `${e.label}:${e.role}`).slice(0, 4).join(' '));
  ok(m.sides.home.tactic.mentality === 0, '팀 성향이 없는 세이브는 균형(0)으로 시작합니다');

  // 저장 → 역할/성향 제거 → 다시 읽기 (구버전 세이브 흉내)
  const w = createWorld('bm', 77);
  const bak = globalThis.localStorage;
  globalThis.localStorage = {
    s: {},
    getItem(k) { return Object.prototype.hasOwnProperty.call(this.s, k) ? this.s[k] : null; },
    setItem(k, v) { this.s[k] = String(v); },
    removeItem(k) { delete this.s[k]; },
    key(i) { return Object.keys(this.s)[i] ?? null; },
    get length() { return Object.keys(this.s).length; },
  };
  const legacyWorld = JSON.parse(JSON.stringify(w));
  delete legacyWorld.myLineup.roles;
  delete legacyWorld.myLineup.tactic.mentality;
  for (const t of Object.values(legacyWorld.teams)) delete t.tactic.mentality;
  saveWorld(legacyWorld);
  const back = loadWorld();
  ok(!!back && Array.isArray(back.myLineup.roles) && back.myLineup.roles.length === 11, '구버전 세이브를 열면 역할이 자동으로 채워집니다',
    back ? back.myLineup.roles.slice(0, 5).join(',') : '불러오기 실패');
  ok(!!back && back.myLineup.tactic.mentality === 0 && back.teams.gs.tactic.mentality === 0, '구버전 세이브의 팀 성향은 균형(0)으로 보정됩니다');
  globalThis.localStorage = bak;

  // 역할 변경은 '자리'에 붙고, 포메이션을 바꿔도 같은 라벨 자리로 따라갑니다
  setRole(w, 1, 'wingback');
  ok(w.myLineup.roles[1] === 'wingback', 'setRole — LB 자리 역할 변경', w.myLineup.roles[1]);
  ok(setRole(w, 1, 'poacher') === 'fullback', '자리에 맞지 않는 역할은 기본값으로 되돌립니다', w.myLineup.roles[1]);
  const lbIdx = FORMATIONS[w.myLineup.formation].slots.findIndex((s) => s.label === 'LB');
  setRole(w, lbIdx, 'wingback');
  setFormation(w, '4-4-2');
  const newLb = FORMATIONS['4-4-2'].slots.findIndex((s) => s.label === 'LB');
  ok(w.myLineup.roles.length === 11 && w.myLineup.roles[newLb] === 'wingback', '포메이션을 바꿔도 LB 역할(윙백)이 LB 자리로 따라갑니다', w.myLineup.roles.join(','));
  const auto = autoLineup(w, w.myTeamId, '4-4-2');
  ok(auto.roles && auto.roles.length === 11, '자동 선발을 다시 돌려도 역할이 유지됩니다', auto.roles.slice(0, 4).join(','));
}


/* ── 14. 전술 축 밸런스 · 배치/데이터 버그 회귀 ── */
console.log('\n[14] 전술 축 밸런스 (조합별 24경기) · 자동 배치·데이터');
function balanceProbe(tactic, n = 24, roles = []) {
  const w = createWorld('gs', 20261122);
  const acc = { gf: 0, ga: 0, xg: 0, oxg: 0, shots: 0, oshots: 0, poss: 0, cross: 0, header: 0, stam: 0, passOk: 0, passN: 0, oppPassOk: 0, oppPassN: 0 };
  for (let i = 0; i < n; i++) {
    const l = autoLineup(w, w.myTeamId, w.myLineup.formation);
    l.tactic = { line: 0, pass: 0, press: 0, route: 0, mentality: 0, ...tactic };
    w.myLineup = l;
    for (const [label, role, nth] of roles) {
      const slots = FORMATIONS[l.formation].slots;
      const idxs = slots.map((s, k) => [s, k]).filter(([s]) => s.label === label).map(([, k]) => k);
      if (idxs.length) setRole(w, idxs[nth || 0], role);
    }
    // 밸런스 계측에서는 상대 AI의 맞대응(전술 변경)을 끄고, 내가 바꾼 축 하나의 효과만 잽니다.
    const m = new Match({ world: w, homeId: 'gs', awayId: 'dj', homeLineup: lineupFor(w, 'gs'), awayLineup: lineupFor(w, 'dj'), seed: `balx-${i}`, cup: false, userSide: 'home', opponentCoach: false });
    m.holdHalf = false;
    let g = 0;
    while (!m.done && g < 6000) { m.tick(); g++; }
    if (!m.done) m.finish();
    const st = m.stats();
    acc.gf += m.score.home; acc.ga += m.score.away;
    acc.xg += st.xg.home; acc.oxg += st.xg.away;
    acc.shots += st.shots.home; acc.oshots += st.shots.away;
    acc.poss += st.possession.home;
    acc.cross += m.sides.home.stats.crossN; acc.header += m.sides.home.stats.headerShots || 0;
    acc.trans = (acc.trans || 0) + (m.sides.home.stats.transShots || 0);
    const st2 = m.sides.home.players.filter((e) => e.onPitch).map((e) => e.stamina);
    acc.stam += st2.reduce((a, b) => a + b, 0) / Math.max(st2.length, 1);
    acc.passOk += m.sides.home.stats.passOk; acc.passN += m.sides.home.stats.passes;
    acc.oppPassOk += m.sides.away.stats.passOk; acc.oppPassN += m.sides.away.stats.passes;
  }
  const per = (k) => acc[k] / n;
  return {
    xg: per('xg'), oxg: per('oxg'), shots: per('shots'), oshots: per('oshots'),
    trans: (acc.trans || 0) / n,
    gf: per('gf'), ga: per('ga'), poss: per('poss'), cross: per('cross'), header: per('header'), stam: per('stam'),
    passPct: acc.passOk / Math.max(acc.passN, 1), oppPassPct: acc.oppPassOk / Math.max(acc.oppPassN, 1),
  };
}
{
  const bal = balanceProbe({});
  const lock = balanceProbe({ mentality: -1 });
  const all = balanceProbe({ mentality: 1 });
  ok(lock.xg < bal.xg - 0.1 && lock.oxg < bal.oxg - 0.05, '잠그기 — 득점 기회는 줄고 실점 기회는 확실히 줄어듭니다',
    `xG ${bal.xg.toFixed(2)} → ${lock.xg.toFixed(2)} · 피xG ${bal.oxg.toFixed(2)} → ${lock.oxg.toFixed(2)}`);
  ok(all.xg > bal.xg + 0.1 && all.oxg > bal.oxg + 0.1, '총공세 — 공격은 늘고 뒷공간 실점 위험도 함께 늘어납니다',
    `xG ${bal.xg.toFixed(2)} → ${all.xg.toFixed(2)} · 피xG ${bal.oxg.toFixed(2)} → ${all.oxg.toFixed(2)} · 피슈팅 ${bal.oshots.toFixed(1)} → ${all.oshots.toFixed(1)}`);
  const gegen = balanceProbe({ press: 1 });
  const wait = balanceProbe({ press: -1 });
  ok(gegen.shots > bal.shots + 0.3, '게겐프레싱은 슈팅이 더 많습니다 (전방에서 계속 때립니다)',
    `슈팅 보통 ${bal.shots.toFixed(1)} → 게겐 ${gegen.shots.toFixed(1)} · xG ${bal.xg.toFixed(2)} → ${gegen.xg.toFixed(2)}`);
  ok(gegen.trans > wait.trans + 0.3, '게겐프레싱은 뺏은 직후 곧바로 슈팅(전환)으로 이어집니다',
    `전환 슈팅 ${wait.trans.toFixed(1)} → ${gegen.trans.toFixed(1)} (경기당)`);
  ok(gegen.stam < wait.stam - 8, '대신 게겐프레싱은 체력을 훨씬 많이 씁니다', `종료 체력 ${wait.stam.toFixed(0)}% → ${gegen.stam.toFixed(0)}%`);
  const long = balanceProbe({ pass: 1 });
  const short = balanceProbe({ pass: -1 });
  ok(short.poss - long.poss > 4, '롱볼은 짧은 패스보다 점유율이 실제로 낮습니다',
    `점유 ${long.poss.toFixed(1)}% ↔ ${short.poss.toFixed(1)}% (Δ${(short.poss - long.poss).toFixed(1)}%p) · 패스 성공 ${(long.passPct * 100).toFixed(1)}% ↔ ${(short.passPct * 100).toFixed(1)}%`);
  const wide = balanceProbe({ route: 1 });
  const mid = balanceProbe({ route: -1 });
  ok(wide.cross > mid.cross * 1.3 && wide.header > mid.header * 1.4 && wide.header > mid.header + 0.3, '측면 루트는 크로스·헤더 기회가 실제로 늘어납니다',
    `크로스 ${mid.cross.toFixed(1)} → ${wide.cross.toFixed(1)} · 헤더슛 ${mid.header.toFixed(1)} → ${wide.header.toFixed(1)}`);

  // 전술 보드 미리보기 — 역할·성향이 바뀌면 칩 좌표가 움직입니다
  const slots = FORMATIONS['4-3-3'].slots;
  const lb = slots.findIndex((s) => s.label === 'LB');
  const fbPos = boardPos(slots[lb], 'fullback', {});
  const wbPos = boardPos(slots[lb], 'wingback', {});
  const lockPos = boardPos(slots[lb], 'fullback', { mentality: -1 });
  const allPos = boardPos(slots[lb], 'fullback', { mentality: 1 });
  ok(wbPos.x - fbPos.x > 0.03, '전술 보드 — 윙백으로 바꾸면 칩이 앞으로 올라갑니다', `x ${fbPos.x.toFixed(3)} → ${wbPos.x.toFixed(3)}`);
  ok(allPos.x - lockPos.x > 0.06, '전술 보드 — 잠그기↔총공세가 칩 위치에 반영됩니다', `x ${lockPos.x.toFixed(3)} → ${allPos.x.toFixed(3)}`);
  const lwIdx = slots.findIndex((s) => s.label === 'LW');
  const wingerY = boardPos(slots[lwIdx], 'winger', {});
  const insideY = boardPos(slots[lwIdx], 'inside', {});
  ok(Math.abs(wingerY.y - 0.5) - Math.abs(insideY.y - 0.5) > 0.05, '전술 보드 — 인사이드 포워드는 안쪽으로 접힙니다',
    `|y-중앙| ${Math.abs(wingerY.y - 0.5).toFixed(3)} → ${Math.abs(insideY.y - 0.5).toFixed(3)}`);

  // 포메이션 변경 — 수비수가 최전방에 들어가지 않습니다
  const w4 = createWorld('gs', 77);
  setFormation(w4, '3-5-2');
  const i352 = lineupInfo(w4);
  const fwBad = i352.slots.filter((s) => s.slot.pos === 'FW' && s.p && s.p.pos === 'DF').length;
  const dfBad = i352.slots.filter((s) => s.slot.pos === 'DF' && s.p && s.p.pos === 'FW').length;
  ok(fwBad === 0 && dfBad === 0 && i352.slots.filter((s) => s.p && s.factor < 0.99).length <= 2, '포메이션 변경 자동 배치 — 수비수가 ST로 밀려가지 않습니다',
    `3-5-2 불일치 ${i352.slots.filter((s) => s.p && s.factor < 0.99).length} · ` + i352.slots.map((s) => `${s.slot.label}:${s.p ? s.p.pos : '-'}`).join(' '));

  // 부상 선수는 선발에서 빠집니다
  const w5 = createWorld('gs', 99);
  const hurtPid = w5.myLineup.starters.find((id) => w5.players[id]?.pos !== 'GK');
  w5.players[hurtPid].inj = 3;
  fillLineup(w5);
  ok(!w5.myLineup.starters.includes(hurtPid), '부상 선수는 선발에서 자동으로 빠집니다', `${w5.players[hurtPid].name} 부상 3경기`);
  const lf = lineupFor(w5, 'gs');
  ok(!lf.starters.includes(hurtPid), '부상 선수는 경기 라인업에도 들어가지 않습니다');

  // 다음 경기 카드는 감독이 저장한 라인업·전술을 읽습니다
  const w6 = createWorld('gs', 55);
  setFormation(w6, '4-4-2');
  w6.myLineup.tactic = { ...w6.myLineup.tactic, mentality: -1, pass: 1 };
  const setup = mySetup(w6);
  ok(setup.formation === '4-4-2' && setup.tactic.mentality === -1 && setup.tactic.pass === 1, '다음 경기 카드의 예상 포메이션·주 전술은 내 라인업 값입니다',
    `${setup.formation} · mentality ${setup.tactic.mentality} · pass ${setup.tactic.pass}`);
}

/* ── 15. 경기 전 상대 스카우팅 ── */
console.log('\n[15] 상대 스카우팅 — 실제 라인업·전술과 일치');
{
  const rep = scoutReport(world, 'dj');
  const lf = lineupFor(world, 'dj');
  const team = world.teams.dj;
  const realTac = { line: 0, pass: 0, press: 0, route: 0, mentality: 0, ...(lf.tactic || team.tactic) };
  ok(rep && rep.formation === lf.formation, '예상 포메이션 = 경기에 실제로 나가는 포메이션', `${rep?.formation} · ${rep?.shape}`);
  ok(rep.axes.length === 4 && ['line', 'pass', 'press', 'route'].every((k) => rep.tactic[k] === realTac[k]), '주 전술 4축이 상대 팀 전술과 일치', rep.axes.map((a) => `${a.name} ${a.word}`).join(' · '));
  ok(rep.words === tacticWords(realTac) && rep.mentality.name === mentalityOf(realTac.mentality).name, '성향·전술 문구도 실제 값', rep.words);
  ok(rep.keyPlayers.length === 2 && rep.keyPlayers.every((k) => lf.starters.includes(k.id)), '핵심 경계 선수는 실제 선발 명단에서 뽑습니다', rep.keyPlayers.map((k) => `${k.name}(${k.slot})`).join(', '));
  const outfield = lf.starters.map((id) => world.players[id]).filter((p) => p && p.pos !== 'GK');
  const best = outfield.slice().sort((a, b) => threatOf(b) - threatOf(a))[0];
  ok(rep.keyPlayers[0].id === best.id, '경계 1순위 = 공격 위협 1위 선발', `${rep.keyPlayers[0].name} · ${rep.keyPlayers[0].slot} · 위협 ${rep.keyPlayers[0].threat}`);
  ok(rep.keyPlayers.every((k) => k.stats.every((s) => s.value === world.players[k.id].stats[s.key])), '경계 선수 능력치는 실제 스탯 그대로', rep.keyPlayers[0].stats.map((s) => `${s.label} ${s.value}`).join(' · '));
  ok(rep.xi.length === 11 && rep.xi.every((x) => lf.starters.some((id) => world.players[id]?.name === x.name)), '상세 보고서의 예상 11명이 실제 선발과 같습니다', rep.xi.slice(0, 4).map((x) => `${x.slot}:${x.name}`).join(' '));
  ok(rep.hints.length >= 3 && rep.hints.every((h) => h.tag && h.text.length > 10), '맞춤 공략 힌트가 나옵니다', rep.hints.map((h) => h.tag).join('·'));
  // 축에 맞는 공략이 나오는지 — 압박형(군산 0.9)과 내려서는 팀(논산 -0.8)
  const press = scoutReport(world, 'ks');
  ok(press.tactic.press >= 0.5 && press.hints.some((h) => h.tag === '압박' && /압박/.test(h.text)), '압박형 상대에게는 압박 공략이 나옵니다', press.hints.find((h) => h.tag === '압박')?.text.slice(0, 34) + '…');
  const low = scoutReport(world, 'ns');
  ok(low.tactic.line <= -0.5 && low.hints.some((h) => h.tag === '라인' && /(내리|블록|문전)/.test(h.text)), '내려서는 상대에게는 블록 공략이 나옵니다', low.hints.find((h) => h.tag === '라인')?.text.slice(0, 34) + '…');
  const wide = scoutReport(world, 'gj');
  ok(wide.tactic.route >= 0.5 && wide.hints.some((h) => h.tag === '루트' && /측면/.test(h.text)), '측면 크로스 팀에게는 측면 대비가 나옵니다', wide.hints.find((h) => h.tag === '루트')?.text.slice(0, 30) + '…');
  const mine = scoutReport(world, 'gs');
  ok(mine.formation === world.myLineup.formation && mine.tactic.mentality === (world.myLineup.tactic.mentality || 0), '내 팀을 스카우팅하면 내가 저장한 라인업·성향이 나옵니다', `${mine.formation} · ${mine.mentality.name}`);
}

/* ── 16. AI 감독 실시간 맞대응 ── */
console.log('\n[16] AI 감독 맞대응 — 후반 열세면 올리고, 리드면 내린다');
{
  // 계획표 — 시간·득실차
  ok(aiMentalityPlan(-1, 50) === null && aiMentalityPlan(-1, 55) === 0.5, '후반 55분부터 열세면 공격적', `50' ${aiMentalityPlan(-1, 50)} · 55' ${aiMentalityPlan(-1, 55)}`);
  ok(aiMentalityPlan(-1, 72) === 1 && aiMentalityPlan(-2, 63) === 1, '종반 열세(72분~·두 골 차 62분~)는 총공세', `72' ${aiMentalityPlan(-1, 72)} · 62' 두 골 차 ${aiMentalityPlan(-2, 62)}`);
  ok(aiMentalityPlan(1, 70) === -0.5 && aiMentalityPlan(1, 82) === -1, '후반 리드(70분~)는 수비적, 종반(82분~)은 잠그기', `70' ${aiMentalityPlan(1, 70)} · 82' ${aiMentalityPlan(1, 82)}`);
  ok(aiMentalityPlan(0, 65) === 0 && aiMentalityPlan(0, 30) === null, '동점 복귀는 균형, 전반에는 개입하지 않음', `65 ' ${aiMentalityPlan(0, 65)} · 30' ${aiMentalityPlan(0, 30)}`);

  // 실제 엔진 — AI 쪽 성향·전술 축이 실제로 바뀌는지
  function coachProbe(diff, minute, userSide = 'home', ticks = 2) {
    const m = new Match({ world, homeId: 'gs', awayId: 'dj', homeLineup: lineupFor(world, 'gs'), awayLineup: lineupFor(world, 'dj'), seed: `coach-${diff}-${minute}-${userSide}`, cup: false, userSide });
    m.holdHalf = false; m.pause = 0; m.phase = 'play'; m.half = 2; m.t = minute * 4 - 1;
    const ai = userSide === 'home' ? 'away' : 'home';
    m.score = { home: 0, away: 0 };
    m.score[ai] = 1 + Math.max(diff, 0);
    m.score[userSide] = 1 + Math.max(-diff, 0);
    const before = { ...m.sides[ai].tactic };
    for (let i = 0; i < ticks; i++) m.tick();
    const ev = m.events.filter((e) => e.type === 'ai-tactic');
    return { m, ai, before, after: { ...m.sides[ai].tactic }, ev, minute: m.minute(), log: m.coachLog };
  }
  const trail = coachProbe(-1, 58);
  ok(trail.after.mentality === 0.5 && trail.after.line > 0.2 && trail.after.press > 0.2, '지고 있는 AI가 공격적으로 올립니다 (라인·압박 상향)',
    `성향 ${trail.before.mentality} → ${trail.after.mentality} · 라인 ${trail.before.line} → ${trail.after.line.toFixed(2)} · 압박 ${trail.before.press} → ${trail.after.press.toFixed(2)}`);
  ok(trail.ev.length === 1 && /승부수/.test(trail.ev[0].text) && /공격적/.test(trail.ev[0].text), '중계에 전술 변경 멘트가 남습니다', trail.ev[0]?.text);
  ok(/대전/.test(trail.ev[0]?.text || '') && trail.ev[0]?.minute >= 56 && trail.ev[0]?.minute <= 62, '멘트에 팀 이름과 시각이 들어갑니다', `minute ${trail.ev[0]?.minute}`);
  ok(trail.m.sides.home.tactic.mentality === 0, '내(감독) 성향은 AI가 건드리지 않습니다', `home ${trail.m.sides.home.tactic.mentality}`);
  const late = coachProbe(-1, 78);
  ok(late.after.mentality === 1 && late.after.line >= 0.6 && late.after.press >= 0.6, '종반 열세는 총공세 — 라인·압박을 끝까지 올립니다', `라인 ${late.after.line} · 압박 ${late.after.press}`);
  const lead = coachProbe(1, 73);
  ok(lead.after.mentality === -0.5 && lead.after.line < -0.2 && lead.after.press < 0, '이기고 있는 AI가 수비적으로 내립니다 (라인·압박 하향)',
    `성향 ${lead.before.mentality} → ${lead.after.mentality} · 라인 ${lead.after.line.toFixed(2)} · 압박 ${lead.after.press.toFixed(2)}`);
  const lock = coachProbe(1, 86);
  ok(lock.after.mentality === -1 && /잠그기/.test(lock.ev[0]?.text || ''), '종반 리드는 잠그기 — 두 줄로 내려앉습니다', lock.ev[0]?.text);
  const awaySide = coachProbe(-1, 60, 'away');
  ok(awaySide.after.mentality === 0.5 && /금산/.test(awaySide.ev[0]?.text || ''), '내가 원정이어도 홈 AI가 맞대응합니다', awaySide.ev[0]?.text);

  // 동점으로 돌아오면 균형 복귀
  const back = coachProbe(-1, 58);
  back.m.score.home = back.m.score.away;
  back.m.t += 2;      // 60분대
  back.m.tick(); back.m.tick();
  ok(back.m.sides[back.ai].tactic.mentality === 0 && back.m.coachLog.length >= 2, '동점이 되면 균형으로 돌아옵니다', `성향 ${back.m.sides[back.ai].tactic.mentality} · 기록 ${back.m.coachLog.length}건`);

  // 한 경기 안에서 AI가 바꾼 값은 모두 계획표와 맞아야 합니다
  let changes = 0;
  for (const seed of ['ai1', 'ai2']) {
    const m = new Match({ world, homeId: 'gs', awayId: 'dj', homeLineup: lineupFor(world, 'gs'), awayLineup: lineupFor(world, 'dj'), seed, cup: false, userSide: 'home' });
    m.holdHalf = false;
    let guard = 0;
    while (!m.done && guard < 6000) { m.tick(); guard++; }
    const bad = m.coachLog.filter((c) => c.to !== aiMentalityPlan(c.diff, c.minute));
    changes += m.coachLog.length;
    ok(bad.length === 0, `경기 ${seed} — AI 변경이 모두 계획표(득실차·시각)와 일치`, m.coachLog.map((c) => `${c.minute}' ${c.from}→${c.to}`).join(' · ') || '변경 없음');
  }
  ok(changes > 0, '실제 경기 중에도 AI 전술 변경이 발생합니다', `두 경기 합계 ${changes}회`);

  // 구버전 세이브(역할·성향 없음)에서도 새 AI 로직이 그대로 돌아갑니다
  const legacy = { ...lineupFor(world, 'gs') };
  delete legacy.roles;
  const lm = new Match({ world, homeId: 'gs', awayId: 'dj', homeLineup: legacy, awayLineup: lineupFor(world, 'dj'), seed: 'legacy-coach', cup: false, userSide: 'home' });
  lm.holdHalf = false;
  let g2 = 0;
  while (!lm.done && g2 < 6000) { lm.tick(); g2++; }
  ok(lm.done && lm.coachLog.every((c) => Number.isFinite(c.to)), '구버전 세이브 경기에서도 AI 맞대응·호환성 유지', `변경 ${lm.coachLog.length}회 · ${lm.score.home}-${lm.score.away}`);
}

console.log(`\n${fails ? `❌ ${fails}개 점검 실패` : '✅ 모든 점검 통과'}\n`);
process.exit(fails ? 1 : 0);
