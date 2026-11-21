// 2D 바둑알 매치 엔진 — 90분(+추가시간)을 1분=4틱으로 시뮬레이션
// · 전술 4축(수비 라인·패스·압박·공격 루트)이 선수 좌표를 크게 바꿉니다.
// · 세트피스(코너킥·프리킥·골킥) · 파울/경고/퇴장/부상 · 하프타임과 진영 교대.
// · 틱마다 '이전 좌표(px,py) → 현재 좌표(x,y)'를 남겨 화면이 프레임마다 보간(lerp)합니다.
// 화면(DOM)에 의존하지 않으므로 '즉시 결과'에서도 그대로 돌릴 수 있습니다.
import { makeRng, clamp, rint, pick } from './rng.js';
import { FORMATIONS } from './data.js';
import { posFactor, autoLineup } from './world.js';

export const W = 100, H = 64, CY = 32, GOAL_HALF = 3.7;
const TPM = 4;            // 1분 = 4틱 (한 틱 = 경기 15초)
// 한 틱(경기 15초)을 몇 단계로 쪼개 판단·이동하는지.
// 공이 여러 틱에 걸쳐 날아가게 되면서 그 사이 '결정할 기회'가 줄어드는데,
// 단계 수를 늘려 경기 흐름(패스·슛 빈도)을 예전과 같게 유지합니다.
const SUBSTEPS = 5;
const STEP_K = 3 / SUBSTEPS;   // 3단계 기준이던 이동량·확률을 틱 기준으로 같게
const SETUP_TICKS = { corner: 3, freekick: 3, goalkick: 2 };
const WARP_TICKS = 2;     // 세트피스·재개 때 제자리로 모이는 데 쓰는 틱 수(한 프레임 순간이동 대신)
const DIVE_LAND_TICKS = 2; // 다이빙을 마친 키퍼가 일어나는 데 쓰는 틱 수

/* 골키퍼 다이빙 진행도 — 0(서 있음) → 1(완전히 뻗음). 마무리(landAt) 뒤에는 2틱에 걸쳐 돌아옵니다. */
export function diveProgress(dive, t, a = 0) {
  if (!dive) return 0;
  if (dive.landAt != null) return Math.max(0, 1 - (t - dive.landAt + a) / DIVE_LAND_TICKS);
  return Math.max(0, Math.min(1.12, (t - dive.at + a) / Math.max(dive.dur || 1, 1)));
}

/* 유니폼 색이 비슷하면 원정팀은 다른 키트를 입는다 */
function rgb(hex) {
  const h = String(hex || '').replace('#', '');
  if (h.length !== 6) return [0, 0, 0];
  return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
}
function colorGap(a, b) {
  const [r1, g1, b1] = rgb(a), [r2, g2, b2] = rgb(b);
  return Math.sqrt((r1 - r2) ** 2 + (g1 - g2) ** 2 + (b1 - b2) ** 2);
}
const ALT_KITS = ['#ffdc1a', '#ff614a', '#7e65c1', '#02c245', '#101014', '#0abbee', '#ffffff'];
function pickAwayKit(homeKit, away) {
  const cands = [...ALT_KITS, away.secondary];
  for (const c of cands) if (c && colorGap(homeKit, c) > 120 && colorGap(away.primary, c) > 60) return c;
  return '#ffffff';
}

const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
// 받침 유무로 조사를 고릅니다 (남상현'이' / 류재현'이' / 조민성'이' / 김선우'가')
const hasJong = (word) => {
  const s = String(word || '').trim();
  if (!s) return false;
  const c = s.charCodeAt(s.length - 1);
  if (c < 0xac00 || c > 0xd7a3) return false;
  return (c - 0xac00) % 28 > 0;
};
const JOSA = { '가': ['이', '가'], '는': ['은', '는'], '를': ['을', '를'], '와': ['과', '와'] };
// 골문 쪽으로 얼마나 전진했는지 (0=자기 골문, 100=상대 골문)
const prog = (x, dir) => (dir > 0 ? x : W - x);

/* ─────────────────────────── 중계 멘트 풀 ───────────────────────────
   {p}=주인공, {p2}=두 번째 선수, {t}=팀 약칭, {n}=숫자 */
const SAY = {
  kickoff: [
    '{t}의 킥오프로 경기가 시작됩니다.',
    '주심의 휘슬 — {t}가 먼저 공을 굴립니다.',
  ],
  build: [
    '{p}, 중원에서 시야를 확보합니다.',
    '{t}가 후방에서 차분히 공을 돌립니다.',
    '{p}가 동료와 짧게 주고받으며 상대 진영을 탐색합니다.',
    '{p}의 첫 터치가 부드럽습니다. {t}의 빌드업이 이어집니다.',
    '중원에서 {p}가 방향을 잡습니다.',
    '{p}가 한 템포 늦추며 동료들의 움직임을 기다립니다.',
  ],
  carry: [
    '{p}가 드리블로 전진합니다.',
    '{p}, 한 명 제치고 앞으로!',
    '{p}가 측면 공간을 파고듭니다.',
    '{p}의 발밑이 가볍습니다. 수비가 물러섭니다.',
    '{p}가 볼을 지키며 기회를 엿봅니다.',
  ],
  through: [
    '스루패스! {p}가 수비 라인 뒤로 찔러 넣습니다.',
    '{p}의 날카로운 스루패스가 수비 사이를 갈랐습니다.',
    '한 번에 수비 뒤 공간으로 — {p}의 패스!',
    '{p}가 뒷공간을 노려 스루패스를 시도합니다.',
  ],
  cross: [
    '{p}의 크로스가 박스로 향합니다!',
    '{p}가 측면에서 올립니다!',
    '{p}의 얼리 크로스 — 문전이 술렁입니다.',
    '{p}가 터치라인까지 붙어 크로스를 올립니다.',
  ],
  shot: [
    '{p}, 과감하게 슈팅!',
    '{p}가 오른발을 감아 찹니다!',
    '{p}의 중거리포!',
    '{p}가 박스 안에서 방아쇠를 당깁니다!',
    '{p}의 발등을 감싸는 슛!',
  ],
  woodwork: [
    '골대 강타! {p}의 슛이 프레임을 때립니다!',
    '아아, {p}의 슛이 골대를 맞고 나옵니다!',
    '크로스바! {p}가 고개를 떨굽니다.',
    '골대가 {p}를 막았습니다!',
  ],
  save: [
    '{p} 골키퍼가 몸을 날려 막아냅니다!',
    '{p}의 선방! 발끝으로 걸러냅니다.',
    '{p}가 각도를 좁혀 슈팅을 막았습니다.',
    '{p} 골키퍼의 집중력이 빛납니다.',
  ],
  supersave: [
    '슈퍼세이브! {p}가 골문을 지켜냅니다!',
    '믿기 힘든 선방 — {p}가 펄쩍 뛰어 쳐냅니다!',
    '{p}의 손끝에 걸렸습니다! 최고의 세이브!',
  ],
  miss: [
    '{p}의 슛이 골문을 벗어납니다.',
    '아쉽습니다. {p}의 슛이 골망 옆을 때립니다.',
    '{p}가 거듭 탄식합니다. 슛이 뜹니다.',
    '{p}의 슛이 수비 다리에 걸립니다.',
  ],
  goal: [
    '골! {t} {p}의 슛이 골망을 흔듭니다!',
    '골입니다! {p}가 침착하게 마무리했습니다!',
    '{p}의 슛이 그물을 갈랐습니다! {t} 득점!',
    '골!!! {p}의 발끝에서 경기가 흔들립니다!',
  ],
  corner: [
    '코너킥이 선언됩니다. 문전에 선수들이 모입니다.',
    '수비를 맞고 나갔습니다 — {t}의 코너킥 찬스.',
    '코너킥! 박스 안이 빽빽해집니다.',
  ],
  freekick: [
    '파울! 프리킥이 주어집니다.',
    '프리킥 찬스 — {p}가 공을 정리합니다.',
    '주심이 휘슬을 불고 프리킥을 선언합니다.',
  ],
  goalkick: [
    '골킥으로 경기가 다시 시작됩니다.',
    '문전을 벗어난 공, 골킥입니다.',
  ],
  foul: [
    '{p}의 늦은 태클, 파울이 선언됩니다.',
    '{p}가 {p2}를 밀어붙입니다. 반칙!',
    '{p}가 발을 높이 들었습니다. 파울!',
    '거친 경합 끝에 파울이 나옵니다.',
  ],
  yellow: [
    '🟨 경고! {p}에게 옐로카드가 주어집니다.',
    '🟨 {p}가 경고를 받습니다. 조심해야 합니다.',
    '🟨 늦은 태클, {p}에게 옐로카드.',
  ],
  red: [
    '🟥 퇴장! {p}가 그라운드에서 나갑니다!',
    '🟥 다이렉트 레드 — {p}가 퇴장당합니다!',
    '🟥 주심이 레드카드를 꺼냅니다. {t}가 수적 열세에 놓입니다.',
  ],
  secondYellow: [
    '🟥 경고 두 장 — {p}가 퇴장당합니다!',
    '🟨→🟥 두 번째 경고, {p}가 나갑니다.',
  ],
  injury: [
    '🚑 {p}가 그라운드에 쓰러졌습니다. 의료진이 들어갑니다.',
    '🚑 {p}가 다리를 부여잡습니다. 교체가 필요해 보입니다.',
    '🚑 경합 후 {p}가 일어나지 못합니다.',
  ],
  tackle: [
    '{p}의 태클 성공! 공을 빼앗습니다.',
    '{p}가 정확하게 공을 걷어냅니다.',
    '{p}의 강한 압박 — 볼 소유가 바뀝니다.',
    '{p}가 몸을 던져 막아섭니다.',
  ],
  intercept: [
    '{p}가 패스 길목을 읽고 차단합니다.',
    '{p}의 예측이 빛났습니다. 패스가 끊깁니다.',
    '{p}가 중원에서 패스를 가로챕니다.',
  ],
  header: [
    '{p}의 헤더! 골문을 향합니다!',
    '{p}가 솟아올라 머리로 때립니다!',
  ],
  half: [
    '선수들이 라커룸으로 향합니다.',
    '15분간의 휴식 — 감독이 전술을 정비할 시간입니다.',
    '하프타임. 양 팀이 라커룸에 모입니다.',
  ],
  secondHalf: [
    '후반전 시작! 양 팀 진영을 바꿔 경기를 이어갑니다.',
    '후반전 킥오프 — 공격 방향이 바뀌었습니다.',
  ],
  aet: ['연장전에 돌입합니다!'],
};

function makeEntity(world, pid, slot, dir, side) {
  const p = world.players[pid];
  if (!p) return null;
  return {
    p, id: pid, name: p.name, num: p.num, pos: slot.pos, label: slot.label, slot, dir, side,
    x: 0, y: 0, px: 0, py: 0, stamina: 100, rd: 0,
    st: {
      goals: 0, assists: 0, shots: 0, onTarget: 0, saves: 0, tackles: 0, fouls: 0,
      passes: 0, passOk: 0, keyPasses: 0, yellow: 0, red: 0, minutes: 0, injuries: 0,
    },
    decCd: 0, tackleCd: 0, factor: posFactor(slot.pos, p.pos),
    rx: 0, ry: 0, rt: 0, onPitch: true, sentOff: false, injured: null, offAt: null,
    x0: 0, y0: 0, moved: 0, touched: 0, press: false,
    dive: null, lastTarget: null,
  };
}

export class Match {
  constructor({ world, homeId, awayId, homeLineup, awayLineup, seed, cup = false, userSide = 'home' }) {
    this.world = world;
    this.cup = cup;
    this.userSide = userSide;
    this.rng = makeRng(String(seed));
    this.homeId = homeId;
    this.awayId = awayId;
    this.score = { home: 0, away: 0 };
    this.t = 0;
    this.half = 1;
    this.phase = 'kickoff';
    this.pause = 3;
    this.done = false;
    this.events = [];
    this.news = [];
    this.commentary = [];
    this.fx = [];
    this.lastEventId = 0;
    this.speed = 1;             // 화면 배속 — 득점 연출 길이(pause)를 벽시계에 맞춥니다
    this.wt = 0;                // 일시정지 중에도 흐르는 틱 수(워프·연출 진행용)
    this.lastKickoffT = -99;    // 마지막 킥오프(순간이동) 시각 — 리플레이 클립이 이 앞을 담지 않게
    this.pens = null;
    this.aet = false;
    this.holdHalf = false;      // 화면이 하프타임 카드를 보여 주는 동안 엔진을 멈춥니다
    this.sp = null;             // 진행 중인 세트피스
    this.lastSetPieceT = -99;   // 마지막 세트피스 시각(틱) — 화면·점검에서 흐름 판단용
    this.tickerId = 0;
    this.added1 = rint(this.rng, 1, 3);   // 전반 추가시간(분)
    this.added2 = rint(this.rng, 2, 5);   // 후반 추가시간(분)
    this.half1Ticks = 180 + this.added1 * TPM;
    this.ft90 = 360 + (this.added1 + this.added2) * TPM;
    this.fullTicks = this.ft90;
    this.firstKick = 'home';
    this.sides = {
      home: this.buildSide(homeId, homeLineup, 1, 'home'),
      away: this.buildSide(awayId, awayLineup, -1, 'away'),
    };
    // 키트 색이 겹치면 원정팀은 대체 유니폼
    const homeKit = this.sides.home.team.primary;
    const awayKit = colorGap(homeKit, this.sides.away.team.primary) < 110
      ? pickAwayKit(homeKit, this.sides.away.team)
      : this.sides.away.team.primary;
    this.kit = { home: homeKit, away: awayKit };
    this.sides.home.kit = homeKit;
    this.sides.away.kit = awayKit;
    // 공의 비행은 '틱' 단위입니다 (dur = 날아가는 데 걸리는 틱 수).
    // 판정은 공이 도착한 그 틱에 내리지만, 화면(중계·스코어·배너)은 한 틱 늦춰 공개합니다.
    // 그래야 공이 골라인·골키퍼에 실제로 닿은 뒤에 GOAL 배너와 스코어가 뜹니다.
    this.ball = {
      x: W / 2, y: CY, px: W / 2, py: CY, owner: null, mode: 'carry',
      from: null, to: null, t: 0, dur: 0, passer: null, receiver: null, cross: false,
      tx: 0, ty: 0, vx: 0, vy: 0, lastShot: null, trail: [],
    };
    this.startPossession('home', 'kickoff');
    this.pushEvent({ type: 'kickoff', text: `킥오프! ${world.teams[homeId].short} vs ${world.teams[awayId].short}` });
  }

  buildSide(teamId, lineup, dir, side) {
    const team = this.world.teams[teamId];
    const form = FORMATIONS[lineup.formation] || FORMATIONS['4-3-3'];
    const starters = lineup.starters.map((pid, i) => makeEntity(this.world, pid, form.slots[i] || form.slots[0], dir, side)).filter(Boolean);
    for (const e of starters) {
      e.x = dir > 0 ? e.slot.x * W : W - e.slot.x * W;
      e.y = e.slot.y * H;
      e.px = e.x; e.py = e.y; e.x0 = e.x; e.y0 = e.y;
    }
    const bench = (lineup.bench || []).map((pid) => {
      const e = makeEntity(this.world, pid, { pos: this.world.players[pid]?.pos || 'MF', label: 'SUB', x: 0.5, y: 0.5 }, dir, side);
      if (e) { e.onPitch = false; e.x = dir > 0 ? W * 0.1 : W * 0.9; e.y = CY; e.px = e.x; e.py = e.y; }
      return e;
    }).filter(Boolean);
    return {
      name: side, teamId, dir, team, formation: lineup.formation || '4-3-3',
      tactic: { line: 0, pass: 0, press: 0, route: 0, ...(lineup.tactic || team.tactic) },
      players: starters, bench, subsUsed: 0, appeared: [...starters], reds: 0,
      stats: {
        shots: 0, onTarget: 0, xg: 0, possTicks: 0, passes: 0, passOk: 0, tackles: 0, saves: 0,
        corners: 0, freeKicks: 0, goalKicks: 0, fouls: 0, yellow: 0, red: 0, injuries: 0, shotDist: 0,
      },
    };
  }

  /* ───────────── 기본 도우미 ───────────── */
  get opposing() { return { home: 'away', away: 'home' }; }
  eff(e, key) {
    const base = e.p.stats[key] || 30;
    const sf = 0.7 + 0.3 * (e.stamina / 100);
    return base * sf * e.factor;
  }
  minute() { return Math.min(this.aet ? 120 : 90, Math.floor(this.t / TPM) + 1); }
  clock() {
    const m = Math.floor(this.t / TPM);
    if (this.aet) {
      if (m <= 90) return `${String(Math.max(1, m)).padStart(2, '0')}'`;
      return `${String(Math.min(120, m)).padStart(2, '0')}'`;
    }
    if (m <= 45) return `${String(Math.max(1, m)).padStart(2, '0')}'`;
    if (this.half === 1) return `45+${m - 45}'`;
    if (m <= 90) return `${String(m).padStart(2, '0')}'`;
    return `90+${m - 90}'`;
  }
  phrase(kind, sideName, vars = {}) {
    const pool = SAY[kind] || SAY.build;
    const team = sideName ? (this.sides[sideName]?.team?.short || '') : '';
    const names = { p: vars.p || '', p2: vars.p2 || '', t: team };
    return pick(this.rng, pool)
      .replace(/\{(p|p2|t)\}([가는를와])?/g, (mm, k, j) => {
        const name = names[k] ?? '';
        if (!j) return name;
        const pair = JOSA[j];
        return name + (hasJong(name) ? pair[0] : pair[1]);
      })
      .replace(/\{n\}/g, String(vars.n ?? ''));
  }
  say(kind, sideName, vars = {}, type = null) {
    const text = this.phrase(kind, sideName, vars);
    this.pushEvent({ type: type || kind, side: sideName || null, text });
    return text;
  }
  pushEvent(ev) {
    ev.id = ++this.lastEventId;
    ev.tick = this.t;
    ev.minute = this.minute();
    ev.label = this.clock();
    this.events.push(ev);
    if (ev.text) {
      this.commentary.unshift({ id: ev.id, minute: ev.minute, label: ev.label, text: ev.text, type: ev.type || 'info', side: ev.side || null });
      if (this.commentary.length > 80) this.commentary.pop();
      this.tickerId = ev.id;
    }
  }

  /* ───────────── 위치·재개 ───────────── */
  setSpeed(v) { this.speed = clamp(Number(v) || 1, 1, 4); }

  /* 다이빙 정리 — 킥오프·세트피스·새 공 전개에서는 골키퍼가 바로 일어납니다 */
  clearDives() {
    for (const s of ['home', 'away']) {
      for (const e of this.sides[s].players) if (e.pos === 'GK') e.dive = null;
      for (const e of this.sides[s].bench) if (e.pos === 'GK') e.dive = null;
    }
  }
  /* 슛이 끝난 뒤 — 뻗은 자세에서 2틱에 걸쳐 일어납니다 */
  landDives() {
    for (const s of ['home', 'away']) {
      for (const e of this.sides[s].players) if (e.dive && e.dive.landAt == null) e.dive.landAt = this.t;
    }
  }
  expireDives() {
    for (const s of ['home', 'away']) {
      for (const e of this.sides[s].players) {
        if (e.dive && e.dive.landAt != null && this.t - e.dive.landAt >= DIVE_LAND_TICKS) e.dive = null;
      }
    }
  }

  /* 자리로 모이기 — y=목표. 한 프레임에 85u 튀지 않고 n틱에 걸쳐 미끄러지듯 이동합니다. */
  warpTo(e, x, y, ticks = WARP_TICKS) {
    if (!e) return false;
    const d = Math.hypot(x - e.x, y - e.y);
    if (d < 2.0) { e.warp = null; return false; }
    e.warp = { x0: e.x, y0: e.y, x1: x, y1: y, t0: this.wt, n: Math.max(1, ticks) };
    return true;
  }
  stepWarps() {
    for (const s of ['home', 'away']) {
      for (const e of this.sides[s].players) {
        const w = e.warp;
        if (!w) continue;
        const p = clamp((this.wt - w.t0) / w.n, 0, 1);
        const k = p * p * (3 - 2 * p);      // 부드럽게 출발하고 부드럽게 도착
        const nx = w.x0 + (w.x1 - w.x0) * k;
        const ny = w.y0 + (w.y1 - w.y0) * k;
        e.moved = Math.hypot(nx - e.x, ny - e.y);
        e.x = nx; e.y = ny;
        if (p >= 1) e.warp = null;
      }
    }
  }

  resetPositions(warpTicks = 0) {
    for (const s of ['home', 'away']) {
      const side = this.sides[s];
      for (const e of side.players) {
        if (!e.onPitch) continue;
        const tx = side.dir > 0 ? e.slot.x * W : W - e.slot.x * W;
        const ty = e.slot.y * H;
        if (warpTicks > 0) this.warpTo(e, tx, ty, warpTicks);
        else { e.warp = null; e.x = tx; e.y = ty; e.px = e.x; e.py = e.y; }
      }
    }
  }

  startPossession(sideName, reason = '', opts = {}) {
    const side = this.sides[sideName];
    if (!side) return;
    const mids = side.players.filter((e) => e.onPitch && e.pos === 'MF');
    const carrier = (opts.carrier && opts.carrier.onPitch) ? opts.carrier
      : mids.length ? mids[Math.floor(this.rng() * mids.length)]
        : side.players.find((e) => e.onPitch && e.pos !== 'GK') || side.players[0];
    if (!carrier) return;
    if (reason === 'kickoff' || reason === 'goal') {
      // opts.placed = 득점 연출(일시정지) 동안 이미 대형으로 워프해 둔 상태
      if (!opts.placed) this.resetPositions();
      carrier.x = 48; carrier.y = CY;
      carrier.px = carrier.x; carrier.py = carrier.y;
      carrier.warp = null;
      this.lastKickoffT = this.t;
    }
    this.clearDives();
    this.ball.owner = carrier;
    this.ball.mode = 'carry';
    this.ball.x = carrier.x; this.ball.y = carrier.y;
    this.ball.px = this.ball.x; this.ball.py = this.ball.y;
    this.ball.trail = [];
    this.ball.shot = null;
    this.ball.passer = null;
    this.ball.receiver = null;
    this.possessionStart = this.t;
    this.sp = null;
    this.phase = 'play';
  }

  /* ───────────── 틱 ───────────── */
  tick() {
    if (this.done) return;
    this.wt += 1;
    if (this.phase === 'half') {
      if (!this.holdHalf) this.startSecondHalf();
      return;
    }
    if (this.pause > 0) {
      this.pause -= 1;
      this.updateStamina(true);
      this.snapshot();
      this.stepWarps();                                  // 득점 연출 중에도 대형으로 흩어지는 워프는 진행
      if (this.ball.mode === 'net') this.moveBall();
      if (this.pause === 0 && this.phase === 'goal' && this.pendingRestart) {
        this.startPossession(this.pendingRestart, 'goal', { placed: this.formationReady, carrier: this.restartCarrier });
        this.pendingRestart = null;
        this.formationReady = false;
        this.restartCarrier = null;
      }
      return;
    }
    this.t += 1;
    this.snapshot();
    if (this.done) return;
    if (this.phase === 'setpiece') {
      this.stepSetPiece();
      this.expireDives();
      this.checkClock();
      return;
    }
    if (this.phase !== 'play') { this.expireDives(); this.checkClock(); return; }
    // 한 틱(=경기 15초) 안에서 SUBSTEPS 번의 플레이 단계를 돌린다 — 패스·슛이 더 자주 나온다
    for (let i = 0; i < SUBSTEPS; i++) {
      this.updateStamina(false);
      this.updateDrift();
      this.thinkCarrier();
      this.movePlayers();
      this.moveBall();
      if (this.pause > 0 || this.phase !== 'play') break;
      this.contests();
      this.countPossession();
      if (this.done) return;
    }
    this.expireDives();
    if (this.t % 30 === 1) this.aiManage();
    this.aiAdjust();
    this.checkClock();
  }

  snapshot() {
    for (const s of ['home', 'away']) {
      for (const e of this.sides[s].players) { e.px = e.x; e.py = e.y; }
      for (const e of this.sides[s].bench) { e.px = e.x; e.py = e.y; }
    }
    const b = this.ball;
    b.px = b.x; b.py = b.y;
    // 비행 궤적은 moveBall 이 매 단계마다 남깁니다 (여기서는 공을 소유했을 때만 정리)
    if (b.mode === 'carry' || b.mode === 'set' || b.mode === 'loose') b.trail.length = 0;
  }

  checkClock() {
    if (this.phase === 'goal' || this.phase === 'half' || this.done) return;
    if (!this.aet && this.half === 1 && this.t >= this.half1Ticks) { this.beginHalfTime(); return; }
    if (!this.aet && this.t >= this.ft90) {
      if (this.cup && this.score.home === this.score.away) {
        this.aet = true;
        this.fullTicks = this.ft90 + 120;
        this.half = 2;
        this.pause = 4;
        this.pushEvent({ type: 'aet', text: `연장전 돌입 — ${this.scoreText()}` });
      } else this.finish();
      return;
    }
    if (this.aet && this.t >= this.fullTicks) {
      if (this.score.home === this.score.away) this.shootout();
      this.finish();
    }
  }

  beginHalfTime() {
    this.t = this.half1Ticks;
    this.phase = 'half';
    this.sp = null;
    this.clearDives();          // 하프타임에는 키퍼가 뻗은 자세로 남지 않습니다
    this.ball.owner = null;
    this.ball.shot = null;
    this.ball.mode = 'loose';
    this.ball.vx = 0; this.ball.vy = 0;
    this.ball.x = W / 2; this.ball.y = CY;
    this.halftimeScore = { ...this.score };
    this.pushEvent({ type: 'half', text: `전반 종료 — ${this.scoreText()}. ${this.phrase('half')}` });
  }

  startSecondHalf() {
    if (this.half === 2 && this.phase === 'play') return;
    this.half = 2;
    for (const s of ['home', 'away']) {
      const side = this.sides[s];
      side.dir *= -1;
      for (const e of side.players) e.dir = side.dir;
      for (const e of side.bench) e.dir = side.dir;
      // 라커룸 휴식 — 체력을 조금 회복합니다
      for (const e of side.players) if (e.onPitch) e.stamina = clamp(e.stamina + 14, 0, 100);
    }
    this.resetPositions();
    const kick = this.opposing[this.firstKick];
    this.pause = 2;
    this.startPossession(kick, 'kickoff');
    this.pushEvent({
      type: 'kickoff',
      text: `후반전 시작 — 진영을 바꿉니다. ${this.world.teams[this.homeId].short} ${this.sides.home.dir > 0 ? '→' : '←'} / ${this.world.teams[this.awayId].short} ${this.sides.away.dir > 0 ? '→' : '←'}`,
    });
  }

  scoreText() { return `${this.world.teams[this.homeId].short} ${this.score.home} - ${this.score.away} ${this.world.teams[this.awayId].short}`; }

  finish() {
    if (this.done) return;
    this.done = true;
    this.phase = 'full';
    this.sp = null;
    const winner = this.pens ? this.pens.winner : this.score.home > this.score.away ? 'home' : this.score.home < this.score.away ? 'away' : null;
    this.result = { hg: this.score.home, ag: this.score.away, winner, pens: this.pens };
    this.pushEvent({ type: 'full', text: `경기 종료 — ${this.scoreText()}${this.pens ? ` (승부차기 ${this.pens.text} ${winner === 'home' ? this.world.teams[this.homeId].short : this.world.teams[this.awayId].short} 승)` : ''}` });
    this.settlePlayers();
  }

  shootout() {
    const order = ['home', 'away'];
    const kicks = { home: [], away: [] };
    const takers = (s) => this.sides[s].players.filter((e) => e.onPitch && e.pos !== 'GK').sort((a, b) => this.eff(b, 'sho') - this.eff(a, 'sho')).slice(0, 5);
    for (let round = 0; round < 5; round++) {
      for (const s of order) {
        const taker = takers(s)[round % Math.max(1, takers(s).length)];
        if (!taker) { kicks[s].push('X'); continue; }
        const gk = this.sides[this.opposing[s]].players.find((e) => e.onPitch && e.pos === 'GK');
        const pGoal = clamp(0.62 + this.eff(taker, 'sho') / 320 - this.eff(gk, 'gk') / 380, 0.45, 0.92);
        const goal = this.rng() < pGoal;
        kicks[s].push(goal ? 'O' : 'X');
        if (goal) taker.rd += 0.05;
        else if (gk) gk.rd += 0.12;
        this.pushEvent({ type: 'pen', side: s, text: `승부차기 ${round + 1}번째 — ${taker.name} ${goal ? '성공' : '실패'}` });
      }
    }
    let h = kicks.home.filter((x) => x === 'O').length, a = kicks.away.filter((x) => x === 'O').length;
    let guard = 0;
    while (h === a && guard < 10) {
      guard++;
      for (const s of order) {
        const taker = takers(s)[guard % Math.max(1, takers(s).length)];
        if (!taker) { kicks[s].push('X'); continue; }
        const gk = this.sides[this.opposing[s]].players.find((e) => e.onPitch && e.pos === 'GK');
        const goal = this.rng() < clamp(0.63 + this.eff(taker, 'sho') / 340 - this.eff(gk, 'gk') / 400, 0.45, 0.92);
        kicks[s].push(goal ? 'O' : 'X');
        if (goal) { if (s === 'home') h++; else a++; }
      }
    }
    const winner = h > a ? 'home' : 'away';
    this.pens = { home: kicks.home.join(''), away: kicks.away.join(''), h, a, winner, text: `${h}-${a}` };
  }

  settlePlayers() {
    for (const s of ['home', 'away']) {
      for (const e of this.sides[s].appeared) {
        e.st.minutes = e.onPitch ? Math.max(1, this.minute()) : (e.offAt ?? Math.max(1, this.minute()));
      }
    }
  }

  /* ───────────── 체력 ───────────── */
  updateStamina(paused) {
    for (const s of ['home', 'away']) {
      const press = this.sides[s].tactic.press || 0;
      for (const e of this.sides[s].players) {
        if (!e.onPitch) continue;
        const moved = e.moved || 0;
        if (paused) { e.stamina = clamp(e.stamina + 0.03, 0, 100); continue; }
        const drain = (0.004 + moved * 0.011) * (1.72 - e.p.stats.sta * 0.009) * (1 + Math.max(0, press) * 0.16) / SUBSTEPS;
        e.stamina = clamp(e.stamina - drain, 0, 100);
      }
    }
  }

  updateDrift() {
    for (const s of ['home', 'away']) {
      for (const e of this.sides[s].players) {
        e.rt -= STEP_K;
        if (e.rt <= 0) {
          e.rt = rint(this.rng, 14, 34) / STEP_K;
          e.rx = (this.rng() - 0.5) * 5;
          e.ry = (this.rng() - 0.5) * 5;
        }
      }
    }
  }

  countPossession() {
    if (!this.ball.owner) return;
    const side = this.sides[this.ball.owner.side];
    side.stats.possTicks += 1;
    const p = prog(this.ball.x, side.dir);
    side.stats.ballX = (side.stats.ballX || 0) + p;
    if (p > 66) side.stats.finalTicks = (side.stats.finalTicks || 0) + 1;
    if (p > 82 && Math.abs(this.ball.y - CY) < 16) side.stats.boxTicks = (side.stats.boxTicks || 0) + 1;
  }

  /* ───────────── 전술 → 진형 ─────────────
     네 축이 진형의 '높이·폭·압박 수·간격'을 직접 정합니다. */
  computeShape(side, hasBall) {
    const t = side.tactic;
    const line = t.line || 0, press = t.press || 0, pass = t.pass || 0, route = t.route || 0;
    const ballP = prog(this.ball.x, side.dir);
    let df = (hasBall ? 26 : 17) + line * (hasBall ? 10 : 8);
    let mf = (hasBall ? 47 : 33) + line * (hasBall ? 9 : 7);
    let fw = (hasBall ? 71 : 52) + line * (hasBall ? 6 : 5);
    const push = (ballP - 50) * (hasBall ? 0.42 : 0.34);
    df += push; mf += push * 0.88; fw += push * 0.78;
    if (hasBall) {
      // 롱볼은 앞선을 높게, 중원을 낮게 — 세로로 길게
      fw += pass * 8; mf -= pass * 5; df -= pass * 2;
    } else {
      df -= pass * 3; mf -= pass * 2.5; fw += pass * 2;
    }
    if (!hasBall) {
      // 강한 압박 = 블록 자체가 올라와 상대를 조입니다
      df += press * 4; mf += press * 6; fw += press * 9;
    } else {
      df += press * 2;
    }
    const wide = hasBall ? 12 + (route + 1) * 7 : 13 - Math.abs(route) * 2 - (1 - press) * 1.6;
    const mid = hasBall ? 6.5 - route * 3 : 9.5 - Math.abs(route) * 1.8;
    const men = 11 - (side.reds || 0);
    return {
      df: clamp(df, 6, 88), mf: clamp(mf, 10, 92), fw: clamp(fw, 24, 94),
      wide: clamp(wide, 6, 26), mid: clamp(mid, 2.5, 12),
      ballP, line, press, pass, route, hasBall, men,
      pressCount: Math.max(1, Math.min(4, 1 + Math.round((press + 1) * 1.25) - (side.reds || 0))),
      pressRange: 18 + (press + 1) * 7,
    };
  }

  /* ───────────── 이동 ───────────── */
  movePlayers() {
    this.stepWarps();       // 자리로 모이는 중인 선수는 워프가 위치를 정합니다
    const owningSide = this.ball.owner ? this.ball.owner.side : null;
    for (const s of ['home', 'away']) {
      const side = this.sides[s];
      const hasBall = owningSide === s;
      side._shape = this.computeShape(side, hasBall);
      if (!hasBall) {
        side._pressers = side.players
          .filter((e) => e.onPitch && e.pos !== 'GK' && !e.injured)
          .sort((a, b) => dist(a, this.ball) - dist(b, this.ball));
      } else side._pressers = [];
    }
    for (const s of ['home', 'away']) {
      const side = this.sides[s];
      const hasBall = owningSide === s;
      for (const e of side.players) {
        if (!e.onPitch) continue;
        if (e.warp) continue;
        e.press = false;
        const tgt = this.phase === 'setpiece' ? this.setPieceTargetFor(e) : this.targetFor(e, side, hasBall);
        e.lastTarget = tgt;
        const dx = tgt.x - e.x, dy = tgt.y - e.y;
        const d = Math.hypot(dx, dy);
        let sp = (0.42 + this.eff(e, 'spd') / 100 * 0.62) * STEP_K;
        if (e === this.ball.owner) sp *= 1.06;
        else if (e.press) sp *= 1.12;
        if (e.injured) sp *= 0.72;
        if (e.pos === 'GK') sp *= 0.8;
        if (this.phase === 'setpiece') sp *= 3.4;   // 세트피스 때는 빠르게 자리를 잡습니다
        const step = Math.min(d, sp);
        if (d > 0.05) {
          e.x0 = e.x; e.y0 = e.y;
          e.x += (dx / d) * step;
          e.y += (dy / d) * step;
          e.moved = step;
        } else e.moved = 0;
        e.x = clamp(e.x, 1, W - 1); e.y = clamp(e.y, 1, H - 1);
      }
    }
  }

  targetFor(e, side, hasBall) {
    const ball = this.ball;
    const dir = side.dir;
    const sh = side._shape || this.computeShape(side, hasBall);
    if (e.pos === 'GK') {
      const gx = dir > 0 ? 4 : W - 4;
      let sweep = clamp(sh.line, 0, 1) * 8 + Math.max(0, sh.press) * 2;
      if (this.phase === 'setpiece') sweep = 0;
      const ty = clamp(CY + (ball.y - CY) * 0.5, CY - 8, CY + 8);
      return { x: gx + dir * sweep, y: ty };
    }
    const sy = (e.slot.y - 0.5) * 2;      // -1(왼쪽) ~ 1(오른쪽)
    const abs = Math.abs(sy);
    let p;
    if (e.pos === 'DF') p = sh.df + (abs > 0.5 ? 1.5 : 0);
    else if (e.pos === 'MF') p = sh.mf + (abs > 0.5 ? 2.5 : -abs * 2);
    else p = sh.fw + (abs > 0.5 ? -2 : 2);
    // 박스 침투 / 측면 오버랩
    if (hasBall && sh.ballP > 58) {
      if (e.pos === 'FW') p += 9;
      if (e.pos === 'MF' && abs > 0.55) p += 7;
      if (e.pos === 'DF' && abs > 0.5 && sh.route > 0.2) p += 8;   // 측면 공격이면 풀백이 올라옵니다
    }
    let halfW = abs > 0.5 ? sh.wide : Math.max(3, sh.mid * (0.55 + abs));
    let y = CY + sy * halfW + (ball.y - CY) * (hasBall ? 0.16 : 0.24);

    if (hasBall) {
      if (e === this.ball.owner) return this.carrierTarget(e);
      // 패스 옵션: 가까운 두 명이 지원
      const mates = side.players.filter((x) => x.onPitch && x !== this.ball.owner && x.pos !== 'GK');
      mates.sort((a, b) => dist(a, ball) - dist(b, ball));
      const rank = mates.indexOf(e);
      if (rank >= 0 && rank < 2 && sh.ballP > 30) {
        const sign = e.slot.y < 0.5 ? -1 : 1;
        const back = 8 + rank * 4 - (sh.pass < -0.3 ? 3 : sh.pass > 0.3 ? -3 : 0);
        return {
          x: clamp(ball.x + dir * back, 4, W - 4),
          y: clamp(ball.y + sign * (10 - rank * 3), 5, H - 5),
        };
      }
    } else {
      // 수비: 압박 수·범위는 '압박 강도' 축이 정합니다
      const idx = side._pressers ? side._pressers.indexOf(e) : -1;
      if (idx >= 0 && idx < sh.pressCount && dist(e, ball) < sh.pressRange) {
        e.press = true;
        const lead = 0.9 + Math.max(0, sh.press) * 1.5;
        return { x: clamp(ball.x + dir * lead, 2, W - 2), y: clamp(ball.y + (e.y - ball.y) * 0.22, 3, H - 3) };
      }
      if (idx === sh.pressCount) {
        // 2선 커버
        return { x: (ball.x + (dir > 0 ? 0 : W)) / 2, y: (ball.y + CY) / 2 };
      }
      if (e.pos === 'DF' && abs > 0.5) y = CY + sy * (halfW - 2) + (ball.y - CY) * 0.28;
    }
    p = clamp(p + (e.rx || 0) * 0.7, 5, hasBall ? 94 : 90);
    y = clamp(y + (e.ry || 0) * 0.7, 3.5, H - 3.5);
    return { x: dir > 0 ? p : W - p, y };
  }

  carrierTarget(e) {
    const dir = e.dir;
    const opp = this.sides[this.opposing[e.side]].players.filter((x) => x.onPitch);
    let nearest = null, nd = 1e9;
    for (const o of opp) { const d = dist(o, e); if (d < nd) { nd = d; nearest = o; } }
    const p = prog(e.x, dir);
    const sh = this.sides[e.side]._shape;
    let ty = e.y + (CY - e.y) * 0.07;
    if (nearest && nd < 9) ty += e.y - nearest.y > 0 ? 3 : -3;
    if (p > 52) ty += (CY - e.y) * 0.16;
    // 공격 루트: 측면이면 터치라인으로 벌리고, 중앙이면 골문 앞으로 파고듭니다
    if (sh) {
      if (sh.route > 0.25 && p > 45) ty += e.y < CY ? -2.4 * sh.route : 2.4 * sh.route;
      if (sh.route < -0.25 && p > 55) ty += (CY - e.y) * 0.2;
    }
    return { x: clamp(e.x + dir * (p > 68 ? 6 : 4), 2, W - 2), y: clamp(ty, 3, H - 3) };
  }

  /* ───────────── 공 소유자의 판단 ───────────── */
  pressureOn(e) {
    const opp = this.sides[this.opposing[e.side]].players;
    let n = 0;
    for (const o of opp) if (o.onPitch && dist(o, e) < 6.5) n += 1;
    return n;
  }

  thinkCarrier() {
    const ball = this.ball;
    if (ball.mode !== 'carry' || !ball.owner) return;
    const c = ball.owner;
    // 골키퍼가 공을 잡았으면 몸에 붙여 두지 않고 곧바로 배급합니다 (패스·골킥 전개)
    if (c.pos === 'GK' && c.holdT != null) { c.holdT = null; this.distributeFromGK(c); return; }
    c.decCd -= 1;
    if (c.decCd > 0) return;
    const gx = c.dir > 0 ? W : 0;
    const dGoal = Math.hypot(gx - c.x, CY - c.y);
    const pressure = this.pressureOn(c);
    const side = this.sides[c.side];

    if (c.pos !== 'GK' && dGoal < 27) {
      const angle = 1 - Math.abs(c.y - CY) / H;
      let urge = clamp((25 - dGoal) / 24, 0, 1) * 1.10 * (this.eff(c, 'sho') / 70) * angle;
      if (side.tactic.route < -0.4) urge *= 1.2;
      urge *= 1 - Math.min(pressure, 3) * 0.14;
      if (this.rng() < clamp(urge, 0.01, 0.72)) return this.shoot(c, dGoal, pressure);
    }

    const best = this.bestPass(c, pressure);
    if (best) {
      let passP = clamp(0.5 + pressure * 0.08 + best.score * 0.06, 0.15, 0.96);
      if (best.score < 0.6) passP *= 0.5;
      if (this.rng() < passP) return this.passTo(c, best.mate, best.cross);
    }
    c.decCd = rint(this.rng, 1, 2);
  }

  /* 골키퍼 배급 — 잡은 공을 오래 끌지 않고 동료에게 넘깁니다 */
  distributeFromGK(gk) {
    const side = this.sides[gk.side];
    const mates = side.players.filter((e) => e.onPitch && e !== gk && e.pos !== 'GK');
    if (!mates.length) return false;
    const style = side.tactic.pass || 0;
    const long = this.rng() < (style > 0.1 ? 0.8 : 0.35);
    let rec = null;
    if (long) {
      rec = mates.filter((e) => e.pos === 'FW' || e.pos === 'MF')
        .sort((a, b) => prog(b.x, side.dir) - prog(a.x, side.dir))[0];
    }
    if (!rec) rec = mates.slice().sort((a, b) => dist(a, gk) - dist(b, gk))[0];
    if (!rec) return false;
    gk.decCd = 1;
    this.passTo(gk, rec, false);
    return true;
  }

  bestPass(c, pressure) {
    const side = this.sides[c.side];
    const opp = this.sides[this.opposing[c.side]].players.filter((e) => e.onPitch);
    const style = side.tactic.pass || 0;
    const route = side.tactic.route || 0;
    let best = null;
    for (const m of side.players) {
      if (!m.onPitch || m === c || m.pos === 'GK') continue;
      const dx = m.x - c.x, dy = m.y - c.y;
      const d = Math.hypot(dx, dy);
      if (d < 4 || d > 68) continue;
      const forward = (dx * c.dir) / Math.max(d, 0.001);
      let risk = 0;
      for (let i = 1; i <= 5; i++) {
        const px = c.x + (dx * i) / 6, py = c.y + (dy * i) / 6;
        for (const o of opp) {
          const dd = Math.hypot(o.x - px, o.y - py);
          if (dd < 4.2) risk += (4.2 - dd) / 4.2;
        }
      }
      risk = risk / 5;
      let open = 99;
      for (const o of opp) open = Math.min(open, dist(o, m));
      let score = forward * 1.55 - d * 0.012 - risk * 1.7 + Math.min(open, 12) * 0.12;
      score += (m.pos === 'FW' ? 0.15 : 0) + (m.pos === 'MF' ? 0.08 : 0);
      score += this.rng() * 0.7;
      if (style < 0) score += clamp(28 - d, -24, 14) * 0.028;
      if (style > 0) score += clamp(d - 26, -20, 30) * 0.022;
      const mProg = prog(m.x, c.dir);
      const inFinal = mProg > 62;
      const inBox = mProg > 78 && Math.abs(m.y - CY) < 15;
      if (inBox) score += 0.6;
      if (route > 0.3 && inFinal && Math.abs(m.y - CY) > 14) score += 0.5;
      if (route < -0.3 && inFinal && Math.abs(m.y - CY) < 14) score += 0.45;
      if (forward < -0.2) score -= 0.7;
      const cross = route > 0.3 && inFinal && Math.abs(m.y - CY) > 14 && prog(c.x, c.dir) > 60;
      const cand = { mate: m, score, cross };
      if (!best || cand.score > best.score) best = cand;
    }
    if (!best || best.score < 0.15) return null;
    return best;
  }

  passTo(c, m, cross) {
    const d = dist(c, m);
    const ball = this.ball;
    this.clearDives();
    ball.mode = 'pass';
    ball.from = { x: c.x, y: c.y };
    ball.to = { x: m.x, y: m.y };
    ball.t = 0;
    // dur = 날아가는 틱 수(정수). 짧은 패스 1틱, 긴 패스 2틱 — 화면이 매 틱 궤적을 이어 그립니다
    ball.dur = clamp(Math.round(1 + d / 45), 1, 2);
    ball.passer = c;
    ball.receiver = m;
    ball.cross = !!cross;
    ball.owner = null;
    ball.trail = [];
    c.decCd = rint(this.rng, 0, 1);
    c.st.passes += 1;
    this.sides[c.side].stats.passes += 1;
    this.lastPass = { from: c, to: m, t: this.t };
    // 중계: 스루패스/크로스/일반 패스
    if (cross) this.say('cross', c.side, { p: c.name }, 'cross');
    else if (prog(m.x, c.dir) - prog(c.x, c.dir) > 18 && this.rng() < 0.5) this.say('through', c.side, { p: c.name }, 'through');
  }

  /* ───────────── 슈팅 ───────────── */
  xgFor(c, dGoal, pressure) {
    const angle = 1 - Math.abs(c.y - CY) / 42;
    const base = 1.22 * Math.exp(-dGoal / 8.4) * clamp(angle, 0.12, 1);
    const skill = 0.72 + this.eff(c, 'sho') / 210;
    const press = 1 - Math.min(pressure, 3) * 0.11;
    return clamp(base * skill * press, 0.02, 0.6);
  }

  shoot(c, dGoal, pressure, header = false) {
    const side = this.sides[c.side];
    const gx = c.dir > 0 ? W : 0;
    const xg = this.xgFor(c, dGoal, pressure) * (header ? 0.5 : 1);
    const ball = this.ball;
    const gk = this.sides[this.opposing[c.side]].players.find((e) => e.pos === 'GK' && e.onPitch);
    // 결과는 슛을 때리는 순간 정해 두되(애니메이션을 미리 맞추기 위해),
    // 스코어·배너 반영은 공이 골라인·키퍼에 닿은 뒤(resolveShot)에 합니다.
    const onTargetP = clamp(0.24 + this.eff(c, 'sho') / 300 + (33 - dGoal) / 90 - pressure * 0.05, 0.14, 0.72);
    const r = this.rng();
    let outcome = 'miss';
    if (r < xg) outcome = 'goal';
    else if (r < xg + 0.05) outcome = 'woodwork';
    else if (r < xg + 0.05 + onTargetP * 0.55) outcome = 'save';
    // 조준점은 결과에 맞춰 따로 — 골은 골문 안, 빗나감은 골문 밖, 골대는 정확히 포스트
    const sgn = this.rng() < 0.5 ? -1 : 1;
    let aimY;
    if (outcome === 'woodwork') aimY = CY + sgn * GOAL_HALF;
    else if (outcome === 'miss') aimY = CY + sgn * (GOAL_HALF + 0.5 + this.rng() * 2.8);   // 4.2~7.0u 바깥
    else aimY = CY + sgn * (0.45 + this.rng() * (GOAL_HALF - 0.75));                      // 골·선방은 ±3.4u 안쪽
    const big = this.rng() < 0.3;
    // 슛은 2~3틱에 걸쳐 날아갑니다 — 1x 에서 28~41프레임, 4x 에서도 7~10프레임 보입니다
    const dur = clamp(Math.round(1 + dGoal / 16), 2, 3);
    this.clearDives();
    ball.mode = 'shot';
    ball.from = { x: c.x, y: c.y };
    ball.to = { x: gx, y: aimY };
    ball.t = 0;
    ball.dur = dur;
    ball.owner = null;
    ball.receiver = null;
    ball.trail = [{ x: c.x, y: c.y }];
    ball.shot = { shooter: c, xg, pressure, header, aimY, outcome, big, onTargetP, gk };
    ball.passer = null;
    c.st.shots += 1;
    side.stats.shots += 1;
    side.stats.xg += xg;
    side.stats.shotDist += dGoal;
    c.decCd = 2;
    // 골키퍼 다이빙도 슛과 '동시에' 시작합니다 — 공이 도착할 즈음 손끝이 간신히 닿도록
    if (gk) {
      const wide = outcome === 'goal' ? sgn * (1.0 + this.rng() * 2.2) : 0;
      gk.dive = { at: this.t, dur, to: clamp(aimY - gk.y + wide, -8, 8), save: outcome === 'save', landAt: null };
    }
    if (this.lastPass && this.t - this.lastPass.t <= 6 && this.lastPass.from.side === c.side && this.lastPass.from !== c) {
      this.assistCand = this.lastPass.from;
      this.lastPass.from.st.keyPasses += 1;
      this.lastPass.from.rd += 0.06;
    } else this.assistCand = null;
    if (header) this.say('header', c.side, { p: c.name }, 'shot');
    else this.say('shot', c.side, { p: c.name }, 'shot');
  }

  resolveShot() {
    this.resolveShotInner();
    // 슛이 끝나면 키퍼는 2틱에 걸쳐 일어납니다 (뻗은 자세로 남지 않게)
    this.landDives();
  }

  resolveShotInner() {
    const ball = this.ball;
    const s = ball.shot;
    if (!s) { ball.mode = 'loose'; ball.owner = null; return; }
    const c = s.shooter;
    const side = this.sides[c.side];
    const oppSide = this.sides[this.opposing[c.side]];
    const gk = s.gk && s.gk.onPitch ? s.gk : oppSide.players.find((e) => e.pos === 'GK' && e.onPitch);
    if (s.outcome === 'goal') { this.goal(c, s); return; }
    if (s.outcome === 'woodwork') {
      side.stats.onTarget += 1;
      c.st.onTarget += 1;
      this.say('woodwork', c.side, { p: c.name }, 'woodwork');
      this.fx.push({ kind: 'woodwork', at: this.t, x: c.dir > 0 ? W : 0, y: s.aimY, dir: c.dir });
      // 골대 맞고 나온 공 — 세컨드볼 또는 골킥
      if (this.rng() < 0.55) {
        const atk = side.players.filter((e) => e.onPitch && e.pos !== 'GK' && Math.hypot((c.dir > 0 ? W : 0) - e.x, CY - e.y) < 20);
        if (atk.length) {
          atk.sort((a, b) => Math.hypot((c.dir > 0 ? W : 0) - a.x, CY - a.y) - Math.hypot((c.dir > 0 ? W : 0) - b.x, CY - b.y));
          const r2 = atk[0];
          ball.owner = r2; ball.mode = 'carry'; ball.x = r2.x; ball.y = r2.y; r2.decCd = 0;
          ball.shot = null;
          return;
        }
      }
      ball.shot = null;
      const gks = this.goalKickSpot(this.opposing[c.side]);
      this.setPiece('goalkick', this.opposing[c.side], gks.x, gks.y);
      return;
    }
    if (s.outcome === 'save') {
      // 유효슈팅 — 골키퍼 선방
      side.stats.onTarget += 1;
      c.st.onTarget += 1;
      c.rd += 0.04;
      const big = s.big;
      if (gk) {
        gk.st.saves += 1;
        gk.rd += big ? 0.3 : 0.16;
        oppSide.stats.saves += 1;
        if (gk.dive) gk.dive.save = true;
      }
      this.say(big ? 'supersave' : 'save', this.opposing[c.side], { p: gk ? gk.name : '골키퍼' }, 'save');
      // 공은 골라인까지 가지 않고 키퍼 손끝에서 멈춰 잡힙니다 (골라인→키퍼 순간이동 없음)
      if (gk) {
        const handX = gk.x + c.dir * 1.1;
        const handY = gk.y + clamp(s.aimY - gk.y, -3.2, 3.2) * 0.85;
        this.fx.push({ kind: 'save', at: this.t, x: handX, y: handY, side: this.opposing[c.side], big });
        ball.px = ball.x; ball.py = ball.y;
        ball.x = handX; ball.y = handY;
      }
      // 선방 후: 골문을 벗어나면 코너킥
      if (this.rng() < 0.78) {
        const spot = this.cornerSpot(c.side);
        ball.shot = null;
        this.setPiece('corner', c.side, spot.x, spot.y);
        return;
      }
      // 세컨드볼
      const atk = side.players.filter((e) => e.onPitch && e.pos !== 'GK' && Math.hypot((c.dir > 0 ? W : 0) - e.x, CY - e.y) < 18);
      if (atk.length && this.rng() < 0.35) {
        atk.sort((a, b2) => Math.hypot((c.dir > 0 ? W : 0) - a.x, CY - a.y) - Math.hypot((c.dir > 0 ? W : 0) - b2.x, CY - b2.y));
        const r2 = atk[0];
        ball.owner = r2; ball.mode = 'carry'; ball.x = r2.x; ball.y = r2.y; r2.decCd = 0;
        this.pushEvent({ type: 'rebound', side: c.side, text: `세컨드볼! ${r2.name}에게 흘러갑니다.` });
        ball.shot = null;
        return;
      }
      // 키퍼가 잡았습니다 — 앞쪽 핸들링 자리에서 곧바로 배급합니다
      const owner = gk || oppSide.players.find((e) => e.onPitch && e.pos !== 'GK') || oppSide.players[0];
      ball.owner = owner;
      if (owner) {
        owner.decCd = 0;
        ball.mode = 'carry';
        ball.x = owner.x + owner.dir * 1.1; ball.y = owner.y;
        if (owner.pos === 'GK') owner.holdT = this.t;    // 다음 틱에 바로 배급(공이 몸에 붙어 있지 않게)
      } else ball.mode = 'loose';
      ball.shot = null;
      return;
    }
    // 빗나간 슛 → 수비 맞고 나가면 코너킥, 아니면 골킥
    this.say('miss', c.side, { p: c.name }, 'miss');
    ball.shot = null;
    if (this.rng() < 0.3) {
      const spot = this.cornerSpot(c.side);
      this.setPiece('corner', c.side, spot.x, spot.y);
      return;
    }
    const gks = this.goalKickSpot(this.opposing[c.side]);
    this.setPiece('goalkick', this.opposing[c.side], gks.x, gks.y);
  }

  goal(c, s) {
    const side = this.sides[c.side];
    side.stats.onTarget += 1;
    c.st.onTarget += 1;
    this.score[c.side] += 1;
    c.st.goals += 1;
    c.rd += c.pos === 'FW' ? 1.15 : 1.3;
    if (this.assistCand && this.assistCand.side === c.side && this.assistCand !== c) {
      this.assistCand.st.assists += 1;
      this.assistCand.rd += 0.62;
      c.assistName = this.assistCand.name;
    } else c.assistName = null;
    const opp = this.sides[this.opposing[c.side]];
    if (opp.players) for (const e of opp.players) if (e.onPitch && (e.pos === 'GK' || e.pos === 'DF')) e.rd -= 0.05;
    const line = this.phrase('goal', c.side, { p: c.name });
    this.pushEvent({ type: 'goal', side: c.side, text: `⚽ ${this.clock()} ${line}${c.assistName ? ` (도움 ${c.assistName})` : ''} — ${this.scoreText()}`, scorer: c.name, score: { ...this.score } });
    // 공이 골망으로 들어가는 연출 — 판정은 이미 골라인 도착 뒤에 났습니다
    const gx = c.dir > 0 ? W : 0;
    this.ball.mode = 'net';
    this.ball.from = { x: gx, y: s.aimY };
    this.ball.to = { x: gx + c.dir * 2.4, y: s.aimY };
    this.ball.x = gx; this.ball.y = s.aimY;
    this.ball.px = gx; this.ball.py = s.aimY;
    this.ball.t = 0;
    this.ball.dur = 1;
    this.ball.owner = null;
    this.ball.receiver = null;
    this.ball.shot = null;
    this.ball.trail = [];
    this.clearDives();           // 실점한 키퍼가 뻗은 채로 남지 않게
    this.fx.push({ kind: 'goal', side: c.side, pid: c.id, name: c.name, at: this.t, x: gx, y: s.aimY, assist: c.assistName });
    // 득점 연출은 배속과 무관하게 벽시계 2.3초 — 4x 에서도 재개 장면이 배너에 가리지 않습니다
    this.pause = Math.max(4, Math.round(10 * (this.speed || 1)));
    this.phase = 'goal';
    this.goalFlash = { side: c.side, name: c.name, assist: c.assistName, at: this.t };
    this.pendingRestart = this.opposing[c.side];
    this.prepareRestart();
  }

  /* 득점 뒤 재개 준비 — 연출(일시정지) 동안 대형으로 워프하고, 재개 순간에 킥오프 순간이동이 없게 합니다 */
  prepareRestart() {
    const side = this.sides[this.pendingRestart];
    if (!side) return;
    const mids = side.players.filter((e) => e.onPitch && e.pos === 'MF');
    const carrier = mids.length ? mids[Math.floor(this.rng() * mids.length)]
      : (side.players.find((e) => e.onPitch && e.pos !== 'GK') || side.players[0] || null);
    this.restartCarrier = carrier;
    const ticks = Math.max(2, Math.min(8, Math.round(this.pause * 0.6)));
    for (const s of ['home', 'away']) {
      const sd = this.sides[s];
      for (const e of sd.players) {
        if (!e.onPitch) continue;
        const tx = e === carrier ? 48 : (sd.dir > 0 ? e.slot.x * W : W - e.slot.x * W);
        const ty = e === carrier ? CY : e.slot.y * H;
        this.warpTo(e, tx, ty, ticks);
      }
    }
    this.formationReady = true;
  }

  /* ────── 볼 이동 ──────
     패스·슛은 from→to 를 dur 틱에 걸쳐 날아가고, 도착한 그 지점에서 결과가 확정됩니다.
     (화면은 확정된 판정을 한 틱 늦춰 보여 줍니다 — matchview.js 의 '판정 공개') */

  moveBall() {
    const b = this.ball;
    if (b.mode === 'carry' && b.owner) {
      b.x = b.owner.x + b.owner.dir * 0.9;
      b.y = b.owner.y;
      b.owner.touched = this.t;
      return;
    }
    if (b.mode === 'pass' || b.mode === 'shot' || b.mode === 'net') {
      b.t += 1 / SUBSTEPS;
      const p = clamp(b.t / Math.max(b.dur, 0.01), 0, 1);
      // 패스는 리시버를 따라갑니다 — 공이 움직이는 선수 발밑으로 정확히 도착합니다
      if (b.mode === 'pass' && b.receiver && b.receiver.onPitch) {
        b.to.x = b.receiver.x; b.to.y = b.receiver.y;
      }
      b.x = b.from.x + (b.to.x - b.from.x) * p;
      b.y = b.from.y + (b.to.y - b.from.y) * p;
      if (b.mode === 'net') return;
      b.trail.push({ x: b.x, y: b.y });
      if (b.trail.length > 20) b.trail.shift();
      if (b.mode === 'pass') {
        const opps = this.sides[this.opposing[b.passer.side]].players.filter((e) => e.onPitch && e.pos !== 'GK');
        for (const o of opps) {
          const d = Math.hypot(o.x - b.x, o.y - b.y);
          // 공이 지나가는 길목의 수비수가 끊을 수 있습니다
          // (비행이 여러 틱으로 늘었으니 틱당 확률을 dur 로 나눠 전체 차단 확률은 그대로)
          if (d < 1.9 && this.rng() < (0.07 + this.eff(o, 'def') / 1000) * STEP_K / Math.max(1, b.dur)) {
            this.intercept(o, b.passer);
            return;
          }
        }
      }
      if (p >= 1) {
        b.t = b.dur;
        if (b.mode === 'shot') { this.resolveShot(); return; }
        this.resolvePass();
      }
      return;
    }
    if (b.mode === 'loose') {
      b.x += b.vx; b.y += b.vy;
      b.vx *= 0.92; b.vy *= 0.92;
      if (b.x < 2 || b.x > W - 2) b.vx *= -0.6;
      if (b.y < 2 || b.y > H - 2) b.vy *= -0.6;
      const all = [...this.sides.home.players, ...this.sides.away.players].filter((e) => e.onPitch && e !== b.owner);
      let best = null, bd = 1e9;
      for (const e of all) { const d = dist(e, b); if (d < bd) { bd = d; best = e; } }
      if (best && bd < 1.6) {
        b.owner = best; b.mode = 'carry'; best.decCd = 1;
        if (best.pos === 'GK') best.holdT = this.t;
      }
    }
  }

  /* 패스가 리시버에게 실제로 닿은 순간의 처리 */
  resolvePass() {
    const b = this.ball;
    const rec = b.receiver;
    const passer = b.passer;
    b.mode = 'loose';
    b.owner = null;
    if (!rec || !rec.onPitch) return;
    const opps = this.sides[this.opposing[rec.side]].players.filter((e) => e.onPitch && e.pos !== 'GK');
    const near = opps.filter((o) => dist(o, rec) < 3.2).sort((a, c2) => dist(a, rec) - dist(c2, rec))[0];
    if (near && this.rng() < 0.13 + this.eff(near, 'def') / 950) {
      if (passer) passer.st.passOk += 1;
      if (b.cross && this.rng() < 0.22) {
        const spot = this.cornerSpot(rec.side);
        this.setPiece('corner', rec.side, spot.x, spot.y);
        return;
      }
      this.intercept(near, passer);
      return;
    }
    // 크로스는 수비가 걷어내는 경우가 많습니다
    if (b.cross && this.rng() < 0.38) {
      const clears = this.sides[this.opposing[rec.side]].players
        .filter((e) => e.onPitch && e.pos !== 'GK')
        .sort((a, c2) => dist(a, rec) - dist(c2, rec))[0];
      if (clears) {
        b.owner = clears; b.mode = 'carry'; b.cross = false;
        b.x = clears.x; b.y = clears.y; clears.decCd = 1;
        clears.st.tackles += 1; clears.rd += 0.04;
        this.sides[clears.side].stats.tackles += 1;
        this.pushEvent({ type: 'clear', side: clears.side, text: `${clears.name}${hasJong(clears.name) ? '이' : '가'} 크로스를 걷어냅니다.` });
        return;
      }
    }
    if (b.cross && this.rng() < 0.08) {
      const opp2 = this.opposing[rec.side];
      const spot = this.goalKickSpot(opp2);
      this.setPiece('goalkick', opp2, spot.x, spot.y);
      return;
    }
    b.owner = rec; b.mode = 'carry';
    b.x = rec.x + rec.dir * 0.9; b.y = rec.y;
    if (rec.pos === 'GK') rec.holdT = this.t;   // 키퍼가 받으면 바로 배급
    if (passer) { passer.st.passOk += 1; this.sides[passer.side].stats.passOk += 1; }
    rec.decCd = 0;
    if (rec.pos !== 'GK' && prog(rec.x, rec.dir) > 81 && Math.abs(rec.y - CY) < 13) {
      const pr = this.pressureOn(rec);
      const dG = Math.hypot((rec.dir > 0 ? W : 0) - rec.x, CY - rec.y);
      if (pr < 2.6 && this.rng() < (b.cross ? 0.33 : 0.66)) { this.shoot(rec, dG, pr); return; }
    }
    if (b.cross && Math.abs(rec.y - CY) < 13 && prog(rec.x, rec.dir) > 70 && rec.pos === 'FW') {
      const dGoal = Math.hypot((rec.dir > 0 ? W : 0) - rec.x, CY - rec.y);
      if (this.rng() < 0.16) { this.shoot(rec, dGoal, this.pressureOn(rec), true); return; }
    }
    b.cross = false;
  }

  intercept(defender, passer) {
    const b = this.ball;
    b.owner = defender;
    b.mode = 'carry';
    b.x = defender.x; b.y = defender.y;
    b.cross = false;
    defender.decCd = 1;
    defender.st.tackles += 1;
    defender.rd += 0.07;
    this.sides[defender.side].stats.tackles += 1;
    if (passer) passer.rd -= 0.03;
    this.say('intercept', defender.side, { p: defender.name }, 'tackle');
  }

  /* ───────────── 경합 · 파울 · 카드 · 부상 ───────────── */
  contests() {
    const b = this.ball;
    if (b.mode !== 'carry' || !b.owner) return;
    const c = b.owner;
    const opp = this.sides[this.opposing[c.side]].players.filter((e) => e.onPitch && e.pos !== 'GK');
    for (const d of opp) {
      if (dist(d, c) > 2.6) continue;
      d.tackleCd -= 1;
      if (d.tackleCd > 0) continue;
      d.tackleCd = rint(this.rng, 2, 4) / STEP_K;
      const def = this.eff(d, 'def') + this.eff(d, 'spd') * 0.25;
      const dri = this.eff(c, 'dri') * 0.8 + this.eff(c, 'spd') * 0.45 + this.eff(c, 'vis') * 0.1;
      const p = clamp((def / (def + dri)) * 0.42, 0.05, 0.44);
      if (this.rng() < p) {
        if (this.rng() < 0.58) { this.commitFoul(d, c); return; }
        b.owner = d; b.mode = 'carry';
        d.decCd = 1;
        d.st.tackles += 1; d.rd += 0.09;
        this.sides[d.side].stats.tackles += 1;
        c.rd -= 0.04;
        this.say('tackle', d.side, { p: d.name }, 'tackle');
        if (this.rng() < 0.008) this.injure(c, this.sides[c.side], 'tackle');
        return;
      }
      // 막히지 못한 수비수의 늦은 태클
      if (this.rng() < 0.075 * STEP_K) { this.commitFoul(d, c); return; }
    }
    // 지친 선수의 근육 부상
    const tired = this.sides[c.side].players.filter((e) => e.onPitch && e.stamina < 32 && !e.injured);
    if (tired.length && this.rng() < 0.006 * STEP_K) {
      const e = pick(this.rng, tired);
      this.injure(e, this.sides[e.side], 'stamina');
    }
  }

  commitFoul(defender, victim) {
    const side = this.sides[defender.side];
    const vs = this.sides[victim.side];
    side.stats.fouls += 1;
    defender.st.fouls += 1;
    defender.rd -= 0.05;
    victim.rd += 0.02;
    const reckless = this.rng() < (defender.st.yellow > 0 ? 0.05 : 0.22);
    this.say('foul', defender.side, { p: defender.name, p2: victim.name }, 'foul');
    // 카드
    const directRed = this.rng() < (reckless ? 0.004 : 0.0008);
    if (directRed) this.giveCard(defender, 'red', 'direct');
    else if (reckless) this.giveCard(defender, 'yellow');
    // 부상 (파울 상황에서 더 자주)
    if (this.rng() < (reckless ? 0.035 : 0.012)) this.injure(victim, vs, 'foul');
    // 프리킥
    if (this.done || this.phase === 'goal') return;
    const vdir = this.sides[victim.side].dir;
    let spot = { x: clamp(victim.x, 4, W - 4), y: clamp(victim.y, 4, H - 4) };
    // 박스 안에서 얻은 파울은 박스 밖 프리킥으로 (페널티는 다루지 않습니다)
    if (prog(spot.x, vdir) > 82 && Math.abs(spot.y - CY) < 20) {
      spot = { x: vdir > 0 ? W - 19 : 19, y: clamp(spot.y, CY - 12, CY + 12) };
    }
    this.setPiece('freekick', victim.side, spot.x, spot.y);
  }

  giveCard(e, color, kind = '') {
    const side = this.sides[e.side];
    if (color === 'yellow') {
      e.st.yellow += 1;
      e.rd -= 0.25;
      side.stats.yellow += 1;
      this.fx.push({ kind: 'card', color: 'yellow', at: this.t, pid: e.id });
      if (e.st.yellow >= 2) {
        this.say('secondYellow', e.side, { p: e.name }, 'card');
        this.sendOff(e, 'secondYellow');
        return;
      }
      this.say('yellow', e.side, { p: e.name }, 'card');
      return;
    }
    this.fx.push({ kind: 'card', color: 'red', at: this.t, pid: e.id });
    this.say('red', e.side, { p: e.name }, 'card');
    this.sendOff(e, kind || 'red');
  }

  sendOff(e, why) {
    if (!e.onPitch || e.sentOff) return;
    const side = this.sides[e.side];
    e.sentOff = true;
    e.onPitch = false;
    e.offAt = this.minute();
    e.st.red += 1;
    e.rd -= 0.8;
    side.stats.red += 1;
    side.reds = (side.reds || 0) + 1;
    if (this.ball.owner === e) {
      this.ball.owner = null;
      this.ball.mode = 'loose';
      this.ball.vx = (this.rng() - 0.5) * 2;
      this.ball.vy = (this.rng() - 0.5) * 2;
    }
    this.fx.push({ kind: 'red', side: e.side, at: this.t, pid: e.id, name: e.name });
    if (this.sides[e.side].players.filter((x) => x.onPitch).length < 8) this.finish();
  }

  injure(e, side, cause) {
    if (!e.onPitch || e.injured) return;
    const serious = this.rng() < 0.4;
    e.injured = { sev: serious ? 'serious' : 'light', at: this.t, cause };
    e.st.injuries += 1;
    e.factor *= serious ? 0.62 : 0.82;
    e.rd -= 0.15;
    side.stats.injuries += 1;
    this.say('injury', e.side, { p: e.name }, 'injury');
    this.fx.push({ kind: 'injury', side: e.side, at: this.t, pid: e.id, name: e.name, serious });
    this.lastInjury = { side: e.side, pid: e.id, name: e.name, serious, at: this.t };
    if (e === this.ball.owner) e.decCd = 2;
  }

  /* ───────────── 세트피스 ───────────── */
  cornerSpot(sideName) {
    const side = this.sides[sideName];
    const y = this.rng() < 0.5 ? 1.1 : H - 1.1;
    return { x: side.dir > 0 ? W - 0.9 : 0.9, y };
  }

  goalKickSpot(sideName) {
    const side = this.sides[sideName];
    const own = side.dir > 0 ? 0 : W;
    const y = this.rng() < 0.5 ? CY - 8 : CY + 8;
    return { x: clamp(own + side.dir * 5.5, 2, W - 2), y };
  }

  setPiece(type, sideName, x, y) {
    if (this.done) return;
    const side = this.sides[sideName];
    if (!side) return;
    this.lastSetPieceT = this.t;
    this.sp = { type, side: sideName, x: clamp(x, 1.5, W - 1.5), y: clamp(y, 1.2, H - 1.2), t: 0, spots: null, taker: null };
    this.phase = 'setpiece';
    this.pause = 0;
    this.clearDives();            // 세트피스에서는 키퍼가 바로 일어나 자리를 잡습니다
    this.ball.mode = 'set';
    this.ball.owner = null;
    this.ball.shot = null;
    this.ball.cross = false;
    this.ball.receiver = null;
    this.ball.passer = null;
    this.ball.x = this.sp.x;
    this.ball.y = this.sp.y;
    this.ball.px = this.sp.x;
    this.ball.py = this.sp.y;
    this.ball.trail = [];
    // 통계
    if (type === 'corner') side.stats.corners += 1;
    if (type === 'freekick') side.stats.freeKicks += 1;
    if (type === 'goalkick') side.stats.goalKicks += 1;
    this.sp.taker = this.pickTaker(type, side);
    this.arrangeSetPiece();
    // 자리로 모이기 — 예전처럼 한 프레임에 85u 튀지 않고 준비 틱에 걸쳐 미끄러지듯 이동합니다
    this.sp.snap = false;
    const warpN = Math.max(2, Math.min(4, SETUP_TICKS[type] || 2));
    for (const [e, spot] of this.sp.spots) this.warpTo(e, spot.x, spot.y, warpN);
    this.say(type, sideName, { p: this.sp.taker?.name || '', t: side.team.short }, type);
  }

  pickTaker(type, side) {
    const out = side.players.filter((e) => e.onPitch && e.pos !== 'GK');
    if (!out.length) return side.players.find((e) => e.onPitch) || null;
    if (type === 'goalkick') return side.players.find((e) => e.onPitch && e.pos === 'GK') || out[0];
    const key = type === 'corner' ? 'pas' : 'sho';
    return out.slice().sort((a, b) => this.eff(b, key) - this.eff(a, key))[0];
  }

  arrangeSetPiece() {
    const sp = this.sp;
    const side = this.sides[sp.side];
    const opp = this.sides[this.opposing[sp.side]];
    const dir = side.dir;
    const gx = dir > 0 ? W : 0;
    const spots = new Map();
    const taken = [];
    const weight = (e) => (e.pos === 'FW' ? 3 : e.pos === 'MF' ? 2 : 1);
    const atk = side.players.filter((e) => e.onPitch && e !== sp.taker && e.pos !== 'GK')
      .sort((a, b) => weight(b) - weight(a));
    const def = opp.players.filter((e) => e.onPitch && e.pos !== 'GK');
    const gkAtk = side.players.find((e) => e.onPitch && e.pos === 'GK');
    const gkDef = opp.players.find((e) => e.onPitch && e.pos === 'GK');
    // 같은 자리에 둘 이상을 놓으면, 가까운 빈 자리로 조금씩 밀어내 겹침을 없앱니다
    // (경기장 가장자리에서는 x 가 고정되므로 원 모양으로 넓게 찾습니다)
    const free = (x, y) => {
      const cx0 = clamp(x, 1.5, W - 1.5), cy0 = clamp(y, 1.5, H - 1.5);
      const clear = (px, py) => !taken.some((q) => Math.hypot(q.x - px, q.y - py) < 2.6);
      if (clear(cx0, cy0)) { taken.push({ x: cx0, y: cy0 }); return { x: cx0, y: cy0 }; }
      let best = null, bestD = -1;
      for (let ring = 2.9; ring <= 20.3; ring += 2.9) {
        for (let k = 0; k < 12; k++) {
          const ang = (k / 12) * Math.PI * 2;
          const px = clamp(cx0 + Math.cos(ang) * ring, 1.5, W - 1.5);
          const py = clamp(cy0 + Math.sin(ang) * ring, 1.5, H - 1.5);
          let d = 99;
          for (const q of taken) d = Math.min(d, Math.hypot(q.x - px, q.y - py));
          if (d >= 2.6) { taken.push({ x: px, y: py }); return { x: px, y: py }; }
          if (d > bestD) { bestD = d; best = { x: px, y: py }; }
        }
      }
      taken.push(best);
      return best;
    };
    const put = (e, x, y) => { if (e) spots.set(e, free(x, y)); };

    if (gkAtk) put(gkAtk, dir > 0 ? 6 : W - 6, CY);
    if (gkDef) put(gkDef, dir > 0 ? W - 2.4 : 2.4, CY + (sp.y > CY ? -1.8 : 1.5));
    put(sp.taker, sp.x - dir * 1.6, sp.y + (sp.y > CY ? -1.4 : 1.4));

    if (sp.type === 'corner') {
      const box = [
        [gx - dir * 6.5, CY - 5.5], [gx - dir * 11, CY + 2.5], [gx - dir * 8, CY + 7.5],
        [gx - dir * 15, CY - 7], [gx - dir * 18, CY + 4],
      ];
      atk.forEach((e, i) => {
        if (i < box.length) put(e, ...box[i]);
        else put(e, gx - dir * (22 + (i - box.length) * 4.5), CY + (((i - box.length) % 3) - 1) * 7);
      });
      const mark = [
        [gx - dir * 3, CY - 7], [gx - dir * 3, CY + 7], [gx - dir * 6.5, CY - 2.5],
        [gx - dir * 6.5, CY + 5], [gx - dir * 10, CY - 6.5], [gx - dir * 10, CY + 3],
      ];
      def.forEach((e, i) => {
        if (i < mark.length) put(e, ...mark[i]);
        else put(e, gx - dir * (18 + (i - mark.length) * 4.5), CY + (((i - mark.length) % 3) - 1) * 8);
      });
    } else if (sp.type === 'freekick') {
      const dGoal = Math.hypot(gx - sp.x, CY - sp.y);
      if (dGoal < 34) {
        const box = [[gx - dir * 9, CY - 4], [gx - dir * 13, CY + 2], [gx - dir * 10, CY + 7], [gx - dir * 18, CY - 5]];
        atk.forEach((e, i) => {
          if (i < box.length) put(e, ...box[i]);
          else put(e, gx - dir * (24 + (i - box.length) * 5), CY + (((i - box.length) % 3) - 1) * 7);
        });
        // 벽: 공에서 골문 방향으로 9.15
        const ang = Math.atan2(CY - sp.y, gx - sp.x);
        def.forEach((e, i) => {
          if (i < 4) {
            const wx = sp.x + Math.cos(ang) * (9 + i * 0.9);
            const wy = sp.y + Math.sin(ang) * (9 + i * 0.9) + (i - 1.5) * 1.3;
            put(e, wx, wy);
          } else if (i < 8) put(e, gx - dir * (4 + (i - 4) * 3), CY + (i % 2 ? 5 : -5));
          else put(e, gx - dir * (30 + (i - 8) * 4), CY + (((i - 8) % 3) - 1) * 6);
        });
      } else {
        atk.forEach((e, i) => put(e, sp.x + dir * (8 + i * 7), CY + ((i % 3) - 1) * 9));
        def.forEach((e, i) => put(e, sp.x + dir * (4 + i * 5.5), CY + ((i % 3) - 1) * 7));
      }
    } else {  // goalkick
      const own = dir > 0 ? 0 : W;
      let dN = 0, mN = 0, fN = 0;
      atk.forEach((e) => {
        if (e.pos === 'DF') { put(e, own + dir * (14 + (dN++) * 6), CY + (dN % 2 ? 16 : -16)); }
        else if (e.pos === 'MF') { put(e, own + dir * (34 + (mN++) * 6), CY + ((mN % 3) - 1) * 12); }
        else { put(e, own + dir * (56 + (fN++) * 6), CY + (fN % 2 ? 10 : -10)); }
      });
      def.forEach((e, i) => {
        if (i < 3) put(e, sp.x + dir * (12 + i * 5), CY + (i - 1) * 8);
        else put(e, own + dir * (44 + i * 6), CY + (((i - 3) % 3) - 1) * 10);
      });
    }
    sp.spots = spots;
  }

  setPieceTargetFor(e) {
    const sp = this.sp;
    if (!sp) return { x: e.x, y: e.y };
    const spot = sp.spots && sp.spots.get(e);
    if (spot) return spot;
    // 자리가 없는 선수는 기본 진형 위치로
    const side = this.sides[e.side];
    return { x: side.dir > 0 ? e.slot.x * W : W - e.slot.x * W, y: e.slot.y * H };
  }

  stepSetPiece() {
    const sp = this.sp;
    if (!sp) { this.phase = 'play'; return; }
    sp.t += 1;
    this.updateStamina(false);
    this.movePlayers();
    const ownHalf = prog(sp.x, this.sides[sp.side].dir) < 55;
    const need = sp.type === 'freekick' && ownHalf ? 3 : (SETUP_TICKS[sp.type] || 3);
    if (sp.t >= need) {
      this.executeSetPiece();
      this.moveBall();          // 찬 그 틱에 공이 바로 출발합니다 (한 틱 멈춰 있던 문제)
    }
  }

  executeSetPiece() {
    const sp = this.sp;
    const side = this.sides[sp.side];
    this.phase = 'play';
    this.sp = null;
    const taker = sp.taker && sp.taker.onPitch ? sp.taker : side.players.find((e) => e.onPitch && e.pos !== 'GK');
    if (!taker) { this.ball.mode = 'loose'; return; }
    taker.x = sp.x - side.dir * 0.8;
    taker.y = sp.y;
    taker.warp = null;          // px 는 그대로 두고 화면이 이 틱 동안 미끄러지듯 옮겨 갑니다
    this.ball.passer = taker;
    this.ball.px = this.ball.x; this.ball.py = this.ball.y;

    if (sp.type === 'goalkick') {
      const style = side.tactic.pass || 0;
      const mates = side.players.filter((e) => e.onPitch && e !== taker);
      const long = style > 0.1 ? this.rng() < 0.85 : this.rng() < 0.45;
      let target;
      if (long) {
        target = mates.filter((e) => e.pos === 'FW' || e.pos === 'MF').sort((a, b) => prog(b.x, side.dir) - prog(a.x, side.dir))[0] || mates[0];
      } else {
        target = mates.filter((e) => e.pos === 'DF').sort((a, b) => dist(a, taker) - dist(b, taker))[0] || mates[0];
      }
      if (!target) { this.ball.mode = 'loose'; return; }
      this.passTo(taker, target, false);
      this.ball.dur = clamp(Math.round(1 + dist(taker, target) / 40), 2, 3);   // 골킥은 길게 — 2~3틱
      return;
    }

    if (sp.type === 'corner') {
      const box = side.players
        .filter((e) => e.onPitch && e !== taker && e.pos !== 'GK')
        .sort((a, b) => this.eff(b, 'sho') + (b.pos === 'FW' ? 12 : 0) - this.eff(a, 'sho') - (a.pos === 'FW' ? 12 : 0));
      const short = this.rng() < 0.12 && box.length > 1;
      if (short) {
        this.passTo(taker, box[0], false);
        return;
      }
      const rec = box[0];
      if (!rec) { this.ball.mode = 'loose'; return; }
      this.ball.mode = 'pass';
      this.ball.from = { x: taker.x, y: taker.y };
      this.ball.to = { x: rec.x, y: rec.y };
      this.ball.t = 0;
      this.ball.dur = 2;        // 크로스는 화면에서 궤적이 보이게 2틱
      this.ball.passer = taker;
      this.ball.receiver = rec;
      this.ball.cross = true;
      this.ball.owner = null;
      this.ball.trail = [{ x: taker.x, y: taker.y }];
      taker.st.passes += 1;
      side.stats.passes += 1;
      return;
    }

    if (sp.type === 'freekick') {
      const gx = side.dir > 0 ? W : 0;
      const dGoal = Math.hypot(gx - sp.x, CY - sp.y);
      if (dGoal < 26 && this.rng() < clamp(0.52 - dGoal / 60, 0.06, 0.36)) {
        this.shoot(taker, dGoal, 0);
        return;
      }
      const mates = side.players.filter((e) => e.onPitch && e !== taker && e.pos !== 'GK');
      const forward = mates.filter((e) => prog(e.x, side.dir) > prog(sp.x, side.dir) + 6);
      const rec = (forward.length ? forward : mates).sort((a, b) => dist(a, taker) - dist(b, taker))[0];
      if (rec && dGoal < 38 && this.rng() < 0.3) {
        const box = mates.filter((e) => prog(e.x, side.dir) > 75 && Math.abs(e.y - CY) < 16);
        const target = box[0] || rec;
        this.ball.mode = 'pass';
        this.ball.from = { x: taker.x, y: taker.y };
        this.ball.to = { x: target.x, y: target.y };
        this.ball.t = 0;
        this.ball.dur = 2;
        this.ball.passer = taker;
        this.ball.receiver = target;
        this.ball.cross = true;
        this.ball.owner = null;
        this.ball.trail = [{ x: taker.x, y: taker.y }];
        return;
      }
      if (rec) { this.passTo(taker, rec, false); return; }
      this.ball.mode = 'loose';
    }
  }

  /* ───────────── AI 전술 조정 · 교체 ───────────── */
  aiAdjust() {
    if (this.t % 60 !== 0) return;
    for (const s of ['home', 'away']) {
      const side = this.sides[s];
      if (s === this.userSide) continue;
      const diff = this.score[s] - this.score[this.opposing[s]];
      const t = side.tactic;
      if (diff < 0) { t.line = clamp(t.line + 0.15, -1, 1); t.press = clamp(t.press + 0.15, -1, 1); }
      else if (diff > 0) { t.line = clamp(t.line - 0.1, -1, 1); t.press = clamp(t.press - 0.1, -1, 1); }
      if (this.t > 300 && diff < 0) t.route = 0.5;
    }
  }

  aiManage() {
    for (const s of ['home', 'away']) {
      if (s === this.userSide) continue;
      const side = this.sides[s];
      if (side.subsUsed >= 5) continue;
      const hurt = side.players.find((e) => e.onPitch && e.injured && e.injured.sev === 'serious');
      const tired = side.players
        .filter((e) => e.onPitch && e.pos !== 'GK' && e.stamina < 42)
        .sort((a, b) => a.stamina - b.stamina)[0];
      const out = hurt || tired;
      if (!out) continue;
      const inE = side.bench.find((e) => !e.onPitch && !e.injured);
      if (!inE) continue;
      this.doSub(s, out, inE);
    }
  }

  /* ───────────── 감독 개입 ───────────── */
  setTactic(tactic) {
    const side = this.sides[this.userSide];
    side.tactic = { ...side.tactic, ...tactic };
  }
  setFormation(fid) {
    const side = this.sides[this.userSide];
    if (!FORMATIONS[fid]) return;
    side.formation = fid;
    const slots = FORMATIONS[fid].slots;
    const outfield = side.players.filter((e) => e.onPitch && e.pos !== 'GK');
    const gk = side.players.find((e) => e.pos === 'GK' && e.onPitch);
    const used = new Set();
    slots.forEach((slot) => {
      if (slot.pos === 'GK') { if (gk) { gk.slot = slot; gk.factor = posFactor('GK', gk.p.pos); } return; }
      const cands = outfield.filter((e) => !used.has(e)).sort((a, b) => ((b.p.pos === slot.pos ? 10 : 0) + b.p.ovr / 10) - ((a.p.pos === slot.pos ? 10 : 0) + a.p.ovr / 10));
      const e = cands[0];
      if (e) { used.add(e); e.slot = slot; e.pos = slot.pos; e.label = slot.label; e.factor = posFactor(slot.pos, e.p.pos); }
    });
  }
  canSub() { return this.sides[this.userSide].subsUsed < 5 && !this.done; }
  sub(outPid, inPid) {
    const side = this.sides[this.userSide];
    if (side.subsUsed >= 5) return { ok: false, why: '교체는 최대 5명까지 가능합니다.' };
    const out = side.players.find((e) => e.id === outPid && e.onPitch);
    const inn = side.bench.find((e) => e.id === inPid && !e.onPitch);
    if (!out || !inn) return { ok: false, why: '선수를 찾을 수 없습니다.' };
    this.doSub(this.userSide, out, inn);
    if (this.ball.owner === out) this.ball.owner = inn;
    this.pushEvent({ type: 'sub', side: this.userSide, text: `🔁 교체 — ${out.name} OUT, ${inn.name} IN` });
    return { ok: true };
  }
  doSub(sideName, out, inn) {
    const side = this.sides[sideName];
    const slot = out.slot;
    inn.slot = slot; inn.pos = slot.pos; inn.label = out.label;
    inn.factor = posFactor(slot.pos, inn.p.pos) * (inn.injured ? 0.7 : 1);
    inn.dir = side.dir;
    inn.x = out.x; inn.y = out.y; inn.px = out.x; inn.py = out.y;
    inn.stamina = clamp(inn.stamina + 6, 0, 100); inn.onPitch = true; inn.st.minutes = 0;
    const idx = side.players.indexOf(out);
    if (idx >= 0) side.players[idx] = inn;
    out.onPitch = false;
    out.offAt = this.minute();
    if (this.ball.owner === out) { this.ball.owner = inn; this.ball.mode = 'carry'; }
    side.appeared.push(inn);
    side.subsUsed += 1;
  }

  /* ───────────── 화면용 요약 ───────────── */
  stats() {
    const h = this.sides.home.stats, a = this.sides.away.stats;
    const total = h.possTicks + a.possTicks || 1;
    const hp = Math.round((h.possTicks / total) * 100);
    return {
      possession: { home: hp, away: 100 - hp },
      shots: { home: h.shots, away: a.shots },
      onTarget: { home: h.onTarget, away: a.onTarget },
      xg: { home: Math.round(h.xg * 100) / 100, away: Math.round(a.xg * 100) / 100 },
      passes: { home: h.passOk, away: a.passOk },
      passAtt: { home: h.passes, away: a.passes },
      shotDist: { home: h.shots ? h.shotDist / h.shots : 0, away: a.shots ? a.shotDist / a.shots : 0 },
      ballX: { home: h.possTicks ? h.ballX / h.possTicks : 0, away: a.possTicks ? a.ballX / a.possTicks : 0 },
      finalTicks: { home: h.finalTicks || 0, away: a.finalTicks || 0 },
      boxTicks: { home: h.boxTicks || 0, away: a.boxTicks || 0 },
      tackles: { home: h.tackles, away: a.tackles },
      saves: { home: h.saves, away: a.saves },
      corners: { home: h.corners, away: a.corners },
      fouls: { home: h.fouls, away: a.fouls },
      freeKicks: { home: h.freeKicks, away: a.freeKicks },
      goalKicks: { home: h.goalKicks, away: a.goalKicks },
      yellow: { home: h.yellow, away: a.yellow },
      red: { home: h.red, away: a.red },
      injuries: { home: h.injuries, away: a.injuries },
    };
  }
  ratings(sideName) {
    return this.sides[sideName].appeared.map((e) => ({
      e, rating: Math.round(clamp(6.0 + e.rd, 4.2, 10) * 10) / 10,
    })).sort((a, b) => b.rating - a.rating);
  }
}

/* ─────────── 라인업 준비 ─────────── */
export function lineupFor(world, teamId) {
  const t = world.teams[teamId];
  const base = teamId === world.myTeamId ? world.myLineup : autoLineup(world, teamId, t.formation);
  const bad = (id) => { const p = world.players[id]; return !p || p.bans > 0 || p.inj > 0; };
  if (!base.starters.some((id) => id && bad(id))) return base;
  // 출전 정지·부상 선수는 후보 중 뛸 수 있는 선수로 바꿉니다
  const pool = (base.bench || []).filter((id) => !bad(id) && !base.starters.includes(id));
  const starters = base.starters.map((id) => (id && !bad(id) ? id : pool.shift() || id));
  return { ...base, starters };
}

/* 다른 경기의 결과를 세계에 반영 */
export function applyResult(world, m) {
  const st = m.stats();
  const played = new Set();
  for (const s of ['home', 'away']) {
    const teamId = s === 'home' ? m.homeId : m.awayId;
    for (const e of m.sides[s].appeared) {
      played.add(e.id);
      const p = world.players[e.id];
      if (!p) continue;
      p.season.apps += 1;
      p.season.goals += e.st.goals;
      p.season.assists += e.st.assists;
      p.season.shots += e.st.shots;
      p.season.onTarget += e.st.onTarget;
      p.season.saves += e.st.saves;
      p.season.tackles += e.st.tackles;
      p.season.yellow += e.st.yellow;
      p.season.red += e.st.red;
      const r = clamp(6.0 + e.rd, 4.2, 10);
      p.season.ratingSum += r;
      p.season.ratingCount += 1;
      // 퇴장 → 다음 경기 출전 정지
      if (e.st.red > 0) p.bans = (p.bans || 0) + 1;
      else if (e.st.yellow > 0 && p.season.yellow > 0 && p.season.yellow % 5 === 0) p.bans = (p.bans || 0) + 1;
      // 부상 → 회복까지 결장
      if (e.injured) {
        const out = e.injured.sev === 'serious' ? 3 : 1;
        p.inj = Math.max(p.inj || 0, out);
      }
    }
    for (const pid of world.teams[teamId].squad) {
      const p = world.players[pid];
      if (!p) continue;
      if (played.has(pid)) continue;
      if (p.bans > 0) p.bans -= 1;
      if (p.inj > 0) p.inj -= 1;
    }
  }
  const hg = m.score.home, ag = m.score.away;
  const homeTeam = world.teams[m.homeId], awayTeam = world.teams[m.awayId];
  homeTeam.recent = [...(homeTeam.recent || []), hg > ag ? 'W' : hg < ag ? 'L' : 'D'].slice(-6);
  awayTeam.recent = [...(awayTeam.recent || []), ag > hg ? 'W' : ag < hg ? 'L' : 'D'].slice(-6);
  return st;
}

export function simulateInstant(world, homeId, awayId, seed, cup = false, userSide = 'home') {
  const m = new Match({
    world, homeId, awayId,
    homeLineup: lineupFor(world, homeId),
    awayLineup: lineupFor(world, awayId),
    seed, cup, userSide,
  });
  let guard = 0;
  while (!m.done && guard < 4000) { m.tick(); guard += 1; }
  if (!m.done) m.finish();
  return m;
}
