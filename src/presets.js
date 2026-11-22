// 전술·명단 프리셋 — 지금의 포메이션·전술 4축·팀 성향·세트피스·포지션별 역할·주간 훈련·
// 선발 11명(과 후보)을 이름을 붙여 저장하고, 목록에서 한 번에 불러옵니다.
//
//   · 저장 위치: 커리어 세이브와 분리된 localStorage 키('fm:presets').
//     커스텀 리그 ↔ K리그 2026 을 오가도 프리셋은 남습니다.
//   · 불러올 때 선수 ID 가 없으면(이적·다른 모드) 이름 → 포지션 순서로 대신 채우고,
//     부상·징계 선수는 빼고 채웁니다. 무엇이 바뀌었는지 notes 로 알려 줍니다.
import { local } from './store.js';
import { FORMATIONS } from './data.js';
import { rolesForLabel, defaultRole, resolveSetPiece } from './tactics.js';
import { squadOf, available, TRAINING, seasonLabel, divOf } from './world.js';

export const PRESET_KEY = 'presets';
export const PRESET_VERSION = 1;
export const PRESET_MAX = 12;

let backend = null;
export function setPresetStore(store) { backend = store || null; }
const store = () => backend || local;

export function readPresets() {
  const raw = store().get(PRESET_KEY, null);
  if (!raw || typeof raw !== 'object' || !Array.isArray(raw.list)) return { v: PRESET_VERSION, list: [] };
  return { v: PRESET_VERSION, list: raw.list.filter((p) => p && p.id && FORMATIONS[p.formation]) };
}

function write(db) {
  try { store().set(PRESET_KEY, db); return { ok: true }; } catch (e) {
    return { ok: false, why: '브라우저 저장 공간이 부족해 프리셋을 저장하지 못했습니다. 오래된 세이브 슬롯을 지운 뒤 다시 시도해 주세요.' };
  }
}

export const presetBytes = () => {
  try { return JSON.stringify(readPresets()).length; } catch { return 0; }
};

/* ── 지금 설정을 프리셋으로 ─────────────────────────────────── */
export function snapshot(w, name) {
  const l = w.myLineup || {};
  const slots = FORMATIONS[l.formation]?.slots || [];
  const ref = (id) => {
    const p = id ? w.players[id] : null;
    return p ? { pid: p.id, name: p.name, pos: p.pos, num: p.num, ovr: p.ovr } : null;
  };
  return {
    id: `pr${Math.random().toString(36).slice(2, 8)}`,
    name: String(name || '').trim().slice(0, 24) || '이름 없는 프리셋',
    at: Date.now(),
    mode: w.mode || 'custom',
    season: seasonLabel(w),
    div: divOf(w, w.myTeamId),
    formation: l.formation,
    slots: slots.map((s) => s.label),
    tactic: { line: 0, pass: 0, press: 0, route: 0, mentality: 0, ...(l.tactic || {}) },
    setpiece: resolveSetPiece(l.setpiece),
    roles: slots.map((s, i) => (l.roles || [])[i] || defaultRole(s.label)),
    training: w.teams[w.myTeamId]?.training || 'balanced',
    starters: (l.starters || []).map(ref),
    bench: (l.bench || []).map(ref),
  };
}

export function addPreset(w, name) {
  const db = readPresets();
  const preset = snapshot(w, name);
  db.list = [preset, ...db.list].slice(0, PRESET_MAX);
  const r = write(db);
  return r.ok ? { ok: true, preset } : r;
}

export function overwritePreset(w, id) {
  const db = readPresets();
  const i = db.list.findIndex((p) => p.id === id);
  if (i < 0) return { ok: false, why: '프리셋을 찾을 수 없습니다.' };
  const old = db.list[i];
  const preset = { ...snapshot(w, old.name), id: old.id };
  db.list[i] = preset;
  const r = write(db);
  return r.ok ? { ok: true, preset } : r;
}

export function renamePreset(id, name) {
  const db = readPresets();
  const p = db.list.find((x) => x.id === id);
  if (!p) return { ok: false };
  p.name = String(name || '').trim().slice(0, 24) || p.name;
  write(db);
  return { ok: true, preset: p };
}

export function deletePreset(id) {
  const db = readPresets();
  const before = db.list.length;
  db.list = db.list.filter((p) => p.id !== id);
  const r = write(db);
  return r.ok ? { ok: true, removed: before - db.list.length } : r;
}

/* ── 불러오기 ───────────────────────────────────────────────
   저장 당시 선수가 남아 있으면 그대로, 없거나 뛸 수 없으면 같은 포지션의
   쓸 수 있는 선수로 채웁니다. 그래도 없으면 그 자리는 비워 둡니다. */
export function applyPreset(w, preset) {
  if (!w || !preset) return { ok: false, notes: ['프리셋을 읽을 수 없습니다.'], kept: 0, changed: 0, empty: 0 };
  const notes = [];
  const cur = w.myLineup || {};
  const formation = FORMATIONS[preset.formation] ? preset.formation
    : (FORMATIONS[cur.formation] ? cur.formation : '4-3-3');
  if (formation !== preset.formation) notes.push(`저장했던 포메이션(${preset.formation || '?'})이 없어 ${formation} 로 불러왔습니다.`);
  const slots = FORMATIONS[formation].slots;

  // 역할 — 지금 포메이션의 자리(라벨)에 맞는 역할만 받아들입니다.
  let roleFix = 0;
  const roles = slots.map((s, i) => {
    const want = preset.roles?.[i];
    const opts = s.pos === 'GK' ? ['goalkeeper'] : rolesForLabel(s.label);
    if (want && opts.includes(want)) return want;
    if (want) roleFix += 1;
    return defaultRole(s.label);
  });
  if (roleFix) notes.push(`자리와 맞지 않는 역할 ${roleFix}개를 기본 역할로 바꿨습니다.`);

  const squad = squadOf(w, w.myTeamId);
  const used = new Set();
  const free = () => squad.filter((p) => !used.has(p.id) && available(w, p));
  const take = (want, slotPos, allowOther = true) => {
    const cands = free();
    const byId = want?.pid ? cands.find((p) => p.id === want.pid) : null;
    if (byId) return { p: byId, exact: true };
    const byName = want?.name ? cands.find((p) => p.name === want.name) : null;
    if (byName) return { p: byName, exact: true };
    const samePos = cands.filter((p) => p.pos === slotPos).sort((a, b) => b.ovr - a.ovr)[0];
    if (samePos) return { p: samePos, exact: false };
    if (allowOther) {
      // 골키퍼 자리는 골키퍼가 아니면 뛸 수 없으므로 다른 포지션으로 대신하지 않습니다.
      if (slotPos === 'GK') return null;
      const any = cands.slice().sort((a, b) => b.ovr - a.ovr)[0];
      if (any) return { p: any, exact: false };
    }
    return null;
  };

  let kept = 0, changed = 0, empty = 0;
  const starters = slots.map((slot, i) => {
    const want = preset.starters?.[i];
    const got = take(want, slot.pos);
    if (!got) { empty += 1; return ''; }
    used.add(got.p.id);
    if (got.exact) kept += 1; else changed += 1;
    return got.p.id;
  });
  if (empty) notes.push(`뛸 수 있는 선수가 없어 빈 자리 ${empty}개가 남았습니다.`);
  if (changed) notes.push(`이적·부상·징계로 ${changed}명을 다른 선수로 채웠습니다.`);

  // 후보 — 저장한 후보를 먼저, 모자라면 남은 선수 중에서 채웁니다.
  const bench = [];
  const seen = new Set(used);
  for (const want of preset.bench || []) {
    if (bench.length >= 7) break;
    const got = take(want, want?.pos || 'MF', false);
    if (!got || seen.has(got.p.id)) continue;
    seen.add(got.p.id); used.add(got.p.id); bench.push(got.p.id);
  }
  for (const p of squad) {
    if (bench.length >= 7) break;
    if (seen.has(p.id) || !available(w, p)) continue;
    seen.add(p.id); bench.push(p.id);
  }

  w.myLineup = {
    formation,
    starters,
    bench,
    tactic: { line: 0, pass: 0, press: 0, route: 0, mentality: 0, ...(preset.tactic || {}) },
    roles,
    setpiece: resolveSetPiece(preset.setpiece),
  };
  const train = preset.training;
  if (TRAINING[train]) w.teams[w.myTeamId].training = train;
  else notes.push('저장했던 훈련 방향을 알 수 없어 훈련은 그대로 두었습니다.');

  return { ok: true, notes, kept, changed, empty, formation };
}

/* 화면·토스트용 한 줄 요약 */
export function applyMessage(preset, res) {
  if (!res?.ok) return '프리셋을 불러오지 못했습니다.';
  const bits = [`프리셋 '${preset?.name || ''}' 불러옴`];
  if (res.changed) bits.push(`선수 ${res.changed}명 자동 보정`);
  if (res.empty) bits.push(`빈 자리 ${res.empty}개`);
  if (!res.changed && !res.empty) bits.push('저장한 그대로');
  return bits.join(' · ');
}

