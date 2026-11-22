// 앱 셸 — 상태·화면 전환·감독 조작
import { TEAM_DEFS, FORMATIONS } from './data.js';
import { KL_TEAMS, KL_BY_ID } from './kleague2026.js';
import * as W from './world.js';
import { local } from './store.js';
import { renderSelect, renderHub, renderSeason, renderModal, applyTeamColors } from './views.js';
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
  document.addEventListener('input', onFilterInput);
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
  applyTeamColors(root, state.world || { teams: defs });
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
    default: break;
  }
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
