// 경기 요약 로그 — 커리어 세이브(localStorage)를 무겁게 하지 않도록
// 경기별 '경량 요약'(스코어·득점자·주요 기록)만 별도 키('fm:matchlog')에 담습니다.
//
//   · 내 경기: 경기 엔진이 이미 계산한 득점 장면·기록·평점을 그대로 옮겨 적습니다.
//   · AI 경기: 빠른 시뮬레이션(simMatchQuick)이 돌려준 스코어·득점자와 경량 기록을 적습니다.
//   · 2MB 를 넘지 않도록 시즌 단위로 묶고, 예산(LOG_BUDGET)을 넘으면 오래된 시즌·경기부터 버립니다.
import { local } from './store.js';

export const LOG_KEY = 'matchlog';
export const LOG_VERSION = 1;
// 이 로그가 차지하는 최대 글자 수(JSON 기준). 브라우저 localStorage 한도를 함께 쓰는
// 다른 앱들을 배려해 0.7MB 로 잡습니다. (경기 1건 ≈ 150~250B → 시즌 900경기 ≈ 180KB)
export const LOG_BUDGET = 700_000;
export const MAX_SEASONS = 5;

/* ── 저장소 ─────────────────────────────────────────────────────
   테스트(node)에서는 setLogStore(메모리 저장소)로 갈아 끼울 수 있습니다. */
let backend = null;
const cache = new WeakMap();
export function setLogStore(store) { backend = store || null; }
const store = () => backend || local;

function readRaw(s) {
  let log = cache.get(s);
  if (log) return log;
  const got = s.get(LOG_KEY, null);
  if (!got || typeof got !== 'object' || got.v !== LOG_VERSION || !Array.isArray(got.seasons)) {
    log = { v: LOG_VERSION, seasons: [] };
  } else {
    log = got;
  }
  cache.set(s, log);
  return log;
}

const sizeOf = (log) => JSON.stringify(log).length;

function prune(log) {
  log.seasons.sort((a, b) => (b.at || 0) - (a.at || 0));
  while (log.seasons.length > MAX_SEASONS) log.seasons.pop();
  while (log.seasons.length > 1 && sizeOf(log) > LOG_BUDGET) log.seasons.pop();
  // 한 시즌만 남았는데도 넘치면 오래된 라운드부터 버립니다 (최근 경기가 더 쓸모 있습니다)
  let guard = 0;
  while (sizeOf(log) > LOG_BUDGET && guard < 4000) {
    guard += 1;
    const bucket = log.seasons[0];
    const keys = Object.keys(bucket.m);
    if (!keys.length) break;
    let oldest = null;
    for (const k of keys) {
      const e = bucket.m[k];
      if (!oldest || (e.r || 0) < (bucket.m[oldest].r || 0)) oldest = k;
    }
    delete bucket.m[oldest];
  }
  return log;
}

/* 이 세계(커리어)의 시즌 묶음 이름 — 시즌이 넘어가면 새 묶음이 됩니다. */
export function worldSeasonId(w) {
  const kl = w?.mode === 'kleague';
  return `${kl ? 'kl' : 'cu'}-${w?.seed}-${kl ? (w?.year || 0) : (w?.season || 0)}`;
}

/* 경기 키 — 달력 라운드·종류·두 팀으로 만듭니다 (한 시즌 안에서 유일). */
export function matchKey(round, home, away) {
  const tag = round?.type === 'cup' ? `C${round.stage}` : `L${round.leagueRound}`;
  return `${tag}:${home}-${away}`;
}

/* 한 경기 요약을 적습니다. entries: [entry, ...] */
export function recordEntries(w, entries) {
  if (!w || !entries?.length) return false;
  const s = store();
  const log = readRaw(s);
  const id = worldSeasonId(w);
  let bucket = log.seasons.find((x) => x.id === id);
  if (!bucket) {
    bucket = { id, at: Date.now(), m: {} };
    log.seasons.unshift(bucket);
  }
  for (const e of entries) {
    if (!e || !e.k) continue;
    bucket.m[e.k] = e;
  }
  bucket.at = Date.now();
  prune(log);
  cache.set(s, log);
  try {
    s.set(LOG_KEY, log);
    return true;
  } catch {
    // 용량 초과 — 가장 오래된 시즌을 버리고 한 번 더 시도합니다.
    while (log.seasons.length > 1) {
      log.seasons.pop();
      try { s.set(LOG_KEY, log); return true; } catch { /* 계속 */ }
    }
    return false;
  }
}

export function readLog() {
  return readRaw(store());
}

export function getEntry(w, round, home, away) {
  if (!w || !round) return null;
  const log = readRaw(store());
  const bucket = log.seasons.find((x) => x.id === worldSeasonId(w));
  return bucket?.m?.[matchKey(round, home, away)] || null;
}

/* 이 시즌에 저장된 요약 수 · 전체 크기(글자) — 화면에 용량을 보여 줄 때 씁니다. */
export function logInfo(w) {
  const log = readRaw(store());
  const bucket = w ? log.seasons.find((x) => x.id === worldSeasonId(w)) : null;
  return {
    bytes: sizeOf(log),
    seasons: log.seasons.length,
    count: bucket ? Object.keys(bucket.m).length : 0,
    total: log.seasons.reduce((a, b) => a + Object.keys(b.m || {}).length, 0),
  };
}

/* 한 시즌 기록만 지웁니다 (다른 커리어 기록은 그대로). */
export function clearSeason(w) {
  const s = store();
  const log = readRaw(s);
  log.seasons = log.seasons.filter((x) => x.id !== worldSeasonId(w));
  cache.set(s, log);
  try { s.set(LOG_KEY, log); return true; } catch { return false; }
}

/* ── 요약 만들기 ─────────────────────────────────────────────── */
// 기록 배열 [점유율, 슈팅, 유효슈팅, xG, 코너, 파울, 오프사이드, 경고, 퇴장]
export const STAT_FIELDS = ['poss', 'shots', 'onTarget', 'xg', 'corners', 'fouls', 'offsides', 'yellow', 'red'];
export const STAT_LABELS = { poss: '점유율', shots: '슈팅', onTarget: '유효슈팅', xg: 'xG', corners: '코너킥', fouls: '파울', offsides: '오프사이드', yellow: '경고', red: '퇴장' };

export function packStats(s) {
  if (!s) return null;
  return STAT_FIELDS.map((k) => (k === 'xg' ? Math.round((Number(s[k]) || 0) * 100) / 100 : Math.round(Number(s[k]) || 0)));
}
export function unpackStats(arr) {
  if (!Array.isArray(arr)) return null;
  const out = {};
  STAT_FIELDS.forEach((k, i) => { out[k] = arr[i] ?? 0; });
  return out;
}

const goalsOf = (events) => (events || [])
  .filter((e) => e.type === 'goal')
  .map((e) => [Math.max(1, Math.round(e.minute || 1)), e.side === 'away' ? 'a' : 'h', e.scorer || '', e.assist || '']);

/* 내 경기 — Match 객체에서 그대로 옮겨 적습니다 (중계·기록·평점이 이미 계산돼 있습니다). */
export function entryFromMatch(w, m, round, home, away) {
  const st = m.stats();
  const ratings = (side) => m.ratings(side).map(({ e, rating }) => [e.num, e.name, e.pos, rating, e.st?.goals || 0, e.st?.assists || 0]);
  return {
    k: matchKey(round, home, away),
    r: round.no,
    h: home, a: away, hg: m.score.home, ag: m.score.away,
    aet: m.aet ? 1 : 0,
    pen: m.pens ? m.pens.text : null,
    g: goalsOf(m.events),
    s: {
      h: packStats({ poss: st.possession.home, shots: st.shots.home, onTarget: st.onTarget.home, xg: st.xg.home, corners: st.corners.home, fouls: st.fouls.home, offsides: st.offsides.home, yellow: st.yellow.home, red: st.red.home }),
      a: packStats({ poss: st.possession.away, shots: st.shots.away, onTarget: st.onTarget.away, xg: st.xg.away, corners: st.corners.away, fouls: st.fouls.away, offsides: st.offsides.away, yellow: st.yellow.away, red: st.red.away }),
    },
    rt: { h: ratings('home'), a: ratings('away') },
    mine: 1,
  };
}

/* AI 경기 — 빠른 시뮬레이션 결과(r)에서 옮겨 적습니다. */
export function entryFromQuick(w, round, fixture, r) {
  const goals = goalsOf(r.events);
  // 컵대회 무승부는 연장에서 가려집니다 (playOtherFixtures 가 홈에 +1). 그 장면도 남깁니다.
  if (r.aet && r.hg > r.ag && goals.filter((g) => g[1] === 'h').length < r.hg) goals.push([95, 'h', '연장 결승골', '']);
  return {
    k: matchKey(round, fixture.home, fixture.away),
    r: round.no,
    h: fixture.home, a: fixture.away, hg: r.hg, ag: r.ag,
    aet: r.aet ? 1 : 0,
    pen: null,
    g: goals,
    s: r.stats ? { h: packStats(r.stats.home), a: packStats(r.stats.away) } : null,
    quick: 1,
  };
}
