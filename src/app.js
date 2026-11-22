// 앱 셸 — 상태·화면 전환·감독 조작
import { TEAM_DEFS, FORMATIONS } from './data.js';
import * as W from './world.js';
import { local } from './store.js';
import { renderSelect, renderHub, renderSeason, renderModal, applyTeamColors } from './views.js';
import { mountMatch } from './matchview.js';
import { Match, applyResult, lineupFor } from './match.js';
import { roleLabel, roleEffect, nextRole, mentalityOf, mentalityEffect } from './tactics.js';

const defs = {};
for (const t of TEAM_DEFS) defs[t.id] = t;

const state = {
  world: null, savedGame: null, view: 'select', tab: 'schedule',
  selSlot: 0, selPid: null, selBench: null, modal: null, roleSlot: null,
  seasonResult: null, seasonPhase: 'preview', pending: null,
};

const api = {
  get world() { return state.world; },
  get savedGame() { return state.savedGame; },
  get state() { return state; },
  defs,
  save: () => { if (state.world) W.saveWorld(state.world); },
  toast,
  endMatch,
};

/* ─────────────────────────── 시작 ─────────────────────────── */
export function init() {
  // 화면 오류를 조용히 삼키지 않고 한곳에 모읍니다 (점검·문의 대응용)
  window.__fm = window.__fm || { errors: [] };
  window.addEventListener('error', (e) => window.__fm.errors.push(String(e.message || e)));
  window.addEventListener('unhandledrejection', (e) => window.__fm.errors.push(String(e.reason)));
  const theme = local.get('theme', 'day');
  document.documentElement.setAttribute('data-theme', theme === 'night' ? 'night' : 'day');
  state.savedGame = W.loadWorld();
  document.addEventListener('click', onClick);
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && state.modal) { state.modal = null; render(); }
  });
  document.getElementById('btn-theme').addEventListener('click', toggleTheme);
  render();
}

function toggleTheme() {
  const cur = document.documentElement.getAttribute('data-theme');
  const next = cur === 'night' ? 'day' : 'night';
  document.documentElement.setAttribute('data-theme', next);
  local.set('theme', next);
  document.getElementById('btn-theme').textContent = next === 'night' ? '☀' : '☾';
  document.getElementById('btn-theme').setAttribute('aria-label', next === 'night' ? '낮 화면으로 바꾸기' : '밤 화면으로 바꾸기');
  document.documentElement.dispatchEvent(new Event('fm-theme'));
}

/* ─────────────────────────── 렌더 ─────────────────────────── */
function render() {
  const root = document.getElementById('app');
  const y = window.scrollY;
  if (state.world && state.view !== 'match') W.ensureProgress(state.world);
  document.body.dataset.view = state.view;
  if (state.view === 'select') root.innerHTML = renderSelect(api);
  else if (state.view === 'hub') root.innerHTML = renderHub(api);
  else if (state.view === 'season') root.innerHTML = renderSeason(api);
  if (state.view !== 'match') {
    const modal = renderModal(api);
    if (modal) root.insertAdjacentHTML('beforeend', modal);
  }
  applyTeamColors(root, state.world);
  updateHeader();
  if (state.view !== 'match') window.scrollTo(0, Math.min(y, root.scrollHeight));
}

function updateHeader() {
  const nameEl = document.querySelector('.brand b');
  const subEl = document.querySelector('.brand small');
  if (!nameEl) return;
  if (state.world) {
    const t = W.myTeam(state.world);
    nameEl.textContent = t.name;
    subEl.textContent = `GOODWAY APPS · FOOTBALL MANAGER · ${state.world.season}시즌`;
  } else {
    nameEl.textContent = 'Football Manager';
    subEl.textContent = 'GOODWAY APPS · FM';
  }
  const btn = document.getElementById('btn-theme');
  if (btn) {
    const night = document.documentElement.getAttribute('data-theme') === 'night';
    btn.textContent = night ? '☀' : '☾';
  }
  document.title = state.world ? `${state.world.teams[state.world.myTeamId].name} · Football Manager` : 'Football Manager · GOODWAY APPS';
}

function toast(msg, kind = 'info') {
  const el = document.getElementById('toast');
  if (!el) return;
  el.textContent = msg;
  el.dataset.kind = kind;
  el.classList.add('on');
  clearTimeout(toast._t);
  toast._t = setTimeout(() => el.classList.remove('on'), 2600);
}

/* ─────────────────────────── 클릭 처리 ─────────────────────────── */
function onClick(e) {
  const el = e.target.closest('[data-act]');
  if (!el) return;
  const act = el.dataset.act;
  const w = state.world;
  const keepScroll = () => window.scrollTo(0, window.scrollY);

  switch (act) {
    case 'team': state.modal = { kind: 'team', team: el.dataset.team }; render(); break;
    case 'team-sign':
      if (state.world || state.savedGame) { state.modal = { kind: 'overwrite', team: el.dataset.team }; render(); }
      else newGame(el.dataset.team);
      break;
    case 'overwrite-confirm': state.modal = null; newGame(el.dataset.team); break;
    case 'continue':
      if (state.savedGame) { state.world = state.savedGame; state.view = 'hub'; state.tab = 'schedule'; state.selSlot = 0; render(); }
      break;
    case 'new-game':
      if (w) state.modal = { kind: 'new-game' };
      else { state.view = 'select'; state.modal = null; }
      render(); break;
    case 'new-game-confirm': W.wipeWorld(); state.world = null; state.savedGame = null; state.modal = null; state.view = 'select'; render(); break;
    case 'modal-close': if (el.classList.contains('modal-back') && e.target !== el) break; state.modal = null; render(); break;
    case 'tab': state.tab = el.dataset.tab; state.selPid = null; state.selSlot = 0; state.modal = null; render(); break;

    case 'formation':
      if (!w) break;
      W.setFormation(w, el.dataset.formation); state.selSlot = 0; state.selPid = null; api.save(); keepScroll(); render(); break;
    case 'slot':
      if (!w) break;
      state.selSlot = Number(el.dataset.slot);
      state.roleSlot = state.selSlot;
      state.selPid = w.myLineup.starters[state.selSlot] || null;
      keepScroll(); render(); break;
    case 'role': {
      if (!w) break;
      const idx = Number(el.dataset.slot);
      const got = W.setRole(w, idx, el.dataset.role);
      if (!got) break;
      state.roleSlot = idx;
      api.save(); keepScroll(); render();
      toast(`역할 · ${roleLabel(got)} — ${roleEffect(got)}`, 'ok');
      break;
    }
    case 'role-cycle': {
      if (!w) break;
      const idx = Number(el.dataset.slot);
      const slots = FORMATIONS[w.myLineup.formation].slots;
      const label = slots[idx]?.label;
      if (!label || slots[idx].pos === 'GK') break;
      const cur = W.lineupInfo(w).roles[idx];
      const got = W.setRole(w, idx, nextRole(label, cur));
      if (!got) break;
      state.roleSlot = idx;
      api.save(); keepScroll(); render();
      toast(`역할 · ${roleLabel(got)} — ${roleEffect(got)}`, 'ok');
      break;
    }
    case 'mentality': {
      if (!w) break;
      const v = Number(el.dataset.val);
      w.myLineup.tactic.mentality = v;
      api.save(); keepScroll(); render();
      toast(`팀 성향 · ${mentalityOf(v).name} — ${mentalityEffect(v, true)}`, 'ok');
      break;
    }
    case 'bench': {
      if (!w || state.selSlot == null) break;
      W.swapPlayers(w, state.selSlot, el.dataset.pid);
      state.selSlot = null; state.selPid = el.dataset.pid;
      api.save(); keepScroll(); render(); break;
    }
    case 'auto-lineup': {
      if (!w) break;
      const tac = { ...w.myLineup.tactic };
      const l = W.autoLineup(w, w.myTeamId, w.myLineup.formation);
      l.tactic = tac;
      w.myLineup = l;
      api.save(); keepScroll(); render(); toast('포지션에 맞춰 자동 선발했습니다.'); break;
    }
    case 'tactic': {
      if (!w) break;
      w.myLineup.tactic[el.dataset.axis] = Number(el.dataset.val);
      api.save(); keepScroll(); render(); break;
    }
    case 'player': state.selPid = el.dataset.pid; state.selBench = el.dataset.pid; keepScroll(); render(); break;

    case 'sign': {
      if (!w) break;
      const entry = w.market.find((x) => x.pid === el.dataset.pid);
      if (!entry) break;
      const r = W.signPlayer(w, entry);
      if (!r.ok) { toast(r.why, 'warn'); break; }
      api.save(); render(); toast('영입 완료! 선수단에 합류했습니다.', 'ok'); break;
    }
    case 'sell': state.modal = { kind: 'sell', pid: el.dataset.pid }; render(); break;
    case 'sell-confirm': {
      if (!w) break;
      const r = W.sellPlayer(w, el.dataset.pid);
      state.modal = null;
      if (!r.ok) toast(r.why, 'warn');
      else { api.save(); toast(`방출 완료 — ${W.fmt(r.price)}억이 들어왔습니다.`, 'ok'); }
      render(); break;
    }

    case 'play': startMatch(false); break;
    case 'instant': startMatch(true); break;
    case 'season-end':
      if (!w) break;
      state.seasonResult = { summary: W.seasonSummary(w), season: w.season };
      state.seasonPhase = 'preview'; state.view = 'season'; render(); break;
    case 'next-season': {
      if (!w) break;
      const seasonNo = w.season;
      const r = W.advanceSeason(w);
      state.seasonResult = { ...r, season: seasonNo };
      state.seasonPhase = 'done';
      api.save(); window.scrollTo(0, 0); render(); break;
    }
    case 'close-season':
      state.view = 'hub'; state.tab = 'schedule'; state.seasonResult = null; state.selPid = null; state.selSlot = 0;
      render(); break;
    default: break;
  }
}

/* ─────────────────────────── 커리어 ─────────────────────────── */
function newGame(teamId) {
  if (!defs[teamId]) return;
  state.world = W.createWorld(teamId, Date.now());
  state.view = 'hub'; state.tab = 'schedule'; state.modal = null; state.selSlot = 0; state.selPid = null;
  W.saveWorld(state.world);
  render();
  toast(`${state.world.teams[teamId].name} 감독 취임! 첫 경기를 준비하세요.`, 'ok');
}

/* ─────────────────────────── 경기 ─────────────────────────── */
function startMatch(instant) {
  const w = state.world;
  if (!w) return;
  W.ensureProgress(w);
  const nx = W.userNextMatch(w);
  if (!nx) { toast('이번 시즌 남은 경기가 없습니다.'); return; }
  const { round, fixture } = nx;
  // 부상·정지 선수가 선발에 남아 있으면 뛸 수 있는 선수로 정리합니다 (경고 없이 그대로 뛰던 버그)
  const before = (w.myLineup.starters || []).slice();
  W.fillLineup(w);
  const changed = before.filter((id, i) => id && w.myLineup.starters[i] !== id);
  if (changed.length) {
    W.saveWorld(w);
    toast(`출전할 수 없는 선수 ${changed.length}명을 자동으로 교체했습니다.`, 'warn');
  }
  const homeId = fixture.home, awayId = fixture.away;
  const userSide = homeId === w.myTeamId ? 'home' : 'away';
  const seed = `${w.seed}-s${w.season}-r${round.no}-h${homeId}-a${awayId}`;
  const m = new Match({
    world: w, homeId, awayId,
    homeLineup: lineupFor(w, homeId),
    awayLineup: lineupFor(w, awayId),
    seed, cup: round.type === 'cup', userSide,
  });
  const meta = {
    label: round.type === 'cup' ? (W.CUP_LABEL[round.stage] || '컵') : `리그 ${round.leagueRound}R`,
    cup: round.type === 'cup', round, fixture,
  };
  if (instant) {
    let guard = 0;
    while (!m.done && guard < 3000) { m.tick(); guard++; }
    if (!m.done) m.finish();
  }
  state.pending = { m, meta };
  state.view = 'match';
  document.body.dataset.view = 'match';
  updateHeader();
  mountMatch(api, m, meta);
  applyTeamColors(document.getElementById('app'), w);
}

function endMatch(m, meta) {
  const w = state.world;
  if (!w) return;
  const { round, fixture } = meta;
  applyResult(w, m);
  if (round.type === 'league') {
    fixture.played = true; fixture.hg = m.score.home; fixture.ag = m.score.away;
    W.finishRound(w, round);
    W.playOtherFixtures(w, round, true);
  } else {
    const stage = w.cup.stages[round.stage];
    const cm = stage?.matches.find((x) => x.home === fixture.home && x.away === fixture.away) || fixture;
    cm.played = true; cm.hg = m.score.home; cm.ag = m.score.away; cm.aet = !!m.aet;
    cm.winner = m.result?.winner === 'home' ? cm.home : m.result?.winner === 'away' ? cm.away : (m.score.home > m.score.away ? cm.home : cm.away);
    cm.pens = m.pens ? m.pens.text : null;
    W.finishRound(w, round);
    W.playOtherFixtures(w, round, true);
  }
  const oppId = round.type === 'league'
    ? (fixture.home === w.myTeamId ? fixture.away : fixture.home)
    : (fixture.home === w.myTeamId ? fixture.away : fixture.home);
  const oppName = w.teams[oppId]?.short || '';
  const res = m.score.home === m.score.away ? '무' : (m.score.home > m.score.away) === (fixture.home === w.myTeamId) ? '승' : '패';
  W.addNews(w, `${meta.label} ${oppName}전 ${m.score.home}-${m.score.away} ${res}${m.pens ? ` (PK ${m.pens.text})` : ''}`);
  W.saveWorld(w);
  state.pending = null;
  state.view = 'hub'; state.tab = 'schedule'; state.selPid = null; state.selSlot = 0;
  window.scrollTo(0, 0);
  render();
  toast(`${meta.label} ${res === '승' ? '승리!' : res === '무' ? '무승부' : '패배'} ${m.score.home}-${m.score.away}`, res === '승' ? 'ok' : res === '패' ? 'warn' : 'info');
}
