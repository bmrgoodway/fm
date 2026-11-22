// 2D 바둑알 매치 엔진 — 90분(+추가시간)을 1분=4틱으로 시뮬레이션
// · 전술 4축(수비 라인·패스·압박·공격 루트)이 선수 좌표를 크게 바꿉니다.
// · 세트피스(코너킥·프리킥·골킥) · 파울/경고/퇴장/부상 · 하프타임과 진영 교대.
// · 틱마다 '이전 좌표(px,py) → 현재 좌표(x,y)'를 남겨 화면이 프레임마다 보간(lerp)합니다.
// 화면(DOM)에 의존하지 않으므로 '즉시 결과'에서도 그대로 돌릴 수 있습니다.
import { makeRng, clamp, rint, pick } from './rng.js';
import { FORMATIONS } from './data.js';
import { posFactor, autoLineup, squadOf, available } from './world.js';
import { defaultRole, roleFor, roleTuning, NEUTRAL_TUNING } from './tactics.js';

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
// 같은 팀 선수가 이보다 가까워지면 서로 부드럽게 밀어냅니다(오픈 플레이).
// 중앙에 바둑알이 한데 뭉치는 현상을 줄이는 장치입니다.
const SEP_R = 4.6;
const GIVE_GO_TICKS = 4;    // 원투 패스 후 리턴을 기다리는 창(틱)
const MISTIME_RUN = 0.2;    // 침투 러닝이 라인을 넘어 먼저 출발하는 비율(오프사이드 위험)

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
  offside: [
    '오프사이드! 부심의 깃발이 올라갑니다.',
    '깃발이 올라갑니다 — 오프사이드. {p}가 수비 라인을 넘어섰습니다.',
    '아쉽습니다. {p}의 침투가 오프사이드에 걸립니다.',
    '부심의 깃발! {p}가 반 박자 빠르게 움직였습니다.',
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
  switch: [
    '사이드 전환! {p}의 길고 정확한 대각 패스가 {p2}에게 닿습니다.',
    '압박을 벗어나는 전환 패스 — {p}가 반대편 {p2}를 찾습니다.',
    '{p}, 한 번에 반대편으로 넘깁니다! {p2}가 넓은 공간에서 받습니다.',
    '{p}의 대각선 전환으로 공격 방향이 바뀝니다.',
  ],
  cutback: [
    '컷백! {p}가 터치라인을 파고들어 {p2}에게 내줍니다.',
    '{p}, 엔드라인까지 가서 뒤로 내줍니다 — {p2}가 달려듭니다!',
    '낮게 깔리는 컷백, {p2}의 발 앞으로 흘러갑니다.',
  ],
  givego: [
    '원투 패스! {p}와 {p2}가 주고받으며 수비 사이를 열어젖힙니다.',
    '{p}의 리턴 — {p2}가 벽처럼 받아 다시 내줍니다.',
    '짧은 원투로 {p}가 앞으로 빠져나갑니다.',
  ],
  dribble: [
    '{p}가 빈 공간을 향해 직접 치고 나갑니다.',
    '{p}, 앞이 텄습니다. 드리블로 수비를 끌어냅니다.',
    '{p}가 볼을 몰고 전진 — 수비 라인이 물러섭니다.',
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

function makeEntity(world, pid, slot, dir, side, role = null) {
  const p = world.players[pid];
  if (!p) return null;
  return {
    p, id: pid, name: p.name, num: p.num, pos: slot.pos, label: slot.label, slot, dir, side,
    role: roleFor(slot.label, role),              // 포지션 역할(풀백·홀딩·윙어 …)
    x: 0, y: 0, px: 0, py: 0, stamina: 100, rd: 0,
    st: {
      goals: 0, assists: 0, shots: 0, onTarget: 0, saves: 0, tackles: 0, fouls: 0,
      passes: 0, passOk: 0, keyPasses: 0, yellow: 0, red: 0, minutes: 0, injuries: 0,
      crosses: 0, throughs: 0,
    },
    decCd: 0, tackleCd: 0, factor: posFactor(slot.pos, p.pos),
    rx: 0, ry: 0, rt: 0, onPitch: true, sentOff: false, injured: null, offAt: null,
    x0: 0, y0: 0, moved: 0, touched: 0, press: false,
    runT: 0, runCd: 0, ggT: -1, runOff: false,
    dive: null, lastTarget: null, holdUntil: 0,
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
    this.offsideFlash = null;   // 피치에 잠깐 띄우는 🚩 오프사이드 표시
    this.offsideGoals = 0;      // 오프사이드 위치에서 나온 득점(항상 0이어야 합니다) — 회귀 점검용
    this.offsideCd = { home: 0, away: 0 };   // 방금 깃발이 올라간 팀은 잠시 라인을 확인합니다
    this.lastSetPieceT = -99;   // 마지막 세트피스 시각(틱) — 화면·점검에서 흐름 판단용
    this.lastSwitchT = -99;     // 마지막 사이드 전환 시각(틱) — 바로 되돌리는 패스를 막는 데 씁니다
    this.lastSwitchFrom = null; // 그 전환이 출발한 쪽(y) — 되돌림 판정 기준
    this.recoverT = { home: 0, away: 0 };   // 세트피스 뒤 수비 라인 복귀 중인 구간(틱)
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
    const roles = Array.isArray(lineup.roles) ? lineup.roles : [];
    const starters = lineup.starters.map((pid, i) => makeEntity(this.world, pid, form.slots[i] || form.slots[0], dir, side, roles[i])).filter(Boolean);
    for (const e of starters) {
      e.x = dir > 0 ? e.slot.x * W : W - e.slot.x * W;
      e.y = e.slot.y * H;
      e.px = e.x; e.py = e.y; e.x0 = e.x; e.y0 = e.y;
    }
    const bench = (lineup.bench || []).map((pid) => {
      const e = makeEntity(this.world, pid, { pos: this.world.players[pid]?.pos || 'MF', label: 'SUB', x: 0.5, y: 0.5 }, dir, side, null);
      if (e) { e.onPitch = false; e.role = defaultRole('CM'); e.x = dir > 0 ? W * 0.1 : W * 0.9; e.y = CY; e.px = e.x; e.py = e.y; }
      return e;
    }).filter(Boolean);
    return {
      name: side, teamId, dir, team, formation: lineup.formation || '4-3-3',
      tactic: { line: 0, pass: 0, press: 0, route: 0, mentality: 0, ...(lineup.tactic || team.tactic) },
      players: starters, bench, subsUsed: 0, appeared: [...starters], reds: 0,
      stats: {
        shots: 0, onTarget: 0, xg: 0, possTicks: 0, passes: 0, passOk: 0, tackles: 0, saves: 0,
        corners: 0, freeKicks: 0, goalKicks: 0, fouls: 0, yellow: 0, red: 0, injuries: 0, shotDist: 0, offsides: 0,
        // 전개 패턴 계측 — 평균 패스 거리, 사이드 전환·스루·원투·컷백·크로스 빈도, 폭·깊이
        passDist: 0, passN: 0, longN: 0,
        switchN: 0, throughN: 0, givegoN: 0, cutbackN: 0, crossN: 0, headerShots: 0, dribbleTicks: 0,
        // 압박 탈취 지점·전환 창 — 압박의 이득(전방 탈취 → 즉시 슈팅)을 재는 값
        winN: 0, winSum: 0, transShots: 0, behindShots: 0,
        widthSum: 0, widthN: 0, depthSum: 0, depthN: 0,
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
  /* 선수의 역할(포지션 역할)과 그 수치 묶음 */
  roleOf(e) { return e.role || defaultRole(e.slot?.label || e.label || 'CM'); }
  tuneOf(e) { return roleTuning(this.roleOf(e)) || NEUTRAL_TUNING; }
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
    this.ball.offside = null;
    this.ball.passer = null;
    this.ball.receiver = null;
    this.ball.kind = 'pass';
    this.ball.lead = false;
    this.ball.cross = false;
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
    if (this.phase === 'play') this.sampleSpace();
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

  /* ───────────── 체력 ─────────────
     90분을 뛰면 실제로 지칩니다. 소모는 '그 틱에 뛴 거리'에 비례하고,
     압박 축이 높을수록 같은 시간에 더 많이 쓰며, 체력 능력치가 높은 선수는 덜 지칩니다.
     (예전 계수는 90분에 98 남아 압박 전술의 대가도, 후반 교체도 생기지 않았습니다) */
  updateStamina(paused) {
    for (const s of ['home', 'away']) {
      const press = this.sides[s].tactic.press || 0;
      for (const e of this.sides[s].players) {
        if (!e.onPitch) continue;
        const moved = e.moved || 0;
        if (paused) { e.stamina = clamp(e.stamina + 0.05, 0, 100); continue; }
        const effort = 0.62 + Math.min(1.4, moved / 0.55) * 0.55;      // 0.62(거의 안 뛴 틱) ~ 1.39(전력 질주)
        const ment = Number(this.sides[s].tactic.mentality) || 0;
        const pressTax = clamp(1 + press * 0.57 + ment * 0.16, 0.7, 1.7);  // 강한 압박·총공세는 같은 시간에 더 많이
        const cond = 1.5 - (e.p.stats.sta || 60) * 0.006;              // 체력 능력치 60 → 1.14, 85 → 0.99
        const drain = 0.115 * effort * pressTax * cond / SUBSTEPS;
        e.stamina = clamp(e.stamina - drain, 0, 100);
      }
    }
  }

  updateDrift() {
    for (const s of ['home', 'away']) {
      for (const e of this.sides[s].players) {
        // 침투 러닝·원투 창의 남은 시간을 한 단계씩 줄입니다
        if (e.runT > 0) { e.runT -= 1; if (e.runT <= 0) e.runOff = false; }
        if (e.runCd > 0) e.runCd -= 1;
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
    // 측면 점유율 — 공을 가진 동안 공이 터치라인 근처(|y-CY|>14)에 있던 비율
    if (Math.abs(this.ball.y - CY) > 14) side.stats.wideTicks = (side.stats.wideTicks || 0) + 1;
  }

  /* 틱마다 '공을 가진 팀'의 평균 폭(|y-CY|)과 깊이(진행도)를 샘플링합니다 — 전술 체감 점검용 */
  sampleSpace() {
    const owning = this.ball.owner ? this.ball.owner.side
      : this.ball.mode === 'pass' && this.ball.passer ? this.ball.passer.side : null;
    if (!owning) return;
    const side = this.sides[owning];
    let w = 0, d = 0, n = 0;
    for (const e of side.players) {
      if (!e.onPitch || e.pos === 'GK') continue;
      w += Math.abs(e.y - CY); d += prog(e.x, side.dir); n += 1;
    }
    if (!n) return;
    side.stats.widthSum += w / n; side.stats.widthN += 1;
    side.stats.depthSum += d / n; side.stats.depthN += 1;
  }

  /* ───────────── 전술 → 진형 ─────────────
     네 축이 진형의 '높이·폭·압박 수·간격'을 직접 정합니다. */
  computeShape(side, hasBall) {
    const t = side.tactic;
    const line = t.line || 0, press = t.press || 0, pass = t.pass || 0, route = t.route || 0;
    const ment = Number(t.mentality) || 0;        // 팀 성향(멘탈리티) — 전원을 밀고·내립니다
    const ballP = prog(this.ball.x, side.dir);
    let df = (hasBall ? 26 : 17) + line * (hasBall ? 10 : 8);
    let mf = (hasBall ? 47 : 33) + line * (hasBall ? 9 : 7);
    let fw = (hasBall ? 71 : 52) + line * (hasBall ? 6 : 5);
    const push = (ballP - 50) * (hasBall ? 0.42 : 0.34);
    df += push; mf += push * 0.88; fw += push * 0.78;
    if (hasBall) {
      // 롱볼은 앞선을 높게 — 다만 중원이 끊기지 않을 만큼만
      fw += pass * 6.5; mf -= pass * 2.5; df -= pass * 1.5;
    } else {
      df -= pass * 3; mf -= pass * 2.5; fw += pass * 2;
    }
    if (!hasBall) {
      // 강한 압박 = 블록 자체가 조금 올라와 상대를 조입니다.
      // (예전에는 라인을 9u까지 밀어 올려, 압박을 걸면 수비 대형이 통째로 앞으로 나가
      //  뒤가 비었습니다 — 압박의 이득보다 실점이 커진 원인)
      df += press * 0.8; mf += press * 1.6; fw += press * 2.4;
    } else {
      df += press * 1.6;
    }
    // ── 팀 성향 ──
    // 잠그기·수비적: 수비 라인부터 내리고 라인 간격을 좁혀 두 줄 블록을 만듭니다.
    // 공격적·총공세: 전원이 앞으로 올라가고 공격 라인은 더 벌어집니다.
    if (ment !== 0) {
      df += ment * (hasBall ? 6.5 : 9);
      mf += ment * (hasBall ? 9.5 : 11);
      fw += ment * 9.5;
      if (ment < 0) {
        const k = 1 + ment * 0.3;                  // -1 → 간격 70%
        mf = df + (mf - df) * k;
        fw = mf + (fw - mf) * k;
      } else {
        const k = 1 + ment * 0.12;
        mf = df + (mf - df) * k;
        fw = mf + (fw - mf) * k;
      }
    }
    const wide = (hasBall ? 14 + (route + 1) * 8 : 13 - Math.abs(route) * 2 - (1 - press) * 1.6)
      * (ment < 0 ? 1 + ment * (hasBall ? 0.08 : 0.2) : 1 + ment * 0.06);
    const mid = hasBall ? 6.5 - route * 3 : 9.5 - Math.abs(route) * 1.8;
    const men = 11 - (side.reds || 0);
    // 상대 수비 라인의 높이 — 침투 러닝과 스루패스의 목표점을 정합니다
    let oppLine = 52;
    if (hasBall) {
      const opp = this.sides[this.opposing[side.name || side.side]];
      let m = 0, n = 0;
      for (const o of opp.players) {
        if (!o.onPitch || o.pos !== 'DF') continue;
        m += prog(o.x, side.dir); n += 1;
      }
      if (n) oppLine = m / n;
    }
    return {
      df: clamp(df, 6, 88), mf: clamp(mf, 10, 92), fw: clamp(fw, 24, 94),
      wide: clamp(wide, 6, 28), mid: clamp(mid, 2.5, 12),
      ballP, line, press, pass, route, hasBall, men, oppLine, ment,
      // 압박 인원·반경 — 압박이 세면 '더 많은 선수가 더 가까이' 달려듭니다.
      // (예전에는 반경이 34u까지 넓어져, 30u 밖에 있던 4번째 선수가 자기 자리를 버리고
      //  달려오느라 압박을 걸수록 대형이 무너졌습니다)
      pressCount: Math.max(1, Math.min(3, 1 + Math.round((press + 1) * 1.0) - (side.reds || 0))),
      pressRange: clamp(14 + (press + 1) * 6 - Math.max(0, -ment) * 3.5, 11, 27),
    };
  }

  /* ───────────── 이동 ───────────── */
  movePlayers() {
    this.stepWarps();       // 자리로 모이는 중인 선수는 워프가 위치를 정합니다
    // 패스가 날아가는 동안도 '공을 가진 팀'의 공격 대형을 유지합니다.
    // (예전에는 비행 중 소유자가 없어 양 팀이 수비 대형으로 움츠러들었고,
    //  공격 폭·침투가 화면에 드러나지 않았습니다)
    const owningSide = this.ball.owner ? this.ball.owner.side
      : this.ball.mode === 'pass' && this.ball.passer ? this.ball.passer.side
        : null;
    for (const s of ['home', 'away']) {
      const side = this.sides[s];
      const hasBall = owningSide === s;
      side._shape = this.computeShape(side, hasBall);
      if (!hasBall) {
        const all = side.players
          .filter((e) => e.onPitch && e.pos !== 'GK' && !e.injured)
          .sort((a, b) => dist(a, this.ball) - dist(b, this.ball));
        // 수비수는 자기 라인에서 14u 넘게 떨어져 있는 공을 쫓아 나가지 않습니다 —
        // 라인을 지키는 역할(커버·풀백)과 팀 성향(라인 높이)이 그대로 드러나게 하는 장치입니다.
        const chasable = all.filter((e) => !(e.pos === 'DF' && prog(this.ball.x, side.dir) > prog(e.x, side.dir) + 14));
        // 압박수만큼 달려들되, 반발력(separate)이 같은 자리에 겹치는 것을 막아 줍니다
        // 세트피스(코너)를 찬 직후에는 수비 라인으로 돌아가는 중인 DF 를 압박 후보에서 뺍니다.
        // (예전에는 문전에 남아 있던 DF 가 '가까운 선수'라 압박 1순위가 되어 공 쪽으로 다시 질주했습니다)
        const ready = chasable.filter((e) => !(e.pos === 'DF' && this.isRecovering(e, side)));
        side._pressers = ready.length >= 2 ? ready : (chasable.length ? chasable : all);
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
        else if (!hasBall && e.pos === 'DF' && this.isRecovering(e, side)) sp *= 1.55;   // 코너 뒤 라인 복귀는 전력으로
        else if (!hasBall && d > 10) sp *= 1.2;   // 수비 전환 — 제자리로 빨리 돌아갑니다
        else if (this.ball.mode === 'pass' && this.ball.lead && this.ball.receiver === e) sp *= 1.28;  // 스루패스를 쫓는 질주
        if (e.injured) sp *= 0.72;
        if (e.pos === 'GK') {
          // 다이빙 중에는 몸이 이미 공 쪽으로 뻗어 있습니다 — 발로 미끄러지지 않게 이동을 멈춥니다
          if (e.dive && e.dive.landAt == null) { e.moved = 0; continue; }
          if (d < 0.45) { e.moved = 0; continue; }   // 골문 앞 미세한 떨림 방지
          const ownX = side.dir > 0 ? 0 : W;
          const currOut = Math.abs(e.x - ownX), tgtOut = Math.abs(tgt.x - ownX);
          // 위험할 때는 골문 앞으로 빠르게 복귀, 평소 전진은 천천히.
          // 골키퍼는 각도선을 따라 옆으로(측면 이동)는 더 발 빠르게 섭니다 — 다이빙 전 자리 잡기.
          const latGap = Math.abs(tgt.y - e.y);
          sp *= tgtOut < currOut - 0.6 ? 1.9 : 1.3;
          if (latGap > 2) sp *= 1.6;
        }
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
    // 오픈 플레이에서만: 같은 팀 선수끼리 최소 간격을 지키게 부드럽게 밀어냅니다
    if (this.phase === 'play') this.separate();
  }

  /* 세트피스(코너·문전 프리킥)를 찬 팀의 DF 가 아직 상대 진영에 남아 복귀 중인가 */
  isRecovering(e, side) {
    if (e.pos !== 'DF') return false;
    const until = this.recoverT[e.side] || 0;
    if (this.t > until) return false;
    return prog(e.x, side.dir) > 48;
  }

  /* 반발력(Separation) — 같은 팀 선수가 4.6u 안으로 겹치면 서로 반대로 밀립니다.
     공 소유자·압박수는 덜 밀려 자기 임무(공을 지키기·빼앗기)를 놓지 않습니다. */
  separate() {
    for (const s of ['home', 'away']) {
      const ps = this.sides[s].players;
      for (let i = 0; i < ps.length; i++) {
        const a = ps[i];
        if (!a.onPitch || a.warp) continue;
        for (let j = i + 1; j < ps.length; j++) {
          const c = ps[j];
          if (!c.onPitch || c.warp) continue;
          let dx = c.x - a.x, dy = c.y - a.y;
          let d = Math.hypot(dx, dy);
          if (d >= SEP_R) continue;
          if (d < 0.01) {
            dx = this.rng() - 0.5; dy = this.rng() - 0.5;
            d = Math.hypot(dx, dy) || 0.2;
          }
          const ux = dx / d, uy = dy / d;
          const wa = this.spacingWeight(a), wc = this.spacingWeight(c);
          const sum = wa + wc || 1;
          // 살짝 스치면 부드럽게, 깊게 겹치면 단숨에 — 화면에 두 알이 포개진 채로 보이지 않게
          const gap = Math.min((SEP_R - d) * 0.95 + 0.1, 1.4);
          a.x -= ux * gap * (wa / sum); a.y -= uy * gap * (wa / sum);
          c.x += ux * gap * (wc / sum); c.y += uy * gap * (wc / sum);
        }
      }
      for (const e of ps) {
        if (!e.onPitch) continue;
        e.x = clamp(e.x, 1, W - 1); e.y = clamp(e.y, 1, H - 1);
      }
    }
  }
  spacingWeight(e) {
    if (e === this.ball.owner) return 0.3;   // 공을 지키는 선수는 자리를 지킵니다
    if (e.press) return 0.65;
    if (e.pos === 'GK') return 0.2;
    return 1;
  }

  /* ───────────── 골키퍼 위치 ─────────────
     골키퍼는 골라인 한가운데에 붙어 있지 않습니다.
     · 공과 골문 중앙을 잇는 각도선 위로 나와 슈팅 각도를 좁힙니다 (공이 가까울수록 조금 더 나옵니다).
     · 우리 팀이 상대 진영에서 공을 돌리면 페널티 박스 앞(스위퍼 자리)까지 전진해 뒷공간을 덮습니다.
     · 상대가 위험 지역으로 들어오면 곧바로 골문 앞으로 내려섭니다. */
  gkTarget(e, side, hasBall) {
    const dir = side.dir;
    const ball = this.ball;
    const ownX = dir > 0 ? 0 : W;
    const dx = ball.x - ownX, dy = ball.y - CY;
    const dB = Math.hypot(dx, dy) || 0.001;
    const ux = dx / dB, uy = dy / dB;
    const sh = side._shape || this.computeShape(side, hasBall);
    const ballP = prog(ball.x, dir);
    // 각도를 좁히는 기본 거리 — 공이 가까울수록 문 앞으로 살짝 나옵니다
    const stand = 1.5 + (1 - clamp(dB / 46, 0, 1)) * 3.2;
    // 스위퍼: 우리 볼 때 상대 진영 전개면 박스 앞까지, 수비 전환·위험 지역이면 즉시 복귀
    let sweep;
    if (hasBall) {
      sweep = clamp((ballP - 44) / 40, 0, 1) * (10 + Math.max(0, sh.line) * 5);
    } else if (ballP > 60) {
      sweep = clamp((ballP - 60) / 30, 0, 1) * 4.5;   // 상대 진영에서 상대 볼 — 조금만 나옵니다
    } else {
      sweep = (1 - clamp((42 - ballP) / 30, 0, 1)) * 1.2;
    }
    // 공이 우리 골문 가까이 오면(상대 슈팅 각) 스위퍼 전진은 취소합니다
    if (ballP < 30) sweep *= 0.35;
    if (this.phase === 'setpiece') sweep *= 0.3;
    const d = clamp(stand + sweep, 1.1, 15.5);
    let x = ownX + ux * d;
    let y = CY + uy * d;
    x = dir > 0 ? clamp(x, 0.8, 16.5) : clamp(x, W - 16.5, W - 0.8);
    y = clamp(y, CY - 10, CY + 10);
    return { x, y };
  }

  /* ───────────── 오프사이드 라인 ─────────────
     상대 골문 쪽에서 두 번째(= 끝에서 두 번째) 수비수의 진행도가 오프사이드 라인입니다.
     키퍼가 스위퍼로 올라와 있으면 그 키퍼가 라인이 됩니다. */
  offsideLineDepth(sideName) {
    const side = this.sides[sideName];
    if (!side) return null;
    const opp = this.sides[this.opposing[sideName]];
    const ds = opp.players.filter((e) => e.onPitch).map((e) => prog(e.x, side.dir)).sort((a, b) => b - a);
    if (ds.length < 2) return null;
    return ds[1];
  }

  /* 이 선수가 설 수 있는 한계 깊이 — 수비 라인과 공 중 더 골문에 가까운 쪽까지 */
  onsideLimit(e) {
    const line = this.offsideLineDepth(e.side);
    if (line == null) return null;
    return Math.max(line, prog(this.ball.x, e.dir));
  }

  /* 공격 위치를 오프사이드 라인 안으로 당깁니다 — 라인을 넘어 미리 서 있지 않게 */
  onsideClamp(e, t) {
    const lim = this.onsideLimit(e);
    if (lim == null) return t;
    const cap = lim - 0.8;
    if (prog(t.x, e.dir) <= cap) return t;
    return { x: e.dir > 0 ? cap : W - cap, y: t.y };
  }

  /* 패스 출발 순간 오프사이드 위치인가
     → 상대 진영 · 공보다 앞 · 끝에서 두 번째 수비수보다 앞. 동일 선상은 온사이드입니다. */
  offsideSpot(c, m) {
    const dir = c.dir;
    const opp = this.sides[this.opposing[c.side]];
    const ds = opp.players.filter((e) => e.onPitch).map((e) => prog(e.x, dir)).sort((a, b) => b - a);
    if (ds.length < 2) return null;
    const line = ds[1];
    const mD = prog(m.x, dir);
    if (mD <= 50) return null;                        // 자기 진영 — 오프사이드가 아닙니다
    if (mD <= prog(c.x, dir) + 0.4) return null;      // 공보다 뒤·같은 선
    if (mD <= line + 1.0) return null;                // 수비 라인과 같거나 비슷한 선 — 온사이드
    return { x: m.x, y: m.y, line, side: c.side, receiver: m };
  }

  /* 오프사이드 판정 — 깃발·중계·상대 프리킥, 그리고 기록 */
  callOffside(info, rec) {
    const atk = this.sides[info.side];
    const def = this.sides[this.opposing[info.side]];
    if (!atk || !def) return;
    atk.stats.offsides += 1;
    this.offsideCd[atk.name] = this.t + 24;
    const name = rec ? rec.name : '';
    if (rec) rec.rd -= 0.05;
    this.offsideFlash = { at: this.t, x: info.x, y: info.y, line: info.line, lineX: atk.dir > 0 ? info.line : W - info.line, side: def.name };
    this.fx.push({ kind: 'offside', side: def.name, at: this.t, x: info.x, y: info.y, name });
    this.say('offside', atk.name, { p: name }, 'offside');
    // 상대 프리킥으로 재개 — 오프사이드 지점에서
    const spot = { x: clamp(info.x, 5, W - 5), y: clamp(info.y, 3.5, H - 3.5) };
    this.setPiece('freekick', def.name, spot.x, spot.y, { quiet: true, noStat: true });
  }

  targetFor(e, side, hasBall) {
    const ball = this.ball;
    const dir = side.dir;
    const sh = side._shape || this.computeShape(side, hasBall);
    if (e.pos === 'GK') return this.gkTarget(e, side, hasBall);
    // 스루패스가 날아가는 중 — 받을 선수는 공이 떨어질 지점으로 달려갑니다
    if (ball.mode === 'pass' && ball.lead && ball.receiver === e) {
      return { x: ball.to.x, y: ball.to.y };
    }
    const sy = (e.slot.y - 0.5) * 2;      // -1(왼쪽) ~ 1(오른쪽)
    const abs = Math.abs(sy);
    const rol = this.roleOf(e);           // 포지션 역할 — 자리·폭·판단을 바꿉니다
    const tune = this.tuneOf(e);
    let p;
    if (e.pos === 'DF') p = sh.df + (abs > 0.5 ? 1.5 : 0);
    else if (e.pos === 'MF') p = sh.mf + (abs > 0.5 ? 2.5 : -abs * 2);
    else p = sh.fw + (abs > 0.5 ? -2 : 2);
    p += tune.depth;                      // 커버·홀딩·타깃은 내려서고, 스토퍼·포처는 올라섭니다
    let halfW = (abs > 0.5 ? sh.wide : Math.max(3, sh.mid * (0.55 + abs))) * tune.width;
    let y = CY + sy * halfW + (ball.y - CY) * (hasBall ? 0.16 : 0.24);

    if (hasBall) {
      if (e === this.ball.owner) return this.carrierTarget(e);
      const wideRole = abs > 0.62 || (abs > 0.5 && e.pos !== 'MF');
      const mySide = Math.sign(sy) || 1;
      const ballSide = Math.abs(ball.y - CY) > 6 ? Math.sign(ball.y - CY) : 0;

      // ⓪ 총공세 — 수비수도 하프라인을 넘어 올라갑니다 (공 쪽 센터백이 문전으로, 반대쪽은 하프라인 유지)
      if (e.pos === 'DF' && abs < 0.5 && sh.ment >= 0.75 && sh.ballP > 58) {
        const sign = e.slot.y < 0.5 ? -1 : 1;
        const sideY = Math.abs(ball.y - CY) > 6 ? Math.sign(ball.y - CY) : 0;
        const near = sideY === 0 || sign === sideY;
        const both = sh.ballP > 64;          // 문전까지 몰아붙이는 국면에는 둘 다 올라갑니다
        const deep = (near || both)
          ? clamp(sh.ballP + (sh.ballP > 72 ? 6 : 0), 60, 88)
          : clamp(sh.mf + 12, 56, 82);
        const ry = (near || both) && sh.ballP > 72 ? CY + sign * 6 : CY + sign * 11;
        return this.onsideClamp(e, { x: dir > 0 ? deep : W - deep, y: clamp(ry, 7, H - 7) });
      }

      // ① 크로스가 날아가는 중 — 문전으로 쇄도합니다 (헤더·세컨드볼 각도)
      if (ball.mode === 'pass' && ball.cross && ball.passer && ball.passer.side === e.side
        && (e.pos === 'FW' || (e.pos === 'MF' && (e.slot.x > 0.38 || Math.abs(e.slot.y - 0.5) > 0.42)))) {
        const sign = e.slot.y < 0.5 ? -1 : 1;
        const ry = CY + sign * (4.5 + Math.abs(e.ry || 0) * 0.35);
        return this.onsideClamp(e, { x: dir > 0 ? 89 : W - 89, y: clamp(ry, 7, H - 7) });
      }
      // ② 원투 — 방금 패스한 선수는 전방으로 빠져 리턴을 받을 준비를 합니다
      if (e.ggT > this.t) {
        return this.onsideClamp(e, {
          x: clamp(e.x + dir * 10, 4, W - 4),
          y: clamp(e.y + (CY - e.y) * 0.12, 4, H - 4),
        });
      }
      // ③ 약읍면(Weak side): 공 반대쪽 윙어·풀백은 터치라인 넓은 공간으로 벌립니다
      if (wideRole && ballSide !== 0 && mySide !== ballSide) {
        // 공이 깊은 지역까지 들어오면 반대쪽 윙어는 터치라인이 아니라 먼 골대(백포스트)로 쇄도합니다
        if (sh.ballP > 78 && Math.abs(ball.y - CY) > 15 && e.pos === 'FW') {
          return this.onsideClamp(e, { x: dir > 0 ? 88 : W - 88, y: clamp(CY + mySide * 4.5, 6, H - 6) });
        }
        const depth = e.pos === 'DF'
          ? sh.df + (rol === 'wingback' ? 10 : 1.5)
          : e.pos === 'FW' ? sh.fw + (rol === 'inside' ? 2 : 1) : sh.mf + 3;
        const yWide = CY + mySide * (H / 2 - 4.2 - Math.max(0, sh.route) * 1.2) * (rol === 'inside' ? 0.55 : 1);
        return this.onsideClamp(e, { x: dir > 0 ? clamp(depth, 8, 90) : W - clamp(depth, 8, 90), y: clamp(yWide + (e.ry || 0) * 0.25, 3.5, H - 3.5) });
      }
      // ④ 뒷공간 침투 — 공격수와 2선이 수비 라인 뒤로 달립니다
      const runner = this.runRole(e);
      if (runner && sh.ballP > 40 && sh.ballP < 92) {
        this.tickRun(e, sh);
        if (e.runT > 0) {
          // 수비가 깊게 내려섰으면 러닝 목표는 박스 문전까지 — 라인 뒤가 아니어도 문전으로 들어갑니다
          const boxPush = sh.ballP > 64 ? 84 : 0;
          let depth = clamp(Math.max(sh.oppLine + 3.5, boxPush) + (e.pos === 'FW' ? 2.5 : 0) + (sh.route > 0.3 && wideRole ? 1.5 : 0), 12, 93);
          // 오프사이드 라인 타기 — 패스가 오기 전에는 최후방 수비수와 공에 맞춰 선을 지키고,
          // 볼이 나간 순간(아래 스루패스 추적)에만 뒷공간으로 파고듭니다. 가끔은 판단이 반 박자 빨라 걸립니다.
          if (!e.runOff) {
            const lim = this.onsideLimit(e);
            if (lim != null) depth = Math.max(12, Math.min(depth, lim - 0.8));
          }
          let ry;
          if (e.pos === 'FW' && abs < 0.34) {
            // 스트라이커는 골문 앞·페널티 스포트로
            ry = CY + (mySide || (this.rng() < 0.5 ? -1 : 1)) * (3.5 + Math.abs(e.ry || 0) * 0.35);
          } else if (rol === 'inside') {
            ry = CY + mySide * 7.5;                    // 인사이드 포워드는 하프스페이스로
          } else {
            ry = CY + mySide * (wideRole ? 15 + Math.max(0, sh.route) * 4 : 9);
          }
          return { x: dir > 0 ? depth : W - depth, y: clamp(ry, 4, H - 4) };
        }
      } else if (e.runT > 0) e.runT = 0;

      // ⑤ 문전 점유 — 공이 전방으로 넘어가면 공격수는 박스에 머뭅니다 (러닝 텀 사이에도)
      if (sh.ballP > 64) {
        if (e.pos === 'FW' && abs < 0.34) {
          // 포처는 골문 바로 앞, 타깃맨은 문전 중앙에서 버티며 등지는 자리
          const yBox = CY + (mySide || (e.ry > 0 ? 1 : -1)) * (rol === 'poacher' ? 3.2 : rol === 'target' ? 4.6 : 5.4);
          const dBox = rol === 'poacher' ? 87 : rol === 'target' ? 83 : 85;
          return this.onsideClamp(e, { x: dir > 0 ? dBox : W - dBox, y: clamp(yBox, 7, H - 7) });
        }
        // 인사이드 포워드는 엔드라인이 아니라 박스 안쪽(하프스페이스)으로 접어 들어와 슈팅을 봅니다
        if (e.pos === 'FW' && rol === 'inside') {
          return this.onsideClamp(e, { x: dir > 0 ? 82 : W - 82, y: clamp(CY + mySide * 8.5, 9, H - 9) });
        }
        if (e.pos === 'MF' && Math.abs(sy) < 0.5 && e.slot.x > 0.4) {
          // 측면 루트를 쓰면 2선이 문전(박스)까지 올라와 크로스에 몸을 겁니다
          const bx = 79 + Math.max(0, sh.route) * 6;
          return this.onsideClamp(e, { x: dir > 0 ? bx : W - bx, y: clamp(CY + (e.slot.y < 0.5 ? -11 : 11), 10, H - 10) });
        }
      }
      // ⑥ 측면 공격수는 깊은 지역에서 엔드라인을 향해 벌어집니다 (컷백 각도)
      if (wideRole && e.pos !== 'DF' && rol !== 'inside' && sh.ballP > 55 && sh.route > 0.15) {
        const depth = e.pos === 'FW' ? 86 : 80;
        return this.onsideClamp(e, { x: dir > 0 ? clamp(depth, 8, 92) : W - clamp(depth, 8, 92), y: clamp(CY + mySide * (H / 2 - 6), 4, H - 4) });
      }
      // ⑦ 오버랩 — 윙백은 볼이 앞으로 넘어가면 윙어 뒤를 받쳐 줍니다 (풀백은 뒤에 남습니다 · 잠그기에서는 아무도 올라가지 않습니다)
      if (e.pos === 'DF' && wideRole && tune.overlap > 0 && sh.ment > -0.75 && sh.ballP > 44) {
        let depth = clamp(sh.ballP + 1, 24, 84);
        const lim = this.onsideLimit(e);
        if (lim != null) depth = Math.min(depth, lim - 0.8);
        return { x: dir > 0 ? depth : W - depth, y: clamp(CY + mySide * (H / 2 - 6.5), 3.5, H - 3.5) };
      }
      // ⑦-2 플레이메이커 — 공보다 앞에 있으면 라인 사이에 서고, 뒤에 있으면 내려와 받습니다
      if (rol === 'playmaker') {
        const myP = prog(e.x, dir);
        const ahead = myP > sh.ballP;
        const depth = ahead
          ? clamp(Math.min(sh.ballP + 12, (sh.oppLine || 60) - 1), 18, 92)
          : clamp(sh.ballP - 10, 8, 90);
        return this.onsideClamp(e, {
          x: dir > 0 ? depth : W - depth,
          y: clamp(CY + sy * 7 + (ball.y - CY) * 0.15, 7, H - 7),
        });
      }
      // ⑦-3 홀딩 — 공을 잡아도 수비 라인 앞을 벗어나지 않습니다
      if (rol === 'holding' && sh.ballP < 62) {
        return this.onsideClamp(e, { x: dir > 0 ? clamp(sh.df + 7, 10, 70) : W - clamp(sh.df + 7, 10, 70), y: clamp(CY + sy * 6, 8, H - 8) });
      }

      // ⑧ 지원 — 공 옆에 붙는 선수는 소수만, 나머지는 자기 구역을 지킵니다
      // (수비수는 지원 대상에서 뺍니다 — 풀백·커버의 '뒤에 남는' 자리가 공 쪽으로 끌려가지 않게)
      const mates = side.players.filter((x) => x.onPitch && x !== this.ball.owner && x.pos !== 'GK' && x.pos !== 'DF' && !(x.runT > 0));
      mates.sort((a, b) => dist(a, ball) - dist(b, ball));
      const rank = mates.indexOf(e);
      if (rank === 0 && sh.ballP > 24) {
        const sign = ball.y < CY ? 1 : -1;   // 공의 반대쪽으로 몸을 열어 줍니다
        return this.onsideClamp(e, {
          x: clamp(ball.x - dir * 8, 4, W - 4),
          y: clamp(ball.y + sign * 8, 5, H - 5),
        });
      }
      if (rank === 1 && sh.ballP > 32) {
        const sign = e.slot.y < 0.5 ? -1 : 1;
        return this.onsideClamp(e, {
          x: clamp(ball.x - dir * 12, 4, W - 4),
          y: clamp(CY + sign * 16, 5, H - 5),
        });
      }
    } else {
      // 수비: 압박 수·범위는 '압박 강도' 축과 역할이 정하되, 같은 점으로 몰려들지 않게 각도를 벌립니다
      const idx = side._pressers ? side._pressers.indexOf(e) : -1;
      const pressRange = sh.pressRange + tune.press;   // 스토퍼는 넓게, 커버·홀딩·포처는 좁게
      if (idx >= 0 && idx < sh.pressCount && dist(e, ball) < pressRange) {
        e.press = true;
        const lead = 0.9 + Math.max(0, sh.press) * 1.5;
        // 압박수끼리 같은 점으로 달려들지 않게 좌우로 번갈아 각도를 벌립니다
        const lane = idx % 2 ? 3.6 : -3.6;
        const spread = clamp((e.y - ball.y) * 0.3 + (idx === 0 ? 0 : lane), -9, 9);
        return { x: clamp(ball.x + dir * lead, 2, W - 2), y: clamp(ball.y + spread, 3, H - 3) };
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

  /* 침투 러닝을 할 만한 역할인가 — 역할(포처·윙어·B2B)과 팀 성향이 정합니다 */
  runRole(e) {
    if (e.injured) return false;
    const tune = this.tuneOf(e);
    if (!(tune.run > 0)) return false;                 // 홀딩·플레이메이커·타깃맨·커버는 라인 뒤로 달리지 않습니다
    const ment = Number(this.sides[e.side]?.tactic?.mentality) || 0;
    if (ment <= -0.75 && e.pos !== 'FW') return false;  // 잠그기에서는 공격수만 침투
    if (e.pos === 'FW') return true;
    if (e.pos === 'MF') return e.slot.x > 0.4 || Math.abs(e.slot.y - 0.5) > 0.5;
    return false;
  }
  /* 러닝은 계속 서 있지 않습니다 — 몇 단계 달리고, 다시 자리를 잡았다가 또 칩니다 */
  tickRun(e, sh) {
    if (e.runT > 0) return;
    if (e.runCd > 0) { e.runCd -= 1; return; }
    const tune = this.tuneOf(e);
    // 압박으로 뺏은 직후에는 앞선이 뒷공간으로 한 번 더 달립니다 (전환의 실제 이득)
    const trans = Math.max(this.transitionBonus(this.sides[e.side]), this.counterBonus(this.sides[e.side]));
    const push = (0.16 + Math.max(0, sh.line) * 0.08 + Math.max(0, sh.pass) * 0.04
      + Math.max(0, sh.ment || 0) * 0.12 + trans * 0.18) * clamp(0.6 + tune.run * 0.45, 0.4, 1.6);
    if (this.rng() < push) {
      e.runT = rint(this.rng, 10, 22);
      e.runCd = e.runT + rint(this.rng, 12, 34);
      // 라인을 확인하지 못하고 먼저 출발하는 러닝 — 부심의 깃발이 올라가는 장면이 여기서 나옵니다
      e.runOff = this.rng() < MISTIME_RUN;
    }
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
    if (p > 52) ty += (CY - e.y) * 0.06;
    // 공격 루트: 측면이면 터치라인을 타고 내려가 컷백을 준비하고, 중앙이면 골문 앞으로 파고듭니다
    if (sh) {
      if (sh.route > 0.25 && p > 40) ty += e.y < CY ? -3.4 * sh.route : 3.4 * sh.route;
      if (sh.route < -0.25 && p > 55) ty += (CY - e.y) * 0.2;
    }
    // 깊은 측면에서는 안으로 접지 않고 엔드라인까지(컷백 각도)
    if (sh && p > 76 && Math.abs(e.y - CY) > 11 && sh.route > 0.15) ty = e.y + (e.y < CY ? -1.2 : 1.2);
    // 압박으로 뺏은 직후·역습 창에는 수비가 정리되기 전에 골문 쪽으로 더 밀고 들어갑니다
    const trans = Math.max(this.transitionBonus(this.sides[e.side]), this.counterBonus(this.sides[e.side]));
    const push = trans > 0.3 ? 4.5 * trans : 0;
    return { x: clamp(e.x + dir * (p > 68 ? 8 : p > 45 ? 5.5 : 4) + dir * push, 2, W - 2), y: clamp(ty, 3, H - 3) };
  }

  /* ───────────── 공 소유자의 판단 ───────────── */
  pressureOn(e) {
    const opp = this.sides[this.opposing[e.side]].players;
    let n = 0;
    for (const o of opp) if (o.onPitch && dist(o, e) < 6.5) n += 1;
    return n;
  }

  /* 압박으로 공을 뺏은 직후의 전환 가중치 — 높은 곳에서 뺏을수록, 뺏은 직후일수록 큽니다 */
  transitionBonus(side) {
    const press = Number(side.tactic.press) || 0;
    if (press <= 0.25) return 0;
    const lw = side.lastWin;
    if (!lw || lw.prog < 42) return 0;
    const age = this.t - lw.t;
    if (age < 0 || age > 38) return 0;
    return clamp(press, 0, 1) * (1 - age / 38) * (lw.prog > 55 ? 1 : 0.55);
  }

  /* 실점 위험의 뿌리 — 공을 잃은 팀이 얼마나 앞으로 나와 있었는가.
     높은 라인·전원 전진(총공세)일수록 잃은 자리 뒤에 공간이 크고, 그 공간으로 역습이 시작됩니다. */
  counterBonus(side) {
    const lw = side.lastWin;
    if (!lw) return 0;
    const age = this.t - lw.t;
    if (age < 0 || age > 18) return 0;
    if (lw.prog > 54) return 0;                 // 상대 진영에서 뺏은 공은 이미 골문 가까이 — 전환 보너스가 따로 있습니다
    const opp = this.sides[this.opposing[side.name]];
    let sum = 0, n = 0;
    for (const e of opp.players) {
      if (!e.onPitch || e.pos === 'GK') continue;
      sum += prog(e.x, opp.dir);                // 상대가 자기 골문에서 얼마나 멀리 나와 있는가
      n += 1;
    }
    if (!n) return 0;
    const commit = clamp((sum / n - 45) / 30, 0, 1.2);
    const support = clamp((lw.fwd ?? 3) / 4, 0.25, 1.3);
    return commit * support * (1 - age / 18);
  }

  thinkCarrier() {
    const ball = this.ball;
    if (ball.mode !== 'carry' || !ball.owner) return;
    const c = ball.owner;
    // 골키퍼가 공을 잡았으면 몸에 붙여 두지 않고 곧바로 배급합니다 (패스·골킥 전개)
    if (c.pos === 'GK' && c.holdT != null) {
      // 잡은 공을 한 틱 다듬고(자세·시야) 배급합니다 — 캐치→배급이 한 프레임에 튀지 않게
      if (c.holdUntil && this.t < c.holdUntil) return;
      c.holdT = null; c.holdUntil = 0;
      this.distributeFromGK(c);
      return;
    }
    c.decCd -= 1;
    if (c.decCd > 0) return;
    const gx = c.dir > 0 ? W : 0;
    const dGoal = Math.hypot(gx - c.x, CY - c.y);
    const pressure = this.pressureOn(c);
    const side = this.sides[c.side];
    const sh = side._shape || this.computeShape(side, true);

    const behind = this.behindLine(c);
    // 압박 탈취 직후의 전환 창 — 게겐프레싱의 실제 이득은 '뺏은 자리에서 바로 때리는 것'입니다
    const trans = Math.max(this.transitionBonus(side), this.counterBonus(side));
    const mentNow = Number(side.tactic.mentality) || 0;
    const shootRange = 30 + Math.max(0, mentNow) * 6;      // 총공세는 조금 더 멀리서도 문을 봅니다
    if (c.pos !== 'GK' && (dGoal < shootRange || (behind > 0.5 && dGoal < 38))) {
      const angle = 1 - Math.abs(c.y - CY) / H;
      const tune = this.tuneOf(c);
      let urge = clamp((26 - dGoal) / 23, 0, 1) * 1.02 * (this.eff(c, 'sho') / 70) * angle;
      if (behind > 0.5) urge = Math.max(urge, 0.3) * 1.25;     // 라인 뒤 1대1 — 망설이지 않고 때립니다
      if (trans > 0) urge = Math.max(urge, 0.16) * (1 + trans * 1.4);   // 압박으로 뺏은 직후
      if (side.tactic.route < -0.4) urge *= 1.2;
      // 측면 루트 — 터치라인까지 내려간 뒤 좁은 각에서도 과감하게 때립니다 (컷백·니어포스트 슈팅)
      if (side.tactic.route > 0.3 && Math.abs(c.y - CY) > 11) urge *= 1.45;
      urge *= tune.shoot;                                    // 포처·인사이드 포워드는 더 자주, 홀딩·풀백은 더 아깝게
      urge *= 1 + Math.max(-0.55, Number(side.tactic.mentality) || 0) * 0.42;  // 잠그기는 아껴 쏘고 총공세는 쏟아냅니다
      urge *= 1 - Math.min(pressure, 3) * 0.14;
      // 상대가 압박을 걸지 않으면 슈터에게 시간이 생깁니다 — 한 번 더 보고 때립니다
      urge *= 1 + Math.max(0, -(Number(this.sides[this.opposing[c.side]].tactic.press) || 0)) * 0.22;
      // 우리 팀 압박 성향도 슈팅 태도에 반영됩니다 — 압박 팀은 전방에서 계속 때리고, 대기 팀은 아낍니다
      urge *= 1 + (Number(side.tactic.press) || 0) * 0.14;
      if (this.rng() < clamp(urge, 0.01, 0.72)) {
        if (trans > 0.3) side.stats.transShots += 1;
        return this.shoot(c, dGoal, pressure);
      }
    }

    // 빈 공간 드리블 — 앞이 비어 있으면 패스 대신 직접 치고 달립니다
    const open = this.openAhead(c);
    const tune = this.tuneOf(c);
    let urge = clamp((open - 4.0) / 14, 0, 1) * (0.52 - Math.min(pressure, 3) * 0.1);
    if (sh.route > 0.2 && Math.abs(c.y - CY) > 12) urge += 0.14;      // 측면 돌파 준비
    if (sh.pass > 0.35) urge -= 0.10;                                  // 롱볼 팀은 빨리 넘깁니다
    if (this.roleOf(c) === 'holding' || this.roleOf(c) === 'playmaker') urge -= 0.08;   // 볼을 돌리는 역할
    if (this.roleOf(c) === 'inside' || this.roleOf(c) === 'winger') urge += 0.06;       // 측면 공격수는 직접 치고 나감
    urge = clamp(urge, 0, 0.7);
    if (open > 5.6 && this.rng() < urge) {
      side.stats.dribbleTicks += 1;
      // 중계는 가끔만 — 매번 알리면 시끄럽습니다
      if (this.t - (this.lastCarrySay ?? -99) > 12 && this.rng() < 0.35) {
        this.lastCarrySay = this.t;
        this.say('dribble', c.side, { p: c.name }, 'carry');
      }
      c.decCd = rint(this.rng, 2, 3);
      return;
    }

    const best = this.bestPass(c, pressure, sh);
    if (best) {
      let passP = clamp(0.5 + pressure * 0.08 + best.score * 0.06, 0.15, 0.96);
      if (best.score < 0.6) passP *= 0.5;
      if (this.rng() < passP) return this.passTo(c, best.mate, best.kind);
    }
    c.decCd = rint(this.rng, 1, 2);
  }

  /* 공 앞쪽 통로가 얼마나 비었는가 — 가장 가까운 상대까지의 거리(u) */
  openAhead(c) {
    const opp = this.sides[this.opposing[c.side]].players;
    let m = 22;
    for (const k of [3, 6, 9, 12]) {
      const x = clamp(c.x + c.dir * k, 1, W - 1);
      const y = clamp(c.y + (CY - c.y) * (k / 16), 2, H - 2);
      for (const o of opp) {
        if (!o.onPitch) continue;
        const d = Math.hypot(o.x - x, o.y - y);
        if (d < m) m = d;
      }
    }
    return m;
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
    if (!rec) {
      // 짧게 풀어나가는 빌드업 — 가장 가까운 선수가 아니라 '가장 열린' 선수를 찾습니다
      const opp = this.sides[this.opposing[gk.side]].players.filter((o) => o.onPitch);
      const open = (m) => opp.reduce((mn, o) => Math.min(mn, dist(o, m)), 99);
      rec = mates.filter((e) => dist(e, gk) < 32).sort((a, b) => open(b) - open(a))[0] || null;
    }
    if (!rec) rec = mates.slice().sort((a, b) => dist(a, gk) - dist(b, gk))[0];
    if (!rec) return false;
    gk.decCd = 1;
    this.passTo(gk, rec, false);
    return true;
  }

  bestPass(c, pressure, sh) {
    const side = this.sides[c.side];
    const opp = this.sides[this.opposing[c.side]].players.filter((e) => e.onPitch);
    const style = side.tactic.pass || 0;
    const route = side.tactic.route || 0;
    const ment = Number(side.tactic.mentality) || 0;
    const tune = this.tuneOf(c);          // 패서의 역할 — 크로스·스루패스·안전 패스 성향
    const trans = Math.max(this.transitionBonus(side), this.counterBonus(side));   // 압박 탈취 직후에는 앞으로 찌릅니다
    const ballP = prog(c.x, c.dir);
    const offLine = this.offsideLineDepth(c.side);
    // 가끔은 라인을 확인하지 못하고 패스합니다 — 오프사이드가 나오는 지점입니다.
    // 한 번 걸린 팀은 잠시(약 4~5분) 라인을 확인하므로 같은 실수가 연달아 나지 않습니다.
    const blind = (this.t > (this.offsideCd[c.side] || 0)) && this.rng() < 0.22;
    let best = null;
    for (const m of side.players) {
      if (!m.onPitch || m === c || m.pos === 'GK') continue;
      const dx = m.x - c.x, dy = m.y - c.y;
      const d = Math.hypot(dx, dy);
      if (d < 4 || d > 68) continue;
      const forward = (dx * c.dir) / Math.max(d, 0.001);
      const lateral = Math.abs(dy);
      // 패스 길목 위험도
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
      const mProg = prog(m.x, c.dir);
      const inFinal = mProg > 62;
      const inBox = mProg > 78 && Math.abs(m.y - CY) < 15;

      let score = forward * 1.55 - d * 0.012 - risk * 1.7 + Math.min(open, 12) * 0.12;
      // 전진한 만큼 점수를 줍니다 — 예전에는 옆으로 보내면 0점이라 '가장 열린 반대편 윙어'로만
      // 공이 왕복했습니다. 뒤로 가는 패스는 조금 감점, 앞으로 나아가는 패스는 보상합니다.
      score += clamp(mProg - ballP, -12, 14) * 0.05;
      score += (m.pos === 'FW' ? 0.15 : 0) + (m.pos === 'MF' ? 0.08 : 0);
      // 오프사이드 위치의 동료는 후보에서 뺍니다 — 라인을 보는 패서는 그 선수를 쓰지 않습니다.
      // (가끔 라인을 놓친 패스만 실제 오프사이드로 이어집니다)
      if (!blind && offLine != null && mProg > 50 && mProg > prog(c.x, c.dir) + 0.4 && mProg > offLine + 1.0) continue;
      score += this.rng() * 0.7;
      if (open < 4) score -= 0.28;                // 수비에게 붙어 있는 동료로는 좀처럼 주지 않습니다
      if (style < 0) score += clamp(28 - d, -24, 14) * 0.028;
      if (style > 0) score += clamp(d - 26, -20, 30) * 0.022;
      if (inBox) score += 0.6;
      if (forward < -0.2) score -= 0.7;

      let kind = 'pass';
      // ── 사이드 전환: 한쪽에 압박이 몰렸을 때 반대쪽 넓은 공간으로 길게 ──
      // 짧은 패스 축은 '압박을 벗어나는 전환'으로만 씁니다
      const canSwitch = style >= -0.05 || pressure >= 1;
      // 방금 전환해 온 쪽으로 곧바로 되돌리는 패스는 금지 — 좌우 핑퐁 루프의 직접 원인입니다
      const reverse = this.lastSwitchFrom != null && this.t - this.lastSwitchT <= 10
        && Math.abs(m.y - this.lastSwitchFrom) < 12;
      if (canSwitch && !reverse && d >= 28 && lateral >= 20 && open > 6.5 && (c.y - CY) * (m.y - CY) < 0 && Math.abs(c.y - CY) > 8) {
        score += 0.18 + pressure * 0.16 + Math.max(0, style) * 0.12 + Math.max(0, route) * 0.12;
        kind = 'switch';
      }
      // ── 선행 스루패스: 달려드는 동료의 앞 공간으로 찔러 넣기 ──
      if (m.runT > 0 && forward > 0.5 && d > 9 && d < 44) {
        score += 0.4 + (route < 0.3 ? 0.16 : 0) + Math.max(0, -style) * 0.1;
        if (kind === 'pass') kind = 'through';
      } else if (forward > 0.72 && mProg > 62 && open > 7 && d > 16 && d < 42) {
        score += 0.14;
        if (kind === 'pass' && this.rng() < 0.35) kind = 'through';
      }
      // ── 원투: 방금 패스한 선수가 앞으로 빠져나갔을 때 리턴 ──
      if (m.ggT > this.t && forward > -0.75 && d < 28) {
        score += 0.8;
        kind = 'givego';
      }
      // ── 컷백: 터치라인 깊은 곳에서 박스 안쪽으로 낮게 ──
      if (ballP > 75 && Math.abs(c.y - CY) > 10 && lateral > 4 && mProg > 66 && mProg < 93 && Math.abs(m.y - CY) < 16) {
        score += 0.7 + Math.max(0, route) * 0.16 + Math.max(0, tune.cross) * 0.8;
        kind = 'cutback';
      }
      // ── 크로스: 측면에서 문전의 머리/발 앞으로 (윙어·오버래핑 윙어는 루트 설정과 상관없이 올립니다) ──
      if (kind === 'pass' && (route > 0.15 || tune.cross > 0.15) && ballP > 50 && Math.abs(c.y - CY) > 9
        && mProg > 70 && Math.abs(m.y - CY) < 15 && Math.abs(m.y - CY) < Math.abs(c.y - CY)) {
        score += 0.62 + Math.max(0, route) * 0.42 + tune.cross + this.tuneOf(m).crossRecv;
        kind = 'cross';
      }
      // 역할별 패스 선택 — 플레이메이커의 킬패스, 홀딩의 안전한 순환, 측면 공격수의 크로스
      if (kind === 'through') score += tune.through;
      if (kind === 'cross') score += Math.max(0, tune.cross);
      // 타깃맨은 등지고 버티는 자리로 들어오는 발밑 패스를 선호합니다
      if (this.roleOf(m) === 'target' && forward > 0.25 && d < 26) score += 0.16;
      // 팀 성향 — 앞으로 가는 패스에 가중(공격적·총공세) / 위험한 패스는 회피(잠그기·수비적)
      score += ment * Math.max(0, forward) * 0.26;
      if (trans > 0) score += trans * Math.max(0, forward) * 0.8;
      if (trans > 0.3 && kind === 'through') score += trans * 0.22;
      if (ment < 0) {
        score -= risk * -ment * 0.5;
        // 잠그기는 수비 뒤에서 공을 뺏은 뒤 앞선으로 길게 넘기는 역습을 노립니다
        if (m.pos === 'FW' && forward > 0.6 && d > 24) score += -ment * 0.24;
      }

      if (inFinal && Math.abs(m.y - CY) > 14 && route > 0.3) score += 0.35;
      if (inFinal && Math.abs(m.y - CY) < 14 && route < -0.3) score += 0.3;
      // 짧은 패스 축은 자르고, 롱볼 축은 멀리 보내는 쪽을 돌립니다
      if (style < 0) {
        // 짧은 패스 축: 앞으로 길게 차는 패스를 특히 꺼립니다. 옆으로 넓히는 전환은 상대 압박을 벗어나는 수단이라 덜 감점
        const fwdW = 0.35 + Math.max(0, forward) * 0.9;
        score -= Math.max(0, d - 18) * 0.05 * fwdW;
        score += Math.min(8, Math.max(0, 18 - d)) * 0.03;  // 가까운 동료에게 주는 쪽
      }
      if (style > 0.2 && d > 32) score += 0.16;

      const cand = { mate: m, score, kind };
      if (!best || cand.score > best.score) best = cand;
    }
    if (!best || best.score < 0.15) return null;
    return best;
  }

  passTo(c, m, kind = 'pass', opts = {}) {
    const dir = c.dir;
    const k = typeof kind === 'boolean' ? (kind ? 'cross' : 'pass') : (kind || 'pass');
    // 사이드 전환을 기억해 두었다가, 곧바로 같은 쪽으로 되돌리는 전환을 막습니다
    if (k === 'switch') { this.lastSwitchT = this.t; this.lastSwitchFrom = c.y; }
    const ball = this.ball;
    this.clearDives();
    // 오프사이드는 '전진 패스·스루패스가 떠나는 순간'의 위치로 정해집니다.
    // (크로스·컷백·사이드 전환과 세트피스 골킥은 제외 — 골킥은 opts.safe)
    ball.offside = null;
    if (!opts.safe && (k === 'pass' || k === 'through')) {
      const off = this.offsideSpot(c, m);
      if (off) ball.offside = off;
    }
    // 스루패스는 발밑이 아니라 앞 공간으로 — 받는 선수가 달려가 잡습니다
    let to = { x: m.x, y: m.y };
    if (k === 'through') {
      // 받는 선수가 달려가 닿을 수 있는 거리로만 앞에 놓습니다
      const lead = clamp(3 + dist(c, m) * 0.14, 3, 9);
      to = { x: clamp(m.x + dir * lead, 2, W - 2), y: clamp(m.y + (CY - m.y) * 0.15, 3, H - 3) };
    }
    const d = Math.hypot(to.x - c.x, to.y - c.y);
    ball.mode = 'pass';
    ball.from = { x: c.x, y: c.y };
    ball.to = to;
    ball.t = 0;
    ball.kind = k;
    ball.lead = k === 'through';
    // dur = 날아가는 틱 수(정수). 짧은 패스 1틱, 긴 패스·전환 2~3틱
    ball.dur = clamp(Math.round(1 + d / 42), 1, k === 'switch' ? 3 : 2);
    ball.passer = c;
    ball.receiver = m;
    ball.cross = k === 'cross';
    ball.press = this.pressureOn(c);       // 패스할 때 받은 압박 — 정확도에 반영됩니다
    ball.dist = d;
    ball.owner = null;
    ball.trail = [];
    c.decCd = rint(this.rng, 0, 1);
    // 원투: 리턴이면 연계가 끝나고, 아니면 패스한 선수가 전방으로 빠져 리턴을 기다립니다
    // (앞으로 찔러 준 패스는 원투가 아닙니다 — 옆·뒤로 내준 뒤 달려 들어가는 흐름만)
    const fwd = ((m.x - c.x) * dir) / Math.max(d, 1);
    if (k === 'givego') {
      c.ggT = -1;
    } else if (c.pos !== 'DF' && k === 'pass' && d < 22 && fwd < 0.45 && this.rng() < 0.55) {
      c.ggT = this.t + GIVE_GO_TICKS;
    }
    m.ggT = -1;
    c.st.passes += 1;
    if (k === 'cross') c.st.crosses = (c.st.crosses || 0) + 1;
    if (k === 'through') c.st.throughs = (c.st.throughs || 0) + 1;
    const st = this.sides[c.side].stats;
    st.passes += 1;
    st.passDist += d;
    st.passN += 1;
    if (d >= 30) st.longN += 1;
    if (k === 'switch') st.switchN += 1;
    if (k === 'through') st.throughN += 1;
    if (k === 'givego') st.givegoN += 1;
    if (k === 'cutback') st.cutbackN += 1;
    if (k === 'cross') st.crossN += 1;
    this.lastPass = { from: c, to: m, t: this.t, offside: !!ball.offside };
    // 중계: 전개 종류가 그대로 멘트에 드러납니다
    if (k === 'cross') this.say('cross', c.side, { p: c.name }, 'cross');
    else if (k === 'cutback') this.say('cutback', c.side, { p: c.name, p2: m.name }, 'cutback');
    else if (k === 'switch') { if (d >= 34 && this.rng() < 0.5) this.say('switch', c.side, { p: c.name, p2: m.name }, 'switch'); }
    else if (k === 'givego') { if (this.rng() < 0.7) this.say('givego', c.side, { p: c.name, p2: m.name }, 'givego'); }
    else if (k === 'through') { if (this.rng() < 0.5) this.say('through', c.side, { p: c.name }, 'through'); }
    else if (this.rng() < 0.1) this.say('build', c.side, { p: c.name }, 'build');
  }

  /* ───────────── 슈팅 ───────────── */
  /* 슈터와 골문 사이에 서 있는 수비수 수 — 내려앉은 블록은 몸으로 슈팅 각을 지웁니다.
     (예전에는 거리·각도·압박만 봤기 때문에, 문전에 10명이 늘어선 잠그기도 먼 거리에서
      한 명만 마크하는 총공세와 같은 확률로 슈팅을 내줬습니다) */
  blockersOn(c) {
    const opp = this.sides[this.opposing[c.side]].players;
    const p0 = prog(c.x, c.dir);
    const gx = c.dir > 0 ? W : 0;
    const dGoal = Math.hypot(gx - c.x, CY - c.y) || 1;
    let n = 0;
    for (const o of opp) {
      if (!o.onPitch || o.pos === 'GK') continue;
      const po = prog(o.x, c.dir);
      if (po <= p0 + 0.5) continue;                       // 슈터보다 뒤에 있으면 가리지 못합니다
      const t = clamp((po - p0) / dGoal, 0, 1);
      const laneY = c.y + (CY - c.y) * t;
      const half = 3.4 + (po - p0) * 0.2;                 // 거리가 멀수록 시야가 넓습니다
      if (Math.abs(o.y - laneY) <= half) n += 1;
    }
    return n;
  }
  /* 수비 라인 뒤에서 잡은 공인가 — 0(라인 앞) ~ 1.4(완전히 뒤, 골키퍼와 1대1) */
  behindLine(c) {
    const line = this.offsideLineDepth(c.side);
    if (line == null) return 0;
    const d = prog(c.x, c.dir) - line;
    if (d <= 0.6) return 0;
    return clamp(d / 10, 0, 1.4);
  }
  xgFor(c, dGoal, pressure) {
    const angle = 1 - Math.abs(c.y - CY) / 42;
    const base = 1.26 * Math.exp(-dGoal / 8.4) * clamp(angle, 0.12, 1);
    const skill = 0.72 + this.eff(c, 'sho') / 210;
    const press = 1 - Math.min(pressure, 3) * 0.11;
    // 수비 팀의 성향 — 내려앉은 블록은 몸이 더 두껍고, 전원 전진한 팀은 뒷공간이 열려 있습니다
    const defMent = Number(this.sides[this.opposing[c.side]].tactic.mentality) || 0;
    // 내려앉을수록 문전에 몸이 많아 슈팅이 막히고, 전원 전진하면 뒤가 열립니다
    const blockFloor = clamp(0.34 - Math.max(0, -defMent) * 0.2, 0.15, 0.4);
    const block = clamp(1 - this.blockersOn(c) * 0.09 * (1 - defMent * 0.55), blockFloor, 1);   // 몸으로 막힌 슈팅
    const behind = 1 + this.behindLine(c) * 0.6 * (1 + Math.max(0, defMent) * 0.25);            // 라인 뒤 1대1
    // 공격 팀의 성향 — 가담 인원이 많으면 문전에 동료가 있어 마무리 각이 살고, 내려앉으면 고립됩니다
    const attMent = Number(this.sides[c.side].tactic.mentality) || 0;
    const support = 1 + attMent * 0.13;
    // 수비 팀의 성향 — 전원 전진(총공세)하면 뒷공간이 열려 상대 슈팅의 값이 올라가고,
    // 내려앉으면(잠그기) 문전이 빽빽해 슈팅 값이 내려갑니다
    const defPress = Number(this.sides[this.opposing[c.side]].tactic.press) || 0;
    const space = 1 + Math.max(0, defMent) * 0.34 - Math.max(0, -defMent) * 0.1
      + Math.max(0, -defPress) * 0.12;
    return clamp(base * skill * press * block * behind * support * space, 0.02, 0.85);
  }

  shoot(c, dGoal, pressure, header = false) {
    const side = this.sides[c.side];
    const gx = c.dir > 0 ? W : 0;
    const xg = this.xgFor(c, dGoal, pressure) * (header ? 0.62 : 1);
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
    ball.offside = null;
    ball.mode = 'shot';
    ball.kind = 'shot';
    ball.lead = false;
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
    if (header) side.stats.headerShots += 1;
    if (this.behindLine(c) > 0.5) side.stats.behindShots += 1;
    side.stats.blockSum = (side.stats.blockSum || 0) + this.blockersOn(c);
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
        if (owner.pos === 'GK') { owner.holdT = this.t; owner.holdUntil = this.t + 1; }  // 한 틱 다듬고 배급
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
    // 오프사이드로 판정된 패스에서 골이 이어지면 안 됩니다 (구조상 불가능 — 회귀 감시용 계수)
    if (this.lastPass && this.lastPass.offside && this.lastPass.to === c) this.offsideGoals += 1;
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
      if (b.mode === 'pass' && b.receiver && b.receiver.onPitch && !b.lead) {
        b.to.x = b.receiver.x; b.to.y = b.receiver.y;
      }
      b.x = b.from.x + (b.to.x - b.from.x) * p;
      b.y = b.from.y + (b.to.y - b.from.y) * p;
      if (b.mode === 'net') return;
      b.trail.push({ x: b.x, y: b.y });
      if (b.trail.length > 26) b.trail.shift();
      if (b.mode === 'pass') {
        const opps = this.sides[this.opposing[b.passer.side]].players.filter((e) => e.onPitch && e.pos !== 'GK');
        for (const o of opps) {
          const d = Math.hypot(o.x - b.x, o.y - b.y);
          // 공이 지나가는 길목의 수비수가 끊을 수 있습니다
          // (비행이 여러 틱으로 늘었으니 틱당 확률을 dur 로 나눠 전체 차단 확률은 그대로)
          const cut = 1 - Math.max(0, -(Number(this.sides[b.passer.side].tactic.pass) || 0)) * 0.32;
          if (d < 1.9 && this.rng() < (0.07 + this.eff(o, 'def') / 1000) * STEP_K / Math.max(1, b.dur) * cut) {
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
        this.noteWin(best);                     // 흐른 공을 주워 possession 을 되찾은 것도 '탈취'입니다
        if (best.pos === 'GK') { best.holdT = this.t; best.holdUntil = this.t + 1; }
      }
    }
  }

  /* 패스가 리시버에게 실제로 닿은 순간의 처리 */
  resolvePass() {
    const b = this.ball;
    const rec = b.receiver;
    const passer = b.passer;
    const kind = b.kind || 'pass';
    const at = { x: b.x, y: b.y };
    // 패스가 떠날 때 오프사이드 위치였고, 그 공이 동료에게 닿았다 — 깃발이 올라갑니다
    if (b.offside) {
      const info = b.offside;
      b.offside = null;
      b.mode = 'loose';
      b.owner = null;
      this.callOffside(info, rec);
      return;
    }
    b.offside = null;
    b.mode = 'loose';
    b.owner = null;
    if (!rec || !rec.onPitch) return;
    const opps = this.sides[this.opposing[rec.side]].players.filter((e) => e.onPitch && e.pos !== 'GK');

    // 패스 정확도 — 길게 차는 패스일수록, 압박받을수록 발밑에 정확히 닿지 않습니다.
    // (예전에는 어떤 패스든 리시버 발밑에 정확히 도착해서 롱볼도 점유율이 떨어지지 않았고,
    //  게겐프레싱으로 압박해도 상대 패스가 흔들리지 않아 압박의 이득이 없었습니다)
    if (kind !== 'cross' && kind !== 'cutback') {
      const dd = b.dist || Math.hypot(at.x - (b.from?.x ?? at.x), at.y - (b.from?.y ?? at.y));
      const pressN = b.press || 0;
      const pas = passer ? this.eff(passer, 'pas') : 62;
      // 위험을 감수하는 축(롱볼)은 실수가 늘고, 안전을 택한 축(짧은 패스)은 줄어듭니다
      const style = Number(this.sides[rec.side].tactic.pass) || 0;
      const risk = 1 + Math.max(0, style) * 0.7 - Math.max(0, -style) * 0.4;
      const errP = clamp(((dd > 22 ? (dd - 22) * 0.014 : 0) + pressN * 0.06 + (60 - pas) * 0.005) * risk, 0, 0.5);
      if (this.rng() < errP) {
        const st2 = this.sides[rec.side].stats;
        st2.passBad = (st2.passBad || 0) + 1;
        b.mode = 'loose';
        b.vx = 0; b.vy = 0;
        let bx = at.x + (this.rng() - 0.5) * Math.min(12, 3 + dd * 0.18);
        let by = at.y + (this.rng() - 0.5) * Math.min(16, 4 + dd * 0.24);
        // 긴 공은 수비 라인이 떨어뜨립니다 — 떨어진 자리 가까운 수비수가 먼저 줍습니다
        if (dd > 28) {
          let near = null, nd = 1e9;
          for (const o of opps) { const d = Math.hypot(o.x - bx, o.y - by); if (d < nd) { nd = d; near = o; } }
          if (near && nd < 13) { bx += (near.x - bx) * 0.4; by += (near.y - by) * 0.4; }
        }
        b.x = clamp(bx, 2, W - 2);
        b.y = clamp(by, 3, H - 3);
        return;
      }
    }

    // 스루패스는 '공이 떨어진 지점'에서 승부가 납니다 — 달려온 동료와 먼저 도착한 수비수의 경합
    if (kind === 'through') {
      const dr = Math.hypot(rec.x - at.x, rec.y - at.y);
      let thief = null, td = 1e9;
      for (const o of opps) {
        const d = Math.hypot(o.x - at.x, o.y - at.y);
        if (d < td) { td = d; thief = o; }
      }
      if (thief && td < Math.min(dr, 3.2) + 0.2) { this.intercept(thief, passer); return; }
      if (dr <= 6.5) {
        b.owner = rec; b.mode = 'carry';
        b.x = rec.x + rec.dir * 0.9; b.y = rec.y;
        if (passer) { passer.st.passOk += 1; this.sides[passer.side].stats.passOk += 1; }
        rec.decCd = 0;
        if (rec.pos !== 'GK' && prog(rec.x, rec.dir) > 80 && Math.abs(rec.y - CY) < 14 && this.pressureOn(rec) < 2.6 && this.rng() < 0.6) {
          this.shoot(rec, Math.hypot((rec.dir > 0 ? W : 0) - rec.x, CY - rec.y), this.pressureOn(rec));
        }
        return;
      }
      // 동료가 닿지 못했습니다 — 공이 굴러가고 가장 가까운 선수가 줍습니다
      b.mode = 'loose';
      b.vx = (at.x < W / 2 ? 1 : -1) * rec.dir * 0.5;
      b.vy = 0;
      return;
    }

    // 긴 공의 공중볼 — 롱볼은 앞선이 수비수와 붙어 버티는 경합입니다. 붙어 있으면 수비가 이깁니다.
    // (예전에는 롱볼도 짧은 패스와 똑같이 리시버 발밑에 붙어, 점유율이 거의 떨어지지 않았습니다)
    const dd2 = b.dist || Math.hypot(at.x - (b.from?.x ?? at.x), at.y - (b.from?.y ?? at.y));
    if (dd2 > 26) {
      const guard = opps.filter((o) => dist(o, rec) < 7).sort((a, c2) => dist(a, rec) - dist(c2, rec))[0];
      if (guard) {
        const air = this.eff(guard, 'def') * 0.6 + this.eff(guard, 'spd') * 0.2;
        const hold = this.eff(rec, 'sho') * 0.22 + this.eff(rec, 'dri') * 0.2 + (rec.p.stats.sta || 60) * 0.5;
        const p = clamp((air / (air + hold)) * 1.0, 0.24, 0.82);
        if (this.rng() < p) {
          b.cross = false; b.kind = 'pass';
          b.owner = guard; b.mode = 'carry';
          b.x = guard.x + guard.dir * 0.8; b.y = guard.y;
          guard.decCd = 1; guard.st.tackles += 1; guard.rd += 0.04;
          this.sides[guard.side].stats.tackles += 1;
          if (passer) passer.st.passOk += 1;
          return;
        }
      }
    }

    const near = opps.filter((o) => dist(o, rec) < 3.2).sort((a, c2) => dist(a, rec) - dist(c2, rec))[0];
    if (near && this.rng() < 0.13 + this.eff(near, 'def') / 950) {
      if (passer) passer.st.passOk += 1;
      if ((b.cross || kind === 'cutback') && this.rng() < 0.30) {
        const spot = this.cornerSpot(rec.side);
        this.setPiece('corner', rec.side, spot.x, spot.y);
        return;
      }
      this.intercept(near, passer);
      return;
    }
    // 크로스·컷백은 수비가 걷어내는 경우가 있습니다 (컷백은 낮고 빨라 걷어내기 어렵습니다)
    const clearP = kind === 'cross' ? 0.19 : kind === 'cutback' ? 0.12 : 0;
    if (clearP && this.rng() < clearP) {
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
    if (rec.pos === 'GK') { rec.holdT = this.t; rec.holdUntil = this.t + 1; }   // 키퍼가 받으면 한 틱 뒤 배급
    if (passer) { passer.st.passOk += 1; this.sides[passer.side].stats.passOk += 1; }
    rec.decCd = 0;
    if (rec.pos !== 'GK' && prog(rec.x, rec.dir) > 81 && Math.abs(rec.y - CY) < 13) {
      const pr = this.pressureOn(rec);
      const dG = Math.hypot((rec.dir > 0 ? W : 0) - rec.x, CY - rec.y);
      if (pr < 2.6 && this.rng() < (b.cross || kind === 'cutback' ? 0.5 : 0.66)) { this.shoot(rec, dG, pr); return; }
    }
    if ((b.cross || kind === 'cutback') && Math.abs(rec.y - CY) < 13 && prog(rec.x, rec.dir) > 70 && (rec.pos === 'FW' || rec.pos === 'MF')) {
      const dGoal = Math.hypot((rec.dir > 0 ? W : 0) - rec.x, CY - rec.y);
      // 타깃맨은 머리로 때리는 확률이 더 높습니다
      const routeUp = Math.max(0, Number(this.sides[rec.side].tactic.route) || 0);
      const headerP = kind === 'cutback' ? 0.46 : 0.36 + routeUp * 0.12 + (this.roleOf(rec) === 'target' ? 0.16 : 0);
      if (this.rng() < headerP) { this.shoot(rec, dGoal, this.pressureOn(rec), true); return; }
    }
    b.cross = false;
    b.kind = 'pass';
  }

  /* 공을 뺏은 순간을 기록합니다 — 압박 팀은 이 지점에서 곧바로 공격을 시작합니다 */
  noteWin(defender) {
    const side = this.sides[defender.side];
    // 탈취 순간 우리 진영에 몇 명이 올라가 있었는가 — 역습의 '호위'가 됩니다.
    // (내려앉아 싸우는 팀은 뺏어도 앞에 동료가 없어 역습이 외롭고, 압박·총공세 팀은 여러 명이 함께 나갑니다)
    const fwd = side.players.filter((e) => e.onPitch && e.pos !== 'GK' && prog(e.x, defender.dir) > 48).length;
    side.lastWin = { t: this.t, prog: prog(defender.x, defender.dir), fwd };
    side.stats.winN += 1;
    const wp = prog(defender.x, defender.dir);
    side.stats.winSum += wp;
    if (wp > 55) side.stats.winHigh = (side.stats.winHigh || 0) + 1;
  }

  intercept(defender, passer) {
    const b = this.ball;
    this.noteWin(defender);
    b.owner = defender;
    b.mode = 'carry';
    b.x = defender.x; b.y = defender.y;
    b.cross = false;
    b.offside = null;      // 수비수가 먼저 손댔습니다 — 오프사이드가 풀립니다
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
      if (dist(d, c) > 3.4) continue;
      d.tackleCd -= 1;
      if (d.tackleCd > 0) continue;
      d.tackleCd = rint(this.rng, 1, 3) / STEP_K;
      const def = this.eff(d, 'def') + this.eff(d, 'spd') * 0.25;
      const dri = this.eff(c, 'dri') * 0.8 + this.eff(c, 'spd') * 0.45 + this.eff(c, 'vis') * 0.1;
      // 압박을 걸고 있으면 달려든 선수의 태클이 더 세게 들어갑니다 (게겐프레싱의 실제 이득)
      const pressUp = 1 + Math.max(0, Number(this.sides[d.side].tactic.press) || 0) * 0.45;
      const p = clamp((def / (def + dri)) * 0.42 * pressUp, 0.05, 0.5);
      if (this.rng() < p) {
        if (this.rng() < 0.7) { this.commitFoul(d, c); return; }
        this.noteWin(d);
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
      if (this.rng() < 0.17 * STEP_K) { this.commitFoul(d, c); return; }
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
    const reckless = this.rng() < (defender.st.yellow > 0 ? 0.05 : 0.24);
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

  setPiece(type, sideName, x, y, opts = {}) {
    if (this.done) return;
    const side = this.sides[sideName];
    if (!side) return;
    this.lastSetPieceT = this.t;
    // 코너·문전 프리킥을 차면 공격팀 수비수들이 상대 진영에 올라가 있습니다 — 찬 직후 복귀 구간을 기억합니다
    const dGoal0 = Math.hypot((side.dir > 0 ? W : 0) - x, CY - y);
    if (type === 'corner' || (type === 'freekick' && dGoal0 < 40)) this.recoverT[sideName] = this.t + 26;
    this.sp = { type, side: sideName, x: clamp(x, 1.5, W - 1.5), y: clamp(y, 1.2, H - 1.2), t: 0, spots: null, taker: null };
    this.phase = 'setpiece';
    this.pause = 0;
    this.clearDives();            // 세트피스에서는 키퍼가 바로 일어나 자리를 잡습니다
    this.ball.mode = 'set';
    this.ball.owner = null;
    this.ball.shot = null;
    this.ball.offside = null;
    this.ball.cross = false;
    this.ball.kind = 'pass';
    this.ball.lead = false;
    this.ball.receiver = null;
    this.ball.passer = null;
    this.ball.x = this.sp.x;
    this.ball.y = this.sp.y;
    this.ball.px = this.sp.x;
    this.ball.py = this.sp.y;
    this.ball.trail = [];
    // 통계
    if (type === 'corner') side.stats.corners += 1;
    if (type === 'freekick' && !opts.noStat) side.stats.freeKicks += 1;   // 오프사이드 재개는 프리킥 집계에서 뺍니다
    if (type === 'goalkick') side.stats.goalKicks += 1;
    this.sp.taker = this.pickTaker(type, side);
    this.arrangeSetPiece();
    // 자리로 모이기 — 예전처럼 한 프레임에 85u 튀지 않고 준비 틱에 걸쳐 미끄러지듯 이동합니다
    this.sp.snap = false;
    const warpN = Math.max(2, Math.min(4, SETUP_TICKS[type] || 2));
    for (const [e, spot] of this.sp.spots) this.warpTo(e, spot.x, spot.y, warpN);
    if (!opts.quiet) this.say(type, sideName, { p: this.sp.taker?.name || '', t: side.team.short }, type);
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
    const ment = Number(side.tactic.mentality) || 0;
    // 총공세에는 센터백도 문전으로 올라가고, 잠그기에는 공격수만 남습니다
    const weight = (e) => (e.pos === 'FW' ? 3 : e.pos === 'MF' ? (ment <= -0.75 ? 1.6 : 2) : (ment >= 0.75 ? 2.4 : ment <= -0.75 ? 0.4 : 1));
    const atk = side.players.filter((e) => e.onPitch && e !== sp.taker && e.pos !== 'GK')
      .sort((a, b) => weight(b) - weight(a));
    const def = opp.players.filter((e) => e.onPitch && e.pos !== 'GK');
    const gkAtk = side.players.find((e) => e.onPitch && e.pos === 'GK');
    const gkDef = opp.players.find((e) => e.onPitch && e.pos === 'GK');
    // 같은 자리에 둘 이상을 놓으면, 가까운 빈 자리로 조금씩 밀어내 겹침을 없앱니다
    // (경기장 가장자리에서는 x 가 고정되므로 원 모양으로 넓게 찾습니다)
    // 선수 도트 지름이 약 4u 라, 최소 3.4u 를 띄워야 화면에서 겹쳐 보이지 않습니다.
    const SP_GAP = 3.4;
    const free = (x, y) => {
      const cx0 = clamp(x, 1.5, W - 1.5), cy0 = clamp(y, 1.5, H - 1.5);
      const clear = (px, py) => !taken.some((q) => Math.hypot(q.x - px, q.y - py) < SP_GAP);
      if (clear(cx0, cy0)) { taken.push({ x: cx0, y: cy0 }); return { x: cx0, y: cy0 }; }
      let best = null, bestD = -1;
      for (let ring = 1.7; ring <= 28.9; ring += 1.7) {
        for (let k = 0; k < 16; k++) {
          const ang = (k / 16) * Math.PI * 2;
          const px = clamp(cx0 + Math.cos(ang) * ring, 1.5, W - 1.5);
          const py = clamp(cy0 + Math.sin(ang) * ring, 1.5, H - 1.5);
          let d = 99;
          for (const q of taken) d = Math.min(d, Math.hypot(q.x - px, q.y - py));
          if (d >= SP_GAP) { taken.push({ x: px, y: py }); return { x: px, y: py }; }
          if (d > bestD) { bestD = d; best = { x: px, y: py }; }
        }
        // 한 바퀴(16방향)를 다 돌았는데 이 반지름에서 빈 자리가 없으면 더 바깥 고리로 넘어갑니다
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
        // 원거리 프리킥 — 예전에는 전원이 공 뒤로 세로 한 줄(CY±9)이라 '기차'처럼 서 있었습니다.
        // 폭 22~30u(측면 루트면 더 넓게)의 지그재그 3열로 펼쳐 줄서기를 풉니다.
        const route = side.tactic.route || 0;
        const width = 22 + Math.max(0, route) * 8;
        atk.forEach((e, i) => {
          const col = i % 3;
          put(e, sp.x + dir * (8 + i * 7), clamp(CY + (col - 1) * (width / 2) + (e.ry || 0) * 0.2, 5, H - 5));
        });
        // 수비팀도 엇갈린 3열로 폭을 지키며 물러섭니다
        def.forEach((e, i) => {
          const col = (i + 1) % 3;
          put(e, sp.x + dir * (4 + i * 5.5), clamp(CY + (col - 1) * (26 / 2), 5, H - 5));
        });
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
      this.passTo(taker, target, false, { safe: true });   // 골킥은 오프사이드 예외
      this.ball.dur = clamp(Math.round(1 + dist(taker, target) / 40), 2, 3);   // 골킥은 길게 — 2~3틱
      return;
    }

    if (sp.type === 'corner') {
      const box = side.players
        .filter((e) => e.onPitch && e !== taker && e.pos !== 'GK')
        .sort((a, b) => this.eff(b, 'sho') + (b.pos === 'FW' ? 12 : 0) - this.eff(a, 'sho') - (a.pos === 'FW' ? 12 : 0));
      const short = this.rng() < 0.12 && box.length > 1;
      if (short) {
        this.passTo(taker, box[0], false, { safe: true });   // 코너킥은 오프사이드 예외
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
      this.ball.kind = 'cross';
      this.ball.lead = false;
      this.ball.owner = null;
      this.ball.trail = [{ x: taker.x, y: taker.y }];
      taker.st.passes += 1;
      side.stats.passes += 1;
      side.stats.crossN += 1;
      side.stats.passDist += dist(taker, rec);
      side.stats.passN += 1;
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
        this.ball.kind = 'cross';
        this.ball.lead = false;
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
        .filter((e) => e.onPitch && e.pos !== 'GK' && e.stamina < 52)
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
  /* 경기 중 역할 변경 — 자리에 붙은 역할을 바꿉니다 (선수는 그대로) */
  setRoleAt(e, role) {
    if (!e || !e.onPitch) return null;
    const label = e.label || e.slot?.label || e.pos;
    if (e.pos === 'GK' || label === 'GK') return null;
    e.role = roleFor(label, role);
    return e.role;
  }
  setFormation(fid) {
    const side = this.sides[this.userSide];
    if (!FORMATIONS[fid]) return;
    side.formation = fid;
    const slots = FORMATIONS[fid].slots;
    const outfield = side.players.filter((e) => e.onPitch && e.pos !== 'GK');
    const gk = side.players.find((e) => e.pos === 'GK' && e.onPitch);
    // 자리-선수 배정은 '포지션 적합도 우선'으로 전체를 봅니다 (자리 순서대로 남은 최고를 넣으면
    // 수비수가 ST로 밀려 들어갑니다)
    const pairs = [];
    outfield.forEach((e) => slots.forEach((slot, i) => {
      if (slot.pos === 'GK') return;
      pairs.push({ e, i, v: posFactor(slot.pos, e.p.pos) * 100 + e.p.ovr * 0.6 });
    }));
    pairs.sort((a, b) => b.v - a.v);
    const placed = new Array(slots.length).fill(null);
    const used = new Set();
    for (const { e, i } of pairs) {
      if (placed[i] || used.has(e)) continue;
      placed[i] = e; used.add(e);
    }
    // 두 자리 교환으로 개선
    for (let iter = 0; iter < 5; iter++) {
      let moved = false;
      for (let a = 0; a < slots.length; a += 1) {
        for (let b = a + 1; b < slots.length; b += 1) {
          const ea = placed[a], eb = placed[b];
          if (!ea || !eb) continue;
          const now = posFactor(slots[a].pos, ea.p.pos) + posFactor(slots[b].pos, eb.p.pos);
          const sw = posFactor(slots[a].pos, eb.p.pos) + posFactor(slots[b].pos, ea.p.pos);
          if (sw > now + 0.001) { placed[a] = eb; placed[b] = ea; moved = true; }
        }
      }
      if (!moved) break;
    }
    slots.forEach((slot, i) => {
      if (slot.pos === 'GK') { if (gk) { gk.slot = slot; gk.factor = posFactor('GK', gk.p.pos); } return; }
      const e = placed[i];
      if (e) { e.slot = slot; e.pos = slot.pos; e.label = slot.label; e.role = roleFor(slot.label, e.role); e.factor = posFactor(slot.pos, e.p.pos); }
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
    inn.slot = slot; inn.pos = slot.pos; inn.label = out.label; inn.role = out.role;
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
      // 전개 패턴 — 화면 밖 점검(selftest·patterns)과 전술 체감 비교에 그대로 씁니다
      patterns: {
        switch: { home: h.switchN, away: a.switchN },
        through: { home: h.throughN, away: a.throughN },
        givego: { home: h.givegoN, away: a.givegoN },
        cutback: { home: h.cutbackN, away: a.cutbackN },
        cross: { home: h.crossN, away: a.crossN },
        long: { home: h.longN, away: a.longN },
      },
      passLen: { home: h.passN ? h.passDist / h.passN : 0, away: a.passN ? a.passDist / a.passN : 0 },
      width: { home: h.widthN ? h.widthSum / h.widthN : 0, away: a.widthN ? a.widthSum / a.widthN : 0 },
      depth: { home: h.depthN ? h.depthSum / h.depthN : 0, away: a.depthN ? a.depthSum / a.depthN : 0 },
      dribble: { home: h.dribbleTicks, away: a.dribbleTicks },
      wideShare: {
        home: h.possTicks ? Math.round((h.wideTicks || 0) / h.possTicks * 100) : 0,
        away: a.possTicks ? Math.round((a.wideTicks || 0) / a.possTicks * 100) : 0,
      },
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
      offsides: { home: h.offsides || 0, away: a.offsides || 0 },
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
  // 출전 정지·부상 선수는 뛸 수 있는 선수로 바꿉니다.
  // 후보가 모자라면 선수단 전체에서, 그것도 없으면 그대로 둡니다(경기는 11명으로 시작해야 합니다).
  const used = new Set(base.starters.filter(Boolean));
  const pool = [
    ...(base.bench || []).filter((id) => !bad(id) && !used.has(id)),
    ...squadOf(world, teamId).filter((p) => available(world, p) && !used.has(p.id)).map((p) => p.id),
  ];
  const starters = base.starters.map((id) => (id && !bad(id) ? id : pool.shift() || id));
  const bench = (base.bench || []).filter((id) => !starters.includes(id));
  return { ...base, starters, bench };
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
