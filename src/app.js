// 앱 셸 — 상태·화면 전환·감독 조작
import { TEAM_DEFS, FORMATIONS, sizeOfFormation, formationsFor } from './data.js';
import { KL_TEAMS, KL_BY_ID } from './kleague2026.js';
import * as W from './world.js';
import { local } from './store.js';
import { renderSelect, renderHub, renderSeason, renderModal, applyTeamColors } from './views.js';
import { renderCustom, renderCustomResult } from './customviews.js';
import * as C from './custom.js';
import { mountMatch } from './matchview.js';
import { Match, applyResult, lineupFor } from './match.js';
import { roleLabel, roleEffect, nextRole, mentalityOf, mentalityEffect, setPieceLabel } from './tactics.js';
import { entryFromMatch, recordEntries } from './history.js';
import { addPreset, overwritePreset, deletePreset, readPresets, applyPreset, applyMessage } from './presets.js';
import { saveSlot, loadSlot, deleteSlot, exportPayload, exportFileName, parseSaveFile, slotBytes } from './saves.js';

const defs = {};
for (const t of TEAM_DEFS) defs[t.id] = t;
for (const t of KL_TEAMS) defs[t.id] = t;

const state = {
  world: null, savedGame: null, view: 'select', tab: 'schedule',
  selSlot: 0, selPid: null, selBench: null, modal: null, roleSlot: null,
  seasonResult: null, seasonPhase: 'preview', pending: null,
  // 구단 선택 · 디비전 탭 · 선수단 필터
  pickMode: 'kleague', pickDiv: 4, divTab: null, marketDiv: 0,
  posFilter: 'ALL', sortKey: 'ovr', sortDir: -1,
  // 커스텀 매치업 — 팀 빌더·공유·가상 경기 (커리어와 분리)
  custom: { tab: 'build', teamId: null, team: null, bulk: false, bulkText: '', codeInput: '', share: { busy: false }, sharePick: null, vsA: null, vsB: null, msg: '', longLink: '', confirmDelete: null, clickSuppress: 0, tacticsOpen: true, confirmDedupe: null },
  matchup: { oppKind: 'kl', oppId: 'geumsan', oppTeam: null, side: 'home' },
  customResult: null, customMatch: null, headerOverride: null,
};

const api = {
  get world() { return state.world; },
  get savedGame() { return state.savedGame; },
  get state() { return state; },
  defs,
  save: () => {
    if (!state.world) return false;
    const ok = W.saveWorld(state.world);
    if (!ok) toast('브라우저 저장 공간이 부족해 자동 저장하지 못했습니다. 저장/불러오기에서 슬롯을 정리하거나 JSON으로 내보내 주세요.', 'warn');
    return ok;
  },
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
  if (state.savedGame && W.isKL(state.savedGame)) {
    state.pickMode = 'kleague';
    state.pickDiv = W.divOf(state.savedGame, state.savedGame.myTeamId) || 1;
  }
  document.addEventListener('click', onClick);
  // 자유 대형 보드 — 마우스·터치 모두 pointer 이벤트 하나로 끌어 옮깁니다
  document.addEventListener('pointerdown', onBoardPointerDown);
  document.addEventListener('pointermove', onBoardPointerMove);
  document.addEventListener('pointerup', onBoardPointerEnd);
  document.addEventListener('pointercancel', onBoardPointerEnd);
  document.addEventListener('input', onFilterInput);
  document.addEventListener('input', onCustomInput);
  document.addEventListener('change', onCustomChange);
  document.addEventListener('change', onFileChange);
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && state.modal) { state.modal = null; render(); return; }
    // 줄 전체를 누르는 버튼(치른 경기 행 등)은 키보드 Enter·Space 로도 열립니다
    if ((e.key === 'Enter' || e.key === ' ') && e.target.matches?.('[data-act][tabindex]')) {
      e.preventDefault();
      e.target.click();
    }
  });
  document.getElementById('btn-theme').addEventListener('click', toggleTheme);
  render();
  openFromUrl();
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
  else if (state.view === 'custom') root.innerHTML = state.customResult ? renderCustomResult(api) : renderCustom(api);
  else if (state.view === 'hub') root.innerHTML = renderHub(api);
  else if (state.view === 'season') root.innerHTML = renderSeason(api);
  if (state.view !== 'match') {
    const modal = renderModal(api);
    if (modal) root.insertAdjacentHTML('beforeend', modal);
  }
  applyTeamColors(root, colorWorld());
  updateHeader();
  if (state.view !== 'match') window.scrollTo(0, Math.min(y, root.scrollHeight));
}

/* 팀 색을 칠할 때 쓰는 팀 목록 — 커리어 구단 + 내가 만든 커스텀 팀(+ 진행 중인 커스텀 경기의 두 팀) */
function colorWorld() {
  const map = { ...(state.world?.teams || defs) };
  for (const t of C.readTeams().list) map[t.id] = { id: t.id, primary: t.colors.primary, secondary: t.colors.secondary, ink: '#101014' };
  const cm = state.customMatch?.world || state.customResult?.m?.world;
  if (cm) Object.assign(map, cm.teams);
  return { teams: map };
}

function updateHeader() {
  const nameEl = document.querySelector('.brand b');
  const subEl = document.querySelector('.brand small');
  if (!nameEl) return;
  if (state.headerOverride) {
    nameEl.textContent = state.headerOverride.name;
    subEl.textContent = state.headerOverride.sub;
    document.title = `${state.headerOverride.name} · Football Manager`;
    const b = document.getElementById('btn-theme');
    if (b) b.textContent = document.documentElement.getAttribute('data-theme') === 'night' ? '☀' : '☾';
    return;
  }
  if (state.world) {
    const t = W.myTeam(state.world);
    nameEl.textContent = t.name;
    subEl.textContent = `GOODWAY APPS · FOOTBALL MANAGER · ${W.seasonLabel(state.world)}${W.isKL(state.world) ? ` · ${W.divName(state.world, W.divOf(state.world, state.world.myTeamId))}` : ''}`;
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
/* 검색 입력은 화면을 다시 그리지 않고 줄만 숨깁니다 (입력 중 포커스 유지). */
function onFilterInput(e) {
  const el = e.target.closest('[data-filter-input]');
  if (!el) return;
  const q = el.value.trim().toLowerCase();
  const scope = el.closest('.card') || document;
  scope.querySelectorAll('[data-fname]').forEach((row) => {
    const name = (row.getAttribute('data-fname') || '').toLowerCase();
    row.hidden = !!q && !name.includes(q);
  });
}

function onClick(e) {
  // 보드에서 칩을 끌고 난 뒤 따라오는 click 은 무시합니다 (역할이 바뀌지 않게)
  // — 끌던 그 칩에 한해, 손을 뗀 직후(0.8초)의 click 만 무시하고 다음 누름은 그대로 받습니다
  if (state.custom.clickSuppress) {
    const sup = state.custom.clickSuppress;
    state.custom.clickSuppress = 0;
    const chip = e.target?.closest?.('[data-chip]');
    if (chip && chip.dataset.chip === sup.chip && Date.now() - sup.at < 800) return;
  }
  const el = e.target.closest('[data-act]');
  if (!el) return;
  const act = el.dataset.act;
  const w = state.world;
  const keepScroll = () => window.scrollTo(0, window.scrollY);

  switch (act) {
    /* 로고 — 앱 첫 화면. 예전에는 허브(bmrgoodway.github.io)로 나갔습니다. */
    case 'home': {
      e.preventDefault();
      if (state.view === 'match') { toast('경기 중에는 이동하지 않습니다. 경기를 마친 뒤에 돌아올 수 있습니다.'); break; }
      state.modal = null;
      if (state.world) { state.view = 'hub'; state.tab = 'schedule'; state.selPid = null; state.selSlot = null; }
      else state.view = 'select';
      window.scrollTo(0, 0);
      render();
      break;
    }
    /* 저장 / 불러오기 */
    case 'saves':
      if (state.view === 'match') { toast('경기 중에는 저장/불러오기를 열 수 없습니다. 경기를 마친 뒤 열어 주세요.'); break; }
      state.modal = { kind: 'saves' }; render(); break;
    case 'slot-save': {
      const i = Number(el.dataset.i);
      if (!w) { toast('저장할 커리어가 없습니다.', 'warn'); break; }
      if (slotBytes(i) > 0) { state.modal = { kind: 'saves', confirm: { op: 'save', i } }; render(); }
      else doSlotSave(i);
      break;
    }
    case 'slot-load': {
      const i = Number(el.dataset.i);
      if (slotBytes(i) > 0) { state.modal = { kind: 'saves', confirm: { op: 'load', i } }; render(); }
      break;
    }
    case 'slot-delete': {
      const i = Number(el.dataset.i);
      if (slotBytes(i) > 0) { state.modal = { kind: 'saves', confirm: { op: 'delete', i } }; render(); }
      break;
    }
    case 'slot-cancel':
      if (state.modal) { state.modal.confirm = null; render(); }
      break;
    case 'slot-confirm': {
      const i = Number(el.dataset.i);
      const op = el.dataset.op;
      if (op === 'save') doSlotSave(i);
      else if (op === 'load') doSlotLoad(i);
      else if (op === 'delete') {
        const r = deleteSlot(i);
        state.modal = { kind: 'saves' };
        if (r.ok) { render(); toast(`슬롯 ${i + 1}을(를) 비웠습니다.`, 'ok'); }
        else { render(); toast(r.why, 'warn'); }
      } else if (op === 'import') {
        const pend = state.pendingImport;
        if (!pend?.world) { toast('불러올 파일이 없습니다.', 'warn'); break; }
        state.pendingImport = null;
        adoptWorld(pend.world, `파일에서 불러왔습니다`);
      }
      break;
    }
    case 'save-export':
      if (w) exportSave(w);
      else toast('내보낼 커리어가 없습니다.', 'warn');
      break;
    case 'save-import':
      document.getElementById('save-file')?.click();
      break;
    /* 전술·명단 프리셋 */
    case 'preset-save': {
      if (!w) break;
      const input = document.getElementById('preset-name');
      const name = (input?.value || '').trim();
      if (!name) { toast('프리셋 이름을 먼저 적어 주세요.', 'warn'); input?.focus(); break; }
      const r = addPreset(w, name);
      if (!r.ok) { toast(r.why, 'warn'); break; }
      api.save(); keepScroll(); render();
      toast(`프리셋 '${r.preset.name}'을(를) 저장했습니다.`, 'ok');
      break;
    }
    case 'preset-load': {
      if (!w) break;
      const p = readPresets().list.find((x) => x.id === el.dataset.id);
      if (!p) { toast('프리셋을 찾을 수 없습니다.', 'warn'); break; }
      const res = applyPreset(w, p);
      if (!res.ok) { toast('프리셋을 불러오지 못했습니다.', 'warn'); break; }
      api.save(); keepScroll(); render();
      toast(applyMessage(p, res), res.changed || res.empty ? 'warn' : 'ok');
      if (res.notes?.length) setTimeout(() => toast(res.notes.join(' '), 'info'), 2700);
      break;
    }
    case 'preset-overwrite': {
      if (!w) break;
      const r = overwritePreset(w, el.dataset.id);
      if (!r.ok) { toast(r.why || '덮어쓰지 못했습니다.', 'warn'); break; }
      api.save(); keepScroll(); render();
      toast(`프리셋 '${r.preset.name}'을(를) 지금 설정으로 덮어썼습니다.`, 'ok');
      break;
    }
    case 'preset-delete':
      state.modal = { kind: 'preset-delete', id: el.dataset.id };
      render(); break;
    case 'preset-delete-confirm': {
      const r = deletePreset(el.dataset.id);
      state.modal = null;
      render();
      toast(r.ok ? '프리셋을 삭제했습니다.' : '프리셋을 삭제하지 못했습니다.', r.ok ? 'ok' : 'warn');
      break;
    }
    /* 이전 경기 결과 */
    case 'match': {
      if (!w) break;
      const back = el.dataset.back === 'club' && el.dataset.backTeam ? { kind: 'club', team: el.dataset.backTeam } : null;
      state.modal = { kind: 'match', round: Number(el.dataset.round), home: el.dataset.home, away: el.dataset.away, back };
      render();
      break;
    }
    case 'pick-mode':
      if (el.dataset.mode === 'matchup') { openCustom(); break; }
      state.pickMode = el.dataset.mode === 'kleague' ? 'kleague' : 'custom';
      state.pickDiv = state.pickMode === 'kleague' ? 4 : 1;
      render(); break;
    case 'pick-div':
      state.pickDiv = Number(el.dataset.div) || 1;
      render(); break;
    case 'divtab':
      state.divTab = Number(el.dataset.div) || 1;
      keepScroll(); render(); break;
    case 'pos-filter':
      state.posFilter = el.dataset.pos || 'ALL';
      keepScroll(); render(); break;
    case 'sort': {
      const k = el.dataset.key || 'ovr';
      if (state.sortKey === k) state.sortDir = state.sortDir === 1 ? -1 : 1;
      else { state.sortKey = k; state.sortDir = k === 'name' || k === 'age' ? 1 : -1; }
      keepScroll(); render(); break;
    }
    case 'market-div':
      state.marketDiv = Number(el.dataset.div) || 0;
      keepScroll(); render(); break;
    case 'club':
      if (w) state.modal = { kind: 'club', team: el.dataset.team };
      else state.modal = { kind: 'team', team: el.dataset.team };
      render(); break;
    case 'player-modal':
      if (w) state.modal = { kind: 'player', pid: el.dataset.pid, team: el.dataset.team || null, back: 'club' };
      render(); break;
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
    case 'setpiece': {
      if (!w) break;
      const got = W.setSetPiece(w, el.dataset.type, el.dataset.key);
      if (!got) break;
      api.save(); keepScroll(); render();
      toast(`세트피스 · ${el.dataset.type === 'corner' ? '코너킥' : '프리킥'} ${setPieceLabel(el.dataset.type, got[el.dataset.type])}`, 'ok');
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
    case 'training': {
      if (!w) break;
      const got = W.setTraining(w, el.dataset.key);
      if (!got) break;
      api.save(); keepScroll(); render();
      toast(`주간 훈련 · ${W.TRAINING[got].name} — ${W.TRAINING[got].note}`, 'ok');
      break;
    }
    case 'offer-accept': {
      if (!w) break;
      const r = W.acceptOffer(w, el.dataset.id);
      if (!r.ok) { toast(r.why, 'warn'); break; }
      api.save(); render(); toast(`오퍼 수락 — ${W.fmt(r.price)}억이 들어왔습니다.`, 'ok'); break;
    }
    case 'offer-reject': {
      if (!w) break;
      const r = W.rejectOffer(w, el.dataset.id);
      if (!r.ok) { toast(r.why, 'warn'); break; }
      api.save(); render(); toast('오퍼를 거절했습니다.', 'info'); break;
    }
    case 'offer-counter': {
      if (!w) break;
      state.modal = { kind: 'offer-counter', id: el.dataset.id }; render(); break;
    }
    case 'offer-counter-send': {
      if (!w) break;
      const r = W.counterOffer(w, el.dataset.id, Number(el.dataset.price));
      state.modal = null;
      if (r.ok) { api.save(); render(); toast(`역제안 수락 — ${W.fmt(r.price)}억에 이적했습니다.`, 'ok'); }
      else { api.save(); render(); toast(r.accepted === false ? r.why : (r.why || '역제안을 받아들이지 않았습니다.'), 'warn'); }
      break;
    }
    case 'negotiate': {
      if (!w) break;
      state.modal = { kind: 'negotiate', pid: el.dataset.pid }; render(); break;
    }
    case 'negotiate-send': {
      if (!w) break;
      const r = W.negotiate(w, el.dataset.pid, Number(el.dataset.price));
      state.modal = null;
      if (r.ok) { api.save(); render(); toast(`협상 성사 — ${W.fmt(r.price)}억에 영입했습니다.`, 'ok'); }
      else { api.save(); render(); toast(r.why || '상대가 거절했습니다.', 'warn'); }
      break;
    }
    case 'loan': {
      if (!w) break;
      const entry = w.market.find((x) => x.pid === el.dataset.pid);
      if (!entry) break;
      const r = W.loanPlayer(w, entry);
      if (!r.ok) { toast(r.why, 'warn'); break; }
      api.save(); render(); toast(`임대 영입 — 임대료 ${W.fmt(r.price)}억, 시즌이 끝나면 돌아갑니다.`, 'ok'); break;
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
      state.seasonResult = { summary: W.seasonSummary(w), season: w.season, year: w.year, label: W.seasonLabel(w) };
      state.seasonPhase = 'preview'; state.view = 'season'; render(); break;
    case 'next-season': {
      if (!w) break;
      const seasonNo = w.season;
      const prevYear = w.year;
      const prevLabel = W.seasonLabel(w);
      const r = W.advanceSeason(w);
      state.seasonResult = { ...r, season: seasonNo, seasonYear: prevYear, seasonLabel: prevLabel };
      state.seasonPhase = 'done';
      api.save(); window.scrollTo(0, 0); render(); break;
    }
    case 'close-season':
      state.view = 'hub'; state.tab = 'schedule'; state.seasonResult = null; state.selPid = null; state.selSlot = 0;
      render(); break;

    /* ─────────────── 커스텀 매치업 (커리어와 완전히 분리) ─────────────── */
    case 'cm-tab':
      state.custom.tab = el.dataset.tab || 'build';
      state.custom.msg = '';
      state.customResult = null;
      ensureCustomTeam();
      render(); break;
    case 'cm-back':
      state.customResult = null; state.custom.tab = 'build'; state.custom.msg = '';
      window.scrollTo(0, 0); render(); break;
    case 'cm-new': {
      const made = C.saveTeam(C.newTeam({ size: state.custom.team?.size || 11 }));
      if (!made.ok) { toast(made.why, 'warn'); break; }
      state.custom.team = made.team; state.custom.teamId = made.team.id; state.custom.tab = 'build';
      state.custom.msg = `새 팀을 만들었습니다 — 이름·색·선수를 채워 주세요.`; state.customResult = null;
      render(); toast('새 팀을 만들었습니다.', 'ok'); break;
    }
    case 'cm-duplicate': {
      const src = state.custom.team;
      if (!src) break;
      const made = C.saveTeam(C.normalizeTeam({ ...JSON.parse(JSON.stringify(src)), id: C.newTeamId(), name: `${src.name} 복사`, code: null, sharedKey: null }));
      if (!made.ok) { toast(made.why, 'warn'); break; }
      state.custom.team = made.team; state.custom.teamId = made.team.id;
      render(); toast('팀을 복제했습니다.', 'ok'); break;
    }
    case 'cm-delete': {
      const id = el.dataset.id;
      if (state.custom.confirmDelete !== id) { state.custom.confirmDelete = id; render(); break; }
      const r = C.deleteTeam(id);
      state.custom.confirmDelete = null;
      if (state.custom.sharePick === id) state.custom.sharePick = null;
      if (state.custom.vsA === id) state.custom.vsA = null;
      if (state.custom.vsB === id) state.custom.vsB = null;
      state.custom.team = null; state.custom.teamId = null;
      ensureCustomTeam();
      render(); toast(r.ok ? '팀을 삭제했습니다.' : r.why, r.ok ? 'ok' : 'warn'); break;
    }
    case 'cm-delete-cancel':
      state.custom.confirmDelete = null; render(); break;
    case 'cm-dedupe-cancel':
      state.custom.confirmDedupe = null; render(); break;
    case 'cm-dedupe': {
      const extra = C.duplicateTeams().reduce((n, g) => n + g.drop.length, 0);
      if (!extra) { toast('중복된 팀이 없습니다.', 'info'); break; }
      if (state.custom.confirmDedupe !== extra) { state.custom.confirmDedupe = extra; render(); break; }
      state.custom.confirmDedupe = null;
      const r = C.removeDuplicates();
      if (!r.ok) { toast(r.why || '정리하지 못했습니다.', 'warn'); break; }
      // 정리된 팀을 보고 있으면 다른 팀으로 넘어갑니다
      if (!C.getTeam(state.custom.teamId)) { state.custom.team = null; state.custom.teamId = null; ensureCustomTeam(); }
      render();
      toast(`같은 내용의 팀 ${r.removed}개를 정리했습니다 · 내 팀 ${r.count}개`, 'ok'); break;
    }
    case 'cm-open': {
      const t = C.getTeam(el.dataset.id);
      if (!t) { toast('팀을 찾을 수 없습니다.', 'warn'); break; }
      state.custom.team = t; state.custom.teamId = t.id; state.custom.tab = 'build'; state.custom.msg = '';
      render(); break;
    }
    case 'cm-size': {
      const t = state.custom.team;
      if (!t) break;
      const hadCustom = C.isCustomShape(t);
      C.setSize(t, Number(el.dataset.size));
      const r = C.saveTeam(t);
      state.custom.team = r.ok ? r.team : t;
      state.custom.msg = `${C.formatName(t.size)} · ${t.formation} — 자리 이름이 같은 선수는 그대로 따라갑니다.${hadCustom ? ' 자유 대형은 기본 대형으로 돌아갑니다.' : ''}`;
      render(); break;
    }
    case 'cm-formation': {
      const t = state.custom.team;
      if (!t) break;
      const hadCustom = C.isCustomShape(t);
      C.setFormation(t, el.dataset.formation);
      const r = C.saveTeam(t);
      state.custom.team = r.ok ? r.team : t;
      state.custom.msg = hadCustom ? `${t.formation} 기본 대형으로 돌아왔습니다 (자유 대형 초기화).` : '';
      render(); break;
    }
    case 'cm-board-reset': {
      const t = state.custom.team;
      if (!t) break;
      C.resetCoords(t);
      const r = C.saveTeam(t);
      state.custom.team = r.ok ? r.team : t;
      state.custom.msg = '';
      render();
      toast(`${t.formation} 기본 대형으로 되돌렸습니다.`, 'ok'); break;
    }
    case 'cm-save': {
      const t = state.custom.team;
      if (!t) break;
      C.autoFill(t);
      const r = C.saveTeam(t);
      state.custom.team = r.ok ? r.team : t;
      if (r.ok) state.custom.msg = `'${t.name}' — 같은 팀을 최신 내용으로 저장했습니다 (내 팀 ${r.count}개).`;
      render();
      toast(r.ok ? (r.created ? `'${t.name}' 팀을 저장했습니다.` : `'${t.name}' 저장 완료 — 같은 팀을 업데이트했습니다 (내 팀 ${r.count}개)`) : r.why, r.ok ? 'ok' : 'warn'); break;
    }
    case 'cm-tactics-toggle':
      state.custom.tacticsOpen = !state.custom.tacticsOpen;
      keepScroll(); render(); break;
    case 'cm-autofill': {
      const t = state.custom.team;
      if (!t) break;
      const added = C.autoFill(t);
      const r = C.saveTeam(t);
      state.custom.team = r.ok ? r.team : t;
      render();
      toast(added.length ? `빈 자리 ${added.length}곳을 기본 선수로 채웠습니다.` : '이미 모든 자리가 채워져 있습니다.', added.length ? 'ok' : 'info'); break;
    }
    case 'cm-bulk-open':
      state.custom.bulk = true; render(); break;
    case 'cm-bulk-close':
      state.custom.bulk = false; render(); break;
    case 'cm-bulk-apply': {
      const t = state.custom.team;
      if (!t) break;
      const { rows, errors } = C.parseBulk(state.custom.bulkText);
      if (!rows.length) { toast(errors[0] || '넣을 선수를 찾지 못했습니다.', 'warn'); break; }
      const n = C.applyBulk(t, rows);
      const r = C.saveTeam(t);
      state.custom.team = r.ok ? r.team : t;
      state.custom.bulk = false; state.custom.bulkText = '';
      render();
      toast(`${n}명을 명단에 넣었습니다${errors.length ? ` · ${errors.length}줄은 건너뛰었습니다` : ''}.`, 'ok'); break;
    }
    case 'cm-role': {
      const t = state.custom.team;
      if (!t) break;
      const i = Number(el.dataset.i);
      const p = t.players[i];
      if (!p) break;
      t.roles = t.roles || [];
      t.roles[i] = nextRole(p.slot, t.roles[i] || 'b2b');
      C.saveTeam(t); keepScroll(); render();
      toast(`역할 · ${roleLabel(t.roles[i])} — ${roleEffect(t.roles[i])}`, 'ok'); break;
    }
    case 'cm-tactic': {
      const t = state.custom.team;
      if (!t) break;
      t.tactic = { ...t.tactic, [el.dataset.axis]: Number(el.dataset.val) };
      C.saveTeam(t); keepScroll(); render(); break;
    }
    case 'cm-mentality': {
      const t = state.custom.team;
      if (!t) break;
      const v = Number(el.dataset.val);
      t.tactic = { ...t.tactic, mentality: v };
      C.saveTeam(t); keepScroll(); render();
      toast(`팀 성향 · ${mentalityOf(v).name} — ${mentalityEffect(v, true)}`, 'ok'); break;
    }
    case 'cm-setpiece': {
      const t = state.custom.team;
      if (!t) break;
      t.setpiece = C.setTeamSetPiece(t, el.dataset.type, el.dataset.key);
      C.saveTeam(t); keepScroll(); render();
      toast(`세트피스 · ${el.dataset.type === 'corner' ? '코너킥' : '프리킥'} ${setPieceLabel(el.dataset.type, t.setpiece[el.dataset.type])}`, 'ok'); break;
    }
    case 'cm-share':
      state.custom.tab = 'share'; render(); break;
    case 'cm-publish': publishTeam(el.dataset.id); break;
    case 'cm-load': loadSharedCode(); break;
    case 'cm-copy': copyText(el.dataset.copy, '복사했습니다.'); break;
    case 'cm-longlink': {
      const t = C.getTeam(el.dataset.id);
      if (!t) break;
      state.custom.longLink = C.teamLink(C.encodePayload(C.packTeam(t)));
      render(); toast('긴 링크를 만들었습니다 — 링크 하나에 팀 전체가 담깁니다.', 'ok'); break;
    }
    case 'cm-copy-result': {
      const r = state.customResult;
      if (!r) break;
      copyText(C.resultText(r.meta, r.m), '경기 결과를 복사했습니다.'); break;
    }
    case 'mu-oppkind': {
      state.matchup.oppKind = el.dataset.kind === 'custom' ? 'custom' : 'kl';
      if (state.matchup.oppKind === 'custom') {
        const other = C.readTeams().list.find((t) => t.id !== state.custom.teamId);
        state.matchup.oppId = state.matchup.oppTeam?.id || other?.id || '';
        state.matchup.oppTeam = state.matchup.oppId ? C.getTeam(state.matchup.oppId) : null;
      } else if (!KL_BY_ID[state.matchup.oppId]) state.matchup.oppId = 'geumsan';
      render(); break;
    }
    case 'mu-side': state.matchup.side = el.dataset.side === 'away' ? 'away' : 'home'; render(); break;
    case 'mu-start': startCustomMatch(el.dataset.instant === '1'); break;
    case 'mu-rematch': startCustomMatch(false); break;
    default: break;
  }
}

/* ─────────────────────────── 커스텀 매치업 — 자유 대형 보드 ───────────────────────────
   전술 보드의 선수 칩을 마우스로도, 손가락으로도 끌어 자리를 옮깁니다.
   · pointerdown: 집은 칩·보드 크기·그 선수의 포지션(GK 인지)을 기억
   · pointermove: 손가락이 보드 안 어디인지 좌표(0~1)로 바꾸고 칩을 따라 움직임 (보드 밖은 클램프)
   · pointerup: 실제로 움직였으면 팀(customCoords)에 저장하고 다시 그립니다. 그냥 누른 것은 역할 변경(click) */
const boardDrag = { i: -1, pointerId: null, moved: false, rect: null, chip: null, coord: null, pos: 'MF', startX: 0, startY: 0 };

const boardTeam = () => (state.view === 'custom' && !state.customResult ? state.custom.team : null);

function onBoardPointerDown(e) {
  if (boardDrag.i >= 0) return;   // 이미 한 손가락으로 끌고 있으면 두 번째 손가락은 무시
  const chip = e.target?.closest?.('[data-chip]');
  if (!chip) return;
  const team = boardTeam();
  const board = chip.closest('[data-board]');
  if (!team || !board) return;
  if (e.pointerType === 'mouse' && e.button !== 0) return;   // 오른쪽·가운데 버튼은 그대로 둡니다
  const i = Number(chip.dataset.chip);
  if (!team.players?.[i]) return;
  boardDrag.i = i;
  boardDrag.pointerId = e.pointerId;
  boardDrag.moved = false;
  boardDrag.rect = board.getBoundingClientRect();
  boardDrag.chip = chip;
  boardDrag.coord = null;
  boardDrag.pos = C.teamSlotPos(team, team.players[i].slot);
  boardDrag.startX = e.clientX;
  boardDrag.startY = e.clientY;
  chip.classList.add('dragging');
  try { chip.setPointerCapture(e.pointerId); } catch { /* 캡처를 못 해도 문서 이벤트로 이어집니다 */ }
}

function boardCoordAt(e) {
  const r = boardDrag.rect;
  if (!r || !r.width || !r.height) return null;
  return C.clampCoord({ x: (e.clientX - r.left) / r.width, y: (e.clientY - r.top) / r.height }, boardDrag.pos);
}

function onBoardPointerMove(e) {
  if (boardDrag.i < 0 || e.pointerId !== boardDrag.pointerId) return;
  if (!boardDrag.moved) {
    if (Math.hypot(e.clientX - boardDrag.startX, e.clientY - boardDrag.startY) < 4) return;
    boardDrag.moved = true;   // 4px 넘게 움직여야 '끌기' (살짝 누른 것은 역할 변경)
  }
  const c = boardCoordAt(e);
  if (!c) return;
  boardDrag.coord = c;
  const chip = boardDrag.chip;
  if (chip) {
    // inline style 속성은 CSP(style-src 'self')가 막으므로 CSS 변수를 CSSOM 으로 바꿉니다
    chip.style.setProperty('--cx', `${(c.x * 100).toFixed(2)}%`);
    chip.style.setProperty('--cy', `${(c.y * 100).toFixed(2)}%`);
  }
}

function onBoardPointerEnd(e) {
  if (boardDrag.i < 0 || e.pointerId !== boardDrag.pointerId) return;
  const { i, moved, coord, chip } = boardDrag;
  boardDrag.i = -1; boardDrag.pointerId = null; boardDrag.chip = null; boardDrag.coord = null; boardDrag.moved = false;
  if (chip) chip.classList.remove('dragging');
  if (!moved || !coord) return;
  const team = boardTeam();
  if (!team) return;
  const wasCustom = C.isCustomShape(team);
  C.movePlayerCoord(team, i, coord);
  const r = C.saveTeam(team);
  state.custom.team = r.ok ? r.team : team;
  state.custom.clickSuppress = { at: Date.now(), chip: String(i) };
  if (!wasCustom) state.custom.msg = '자유 대형 — 끌어 옮긴 자리 그대로 경기에 섭니다. 「기본 대형으로 되돌리기」로 초기화할 수 있습니다.';
  render();
}

/* ─────────────────────────── 커리어 ─────────────────────────── */
function newGame(teamId) {
  const def = defs[teamId];
  if (!def) return;
  const mode = def.div ? 'kleague' : 'custom';
  state.world = W.createWorld(teamId, Date.now(), { mode });
  state.view = 'hub'; state.tab = 'schedule'; state.modal = null; state.selSlot = 0; state.selPid = null;
  W.saveWorld(state.world);
  render();
  toast(`${state.world.teams[teamId].name} 감독 취임! 첫 경기를 준비하세요.`, 'ok');
}

/* ─────────────────────────── 저장 / 불러오기 ─────────────────────────── */
const kbText = (bytes) => (!bytes ? '0KB' : bytes >= 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(1)}MB` : `${Math.max(1, Math.round(bytes / 1024))}KB`);

/* 읽어 온 세계로 감독 자리를 옵깁니다 (슬롯·파일 모두 같은 길). */
function adoptWorld(world, why = '불러왔습니다') {
  state.world = world;
  state.savedGame = world;
  state.view = 'hub'; state.tab = 'schedule';
  state.modal = null; state.selPid = null; state.selSlot = null; state.roleSlot = null;
  state.seasonResult = null; state.seasonPhase = 'preview'; state.pending = null;
  if (W.isKL(world)) { state.pickMode = 'kleague'; state.pickDiv = W.divOf(world, world.myTeamId) || 1; }
  W.saveWorld(world);
  window.scrollTo(0, 0);
  render();
  const t = world.teams[world.myTeamId];
  toast(`${why} — ${t?.name || ''} · ${W.seasonLabel(world)}`, 'ok');
}

function doSlotSave(i) {
  const w = state.world;
  if (!w) { toast('저장할 커리어가 없습니다.', 'warn'); return; }
  const r = saveSlot(i, w);
  state.modal = { kind: 'saves' };
  render();
  if (r.ok) toast(`슬롯 ${i + 1}에 저장했습니다 (${kbText(r.bytes)}).`, 'ok');
  else toast(r.why, 'warn');
}

function doSlotLoad(i) {
  const r = loadSlot(i);
  if (!r.ok) { toast(r.why, 'warn'); return; }
  adoptWorld(r.world, `슬롯 ${i + 1}에서 불러왔습니다`);
}

/* 파일로 내보내기 — 기기 간 이동·백업용 JSON */
function exportSave(w) {
  const name = exportFileName(w);
  try {
    const blob = new Blob([JSON.stringify(exportPayload(w))], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = name;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 2000);
    toast(`세이브 파일을 내보냈습니다 — ${name}`, 'ok');
  } catch {
    toast('파일을 만들지 못했습니다. 브라우저 저장 공간을 확인해 주세요.', 'warn');
  }
}

/* 파일 고르기 → 읽기 → 확인 모달 */
function onFileChange(e) {
  const el = e.target.closest('[data-import]');
  if (!el || !el.files || !el.files.length) return;
  const file = el.files[0];
  const reader = new FileReader();
  reader.onload = () => {
    const r = parseSaveFile(String(reader.result || ''));
    if (!r.ok) { toast(r.why, 'warn'); render(); return; }
    state.pendingImport = r;
    state.modal = { kind: 'saves', confirm: { op: 'import', meta: r.meta } };
    render();
  };
  reader.onerror = () => { toast('파일을 읽지 못했습니다.', 'warn'); render(); };
  reader.readAsText(file);
  el.value = '';
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
    label: round.type === 'cup' ? W.cupLabelOf(w, round.stage) : `리그 ${round.leagueRound}R`,
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
  // 이 경기의 요약을 별도 로그에 남깁니다 (이전 경기 결과 모달의 재료).
  try { recordEntries(w, [entryFromMatch(w, m, round, fixture.home, fixture.away)]); } catch { /* 기록 실패는 경기 결과에 영향을 주지 않습니다 */ }
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

/* ─────────────────────────── 커스텀 매치업 ─────────────────────────── */
/* 화면 전환·상태는 모두 여기서 — 커리어(state.world / savedGame)는 절대 건드리지 않습니다. */
function openCustom() {
  state.view = 'custom';
  state.customResult = null;
  state.custom.msg = '';
  ensureCustomTeam();
  window.scrollTo(0, 0);
  render();
}

function ensureCustomTeam() {
  const db = C.readTeams();
  if (state.custom.team) return state.custom.team;
  const t = (state.custom.teamId && db.list.find((x) => x.id === state.custom.teamId)) || db.list[0] || null;
  state.custom.team = t;
  state.custom.teamId = t?.id || null;
  if (!state.matchup.oppId || state.matchup.oppKind === 'custom') {
    if (state.matchup.oppKind === 'custom') {
      const other = db.list.find((x) => x.id !== t?.id) || null;
      state.matchup.oppId = other?.id || '';
      state.matchup.oppTeam = other;
    }
  }
  return t;
}

/* 입력 — 화면을 다시 그리지 않아 타이핑 중 포커스가 유지됩니다. */
function onCustomInput(e) {
  const el = e.target;
  if (state.view !== 'custom' || !el?.dataset) return;
  const cm = el.dataset.cm;
  // 공유 코드는 팀이 하나도 없을 때도 입력할 수 있어야 합니다 (처음 온 친구가 코드부터 넣는 경우)
  if (cm === 'code') { state.custom.codeInput = el.value; return; }
  if (cm === 'bulk') { state.custom.bulkText = el.value; return; }
  const t = state.custom.team;
  if (!t) return;
  const cp = el.dataset.cp;
  if (cp) {
    const i = Number(el.dataset.i);
    const p = t.players?.[i];
    if (!p) return;
    if (cp === 'name') { p.name = String(el.value).slice(0, 16); return; }
    if (cp === 'ovr') { const v = Number(el.value); if (Number.isFinite(v) && v >= 25) C.setPlayerOvr(t, i, v, 'edit'); return; }
    if (cp === 'stat') { if (el.value !== '') C.setPlayerStat(t, i, el.dataset.key, el.value); return; }
    if (cp === 'age') { if (el.value !== '') C.setPlayerAge(t, i, el.value); return; }
  }
  if (cm === 'name') t.name = String(el.value).slice(0, 24);
  else if (cm === 'short') t.short = String(el.value).slice(0, 5);
  else if (cm === 'primary') t.colors.primary = el.value;
  else if (cm === 'secondary') t.colors.secondary = el.value;
}

/* 값이 확정되는 순간(블러·선택) — 모델을 저장하고 바뀐 부분만 그 자리에서 갱신합니다.
   입력칸에서 바로 다음 버튼을 누를 때 화면을 통째로 다시 그리면 그 탭이 삼켜지므로,
   글자·숫자 입력은 화면을 다시 그리지 않고 OVR 표시만 고칩니다. */
function onCustomChange(e) {
  const el = e.target;
  if (state.view !== 'custom' || !el?.dataset) return;
  const cm = el.dataset.cm;
  const cp = el.dataset.cp;
  if (cm === 'pick') {
    const nt = C.getTeam(el.value);
    if (nt) { state.custom.team = nt; state.custom.teamId = nt.id; state.custom.confirmDelete = null; render(); }
    return;
  }
  // 공유·불러오기 탭 — 공유할 팀 고르기 / 매치업 링크의 두 팀 고르기 (팀이 없어도 동작해야 합니다)
  if (cm === 'share-pick') {
    state.custom.sharePick = el.value;
    state.custom.longLink = '';
    render();
    return;
  }
  if (cm === 'vs') {
    if (el.dataset.side === 'b') state.custom.vsB = el.value;
    else state.custom.vsA = el.value;
    render();
    return;
  }
  const t = state.custom.team;
  if (!t) return;
  if (cm === 'primary' || cm === 'secondary') {
    C.saveTeam(t);
    applyTeamColors(document.getElementById('app'), colorWorld());
    return;
  }
  if (cm === 'name' || cm === 'short') {
    C.saveTeam(t);
    const badgeEl = document.querySelector('.cm-badge');
    if (badgeEl) badgeEl.textContent = C.teamShort(t);
    return;
  }
  if (cp) {
    const i = Number(el.dataset.i);
    const p = t.players?.[i];
    if (!p) return;
    if (cp === 'slot') {
      // 포지션(자리)을 바꾸면 그 자리 기준으로 OVR을 다시 깔아 줍니다
      p.slot = el.value;
      const ovr = C.ovrOf(t, p) || 68;
      C.setPlayerOvr(t, i, ovr, 'slot');
    }
    C.saveTeam(t);
    const chip = el.closest('.cp-row')?.querySelector('.cp-ovr-val');
    if (chip) {
      const v = C.ovrOf(t, p);
      chip.textContent = v || '—';
      chip.classList.toggle('hi', v >= 80);
      chip.classList.toggle('lo', !!v && v < 60);
    }
    return;
  }
  if (el.dataset.mu === 'opp' || el.dataset.mu === 'kl') {
    state.matchup.oppKind = el.dataset.mu === 'kl' ? 'kl' : 'custom';
    state.matchup.oppId = el.value;
    state.matchup.oppTeam = state.matchup.oppKind === 'custom' ? C.getTeam(el.value) : null;
    render(); return;
  }
}

async function publishTeam(id) {
  const t = C.getTeam(id) || state.custom.team;
  if (!t) return;
  if (!t.players.some((p) => p.stats)) C.autoFill(t);
  C.saveTeam(t);
  state.custom.share = { busy: true };
  state.custom.msg = '공유 서버에 올리는 중…';
  render();
  try {
    const r = await C.publishTeam(t);
    state.custom.share = { busy: false };
    if (r.ok) {
      t.code = r.code; t.sharedAt = Date.now();
      const saved = C.saveTeam(t);
      state.custom.team = saved.ok ? saved.team : t;
      state.custom.msg = `공유 코드 ${r.code} — 친구에게 코드나 링크를 보내세요.`;
      render();
      toast(`공유 코드 ${r.code} 발급!`, 'ok');
    } else {
      state.custom.msg = r.why;
      render();
      toast(r.why, 'warn');
    }
  } catch (err) {
    state.custom.share = { busy: false };
    state.custom.msg = `공유하지 못했습니다 (${String(err?.message || err).slice(0, 80)})`;
    render();
    toast('공유하지 못했습니다.', 'warn');
  }
}

/* 코드·링크 입력 — 짧은 링크(?t=·?m=)와 예전 링크(?team=·?match=) 모두 알아봅니다. */
const codeFromInput = (raw) => {
  const p = C.parseShareInput(raw);
  return p.kind === 'match' ? p.a || '' : p.code;
};

/* 공유 코드·링크로 들여온 팀을 내 팀으로 저장합니다.
   같은 팀(같은 공유 코드 또는 같은 내용 지문)이 이미 있으면 **새 팀을 만들지 않고 그 팀을 덮어씁니다.**
   → 같은 링크를 여러 번 열거나 '불러오기'를 다시 눌러도 내 팀 목록이 늘어나지 않습니다. */
function importSharedTeam(team, { code = null, source = '공유 링크' } = {}) {
  const key = /^[A-Za-z0-9]{4,12}$/.test(String(code || '')) ? String(code).toUpperCase() : null;
  const sharedKey = C.teamFingerprint(team);
  const same = C.readTeams().list.find((t) => (key && t.code === key) || (sharedKey && t.sharedKey === sharedKey)) || null;
  const saved = C.saveTeam({
    ...team,
    id: same?.id || C.newTeamId(),
    code: key || same?.code || null,
    sharedKey,
    from: same?.from || source,
  });
  return { saved, updated: !!same, count: saved.count };
}

/* 공유 링크(?t=·?team=·?m=·?match=)로 들어왔을 때 주소창에서 그 값을 지웁니다 —
   새로고침·뒤로가기로 같은 링크를 다시 열어도 팀 사본이 쌓이지 않게. */
function clearShareParams() {
  try { history.replaceState(null, '', C.appBase()); } catch { /* 주소를 못 바꾸는 환경이면 그냥 둡니다 */ }
}

async function loadSharedCode() {
  const raw = (state.custom.codeInput || '').trim();
  if (!raw) { toast('공유 코드나 링크를 입력해 주세요.', 'warn'); return; }
  // 매치업 링크(?m=A:B)를 붙여 넣었으면 두 팀을 함께 엽니다
  const parsed = C.parseShareInput(raw);
  if (parsed.kind === 'match' && parsed.a && parsed.b) {
    state.custom.codeInput = '';
    await openMatchParam(`${parsed.a}:${parsed.b}`);
    return;
  }
  const code = codeFromInput(raw);
  state.custom.msg = '불러오는 중…';
  render();
  const r = await C.fetchTeam(code);
  if (!r.ok) { state.custom.msg = r.why; render(); toast(r.why, 'warn'); return; }
  const { saved, updated, count } = importSharedTeam(r.team, { code, source: '공유 코드' });
  if (!saved.ok) { state.custom.msg = saved.why; render(); toast(saved.why, 'warn'); return; }
  state.custom.team = saved.team;
  state.custom.teamId = saved.team.id;
  state.custom.codeInput = '';
  state.custom.msg = updated
    ? `이미 저장한 '${saved.team.name}' 팀을 새 내용으로 업데이트했습니다 (내 팀 ${count}개). 따로 보관하려면 '복제'를 누르세요.`
    : `'${saved.team.name}' 팀을 불러와 내 팀으로 저장했습니다 (내 팀 ${count}개).`;
  render();
  toast(updated ? `${saved.team.name} 팀을 업데이트했습니다.` : `${saved.team.name} 팀을 불러왔습니다.`, 'ok');
}

function copyText(text, okMsg = '복사했습니다.') {
  const value = String(text || '');
  if (!value) return;
  const fallback = () => {
    const ta = document.createElement('textarea');
    ta.value = value;
    ta.setAttribute('readonly', '');
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    let ok = false;
    try { ok = document.execCommand('copy'); } catch { ok = false; }
    ta.remove();
    toast(ok ? okMsg : '복사하지 못했습니다 — 길게 눌러 복사해 주세요.', ok ? 'ok' : 'warn');
  };
  if (navigator.clipboard?.writeText) navigator.clipboard.writeText(value).then(() => toast(okMsg, 'ok')).catch(fallback);
  else fallback();
}

/* ?t=CODE · ?m=A:B (예전 ?team= · ?match= 도 그대로) — 공유 링크로 바로 열기 */
async function openFromUrl() {
  const q = new URLSearchParams(location.search);
  const team = q.get('t') || q.get('team');
  const match = q.get('m') || q.get('match');
  if (match) { await openMatchParam(match); return; }
  if (team) await openSharedParam(team);
}

async function openSharedParam(code) {
  state.view = 'custom';
  state.custom.tab = 'build';
  ensureCustomTeam();
  state.custom.msg = '공유된 팀을 불러오는 중…';
  render();
  const r = await C.fetchTeam(code);
  if (!r.ok) { clearShareParams(); state.custom.msg = r.why; render(); toast(r.why, 'warn'); return; }
  const { saved, updated, count } = importSharedTeam(r.team, { code, source: '공유 링크' });
  if (!saved.ok) { clearShareParams(); state.custom.msg = saved.why; render(); return; }
  clearShareParams();
  state.custom.team = saved.team;
  state.custom.teamId = saved.team.id;
  state.custom.msg = updated
    ? `공유받은 '${saved.team.name}' 팀이 이미 있어 새 내용으로 업데이트했습니다 (내 팀 ${count}개). 바로 경기하거나 고쳐서 쓸 수 있어요.`
    : `공유받은 '${saved.team.name}' 팀입니다 — 바로 경기하거나 고쳐서 내 팀으로 쓸 수 있어요.`;
  render();
  toast(`${saved.team.name} 팀을 불러왔습니다.`, 'ok');
}

async function openMatchParam(value) {
  const [a, b] = String(value).split(':').map((s) => s.trim()).filter(Boolean);
  state.view = 'custom';
  state.custom.tab = 'match';
  ensureCustomTeam();
  state.custom.msg = '두 팀을 불러오는 중…';
  render();
  const [ra, rb] = await Promise.all([C.fetchTeam(a || ''), C.fetchTeam(b || '')]);
  if (!ra.ok || !rb.ok) {
    clearShareParams();
    state.custom.msg = ra.ok ? rb.why : ra.why;
    render();
    toast(state.custom.msg, 'warn');
    return;
  }
  const sa = importSharedTeam(ra.team, { code: a, source: '공유 링크' });
  const sb = importSharedTeam(rb.team, { code: b, source: '공유 링크' });
  if (!sa.saved.ok || !sb.saved.ok) { state.custom.msg = '팀을 저장하지 못했습니다.'; render(); return; }
  clearShareParams();
  state.custom.team = sa.saved.team;
  state.custom.teamId = sa.saved.team.id;
  state.matchup.oppKind = 'custom';
  state.matchup.oppId = sb.saved.team.id;
  state.matchup.oppTeam = sb.saved.team;
  state.custom.msg = `${sa.saved.team.name} vs ${sb.saved.team.name} — 홈/원정을 고르고 시작하세요.`;
  render();
  toast('두 팀을 불러왔습니다.', 'ok');
}

/* 경기용 앱 객체 — 커리어 api 대신 넘겨 세이브를 건드리지 않습니다. */
function customMatchApi() {
  return {
    get world() { return state.customMatch?.world || null; },
    get savedGame() { return state.savedGame; },
    get state() { return state; },
    defs,
    save: () => true,
    toast,
    endMatch: (m, meta) => endCustomMatch(m, meta),
  };
}

function startCustomMatch(instant) {
  const my = state.custom.team;
  if (!my) { toast('내 팀을 먼저 만들어 주세요.', 'warn'); return; }
  if (!my.players.some((p) => p.stats) || my.players.some((p) => !p.name)) {
    C.autoFill(my);
    C.saveTeam(my);
    toast('빈 자리를 기본 선수로 채우고 경기를 시작합니다.', 'info');
  }
  const mu = state.matchup;
  let opp;
  if (mu.oppKind === 'custom') {
    const t = C.getTeam(mu.oppId) || mu.oppTeam;
    if (!t) { toast('상대 팀을 고르세요.', 'warn'); return; }
    if (t.size !== my.size) { toast(`규모가 다릅니다 — ${C.formatName(my.size)} 팀끼리 경기할 수 있어요.`, 'warn'); return; }
    opp = { kind: 'custom', team: t };
  } else {
    const kl = KL_BY_ID[mu.oppId];
    if (!kl) { toast('상대 구단을 고르세요.', 'warn'); return; }
    opp = { kind: 'kl', id: kl.id };
  }
  const meSpec = { kind: 'custom', team: my };
  const home = mu.side === 'away' ? opp : meSpec;
  const away = mu.side === 'away' ? meSpec : opp;
  const seed = `cm-${Date.now()}`;
  const built = C.buildMatchupWorld({ home, away, seed, mySide: mu.side });
  if (!built) { toast('경기를 준비하지 못했습니다.', 'warn'); return; }
  const { world, homeId, awayId, homeLineup, awayLineup, size } = built;
  const m = new Match({
    world, homeId, awayId, homeLineup, awayLineup,
    seed: `cm-${size}-${my.id}-${Date.now()}`, cup: false, userSide: mu.side,
  });
  const meta = {
    label: `커스텀 매치업 · ${C.formatName(size)}`,
    custom: true, size, instant: !!instant,
    myTeamId: world.myTeamId,
    homeName: world.teams[homeId].name, awayName: world.teams[awayId].name,
  };
  if (instant) {
    let guard = 0;
    while (!m.done && guard < 5000) { m.tick(); guard += 1; }
    if (!m.done) m.finish();
  }
  state.customResult = null;
  state.customMatch = { m, meta, world };
  state.headerOverride = {
    name: `${world.teams[homeId].short} vs ${world.teams[awayId].short}`,
    sub: `GOODWAY APPS · FM · 커스텀 매치업 · ${C.formatName(size)}`,
  };
  state.view = 'match';
  document.body.dataset.view = 'match';
  updateHeader();
  mountMatch(customMatchApi(), m, meta);
  applyTeamColors(document.getElementById('app'), colorWorld());
  window.scrollTo(0, 0);
}

function endCustomMatch(m, meta) {
  state.customResult = { m, meta };
  state.customMatch = null;
  state.headerOverride = null;
  state.view = 'custom';
  state.custom.tab = 'match';
  state.custom.msg = '';
  document.body.dataset.view = 'custom';
  window.scrollTo(0, 0);
  render();
  const mine = m.score[m.userSide] || 0;
  const theirs = m.score[m.userSide === 'home' ? 'away' : 'home'] || 0;
  toast(`커스텀 매치업 ${mine > theirs ? '승리!' : mine < theirs ? '패배' : '무승부'} ${m.score.home}-${m.score.away}`,
    mine > theirs ? 'ok' : mine < theirs ? 'warn' : 'info');
}
