// 저장 / 불러오기 — 수동 세이브 슬롯과 JSON 파일 백업·복원.
//
//   · 슬롯은 3개. 커리어 세이브(자동 저장)와 별개 키('fm:slots')에 담습니다.
//   · 슬롯 한 칸이 브라우저 저장소를 너무 많이 차지하지 않도록, 선수를 고정 순서 배열로
//     바꿔 넣는 경량 인코딩을 씁니다 (월드 하나 ≈ 300KB → 약 230KB). 읽을 때 그대로 되돌립니다.
//   · 용량이 모자라면 이유를 돌려주고, 화면은 오래된 슬롯을 지우라고 안내합니다.
import { local } from './store.js';
import { STAT_KEYS } from './data.js';
import { fixWorld, seasonLabel, divName, divOf, cupLabelOf, userNextMatch, myFixtures, SAVE_VERSION } from './world.js';

export const SLOT_KEY = 'slots';
export const SLOT_COUNT = 3;
export const SLOT_VERSION = 1;
export const FILE_VERSION = 1;

const SEASON_KEYS = ['apps', 'starts', 'subs', 'goals', 'assists', 'shots', 'onTarget', 'saves', 'tackles', 'ratingSum', 'ratingCount', 'cleanSheets', 'yellow', 'red'];
const CAREER_KEYS = ['apps', 'goals', 'assists', 'seasons'];

let backend = null;
export function setSlotStore(store) { backend = store || null; }
const store = () => backend || local;

/* ── 선수 인코딩 ─────────────────────────────────────────────
   [id, name, pos, age, num, stats(8), teamId, form, season(14), career(4),
    growthLog(≤4), ovr, pot, value, wage, recent(≤5), bans, inj, loan] */
function encPlayer(p) {
  return [
    p.id, p.name, p.pos, p.age, p.num ?? 0,
    STAT_KEYS.map((k) => p.stats?.[k] ?? 0),
    p.teamId ?? null, p.form ?? 0,
    SEASON_KEYS.map((k) => p.season?.[k] ?? 0),
    CAREER_KEYS.map((k) => p.career?.[k] ?? 0),
    (p.growthLog || []).slice(-4).map((g) => [g.s ?? 0, g.d ?? 0, g.up || [], g.dn || [], g.st || []]),
    p.ovr ?? 0, p.pot ?? 0, p.value ?? 0, p.wage ?? 0,
    (p.recent || []).slice(-5),
    p.bans || 0, p.inj || 0,
    p.loan ? [p.loan.owner ?? null, p.loan.fee ?? 0, p.loan.season ?? 0] : 0,
  ];
}

function decPlayer(a) {
  if (!Array.isArray(a)) return null;
  const [id, name, pos, age, num, st, teamId, form, se, ca, gl, ovr, pot, value, wage, recent, bans, inj, loan] = a;
  const stats = {};
  STAT_KEYS.forEach((k, i) => { stats[k] = st?.[i] ?? 25; });
  const season = {};
  SEASON_KEYS.forEach((k, i) => { season[k] = se?.[i] ?? 0; });
  const career = {};
  CAREER_KEYS.forEach((k, i) => { career[k] = ca?.[i] ?? 0; });
  const p = {
    id, name, pos, age, num, stats, teamId: teamId ?? null, form: form ?? 0,
    season, career,
    growthLog: (Array.isArray(gl) ? gl : []).map((g) => ({ s: g[0] ?? 0, d: g[1] ?? 0, up: g[2] || [], dn: g[3] || [], st: g[4] || [] })),
    ovr, pot, value, wage,
    recent: Array.isArray(recent) ? recent : [],
    bans: bans || 0, inj: inj || 0,
  };
  if (Array.isArray(loan)) p.loan = { owner: loan[0] ?? null, fee: loan[1] ?? 0, season: loan[2] ?? 0 };
  return p;
}

/* 일정에서 지난 라운드의 '중계 이벤트'는 요약 로그에 따로 남으므로 슬롯에는 넣지 않습니다. */
function encCalendar(cal) {
  return (cal || []).map((r) => {
    const round = { ...r };
    if (Array.isArray(round.fixtures)) {
      round.fixtures = round.fixtures.map((f) => ({ home: f.home, away: f.away, played: !!f.played, hg: f.hg || 0, ag: f.ag || 0 }));
    }
    return round;
  });
}

export function encodeWorld(w) {
  const players = {};
  for (const p of Object.values(w.players || {})) players[p.id] = encPlayer(p);
  const teams = {};
  for (const [id, t] of Object.entries(w.teams || {})) teams[id] = { ...t, squad: t.squad || [] };
  return {
    v: SLOT_VERSION,
    w: {
      version: w.version ?? SAVE_VERSION,
      mode: w.mode || 'custom',
      seed: w.seed, season: w.season, year: w.year,
      myTeamId: w.myTeamId, pidSeq: w.pidSeq, createdAt: w.createdAt,
      divisions: w.divisions,
      teams,
      players,
      calendar: encCalendar(w.calendar),
      cup: w.cup,
      myLineup: w.myLineup,
      market: w.market || [],
      history: w.history || [],
      news: (w.news || []).slice(-8),
      finance: w.finance || { income: 0, spent: 0 },
      form: w.form || {},
      offers: w.offers || [],
      offerSeq: w.offerSeq || 1,
      loans: w.loans || [],
      transfers: (w.transfers || []).slice(0, 8),
      lastGrowth: null,
    },
  };
}

export function decodeWorld(data) {
  if (!data || typeof data !== 'object') return null;
  // 1) 이 앱의 슬롯/파일 형식 { v, w: {...} }
  if (data.w && data.v) {
    const raw = data.w;
    const world = { ...raw };
    world.players = {};
    for (const [id, a] of Object.entries(raw.players || {})) {
      const p = decPlayer(a);
      if (p) world.players[id] = p;
    }
    return fixWorld(world);
  }
  // 2) 예전 형식 — 세계 객체를 그대로 저장한 파일
  if (data.myTeamId && data.teams && data.players) return fixWorld({ ...data, players: { ...data.players } });
  return null;
}

/* 슬롯 목록에 보여 줄 요약 */
export function slotMeta(w) {
  const t = w.teams?.[w.myTeamId] || {};
  const nx = userNextMatch(w);
  const played = myFixtures(w).filter((x) => x.fixture.played).length;
  return {
    teamName: t.name || '',
    teamId: w.myTeamId || '',
    mode: w.mode || 'custom',
    div: w.mode === 'kleague' ? divName(w, divOf(w, w.myTeamId)) : '커스텀 리그',
    season: seasonLabel(w),
    round: nx ? (nx.round.type === 'cup' ? cupLabelOf(w, nx.round.stage) : `리그 ${nx.round.leagueRound}R`) : '시즌 종료',
    played,
  };
}

/* ── 슬롯 저장소 ─────────────────────────────────────────────── */
export function readSlots() {
  const raw = store().get(SLOT_KEY, null);
  const list = Array.from({ length: SLOT_COUNT }, (_, i) => {
    const s = raw?.list?.[i];
    return s && s.data ? s : null;
  });
  return { v: SLOT_VERSION, list };
}

function writeSlots(db) {
  try { store().set(SLOT_KEY, db); return { ok: true }; }
  catch {
    return { ok: false, why: '브라우저 저장 공간이 부족합니다. 쓰지 않는 슬롯을 지우거나 JSON 파일로 내보낸 뒤 다시 시도해 주세요.' };
  }
}

export function slotBytes(i) {
  const s = readSlots().list[i];
  if (!s) return 0;
  try { return JSON.stringify(s).length; } catch { return 0; }
}
export function slotsBytes() {
  try { return JSON.stringify(readSlots()).length; } catch { return 0; }
}

export function saveSlot(i, w) {
  if (i < 0 || i >= SLOT_COUNT) return { ok: false, why: '없는 슬롯입니다.' };
  const db = readSlots();
  let data, bytes = 0;
  try {
    data = encodeWorld(w);
    bytes = JSON.stringify(data).length;
  } catch {
    return { ok: false, why: '세이브를 만들지 못했습니다. 잠시 뒤 다시 시도해 주세요.' };
  }
  db.list[i] = { at: Date.now(), bytes, meta: slotMeta(w), data };
  const r = writeSlots(db);
  return r.ok ? { ok: true, slot: db.list[i], bytes } : r;
}

export function deleteSlot(i) {
  const db = readSlots();
  if (!db.list[i]) return { ok: false, why: '이미 비어 있는 슬롯입니다.' };
  db.list[i] = null;
  return writeSlots(db);
}

export function loadSlot(i) {
  const s = readSlots().list[i];
  if (!s) return { ok: false, why: '빈 슬롯입니다.' };
  const w = decodeWorld(s.data);
  if (!w) return { ok: false, why: '이 슬롯의 세이브를 읽을 수 없습니다.' };
  return { ok: true, world: w, meta: s.meta, at: s.at };
}

/* ── JSON 파일 백업 · 복원 ─────────────────────────────────── */
export function exportPayload(w) {
  return { app: 'fm', v: FILE_VERSION, at: Date.now(), meta: slotMeta(w), data: encodeWorld(w) };
}

export function exportFileName(w) {
  const t = w.teams?.[w.myTeamId] || {};
  const safe = String(t.name || 'fm').replace(/[\\/:*?"<>|\s]+/g, '');
  const d = new Date();
  const stamp = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`;
  const season = w.mode === 'kleague' ? (w.year || '') : `${w.season || 1}시즌`;
  return `fm-${safe}-${season}-${stamp}.json`;
}

/* 파일 텍스트 → 세계. 형식이 다르면 이유를 돌려줍니다. */
export function parseSaveFile(text) {
  const s = String(text || '').trim();
  if (!s) return { ok: false, why: '빈 파일입니다.' };
  if (s.length > 8_000_000) return { ok: false, why: '파일이 너무 큽니다 (8MB 초과).' };
  let raw;
  try { raw = JSON.parse(s); } catch { return { ok: false, why: 'JSON 형식이 아니어서 읽을 수 없습니다.' }; }
  const world = decodeWorld(raw?.data ?? raw);
  if (!world) return { ok: false, why: 'Football Manager 세이브 파일이 아니거나 손상되었습니다.' };
  return { ok: true, world, meta: raw?.meta || slotMeta(world), bytes: s.length };
}
