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
//   17) 새 포메이션 3종(4-1-4-1·3-4-3·4-3-1-2) — 배치·역할·보드·경기 중 변경·스카우팅
//   18) 세트피스 지시(코너 3종·프리킥 3종) — 배치·타겟·슛/크로스·중계·저장
//   19) 세트피스 필드가 없는 구버전 세이브 호환
//   20) 피치 위 미니 체력 바 색 기준(70%/45%)
//   21) 선수 성장·훈련 — 라운드마다 출전·평점·나이·잠재력 반영, 훈련 방향 차이
//   22) AI 구단 간 이적·시장 갱신·이적 소식 피드
//   23) 우리 선수 영입 오퍼 — 수락/거절/역제안
//   24) 가격 협상·FA·시즌 임대(임대 종료 반환)
//   25) 4단계 필드가 없는 구버전 세이브 호환
//   29) K리그 장기 밸런스 — 12시즌 시뮬레이션 · 디비전별 유스 아카데미 · 이적 위계 · AI 세대교체
// 사용: node scripts/fm-selftest.mjs [경기수]
import { createWorld, loadWorld, saveWorld, autoLineup, setFormation, setRole, setSetPiece, lineupInfo, fillLineup, mySetup, squadOf, userNextMatch, ensureProgress, finishRound, playOtherFixtures, settleRound, generateOffers, acceptOffer, rejectOffer, counterOffer, negotiate, loanPlayer, returnLoans, signPlayer, sellToClub, advanceSeason, growthPlan, applyGrowth, growTeamFromMatch, setTraining, trainingOf, growthStatus, recentDelta, TRAINING, TRAINING_IDS, myTeam, divisionsOf, divOf, standingsFor, standings, cupStageCount, completeSeason, promotionPlan, applyPromotion, seasonSummary, seasonLabel, simMatchQuick, buildCupStage, teamPower, academyOf, KL_ACADEMY, aiTransferRound } from '../src/world.js';
import { Match, lineupFor, applyResult, growthPreview, simulateInstant, CY, W, H, aiMentalityPlan } from '../src/match.js';
// 커스텀 매치업 — 친구 팀 빌더·공유 코드·풋살(5·6인제) 경기
import {
  newTeam, normalizeTeam, setPlayerOvr, setPlayerName, setPlayerStat, autoFill, ovrOf, teamPowerOf,
  setFormation as setTeamFormation, setSize, setTeamSetPiece, parseBulk, applyBulk, packTeam, unpackTeam, encodePayload, decodePayload,
  buildMatchupWorld, resultText, matchSummary, FORMATS, formatName,
} from '../src/custom.js';
import { FORMATIONS, FORMATION_IDS, FUTSAL_FORMATIONS, formationsFor, sizeOfFormation, overall, valueOf, TEAM_DEFS } from '../src/data.js';
import { KL_ROSTERS, KL_TEAMS } from '../src/kleague2026.js';
import { roleFor, resolveRoles, defaultRole, rolesForLabel, ROLE_TUNING, MENTALITY, tacticWords, mentalityOf, SET_PIECES, resolveSetPiece, setPieceLabel } from '../src/tactics.js';
import { boardPos, renderSeason, renderHub, renderSelect, renderModal } from '../src/views.js';
import { staminaColor, STAMINA_COLORS } from '../src/matchview.js';
import { scoutReport, threatOf } from '../src/scout.js';
// 5차 — 경기 요약 로그 · 프리셋 · 저장 슬롯
import { setLogStore, getEntry, recordEntries, entryFromMatch, logInfo, LOG_BUDGET, matchKey } from '../src/history.js';
import { setPresetStore, readPresets, addPreset, overwritePreset, deletePreset, applyPreset } from '../src/presets.js';
import { setSlotStore, saveSlot, loadSlot, deleteSlot, readSlots, exportPayload, exportFileName, parseSaveFile, slotMeta, SLOT_COUNT } from '../src/saves.js';
import { readFileSync } from 'node:fs';

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

/* ── 4단계 점검 도우미 ── */
// 지정한 포지션의 선수를 원하는 나이·잠재력·능력치로 맞춥니다.
function craft(w, { pos = 'FW', age = 20, pot = 95, base = 70 } = {}) {
  const p = squadOf(w, 'gs').find((x) => x.pos === pos);
  p.age = age; p.pot = pot;
  p.stats = { spd: base, sho: base, pas: base, dri: base, def: base, vis: base, sta: base, gk: pos === 'GK' ? base + 10 : 25 };
  p.ovr = overall(p);
  p.value = valueOf(p);
  p.growthLog = [];
  return p;
}
// n 라운드만큼 성장을 돌리고 종합·능력치 변화를 돌려줍니다 (경기 키도 라운드마다 다르게).
function growN(w, p, n = 18, rating = 7.0, prefix = 'g', goals = 0) {
  const before = { ovr: p.ovr, stats: { ...p.stats } };
  for (let i = 1; i <= n; i++) {
    const key = `${prefix}-o${i}`;
    applyGrowth(w, growthPlan(w, p.id, { rating, goals }, key), key);
  }
  const stats = Object.fromEntries(Object.keys(p.stats).map((k) => [k, p.stats[k] - before.stats[k]]));
  return { d: p.ovr - before.ovr, stats, points: Object.values(stats).reduce((a, b) => a + Math.max(0, b), 0) };
}
// 내 경기를 n 라운드 진행합니다 (경기 결과 반영 → 라운드 마감 → 나머지 경기).
function playUserRounds(w, n = 1) {
  let played = 0;
  while (played < n) {
    const nx = userNextMatch(w);
    if (!nx) break;
    const { round, fixture } = nx;
    const m = simulateInstant(w, fixture.home, fixture.away, `${w.seed}-s${w.season}-r${round.no}`, round.type === 'cup', fixture.home === w.myTeamId ? 'home' : 'away');
    applyResult(w, m);
    // 앱(app.js endMatch)과 같게: 내 경기도 요약 로그에 남깁니다 (저장소가 없으면 무해)
    if (recordEntries) recordEntries(w, [entryFromMatch(w, m, round, fixture.home, fixture.away)]);
    if (round.type === 'league') {
      fixture.played = true; fixture.hg = m.score.home; fixture.ag = m.score.away;
    } else {
      const st = w.cup.stages[round.stage];
      const cm = st.matches.find((x) => x.home === fixture.home && x.away === fixture.away);
      cm.played = true; cm.hg = m.score.home; cm.ag = m.score.away;
      cm.winner = m.score.home > m.score.away ? cm.home : cm.away;
    }
    finishRound(w, round);
    playOtherFixtures(w, round, true);
    played += 1;
  }
  return played;
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
  // 경기 결과를 반영하면 선수가 성장하므로(4단계), 공용 월드는 건드리지 않고 이 점검 전용 월드를 씁니다.
  const w4 = createWorld('gs', 4242);
  const m = new Match({ world: w4, homeId: 'gs', awayId: 'dj', homeLineup: lineupFor(w4, 'gs'), awayLineup: lineupFor(w4, 'dj'), seed: 'susp', cup: false, userSide: 'home' });
  m.holdHalf = true;
  for (let i = 0; i < 6; i++) m.tick();
  const side = m.sides[m.userSide];
  const victim = side.players.find((e) => e.onPitch && e.pos === 'DF');
  const hurt = side.players.find((e) => e.onPitch && e !== victim && e.pos === 'MF');
  m.giveCard(victim, 'red');
  m.injure(hurt, side, 'test');
  let g = 0;
  while (!m.done && g < 4000) { m.tick(); g++; }
  if (!m.done) m.finish();
  applyResult(w4, m);
  const pv = w4.players[victim.id], ph = w4.players[hurt.id];
  ok(pv.bans === 1, '퇴장 → 다음 경기 출전 정지 1경기', `${pv.name} bans=${pv.bans}`);
  ok(ph.inj >= 1, '부상 → 결장 경기 수 기록', `${ph.name} inj=${ph.inj}`);
  const l = lineupFor(w4, w4.myTeamId);
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
  // 축이 중립인 팀에도 공략이 비지 않아야 합니다 (포메이션·수비 라인·추천)
  const allReports = Object.keys(world.teams).map((id) => ({ id, rep: scoutReport(world, id) }));
  ok(allReports.every((x) => x.rep.hints.length >= 3), '모든 상대에게 공략 힌트가 3개 이상 나옵니다', allReports.map((x) => `${x.id}:${x.rep.hints.length}`).join(' '));
  const neutral = allReports.find((x) => x.id === 'sc').rep;
  ok(neutral.hints.some((h) => h.tag === '포메이션') && neutral.hints.some((h) => h.tag === '추천') && neutral.hints.some((h) => h.tag === '수비'),
    '성향이 중립인 상대도 포메이션·수비 라인·추천 힌트가 나옵니다', neutral.hints.map((h) => h.tag).join('·'));
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

/* ── 17. 새 포메이션 3종 ── */
console.log('\n[17] 새 포메이션 3종 — 배치·역할·전술 보드·스카우팅');
{
  const NEW_F = ['4-1-4-1', '3-4-3', '4-3-1-2'];
  ok(NEW_F.every((f) => !!FORMATIONS[f]), '포메이션 3종이 데이터에 등록됩니다', NEW_F.join(' · '));
  ok(FORMATION_IDS.length === 7, '기존 4종 + 신규 3종 = 11인제 7종 (풋살 포메이션은 따로 셉니다)', FORMATION_IDS.join(' · '));
  const slotsOf = (f) => FORMATIONS[f].slots;
  ok(NEW_F.every((f) => slotsOf(f).length === 11 && slotsOf(f).filter((s) => s.pos === 'GK').length === 1),
    '각 포메이션 11명(골키퍼 1명)', NEW_F.map((f) => `${f}:${slotsOf(f).length}`).join(' '));
  ok(NEW_F.every((f) => slotsOf(f).every((s) => defaultRole(s.label) && rolesForLabel(s.label).length >= 1)),
    '모든 자리 라벨에 기본 역할과 역할 선택지가 있습니다',
    NEW_F.map((f) => `${f} ${slotsOf(f).map((s) => `${s.label}:${defaultRole(s.label)}`).slice(0, 3).join(',')}`).join(' | '));
  ok(NEW_F.every((f) => slotsOf(f).every((s) => {
    const p = boardPos(s, defaultRole(s.label), { mentality: 0 });
    return p.x >= 0.05 && p.x <= 0.96 && p.y >= 0.05 && p.y <= 0.95;
  })), '전술 보드 미리보기 좌표가 피치 안에 들어옵니다');
  // 역할 선택지가 실제로 2개 이상인자리 (윙백↔풀백, 커버↔스토퍼 …)
  const roleChoices = (f) => slotsOf(f).filter((s) => rolesForLabel(s.label).length >= 2).length;
  ok(NEW_F.every((f) => roleChoices(f) >= 7), '자리별 역할 선택지가 그대로 붙습니다',
    NEW_F.map((f) => `${f}:${roleChoices(f)}자리`).join(' '));

  // 전역 최적 자동 배치 — 빈 자리·포지션 역전 없음
  for (const f of NEW_F) {
    const w = createWorld('gs', 991);
    setFormation(w, f);
    const info = lineupInfo(w);
    const empty = info.slots.filter((s) => !s.p).length;
    const bad = info.slots.filter((s) => s.p && s.factor < 0.99).length;
    const dfAtFw = info.slots.filter((s) => s.slot.pos === 'FW' && s.p && s.p.pos === 'DF').length;
    const fwAtDf = info.slots.filter((s) => s.slot.pos === 'DF' && s.p && s.p.pos === 'FW').length;
    ok(empty === 0 && bad <= 2 && dfAtFw === 0 && fwAtDf === 0, `${f} 자동 배치 — 빈 자리 0, 포지션 불일치 ${bad}명`,
      info.slots.map((s) => `${s.slot.label}:${s.p ? s.p.pos : '-'}`).join(' '));
  }
  // 경기 엔진 — 새 포메이션으로 11명이 서고 경기 중에도 바꿀 수 있음
  for (const f of NEW_F) {
    const l = { ...lineupFor(world, 'gs'), formation: f };
    const m = new Match({ world, homeId: 'gs', awayId: 'dj', homeLineup: l, awayLineup: lineupFor(world, 'dj'), seed: `nf-${f}`, cup: false, userSide: 'home' });
    const on = m.sides.home.players.filter((e) => e.onPitch);
    const labels = on.map((e) => e.label);
    ok(on.length === 11 && on.every((e) => e.label && e.role),
      `${f} — 11명이 자리·역할을 받고 경기를 시작합니다`, labels.join(','));
    const next = f === '3-4-3' ? '4-1-4-1' : '3-4-3';
    m.setFormation(next);
    const after = m.sides.home.players.filter((e) => e.onPitch);
    const nextLabels = after.map((e) => e.label).sort().join(',');
    const wantLabels = FORMATIONS[next].slots.map((s) => s.label).sort().join(',');
    ok(after.length === 11 && nextLabels === wantLabels && after.every((e) => e.role),
      `경기 중 ${f} → ${next} 변경 — 11명이 새 자리로 재배치`, nextLabels);
    m.holdHalf = false;
    let g = 0;
    while (!m.done && g < 6000) { m.tick(); g++; }
    ok(m.done, `${f} 포메이션으로 90분 경기가 끝까지 진행됩니다`, `${m.score.home}-${m.score.away}`);
  }
  // 상대 스카우팅 — 새 포메이션의 예상 배치·공략이 나옴
  const prevForm = world.teams.dj.formation;
  for (const f of NEW_F) {
    world.teams.dj.formation = f;
    const rep = scoutReport(world, 'dj');
    const slots = FORMATIONS[f].slots;
    ok(rep.formation === f && !!rep.shape && rep.xi.length === 11
      && rep.xi.map((x) => x.slot).join(',') === slots.map((s) => s.label).join(','),
      `스카우팅 — ${f} 예상 배치(11명·자리) 일치`, `${rep.shape} · ${rep.xi.slice(0, 3).map((x) => `${x.slot}/${x.name}`).join(' ')}`);
    const hint = rep.hints.find((h) => h.tag === '포메이션');
    ok(!!hint && hint.text.length > 20, `스카우팅 — ${f} 포메이션 공략 힌트`, hint ? hint.text.slice(0, 34) + '…' : '없음');
    ok(rep.hints.length >= 3 && rep.setpiece && rep.setpiece.corner && rep.setpiece.freekick,
      `스카우팅 — ${f} 공략 3개 이상 · 세트피스 지시 포함`, rep.hints.map((h) => h.tag).join('·'));
  }
  world.teams.dj.formation = prevForm;

  // 포메이션을 바꿔도 같은 라벨 자리의 역할이 따라갑니다 (신규 포메이션 포함)
  const w7 = createWorld('gs', 4242);
  setFormation(w7, '4-1-4-1');
  const dmIdx = FORMATIONS['4-1-4-1'].slots.findIndex((s) => s.label === 'DM');
  setRole(w7, dmIdx, 'b2b');
  setFormation(w7, '4-3-1-2');
  const dm2 = FORMATIONS['4-3-1-2'].slots.findIndex((s) => s.label === 'DM');
  ok(w7.myLineup.roles[dm2] === 'b2b', '신규 포메이션 사이에서도 DM 역할이 자리를 따라갑니다', w7.myLineup.roles.join(','));
}

/* ── 18. 세트피스 지시 ── */
console.log('\n[18] 세트피스 지시 — 코너 3종 · 프리킥 3종이 엔진에 반영');
{
  const prog1 = (x, dir) => (dir > 0 ? x : 100 - x);
  ok(resolveSetPiece(undefined).corner === 'central' && resolveSetPiece(undefined).freekick === 'direct',
    '지시가 없는 세이브·라인업은 기본값(중앙 집중 · 직접 슈팅)으로 이어집니다', JSON.stringify(resolveSetPiece(null)));
  ok(resolveSetPiece({ corner: '??', freekick: 'x' }).corner === 'central', '모르는 지시 값은 기본값으로 보정', JSON.stringify(resolveSetPiece({ corner: '??' })));
  ok(SET_PIECES.corner.opts.length === 3 && SET_PIECES.freekick.opts.length === 3, '코너킥·프리킥 각 3가지 지시',
    SET_PIECES.corner.opts.map((o) => o.label).join('/') + ' · ' + SET_PIECES.freekick.opts.map((o) => o.label).join('/'));

  // 세트피스를 바로 세팅하고, 찬 직후의 공 상태를 잽니다
  function spProbe(type, key, seed, x, y) {
    const l = lineupFor(world, 'gs');
    l.setpiece = type === 'corner' ? { corner: key, freekick: 'direct' } : { corner: 'central', freekick: key };
    const m = new Match({ world, homeId: 'gs', awayId: 'dj', homeLineup: l, awayLineup: lineupFor(world, 'dj'), seed, cup: false, userSide: 'home' });
    m.holdHalf = true; m.pause = 0; m.phase = 'setpiece';
    m.setPiece(type, 'home', x, y);
    m.pause = 0;
    const before = { shots: m.sides.home.stats.shots, cross: m.sides.home.stats.crossN, pass: m.sides.home.stats.passes };
    let g = 0;
    while (m.phase === 'setpiece' && g < 10) { m.tick(); g++; }
    const ev = m.events.filter((e) => e.type === type).slice(-1)[0];
    return {
      m, before, ev,
      after: { shots: m.sides.home.stats.shots, cross: m.sides.home.stats.crossN, pass: m.sides.home.stats.passes },
      kind: m.ball.kind, cross: !!m.ball.cross, spKey: m.ball.spKey, dur: m.ball.dur,
      rec: m.ball.receiver && m.ball.receiver.onPitch ? m.ball.receiver : null,
      recX: m.ball.receiver ? prog1(m.ball.receiver.x, 1) : 0,
      recY: m.ball.receiver ? m.ball.receiver.y : 0,
      text: ev ? ev.text : '',
    };
  }
  // ① 코너 — 니어 포스트는 가까운 골대 쪽으로, 중앙 집중은 문전 가운데로
  for (const [cy, sideName, sign] of [[1.1, '위쪽', -1], [H - 1.1, '아래쪽', 1]]) {
    const near = spProbe('corner', 'near', `cn-${cy}`, W - 0.9, cy);
    const cen = spProbe('corner', 'central', `cc-${cy}`, W - 0.9, cy);
    const sh = spProbe('corner', 'short', `cs-${cy}`, W - 0.9, cy);
    ok(near.kind === 'cross' && near.spKey === 'near' && near.dur === 1 && near.rec
      && Math.sign(near.recY - CY) === sign && Math.abs(near.recY - CY) >= 3,
      `코너 니어 포스트(${sideName}) — 가까운 골대 앞으로 낮게(1틱) 배달`,
      near.rec ? `x ${near.recX.toFixed(1)} · y ${near.recY.toFixed(1)} · ${near.text.slice(0, 22)}…` : '리시버 없음');
    ok(cen.kind === 'cross' && cen.spKey === 'central' && cen.dur === 2 && cen.rec && Math.abs(cen.recY - CY) <= 8,
      `코너 중앙 집중(${sideName}) — 문전 가운데로 2틱 크로스`,
      cen.rec ? `x ${cen.recX.toFixed(1)} · y ${cen.recY.toFixed(1)} · ${cen.text.slice(0, 22)}…` : '리시버 없음');
    ok(near.recX > cen.recX, `니어 포스트 타겟이 중앙 집중보다 골문에 가깝습니다`, `${cen.recX.toFixed(1)} → ${near.recX.toFixed(1)}`);
    ok(sh.kind === 'pass' && !sh.cross && sh.spKey === 'short' && sh.rec
      && Math.hypot(sh.rec.x - (W - 0.9), sh.rec.y - cy) < 14 && sh.after.cross === sh.before.cross,
      `코너 짧게 연결(${sideName}) — 코너 옆 동료에게 패스, 크로스 집계 없음`,
      sh.rec ? `거리 ${Math.hypot(sh.rec.x - (W - 0.9), sh.rec.y - cy).toFixed(1)}u · ${sh.text.slice(0, 22)}…` : '리시버 없음');
    ok(/니어|가까운 골대/.test(near.text) && /중앙|한가운데/.test(cen.text) && /짧/.test(sh.text),
      '중계 멘트가 고른 지시를 그대로 말합니다', `${near.text.slice(0, 18)} / ${cen.text.slice(0, 18)} / ${sh.text.slice(0, 18)}`);
  }
  // 배치 — 니어 포스트는 문전 6야드 앞에 한 명이 서고, 짧게는 박스가 비워집니다
  const nearSet = spProbe('corner', 'near', 'cn-spots', W - 0.9, H - 1.1);
  const shortSet = spProbe('corner', 'short', 'cs-spots', W - 0.9, H - 1.1);
  const inSix = (m) => m.sides.home.players.filter((e) => e.onPitch && e.pos !== 'GK' && prog1(e.x, 1) > 94 && Math.abs(e.y - CY) < 8).length;
  const inBox = (m) => m.sides.home.players.filter((e) => e.onPitch && e.pos !== 'GK' && prog1(e.x, 1) > 84 && Math.abs(e.y - CY) < 18).length;
  ok(inSix(nearSet.m) >= 1, '니어 포스트 배치 — 6야드 앞에 쇄도하는 선수가 있습니다', `${inSix(nearSet.m)}명`);
  ok(inBox(shortSet.m) < inBox(nearSet.m), '짧게 연결 배치 — 박스를 비우고 2선에서 기다립니다', `${inBox(shortSet.m)}명 ↔ ${inBox(nearSet.m)}명`);

  // ② 프리킥 — 22u 지점
  const fkAt = { x: W - 18, y: CY };
  const d = spProbe('freekick', 'direct', 'fk-d', fkAt.x, fkAt.y);
  const b = spProbe('freekick', 'box', 'fk-b', fkAt.x, fkAt.y);
  const sh2 = spProbe('freekick', 'short', 'fk-s', fkAt.x, fkAt.y);
  ok(b.kind === 'cross' && b.spKey === 'box' && b.rec && prog1(b.rec.x, 1) > 74 && /박스|크로스/.test(b.text),
    '프리킥 박스 투입 — 문전으로 크로스, 타겟은 박스 안', b.rec ? `타겟 x ${b.recX.toFixed(1)} · ${b.text.slice(0, 20)}…` : '없음');
  ok(sh2.kind === 'pass' && !sh2.cross && sh2.spKey === 'short' && sh2.rec && Math.hypot(sh2.rec.x - fkAt.x, sh2.rec.y - fkAt.y) < 16 && /짧/.test(sh2.text),
    '프리킥 짧게 패스 — 가까운 동료에게 넘겨 점유 유지', sh2.rec ? `거리 ${Math.hypot(sh2.rec.x - fkAt.x, sh2.rec.y - fkAt.y).toFixed(1)}u` : '없음');
  // 직접 슈팅은 확률이 있어 여러 판본에서 한 번 이상 슛이 나와야 합니다
  let shotHit = null, attempts = 0;
  for (let i = 0; i < 20 && !shotHit; i++) {
    const p = spProbe('freekick', 'direct', `fk-dir-${i}`, fkAt.x, fkAt.y);
    if (p.after.shots > p.before.shots) shotHit = p;
    if (p.kind === 'cross') attempts += 1;
  }
  ok(!!shotHit && /직접/.test(shotHit.text), '프리킥 직접 슈팅 — 직접 슈팅 멘트와 함께 슛이 나옵니다',
    shotHit ? `${shotHit.text.slice(0, 30)}…` : '20번 모두 슛 없음');
  ok(attempts <= 20, '직접 슈팅이 각이 안 서면 크로스·패스로 전환됩니다', `20판 중 크로스 ${attempts}회`);

  // ③ 지시별 차이 — 20번씩 반복해 '세트피스 그 순간' 무엇을 했는지 셉니다
  function fkHarvest(key, n = 40) {
    const acc = { shots: 0, cross: 0, pass: 0 };
    for (let i = 0; i < n; i++) {
      const p = spProbe('freekick', key, `fkh-${key}-${i}`, fkAt.x, fkAt.y);
      acc.shots += p.after.shots - p.before.shots;
      acc.cross += p.after.cross - p.before.cross;
      acc.pass += p.after.pass - p.before.pass;
    }
    return acc;
  }
  const hd = fkHarvest('direct'), hb = fkHarvest('box'), hs = fkHarvest('short');
  ok(hd.shots >= 3 && hd.shots > hs.shots, '직접 슈팅은 세트피스 순간 곧바로 슛으로 이어집니다', `슛 직접 ${hd.shots} · 박스 ${hb.shots} · 짧게 ${hs.shots} (40회 기준)`);
  ok(hb.cross > hd.cross && hb.cross >= 18, '박스 투입은 거의 매번 크로스를 올립니다', `크로스 직접 ${hd.cross} · 박스 ${hb.cross} · 짧게 ${hs.cross}`);
  ok(hs.pass >= 18 && hs.cross === 0, '짧게 패스는 크로스 없이 패스로만 재개합니다', `패스 박스 ${hb.pass} · 짧게 ${hs.pass} · 크로스 ${hs.cross}`);

  // ④ 경기 중 시트에서 바꾸면 다음 세트피스부터 적용
  const l = lineupFor(world, 'gs');
  const m2 = new Match({ world, homeId: 'gs', awayId: 'dj', homeLineup: l, awayLineup: lineupFor(world, 'dj'), seed: 'sp-set', cup: false, userSide: 'home' });
  m2.holdHalf = true; m2.pause = 0;
  const got = m2.setSetPiece({ corner: 'near', freekick: 'short' });
  ok(got.corner === 'near' && got.freekick === 'short' && m2.sides.home.setpiece.corner === 'near',
    '경기 중 세트피스 지시 변경 — 엔진이 즉시 받습니다', JSON.stringify(got));
  const spNear = (() => {
    m2.phase = 'setpiece'; m2.pause = 0; m2.setPiece('corner', 'home', W - 0.9, H - 1.1); m2.pause = 0;
    let g = 0;
    while (m2.phase === 'setpiece' && g < 10) { m2.tick(); g++; }
    return { key: m2.ball.spKey, y: m2.ball.receiver ? m2.ball.receiver.y : 0 };
  })();
  ok(spNear.key === 'near' && spNear.y > CY, '바꾼 지시가 다음 코너킥에 그대로 쓰입니다', `spKey ${spNear.key} · 타겟 y ${spNear.y.toFixed(1)}`);
  ok(m2.setSetPiece({ corner: '???' }).corner === 'central', '경기 중 잘못된 값은 기본값(중앙 집중)으로 보정', JSON.stringify(m2.sides.home.setpiece));

  // ⑤ 내 라인업에 저장되고, 다음 경기 라인업으로 이어짐
  const w8 = createWorld('gs', 2026);
  setSetPiece(w8, 'corner', 'short');
  setSetPiece(w8, 'freekick', 'box');
  ok(w8.myLineup.setpiece.corner === 'short' && w8.myLineup.setpiece.freekick === 'box', '전술 탭에서 고른 지시가 내 라인업에 저장됩니다', JSON.stringify(w8.myLineup.setpiece));
  ok(mySetup(w8).setpiece.corner === 'short' && mySetup(w8).setpiece.freekick === 'box', '다음 경기 카드도 같은 지시를 읽습니다');
  const l8 = lineupFor(w8, 'gs');
  ok(l8.setpiece.corner === 'short' && l8.setpiece.freekick === 'box', '다음 경기 라인업이 저장된 지시를 그대로 씁니다');
  const m8 = new Match({ world: w8, homeId: 'gs', awayId: 'dj', homeLineup: l8, awayLineup: lineupFor(w8, 'dj'), seed: 'sp-save', cup: false, userSide: 'home' });
  ok(m8.sides.home.setpiece.corner === 'short' && m8.sides.home.setpiece.freekick === 'box',
    '경기 엔진이 저장된 지시를 받아 시작합니다', JSON.stringify(m8.sides.home.setpiece));
}

/* ── 19. 세트피스 필드가 없는 구버전 세이브 ── */
console.log('\n[19] 세트피스·새 포메이션 이전 세이브 호환');
{
  const bak = globalThis.localStorage;
  globalThis.localStorage = {
    s: {},
    getItem(k) { return Object.prototype.hasOwnProperty.call(this.s, k) ? this.s[k] : null; },
    setItem(k, v) { this.s[k] = String(v); },
    removeItem(k) { delete this.s[k]; },
    key(i) { return Object.keys(this.s)[i] ?? null; },
    get length() { return Object.keys(this.s).length; },
  };
  const w = createWorld('bm', 808);
  const legacy = JSON.parse(JSON.stringify(w));
  delete legacy.myLineup.setpiece;
  for (const t of Object.values(legacy.teams)) delete t.setpiece;
  saveWorld(legacy);
  const back = loadWorld();
  ok(!!back && back.myLineup.setpiece.corner === 'central' && back.myLineup.setpiece.freekick === 'direct',
    '세트피스 필드가 없는 세이브를 열면 기본 지시가 채워집니다', back ? JSON.stringify(back.myLineup.setpiece) : '불러오기 실패');
  ok(!!back && Object.values(back.teams).every((t) => t.setpiece && t.setpiece.corner && t.setpiece.freekick),
    'AI 구단도 기본 지시(중앙 집중·직접 슈팅)로 보정됩니다', back ? Object.values(back.teams).map((t) => t.setpiece.corner).join(',') : '');
  globalThis.localStorage = bak;

  // 새 필드가 없는 라인업으로 경기를 만들어도 세트피스가 정상 동작
  const l = { ...lineupFor(world, 'gs') };
  delete l.setpiece;
  const m = new Match({ world, homeId: 'gs', awayId: 'dj', homeLineup: l, awayLineup: lineupFor(world, 'dj'), seed: 'legacy-sp', cup: false, userSide: 'home' });
  ok(m.sides.home.setpiece.corner === 'central' && m.sides.home.setpiece.freekick === 'direct',
    '세트피스 필드가 없는 라인업도 기본 지시로 경기를 시작합니다', JSON.stringify(m.sides.home.setpiece));
  m.holdHalf = false; m.pause = 0; m.phase = 'setpiece';
  m.setPiece('corner', 'home', W - 0.9, 1.1);
  m.pause = 0;
  let g = 0;
  while (m.phase === 'setpiece' && g < 10) { m.tick(); g++; }
  ok(m.ball.kind === 'cross' && m.ball.spKey === 'central', '구버전 라인업에서도 코너킥이 정상 전개됩니다', `spKey ${m.ball.spKey}`);
  let g2 = 0;
  while (!m.done && g2 < 6000) { m.tick(); g2++; }
  ok(m.done, '구버전 세이브 경기가 끝까지 진행됩니다', `${m.score.home}-${m.score.away}`);

  // 예전 포메이션 이름만 있던 세이브 — 포메이션 목록이 늘어도 그대로 동작
  const w2 = createWorld('gs', 5);
  ok(!!FORMATIONS[w2.myLineup.formation], '세이브의 포메이션 이름이 새 목록에서도 유효합니다', w2.myLineup.formation);
  const changed = createWorld('gs', 6);
  changed.myLineup.formation = '4-1-4-1';
  const changedBack = (() => {
    const bak2 = globalThis.localStorage;
    globalThis.localStorage = { s: {}, getItem(k) { return this.s[k] ?? null; }, setItem(k, v) { this.s[k] = String(v); }, removeItem(k) { delete this.s[k]; }, key(i) { return Object.keys(this.s)[i] ?? null; }, get length() { return Object.keys(this.s).length; } };
    saveWorld(changed);
    const r = loadWorld();
    globalThis.localStorage = bak2;
    return r;
  })();
  ok(!!changedBack && changedBack.myLineup.formation === '4-1-4-1' && changedBack.myLineup.roles.length === 11,
    '새 포메이션을 고른 세이브도 그대로 열립니다', changedBack ? `${changedBack.myLineup.formation} · 역할 ${changedBack.myLineup.roles.length}` : '');
}

/* ── 20. 피치 위 체력 바 색 기준 ── */
console.log('\n[20] 피치 위 미니 체력 바 — 색 기준');
{
  ok(staminaColor(100) === STAMINA_COLORS.good && staminaColor(70) === STAMINA_COLORS.good,
    '체력 70% 이상은 초록', `100 → ${staminaColor(100)} · 70 → ${staminaColor(70)}`);
  ok(staminaColor(69) === STAMINA_COLORS.warn && staminaColor(45) === STAMINA_COLORS.warn,
    '체력 45~70%는 노랑', `69 → ${staminaColor(69)} · 45 → ${staminaColor(45)}`);
  ok(staminaColor(44) === STAMINA_COLORS.low && staminaColor(12) === STAMINA_COLORS.low,
    '체력 45% 미만은 빨강', `44 → ${staminaColor(44)} · 12 → ${staminaColor(12)}`);
  // 화면·리플레이가 읽는 값 — 모든 선수가 체력과 카드 수를 들고 있습니다
  const m = newMatch('gs', 'dj', 'stam');
  const all = ['home', 'away'].every((s) => m.sides[s].players.every((e) => Number.isFinite(e.stamina) && Number.isFinite(e.st.yellow)));
  ok(all, '피치에 그릴 체력·옐로카드 값이 모든 선수에게 있습니다',
    m.sides.home.players.slice(0, 3).map((e) => `${e.num}:${Math.round(e.stamina)}%`).join(' '));
}

/* ── 21. 선수 성장·훈련 ── */
console.log('\n[21] 선수 성장·훈련 — 라운드마다 출전·평점·나이·잠재력 반영');
{
  // ① 나이 — 성장기와 노장의 방향이 다릅니다.
  const wA = createWorld('gs', 2101);
  const young = craft(wA, { pos: 'FW', age: 20, pot: 95 });
  const old = craft(wA, { pos: 'DF', age: 34, pot: 92 });
  const gy = growN(wA, young, 18, 7.0, 'young');
  const go = growN(wA, old, 18, 6.6, 'old');
  ok(gy.d >= 2, '20세 선수는 한 시즌에 2 이상 자랍니다', `${young.name} +${gy.d} (${JSON.stringify(gy.stats)})`);
  ok(go.d <= 0, '34세 선수는 한 시즌에 내려갑니다', `${old.name} ${go.d} (spd ${go.stats.spd} · sta ${go.stats.sta})`);
  ok(gy.d - go.d >= 3, '성장기와 노장의 성장 차이가 뚜렷합니다', `+${gy.d} vs ${go.d}`);
  ok(Object.values(go.stats).some((v) => v < 0), '노장은 실제 능력치가 깎입니다', JSON.stringify(go.stats));

  // ② 평점 — 잘 뛴 경기는 더 자랍니다 (7.0 이상 가산).
  const wB = createWorld('gs', 2102);
  const high = craft(wB, { pos: 'MF', age: 21, pot: 95 });
  const low = craft(wB, { pos: 'MF', age: 21, pot: 95 });
  high.stats = { ...high.stats };
  const gh = growN(wB, high, 18, 8.2, 'high');
  const gl = growN(wB, low, 18, 5.4, 'low');
  ok(gh.d > gl.d, '평점이 높은 쪽이 더 크게 성장합니다', `8.2 → +${gh.d} · 5.4 → +${gl.d}`);

  // ③ 훈련 방향 — 같은 선수라도 고른 방향의 능력치가 먼저 자랍니다.
  const wa = createWorld('gs', 2103); setTraining(wa, 'attack');
  const wd = createWorld('gs', 2103); setTraining(wd, 'defense');
  const pa = craft(wa, { pos: 'FW', age: 21, pot: 95 });
  const pd = craft(wd, { pos: 'FW', age: 21, pot: 95 });
  const ga = growN(wa, pa, 18, 7.0, 'train');
  const gd = growN(wd, pd, 18, 7.0, 'train');
  ok(TRAINING_IDS.length >= 4 && TRAINING.attack && TRAINING.defense && TRAINING.pass && TRAINING.balanced,
    '훈련 방향 4종(균형·공격/슈팅·패스/시야·수비/체력)이 있습니다', TRAINING_IDS.join(' · '));
  ok(ga.stats.sho > gd.stats.sho, '공격/슈팅 훈련은 슈팅이 더 자랍니다', `공격 +${ga.stats.sho} vs 수비 +${gd.stats.sho}`);
  ok(gd.stats.def + gd.stats.sta >= ga.stats.def + ga.stats.sta + 1, '수비/체력 훈련은 수비·체력이 더 자랍니다',
    `수비 ${gd.stats.def}+${gd.stats.sta} vs 공격 ${ga.stats.def}+${ga.stats.sta}`);
  ok(trainingOf(wa, 'gs') === 'attack' && trainingOf(wd, 'gs') === 'defense', '고른 훈련이 팀에 저장됩니다');

  // ④ 잠재력 — 한계에 닿은 선수는 더 자라지 않습니다.
  const wP = createWorld('gs', 2104);
  const capped = craft(wP, { pos: 'MF', age: 24, pot: 70 });
  capped.pot = capped.ovr;
  const gc = growN(wP, capped, 18, 9.0, 'cap');
  ok(gc.d === 0 && gc.points === 0, '잠재력에 닿은 선수는 더 자라지 않습니다', `${capped.ovr}/${capped.pot} · +${gc.points}`);

  // ⑤ 실제 경기 결과 → 성장 반영 + 결과 화면 예고와 같은 값
  const wReal = createWorld('gs', 2105);
  const nx = userNextMatch(wReal);
  const mReal = simulateInstant(wReal, nx.fixture.home, nx.fixture.away, 'grow-real', false, nx.fixture.home === wReal.myTeamId ? 'home' : 'away');
  const prev = growthPreview(wReal, mReal);
  const beforeOvr = Object.fromEntries(prev.map((g) => [g.pid, wReal.players[g.pid].ovr]));
  applyResult(wReal, mReal);
  ok(prev.length >= 11, '경기 결과 화면이 보여 줄 성장 목록이 있습니다', `${prev.length}명`);
  ok(wReal.lastGrowth && wReal.lastGrowth.list.length === prev.length, '경기 후 성장 기록이 월드에 남습니다', `${wReal.lastGrowth?.list.length}명`);
  const same = prev.every((g) => wReal.players[g.pid].ovr === g.to && beforeOvr[g.pid] === g.from);
  ok(same, '결과 화면 예고(성장)와 실제 반영이 같은 값입니다', `${prev.filter((g) => g.d).length}명 종합 변동`);
  const logged = prev.filter((g) => wReal.players[g.pid].growthLog?.length).length;
  ok(logged >= 11, '선수마다 최근 성장 기록(growthLog)이 쌓입니다', `${logged}명`);
  const sample = wReal.players[prev[0].pid];
  ok(sample.value === valueOf(sample) && sample.wage > 0, '성장한 선수의 몸값·주급이 다시 계산됩니다',
    `${sample.name} ${sample.ovr} · ${sample.value}억`);
  ok(['prospect', 'peak', 'decline', 'up', 'down', 'flat'].includes(growthStatus(sample).key)
    && typeof recentDelta(sample) === 'number', '성장 상태(유망주·성장 중·노장 등)를 읽을 수 있습니다', growthStatus(sample).label);
}

/* ── 22. AI 구단 간 이적 ── */
console.log('\n[22] AI 구단 간 이적·시장 갱신·이적 소식 피드');
{
  const w = createWorld('gs', 2201);
  const before = Object.fromEntries(Object.values(w.teams).map((t) => [t.id, t.squad.slice().sort().join(',')]));
  const marketBefore = w.market.length;
  playUserRounds(w, 6);
  const aiEntries = w.transfers.filter((t) => t.type === 'ai');
  const changed = Object.values(w.teams).filter((t) => t.id !== w.myTeamId && t.squad.slice().sort().join(',') !== before[t.id]);
  ok(aiEntries.length >= 2, 'AI 구단끼리 실제로 선수를 사고팝니다', `${aiEntries.length}건`);
  ok(changed.length >= 2, '여러 AI 구단의 스쿼드가 실제로 바뀌였습니다', `${changed.map((t) => t.short).join(', ')}`);
  ok(w.transfers.length >= aiEntries.length && w.transfers.every((t) => t.text && t.s >= 1), '이적 소식 피드에 한 줄 설명이 남습니다',
    w.transfers.slice(0, 2).map((t) => t.text).join(' / '));
  const sizes = Object.values(w.teams).map((t) => t.squad.length);
  ok(Math.min(...sizes) >= 15 && Math.max(...sizes) <= 24, '모든 구단 스쿼드가 15~24명을 지킵니다', `${Math.min(...sizes)}~${Math.max(...sizes)}`);
  ok(Object.values(w.teams).every((t) => t.budget >= 0), '이적 뒤에도 구단 자금이 음수가 되지 않습니다');
  const marketOk = w.market.every((e) => {
    const p = w.players[e.pid];
    if (!p) return false;
    if (e.loan) return !!p.teamId && p.teamId !== w.myTeamId;
    return !e.from || p.teamId === e.from;
  });
  ok(marketOk, '시장 매물이 실제 소속 구단과 맞습니다', `${w.market.length}건 (시작 ${marketBefore}건)`);
  ok(w.market.length >= 6, '라운드가 진행돼도 시장에 매물이 남아 있습니다', `${w.market.length}건`);
  // 라운드 마감은 한 번만 처리됩니다 (중복 정산 금지)
  const round = w.calendar.find((r) => r.played);
  const feedLen = w.transfers.length;
  settleRound(w, round);
  ok(w.transfers.length === feedLen, '같은 라운드를 두 번 정산하지 않습니다', `${feedLen} → ${w.transfers.length}`);
  // 라운드가 갈수록 이적이 잦아집니다
  const early = w.transfers.filter((t) => t.type === 'ai' && t.s === 1).length;
  const w2 = createWorld('gs', 2202);
  playUserRounds(w2, 14);
  const late = w2.transfers.filter((t) => t.type === 'ai').length;
  ok(late > early, '라운드가 진행될수록 이적이 더 잦아집니다', `6R ${early}건 → 14R ${late}건`);
}

/* ── 23. 우리 선수 영입 오퍼 ── */
console.log('\n[23] 우리 선수 영입 오퍼 — 수락·거절·역제안');
{
  const w = createWorld('gs', 2301);
  const made = generateOffers(w, { no: 3 }, { force: true });
  ok(made.length >= 1 && w.offers.length >= 1, 'AI 구단이 우리 선수에게 오퍼를 보내옵니다', `${made.length}건`);
  const o1 = w.offers[0];
  const p1 = w.players[o1.pid];
  const budgetBefore = w.teams.gs.budget;
  const acc = acceptOffer(w, o1.id);
  ok(acc.ok && w.teams[o1.from].squad.includes(p1.id), '오퍼를 수락하면 선수가 그 구단으로 이적합니다',
    `${p1.name} → ${w.teams[o1.from].short}`);
  ok(w.teams.gs.budget > budgetBefore && w.finance.income > 0, '이적료가 우리 구단 자금으로 들어옵니다',
    `${budgetBefore} → ${w.teams.gs.budget}`);
  ok(!w.offers.some((o) => o.id === o1.id) && !w.teams.gs.squad.includes(p1.id), '수락한 오퍼와 선수가 정리됩니다');

  // 거절
  generateOffers(w, { no: 4 }, { force: true });
  const o2 = w.offers[0];
  const rej = rejectOffer(w, o2 && o2.id);
  ok(rej.ok && w.offers.length === 0, '오퍼를 거절하면 목록에서 사라집니다');
  ok(w.transfers.some((t) => t.type === 'reject'), '거절도 이적 소식에 남습니다');

  // 역제안 — 너무 높으면 거절하고 오퍼는 남습니다
  generateOffers(w, { no: 5 }, { force: true });
  const o3 = w.offers[0];
  const wild = counterOffer(w, o3.id, Math.round(o3.price * 3 * 10) / 10);
  ok(!wild.ok && wild.accepted === false && w.offers.some((o) => o.id === o3.id),
    '터무니없는 역제안은 거절되고 오퍼는 남습니다', `${wild.why || ''}`);
  ok(wild.price === undefined || wild.price >= o3.price, '상대가 낼 수 있는 금액을 다시 제시합니다', `${o3.price}억 · ${wild.price}억`);
  ok(w.offers.find((o) => o.id === o3.id)?.price >= o3.price, '거절 뒤에도 오퍼 금액은 줄지 않습니다',
    `${o3.price} → ${w.offers.find((o) => o.id === o3.id)?.price}`);

  // 역제안 수락 — 남은 여력이 큰 구단에 낮게 시작한 오퍼를 만들어 상한 안에서 부릅니다
  const wC = createWorld('gs', 2303);
  const p3 = squadOf(wC, 'gs').sort((a, b) => b.value - a.value)[0];
  const value = valueOf(p3);
  wC.offers = [{ id: 'oT', pid: p3.id, from: 'dj', price: Math.round(value * 0.55 * 10) / 10, season: wC.season, round: 5 }];
  const target = Math.round(value * 0.8 * 10) / 10;
  const fair = counterOffer(wC, 'oT', target);
  ok(fair.ok && fair.accepted, '상대 상한 안의 역제안은 수락됩니다', `${p3.name} ${fair.price}억 (몸값 ${value})`);
  ok(wC.teams.dj.squad.includes(p3.id) && wC.players[p3.id].teamId === 'dj', '역제안이 성사되면 선수가 그 구단으로 갑니다');
  ok(!wC.offers.some((o) => o.id === 'oT'), '성사된 오퍼는 목록에서 정리됩니다');

  // 선수단 15명 이하 보호
  const w2 = createWorld('gs', 2302);
  const list = squadOf(w2, 'gs').slice(0, 15);
  w2.teams.gs.squad = list.map((p) => p.id);
  w2.myLineup.starters = []; w2.myLineup.bench = []; fillLineup(w2);
  const guarded = sellToClub(w2, list[0].id, 'dj', 5, 'offer');
  ok(!guarded.ok && /15명/.test(guarded.why || ''), '선수단이 15명 이하가 되면 팔지 못합니다', guarded.why);
}

/* ── 24. 가격 협상 · FA · 시즌 임대 ── */
console.log('\n[24] 가격 협상·FA·시즌 임대');
{
  const w = createWorld('gs', 2401);
  const entry = w.market.filter((e) => e.from && !e.loan && e.price > 1)[0];
  const ask = entry.price;
  const p = w.players[entry.pid];
  const low = negotiate(w, entry.pid, Math.round(ask * 0.45 * 10) / 10);
  const after = w.market.find((e) => e.pid === entry.pid);
  ok(!low.accepted && after && after.price < ask, '낮은 제안은 거절되고 요청가가 내려갑니다', `${ask} → ${after?.price}`);
  const deal = negotiate(w, entry.pid, after ? after.price : ask);
  ok(deal.ok && w.teams.gs.squad.includes(p.id), '상대가 제시한 금액에는 영입됩니다', `${p.name} ${deal.price}억`);

  // FA — 이적료 없이
  const fa = w.market.find((e) => !e.from && !e.loan);
  const faP = w.players[fa.pid];
  const budget = w.teams.gs.budget;
  const faRes = signPlayer(w, fa);
  ok(faRes.ok && faP.teamId === w.myTeamId && w.teams.gs.budget === budget, '자유계약(FA)은 이적료 없이 영입됩니다', `${faP.name} ${faP.ovr}`);

  // 시즌 임대
  const w2 = createWorld('gs', 2402);
  const loanEntry = w2.market.find((e) => e.loan);
  const lp = w2.players[loanEntry.pid];
  const owner = lp.teamId;
  const budget2 = w2.teams.gs.budget;
  const ln = loanPlayer(w2, loanEntry);
  ok(ln.ok && lp.teamId === w2.myTeamId && lp.loan && lp.loan.owner === owner, '임대로 선수를 데려오면 원소속이 기록됩니다',
    `${lp.name} ← ${w2.teams[owner].short} · 임대료 ${ln.price}억`);
  ok(w2.teams.gs.budget === Math.round((budget2 - ln.price) * 10) / 10 && w2.loans.length === 1, '임대료만 나가고 이적 자금은 그대로입니다',
    `${budget2} → ${w2.teams.gs.budget}`);
  ok(!w2.market.some((e) => e.pid === lp.id), '임대한 선수는 시장에서 빠집니다');
  const back = returnLoans(w2);
  ok(back.length === 1 && lp.teamId === owner && !lp.loan && w2.loans.length === 0, '시즌이 끝나면 임대 선수가 원소속으로 돌아갑니다',
    JSON.stringify(back));
  ok(!w2.teams.gs.squad.includes(lp.id), '돌려보낸 선수는 내 선수단에서 빠집니다');

  // 임대가 아닌 매물은 임대로 데려올 수 없음
  const normal = w2.market.find((e) => e.from && !e.loan);
  const bad = loanPlayer(w2, { ...normal, loan: false });
  ok(!bad.ok, '임대 매물이 아니면 임대로 데려올 수 없습니다', bad.why);
  // 시즌 결산에서도 임대가 정리됩니다
  const w3 = createWorld('gs', 2403);
  const le = w3.market.find((e) => e.loan);
  loanPlayer(w3, le);
  playUserRounds(w3, 18);
  const season = advanceSeason(w3);
  ok(Array.isArray(season.loansBack) && w3.loans.length === 0, '시즌 결산에서 임대가 정리됩니다', JSON.stringify(season.loansBack));
}

/* ── 25. 4단계 필드가 없는 구버전 세이브 ── */
console.log('\n[25] 4단계 이전 세이브 호환');
{
  const bak = globalThis.localStorage;
  globalThis.localStorage = {
    s: {},
    getItem(k) { return Object.prototype.hasOwnProperty.call(this.s, k) ? this.s[k] : null; },
    setItem(k, v) { this.s[k] = String(v); },
    removeItem(k) { delete this.s[k]; },
    key(i) { return Object.keys(this.s)[i] ?? null; },
    get length() { return Object.keys(this.s).length; },
  };
  const w = createWorld('bm', 2501);
  const legacy = JSON.parse(JSON.stringify(w));
  // 4단계 이전 세이브 — 잠재력·훈련·오퍼·임대·성장 기록·이적 피드가 없습니다.
  delete legacy.offers; delete legacy.loans; delete legacy.transfers; delete legacy.lastGrowth; delete legacy.offerSeq;
  for (const t of Object.values(legacy.teams)) delete t.training;
  for (const p of Object.values(legacy.players)) { delete p.pot; delete p.growthLog; }
  saveWorld(legacy);
  const back = loadWorld();
  ok(!!back, '구버전 세이브를 그대로 엽니다');
  ok(back && Array.isArray(back.offers) && Array.isArray(back.loans) && Array.isArray(back.transfers), '오퍼·임대·이적 피드 배열이 채워집니다');
  ok(back && Object.values(back.teams).every((t) => TRAINING[t.training]), '모든 구단의 훈련 방향이 기본값(균형)으로 채워집니다',
    back ? Object.values(back.teams).map((t) => t.training).join(',') : '');
  ok(back && Object.values(back.players).every((p) => Number.isFinite(p.pot) && p.pot >= p.ovr && Array.isArray(p.growthLog)),
    '모든 선수의 잠재력·성장 기록이 보정됩니다',
    back ? `${Object.values(back.players).filter((p) => p.pot > p.ovr).length}명 성장 여지` : '');
  const p = back ? squadOf(back, back.myTeamId).sort((a, b) => a.age - b.age)[0] : null;
  const plan = p ? growthPlan(back, p.id, { rating: 7.4 }, 'legacy') : null;
  ok(!!plan, '구버전 세이브에서도 성장 계산이 됩니다', p ? `${p.name} ${plan.from}→${plan.to}` : '');
  const round = back?.calendar?.[0];
  let settledOk = false;
  try { settledOk = settleRound(back, round) === true; } catch { settledOk = false; }
  ok(settledOk, '구버전 세이브에서도 라운드 정산(AI 이적·오퍼)이 돕니다');
  globalThis.localStorage = bak;
}

/* ── 26. 포지셔닝 — 파이널 서드 지원 · 수비 두 줄 블록 · 한 구역 몰림 ──
   사용자가 경기 화면에서 찍어 보낸 두 장면(공을 잡고 올라가도 동료가 안 올라옴 /
   20명이 한 구역에 몰림)의 회귀를 막는 점검입니다. 전술 축이 아니라 '대형' 자체를 셉니다. */
console.log('\n[26] 포지셔닝 — 공격 지원 · 수비 블록 · 몰림');
{
  const pv = (x, dir) => (dir > 0 ? x : 100 - x);
  const zoneMax = (ps, cw, ch) => {
    const g = new Map();
    for (const e of ps) { const k = `${Math.floor(e.x / cw)},${Math.floor(e.y / ch)}`; g.set(k, (g.get(k) || 0) + 1); }
    let best = 0;
    for (const k of g.keys()) {
      const [gx, gy] = k.split(',').map(Number);
      let c = 0;
      for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) c += g.get(`${gx + dx},${gy + dy}`) || 0;
      if (c > best) best = c;
    }
    return best;
  };
  const w26 = createWorld('gs', 20261122);
  const ids26 = Object.keys(w26.teams).sort();
  const acc = { atkN: 0, near22: 0, ownHalf: 0, defN: 0, defBox: 0, defSix: 0, lineGap: 0, gapN: 0, frames: 0, crowd: 0, crowd6: 0 };
  for (let i = 0; i < 12; i++) {
    const home = ids26[i % ids26.length], away = ids26[(i * 3 + 1) % ids26.length];
    const m = new Match({ world: w26, homeId: home, awayId: away, homeLineup: lineupFor(w26, home), awayLineup: lineupFor(w26, away), seed: `pos-${i}`, cup: false, userSide: 'home' });
    m.holdHalf = false;
    let g = 0, streak = { home: 0, away: 0 };
    while (!m.done && g < 6000) {
      m.tick(); g++;
      if (m.phase !== 'play') { streak = { home: 0, away: 0 }; continue; }
      const b = m.ball;
      // 세트피스·킥오프 직후(자리로 모이는 중)는 대형 점검에서 뻗니다
      if (m.t - (m.lastSetPieceT ?? -99) <= 8 || m.t - (m.lastKickoffT ?? -99) <= 8) continue;
      // 한 구역 몰림 — 8x6 격자의 3x3(24x18u) 안에 10명 이상
      const all = [];
      for (const s of ['home', 'away']) for (const e of m.sides[s].players) if (e.onPitch) all.push(e);
      acc.frames += 1;
      if (zoneMax(all, 8, 6) >= 10) acc.crowd += 1;
      if (zoneMax(all, 5, 3.6) >= 6) acc.crowd6 += 1;
      const owner = b.owner;
      if (!owner) continue;
      streak[owner.side] += 1; streak[owner.side === 'home' ? 'away' : 'home'] = 0;
      if (streak[owner.side] < 8) continue;
      const atk = m.sides[owner.side], def = m.sides[m.opposing[owner.side]];
      const bp = pv(b.x, atk.dir);
      if (bp > 66) {
        acc.atkN += 1;
        const mates = atk.players.filter((e) => e.onPitch && e !== owner && e.pos !== 'GK');
        acc.near22 += mates.filter((e) => Math.hypot(e.x - b.x, e.y - b.y) < 22).length;
        acc.ownHalf += mates.filter((e) => pv(e.x, atk.dir) < 45).length;
      }
      if (bp > 70) {
        acc.defN += 1;
        const outs = def.players.filter((e) => e.onPitch && e.pos !== 'GK');
        const own = (e) => pv(e.x, def.dir);
        acc.defBox += outs.filter((e) => own(e) < 17 && Math.abs(e.y - CY) < 20).length;
        acc.defSix += outs.filter((e) => own(e) < 8 && Math.abs(e.y - CY) < 12).length;
        const dfs = outs.filter((e) => e.pos === 'DF').map(own);
        const mfs = outs.filter((e) => e.pos === 'MF').map(own);
        if (dfs.length && mfs.length) {
          acc.lineGap += (mfs.reduce((a, v) => a + v, 0) / mfs.length) - (dfs.reduce((a, v) => a + v, 0) / dfs.length);
          acc.gapN += 1;
        }
      }
    }
  }
  const near22 = acc.near22 / Math.max(1, acc.atkN);
  const ownHalf = acc.ownHalf / Math.max(1, acc.atkN);
  const defBox = acc.defBox / Math.max(1, acc.defN);
  const defSix = acc.defSix / Math.max(1, acc.defN);
  const lineGap = acc.lineGap / Math.max(1, acc.gapN);
  const crowd = (acc.crowd / Math.max(1, acc.frames)) * 100;
  const crowd6 = (acc.crowd6 / Math.max(1, acc.frames)) * 100;
  ok(near22 >= 1.8, '공을 잡고 올라가면 동료가 22u 안에 붙어 있습니다', `평균 ${near22.toFixed(2)}명 (개선 전 1.5)`);
  ok(ownHalf <= 3.6, '파이널 서드 공격 때 우리 진영에 남는 선수가 적습니다', `평균 ${ownHalf.toFixed(2)}명 (개선 전 4.2)`);
  ok(defBox <= 1.8, '상대가 전방에 있어도 수비수가 우리 박스에 다 몰리지 않습니다', `박스 안 ${defBox.toFixed(2)}명 (개선 전 3.2)`);
  ok(defSix <= 1.6, '6야드 박스 안에 수비수가 겹쳐 서지 않습니다', `평균 ${defSix.toFixed(2)}명`);
  ok(lineGap >= 8, '수비 라인과 2선 사이에 간격이 있습니다(두 줄 블록)', `간격 ${lineGap.toFixed(1)}u`);
  ok(crowd < 45, '한 구역(24x18u)에 10명 이상 몰리는 시간이 절반 아래입니다', `전체 틱의 ${crowd.toFixed(1)}% (개선 전 44%)`);
  ok(crowd6 < 45, '좁은 구역(15x11u)에 6명 이상 몰리지 않습니다', `${crowd6.toFixed(1)}%`);
}

/* ── 27. K리그 2026 모드 — 실제 56개 구단 · K4→K1 승강제 · 코리아컵 ── */
console.log('\n[27] K리그 2026 모드 — 실제 구단·선수, 4부 승강제, 코리아컵');
{
  const kl = createWorld('geumsan', 20261201, { mode: 'kleague' });
  const app = { world: kl, savedGame: null, defs: Object.fromEntries([...TEAM_DEFS.map((t) => [t.id, t]), ...KL_TEAMS.map((t) => [t.id, t])]), state: { tab: 'records', pickMode: 'kleague', pickDiv: 4, divTab: 4, posFilter: 'ALL', sortKey: 'ovr', sortDir: -1, marketDiv: 0, seasonPhase: 'preview', seasonResult: null } };
  ok(kl.mode === 'kleague' && kl.year === 2026, 'K리그 모드로 2026 시즌이 열립니다', `mode=${kl.mode} year=${kl.year}`);
  ok(Object.keys(kl.teams).length === 56, '56개 구단이 들어 있습니다', `${Object.keys(kl.teams).length}팀`);
  const divs = divisionsOf(kl).map((d) => d.teams.length);
  ok(divs.join(',') === '12,17,14,13', 'K1 12 · K2 17 · K3 14 · K4 13 로 나뉩니다', divs.join(' / '));

  // 실제 선수 데이터 — 한글 이름·등번호·나이·포지션
  const geum = squadOf(kl, 'geumsan');
  ok(geum.length === 20 && geum.every((p) => p.name && p.num > 0 && p.age >= 16 && ['GK', 'DF', 'MF', 'FW'].includes(p.pos)),
    '금산 인삼 FC 20명이 이름·등번호·나이·포지션을 갖습니다', geum.slice(0, 3).map((p) => `${p.num} ${p.name} ${p.pos} ${p.age}`).join(' / '));
  const seoulSquad = squadOf(kl, 'seoul');
  const seoulReal = new Set((KL_ROSTERS.seoul || []).map(([name]) => name));
  ok(seoulSquad.length === 20 && seoulSquad.every((p) => seoulReal.has(p.name)), 'FC 서울 선수 20명이 실제 2026 명단에서 그대로 들어옵니다', seoulSquad.slice(0, 4).map((p) => p.name).join(', '));
  ok(seoulSquad.some((p) => p.name === '야잔' || p.name === '바베츠'), '외국인 선수 이름도 실제 명단 그대로입니다');
  const dupNum = squadOf(kl, 'seoul').map((p) => p.num).filter((n, i, a) => a.indexOf(n) !== i);
  ok(dupNum.length === 0, '한 구단 안에서 등번호가 겹치지 않습니다');

  // 디비전 격차
  const avgOvr = (id) => { const s = squadOf(kl, id); return Math.round(s.reduce((a, p) => a + p.ovr, 0) / s.length); };
  const k1 = Math.round(divisionsOf(kl)[0].teams.reduce((a, id) => a + avgOvr(id), 0) / 12);
  const k4 = Math.round(divisionsOf(kl)[3].teams.reduce((a, id) => a + avgOvr(id), 0) / 13);
  ok(k1 - k4 >= 18 && k1 >= 68 && k4 <= 52, '리그 티어만큼 전력 격차가 있습니다', `K1 평균 ${k1} · K4 평균 ${k4}`);

  // 경기 수 — K4 24경기, K3 26, K2 32, K1 33
  const gamesOf = (div) => {
    const counts = {};
    for (const r of kl.calendar) {
      if (r.type !== 'league' || r.div !== div) continue;
      for (const f of r.fixtures) { counts[f.home] = (counts[f.home] || 0) + 1; counts[f.away] = (counts[f.away] || 0) + 1; }
    }
    const vals = [...new Set(Object.values(counts))];
    return vals.length === 1 ? vals[0] : vals.join('/');
  };
  ok(gamesOf(4) === 24 && gamesOf(3) === 26 && gamesOf(2) === 32 && gamesOf(1) === 33,
    '디비전별 더블 라운드 로빈(1부는 33라운드) 일정이 짜집니다', `K1 ${gamesOf(1)} · K2 ${gamesOf(2)} · K3 ${gamesOf(3)} · K4 ${gamesOf(4)}경기`);
  const cross = kl.calendar.filter((r) => r.type === 'league' && r.fixtures.some((f) => kl.teams[f.home].div !== r.div || kl.teams[f.away].div !== r.div));
  ok(cross.length === 0, '다른 디비전 팀끼리 리그 경기를 치르지 않습니다');

  // 순위표 — 디비전별
  ok(standingsFor(kl, 4).length === 13 && standingsFor(kl, 1).length === 12, '디비전별 순위표를 따로 볼 수 있습니다',
    `K1 ${standingsFor(kl, 1).length} · K4 ${standingsFor(kl, 4).length}`);
  ok(standings(kl).length === 13 && standings(kl).every((r) => kl.teams[r.id].div === 4), '기본 순위표는 내 디비전(K4)입니다');

  // 코리아컵 — 56팀 6단계
  ok(cupStageCount(kl) === 6, '코리아컵은 6단계입니다');
  ok(kl.cup.stages[0].matches.length === 24 && (kl.cup.byes || []).length === 8, '1라운드는 48팀(24경기), 상위 8팀은 32강부터 합류합니다',
    `${kl.cup.stages[0].matches.length}경기 · 부전승 ${(kl.cup.byes || []).length}`);
  const cupTeams = new Set();
  for (const s of kl.cup.stages) for (const m of s.matches) { cupTeams.add(m.home); cupTeams.add(m.away); }
  ok(cupTeams.size + (kl.cup.byes || []).length >= 56, 'K1~K4 전체 구단이 컵대회에 참가합니다', `${cupTeams.size + (kl.cup.byes || []).length}팀`);

  // 내 경기를 3라운드 치르고 선수 상세 기록이 쌓이는지
  const played = playUserRounds(kl, 3);
  const some = squadOf(kl, 'geumsan').filter((p) => p.season.apps > 0);
  ok(played === 3 && some.length >= 11 && some.length <= 14, '내 경기가 실제로 진행되고 11명 이상 출전 기록이 남습니다', `${played}경기 · ${some.length}명`);
  ok(some.every((p) => p.season.starts >= 1) && some.every((p) => Array.isArray(p.recent) && p.recent.length > 0),
    '선발 출전 수와 최근 평점이 선수별로 기록됩니다', some.slice(0, 3).map((p) => `${p.name} 선발${p.season.starts} 최근${p.recent.join(',')}`).join(' / '));
  ok(some.some((p) => Number.isFinite(p.season.ratingSum / Math.max(1, p.season.ratingCount))), '평균 평점을 계산할 수 있습니다');

  // 세이브/로드 — 56개 구단 전체 저장
  const raw = JSON.stringify(kl);
  ok(raw.length < 2 * 1024 * 1024, '56개 구단 전체 세이브가 2MB 안에 들어갑니다', `${(raw.length / 1024).toFixed(0)}KB`);
  const bak = globalThis.localStorage;
  globalThis.localStorage = {
    s: {},
    getItem(k) { return Object.prototype.hasOwnProperty.call(this.s, k) ? this.s[k] : null; },
    setItem(k, v) { this.s[k] = String(v); },
    removeItem(k) { delete this.s[k]; },
    key(i) { return Object.keys(this.s)[i] ?? null; },
    get length() { return Object.keys(this.s).length; },
  };
  saveWorld(kl);
  const back = loadWorld();
  ok(!!back && back.mode === 'kleague' && Object.keys(back.teams).length === 56 && back.divisions.length === 4,
    'K리그 세이브를 그대로 다시 엽니다', back ? `${Object.keys(back.teams).length}팀 · ${back.divisions.map((d) => d.teams).length}부` : '실패');
  ok(!!back && squadOf(back, 'geumsan').every((p) => p.name && p.num > 0), '불러온 뒤에도 선수 명단이 그대로입니다');
  globalThis.localStorage = bak;

  // 시즌 결산 · 승격/강등
  const beforeDiv = Object.fromEntries(Object.entries(kl.teams).map(([id, t]) => [id, t.div]));
  completeSeason(kl);
  const s = seasonSummary(kl);
  ok(s.table.length === 13 && s.divs.length === 4, '시즌 결산에 내 디비전 순위와 4개 디비전이 모두 나옵니다');
  ok(s.moves.filter((m) => m.kind === 'direct').length === 3 && s.moves.filter((m) => m.kind === 'playoff').length === 3,
    '세 경계에서 맞교대 3건 + 승강 플레이오프 3건이 잡힙니다');
  const plan = promotionPlan(kl);
  const counts0 = divisionsOf(kl).map((d) => d.teams.length).join(',');
  applyPromotion(kl);
  const counts1 = divisionsOf(kl).map((d) => d.teams.length).join(',');
  ok(counts1 === counts0, '승격·강등 뒤에도 디비전 팀 수가 유지됩니다', `${counts0} → ${counts1}`);
  const moved = Object.values(kl.teams).filter((t) => t.div !== beforeDiv[t.id]).length;
  const directOk = plan.filter((m) => m.kind === 'direct').every((m) => kl.teams[m.up].div === m.upDiv && kl.teams[m.down].div === m.loDiv);
  ok(directOk && moved >= 4, '맞교대 구단이 실제로 디비전을 옮겼습니다', `${moved}팀 이동`);
  ok(plan.some((m) => m.kind === 'playoff' && m.winner && m.loser), '승강 플레이오프 승자가 정해집니다',
    plan.filter((m) => m.kind === 'playoff').map((m) => `${kl.teams[m.upper].short} vs ${kl.teams[m.lower].short}`).join(', '));

  // 1부 꼴찌는 2부로 내려갑니다
  const kl2 = createWorld('gwangju', 20261202, { mode: 'kleague' });
  completeSeason(kl2);
  const k1Table = standingsFor(kl2, 1);
  const bottom = k1Table[k1Table.length - 1].id;
  const bottomName = kl2.teams[bottom].name;
  applyPromotion(kl2);
  ok(kl2.teams[bottom].div === 2, '1부 꼴찌 구단이 2부로 강등됩니다', bottomName);
  const promoted = Object.keys(kl2.teams).filter((id) => kl2.teams[id].div === 1 && Object.values(kl2.teams).find((t) => t.id === id));
  ok(promoted.length === 12, '1부는 그대로 12팀입니다', `${promoted.length}팀`);

  // 다음 시즌 — 새 일정, 이전 이동 반영
  const r = advanceSeason(kl);
  ok(kl.year === 2027 && kl.calendar.length > 100, '다음 시즌(2027) 일정이 새로 짜집니다', `year=${kl.year} · ${kl.calendar.length}매치데이`);
  ok(r.promo.length === 6, '시즌 결산에 승격·강등 6건이 실립니다');
  const myDiv2 = divOf(kl, 'geumsan');
  ok([1, 2, 3, 4].includes(myDiv2), '내 팀도 새 디비전에서 시작합니다', `${kl.teams.geumsan.name} → ${myDiv2}부`);
  ok(squadOf(kl, 'geumsan').length >= 20, '새 시즌에도 선수단이 20명 이상 유지됩니다', `${squadOf(kl, 'geumsan').length}명`);

  // 화면 렌더 — 시즌 결산·허브·선수 상세가 K리그 데이터로도 그려지는지 (렌더 예외 0)
  app.state.seasonResult = { ...r, season: r.summary ? kl.season - 1 : kl.season };
  app.state.seasonPhase = 'done';
  let html = '';
  try { html = renderSeason(app); } catch (e) { html = 'ERR ' + e.message; }
  ok(html.includes('승격') || html.includes('강등'), '시즌 결산 화면에 승격·강등 결과가 그려집니다', html.startsWith('ERR') ? html : `${html.length}자`);
  let hub = '';
  try { hub = renderHub(app); } catch (e) { hub = 'ERR ' + e.message; }
  ok(hub.includes('K4리그') || hub.includes('K3리그') || hub.includes('K2리그') || hub.includes('K리그1'), '허브 화면이 새 디비전으로 그려집니다', hub.startsWith('ERR') ? hub : `${hub.length}자`);
  let sel = '';
  try { sel = renderSelect({ ...app, world: null, savedGame: null }); } catch (e) { sel = 'ERR ' + e.message; }
  ok(sel.includes('K리그 2026') && sel.includes('금산 인삼 FC'), '구단 선택 화면에 K리그 2026 과 금산 인삼 FC 가 나옵니다', sel.startsWith('ERR') ? sel : `${sel.length}자`);
  const anyPid = squadOf(kl, 'seoul')[0].id;
  let pm = '';
  try { pm = renderModal({ ...app, state: { ...app.state, modal: { kind: 'player', pid: anyPid, team: 'seoul', back: 'club' } } }); } catch (e) { pm = 'ERR ' + e.message; }
  ok(pm.includes('stats8') && pm.includes('최근 평점'), '선수 상세 모달에 8개 능력치와 최근 평점이 그려집니다', pm.startsWith('ERR') ? pm : `${pm.length}자`);
  let cm = '';
  try { cm = renderModal({ ...app, state: { ...app.state, modal: { kind: 'club', team: 'jinju' } } }); } catch (e) { cm = 'ERR ' + e.message; }
  ok(cm.includes('club-squad') && /jinju|진주/.test(cm), '구단 모달에 선수단 표가 그려집니다', cm.startsWith('ERR') ? cm : `${cm.length}자`);
}

/* ── 28. 5차 — 이전 경기 터록 · 전술·명단 프리셋 · 저장/불러오기 · 로고 ── */
console.log('\n[28] 이전 경기 결과 · 전술·명단 프리셋 · 저장/불러오기 · 로고');
{
  /* 테스트용 저장소 — node 에는 localStorage 가 없으므로 메모리로 갈아 끼밉니다. */
  const memStore = () => {
    const m = new Map();
    return {
      _m: m,
      get(k, f = null) { return m.has(k) ? JSON.parse(m.get(k)) : f; },
      set(k, v) { m.set(k, JSON.stringify(v)); },
      remove(k) { m.delete(k); },
    };
  };
  const fullStore = () => ({ get: () => null, set() { throw new Error('QuotaExceededError'); }, remove() {} });
  const logStore = memStore(), slotStore = memStore(), presetStore = memStore();
  setLogStore(logStore); setSlotStore(slotStore); setPresetStore(presetStore);

  /* ── (1) 내 경기 · AI 경기 요약 ── */
  const hw = createWorld('gs', 20261212);
  const nx = userNextMatch(hw);
  const hm = simulateInstant(hw, nx.fixture.home, nx.fixture.away, 'v5-a', nx.round.type === 'cup', 'home');
  applyResult(hw, hm);
  recordEntries(hw, [entryFromMatch(hw, hm, nx.round, nx.fixture.home, nx.fixture.away)]);
  nx.fixture.played = true; nx.fixture.hg = hm.score.home; nx.fixture.ag = hm.score.away;
  finishRound(hw, nx.round); playOtherFixtures(hw, nx.round, true);
  const e1 = getEntry(hw, nx.round, nx.fixture.home, nx.fixture.away);
  ok(!!e1 && e1.hg === hm.score.home && e1.ag === hm.score.away, '내 경기 결과가 요약으로 저장됩니다', e1 ? `${e1.hg}-${e1.ag} ${e1.k}` : '없음');
  ok(!!e1 && e1.g.length === hm.score.home + hm.score.away, '저장된 득점 장면 수가 스코어와 맞습니다', e1 ? `${e1.g.length}장면` : '');
  ok(!!e1 && e1.g.every((g) => g[0] >= 1 && g[0] <= 120 && ['h', 'a'].includes(g[1]) && g[2]), '득점 장면마다 시간·팀·득점자가 있습니다');
  ok(!!e1 && e1.rt.h.length === 11 && e1.rt.a.length === 11, '양 팀 출전 선수 평점이 함께 저장됩니다', e1 ? `${e1.rt.h.length}+${e1.rt.a.length}명` : '');
  ok(!!e1 && Array.isArray(e1.s.h) && e1.s.h.length === 9 && e1.s.h[0] + e1.s.a[0] === 100, '주요 기록 9종과 점유율 합 100%', e1 ? `점유율 ${e1.s.h[0]}:${e1.s.a[0]}` : '');
  const otherPlayed = hw.calendar.filter((r) => r.type === 'league' && r.played).flatMap((r) => r.fixtures.map((f) => ({ r, f }))).filter((x) => x.f.home !== hw.myTeamId && x.f.away !== hw.myTeamId);
  ok(otherPlayed.length > 0 && otherPlayed.every((x) => !!getEntry(hw, x.r, x.f.home, x.f.away)), 'AI 경기(다른 구단) 요약도 함께 남습니다', `${otherPlayed.length}경기`);
  const aiEntry = otherPlayed.length ? getEntry(hw, otherPlayed[0].r, otherPlayed[0].f.home, otherPlayed[0].f.away) : null;
  ok(!!aiEntry && aiEntry.g.length === aiEntry.hg + aiEntry.ag && Array.isArray(aiEntry.s.h), 'AI 경기 요약에도 득점자·주요 기록이 있습니다');
  const aiNames = (otherPlayed.length ? getEntry(hw, otherPlayed[0].r, otherPlayed[0].f.home, otherPlayed[0].f.away) : null)?.g || [];
  const aiTeams = new Set([...otherPlayed.slice(0, 4)].flatMap((x) => (getEntry(hw, x.r, x.f.home, x.f.away)?.g || []).map((g) => g[2])));
  ok(aiNames.every((g) => g[2] && ['h', 'a'].includes(g[1])), 'AI 경기 득점자는 실제 선수 이름으로, 홈/원정 구분과 함께 남습니다', [...aiTeams].slice(0, 3).join(', '));

  /* 컵대회 경기(연장)도 요약에 남는지 */
  const cupWorld = createWorld('gs', 20261213);
  let cupSeed = 0, cupTried = false, cupOk = true;
  while (!cupTried && cupSeed < 40) {
    ensureProgress(cupWorld);   // 앱처럼: 내 경기가 없는 라운드는 먼저 진행
    const n2 = userNextMatch(cupWorld);
    if (!n2) break;
    const m2 = simulateInstant(cupWorld, n2.fixture.home, n2.fixture.away, `v5-c${cupSeed}`, n2.round.type === 'cup', 'home');
    applyResult(cupWorld, m2);
    recordEntries(cupWorld, [entryFromMatch(cupWorld, m2, n2.round, n2.fixture.home, n2.fixture.away)]);
    n2.fixture.played = true; n2.fixture.hg = m2.score.home; n2.fixture.ag = m2.score.away;
    finishRound(cupWorld, n2.round); playOtherFixtures(cupWorld, n2.round, true);
    if (n2.round.type === 'cup') {
      cupTried = true;
      const ce = getEntry(cupWorld, n2.round, n2.fixture.home, n2.fixture.away);
      cupOk = !!ce && ce.k.startsWith('C');
    }
    cupSeed += 1;
  }
  ok(cupTried && cupOk, '컵대회 경기 요약도 라운드 키와 함께 남습니다');

  /* ── (2) 저장 크기 — 경기 기록은 가법게 ── */
  const info = logInfo(hw);
  ok(info.bytes < LOG_BUDGET, '경기 기록이 예산(0.7MB) 안에 있습니다', `${Math.round(info.bytes / 1024)}KB · ${info.total}경기`);
  ok(info.bytes / Math.max(1, info.total) < 400, '경기 1건당 요약이 400B 미만입니다', `${Math.round(info.bytes / Math.max(1, info.total))}B`);

  /* ── (3) 전술·명단 프리셋 ── */
  const pw = createWorld('gs', 20261214);
  setFormation(pw, '4-2-3-1');
  pw.myLineup.tactic = { line: 0.5, pass: -0.5, press: 0.8, route: 0.3, mentality: 0.75 };
  setSetPiece(pw, 'corner', 'near');
  setTraining(pw, 'attack');
  const want = {
    formation: pw.myLineup.formation,
    tactic: JSON.stringify(pw.myLineup.tactic),
    roles: JSON.stringify(pw.myLineup.roles),
    setpiece: JSON.stringify(pw.myLineup.setpiece),
    starters: JSON.stringify(pw.myLineup.starters),
    bench: JSON.stringify(pw.myLineup.bench),
    training: pw.teams.gs.training,
  };
  const saved = addPreset(pw, '홈 압박 4-2-3-1');
  ok(saved.ok && readPresets().list.length === 1, '프리셋이 이름으로 저장됩니다', saved.ok ? saved.preset.name : saved.why);
  ok(readPresets().list[0].starters.filter(Boolean).length === 11, '선발 11명이 함께 저장됩니다');
  // 설정을 마구 바꿔본 뒤 한 번에 되살리기
  setFormation(pw, '4-4-2');
  pw.myLineup.tactic = { line: -0.6, pass: 0.6, press: -0.8, route: -0.4, mentality: -1 };
  setSetPiece(pw, 'corner', 'short');
  setTraining(pw, 'defense');
  const res1 = applyPreset(pw, readPresets().list[0]);
  ok(res1.ok && pw.myLineup.formation === want.formation, '불러오면 포메이션이 되살아납니다', pw.myLineup.formation);
  ok(JSON.stringify(pw.myLineup.tactic) === want.tactic, '전술 4축 · 팀 성향이 그대로 되살아납니다', JSON.stringify(pw.myLineup.tactic));
  ok(JSON.stringify(pw.myLineup.roles) === want.roles, '포지션별 역할이 그대로 되살아납니다');
  ok(JSON.stringify(pw.myLineup.setpiece) === want.setpiece, '세트피스 지시가 그대로 되살아납니다');
  ok(pw.teams.gs.training === want.training, '주간 훈련이 그대로 되살아납니다', pw.teams.gs.training);
  ok(JSON.stringify(pw.myLineup.starters) === want.starters, '선발 11명이 그대로 되살아납니다');
  ok(JSON.stringify(pw.myLineup.bench) === want.bench, '후보 명단도 그대로 되살아납니다');

  /* 이적 · 부상 · 정지 — 빠진 자리만 다른 선수로 */
  const preset = readPresets().list[0];
  const goneRef = preset.starters[0];         // 골키퍼가 이적
  const hurtRef = preset.starters[5];         // 미드필더가 부상
  const goneP = pw.players[goneRef.pid];
  pw.teams.gs.squad = pw.teams.gs.squad.filter((id) => id !== goneP.id);
  pw.teams.dj.squad.push(goneP.id); goneP.teamId = 'dj';
  pw.players[hurtRef.pid].inj = 2;
  const res2 = applyPreset(pw, preset);
  ok(res2.ok && res2.changed >= 2, '이적·부상으로 빠진 자리를 다른 선수로 채우고 알려 줍니다', res2.notes?.join(' ') || '');
  ok(!pw.myLineup.starters.includes(goneP.id) && !pw.myLineup.starters.includes(hurtRef.pid), '이적·부상 선수는 선발에서 빠집니다');
  ok(pw.myLineup.starters.filter(Boolean).length === 11 && new Set(pw.myLineup.starters).size === 11, '선발 11명이 중복 없이 채워집니다');
  const gkSlot = FORMATIONS[pw.myLineup.formation].slots.findIndex((s) => s.pos === 'GK');
  ok(pw.players[pw.myLineup.starters[gkSlot]]?.pos === 'GK', '빈 골키퍼 자리는 다른 골키퍼로 채웁니다');

  /* 커스텀 → K리그 혼용·알 수 없는 값도 안전하게 */
  const klw = createWorld('geumsan', 20261215, { mode: 'kleague' });
  const cross = applyPreset(klw, preset);
  const klIds = new Set(squadOf(klw, 'geumsan').map((p) => p.id));
  ok(cross.ok && klw.myLineup.starters.filter(Boolean).length === 11 && klw.myLineup.starters.every((id) => !id || klIds.has(id)),
    '다른 모드(K리그)에 불러와도 ID·포지션 폴백으로 채워집니다', cross.notes?.join(' ') || '그대로');
  const broken = { ...preset, formation: '9-9-9', roles: preset.roles.map(() => 'no-such-role'), setpiece: null, training: 'x' };
  const res3 = applyPreset(klw, broken);
  ok(res3.ok && FORMATIONS[klw.myLineup.formation] && klw.myLineup.roles.every((r) => typeof r === 'string' && r.length > 1),
    '알 수 없는 포메이션·역할은 지금 값과 기본 역할로 안전하게') ;
  ok(overwritePreset(pw, readPresets().list[0].id).ok, '덮어쓰기가 됩니다');
  const delOk = deletePreset(readPresets().list[0].id);
  ok(delOk.ok && readPresets().list.length === 0, '삭제가 됩니다');

  /* ── (4) 수동 세이브 슬롯 ── */
  const sw = createWorld('gs', 20261216);
  playUserRounds(sw, 3);
  const s1 = saveSlot(0, sw);
  ok(s1.ok && s1.bytes < 400 * 1024, '슬롯 저장이 경량 형식으로 됩니다', s1.ok ? `${Math.round(s1.bytes / 1024)}KB` : s1.why);
  ok(SLOT_COUNT >= 3 && SLOT_COUNT <= 5, '수동 슬롯이 3~5개입니다', `${SLOT_COUNT}개`);
  const meta0 = readSlots().list[0].meta;
  ok(meta0.teamName === sw.teams[sw.myTeamId].name && meta0.season === seasonLabel(sw) && !!meta0.round && meta0.played > 0,
    '슬롯에 구단명·시즌·라운드·진행 경기가 표시됩니다', `${meta0.teamName} · ${meta0.season} · ${meta0.round} · ${meta0.played}경기`);
  const l0 = loadSlot(0);
  ok(l0.ok, '슬롯에서 불러오기가 됩니다');
  const lw = l0.world;
  ok(!!lw && lw.myTeamId === sw.myTeamId && Object.keys(lw.players).length === Object.keys(sw.players).length, '선수단 구성이 그대로 복원됩니다');
  ok(JSON.stringify(standings(lw)) === JSON.stringify(standings(sw)), '순위표(승점·득실)가 그대로 복원됩니다');
  ok(JSON.stringify(lw.myLineup) === JSON.stringify(sw.myLineup), '라인업·전술이 그대로 복원됩니다');
  const sp = squadOf(sw, sw.myTeamId)[0];
  ok(JSON.stringify(lw.players[sp.id].stats) === JSON.stringify(sp.stats) && lw.players[sp.id].season.apps === sp.season.apps && lw.players[sp.id].ovr === sp.ovr,
    '선수 능력치·시즌 기록이 그대로 복원됩니다', `${sp.name} ${sp.ovr}`);
  ok(lw.calendar.filter((r) => r.played).length === sw.calendar.filter((r) => r.played).length, '진행한 라운드가 그대로 복원됩니다');
  ok(!!lw.cup.stages.length, '코리아컵 대진도 그대로 복원됩니다');
  // 여러 슬롯
  saveSlot(1, lw);
  ok(readSlots().list.filter(Boolean).length === 2, '여러 슬롯에 따로 저장됩니다');
  ok(deleteSlot(1).ok && readSlots().list[1] === null, '슬롯을 지울 수 있습니다');
  // 용량 초과
  setSlotStore(fullStore());
  const bad = saveSlot(2, sw);
  ok(!bad.ok && /저장 공간/.test(bad.why || ''), '저장 공간이 모자라면 이유를 돌려줍니다', bad.why || '');
  setSlotStore(slotStore);

  /* ── (5) JSON 내보내기 / 파일에서 불러오기 ── */
  const payload = exportPayload(sw);
  const json = JSON.stringify(payload);
  const back = parseSaveFile(json);
  ok(back.ok && back.world.myTeamId === sw.myTeamId && JSON.stringify(standings(back.world)) === JSON.stringify(standings(sw)),
    'JSON 으로 내보낸 세이브를 다시 읽어도 그대로입니다', `${Math.round(json.length / 1024)}KB`);
  ok(/^fm-.+\.json$/.test(exportFileName(sw)), '내보내기 파일 이름이 구단·시즌을 담습니다', exportFileName(sw));
  const legacy = parseSaveFile(JSON.stringify(JSON.parse(JSON.stringify(sw))));
  ok(legacy.ok, '예전 형식(세계 객체 그대로) 파일도 읽습니다');
  ok(!parseSaveFile('이건 JSON 이 아님').ok && !parseSaveFile('{"a":1}').ok && !parseSaveFile('').ok, '잘못된 파일은 거절합니다');

  /* ── (6) 로고 → 앱 안 첫 화면 ── */
  const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
  const markTag = (html.match(/<a class="mark"[^>]*>/) || [''])[0];
  ok(/data-act="home"/.test(markTag) && !/href="https?:\/\/bmrgoodway/.test(markTag),
    '메인 로고가 외부 허브로 나가지 않고 앱 첫 화면을 열게 되어 있습니다', markTag.slice(0, 90));

  /* ── (7) 화면 ── */
  const hap = { world: sw, savedGame: sw, defs: Object.fromEntries([...TEAM_DEFS.map((t) => [t.id, t]), ...KL_TEAMS.map((t) => [t.id, t])]), state: { tab: 'schedule', pickMode: 'custom', pickDiv: 1, divTab: 1, posFilter: 'ALL', sortKey: 'ovr', sortDir: -1, marketDiv: 0, seasonPhase: 'preview', seasonResult: null, selSlot: null, selPid: null } };
  let hub2 = '';
  try { hub2 = renderHub(hap); } catch (e) { hub2 = 'ERR ' + e.message; }
  ok(hub2.includes('data-act="saves"') && hub2.includes('저장/불러오기'), '허브에 저장/불러오기 버튼이 있습니다');
  const sched = hap.state.tab;
  hap.state.tab = 'squad';
  let sq = '';
  try { sq = renderHub(hap); } catch (e) { sq = 'ERR ' + e.message; }
  ok(sq.includes('전술·명단 프리셋') && sq.includes('data-act="preset-save"'), '전술/선수단 탭에 프리셋 UI가 그려집니다', sq.startsWith('ERR') ? sq : `${sq.length}자`);
  hap.state.tab = sched;
  const playedRound = sw.calendar.find((r) => r.type === 'league' && r.played);
  const pf = playedRound.fixtures.find((f) => f.home === sw.myTeamId || f.away === sw.myTeamId) || playedRound.fixtures[0];
  let mm2 = '';
  try { mm2 = renderModal({ ...hap, state: { ...hap.state, modal: { kind: 'match', round: playedRound.no, home: pf.home, away: pf.away, back: null } } }); } catch (e) { mm2 = 'ERR ' + e.message; }
  ok(mm2.includes('득점 장면') && mm2.includes('출전 선수 평점'), '이전 경기 결과 모달이 득점·기록·평점을 그립니다', mm2.startsWith('ERR') ? mm2 : `${mm2.length}자`);
  const aiPf = playedRound.fixtures.find((f) => f.home !== sw.myTeamId && f.away !== sw.myTeamId);
  let am = '';
  try { am = renderModal({ ...hap, state: { ...hap.state, modal: { kind: 'match', round: playedRound.no, home: aiPf.home, away: aiPf.away, back: null } } }); } catch (e) { am = 'ERR ' + e.message; }
  ok(am.includes('득점 장면') && am.includes('빠른 시뮬레이션'), '다른 구단끼리 경기도 같은 모달로 열립니다', am.startsWith('ERR') ? am : `${am.length}자`);
  let sm2 = '';
  try { sm2 = renderModal({ ...hap, state: { ...hap.state, modal: { kind: 'saves' } } }); } catch (e) { sm2 = 'ERR ' + e.message; }
  ok(sm2.includes('slot-list') && sm2.includes('JSON 파일로 내보내기') && sm2.includes('파일에서 불러오기'), '저장/불러오기 모달이 슬롯·파일 버튼을 그립니다', sm2.startsWith('ERR') ? sm2 : `${sm2.length}자`);
  const oppTeam = Object.keys(sw.teams).find((id) => id !== sw.myTeamId);
  let cm2 = '';
  try { cm2 = renderModal({ ...hap, state: { ...hap.state, modal: { kind: 'club', team: oppTeam } } }); } catch (e) { cm2 = 'ERR ' + e.message; }
  ok(cm2.includes('경기 결과') && cm2.includes('data-act="match"'), '타 구단 모달에 경기 결과 목록이 그려집니다', cm2.startsWith('ERR') ? cm2 : `${cm2.length}자`);
  let pd = '';
  try { pd = renderModal({ ...hap, state: { ...hap.state, modal: { kind: 'preset-delete', id: 'x' } } }); } catch (e) { pd = 'ERR ' + e.message; }
  ok(pd === '' || !pd.startsWith('ERR'), '없는 프리셋 삭제 요청은 빈 화면으로 안전하게 처리됩니다');

  /* 지난 경기 줄이 실제로 눌러지는지 (일정 탭 HTML) */
  hap.state.tab = 'schedule';
  let schedHtml = '';
  try { schedHtml = renderHub(hap); } catch (e) { schedHtml = 'ERR ' + e.message; }
  ok(/data-act="match" data-round="\d+"/.test(schedHtml), '일정 탭의 치른 경기 행이 클릭 대상(data-act=match)으로 그려집니다');

  setLogStore(null); setSlotStore(null); setPresetStore(null);
}

/* ── 29. K리그 2026 장기 밸런스 — 12시즌 연속 시뮬레이션 ── */
console.log('\n[29] K리그 장기 밸런스 — 12시즌 시뮬레이션 · 유스 아카데미 · 이적 위계');
{
  const SEASONS = 12;
  const lw = createWorld('geumsan', 20261123, { mode: 'kleague' });
  const startDiv = Object.fromEntries(Object.entries(lw.teams).map(([id, t]) => [id, t.div]));
  const startK1 = Object.keys(startDiv).filter((id) => startDiv[id] === 1);

  /* 내 경기까지 빠른 시뮬로 채워 한 시즌을 끝까지 치릅니다 (앱의 '즉시 결과'와 같은 경로). */
  const playAll = (w) => {
    let guard = 0;
    let changed = true;
    while (changed && guard < 500) {
      changed = false;
      for (const r of w.calendar) {
        if (r.played) continue;
        if (r.type === 'cup') {
          if (!w.cup.stages[r.stage]) {
            if (r.stage > 0 && !w.cup.stages[r.stage - 1]) continue;
            buildCupStage(w, r.stage);
          }
          const st = w.cup.stages[r.stage];
          if (!st) continue;
          for (const m of st.matches) {
            if (m.played) continue;
            const res = simMatchQuick(w, m.home, m.away, { stamp: `s${r.stage}` });
            let hg = res.hg, ag = res.ag;
            const draw = hg === ag;
            if (draw) hg += 1;
            m.played = true; m.hg = hg; m.ag = ag; m.aet = draw; m.winner = hg > ag ? m.home : m.away;
          }
          r.played = st.matches.every((m) => m.played);
          finishRound(w, r);
        } else {
          for (const f of r.fixtures) {
            if (f.played) continue;
            const res = simMatchQuick(w, f.home, f.away, { stamp: `s${r.no}` });
            f.played = true; f.hg = res.hg; f.ag = res.ag;
          }
          r.played = r.fixtures.every((f) => f.played);
          if (r.played) finishRound(w, r);
        }
        changed = true;
      }
      guard += 1;
    }
  };
  const divAvg = (w) => Object.fromEntries(divisionsOf(w).map((d) => [d.id,
    d.teams.reduce((a, id) => a + teamPower(w, id), 0) / d.teams.length]));

  const rows = [];
  for (let i = 0; i < SEASONS; i++) {
    playAll(lw);
    const d = divAvg(lw);
    const table = standingsFor(lw, 1);
    rows.push({ year: lw.year, d, kept: startK1.filter((id) => divOf(lw, id) === 1).length, champ: table[0]?.id });
    advanceSeason(lw);
  }
  const s10 = rows[9];
  const s12 = rows[11];
  ok(lw.year === 2026 + SEASONS && Object.keys(lw.teams).length === 56,
    'K리그 2026을 12시즌 연속 시뮬레이션합니다', `${rows[0].year}~${s12.year} · 구단 ${Object.keys(lw.teams).length}개 유지`);
  ok(s10.kept >= 6, '10시즌 뒤 초기 K1 12개 구단 중 절반 이상이 K1에 남아 있습니다', `${s10.kept}/12`);
  ok(s12.kept >= 6, '12시즌 뒤에도 초기 K1 구단 다수가 K1에 남아 있습니다', `${s12.kept}/12`);

  const order = (d) => d[1] > d[2] && d[2] > d[3] && d[3] > d[4];
  const ordered = rows.slice(2).every((r) => order(r.d));
  ok(ordered, '12시즌 내내 디비전 평균 전력 위계(K1 > K2 > K3 > K4)가 유지됩니다',
    rows.map((r) => [1, 2, 3, 4].map((d) => r.d[d].toFixed(0)).join('>')).join(' / '));
  const gap = (d, a, b) => d[a] - d[b];
  ok(gap(s10.d, 1, 2) >= 5 && gap(s10.d, 2, 3) >= 3 && gap(s10.d, 3, 4) >= 1,
    '10시즌 뒤에도 디비전 격차가 남아 있습니다',
    `K1 ${s10.d[1].toFixed(1)} · K2 ${s10.d[2].toFixed(1)} · K3 ${s10.d[3].toFixed(1)} · K4 ${s10.d[4].toFixed(1)} (격차 ${gap(s10.d, 1, 2).toFixed(1)}/${gap(s10.d, 2, 3).toFixed(1)}/${gap(s10.d, 3, 4).toFixed(1)})`);
  ok(s12.d[1] >= 64, '10시즌이 지나도 K1 평균 전력이 표류하지 않습니다', `12시즌째 K1 평균 ${s12.d[1].toFixed(1)}`);
  const k1Champs = rows.filter((r) => startDiv[r.champ] === 1).length;
  ok(k1Champs >= 9, '우승은 대부분 초기 K1 구단에서 나옵니다 (4부 출신의 돌풍은 드물게만)',
    `12시즌 중 ${k1Champs}회 · 마지막 우승 ${lw.teams[rows[11].champ]?.short || '—'}`);

  /* 유스 아카데미 — 디비전이 높을수록 신인 OVR·잠재력 상한이 높습니다 */
  const acad = [1, 2, 3, 4].map((d) => KL_ACADEMY[d]);
  ok(acad.every((g, i) => i === 0 || (g.base < acad[i - 1].base && g.pot < acad[i - 1].pot)),
    '디비전별 유스 아카데미 등급(신인 OVR·잠재 상한)이 차등됩니다',
    acad.map((g, i) => `K${i + 1} ${g.base}~${g.hi}/잠재 ${g.pot}`).join(' · '));
  const fresh = createWorld('seoul', 20261126, { mode: 'kleague' });
  const acK1 = academyOf(fresh, 'seoul'), acK4 = academyOf(fresh, 'geumsan');
  ok(acK1.pot >= 85 && acK4.pot <= 70 && acK1.pot - acK4.pot >= 15,
    '명문 구단 유스와 하위 리그 구단 유스의 잠재 상한이 다릅니다',
    `FC 서울(K1) ${acK1.base}~${acK1.hi}/잠재 ${acK1.pot} vs 금산 인삼(K4) ${acK4.base}~${acK4.hi}/잠재 ${acK4.pot}`);

  /* 실제로 들어온 유스의 차이 — 시즌을 마친 구단에서 3명씩 빼고 다음 시즌을 열어 봅니다 */
  const beforeIds = new Set(Object.keys(lw.players));
  const k1Club = rows[11].champ;
  const k4Table = standingsFor(lw, 4);
  const k4Club = k4Table[k4Table.length - 1]?.id;
  const trim = (id) => {
    const sq = squadOf(lw, id).slice().sort((a, b) => a.ovr - b.ovr);
    const cut = sq.slice(0, Math.max(3, sq.length - 17));
    lw.teams[id].squad = lw.teams[id].squad.filter((pid) => !cut.some((p) => p.id === pid));
    for (const p of cut) delete lw.players[p.id];
  };
  trim(k1Club); trim(k4Club);
  advanceSeason(lw);
  const youth = (id) => squadOf(lw, id).filter((p) => !beforeIds.has(p.id));
  const avgOf = (arr, k) => arr.reduce((a, p) => a + p[k], 0) / Math.max(1, arr.length);
  const y1 = youth(k1Club), y4 = youth(k4Club);
  ok(y1.length > 0 && y4.length > 0 && avgOf(y1, 'ovr') >= avgOf(y4, 'ovr') + 10 && avgOf(y1, 'pot') >= avgOf(y4, 'pot') + 10,
    '같은 시즌에 들어온 유스라도 K1 구단이 K4 구단보다 훨씬 좋은 자원을 받습니다',
    `K1 ${y1.map((p) => `${p.ovr}/${p.pot}`).join(',')} vs K4 ${y4.map((p) => `${p.ovr}/${p.pot}`).join(',')}`);
  ok(y4.every((p) => p.pot <= Math.max(KL_ACADEMY[4].pot, p.ovr + 2) + 6),
    'K4 유스의 잠재력은 K4 아카데미 상한을 넘지 않습니다', `K4 유스 잠재 최고 ${Math.max(...y4.map((p) => p.pot))}`);

  /* 이적 피라미드 — 상위 디비전이 하위 디비전의 주전(상위 13명)을 데려가지 않습니다 */
  const tw = createWorld('geumsan', 20261124, { mode: 'kleague' });
  let total = 0, down = 0, violations = 0, upProspects = 0;
  for (let no = 1; no <= 36; no++) {
    const top13 = Object.fromEntries(Object.keys(tw.teams).map((id) => [id,
      new Set(squadOf(tw, id).slice().sort((a, b) => b.ovr - a.ovr).slice(0, 13).map((p) => p.id))]));
    for (const e of aiTransferRound(tw, { no })) {
      total += 1;
      const fd = divOf(tw, e.from), td = divOf(tw, e.to);
      if (td > fd) { down += 1; if (top13[e.from].has(e.pid)) violations += 1; }
      const p = tw.players[e.pid];
      if (td < fd && fd >= 3 && td <= 2 && p && p.age <= 23) upProspects += 1;
    }
  }
  ok(total > 0 && violations === 0, '상위 디비전이 하위 디비전으로 주전(상위 13명)을 팔지 않습니다',
    `이적 ${total}건 · 하향 ${down}건 · 위반 ${violations}건`);
  ok(upProspects >= 1, 'K1·K2 구단이 K3·K4의 젊은 유망주를 데려오는 이적이 있습니다', `${upProspects}건`);

  /* AI 세대교체 — 12시즌을 지나도 선수단이 늙어붙지 않습니다 */
  const ages = Object.values(lw.teams).filter((t) => t.id !== lw.myTeamId).map((t) => {
    const sq = squadOf(lw, t.id);
    return { n: sq.length, avg: sq.reduce((a, p) => a + p.age, 0) / Math.max(1, sq.length), old: sq.filter((p) => p.age >= 32).length };
  });
  const worst = ages.slice().sort((a, b) => b.avg - a.avg)[0];
  ok(ages.every((x) => x.n >= 20), 'AI 구단 선수단은 20명 아래로 줄지 않습니다', `최소 ${Math.min(...ages.map((x) => x.n))}명`);
  ok(worst.avg <= 31, 'AI 구단 평균 나이가 31세를 넘지 않습니다 (세대교체)',
    `최고 ${worst.avg.toFixed(1)}세 · 전체 평균 ${(ages.reduce((a, x) => a + x.avg, 0) / ages.length).toFixed(1)}세 · 32세 이상 최다 ${Math.max(...ages.map((x) => x.old))}명`);
  ok(lw.news.some((n) => n.text.includes('개막.')) && !lw.news.some((n) => n.text.includes('개꾸')),
    "새 시즌 소식의 오타('개꾸'→'개막')가 고쳐졌습니다", lw.news.map((n) => n.text).find((t) => t.includes('개막')) || '');
}


/* ── 30) 커스텀 매치업 — 팀 빌더·공유 코드·풋살(5·6인제) 경기 ───────────── */
{
  console.log('\n[30] 커스텀 매치업 — 팀 빌더 · 공유 코드 · 풋살(5·6인제) 경기');

  /* 규모별 포메이션 — 11인제는 기존 7종, 풋살은 5인제 2종·6인제 2종 */
  ok(formationsFor(11).length === 7 && formationsFor(5).join(',') === '1-2-1,2-2' && formationsFor(6).join(',') === '1-2-2,1-3-1',
    '규모별 포메이션 목록이 맞습니다', `11인제 ${formationsFor(11).length}종 · 5인제 ${formationsFor(5).join('·')} · 6인제 ${formationsFor(6).join('·')}`);
  ok(FORMATS.length === 3 && FORMATS.map((f) => f.name).join(' / ') === '11인제 / 6인제 풋살 / 5인제 풋살',
    '경기 규모 3가지가 정의됩니다', FORMATS.map((f) => `${f.name}(${f.size}명)`).join(' · '));
  ok(sizeOfFormation('4-3-3') === 11 && sizeOfFormation('1-2-1') === 5 && sizeOfFormation('1-2-2') === 6,
    '포메이션에서 규모를 읽습니다');

  /* 새 팀 — 자리 수·포메이션 */
  const t11 = newTeam({ size: 11, name: '점검 FC' });
  ok(t11.players.length === 11 && t11.formation === '4-3-3' && t11.players.every((p) => p.slot),
    '11인제 팀은 11자리로 시작합니다', `${t11.formation} · ${t11.players.map((p) => p.slot).join(',')}`);

  /* OVR 한 칸 → 포지션별 세부 능력치 자동 배분 */
  setPlayerName(t11, 0, '테스트 키퍼');
  setPlayerOvr(t11, 0, 75);
  const gk0 = t11.players[0];
  ok(gk0.stats && gk0.stats.gk >= 78 && gk0.stats.gk > gk0.stats.sho, '골키퍼 OVR 75 → GK 능력치가 높게 배분됩니다', `gk ${gk0.stats.gk} · 슈팅 ${gk0.stats.sho}`);
  ok(Math.abs(ovrOf(t11, gk0) - 75) <= 2, 'OVR 입력값이 종합으로 다시 계산됩니다', `${ovrOf(t11, gk0)}`);

  /* 세부 능력치를 직접 고치면 OVR이 따라 움직입니다 */
  const beforeOvr = ovrOf(t11, gk0);
  setPlayerStat(t11, 0, 'gk', 40);
  ok(ovrOf(t11, gk0) < beforeOvr, '세부 능력치를 낮추면 OVR도 내려갑니다', `${beforeOvr} → ${ovrOf(t11, gk0)}`);
  setPlayerOvr(t11, 0, 75);

  /* 빈 자리 자동 채우기 */
  const added = autoFill(t11);
  ok(added.length === 10 && t11.players.every((p) => p.name && p.stats), '빈 자리를 기본 선수로 채웁니다', `${added.length}명 추가`);
  ok(teamPowerOf(t11) >= 55 && teamPowerOf(t11) <= 85, '팀 전력이 합리적인 범위입니다', `${teamPowerOf(t11)}`);

  /* 빠른 일괄 입력 */
  const parsed = parseBulk('김철수 ST 84\n이영희,CB,79\n박민수 74\n\n잘못된줄 999');
  ok(parsed.rows.length === 3 && parsed.errors.length === 1, '이름·포지션·OVR 일괄 입력을 읽습니다', `${parsed.rows.map((r) => `${r.name}/${r.label || '자동'}/${r.ovr ?? 'OVR없음'}`).join(' · ')}`);
  const tb = newTeam({ size: 11, name: '일괄 입력' });
  const filled = applyBulk(tb, parsed.rows);
  ok(filled === 3 && tb.players.filter((p) => p.name).length === 3, '일괄 입력이 빈 자리에 차례로 들어갑니다', `${filled}명`);
  const striker = tb.players.find((p) => p.name === '김철수');
  ok(striker && striker.slot === 'ST' && Math.abs(ovrOf(tb, striker) - 84) <= 3, '포지션 자리에 맞춰 넣고 OVR을 맞춥니다', `${striker?.slot} · ${striker ? ovrOf(tb, striker) : ''}`);

  /* 포메이션·규모 바꾸기 */
  const t5 = newTeam({ size: 5, name: '별무리 풋살단' });
  autoFill(t5, { level: 70 });
  ok(t5.players.length === 5 && t5.formation === '1-2-1', '5인제 팀은 5자리(1-2-1)로 시작합니다', t5.formation);
  setTeamFormation(t5, '2-2');
  ok(t5.players.length === 5 && t5.formation === '2-2', '5인제 안에서 포메이션을 바꿉니다', t5.players.map((p) => p.slot).join(','));
  const t6 = newTeam({ size: 6, name: '별무리 6인' });
  autoFill(t6);
  ok(t6.players.length === 6 && t6.formation === '1-2-2', '6인제 팀은 6자리(1-2-2)로 시작합니다', t6.formation);
  setSize(t5, 11);
  ok(t5.players.length === 11 && t5.size === 11, '규모를 11인제로 키우면 자리도 11개가 됩니다', `${t5.formation} · ${t5.players.length}명`);
  setSize(t5, 5);
  ok(t5.players.length === 5 && t5.size === 5, '다시 5인제로 줄입니다', `${t5.formation} · ${t5.players.length}명`);

  /* 공유 코드 — 링크에 담는 긴 코드 왕복 */
  const packed = packTeam(t5);
  const longCode = encodePayload(packed);
  const back = unpackTeam(decodePayload(longCode));
  ok(back && back.size === 5 && back.formation === t5.formation && back.players.length === 5
    && back.players[0].name === t5.players[0].name && back.colors.primary === t5.colors.primary,
    '링크용 긴 코드로 팀이 그대로 복원됩니다', `${longCode.length}자`);
  ok(longCode.length < 4000, '긴 코드는 URL에 담을 수 있는 길이입니다', `${longCode.length}자`);
  ok(decodePayload('Z아무거나') === null, '망가진 코드는 null 로 안전하게 처리합니다');

  /* 5인제 커스텀 vs 커스텀 — 엔진이 5명으로 끝까지 진행 */
  const a5 = newTeam({ size: 5, name: '별무리 풋살' });
  autoFill(a5, { level: 70 });
  const b5 = newTeam({ size: 5, name: '친구 풋살' });
  autoFill(b5, { level: 70 });
  const career = createWorld('gs', 20261126);
  const careerBefore = JSON.stringify(career);
  const bu = buildMatchupWorld({ home: { kind: 'custom', team: a5 }, away: { kind: 'custom', team: b5 }, seed: 'cm-5', mySide: 'home' });
  ok(!!bu && bu.size === 5 && bu.homeLineup.starters.length === 5 && bu.awayLineup.starters.length === 5,
    '5인제 매치업 세계를 만듭니다', `${bu?.world.teams[bu.homeId].name} vs ${bu?.world.teams[bu.awayId].name}`);
  const m5 = new Match({ world: bu.world, homeId: bu.homeId, awayId: bu.awayId, homeLineup: bu.homeLineup, awayLineup: bu.awayLineup, seed: 'cm-5', userSide: 'home' });
  m5.holdHalf = false;
  let g5 = 0;
  while (!m5.done && g5 < 8000) { m5.tick(); g5 += 1; }
  ok(m5.done && g5 < 8000, '5인제 경기가 90분을 끝까지 진행합니다', `${m5.score.home}-${m5.score.away} · ${g5}틱`);
  ok(m5.sides.home.players.filter((e) => e.onPitch).length === 5 && m5.sides.away.players.filter((e) => e.onPitch).length === 5,
    '5인제 경기 내내 양 팀 5명이 필드에 있습니다');
  ok(['home', 'away'].every((s) => m5.sides[s].players.every((e) => Number.isFinite(e.x) && Number.isFinite(e.y) && e.x >= -1 && e.x <= 101)),
    '모든 선수 좌표가 피치 안의 유한한 값입니다');
  const s5 = m5.stats();
  ok(m5.offsideOn === false && s5.offsides.home + s5.offsides.away === 0, '풋살 경기에는 오프사이드가 없습니다', `오프사이드 ${s5.offsides.home + s5.offsides.away}`);
  ok((s5.shots.home + s5.shots.away) > 0 && (m5.score.home + m5.score.away) < 20, '5인제 경기에 슈팅·득점이 자연스럽게 나옵니다', `슈팅 ${s5.shots.home + s5.shots.away} · 득점 ${m5.score.home + m5.score.away}`);
  ok(s5.passes.home + s5.passes.away > 20, '5인제에서도 패스가 이어집니다', `패스 성공 ${s5.passes.home + s5.passes.away}`);

  /* 결과 요약·공유 텍스트 */
  const sum5 = matchSummary(m5);
  ok(sum5.mom && sum5.mom.rating >= 4.2 && sum5.mom.rating <= 10, '결과 요약이 MOM을 뽑습니다', `${sum5.mom?.e.name} ${sum5.mom?.rating}`);
  const txt = resultText({ size: 5 }, m5);
  ok(txt.includes('별무리 풋살') && txt.includes(`${m5.score.home}-${m5.score.away}`) && /5인제 풋살/.test(txt),
    '결과 텍스트에 팀·스코어·규모가 들어갑니다', txt.split('\n')[0]);

  /* 퇴장 — 5인제는 3명 밑으로 떨어질 때만 끝납니다 */
  const bu2 = buildMatchupWorld({ home: { kind: 'custom', team: a5 }, away: { kind: 'custom', team: b5 }, seed: 'cm-red', mySide: 'home' });
  const mRed = new Match({ world: bu2.world, homeId: bu2.homeId, awayId: bu2.awayId, homeLineup: bu2.homeLineup, awayLineup: bu2.awayLineup, seed: 'cm-red', userSide: 'home' });
  mRed.sides.home.players.slice(1, 3).forEach((e) => mRed.sendOff(e, 'red'));
  ok(!mRed.done && mRed.sides.home.players.filter((e) => e.onPitch).length === 3, '5인제에서 두 명이 퇴장해도 3명으로 계속합니다', `남은 인원 ${mRed.sides.home.players.filter((e) => e.onPitch).length}`);
  mRed.sendOff(mRed.sides.home.players.filter((e) => e.onPitch)[0], 'red');
  ok(mRed.done, '3명 미만이 되면 경기를 멈춥니다');

  /* 5인제 커스텀 vs K리그 구단 — 그 구단에서 5명만 추려 5:5 */
  const bkl = buildMatchupWorld({ home: { kind: 'custom', team: a5 }, away: { kind: 'kl', id: 'geumsan' }, seed: 'cm-kl', mySide: 'home' });
  ok(!!bkl && bkl.awayLineup.starters.length === 5 && ['1-2-1', '2-2'].includes(bkl.world.teams[bkl.awayId].formation),
    'K리그 구단도 풋살 규모(5명)로 나옵니다', `${bkl?.world.teams[bkl.awayId].name} · ${bkl?.world.teams[bkl.awayId].formation}`);
  const mkl = new Match({ world: bkl.world, homeId: bkl.homeId, awayId: bkl.awayId, homeLineup: bkl.homeLineup, awayLineup: bkl.awayLineup, seed: 'cm-kl', userSide: 'home' });
  mkl.holdHalf = false;
  let gkl = 0;
  while (!mkl.done && gkl < 8000) { mkl.tick(); gkl += 1; }
  ok(mkl.done, '커스텀 5인제 팀 vs K리그 구단 경기가 끝까지 진행합니다', `${mkl.score.home}-${mkl.score.away}`);
  ok(mkl.sides.away.players.filter((e) => e.onPitch).length === 5, 'K리그 쪽도 5명이 필드에 있습니다');

  /* 11인제 커스텀 vs 커스텀 — 오프사이드는 그대로 켜집니다 */
  const c11a = newTeam({ size: 11, name: '커스텀 A' }); autoFill(c11a);
  const c11b = newTeam({ size: 11, name: '커스텀 B' }); autoFill(c11b);
  const b11 = buildMatchupWorld({ home: { kind: 'custom', team: c11a }, away: { kind: 'custom', team: c11b }, seed: 'cm-11', mySide: 'away' });
  ok(b11 && b11.homeLineup.starters.length === 11 && b11.world.myTeamId === b11.awayId,
    '11인제 매치업은 11명·원정 선택이 그대로입니다');
  const m11 = new Match({ world: b11.world, homeId: b11.homeId, awayId: b11.awayId, homeLineup: b11.homeLineup, awayLineup: b11.awayLineup, seed: 'cm-11', userSide: 'away' });
  ok(m11.offsideOn === true, '11인제 경기는 오프사이드 판정이 켜집니다');

  /* 세트피스 지시가 경기 라인업까지 전달됩니다 */
  const spTeam = newTeam({ size: 5, name: '세트피스 점검' });
  autoFill(spTeam, { level: 70 });
  setTeamSetPiece(spTeam, 'corner', 'near');
  setTeamSetPiece(spTeam, 'freekick', 'box');
  const bsp = buildMatchupWorld({ home: { kind: 'custom', team: spTeam }, away: { kind: 'kl', id: 'seoul' }, seed: 'cm-sp', mySide: 'home' });
  ok(bsp?.homeLineup.setpiece.corner === 'near' && bsp?.homeLineup.setpiece.freekick === 'box',
    '커스텀 팀의 코너·프리킥 지시가 경기 라인업에 들어갑니다', `코너 ${bsp?.homeLineup.setpiece.corner} · 프리킥 ${bsp?.homeLineup.setpiece.freekick}`);

  /* 커리어 세이브는 그대로 */
  ok(JSON.stringify(career) === careerBefore, '커스텀 매치업이 커리어 세이브(세계)를 건드리지 않습니다');
}

console.log(`\n${fails ? `❌ ${fails}개 점검 실패` : '✅ 모든 점검 통과'}\n`);
process.exit(fails ? 1 : 0);
