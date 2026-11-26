// 커스텀 팀 — 친구와 나누는 팀 만들기 · 공유 코드 · 가상 매치업
//   · 팀은 브라우저(localStorage 'fm:customTeams')에 남습니다. 커리어 세이브와 완전히 분리.
//   · 공유는 Supabase `fm.custom_teams` 표에 사본을 올리고 6자리 코드를 받습니다.
//     (표가 없거나 인터넷이 없으면 링크에 팀 전체를 담는 긴 코드로 대신합니다)
//   · 매치업은 그때그때 작은 '경기용 세계'를 만들어 기존 2D 엔진(Match)에 넘깁니다.
//     커리어(state.world / savedGame)는 건드리지 않습니다.
import { local } from './store.js';
import { makeRng, clamp } from './rng.js';
import {
  FORMATIONS, FUTSAL_FORMATIONS, formationsFor, sizeOfFormation,
  statsFor, overall, valueOf, wageOf, randomName, freshSeasonStats, STAT_KEYS, POS_LABEL,
} from './data.js';
import { KL_ROSTERS, KL_TEAMS, KL_BY_ID } from './kleague2026.js';
import { resolveRoles, resolveSetPiece, defaultRoles, defaultRole } from './tactics.js';
import { posFactor } from './world.js';

export const TEAM_KEY = 'customTeams';
export const TEAM_VERSION = 1;
export const TEAM_MAX = 24;
export const REMOTE_TABLE = 'custom_teams';

/* ─────────────────────────── 규모 ─────────────────────────── */
export const FORMATS = [
  { size: 11, name: '11인제', note: '정규 축구 · 4-3-3 · 4-4-2 등' },
  { size: 6, name: '6인제 풋살', note: '1-2-2 · 1-3-1' },
  { size: 5, name: '5인제 풋살', note: '1-2-1 · 2-2' },
];
export const formatOf = (size) => FORMATS.find((f) => f.size === Number(size)) || FORMATS[0];
export const formatName = (size) => formatOf(size).name;

/* ─────────────────────────── 팀 만들기 ─────────────────────────── */
const PALETTE = ['#02c245', '#0abbee', '#ff614a', '#7e65c1', '#ffdc1a', '#ff5ea8', '#00c2a8', '#2b59ff', '#ff9f1a', '#c9c9d4'];

let seq = 0;
export function newTeamId() {
  seq += 1;
  return `ct${Date.now().toString(36)}${seq.toString(36)}${Math.random().toString(36).slice(2, 5)}`;
}

const slotsOf = (formation) => FORMATIONS[formation]?.slots || FORMATIONS['4-3-3'].slots;
export const slotLabelsOf = (formation) => slotsOf(formation).map((s) => s.label);

/* ─────────────────────────── 자유 대형 좌표 ───────────────────────────
   전술 보드에서 선수 칩을 끌어 옮긴 자리입니다. 포메이션 기본 좌표 위에 덮어쓰고,
   team.customCoords = [{ x, y }, …] (선수 수만큼) 에 남깁니다. null 이면 기본 대형.
   필드 플레이어는 우리 진영~상대 진영, 골키퍼는 골문 앞으로만 옮길 수 있습니다. */
export const FIELD_BOX = { xMin: 0.12, xMax: 0.88, yMin: 0.06, yMax: 0.94 };
export const GK_BOX = { xMin: 0.03, xMax: 0.14, yMin: 0.22, yMax: 0.78 };
export function clampCoord(coord, pos = 'MF') {
  const box = String(pos).toUpperCase() === 'GK' ? GK_BOX : FIELD_BOX;
  const round = (v, lo, hi) => Math.round(clamp(v, lo, hi) * 10000) / 10000;
  const x = Number(coord?.x);
  const y = Number(coord?.y);
  return {
    x: round(Number.isFinite(x) ? x : (box.xMin + box.xMax) / 2, box.xMin, box.xMax),
    y: round(Number.isFinite(y) ? y : (box.yMin + box.yMax) / 2, box.yMin, box.yMax),
  };
}
/* 저장·공유에서 온 좌표를 검사합니다 — 선수 수가 맞지 않거나 값이 깨졌으면 기본 대형(null) */
function normalizeCoords(raw, slots) {
  if (!Array.isArray(raw) || raw.length !== slots.length) return null;
  const out = [];
  for (let i = 0; i < slots.length; i += 1) {
    const c = raw[i];
    if (!c || typeof c !== 'object') return null;
    const x = Number(c.x);
    const y = Number(c.y);
    if (!Number.isFinite(x) || !Number.isFinite(y) || x < 0 || x > 1 || y < 0 || y > 1) return null;
    out.push(clampCoord({ x, y }, slots[i].pos));
  }
  return out;
}
export const isCustomShape = (team) => Array.isArray(team?.customCoords) && team.customCoords.length === (team?.players?.length || 0);
/* 지금 대형 — 자유 대형이면 그 좌표, 아니면 포메이션 기본 좌표 */
export function coordsOf(team) {
  const slots = slotsOf(team?.formation);
  if (!isCustomShape(team)) return slots.map((s) => ({ x: s.x, y: s.y }));
  return team.customCoords.map((c, i) => clampCoord(c, slots[i]?.pos));
}
/* 선수 한 명 옮기기 — 처음 옮기는 순간 나머지 선수의 기본 좌표까지 함께 담습니다 */
export function movePlayerCoord(team, i, coord) {
  const slots = slotsOf(team.formation);
  if (!slots[i]) return null;
  const list = coordsOf(team);
  list[i] = clampCoord(coord, slots[i].pos);
  team.customCoords = list;
  return list[i];
}
export function resetCoords(team) {
  team.customCoords = null;
  return team;
}
/* 자리 이름 → 포지션 분류 (포메이션에 없는 자리 이름으로도 입력할 수 있게) */
export const LABEL_CAT = {
  GK: 'GK', CB: 'DF', LB: 'DF', RB: 'DF', FIXO: 'DF', SW: 'DF',
  DM: 'MF', CM: 'MF', CAM: 'MF', LM: 'MF', RM: 'MF', LWB: 'MF', RWB: 'MF', ALA: 'MF',
  LW: 'FW', RW: 'FW', LAM: 'FW', RAM: 'FW', ST: 'FW', PIVO: 'FW',
};
export const categoryOf = (label) => LABEL_CAT[String(label || '').toUpperCase()] || 'MF';
const posOfSlot = (formation, label) => slotsOf(formation).find((s) => s.label === label)?.pos || categoryOf(label);

export function emptyPlayer(slotLabel = 'CM') {
  return { name: '', slot: slotLabel, age: 25, stats: null };
}

export function newTeam(opts = {}) {
  const size = [11, 6, 5].includes(Number(opts.size)) ? Number(opts.size) : 11;
  const formation = FORMATIONS[opts.formation] && sizeOfFormation(opts.formation) === size ? opts.formation : formationsFor(size)[0];
  const pick = PALETTE[Math.floor(Math.random() * PALETTE.length)];
  const team = {
    v: TEAM_VERSION,
    id: opts.id || newTeamId(),
    name: opts.name || '우리 동네 FC',
    short: '',
    size, formation,
    colors: { primary: pick, secondary: '#ffffff' },
    players: slotsOf(formation).map((s) => emptyPlayer(s.label)),
    customCoords: null,
    tactic: { line: 0, pass: 0, press: 0, route: 0, mentality: 0 },
    roles: [],
    setpiece: {},
    updatedAt: Date.now(),
  };
  team.roles = defaultRoles(slotsOf(team.formation));
  return normalizeTeam(team);
}

/* 저장된 값·공유 코드를 지금 형식으로 맞춥니다 (구버전·손상 값도 살립니다) */
export function normalizeTeam(raw) {
  if (!raw || typeof raw !== 'object') return newTeam();
  const size = [11, 6, 5].includes(Number(raw.size)) ? Number(raw.size) : sizeOfFormation(raw.formation) || 11;
  const formation = FORMATIONS[raw.formation] && sizeOfFormation(raw.formation) === size ? raw.formation : formationsFor(size)[0];
  const slots = slotsOf(formation);
  const players = slots.map((s, i) => {
    const src = Array.isArray(raw.players) ? raw.players[i] : null;
    const p = src && typeof src === 'object' ? src : {};
    const stats = p.stats && STAT_KEYS.every((k) => Number.isFinite(Number(p.stats[k]))) ? Object.fromEntries(STAT_KEYS.map((k) => [k, Math.round(clamp(Number(p.stats[k]), 25, 99))])) : null;
    return {
      name: String(p.name || '').slice(0, 16),
      slot: s.label,
      age: clamp(Math.round(Number(p.age) || 25), 15, 45),
      stats,
    };
  });
  // DB(tactic jsonb)로 오간 좌표가 전술 값에 섞여 들어오지 않게 떼어 냅니다
  const tactic = { line: 0, pass: 0, press: 0, route: 0, mentality: 0, ...(raw.tactic || {}) };
  delete tactic.coords;
  return {
    v: TEAM_VERSION,
    id: String(raw.id || newTeamId()),
    name: String(raw.name || '이름 없는 팀').slice(0, 24),
    short: String(raw.short || '').slice(0, 5),
    size, formation,
    colors: { primary: String(raw.colors?.primary || '#02c245'), secondary: String(raw.colors?.secondary || '#ffffff') },
    players,
    customCoords: normalizeCoords(raw.customCoords, slots),
    tactic,
    roles: Array.isArray(raw.roles) && raw.roles.length ? resolveRoles(raw.roles, slots) : defaultRoles(slots),
    setpiece: resolveSetPiece(raw.setpiece),
    updatedAt: Number(raw.updatedAt) || Date.now(),
    code: raw.code ? String(raw.code) : null,
    sharedAt: Number(raw.sharedAt) || 0,
    from: raw.from ? String(raw.from).slice(0, 40) : null,
    // 공유에서 들여온 내용 지문 — 같은 팀을 다시 불러올 때 새 팀을 만들지 않고 덮어쓰는 기준
    sharedKey: raw.sharedKey ? String(raw.sharedKey).slice(0, 40) : null,
  };
}

/* 팀 내용 지문 — 이름·규모·포메이션·선수·대형·전술·역할·세트피스가 모두 같으면 같은 팀으로 봅니다.
   공유 코드(6자리)가 없는 긴 링크(Z…)로 같은 팀을 여러 번 열어도 사본이 쌓이지 않게 하는 장치입니다. */
export function teamFingerprint(team) {
  const t = normalizeTeam(team);
  const body = JSON.stringify([
    t.name, t.size, t.formation,
    t.players.map((p) => [p.name, p.slot, p.age, p.stats]),
    t.customCoords, t.tactic, t.roles, t.setpiece,
  ]);
  let h = 5381;
  for (let i = 0; i < body.length; i += 1) h = ((h * 33) ^ body.charCodeAt(i)) >>> 0;
  return `fp${h.toString(36)}${body.length.toString(36)}`;
}

export const teamShort = (team) => (team.short || team.name || '팀').slice(0, 2);
export const teamSlotPos = (team, label) => posOfSlot(team.formation, label);

/* 포메이션·규모 바꾸기 — 자리 이름이 같은 선수는 그 자리로 따라갑니다 */
export function setFormation(team, fid) {
  if (!FORMATIONS[fid]) return team;
  const slots = slotsOf(fid);
  const byLabel = new Map();
  for (const p of team.players) if (!byLabel.has(p.slot)) byLabel.set(p.slot, p);
  const players = slots.map((s, i) => byLabel.get(s.label) || team.players[i] || emptyPlayer(s.label));
  team.players = players.map((p, i) => ({ ...p, slot: slots[i].label }));
  team.formation = fid;
  team.size = sizeOfFormation(fid);
  team.roles = defaultRoles(slots);
  team.customCoords = null;   // 포메이션을 바꾸면 자유 대형은 그 포메이션 기본 좌표로 돌아갑니다
  return team;
}

export function setSize(team, size) {
  const n = Number(size);
  if (![11, 6, 5].includes(n) || n === team.size) return team;
  return setFormation(team, formationsFor(n)[0]);
}

/* 세트피스 지시 — 코너킥·프리킥을 어떻게 찰지 고릅니다 */
export function setTeamSetPiece(team, type, key) {
  team.setpiece = resolveSetPiece({ ...(team.setpiece || {}), [type]: key });
  return team.setpiece;
}

/* ─────────────────────────── 능력치 ─────────────────────────── */
export function ovrOf(team, p) {
  if (!p?.stats) return 0;
  return overall({ pos: posOfSlot(team.formation, p.slot), age: p.age, stats: p.stats });
}
export const teamPowerOf = (team) => {
  const list = team.players.map((p) => ovrOf(team, p)).filter(Boolean).sort((a, b) => b - a).slice(0, team.size);
  return list.length ? Math.round(list.reduce((a, b) => a + b, 0) / list.length) : 0;
};

/* OVR 한 칸 → 포지션에 맞춰 세부 능력치를 자동으로 깔아 줍니다 */
export function setPlayerOvr(team, i, ovr, seed = '') {
  const p = team.players[i];
  if (!p) return;
  const pos = posOfSlot(team.formation, p.slot);
  const target = clamp(Math.round(Number(ovr) || 60), 25, 97);
  const rng = makeRng(`ovr-${team.id}-${i}-${p.slot}-${target}-${seed}`);
  p.stats = statsFor(rng, pos, target, p.age);
  return p;
}

export function setPlayerStat(team, i, key, value) {
  const p = team.players[i];
  if (!p || !STAT_KEYS.includes(key)) return;
  if (!p.stats) setPlayerOvr(team, i, 60);
  p.stats[key] = Math.round(clamp(Number(value) || 25, 25, 99));
}

export function setPlayerAge(team, i, age) {
  const p = team.players[i];
  if (!p) return;
  p.age = clamp(Math.round(Number(age) || 25), 15, 45);
}

export function setPlayerName(team, i, name) {
  const p = team.players[i];
  if (!p) return;
  p.name = String(name || '').slice(0, 16);
}

/* 빈 자리 채우기 — 이름이 없거나 능력치가 없는 자리에 균형 잡힌 선수를 넣습니다.
   level: 그 팀의 기준 종합 (기본 68). 포지션별로 ±4 흔들림. */
export function autoFill(team, opts = {}) {
  const level = clamp(Number(opts.level) || Math.max(60, Math.min(80, teamPowerOf(team) || 68)), 40, 90);
  const used = new Set(team.players.map((p) => p.name).filter(Boolean));
  const added = [];
  team.players.forEach((p, i) => {
    const empty = !p.name || !p.stats;
    if (!empty) return;
    if (!p.name) p.name = randomName(makeRng(`fill-${team.id}-${i}-${level}-${team.players.length}`), used);
    const pos = posOfSlot(team.formation, p.slot);
    const target = clamp(level + (pos === 'GK' ? 1 : 0) + Math.round((((i * 37) % 9) - 4)), 30, 92);
    setPlayerOvr(team, i, target, 'fill');
    added.push(p);
  });
  return added;
}

/* ─────────────────────────── 빠른 일괄 입력 ─────────────────────────── */
const LABEL_WORDS = {
  GK: ['GK', '골키퍼', '키퍼', 'G'], DF: ['DF', '수비', '수비수', 'D'], MF: ['MF', '미들', '미드필더', '중원', 'M'],
  FW: ['FW', '공격', '공격수', '스트라이커', 'F'], FIXO: ['FIXO', '피보'], ALA: ['ALA', '알라'], PIVO: ['PIVO', '피보타', '피보'],
};
/* 자리 이름을 그대로 적어도 받아 줍니다 (ST·CB·CM·LW …) */
const SLOT_WORDS = new Set(Object.keys(LABEL_CAT));
const labelOfWord = (word) => {
  const w = String(word || '').trim().toUpperCase();
  if (SLOT_WORDS.has(w)) return w;
  for (const [label, list] of Object.entries(LABEL_WORDS)) if (list.includes(w)) return label;
  return null;
};

/* "김철수 ST 84" · "김철수,MF,79" · "김철수 84" · "김철수"
   줄바꿈·쉼표·탭으로 구분합니다. */
export function parseBulk(text) {
  const rows = [];
  const errors = [];
  String(text || '').split(/\r?\n/).forEach((line, n) => {
    const raw = line.trim();
    if (!raw) return;
    const parts = raw.split(/[,\t|]+/).map((s) => s.trim()).filter(Boolean);
    let name = '', label = null, ovr = null;
    // "이름 ST 84" 처럼 공백으로만 나뉜 줄
    if (parts.length === 1) {
      const m = raw.match(/^(.+?)\s+([A-Za-z가-힣]+)(?:\s+(\d{2,3}))?$/) || raw.match(/^(.+?)\s+(\d{2,3})$/);
      if (m) {
        name = m[1].trim();
        const w = labelOfWord(m[2]);
        if (w) label = w; else if (m[2] && /^\d{2,3}$/.test(m[2])) ovr = Number(m[2]);
        if (m[3]) ovr = Number(m[3]);
      } else name = raw;
      if (!label && /^\d{2,3}$/.test(parts[0])) { errors.push(`${n + 1}번째 줄: 이름이 없습니다`); return; }
    } else {
      name = parts[0];
      for (const p of parts.slice(1)) {
        const l = labelOfWord(p);
        if (l && !label) label = l;
        else if (/^\d{2,3}$/.test(p) && ovr == null) ovr = Number(p);
      }
    }
    if (!name) { errors.push(`${n + 1}번째 줄: 이름이 없습니다`); return; }
    if (ovr != null && (ovr < 25 || ovr > 97)) { errors.push(`${n + 1}번째 줄: OVR 은 25~97 사이여야 합니다 (${ovr})`); return; }
    rows.push({ name: name.slice(0, 16), label, ovr });
  });
  return { rows, errors };
}

/* 파싱한 선수들을 빈 자리에 채웁니다. 자리 이름이 맞으면 그 자리, 아니면 같은 포지션 빈 자리, 그래도 없으면 앞에서부터. */
export function applyBulk(team, rows) {
  const slots = slotsOf(team.formation);
  const taken = new Set();
  const pickSlot = (label) => {
    const want = label ? (slots.some((s) => s.label === label) ? label : null) : null;
    if (want) {
      const i = slots.findIndex((s, idx) => s.label === want && !taken.has(idx) && !team.players[idx].name);
      if (i >= 0) return i;
      const j = slots.findIndex((s, idx) => s.label === want && !taken.has(idx));
      if (j >= 0) return j;
    }
    if (label) {
      const pos = categoryOf(label);
      const k = slots.findIndex((s, idx) => s.pos === pos && !taken.has(idx) && !team.players[idx].name);
      if (k >= 0) return k;
    }
    const free = slots.findIndex((s, idx) => !taken.has(idx) && !team.players[idx].name);
    if (free >= 0) return free;
    return slots.findIndex((s, idx) => !taken.has(idx));
  };
  let filled = 0;
  for (const row of rows) {
    const i = pickSlot(row.label);
    if (i < 0) break;
    taken.add(i);
    const p = team.players[i];
    p.name = row.name;
    if (row.ovr != null || !p.stats) setPlayerOvr(team, i, row.ovr ?? (ovrOf(team, p) || 68), 'bulk');
    else if (row.ovr != null) setPlayerOvr(team, i, row.ovr, 'bulk');
    filled += 1;
  }
  return filled;
}

/* ─────────────────────────── 저장 ─────────────────────────── */
export function readTeams() {
  const raw = local.get(TEAM_KEY, null);
  const list = Array.isArray(raw?.list) ? raw.list : Array.isArray(raw) ? raw : [];
  const seen = new Map();
  for (const row of list) {
    const t = normalizeTeam(row);
    if (!t.id) continue;
    // 같은 id 가 두 번 들어간 저장소(예전 사고·직접 편집)는 최신 것 하나만 남깁니다
    const prev = seen.get(t.id);
    if (!prev || (t.updatedAt || 0) >= (prev.updatedAt || 0)) seen.set(t.id, t);
  }
  return { v: TEAM_VERSION, list: [...seen.values()] };
}
export function writeTeams(db) {
  try { local.set(TEAM_KEY, { v: TEAM_VERSION, list: db.list.slice(0, TEAM_MAX) }); return { ok: true }; }
  catch { return { ok: false, why: '브라우저 저장 공간이 부족해 팀을 저장하지 못했습니다.' }; }
}
/* 저장 — 같은 id 가 있으면 그 팀을 덮어쓰고, 없을 때만 새로 넣습니다.
   (새 팀은 「+ 새 팀」·「복제」·공유 불러오기에서만 만들어집니다) */
export function saveTeam(team) {
  const db = readTeams();
  const t = { ...normalizeTeam(team), updatedAt: Date.now() };
  const i = db.list.findIndex((x) => x.id === t.id);
  const created = i < 0;
  if (!created) db.list[i] = t; else db.list = [t, ...db.list];
  const r = writeTeams(db);
  return r.ok ? { ok: true, team: t, created, count: Math.min(db.list.length, TEAM_MAX) } : r;
}
export function deleteTeam(id) {
  const db = readTeams();
  const before = db.list.length;
  db.list = db.list.filter((x) => x.id !== id);
  if (db.list.length === before) return { ok: false, why: '팀을 찾을 수 없습니다.' };
  return writeTeams(db);
}
export const getTeam = (id) => readTeams().list.find((t) => t.id === id) || null;

/* ─────────────────────────── 공유 ─────────────────────────── */
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';   // 헷갈리는 O·I·0·1 제외
export function makeCode(len = 6) {
  let out = '';
  const bytes = new Uint8Array(len);
  if (globalThis.crypto?.getRandomValues) globalThis.crypto.getRandomValues(bytes);
  else for (let i = 0; i < len; i++) bytes[i] = Math.floor(Math.random() * 256);
  for (let i = 0; i < len; i++) out += CODE_ALPHABET[bytes[i] % CODE_ALPHABET.length];
  return out;
}

/* DB·링크에 담을 압축 모양 — 선수는 [이름, 자리, 나이, ...8개 능력치] 배열 */
export function packTeam(team) {
  const t = normalizeTeam(team);
  autoFill(t);   // 빈자리가 있으면 같이 채워서 보냅니다 (받는 사람이 바로 경기 가능)
  return {
    v: 1,
    name: t.name,
    short: teamShort(t),
    size: t.size,
    formation: t.formation,
    colors: t.colors,
    tactic: t.tactic,
    roles: t.roles,
    setpiece: t.setpiece,
    // 자유 대형 — [x, y] 쌍으로 담아 DB(tactic jsonb)·링크 어디로 가도 그대로 살아나게
    coords: isCustomShape(t) ? t.customCoords.map((c) => [c.x, c.y]) : null,
    players: t.players.map((p) => [p.name, p.slot, p.age, ...STAT_KEYS.map((k) => p.stats?.[k] ?? 60)]),
  };
}
export function unpackTeam(packed, extra = {}) {
  if (!packed || !Array.isArray(packed.players)) return null;
  const players = packed.players.map((row) => ({
    name: row[0], slot: row[1], age: row[2],
    stats: Object.fromEntries(STAT_KEYS.map((k, i) => [k, row[3 + i]])),
  }));
  const coords = Array.isArray(packed.coords)
    ? packed.coords.map((c) => (Array.isArray(c) ? { x: Number(c[0]), y: Number(c[1]) } : c))
    : null;
  return normalizeTeam({
    id: extra.id || newTeamId(),
    name: packed.name, short: packed.short, size: packed.size, formation: packed.formation,
    colors: packed.colors, tactic: packed.tactic, roles: packed.roles, setpiece: packed.setpiece,
    customCoords: coords,
    players, code: extra.code || null, from: extra.from || null,
  });
}

/* 링크에 팀 전체를 담는 fallback 코드 (DB 없이도 공유) */
const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
export function encodePayload(packed) {
  const json = JSON.stringify(packed);
  const bytes = new TextEncoder().encode(json);
  let out = 'Z';
  for (let i = 0; i < bytes.length; i += 3) {
    const a = bytes[i], b = bytes[i + 1], c = bytes[i + 2];
    out += B64[a >> 2];
    out += B64[((a & 3) << 4) | ((b ?? 0) >> 4)];
    if (b == null) break;
    out += B64[((b & 15) << 2) | ((c ?? 0) >> 6)];
    if (c == null) break;
    out += B64[c & 63];
  }
  return out;
}
export function decodePayload(code) {
  if (!code || code[0] !== 'Z') return null;
  try {
    const s = code.slice(1);
    const bytes = [];
    for (let i = 0; i < s.length; i += 4) {
      const n = [0, 1, 2, 3].map((k) => B64.indexOf(s[i + k] || 'A'));
      bytes.push((n[0] << 2) | (n[1] >> 4));
      if (s[i + 2] != null) bytes.push(((n[1] & 15) << 4) | (n[2] >> 2));
      if (s[i + 3] != null) bytes.push(((n[2] & 3) << 6) | n[3]);
    }
    return JSON.parse(new TextDecoder().decode(new Uint8Array(bytes)));
  } catch { return null; }
}

/* Supabase 클라이언트는 필요할 때만 불러옵니다 — 인터넷·설정이 없어도 앱은 그대로 동작해야 합니다. */
let clientPromise = null;
async function db() {
  if (!clientPromise) {
    clientPromise = import('./supabase.js')
      .then((m) => m.supabase || null)
      .catch(() => null);
  }
  return clientPromise;
}

export const appBase = () => {
  const path = String(globalThis.location?.pathname || '/fm/');
  return `${globalThis.location?.origin || 'https://bmrgoodway.github.io'}${path.replace(/index\.html$/, '')}`;
};
export const teamLink = (code) => `${appBase()}?team=${encodeURIComponent(code)}`;
export const matchLink = (a, b) => `${appBase()}?match=${encodeURIComponent(a)}:${encodeURIComponent(b)}`;

/* 팀을 공유 표에 올리고 코드를 받습니다. 실패하면 { ok:false, why } — 화면은 긴 링크로 안내합니다. */
export async function publishTeam(team) {
  const packed = packTeam(team);
  const short = teamShort(team);
  let lastErr = '';
  const sb = await db();
  if (!sb) return { ok: false, why: '공유 서버에 연결하지 못했습니다. 링크 공유를 이용해 주세요.', packed };
  for (let attempt = 0; attempt < 4; attempt++) {
    const code = makeCode();
    try {
      const { error } = await sb.from(REMOTE_TABLE).insert({
        code, name: packed.name.slice(0, 24), short, size: packed.size, formation: packed.formation,
        colors: packed.colors, players: packed.players,
        // 자유 대형은 표 구조를 바꾸지 않고 tactic jsonb 안에 함께 실어 보냅니다
        tactic: { ...packed.tactic, coords: packed.coords },
      });
      if (!error) return { ok: true, code, packed };
      lastErr = error.message || String(error);
      // 코드가 겹쳤으면 새 코드로 다시 (그 밖의 오류는 바로 알립니다)
      if (!/duplicate|unique|23505/i.test(lastErr)) break;
    } catch (e) { lastErr = String(e?.message || e); break; }
  }
  return { ok: false, why: `공유 서버에 저장하지 못했습니다${lastErr ? ` (${lastErr.slice(0, 80)})` : ''}. 링크 공유를 이용해 주세요.`, packed };
}

/* 코드로 팀을 불러옵니다. 6자리 코드는 DB, Z로 시작하는 긴 코드는 링크에 담긴 팀입니다. */
export async function fetchTeam(code) {
  const raw = String(code || '').trim();
  if (!raw) return { ok: false, why: '공유 코드를 입력해 주세요.' };
  const key = raw.toUpperCase().replace(/[^A-Z0-9]/g, '');
  if (raw.startsWith('Z') && raw.length > 20) {
    const packed = decodePayload(raw);
    const team = packed && unpackTeam(packed, { from: 'link' });
    return team ? { ok: true, team } : { ok: false, why: '링크에 담긴 팀 정보를 읽지 못했습니다.' };
  }
  if (key.length < 4 || key.length > 12) return { ok: false, why: '공유 코드는 4~12자리입니다.' };
  const sb = await db();
  if (!sb) return { ok: false, why: '공유 서버에 연결하지 못했습니다. 잠시 뒤 다시 시도해 주세요.' };
  try {
    const { data, error } = await sb.from(REMOTE_TABLE).select('code,name,short,size,formation,colors,players,tactic,created_at').eq('code', key).maybeSingle();
    if (error) return { ok: false, why: `불러오지 못했습니다 (${(error.message || '').slice(0, 80)})` };
    if (!data) return { ok: false, why: '그 코드의 팀을 찾지 못했습니다. 코드를 확인해 주세요.' };
    const tactic = { ...(data.tactic || {}) };
    const coords = tactic.coords ?? null;
    delete tactic.coords;
    const team = unpackTeam({
      name: data.name, short: data.short, size: data.size, formation: data.formation,
      colors: data.colors, players: data.players, tactic, coords,
    }, { code: key, from: `${data.created_at?.slice(0, 10) || ''} 공유` });
    if (!team) return { ok: false, why: '팀 정보가 손상되어 읽지 못했습니다.' };
    return { ok: true, team };
  } catch (e) {
    return { ok: false, why: `불러오지 못했습니다 (${String(e?.message || e).slice(0, 80)})` };
  }
}

/* ─────────────────────────── 경기용 세계 ─────────────────────────── */
/* K리그 구단을 풋살 규모로 부를 때 쓰는 기본 포메이션 */
const FUTSAL_DEFAULT = { 6: '1-2-2', 5: '1-2-1' };

function pickLineup(world, teamId, formation, prefer = []) {
  const slots = slotsOf(formation);
  const squad = world.teams[teamId].squad.map((pid) => world.players[pid]).filter(Boolean);
  const val = (p, slot) => posFactor(slot.pos, p.pos) * 100 + p.ovr * 0.6 + (prefer.includes(p.id) ? 18 : 0);
  const pairs = [];
  squad.forEach((p) => slots.forEach((s, si) => pairs.push({ pid: p.id, si, v: val(p, s) })));
  pairs.sort((a, b) => b.v - a.v);
  const starters = new Array(slots.length).fill(null);
  const used = new Set();
  for (const { pid, si } of pairs) {
    if (starters[si] || used.has(pid)) continue;
    starters[si] = pid; used.add(pid);
  }
  const rest = squad.filter((p) => !used.has(p.id)).sort((a, b) => b.ovr - a.ovr);
  const gk = rest.find((p) => p.pos === 'GK');
  const bench = [...(gk ? [gk] : []), ...rest.filter((p) => p !== gk)].slice(0, 5).map((p) => p.id);
  return { formation, starters, bench };
}

function addCustomTeam(world, team, id) {
  const t = normalizeTeam(team);
  autoFill(t);
  const squad = [];
  t.players.forEach((p, i) => {
    const pos = posOfSlot(t.formation, p.slot);
    const stats = p.stats || statsFor(makeRng(`p-${id}-${i}`), pos, 68, p.age);
    const player = {
      id: `${id}_${i}`, name: p.name || `선수 ${i + 1}`, pos, age: p.age, num: i === 0 ? 1 : i + 1,
      stats, teamId: id, form: 0, season: freshSeasonStats(), growthLog: [],
      career: { apps: 0, goals: 0, assists: 0 },
    };
    player.ovr = overall(player);
    player.pot = player.ovr;
    player.value = valueOf(player);
    player.wage = wageOf(player);
    world.players[player.id] = player;
    squad.push(player.id);
  });
  world.teams[id] = {
    id, name: t.name, short: teamShort(t), nick: '커스텀 팀', city: '커스텀', stadium: '커스텀 구장',
    primary: t.colors.primary, secondary: t.colors.secondary, ink: '#101014',
    formation: t.formation, tactic: { line: 0, pass: 0, press: 0, route: 0, mentality: 0, ...t.tactic },
    squad, recent: [], div: null, custom: true,
  };
  // 자유 대형 — 기본 포메이션 자리의 pos·label 은 그대로 두고 x·y 만 옮긴 좌표로 바꿉니다.
  // Match 는 이 자리를 선수의 기준 위치(slot)로 씁니다.
  const coords = coordsOf(t);
  const slots = slotsOf(t.formation).map((s, i) => ({ ...s, x: coords[i].x, y: coords[i].y }));
  return {
    formation: t.formation, starters: squad.slice(), bench: [], slots,
    tactic: { line: 0, pass: 0, press: 0, route: 0, mentality: 0, ...t.tactic },
    roles: resolveRoles(t.roles, slotsOf(t.formation)),
    setpiece: resolveSetPiece(t.setpiece),
    team: t,
  };
}

function addKlTeam(world, klId, size) {
  const def = KL_BY_ID[klId];
  if (!def) return null;
  const rows = KL_ROSTERS[klId] || [];
  const used = new Set();
  let n = 1;
  const squad = [];
  for (const [name, pos, age, num, ovr] of rows) {
    const a = Number(age) > 0 ? Number(age) : 25;
    const target = clamp(Number(ovr) || 50, 28, 94);
    const id = `k_${klId}_${n++}`;
    const p = {
      id, name, pos, age: a, num: 0, stats: statsFor(makeRng(`kl-${klId}-${id}`), pos, target, a),
      teamId: klId, form: 0, season: freshSeasonStats(), growthLog: [], career: { apps: 0, goals: 0, assists: 0 },
    };
    p.ovr = overall(p);
    p.pot = p.ovr;
    p.value = valueOf(p);
    p.wage = wageOf(p);
    p.num = Number(num) || 0;
    world.players[id] = p;
    squad.push(id);
  }
  let num = 1;
  for (const id of squad) { const p = world.players[id]; if (!p.num) { while (used.has(num)) num += 1; p.num = num; used.add(num); } }
  const formation = size === 11 ? (FORMATIONS[def.formation] ? def.formation : '4-3-3') : FUTSAL_DEFAULT[size];
  world.teams[klId] = {
    id: klId, name: def.name, short: def.short, nick: def.nick, city: def.city, stadium: def.stadium,
    primary: def.primary, secondary: def.secondary, ink: def.ink || '#101014',
    formation, tactic: { line: 0, pass: 0, press: 0, route: 0, mentality: 0, ...def.tactic },
    squad, recent: [], div: def.div, custom: false,
  };
  const lineup = pickLineup(world, klId, formation);
  lineup.tactic = { ...world.teams[klId].tactic };
  lineup.roles = defaultRoles(slotsOf(formation));
  lineup.setpiece = resolveSetPiece(null);
  return lineup;
}

/* 경기용 세계 — home/away 는 { kind:'custom', team } 또는 { kind:'kl', id } */
export function buildMatchupWorld({ home, away, seed = Date.now(), mySide = 'home' }) {
  const size = home.kind === 'custom' ? home.team.size : away.kind === 'custom' ? away.team.size : Number(home.size || away.size || 11);
  const world = {
    version: 1, mode: 'matchup', seed, season: 1, myTeamId: null,
    teams: {}, players: {}, calendar: [], cup: { stages: [] }, myLineup: null,
    market: [], history: [], news: [], finance: { income: 0, spent: 0 }, pidSeq: 1,
    createdAt: Date.now(), form: {}, offers: [], offerSeq: 1, loans: [], transfers: [],
  };
  const homeId = home.kind === 'custom' ? `ct_${home.team.id}` : home.id;
  const awayId = away.kind === 'custom' ? `ct_${away.team.id}` : away.id;
  const homeLineup = home.kind === 'custom' ? addCustomTeam(world, home.team, homeId) : addKlTeam(world, home.id, size);
  const awayLineup = away.kind === 'custom' ? addCustomTeam(world, away.team, awayId) : addKlTeam(world, away.id, size);
  if (!homeLineup || !awayLineup) return null;
  // 같은 '약칭'이면 화면에서 구분이 안 되므로 뒤에 붙입니다
  if (world.teams[homeId].short === world.teams[awayId].short) world.teams[awayId].short = `${world.teams[awayId].short}2`.slice(0, 4);
  world.myTeamId = mySide === 'away' ? awayId : homeId;
  world.myLineup = { ...(mySide === 'away' ? awayLineup : homeLineup) };
  world.teams[homeId].size = size;
  world.teams[awayId].size = size;
  return { world, homeId, awayId, homeLineup, awayLineup, size };
}

/* ─────────────────────────── 결과 요약 ─────────────────────────── */
export const MOM_LABEL = 'MOM';
export function matchSummary(m) {
  const goals = m.events.filter((e) => e.type === 'goal').map((e) => ({
    side: e.side, minute: e.minute, label: e.label, scorer: e.scorer, assist: e.assist, score: e.score,
  }));
  const ratings = ['home', 'away'].flatMap((s) => m.ratings(s).map((r) => ({ ...r, side: s })));
  const mom = ratings.slice().sort((a, b) => b.rating - a.rating || (b.e.st.goals - a.e.st.goals))[0] || null;
  return { goals, mom, stats: m.stats(), score: { ...m.score }, pens: m.pens || null };
}

export function resultText(meta, m) {
  const sum = matchSummary(m);
  const home = m.world.teams[m.homeId], away = m.world.teams[m.awayId];
  const lines = [
    `⚽ ${home.name} ${m.score.home}-${m.score.away} ${away.name}${m.pens ? ` (PK ${m.pens.text})` : ''}`,
    `${formatName(meta.size)} 커스텀 매치업 · Football Manager`,
  ];
  const goals = sum.goals.map((g) => `  ${g.label} ${g.scorer}${g.assist ? ` (도움 ${g.assist})` : ''}`).join('\n');
  if (goals) lines.push('득점', goals);
  if (sum.mom) lines.push(`MOM ${sum.mom.e.name} (${sum.mom.e.side === 'home' ? home.short : away.short}, 평점 ${sum.mom.rating})`);
  const st = sum.stats;
  lines.push(`점유율 ${st.possession.home}:${st.possession.away} · 슈팅 ${st.shots.home}-${st.shots.away} · 유효슈팅 ${st.onTarget.home}-${st.onTarget.away}`);
  return lines.join('\n');
}
