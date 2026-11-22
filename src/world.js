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
  };
  for (const def of TEAM_DEFS) {
    const squad = buildSquad(rng, { ...def, power: def.power }, usedNames);
    w.teams[def.id] = {
      ...clone(def), squad: squad.map((p) => p.id), recent: [],
    };
    for (const p of squad) {
      p.id = `p${w.pidSeq++}`;
      p.teamId = def.id;
      p.pot = clamp(p.ovr + rint(rng, 0, p.age <= 23 ? 14 : p.age <= 27 ? 7 : 2), p.ovr, 97);
      p.season = freshSeasonStats();
      p.career = { apps: 0, goals: 0, assists: 0, seasons: 0 };
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
    for (const p of sq) {
      p.season.apps += 1;
      let r = 6.2 + gauss(rng) * 0.42 + (p.ovr - 70) * 0.012;
      const g = picked.filter((x) => x.scorer?.id === p.id).length;
      const a = picked.filter((x) => x.assist?.id === p.id).length;
      r += g * 1.05 + a * 0.6;
      if (p.pos === 'GK' || p.pos === 'DF') r -= conceded * 0.09;
      p.season.ratingSum += clamp(r, 4.2, 9.8);
      p.season.ratingCount += 1;
    }
    if (conceded === 0) {
      const gk = sq.find((p) => p.pos === 'GK');
      if (gk) gk.season.cleanSheets = (gk.season.cleanSheets || 0) + 1;
    }
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
export function buildMarket(w) {
  const rng = makeRng(`market-${w.seed}-${w.season}`);
  const out = [];
  for (const t of Object.values(w.teams)) {
    if (t.id === w.myTeamId) continue;
    const sq = squadOf(w, t.id).slice().sort((a, b) => b.ovr - a.ovr);
    const sells = shuffle(rng, sq.slice(2)).slice(0, 2);
    for (const p of sells) {
      out.push({ pid: p.id, from: t.id, price: Math.round(valueOf(p) * (1.05 + rng() * 0.5) * 10) / 10 });
    }
  }
  // 자유계약 선수 4명
  const used = new Set(Object.values(w.players).map((p) => p.name));
  for (let i = 0; i < 4; i++) {
    const ovr = rint(rng, 62, 78);
    const pos = pick(rng, ['DF', 'MF', 'FW', 'GK']);
    const stats = {};
    for (const k of STAT_KEYS) stats[k] = clamp(Math.round(ovr - 8 + gauss(rng) * 6 + (k === 'gk' && pos !== 'GK' ? -45 : 0)), 25, 95);
    const p = { id: `p${w.pidSeq++}`, name: '', pos, age: rint(rng, 19, 34), num: 0, stats, teamId: null, form: 0, season: freshSeasonStats(), career: { apps: 0, goals: 0, assists: 0, seasons: 0 } };
    p.name = freeName(rng, used);
    p.ovr = overall(p);
    p.pot = clamp(p.ovr + rint(rng, 0, p.age < 24 ? 12 : 3), p.ovr, 95);
    p.value = valueOf(p);
    p.wage = wageOf(p);
    w.players[p.id] = p;
    out.push({ pid: p.id, from: null, price: 0 });
  }
  return shuffle(rng, out);
}

function freeName(rng, used) {
  const pool = ['문태호', '류재성', '백승주', '허정욱', '남기훈', '심우재', '노현석', '하민철', '곽동현', '성지훈', '차우빈', '주태건'];
  const free = pool.filter((n) => !used.has(n));
  return free.length ? pick(rng, free) : `${pick(rng, pool)}${rint(rng, 2, 9)}`;
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
  addNews(w, `${p.name}(${p.pos}, ${p.ovr}) 선수를 ${entry.price ? fmt(entry.price) + '억' : '자유계약'}에 영입했습니다.`);
  return { ok: true };
}

export function sellPlayer(w, pid) {
  const t = myTeam(w);
  const p = w.players[pid];
  if (!p) return { ok: false, why: '선수를 찾을 수 없습니다.' };
  if (t.squad.length <= 15) return { ok: false, why: '선수단이 15명 이하가 되면 방출할 수 없습니다.' };
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
  return { ok: true, price };
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
    let delta = 0;
    if (p.age <= 22) delta = rint(Math.random, 0, 3);
    else if (p.age <= 25) delta = rint(Math.random, 0, 2);
    else if (p.age <= 28) delta = rint(Math.random, -1, 1);
    else if (p.age <= 31) delta = rint(Math.random, -2, 0);
    else delta = rint(Math.random, -4, -1);
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
      const p = { id: `p${w.pidSeq++}`, name: freeName(rng, new Set(Object.values(w.players).map((x) => x.name))), pos, age: rint(rng, 18, 19), num: 0, stats, teamId: t.id, form: 0, season: freshSeasonStats(), career: { apps: 0, goals: 0, assists: 0, seasons: 0 } };
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
  w.market = buildMarket(w);
  addNews(w, `${w.season}시즌 개막. 이적 시장이 열렸습니다.`);
  return { summary: s, prize: myPrize + cupPrize, cupPrize, growth: growth.sort((a, b) => (b.to - b.from) - (a.to - a.from)).slice(0, 8), retired };
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
