// 세계(커리어) 상태 — 저장·일정·순위·컵·이적·시즌 진행
import { local } from './store.js';
import { makeRng, rint, pick, clamp, gauss, shuffle } from './rng.js';
import { TEAM_DEFS, FORMATIONS, FORMATION_IDS, overall, valueOf, wageOf, buildSquad, freshSeasonStats, STAT_KEYS } from './data.js';
import { defaultRoles, resolveRoles, roleFor, resolveSetPiece } from './tactics.js';

export const SAVE_KEY = 'career';
export const SAVE_VERSION = 1;

/* ─────────────────────────── 유틸 ─────────────────────────── */
const sum = (a) => a.reduce((x, y) => x + y, 0);
const clone = (v) => JSON.parse(JSON.stringify(v));

export function myTeam(w) { return w.teams[w.myTeamId]; }
/* 화면이 '내 팀의 전술'을 물을 때 쓰는 단일 출처 — 팀 기본값이 아니라 감독이 저장한 라인업입니다. */
export function mySetup(w) {
  const l = w.myLineup || {};
  return {
    formation: l.formation || myTeam(w).formation,
    tactic: { line: 0, pass: 0, press: 0, route: 0, mentality: 0, ...(l.tactic || {}) },
    roles: Array.isArray(l.roles) ? l.roles : [],
    setpiece: resolveSetPiece(l.setpiece),
  };
}
export function player(w, id) { return w.players[id]; }
export function squadOf(w, teamId) {
  const t = w.teams[teamId];
  if (!t) return [];
  return t.squad.map((id) => w.players[id]).filter(Boolean);
}
export function teamWageTotal(w, teamId) {
  return sum(squadOf(w, teamId).map((p) => p.wage));
}
export function teamPower(w, teamId) {
  const sq = squadOf(w, teamId);
  if (!sq.length) return 50;
  const top = sq.map((p) => p.ovr).sort((a, b) => b - a).slice(0, 11);
  return Math.round(sum(top) / top.length);
}

// 출전 가능 여부 — 퇴장 누적 정지(bans)나 부상(inj) 중이면 뛰지 못합니다.
export function available(w, p) {
  return !!p && !(p.bans > 0) && !(p.inj > 0);
}
export function ifUnavailable(p) {
  if (!p) return '';
  if (p.bans > 0) return `정지 ${p.bans}경기`;
  if (p.inj > 0) return `부상 ${p.inj}경기`;
  return '';
}

// 포지션 불일치 보정
export function posFactor(slotPos, playerPos) {
  if (slotPos === playerPos) return 1;
  if (slotPos === 'GK' || playerPos === 'GK') return 0.55;
  const order = { DF: 0, MF: 1, FW: 2 };
  const d = Math.abs(order[slotPos] - order[playerPos]);
  return d === 1 ? 0.88 : 0.72;
}

export function lineupInfo(w) {
  const l = w.myLineup;
  const slots = FORMATIONS[l.formation].slots;
  const roles = resolveRoles(l.roles, slots);
  const stat = { slots: [], valid: true, missing: 0, roles };
  l.starters.forEach((pid, i) => {
    const p = pid ? w.players[pid] : null;
    const slot = slots[i];
    if (!p) { stat.missing += 1; stat.valid = false; stat.slots.push({ slot, p: null, factor: 0, role: roles[i] }); return; }
    const f = posFactor(slot.pos, p.pos);
    stat.slots.push({ slot, p, factor: f, role: roles[i] });
  });
  stat.bench = l.bench.map((id) => w.players[id]).filter(Boolean);
  stat.attack = Math.round(sum(stat.slots.filter((s) => s.p).map((s) => (s.p.stats.sho * 0.4 + s.p.stats.dri * 0.3 + s.p.stats.pas * 0.3) * s.factor)) / 11);
  return stat;
}

/* ─────────────────────────── 새 커리어 ─────────────────────────── */
export function createWorld(teamId, seed = Date.now()) {
  const rng = makeRng(String(seed));
  const usedNames = new Set();
  const w = {
    version: SAVE_VERSION, seed, season: 1, myTeamId: teamId,
    teams: {}, players: {}, calendar: [], cup: { stages: [] },
    myLineup: null, market: [], history: [], news: [], finance: { income: 0, spent: 0 },
    pidSeq: 1, createdAt: Date.now(), form: {},
    // 4단계 — 성장 기록·AI 이적·영입 오퍼·임대
    offers: [], offerSeq: 1, loans: [], transfers: [], lastGrowth: null,
  };
  for (const def of TEAM_DEFS) {
    const squad = buildSquad(rng, { ...def, power: def.power }, usedNames);
    w.teams[def.id] = {
      ...clone(def), squad: squad.map((p) => p.id), recent: [], training: 'balanced',
    };
    for (const p of squad) {
      p.id = `p${w.pidSeq++}`;
      p.teamId = def.id;
      p.pot = clamp(p.ovr + rint(rng, 0, p.age <= 23 ? 14 : p.age <= 27 ? 7 : 2), p.ovr, 97);
      p.season = freshSeasonStats();
      p.career = { apps: 0, goals: 0, assists: 0, seasons: 0 };
      p.growthLog = [];
      w.players[p.id] = p;
    }
    // 팀 내 등번호·id 재정리
    w.teams[def.id].squad = squad.map((p) => p.id);
    w.teams[def.id].powerNow = teamPower(w, def.id);
    // 주급 예산은 실제 선수단 주급에 여유를 더해 잡는다
    w.teams[def.id].wage = Math.round((teamWageTotal(w, def.id) * 1.15) / 100) * 100;
  }
  buildCalendar(w);
  buildCupStage(w, 0);
  w.myLineup = autoLineup(w, teamId, w.teams[teamId].formation);
  w.market = buildMarket(w);
  addNews(w, `${w.teams[teamId].name} 감독으로 취임했습니다. ${w.season}시즌 리그가 시작됩니다.`);
  return w;
}

/* ─────────────────────────── 일정 ─────────────────────────── */
function roundRobin(ids, rng) {
  const arr = shuffle(rng, ids);
  const n = arr.length;
  const first = [];
  for (let r = 0; r < n - 1; r++) {
    const pairs = [];
    for (let i = 0; i < n / 2; i++) {
      const a = arr[i], b = arr[n - 1 - i];
      pairs.push((r + i) % 2 === 0 ? { home: a, away: b } : { home: b, away: a });
    }
    first.push(pairs);
    arr.splice(1, 0, arr.pop());
  }
  const second = first.map((pairs) => pairs.map((p) => ({ home: p.away, away: p.home })));
  return [...first, ...second];
}

const CUP_SLOTS = [4, 9, 14, 20]; // 캘린더에서 컵 경기가 들어가는 순번

export function buildCalendar(w) {
  const rng = makeRng(`cal-${w.seed}-${w.season}`);
  const ids = Object.keys(w.teams);
  const rounds = roundRobin(ids, rng);
  const cal = [];
  let no = 0;
  for (let i = 0; i < rounds.length; i++) {
    if (CUP_SLOTS.includes(no + 1)) {
      cal.push({ no: ++no, type: 'cup', stage: CUP_SLOTS.indexOf(no), played: false, fixtures: [] });
    }
    no += 1;
    cal.push({
      no, type: 'league', leagueRound: i + 1, played: false,
      fixtures: rounds[i].map((f) => ({ home: f.home, away: f.away, played: false, hg: 0, ag: 0 })),
    });
  }
  // 마지막에 컵 결승이 남았으면 추가
  while (cal.length < 22) {
    const stage = CUP_SLOTS.length - 1 - (22 - cal.length) + 1;
    cal.push({ no: ++no, type: 'cup', stage: Math.max(0, stage - 1), played: false, fixtures: [] });
  }
  w.calendar = cal;
}

/* ─────────────────────────── 컵대회 ─────────────────────────── */
export const CUP_NAMES = ['예선', '8강', '4강', '결승'];
export const CUP_LABEL = ['컵 예선', '컵 8강', '컵 4강', '컵 결승'];

export function buildCupStage(w, stage) {
  if (w.cup.stages[stage]) return;
  const rng = makeRng(`cup-${w.seed}-${w.season}-${stage}`);
  const teams = Object.keys(w.teams);
  let entrants;
  if (stage === 0) {
    const byPower = teams.slice().sort((a, b) => teamPower(w, a) - teamPower(w, b));
    entrants = byPower.slice(0, 4);
  } else {
    const prev = w.cup.stages[stage - 1];
    const winners = prev.matches.map((m) => m.winner).filter(Boolean);
    const used = new Set(w.cup.stages.slice(0, stage).flatMap((s) => s.matches.flatMap((m) => [m.home, m.away])));
    const byes = teams.filter((t) => !used.has(t));
    entrants = [...byes, ...winners];
  }
  const order = shuffle(rng, entrants);
  const matches = [];
  for (let i = 0; i < order.length; i += 2) {
    matches.push({ home: order[i], away: order[i + 1], played: false, hg: 0, ag: 0, pens: null, winner: null });
  }
  w.cup.stages[stage] = { stage, name: CUP_NAMES[stage], matches };
}

export function cupFixtures(w, stage) {
  const s = w.cup.stages[stage];
  return s ? s.matches : [];
}

/* 사용자가 관여하지 않는 경기를 순서대로 자동 진행한다.
   — 내 경기가 나오면 거기서 멈춘다. (컵 대진이 다음 단계로 이어지려면 필요) */
export function ensureProgress(w) {
  for (const r of w.calendar) {
    if (r.played) continue;
    if (r.type === 'cup' && !w.cup.stages[r.stage]) return; // 아직 대진 미정
    const fx = r.type === 'league' ? r.fixtures : w.cup.stages[r.stage].matches;
    const userUnplayed = fx.some((f) => !f.played && (f.home === w.myTeamId || f.away === w.myTeamId));
    if (userUnplayed) return;
    playOtherFixtures(w, r, true);
    finishRound(w, r);
  }
}

/* ─────────────────────────── 다음 경기 ─────────────────────────── */
export function userNextMatch(w) {
  for (const r of w.calendar) {
    const fx = r.type === 'league'
      ? r.fixtures.filter((f) => !f.played && (f.home === w.myTeamId || f.away === w.myTeamId))
      : cupFixtures(w, r.stage).filter((f) => !f.played && f.home && (f.home === w.myTeamId || f.away === w.myTeamId));
    if (fx.length) return { round: r, fixture: fx[0] };
  }
  return null;
}
export function isUserInCup(w) {
  return w.cup.stages.some((s) => s && s.matches.some((m) => (m.home === w.myTeamId || m.away === w.myTeamId)));
}
export function userCupOut(w) {
  const last = w.cup.stages[w.cup.stages.length - 1];
  if (!last) return false;
  return last.matches.every((m) => m.played) && !last.matches.some((m) => m.winner === w.myTeamId && m.played);
}
export function seasonOver(w) {
  return userNextMatch(w) === null;
}

/* ─────────────────────────── 순위표 ─────────────────────────── */
export function standings(w) {
  const rows = {};
  for (const id of Object.keys(w.teams)) rows[id] = { id, play: 0, win: 0, draw: 0, loss: 0, gf: 0, ga: 0, pts: 0, gd: 0, form: [] };
  for (const r of w.calendar) {
    if (r.type !== 'league') continue;
    for (const f of r.fixtures) {
      if (!f.played) continue;
      const H = rows[f.home], A = rows[f.away];
      if (!H || !A) continue;
      H.play++; A.play++;
      H.gf += f.hg; H.ga += f.ag; A.gf += f.ag; A.ga += f.hg;
      if (f.hg > f.ag) { H.win++; H.pts += 3; A.loss++; H.form.push('W'); A.form.push('L'); }
      else if (f.hg < f.ag) { A.win++; A.pts += 3; H.loss++; H.form.push('L'); A.form.push('W'); }
      else { H.draw++; A.draw++; H.pts++; A.pts++; H.form.push('D'); A.form.push('D'); }
    }
  }
  const list = Object.values(rows).map((r) => ({ ...r, gd: r.gf - r.ga, form: r.form.slice(-5) }));
  list.sort((a, b) => b.pts - a.pts || b.gd - a.gd || b.gf - a.gf || String(a.id).localeCompare(String(b.id)));
  list.forEach((r, i) => { r.rank = i + 1; });
  return list;
}

export function leagueRoundOf(w) {
  const done = w.calendar.filter((r) => r.type === 'league' && r.played).length;
  return done + 1;
}

/* ─────────────────────────── 기록 ─────────────────────────── */
export function leaders(w, kind, n = 5) {
  const all = Object.values(w.players).filter((p) => (p.season?.apps || 0) > 0);
  const val = (p) => {
    const s = p.season;
    if (kind === 'goals') return s.goals;
    if (kind === 'assists') return s.assists;
    if (kind === 'rating') return s.ratingCount >= 1 ? s.ratingSum / s.ratingCount : 0;
    return 0;
  };
  return all.sort((a, b) => val(b) - val(a) || (b.ovr - a.ovr)).slice(0, n).map((p) => ({
    p, value: kind === 'rating' ? (val(p) ? val(p).toFixed(2) : '—') : val(p),
  })).filter((x) => kind === 'rating' ? Number(x.value) > 0 : x.value > 0);
}

/* ─────────────────────────── 빠른 경기 시뮬 (AI vs AI) ─────────────────────────── */
function poisson(rng, lambda) {
  const L = Math.exp(-lambda);
  let k = 0, p = 1;
  do { k++; p *= rng(); } while (p > L && k < 12);
  return k - 1;
}

function strengthOf(w, id) {
  const t = w.teams[id];
  const p = teamPower(w, id);
  let s = p;
  // 전술 궁합: 압박형은 체력 소모, 수비형은 안정
  s += (t.tactic.press || 0) * 1.2 - Math.abs(t.tactic.line || 0) * 0.4;
  const rec = t.recent || [];
  s += rec.slice(-3).reduce((a, r) => a + (r === 'W' ? 1.2 : r === 'L' ? -1.2 : 0), 0);
  return s;
}

export function simMatchQuick(w, homeId, awayId, opts = {}) {
  const rng = makeRng(`${w.seed}-${w.season}-m-${homeId}-${awayId}-${opts.stamp ?? Math.random()}`);
  const sh = strengthOf(w, homeId), sa = strengthOf(w, awayId);
  const homeAdv = 4.5;
  const lamH = clamp(1.35 * Math.exp((sh + homeAdv - sa) / 15), 0.25, 4.2);
  const lamA = clamp(1.1 * Math.exp((sa - sh - homeAdv) / 15), 0.2, 4);
  let hg = poisson(rng, lamH), ag = poisson(rng, lamA);
  hg = Math.min(hg, 7); ag = Math.min(ag, 7);
  const events = [];
  const picked = [];
  const scorerFor = (teamId) => {
    const sq = squadOf(w, teamId).filter((p) => p.pos !== 'GK');
    const weights = sq.map((p) => (p.pos === 'FW' ? 5 : p.pos === 'MF' ? 2.4 : 0.9) * (0.4 + p.stats.sho / 100));
    let r = rng() * sum(weights);
    for (let i = 0; i < sq.length; i++) { r -= weights[i]; if (r <= 0) return sq[i]; }
    return sq[0];
  };
  const addGoal = (teamId, minute) => {
    const s = scorerFor(teamId);
    const mates = squadOf(w, teamId).filter((p) => p.id !== s.id && p.pos !== 'GK');
    const a = mates.length ? mates[Math.floor(rng() * Math.min(mates.length, 8))] : null;
    picked.push({ teamId, goal: true, scorer: s, assist: rng() < 0.65 ? a : null });
    events.push({ minute, type: 'goal', teamId, scorerId: s.id, assistId: a?.id ?? null });
    s.season.goals += 1;
    if (a) a.season.assists += 1;
  };
  // 골 시간 배분
  const times = () => rint(rng, 3, 90);
  for (let i = 0; i < hg; i++) addGoal(homeId, times());
  for (let i = 0; i < ag; i++) addGoal(awayId, times());
  events.sort((a, b) => a.minute - b.minute);
  // 출전 선수 · 평점
  for (const teamId of [homeId, awayId]) {
    const fit = squadOf(w, teamId).filter((p) => available(w, p));
    const sq = (fit.length >= 11 ? fit : squadOf(w, teamId)).sort((a, b) => b.ovr - a.ovr).slice(0, 11);
    const conceded = teamId === homeId ? ag : hg;
    const perf = [];
    for (const p of sq) {
      p.season.apps += 1;
      let r = 6.2 + gauss(rng) * 0.42 + (p.ovr - 70) * 0.012;
      const g = picked.filter((x) => x.scorer?.id === p.id).length;
      const a = picked.filter((x) => x.assist?.id === p.id).length;
      r += g * 1.05 + a * 0.6;
      if (p.pos === 'GK' || p.pos === 'DF') r -= conceded * 0.09;
      const rating = clamp(r, 4.2, 9.8);
      p.season.ratingSum += rating;
      p.season.ratingCount += 1;
      perf.push({ pid: p.id, rating, goals: g, assists: a });
    }
    if (conceded === 0) {
      const gk = sq.find((p) => p.pos === 'GK');
      if (gk) gk.season.cleanSheets = (gk.season.cleanSheets || 0) + 1;
    }
    // 라운드마다 AI 선수도 실제 출전·평점만큼 성장합니다 (내 경기는 applyResult 가 처리)
    growTeamFromMatch(w, teamId, perf, `${opts.stamp || 'q'}-${homeId}-${awayId}`);
  }
  return { hg, ag, events };
}

/* 한 라운드의 나머지 경기 처리 */
export function playOtherFixtures(w, round, skipUser = true) {
  if (round.type === 'league') {
    for (const f of round.fixtures) {
      if (f.played) continue;
      if (skipUser && (f.home === w.myTeamId || f.away === w.myTeamId)) continue;
      const r = simMatchQuick(w, f.home, f.away, { stamp: `l${round.no}` });
      f.played = true; f.hg = r.hg; f.ag = r.ag; f.events = r.events;
      pushRecent(w, f.home, r.hg > r.ag ? 'W' : r.hg < r.ag ? 'L' : 'D');
      pushRecent(w, f.away, r.ag > r.hg ? 'W' : r.ag < r.hg ? 'L' : 'D');
    }
    round.played = round.fixtures.every((f) => f.played);
    if (round.played) settleRound(w, round);
  } else {
    const stage = w.cup.stages[round.stage];
    if (!stage) return;
    for (const m of stage.matches) {
      if (m.played) continue;
      if (skipUser && (m.home === w.myTeamId || m.away === w.myTeamId)) continue;
      const r = simMatchQuick(w, m.home, m.away, { stamp: `c${round.stage}` });
      let hg = r.hg, ag = r.ag;
      const draw = hg === ag;
      if (draw) hg += 1; // 연장 승부 (표시용)
      m.played = true; m.hg = hg; m.ag = ag; m.aet = draw;
      m.winner = hg > ag ? m.home : m.away;
    }
    round.played = stage.matches.every((m) => m.played);
    const next = round.stage + 1;
    if (round.played && next < CUP_NAMES.length) buildCupStage(w, next);
    if (round.played) settleRound(w, round);
  }
}

function rngBool(w, key) {
  const r = makeRng(`${w.seed}-x-${key}`)();
  return r < 0.5;
}
function pushRecent(w, teamId, r) {
  const t = w.teams[teamId];
  t.recent = [...(t.recent || []), r].slice(-6);
}

/* 라운드 전체 마감 (내 경기 결과까지 반영한 뒤) */
export function finishRound(w, round) {
  if (round.type === 'league') {
    round.played = round.fixtures.every((f) => f.played);
  } else {
    const stage = w.cup.stages[round.stage];
    if (stage) {
      round.played = stage.matches.every((m) => m.played);
      if (round.played && round.stage + 1 < CUP_NAMES.length) buildCupStage(w, round.stage + 1);
    }
  }
  if (round.played) settleRound(w, round);
}

/* ─────────────────────────── 라인업 ─────────────────────────── */
export function autoLineup(w, teamId, formationId = null) {
  const t = w.teams[teamId];
  const fid = formationId || t.formation;
  const slots = FORMATIONS[fid].slots;
  let squad = squadOf(w, teamId).slice();
  // 출전 정지·부상 선수는 빼고 고릅니다 (11명이 안 되면 어쩔 수 없이 포함)
  const fit = squad.filter((p) => available(w, p));
  if (fit.length >= 11) squad = fit;
  const used = new Set();
  const starters = [];
  for (const slot of slots) {
    const cands = squad.filter((p) => !used.has(p.id));
    if (!cands.length) { starters.push(null); continue; }
    cands.sort((a, b) => {
      const sa = (a.pos === slot.pos ? 10 : 0) + a.ovr / 10 - (a.season?.apps ? 0 : 0);
      const sb = (b.pos === slot.pos ? 10 : 0) + b.ovr / 10;
      return sb - sa;
    });
    const chosen = cands[0];
    used.add(chosen.id);
    starters.push(chosen.id);
  }
  // 후보 7명: 나머지 중 GK 1 + 필드 6
  const rest = squad.filter((p) => !used.has(p.id)).sort((a, b) => b.ovr - a.ovr);
  const benchGk = rest.find((p) => p.pos === 'GK');
  const bench = rest.filter((p) => p !== benchGk).slice(0, 6);
  if (benchGk) bench.unshift(benchGk);
  // 역할은 '자리'에 붙습니다 — 같은 포메이션이면 감독이 정해 둔 역할을 그대로 지킵니다.
  const keepRoles = teamId === w.myTeamId && w.myLineup && w.myLineup.formation === fid && w.myLineup.roles
    ? w.myLineup.roles : null;
  const out = {
    formation: fid, starters, bench: bench.map((p) => p.id),
    tactic: { line: 0, pass: 0, press: 0, route: 0, mentality: 0, ...t.tactic },
    roles: keepRoles ? resolveRoles(keepRoles, slots) : defaultRoles(slots),
    // 세트피스 지시 — 내 팀은 감독이 고른 값, AI 팀은 팀 성향 값
    setpiece: resolveSetPiece(teamId === w.myTeamId && w.myLineup?.setpiece ? w.myLineup.setpiece : t.setpiece),
  };
  if (teamId === w.myTeamId) return out;
  return out;
}

/* 역할 배열을 다른 포메이션으로 옮깁니다 — 같은 라벨 자리(LB→LB)로 따라갑니다. */
export function remapRoles(roles, fromId, toId) {
  const from = FORMATIONS[fromId]?.slots || [];
  const to = FORMATIONS[toId]?.slots || [];
  const cur = resolveRoles(roles, from);
  const pool = from.map((s, i) => ({ label: s.label, role: cur[i], used: false }));
  const fallback = defaultRoles(to);
  return to.map((s, i) => {
    const hit = pool.find((o) => !o.used && o.label === s.label);
    if (!hit) return fallback[i];
    hit.used = true;
    return roleFor(s.label, hit.role);
  });
}

/* 자리-선수 배정 — 포지션 적합도를 먼저 보고, 그다음 종합·기존 선발 여부를 봅니다.
   (예전에는 자리 순서대로 '남은 선수 중 최고'를 넣어서, 3-5-2로 바꾸면 수비수가 ST에,
    공격수가 윙백 자리에 밀려 들어갔습니다) */
export function assignSlots(w, slots, prefer = []) {
  const preferSet = new Set(prefer.filter(Boolean));
  const squad = squadOf(w, w.myTeamId);
  const fit = squad.filter((p) => available(w, p));
  const pool = fit.length >= slots.length ? fit : squad;
  const val = (p, slot) => posFactor(slot.pos, p.pos) * 100 + p.ovr * 0.6 + (preferSet.has(p.id) ? 18 : 0);
  const pairs = [];
  pool.forEach((p) => slots.forEach((s, si) => pairs.push({ pid: p.id, si, v: val(p, s) })));
  pairs.sort((a, b) => b.v - a.v);
  const out = new Array(slots.length).fill(null);
  const used = new Set();
  for (const { pid, si } of pairs) {
    if (out[si] || used.has(pid)) continue;
    out[si] = pid; used.add(pid);
  }
  // 국소 개선 — 두 자리를 맞바꿔 합이 커지면 교환합니다
  const byId = (id) => w.players[id];
  for (let iter = 0; iter < 6; iter++) {
    let moved = false;
    for (let a = 0; a < out.length; a += 1) {
      for (let b = a + 1; b < out.length; b += 1) {
        const pa = byId(out[a]), pb = byId(out[b]);
        if (!pa || !pb) continue;
        const now = val(pa, slots[a]) + val(pb, slots[b]);
        const swap = val(pb, slots[a]) + val(pa, slots[b]);
        if (swap > now + 0.01) { out[a] = pb.id; out[b] = pa.id; moved = true; }
      }
    }
    if (!moved) break;
  }
  return out;
}

export function setFormation(w, fid) {
  const l = w.myLineup;
  if (!FORMATIONS[fid]) return;
  const slots = FORMATIONS[fid].slots;
  l.roles = remapRoles(l.roles, l.formation, fid);
  l.formation = fid;
  l.starters = assignSlots(w, slots, l.starters);
  const used = new Set(l.starters.filter(Boolean));
  const rest = squadOf(w, w.myTeamId).filter((p) => !used.has(p.id))
    .sort((a, b) => (available(w, b) ? 1 : 0) - (available(w, a) ? 1 : 0) || b.ovr - a.ovr);
  const gk = rest.find((p) => p.pos === 'GK');
  l.bench = (gk ? [gk, ...rest.filter((p) => p !== gk)] : rest).slice(0, 7).map((p) => p.id);
  fillLineup(w);
  w.myLineup.tactic = l.tactic;
}

export function swapPlayers(w, starterIdx, playerId) {
  const l = w.myLineup;
  const cur = l.starters[starterIdx];
  if (cur === playerId) return;
  const benchIdx = l.bench.indexOf(playerId);
  if (benchIdx < 0) return;
  l.starters[starterIdx] = playerId;
  if (cur) l.bench[benchIdx] = cur;
  else l.bench.splice(benchIdx, 1);
  // 중복 방지
  const seen = new Set();
  l.starters = l.starters.map((id) => {
    if (!id || seen.has(id)) return null;
    seen.add(id); return id;
  });
}

/* 슬롯(자리)의 역할을 바꿉니다 — 역할은 선수가 아니라 자리에 붙습니다. */
/* 세트피스 지시 — 코너킥·프리킥을 어떻게 찰지 고릅니다 (모르는 값은 기본값으로). */
export function setSetPiece(w, type, key) {
  const l = w.myLineup;
  if (!l) return null;
  l.setpiece = resolveSetPiece({ ...(l.setpiece || {}), [type]: key });
  return l.setpiece;
}

export function setRole(w, slotIdx, role) {
  const l = w.myLineup;
  if (!l) return null;
  const slots = FORMATIONS[l.formation].slots;
  if (slotIdx < 0 || slotIdx >= slots.length) return null;
  const roles = resolveRoles(l.roles, slots);
  roles[slotIdx] = roleFor(slots[slotIdx].label, role);
  l.roles = roles;
  return roles[slotIdx];
}

/* ─────────────────────────── 이적 시장 ─────────────────────────── */
export function loanFee(p) { return Math.max(0.2, Math.round(valueOf(p) * 0.06 * 10) / 10); }

function freeName(rng, used) {
  const pool = ['문태호', '류재성', '백승주', '허정욱', '남기훈', '심우재', '노현석', '하민철', '곽동현', '성지훈', '차우빈', '주태건'];
  const free = pool.filter((n) => !used.has(n));
  return free.length ? pick(rng, free) : `${pick(rng, pool)}${rint(rng, 2, 9)}`;
}

function freeAgent(w, rng) {
  const used = new Set(Object.values(w.players).map((p) => p.name));
  const ovr = rint(rng, 62, 78);
  const pos = pick(rng, ['DF', 'MF', 'FW', 'GK']);
  const stats = {};
  for (const k of STAT_KEYS) stats[k] = clamp(Math.round(ovr - 8 + gauss(rng) * 6 + (k === 'gk' && pos !== 'GK' ? -45 : 0)), 25, 95);
  const p = {
    id: `p${w.pidSeq++}`, name: '', pos, age: rint(rng, 19, 34), num: 0, stats, teamId: null,
    form: 0, season: freshSeasonStats(), career: { apps: 0, goals: 0, assists: 0, seasons: 0 }, growthLog: [],
  };
  p.name = freeName(rng, used);
  p.ovr = overall(p);
  p.pot = clamp(p.ovr + rint(rng, 0, p.age < 24 ? 12 : 3), p.ovr, 95);
  p.value = valueOf(p);
  p.wage = wageOf(p);
  w.players[p.id] = p;
  return p;
}

function listing(w, p, rng) {
  return { pid: p.id, from: p.teamId, price: Math.round(valueOf(p) * (1.05 + rng() * 0.5) * 10) / 10 };
}

export function buildMarket(w) {
  const rng = makeRng(`market-${w.seed}-${w.season}`);
  const out = [];
  for (const t of Object.values(w.teams)) {
    if (t.id === w.myTeamId) continue;
    const sq = squadOf(w, t.id).slice().sort((a, b) => b.ovr - a.ovr);
    const sells = shuffle(rng, sq.slice(2)).slice(0, 2);
    for (const p of sells) out.push(listing(w, p, rng));
  }
  // 시즌 임대 매물 2명 — 출전 시간이 필요한 젊은 백업
  const pool = [];
  for (const t of Object.values(w.teams)) {
    if (t.id === w.myTeamId || t.squad.length <= 18) continue;
    const sq = squadOf(w, t.id).filter((p) => p.age <= 25).sort((a, b) => a.ovr - b.ovr);
    for (const p of sq.slice(0, 4)) pool.push(p);
  }
  for (const p of shuffle(rng, pool).slice(0, 2)) {
    out.push({ pid: p.id, from: p.teamId, price: 0, loan: true, fee: loanFee(p) });
  }
  // 자유계약 선수 4명
  for (let i = 0; i < 4; i++) {
    const p = freeAgent(w, rng);
    out.push({ pid: p.id, from: null, price: 0 });
  }
  return shuffle(rng, out);
}

export function canSign(w, entry) {
  const t = myTeam(w);
  const p = w.players[entry.pid];
  if (!p) return { ok: false, why: '선수를 찾을 수 없습니다.' };
  if (t.squad.length >= 24) return { ok: false, why: '선수단은 24명까지만 보유할 수 있습니다.' };
  if (t.budget < entry.price) return { ok: false, why: `이적 자금이 ${fmt(entry.price - t.budget)}억 부족합니다.` };
  if (teamWageTotal(w, w.myTeamId) + p.wage > t.wage) return { ok: false, why: '주급 예산을 넘습니다.' };
  return { ok: true };
}

export function signPlayer(w, entry) {
  const c = canSign(w, entry);
  if (!c.ok) return c;
  const p = w.players[entry.pid];
  const t = myTeam(w);
  t.budget = Math.round((t.budget - entry.price) * 10) / 10;
  w.finance.spent += entry.price;
  if (p.teamId && w.teams[p.teamId]) {
    w.teams[p.teamId].squad = w.teams[p.teamId].squad.filter((id) => id !== p.id);
  }
  p.teamId = w.myTeamId;
  p.num = nextNum(w, w.myTeamId);
  t.squad.push(p.id);
  w.myLineup.bench = [...w.myLineup.bench, p.id].slice(0, 9);
  w.market = w.market.filter((e) => e.pid !== p.id);
  w.offers = (w.offers || []).filter((o) => o.pid !== p.id);
  addNews(w, `${p.name}(${p.pos}, ${p.ovr}) 선수를 ${entry.price ? fmt(entry.price) + '억' : '자유계약'}에 영입했습니다.`);
  pushTransfer(w, {
    type: 'in', pid: p.id, from: entry.from || null,
    text: entry.from && w.teams[entry.from]
      ? `${w.teams[entry.from].short}에서 ${p.name}(${p.pos}, ${p.ovr}) 영입 · ${fmt(entry.price)}억`
      : `자유계약 ${p.name}(${p.pos}, ${p.ovr}) 영입`,
  });
  return { ok: true, price: entry.price };
}

export function sellPlayer(w, pid) {
  const t = myTeam(w);
  const p = w.players[pid];
  if (!p) return { ok: false, why: '선수를 찾을 수 없습니다.' };
  if (t.squad.length <= 15) return { ok: false, why: '선수단이 15명 이하가 되면 방출할 수 없습니다.' };
  if (p.loan) return { ok: false, why: '임대 중인 선수는 방출할 수 없습니다.' };
  const price = Math.round(valueOf(p) * 0.9 * 10) / 10;
  const buyers = Object.keys(w.teams).filter((id) => id !== w.myTeamId && w.teams[id].squad.length < 24);
  const buyer = buyers[Math.floor(Math.random() * buyers.length)] || null;
  t.squad = t.squad.filter((id) => id !== pid);
  t.budget = Math.round((t.budget + price) * 10) / 10;
  w.finance.income += price;
  p.teamId = buyer;
  if (buyer) {
    w.teams[buyer].squad.push(pid);
    p.num = nextNum(w, buyer);
  }
  const l = w.myLineup;
  l.starters = l.starters.map((id) => (id === pid ? null : id));
  l.bench = l.bench.filter((id) => id !== pid);
  fillLineup(w);
  addNews(w, `${p.name} 선수를 ${fmt(price)}억에 방출했습니다.`);
  pushTransfer(w, { type: 'out', pid, to: buyer, text: `${p.name}(${p.pos}, ${p.ovr}) 방출 · ${fmt(price)}억` });
  return { ok: true, price };
}

/* 선수 이동의 단일 통로 — 구단 명단·등번호·임대 표시를 함께 정리합니다. */
export function movePlayer(w, pid, toTeamId) {
  const p = w.players[pid];
  if (!p) return null;
  const fromId = p.teamId;
  if (fromId && w.teams[fromId]) w.teams[fromId].squad = w.teams[fromId].squad.filter((id) => id !== pid);
  if (!toTeamId || !w.teams[toTeamId]) {
    p.teamId = null;
    return fromId;
  }
  p.teamId = toTeamId;
  delete p.loan;
  if (!w.teams[toTeamId].squad.includes(pid)) w.teams[toTeamId].squad.push(pid);
  p.num = nextNum(w, toTeamId);
  return fromId;
}

export function nextNum(w, teamId) {
  const used = new Set(squadOf(w, teamId).map((p) => p.num));
  for (let n = 2; n <= 45; n++) if (!used.has(n)) return n;
  return 46;
}

export function fillLineup(w) {
  const l = w.myLineup;
  const used = new Set(l.starters.filter(Boolean));
  const slots = FORMATIONS[l.formation].slots;
  for (let i = 0; i < 11; i++) {
    if (l.starters[i]) {
      const cur = w.players[l.starters[i]];
      if (cur && !available(w, cur)) l.starters[i] = null;   // 정지·부상 선수는 자동으로 빼 둡니다
      else continue;
    }
    const pool = squadOf(w, w.myTeamId).filter((p) => !used.has(p.id));
    const fit = pool.filter((p) => available(w, p));
    const cand = (fit.length ? fit : pool).sort((a, b) => (b.pos === slots[i].pos ? 10 : 0) + b.ovr / 10 - ((a.pos === slots[i].pos ? 10 : 0) + a.ovr / 10))[0];
    if (cand) { l.starters[i] = cand.id; used.add(cand.id); }
  }
  const rest = squadOf(w, w.myTeamId).filter((p) => !used.has(p.id)).sort((a, b) => (available(w, b) ? 1 : 0) - (available(w, a) ? 1 : 0) || b.ovr - a.ovr);
  l.bench = rest.slice(0, 7).map((p) => p.id);
}

/* ─────────────────────────── 선수 성장·훈련 ───────────────────────────
   라운드마다 실제 출전·평점(7.0 이상 가산)·득점·도움과 나이·잠재력(pot)을
   반영해 능력치·종합(OVR)·몸값이 움직입니다. 노장은 서서히 하락합니다.
   훈련 방향은 어느 능력치가 먼저 오르는지를 정합니다.
   난수는 (시드·시즌·경기 키·선수 id)로 고정 — 같은 경기면 늘 같은 성장이라
   경기 결과 화면의 예고와 실제 반영이 어긋나지 않습니다. */
export const TRAINING = {
  balanced: { name: '균형', icon: '⚖️', short: '균형', note: '모든 능력치를 고르게 끌어올립니다.', w: { spd: 1, sho: 1, pas: 1, dri: 1, def: 1, vis: 1, sta: 1, gk: 1 } },
  attack: { name: '공격/슈팅', icon: '🎯', short: '공격', note: '슈팅·드리블·스피드가 먼저 자랍니다.', w: { spd: 1.4, sho: 2.4, pas: 0.7, dri: 1.8, def: 0.3, vis: 1, sta: 0.7, gk: 0 } },
  pass: { name: '패스/시야', icon: '🪄', short: '패스', note: '패스·시야·드리블이 먼저 자랍니다.', w: { spd: 0.8, sho: 0.6, pas: 2.4, dri: 1.5, def: 0.6, vis: 2.2, sta: 0.8, gk: 0 } },
  defense: { name: '수비/체력', icon: '🛡️', short: '수비', note: '수비·체력·스피드가 먼저 자랍니다.', w: { spd: 1.3, sho: 0.3, pas: 0.7, dri: 0.5, def: 2.4, vis: 0.8, sta: 2.2, gk: 0.8 } },
};
export const TRAINING_IDS = Object.keys(TRAINING);

export function trainingOf(w, teamId) {
  const k = w.teams?.[teamId]?.training;
  return TRAINING[k] ? k : 'balanced';
}

export function setTraining(w, key) {
  if (!TRAINING[key]) return null;
  w.teams[w.myTeamId].training = key;
  addNews(w, `주간 훈련 방향을 '${TRAINING[key].name}'으로 정했습니다.`);
  return key;
}

/* 포지션별 성장 가중치 — 훈련 가중치와 곱해집니다. */
const POS_GROW = {
  GK: { gk: 6, vis: 0.5, def: 0.4, pas: 0.4, spd: 0.3, sta: 0.3, sho: 0.05, dri: 0.05 },
  DF: { def: 2, sta: 1.3, spd: 1.4, pas: 0.9, vis: 0.6, dri: 0.3, sho: 0.15, gk: 0 },
  MF: { pas: 2, vis: 1.4, dri: 1.3, sta: 1.1, def: 0.6, spd: 0.8, sho: 0.6, gk: 0 },
  FW: { sho: 2, dri: 1.6, spd: 1.5, vis: 0.7, pas: 0.6, sta: 0.4, def: 0.15, gk: 0 },
};
/* 나이에 따른 한 경기 기대 성장(능력치 포인트). 30대는 마이너스 = 노쇠. */
const AGE_CURVE = [[19, 1.9], [21, 1.4], [23, 1.1], [25, 0.72], [27, 0.4], [29, -0.1], [31, -0.55], [33, -1.4], [35, -1.8], [38, -2.2]];
/* 성장 점수를 실제 능력치 포인트로 바꾸는 비율 — 한 경기에 0~2포인트 */
const GROW_K = 0.36;
function ageBase(age) {
  const a = Number(age) || 25;
  if (a <= AGE_CURVE[0][0]) return AGE_CURVE[0][1];
  for (let i = 1; i < AGE_CURVE.length; i++) {
    if (a <= AGE_CURVE[i][0]) {
      const [a0, v0] = AGE_CURVE[i - 1], [a1, v1] = AGE_CURVE[i];
      return v0 + ((a - a0) / (a1 - a0)) * (v1 - v0);
    }
  }
  return AGE_CURVE[AGE_CURVE.length - 1][1];
}

function weightedPick(rng, weights) {
  const keys = Object.keys(weights);
  const total = keys.reduce((s, k) => s + Math.max(0, weights[k]), 0);
  if (total <= 0) return keys[0];
  let r = rng() * total;
  for (const k of keys) { r -= Math.max(0, weights[k]); if (r <= 0) return k; }
  return keys[keys.length - 1];
}

/* 이번 경기 성장 계획 — 월드를 건드리지 않습니다(미리보기와 실제 반영이 같은 값). */
export function growthPlan(w, pid, perf = {}, key = 'x') {
  const p = w.players?.[pid];
  if (!p || !p.stats) return null;
  const rng = makeRng(`grow-${w.seed}-${w.season}-${key}-${pid}`);
  const age = Number(p.age) || 25;
  const rating = Number.isFinite(perf.rating) ? perf.rating : 6.4;
  const goals = Number(perf.goals) || 0;
  const assists = Number(perf.assists) || 0;
  // 잘 뛴 경기는 더 크게 자랍니다 — 평점 7.0 이상 가산
  const form = Math.max(0, rating - 6.8) * 0.9 + (rating >= 7 ? 0.2 : 0) + goals * 0.12 + assists * 0.08;
  const pot = Number.isFinite(p.pot) ? p.pot : p.ovr;
  // 잠재력에 이미 닿은 선수는 더 자라지 않습니다 (노장은 하락만).
  const room = Math.max(0, pot - p.ovr);
  // 노장은 잘 뛰어도 하락 폭이 줄 뿐입니다 (성장으로 뒤집히지 않음)
  const base = ageBase(age);
  let score = base >= 0 ? base + form : base + Math.min(form, 0.3) * 0.7;
  score *= GROW_K;
  if (score > 0) score *= clamp(room / 5, 0, 1);   // 잠재력에 가까워지면 성장이 둔해집니다
  const mag = Math.abs(score);
  let pts = Math.floor(mag);
  if (rng() < mag - pts) pts += 1;
  const train = TRAINING[trainingOf(w, p.teamId)] || TRAINING.balanced;
  const baseW = POS_GROW[p.pos] || POS_GROW.MF;
  const upW = {};
  for (const k of STAT_KEYS) {
    // 골키퍼의 GK 능력치는 어떤 훈련을 골라도 최소한으로는 자랍니다
    const tw = k === 'gk' && p.pos === 'GK' ? Math.max(0.5, train.w[k] ?? 1) : (train.w[k] ?? 1);
    upW[k] = (baseW[k] || 0) * tw;
  }
  const downW = { spd: 2.2, sta: 1.8, dri: 0.9, def: 0.5, sho: 0.5, pas: 0.5, vis: 0.4, gk: p.pos === 'GK' ? 2 : 0 };
  const stats = { ...p.stats };
  const plus = [], minus = [];
  for (let i = 0; i < pts; i++) {
    if (score > 0) {
      const k = weightedPick(rng, upW);
      if (stats[k] < 99) { stats[k] += 1; plus.push(k); }
    } else {
      const k = weightedPick(rng, downW);
      if (stats[k] > 25) { stats[k] -= 1; minus.push(k); }
    }
  }
  const to = overall({ pos: p.pos, age: p.age, stats });
  return {
    pid, name: p.name, pos: p.pos, age, from: p.ovr, to, d: to - p.ovr, pot,
    plus, minus, stats, teamId: p.teamId,
  };
}

export function applyGrowth(w, plan, key = 'x') {
  const p = w.players?.[plan?.pid];
  if (!p) return null;
  p.stats = plan.stats;
  p.ovr = plan.to;
  p.value = valueOf(p);
  p.wage = wageOf(p);
  const before = plan.from;
  const d = p.ovr - before;
  p.growthLog = [...(p.growthLog || []), { s: w.season, d, st: [...plan.plus, ...plan.minus], up: plan.plus, dn: plan.minus, k: key }].slice(-6);
  return { ...plan, from: before, to: p.ovr, d };
}

/* 한 팀의 경기 출전 기록으로 성장을 반영합니다. entries: [{pid, rating, goals, assists}] */
export function growTeamFromMatch(w, teamId, entries, key = 'x') {
  const out = [];
  for (const e of entries || []) {
    const plan = growthPlan(w, e.pid, e, key);
    if (!plan) continue;
    const got = applyGrowth(w, plan, key);
    if (got) out.push(got);
  }
  if (teamId === w.myTeamId) {
    w.lastGrowth = { season: w.season, key, list: out };
    const notable = out.filter((g) => g.d > 0 && (g.d >= 2 || g.plus.length >= 2));
    if (notable.length) {
      addNews(w, `성장 — ${notable.slice(0, 2).map((g) => `${g.name} ${g.from}→${g.to}`).join(', ')}${notable.length > 2 ? ` 외 ${notable.length - 2}명` : ''}`);
    }
  }
  return out;
}

/* 화면용 성장 상태 — 유망주/성장 중/만개/노쇠/정체 */
export function growthStatus(p) {
  if (!p) return { key: 'none', label: '—', note: '' };
  const pot = Number.isFinite(p.pot) ? p.pot : p.ovr;
  const room = pot - p.ovr;
  const last = (p.growthLog || []).slice(-1)[0];
  if (p.age <= 22 && room >= 6) return { key: 'prospect', label: '유망주', note: `잠재력 ${pot}까지 ${room} 남았습니다.` };
  if (room <= 0 && p.age <= 29) return { key: 'peak', label: '만개', note: `잠재력 ${pot}에 도달했습니다.` };
  if (p.age >= 32) return { key: 'decline', label: '노쇠', note: `${p.age}세 — 서서히 내려갑니다.` };
  if (last && last.d > 0) return { key: 'up', label: '성장 중', note: `잠재력 ${pot} · 최근 +${last.d}` };
  if (last && last.d < 0) return { key: 'down', label: '하락', note: `최근 ${last.d}` };
  return { key: 'flat', label: '정체', note: `잠재력 ${pot} · ${room > 0 ? `+${room} 남음` : '한계'}` };
}

/* 최근 능력치 변화 표시용 — 마지막 경기의 종합 증감 */
export function recentDelta(p) {
  const logs = p?.growthLog || [];
  if (!logs.length) return 0;
  return logs[logs.length - 1].d || 0;
}

/* ─────────────────────────── 이적 소식 피드 ─────────────────────────── */
export function pushTransfer(w, entry) {
  if (!w.transfers) w.transfers = [];
  w.transfers.unshift({ s: w.season, at: Date.now(), ...entry });
  w.transfers = w.transfers.slice(0, 40);
  return entry;
}

/* ─────────────────────────── AI 구단 간 이적 ─────────────────────────── */
export function aiTransferRound(w, round) {
  const no = round?.no ?? 0;
  const aiIds = Object.keys(w.teams).filter((id) => id !== w.myTeamId);
  const made = [];
  for (let i = 0; i < 4; i++) {
    const rng = makeRng(`ait-${w.seed}-${w.season}-${no}-${i}`);
    // 라운드가 진행될수록 이적 시장이 뜨거워집니다 (1R 45% → 18R 90%)
    const chance = clamp(0.45 + no * 0.025, 0.45, 0.9);
    if (rng() > chance) continue;
    const buyerId = pick(rng, aiIds);
    const buyer = w.teams[buyerId];
    if (!buyer || buyer.squad.length >= 24) continue;
    const sellers = aiIds.filter((id) => id !== buyerId && w.teams[id].squad.length > 17);
    if (!sellers.length) continue;
    const sellerId = pick(rng, sellers);
    const seller = w.teams[sellerId];
    // 에이스(상위 2명)는 팔지 않습니다 — 하위권 선수만 시장에 나옵니다
    const pool = squadOf(w, sellerId).slice().sort((a, b) => b.ovr - a.ovr).slice(2);
    if (!pool.length) continue;
    const target = pick(rng, pool.slice(0, Math.max(3, Math.ceil(pool.length * 0.75))));
    const price = Math.round(valueOf(target) * (0.9 + rng() * 0.5) * 10) / 10;
    if (price > buyer.budget) continue;
    if (teamWageTotal(w, buyerId) + target.wage > buyer.wage * 1.08) continue;
    buyer.budget = Math.round((buyer.budget - price) * 10) / 10;
    seller.budget = Math.round((seller.budget + price) * 10) / 10;
    movePlayer(w, target.id, buyerId);
    w.market = (w.market || []).filter((e) => e.pid !== target.id);
    w.offers = (w.offers || []).filter((o) => o.pid !== target.id);
    const entry = {
      type: 'ai', pid: target.id, from: sellerId, to: buyerId, price,
      text: `${seller.short} → ${buyer.short} · ${target.name}(${target.pos}, ${target.ovr}) ${fmt(price)}억`,
    };
    pushTransfer(w, entry);
    made.push(entry);
  }
  return made;
}

/* ─────────────────────────── 시장 갱신 · AI 영입 ─────────────────────────── */
export function refreshMarket(w, round) {
  const no = round?.no ?? 0;
  const rng = makeRng(`mkr-${w.seed}-${w.season}-${no}`);
  const myId = w.myTeamId;
  // 다른 팀으로 옮겨 간 선수·내 선수·임대 만료 매물은 목록에서 내립니다
  w.market = (w.market || []).filter((e) => {
    const p = w.players[e.pid];
    if (!p) return false;
    if (p.teamId === myId) return false;
    if (e.loan) return !!p.teamId && p.teamId !== myId;
    return !e.from || p.teamId === e.from;
  });
  // AI 구단이 새 매물을 내놓습니다
  const clubs = Object.keys(w.teams).filter((id) => id !== myId && w.teams[id].squad.length > 17);
  const listed = new Set(w.market.map((e) => e.pid));
  const add = 1 + Math.floor(rng() * 2);
  for (let i = 0; i < add && w.market.length < 16 && clubs.length; i++) {
    const clubId = pick(rng, clubs);
    const pool = squadOf(w, clubId).filter((p) => !listed.has(p.id)).sort((a, b) => a.ovr - b.ovr);
    if (!pool.length) continue;
    const p = pool[Math.floor(rng() * Math.max(1, Math.ceil(pool.length * 0.8)))];
    if (!p) continue;
    listed.add(p.id);
    w.market.push(listing(w, p, rng));
  }
  // 가끔 AI 구단이 자유계약 선수를 데려갑니다 (빈자리는 새 FA로 채움)
  if (rng() < 0.4) {
    const fa = w.market.filter((e) => !e.from && !e.loan);
    if (fa.length) {
      const e = pick(rng, fa);
      const p = w.players[e.pid];
      const buyers = clubs.length ? clubs : Object.keys(w.teams).filter((id) => id !== myId && w.teams[id].squad.length < 24);
      const buyerId = buyers.length ? pick(rng, buyers) : null;
      if (p && buyerId && w.teams[buyerId].squad.length < 24) {
        movePlayer(w, p.id, buyerId);
        w.market = w.market.filter((x) => x.pid !== p.id);
        pushTransfer(w, { type: 'ai', pid: p.id, from: null, to: buyerId, price: 0, text: `${w.teams[buyerId].short} · ${p.name}(${p.pos}, ${p.ovr}) 자유계약 영입` });
      }
    }
  }
  // 자유계약 매물이 2명 밑으로 떨어지면 새로 채웁니다
  const faCount = w.market.filter((e) => !e.from).length;
  for (let i = faCount; i < 2; i++) {
    const p = freeAgent(w, rng);
    w.market.push({ pid: p.id, from: null, price: 0 });
  }
  // 임대 매물은 1~2명 유지
  const loanCount = w.market.filter((e) => e.loan).length;
  for (let i = loanCount; i < 2; i++) {
    const pool = [];
    for (const id of clubs) {
      const sq = squadOf(w, id).filter((p) => p.age <= 25 && p.teamId !== myId).sort((a, b) => a.ovr - b.ovr);
      for (const p of sq.slice(0, 3)) pool.push(p);
    }
    if (!pool.length) break;
    const p = pick(rng, pool);
    if (w.market.some((e) => e.pid === p.id)) continue;
    w.market.push({ pid: p.id, from: p.teamId, price: 0, loan: true, fee: loanFee(p) });
  }
  return w.market;
}

/* ─────────────────────────── 우리 선수 영입 오퍼 ─────────────────────────── */
export function generateOffers(w, round, opts = {}) {
  const no = round?.no ?? 0;
  w.offers = w.offers || [];
  // 시즌이 바뀌었거나 너무 오래된 오퍼는 정리
  w.offers = w.offers.filter((o) => o.season === w.season && no - (o.round || 0) <= 2 && w.players[o.pid]?.teamId === w.myTeamId);
  const myId = w.myTeamId;
  const squad = squadOf(w, myId);
  const power = teamPower(w, myId);
  const clubs = Object.keys(w.teams)
    .filter((id) => id !== myId && w.teams[id].squad.length < 23 && w.teams[id].budget > 2)
    .sort((a, b) => w.teams[b].budget - w.teams[a].budget);
  const rng = makeRng(`offers-${w.seed}-${w.season}-${no}`);
  const out = [];
  const pool = squad.filter((p) => !p.loan && p.ovr >= power - 8 && !w.offers.some((o) => o.pid === p.id));
  const open = (p) => !p.cool || w.season * 100 + no - p.cool > 3;
  const make = (p) => {
    if (!clubs.length) return null;
    const clubId = pick(rng, clubs.slice(0, Math.min(5, clubs.length)));
    const club = w.teams[clubId];
    const value = Math.max(0.4, valueOf(p));
    const cap = club.budget * 0.92;
    const price = Math.round(Math.min(cap, value * (0.9 + rng() * 0.55) * (1 + no * 0.012)) * 10) / 10;
    if (price < 0.4) return null;
    const offer = { id: `o${w.offerSeq++}`, pid: p.id, from: clubId, price, season: w.season, round: no };
    w.offers.push(offer);
    out.push(offer);
    pushTransfer(w, {
      type: 'offer', pid: p.id, from: clubId, price,
      text: `${club.short}, ${p.name}(${p.pos}, ${p.ovr}) 영입 오퍼 ${fmt(price)}억`,
    });
    return offer;
  };
  // 라운드가 갈수록 오퍼가 잦아집니다 — 최대 2건
  const want = w.offers.length >= 3 ? 0 : (rng() < 0.55 + no * 0.02 ? (rng() < 0.3 ? 2 : 1) : 0);
  const shuffled = shuffle(rng, pool.filter(open));
  for (let i = 0; i < want && i < shuffled.length; i++) make(shuffled[i]);
  // 오퍼가 하나도 없으면 라운드마다 한 건은 오도록 — 화면에서 오퍼 흐름을 놓치지 않게
  if (opts.force || (!w.offers.length && no >= 1)) {
    const best = squad.filter((p) => !p.loan && open(p)).sort((a, b) => b.value - a.value)[0];
    if (best && !w.offers.some((o) => o.pid === best.id)) make(best);
  }
  return out;
}

function squadTrim(w, pid) {
  const l = w.myLineup;
  l.starters = l.starters.map((id) => (id === pid ? null : id));
  l.bench = l.bench.filter((id) => id !== pid);
  fillLineup(w);
}

export function sellToClub(w, pid, clubId, price, kind = 'transfer') {
  const t = myTeam(w);
  const p = w.players[pid];
  const club = w.teams[clubId];
  if (!p || !club) return { ok: false, why: '선수나 구단을 찾을 수 없습니다.' };
  if (p.loan) return { ok: false, why: '임대 중인 선수는 이적할 수 없습니다.' };
  if (p.teamId !== w.myTeamId) return { ok: false, why: '우리 선수가 아닙니다.' };
  if (t.squad.length <= 15) return { ok: false, why: '선수단이 15명 이하가 되면 팔 수 없습니다.' };
  if (club.squad.length >= 24) return { ok: false, why: '상대 구단의 선수단이 가득 찼습니다.' };
  const fee = Math.max(0, Math.round(price * 10) / 10);
  t.squad = t.squad.filter((id) => id !== pid);
  t.budget = Math.round((t.budget + fee) * 10) / 10;
  w.finance.income += fee;
  club.budget = Math.max(0, Math.round((club.budget - fee) * 10) / 10);
  movePlayer(w, pid, clubId);
  squadTrim(w, pid);
  w.offers = (w.offers || []).filter((o) => o.pid !== pid);
  addNews(w, `${p.name} 선수를 ${club.short}로 보냈습니다 — ${fmt(fee)}억.`);
  pushTransfer(w, {
    type: 'out', pid, from: w.myTeamId, to: clubId, price: fee,
    text: `${p.name}(${p.pos}, ${p.ovr}) → ${club.short} · ${fmt(fee)}억${kind === 'counter' ? ' (역제안 수락)' : ''}`,
  });
  return { ok: true, price: fee };
}

export function acceptOffer(w, offerId) {
  const o = (w.offers || []).find((x) => x.id === offerId);
  if (!o) return { ok: false, why: '오퍼가 이미 사라졌습니다.' };
  return sellToClub(w, o.pid, o.from, o.price, 'offer');
}

export function rejectOffer(w, offerId) {
  const o = (w.offers || []).find((x) => x.id === offerId);
  if (!o) return { ok: false, why: '오퍼가 이미 사라졌습니다.' };
  w.offers = w.offers.filter((x) => x.id !== offerId);
  const p = w.players[o.pid];
  if (p) p.cool = w.season * 100 + (o.round || 0);
  if (p) {
    pushTransfer(w, {
      type: 'reject', pid: p.id, from: o.from, price: o.price,
      text: `${w.teams[o.from]?.short || ''}의 ${p.name} 영입 오퍼(${fmt(o.price)}억)를 거절했습니다`,
    });
  }
  return { ok: true };
}

export function counterOffer(w, offerId, price) {
  const o = (w.offers || []).find((x) => x.id === offerId);
  const p = o ? w.players[o.pid] : null;
  const club = o ? w.teams[o.from] : null;
  if (!o || !p || !club) return { ok: false, why: '오퍼가 이미 사라졌습니다.' };
  const ask = Math.round(Number(price) * 10) / 10;
  if (!(ask > o.price)) return { ok: false, why: '지금 오퍼보다 높은 금액을 불러야 합니다.', offer: o };
  const rng = makeRng(`counter-${w.seed}-${w.season}-${o.id}-${Math.round(ask * 10)}`);
  const value = Math.max(0.4, valueOf(p));
  const ceiling = value * (1.25 + rng() * 0.4);
  const limit = Math.round(Math.min(ceiling, club.budget * 0.95) * 10) / 10;
  if (ask <= limit) {
    const r = sellToClub(w, o.pid, o.from, ask, 'counter');
    return { ...r, accepted: r.ok };
  }
  const bump = Math.round(Math.min(Math.max(limit, o.price), Math.max(o.price, value * 1.12)) * 10) / 10;
  if (bump > o.price) o.price = bump;
  pushTransfer(w, {
    type: 'counter-no', pid: p.id, from: o.from, price: bump,
    text: `${club.short} — ${p.name} 역제안 거절, ${fmt(bump)}억까지 가능`,
  });
  return { ok: false, accepted: false, why: `${club.short}가 ${fmt(bump)}억까지만 낼 수 있다고 합니다.`, price: bump, offer: o };
}

/* ─────────────────────────── 가격 협상 · 임대 ─────────────────────────── */
export function negotiate(w, pid, price) {
  const e = (w.market || []).find((x) => x.pid === pid);
  const p = w.players[pid];
  if (!e || !p) return { ok: false, why: '이미 시장에서 빠진 선수입니다.' };
  if (e.loan) return { ok: false, why: '임대 매물은 가격 협상 대신 임대로 데려옵니다.' };
  if (!e.from) return { ok: false, why: '자유계약 선수는 협상 없이 바로 영입할 수 있습니다.' };
  const seller = w.teams[e.from];
  const ask = e.price;
  const bid = Math.max(0.3, Math.round(Number(price) * 10) / 10);
  if (bid >= ask) {
    const r = signPlayer(w, { ...e, price: bid });
    return { ...r, accepted: r.ok, price: bid };
  }
  const rng = makeRng(`nego-${w.seed}-${w.season}-${pid}-${Math.round(bid * 10)}`);
  // 구단이 받아들일 최저선 — 몸값의 70~88%
  const floor = Math.round(Math.max(0.3, valueOf(p) * (0.7 + rng() * 0.18)) * 10) / 10;
  if (bid >= floor) {
    const r = signPlayer(w, { ...e, price: bid });
    return { ...r, accepted: r.ok, price: bid };
  }
  const counter = Math.max(floor, Math.round(ask * 0.62 * 10) / 10);
  e.price = Math.min(ask, Math.round(counter * 10) / 10);
  return {
    ok: false, accepted: false, price: e.price,
    why: `${seller?.short || '상대 구단'}가 ${fmt(e.price)}억까지 내려왔습니다. 그 아래로는 안 된다고 합니다.`,
  };
}

export function loanPlayer(w, entry) {
  const p = w.players[entry?.pid];
  const t = myTeam(w);
  if (!p) return { ok: false, why: '선수를 찾을 수 없습니다.' };
  if (!entry.loan) return { ok: false, why: '임대 매물이 아닙니다.' };
  const owner = p.teamId;
  if (!owner || !w.teams[owner]) return { ok: false, why: '원소속 구단이 없습니다.' };
  if (t.squad.length >= 24) return { ok: false, why: '선수단은 24명까지만 보유할 수 있습니다.' };
  const fee = Math.round((entry.fee ?? loanFee(p)) * 10) / 10;
  if (t.budget < fee) return { ok: false, why: `임대료가 ${fmt(fee - t.budget)}억 부족합니다.` };
  if (teamWageTotal(w, w.myTeamId) + p.wage > t.wage) return { ok: false, why: '주급 예산을 넘습니다.' };
  w.teams[owner].squad = w.teams[owner].squad.filter((id) => id !== p.id);
  t.squad.push(p.id);
  const prev = p.teamId;
  p.teamId = w.myTeamId;
  p.loan = { owner: prev, fee, season: w.season };
  p.num = nextNum(w, w.myTeamId);
  t.budget = Math.round((t.budget - fee) * 10) / 10;
  w.finance.spent += fee;
  w.market = w.market.filter((x) => x.pid !== p.id);
  w.loans = w.loans || [];
  w.loans.push({ pid: p.id, owner: prev, club: w.myTeamId, fee, season: w.season });
  w.myLineup.bench = [...w.myLineup.bench, p.id].slice(0, 9);
  addNews(w, `${p.name}(${p.pos}, ${p.ovr}) 선수를 ${w.teams[prev].short}에서 시즌 임대로 데려왔습니다 — 임대료 ${fmt(fee)}억.`);
  pushTransfer(w, { type: 'loan-in', pid: p.id, from: prev, price: fee, text: `${p.name}(${p.pos}, ${p.ovr}) ${w.teams[prev].short}에서 시즌 임대 · ${fmt(fee)}억` });
  return { ok: true, price: fee };
}

/* 시즌이 끝나면 임대 선수를 원소속으로 돌려보냅니다. */
export function returnLoans(w) {
  const back = [];
  for (const loan of w.loans || []) {
    const p = w.players[loan.pid];
    if (!p || p.teamId !== w.myTeamId) continue;
    const owner = w.teams[loan.owner];
    w.teams[w.myTeamId].squad = w.teams[w.myTeamId].squad.filter((id) => id !== p.id);
    w.myLineup.starters = w.myLineup.starters.map((id) => (id === p.id ? null : id));
    w.myLineup.bench = w.myLineup.bench.filter((id) => id !== p.id);
    if (owner && owner.squad.length < 24) {
      p.teamId = loan.owner;
      delete p.loan;
      owner.squad.push(p.id);
      p.num = nextNum(w, loan.owner);
      back.push({ name: p.name, to: owner.short });
    } else {
      p.teamId = null;
      delete p.loan;
      back.push({ name: p.name, to: '자유계약' });
    }
  }
  w.loans = [];
  fillLineup(w);
  for (const b of back) addNews(w, `임대 종료 — ${b.name} 선수가 ${b.to}(으)로 돌아갔습니다.`);
  return back;
}

/* 라운드가 마감될 때마다 한 번 — AI 이적·시장 갱신·영입 오퍼 */
export function settleRound(w, round) {
  if (!round || round.settled) return false;
  round.settled = true;
  aiTransferRound(w, round);
  refreshMarket(w, round);
  generateOffers(w, round);
  return true;
}

/* ─────────────────────────── 시즌 종료·다음 시즌 ─────────────────────────── */
export function seasonSummary(w) {
  const table = standings(w);
  const myRank = table.findIndex((r) => r.id === w.myTeamId) + 1;
  const cup = w.cup.stages.map((s) => ({ name: s.name, matches: s.matches }));
  const final = w.cup.stages[CUP_NAMES.length - 1];
  const cupWinner = final?.matches?.[0]?.winner ?? null;
  const cupOut = (() => {
    if (cupWinner === w.myTeamId) return '우승';
    for (let s = w.cup.stages.length - 1; s >= 0; s--) {
      const st = w.cup.stages[s];
      const mine = st.matches.find((m) => m.home === w.myTeamId || m.away === w.myTeamId);
      if (mine) return `${st.name} 탈락`;
    }
    return '참가';
  })();
  return { table, myRank, cupWinner, cupOut, champion: table[0]?.id };
}

const PRIZE = [62, 48, 38, 30, 24, 19, 15, 12, 10, 8];

export function advanceSeason(w) {
  const s = seasonSummary(w);
  const myRow = s.table.find((r) => r.id === w.myTeamId);
  const myPrize = PRIZE[(myRow?.rank ?? 10) - 1] || 6;
  const cupPrize = s.cupWinner === w.myTeamId ? 24 : 0;
  const my = myTeam(w);
  my.budget = Math.round((my.budget + myPrize + cupPrize) * 10) / 10;
  // 임대 선수는 원소속으로 돌려보낸 뒤 나이·성장 정산을 합니다.
  const loansBack = returnLoans(w);
  w.history.push({
    season: w.season, rank: s.myRank, pts: myRow?.pts ?? 0, gf: myRow?.gf ?? 0, ga: myRow?.ga ?? 0,
    champion: s.champion, cupWinner: s.cupWinner, cupOut: s.cupOut, prize: myPrize + cupPrize,
  });
  const growth = [];
  for (const p of Object.values(w.players)) {
    p.career.apps += p.season.apps; p.career.goals += p.season.goals; p.career.assists += p.season.assists;
    p.career.seasons += p.season.apps > 0 ? 1 : 0;
    p.age += 1;
    const before = p.ovr;
    // 라운드마다 성장이 이미 반영되므로 시즌 결산은 완만하게 — 나이 한 살만 반영합니다.
    let delta = 0;
    if (p.age <= 22) delta = rint(Math.random, 0, 1);
    else if (p.age <= 25) delta = rint(Math.random, 0, 1);
    else if (p.age <= 28) delta = rint(Math.random, -1, 1);
    else if (p.age <= 31) delta = rint(Math.random, -2, 0);
    else delta = rint(Math.random, -3, -1);
    const room = (p.pot || p.ovr) - p.ovr;
    if (delta > 0) delta = Math.min(delta, Math.max(room, 0));
    if (p.ovr + delta <= p.pot + 2) p.ovr = clamp(p.ovr + delta, 40, 97);
    // 능력치 반영
    for (const k of STAT_KEYS) p.stats[k] = clamp(p.stats[k] + delta + rint(Math.random, -1, 1), 25, 99);
    p.ovr = overall(p);
    p.value = valueOf(p); p.wage = wageOf(p);
    if (p.ovr !== before) growth.push({ name: p.name, teamId: p.teamId, from: before, to: p.ovr });
    p.season = freshSeasonStats();
    p.bans = 0; p.inj = 0;   // 새 시즌에는 정지·부상이 풀립니다
  }
  // 은퇴 & 유스 영입
  const retired = [];
  for (const t of Object.values(w.teams)) {
    const keep = [];
    for (const id of t.squad) {
      const p = w.players[id];
      if (p.age >= 37) { retired.push(p.name); delete w.players[id]; continue; }
      keep.push(id);
    }
    t.squad = keep;
    while (t.squad.length < 20) {
      const rng = makeRng(`youth-${w.seed}-${w.season}-${t.id}-${t.squad.length}`);
      const pos = pick(rng, ['DF', 'MF', 'FW', 'GK']);
      const ovr = rint(rng, 55, 68);
      const stats = {};
      for (const k of STAT_KEYS) stats[k] = clamp(Math.round(ovr - 6 + gauss(rng) * 6 + (k === 'gk' && pos !== 'GK' ? -45 : 0)), 25, 95);
      const p = { id: `p${w.pidSeq++}`, name: freeName(rng, new Set(Object.values(w.players).map((x) => x.name))), pos, age: rint(rng, 18, 19), num: 0, stats, teamId: t.id, form: 0, season: freshSeasonStats(), career: { apps: 0, goals: 0, assists: 0, seasons: 0 }, growthLog: [] };
      p.ovr = overall(p); p.pot = clamp(p.ovr + rint(rng, 8, 20), p.ovr, 95);
      p.value = valueOf(p); p.wage = wageOf(p);
      w.players[p.id] = p;
      t.squad.push(p.id);
    }
    for (const id of t.squad) { const p = w.players[id]; if (p && !p.num) p.num = nextNum(w, t.id); }
    t.recent = [];
    t.powerNow = teamPower(w, t.id);
    // 주급 예산은 선수단 주급에 맞춰 다시 잡는다 (성장·노쇠 반영)
    t.wage = Math.max(t.wage, Math.round((teamWageTotal(w, t.id) * 1.15) / 100) * 100);
  }
  const keepTactic = { ...w.myLineup.tactic };
  w.season += 1;
  w.cup = { stages: [] };
  buildCalendar(w);
  buildCupStage(w, 0);
  w.myLineup = autoLineup(w, w.myTeamId, w.myLineup.formation);
  w.myLineup.tactic = keepTactic;
  w.finance = { income: 0, spent: 0 };
  // 어느 팀에도 없고 시장에도 없는 자유계약 선수는 정리합니다 (세이브 크기)
  const listed = new Set((w.market || []).map((e) => e.pid));
  for (const [id, p] of Object.entries(w.players)) {
    if (!p.teamId && !listed.has(id)) delete w.players[id];
  }
  w.market = buildMarket(w);
  w.offers = [];
  w.offerSeq = 1;
  w.loans = [];
  w.lastGrowth = null;
  addNews(w, `${w.season}시즌 개막. 이적 시장이 열렸습니다.`);
  return { summary: s, prize: myPrize + cupPrize, cupPrize, growth: growth.sort((a, b) => (b.to - b.from) - (a.to - a.from)).slice(0, 8), retired, loansBack };
}

export function addNews(w, text) {
  w.news.unshift({ text, season: w.season, at: Date.now() });
  w.news = w.news.slice(0, 40);
}

/* ─────────────────────────── 저장 ─────────────────────────── */
export function saveWorld(w) {
  try { local.set(SAVE_KEY, { ...w, savedAt: Date.now() }); return true; } catch { return false; }
}
export function loadWorld() {
  const w = local.get(SAVE_KEY, null);
  if (!w || w.version !== SAVE_VERSION) return null;
  if (!w.myTeamId || !w.teams?.[w.myTeamId]) return null;
  // 구버전 필드 보정
  for (const t of Object.values(w.teams)) if (!t.recent) t.recent = [];
  for (const p of Object.values(w.players)) if (!p.season) p.season = freshSeasonStats();
  // 4단계 필드가 없던 세이브 — 잠재력·훈련·오퍼·임대·성장 기록을 자동 보정합니다.
  if (!Array.isArray(w.offers)) w.offers = [];
  if (!Array.isArray(w.loans)) w.loans = [];
  if (!Array.isArray(w.transfers)) w.transfers = [];
  if (!Array.isArray(w.market)) w.market = [];
  if (!w.news) w.news = [];
  if (!w.history) w.history = [];
  if (!w.finance) w.finance = { income: 0, spent: 0 };
  if (!Number.isFinite(w.offerSeq)) w.offerSeq = (w.offers.length || 0) + 1;
  if (!('lastGrowth' in w)) w.lastGrowth = null;
  for (const t of Object.values(w.teams)) {
    if (!TRAINING[t.training]) t.training = 'balanced';
    if (!Number.isFinite(t.budget)) t.budget = 100;
    if (!Number.isFinite(t.wage)) t.wage = Math.max(1000, Math.round((teamWageTotal(w, t.id) * 1.15) / 100) * 100);
    if (!t.tactic) t.tactic = {};
    if (!t.squad) t.squad = [];
  }
  for (const p of Object.values(w.players)) {
    if (!Number.isFinite(p.ovr)) p.ovr = overall(p);
    if (!Number.isFinite(p.pot)) p.pot = clamp(p.ovr + (p.age <= 23 ? 10 : p.age <= 27 ? 5 : 1), p.ovr, 97);
    if (!Array.isArray(p.growthLog)) p.growthLog = [];
    if (!Number.isFinite(p.value)) p.value = valueOf(p);
    if (!Number.isFinite(p.wage)) p.wage = wageOf(p);
    if (!Number.isFinite(p.num)) p.num = 0;
    if (p.teamId && !w.teams[p.teamId]) p.teamId = null;
  }
  // 내 팀 명단에 없는 임대 표시는 정리
  for (const p of Object.values(w.players)) {
    if (p.loan && p.teamId !== w.myTeamId) delete p.loan;
  }
  w.loans = w.loans.filter((l) => w.players[l.pid] && w.players[l.pid].teamId === w.myTeamId);
  w.offers = w.offers.filter((o) => w.players[o.pid] && w.players[o.pid].teamId === w.myTeamId && w.teams[o.from]);
  // 역할·팀 성향이 없는 세이브(역할 도입 전)는 포지션 기본값으로 채웁니다.
  const slots = (FORMATIONS[w.myLineup?.formation] || FORMATIONS['4-3-3']).slots;
  if (!w.myLineup) w.myLineup = autoLineup(w, w.myTeamId, w.teams[w.myTeamId].formation);
  w.myLineup.roles = resolveRoles(w.myLineup.roles, slots);
  w.myLineup.tactic = { line: 0, pass: 0, press: 0, route: 0, mentality: 0, ...(w.myLineup.tactic || {}) };
  w.myLineup.tactic.mentality = Number(w.myLineup.tactic.mentality) || 0;
  // 세트피스 지시가 없던 세이브(3단계 이전)는 기본값(중앙 집중·직접 슈팅)으로 이어집니다.
  w.myLineup.setpiece = resolveSetPiece(w.myLineup.setpiece);
  for (const t of Object.values(w.teams)) {
    t.tactic = { mentality: 0, ...(t.tactic || {}) };
    t.setpiece = resolveSetPiece(t.setpiece);
  }
  return w;
}
export function wipeWorld() { local.remove(SAVE_KEY); }

/* ─────────────────────────── 표시 도우미 ─────────────────────────── */
export const fmt = (v) => (Math.round(v * 10) / 10).toLocaleString('ko-KR');
export const fmtWon = (v) => v.toLocaleString('ko-KR');
export function resultOf(w, round, teamId) {
  if (round.type === 'league') {
    const f = round.fixtures.find((x) => x.home === teamId || x.away === teamId);
    if (!f || !f.played) return null;
    const mine = f.home === teamId ? f.hg : f.ag, opp = f.home === teamId ? f.ag : f.hg;
    return { mine, opp, res: mine > opp ? 'W' : mine < opp ? 'L' : 'D', home: f.home === teamId, oppId: f.home === teamId ? f.away : f.home };
  }
  const st = w.cup.stages[round.stage];
  const m = st?.matches.find((x) => x.home === teamId || x.away === teamId);
  if (!m || !m.played) return null;
  const mine = m.home === teamId ? m.hg : m.ag, opp = m.home === teamId ? m.ag : m.hg;
  return { mine, opp, res: mine > opp ? 'W' : mine < opp ? 'L' : 'D', home: m.home === teamId, oppId: m.home === teamId ? m.away : m.home };
}
export function myFixtures(w) {
  const out = [];
  for (const r of w.calendar) {
    if (r.type === 'league') {
      const f = r.fixtures.find((x) => x.home === w.myTeamId || x.away === w.myTeamId);
      if (f) out.push({ round: r, fixture: f });
    } else {
      const st = w.cup.stages[r.stage];
      if (!st) continue;
      const m = st.matches.find((x) => x.home === w.myTeamId || x.away === w.myTeamId);
      if (m) out.push({ round: r, fixture: m });
    }
  }
  return out;
}
