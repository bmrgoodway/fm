// 구단·선수·포메이션 데이터. 모든 수치는 이 파일에서 만듭니다.
import { makeRng, rint, pick, clamp, gauss, shuffle } from './rng.js';

/* ─────────────────────────── 포메이션 ───────────────────────────
   x: 0(우리 골문) ~ 1(상대 골문), y: 0(왼쪽) ~ 1(오른쪽) */
export const FORMATIONS = {
  '4-3-3': {
    name: '4-3-3', shape: '공격적 균형',
    slots: [
      { pos: 'GK', label: 'GK', x: 0.05, y: 0.50 },
      { pos: 'DF', label: 'LB', x: 0.21, y: 0.14 }, { pos: 'DF', label: 'CB', x: 0.18, y: 0.37 },
      { pos: 'DF', label: 'CB', x: 0.18, y: 0.63 }, { pos: 'DF', label: 'RB', x: 0.21, y: 0.86 },
      { pos: 'MF', label: 'CM', x: 0.42, y: 0.28 }, { pos: 'MF', label: 'CM', x: 0.38, y: 0.50 },
      { pos: 'MF', label: 'CM', x: 0.42, y: 0.72 },
      { pos: 'FW', label: 'LW', x: 0.69, y: 0.15 }, { pos: 'FW', label: 'ST', x: 0.74, y: 0.50 },
      { pos: 'FW', label: 'RW', x: 0.69, y: 0.85 },
    ],
  },
  '4-4-2': {
    name: '4-4-2', shape: '클래식 밸런스',
    slots: [
      { pos: 'GK', label: 'GK', x: 0.05, y: 0.50 },
      { pos: 'DF', label: 'LB', x: 0.20, y: 0.13 }, { pos: 'DF', label: 'CB', x: 0.17, y: 0.37 },
      { pos: 'DF', label: 'CB', x: 0.17, y: 0.63 }, { pos: 'DF', label: 'RB', x: 0.20, y: 0.87 },
      { pos: 'MF', label: 'LM', x: 0.45, y: 0.11 }, { pos: 'MF', label: 'CM', x: 0.41, y: 0.38 },
      { pos: 'MF', label: 'CM', x: 0.41, y: 0.62 }, { pos: 'MF', label: 'RM', x: 0.45, y: 0.89 },
      { pos: 'FW', label: 'ST', x: 0.71, y: 0.38 }, { pos: 'FW', label: 'ST', x: 0.71, y: 0.62 },
    ],
  },
  '3-5-2': {
    name: '3-5-2', shape: '중원 장악',
    slots: [
      { pos: 'GK', label: 'GK', x: 0.05, y: 0.50 },
      { pos: 'DF', label: 'CB', x: 0.18, y: 0.26 }, { pos: 'DF', label: 'CB', x: 0.16, y: 0.50 },
      { pos: 'DF', label: 'CB', x: 0.18, y: 0.74 },
      { pos: 'MF', label: 'LWB', x: 0.44, y: 0.08 }, { pos: 'MF', label: 'CM', x: 0.39, y: 0.31 },
      { pos: 'MF', label: 'CM', x: 0.36, y: 0.50 }, { pos: 'MF', label: 'CM', x: 0.39, y: 0.69 },
      { pos: 'MF', label: 'RWB', x: 0.44, y: 0.92 },
      { pos: 'FW', label: 'ST', x: 0.70, y: 0.39 }, { pos: 'FW', label: 'ST', x: 0.70, y: 0.61 },
    ],
  },
  '4-2-3-1': {
    name: '4-2-3-1', shape: '역습·균형',
    slots: [
      { pos: 'GK', label: 'GK', x: 0.05, y: 0.50 },
      { pos: 'DF', label: 'LB', x: 0.20, y: 0.13 }, { pos: 'DF', label: 'CB', x: 0.17, y: 0.37 },
      { pos: 'DF', label: 'CB', x: 0.17, y: 0.63 }, { pos: 'DF', label: 'RB', x: 0.20, y: 0.87 },
      { pos: 'MF', label: 'DM', x: 0.34, y: 0.38 }, { pos: 'MF', label: 'DM', x: 0.34, y: 0.62 },
      { pos: 'MF', label: 'LAM', x: 0.57, y: 0.17 }, { pos: 'MF', label: 'CAM', x: 0.55, y: 0.50 },
      { pos: 'MF', label: 'RAM', x: 0.57, y: 0.83 },
      { pos: 'FW', label: 'ST', x: 0.74, y: 0.50 },
    ],
  },
  '4-1-4-1': {
    name: '4-1-4-1', shape: '한 줄 두 줄',
    slots: [
      { pos: 'GK', label: 'GK', x: 0.05, y: 0.50 },
      { pos: 'DF', label: 'LB', x: 0.20, y: 0.13 }, { pos: 'DF', label: 'CB', x: 0.17, y: 0.37 },
      { pos: 'DF', label: 'CB', x: 0.17, y: 0.63 }, { pos: 'DF', label: 'RB', x: 0.20, y: 0.87 },
      { pos: 'MF', label: 'DM', x: 0.33, y: 0.50 },
      { pos: 'MF', label: 'LM', x: 0.47, y: 0.11 }, { pos: 'MF', label: 'CM', x: 0.43, y: 0.38 },
      { pos: 'MF', label: 'CM', x: 0.43, y: 0.62 }, { pos: 'MF', label: 'RM', x: 0.47, y: 0.89 },
      { pos: 'FW', label: 'ST', x: 0.73, y: 0.50 },
    ],
  },
  '3-4-3': {
    name: '3-4-3', shape: '전방 압박·폭',
    slots: [
      { pos: 'GK', label: 'GK', x: 0.05, y: 0.50 },
      { pos: 'DF', label: 'CB', x: 0.18, y: 0.26 }, { pos: 'DF', label: 'CB', x: 0.16, y: 0.50 },
      { pos: 'DF', label: 'CB', x: 0.18, y: 0.74 },
      { pos: 'MF', label: 'LWB', x: 0.44, y: 0.08 }, { pos: 'MF', label: 'CM', x: 0.39, y: 0.36 },
      { pos: 'MF', label: 'CM', x: 0.36, y: 0.64 }, { pos: 'MF', label: 'RWB', x: 0.44, y: 0.92 },
      { pos: 'FW', label: 'LW', x: 0.70, y: 0.17 }, { pos: 'FW', label: 'ST', x: 0.75, y: 0.50 },
      { pos: 'FW', label: 'RW', x: 0.70, y: 0.83 },
    ],
  },
  '4-3-1-2': {
    name: '4-3-1-2', shape: '중원 다이아몬드',
    slots: [
      { pos: 'GK', label: 'GK', x: 0.05, y: 0.50 },
      { pos: 'DF', label: 'LB', x: 0.20, y: 0.13 }, { pos: 'DF', label: 'CB', x: 0.17, y: 0.37 },
      { pos: 'DF', label: 'CB', x: 0.17, y: 0.63 }, { pos: 'DF', label: 'RB', x: 0.20, y: 0.87 },
      { pos: 'MF', label: 'CM', x: 0.41, y: 0.28 }, { pos: 'MF', label: 'DM', x: 0.34, y: 0.50 },
      { pos: 'MF', label: 'CM', x: 0.41, y: 0.72 }, { pos: 'MF', label: 'CAM', x: 0.58, y: 0.50 },
      { pos: 'FW', label: 'ST', x: 0.75, y: 0.40 }, { pos: 'FW', label: 'ST', x: 0.75, y: 0.60 },
    ],
  },
};

/* ─────────────────────── 풋살 규모(5인제·6인제) 포메이션 ───────────────────────
   커스텀 매치업에서만 씁니다. 11인제 화면(커리어)은 FORMATION_IDS 만 고르므로
   여기에 더해도 기존 구단 선택·전술 화면의 포메이션 목록은 그대로 7종입니다.
   size: 그 포메이션이 세우는 선수 수 (GK 포함). */
export const FUTSAL_FORMATIONS = {
  '1-2-1': {
    name: '1-2-1', shape: '풋살 균형 · 피보+알라 2', size: 5,
    slots: [
      { pos: 'GK', label: 'GK', x: 0.07, y: 0.50 },
      { pos: 'DF', label: 'FIXO', x: 0.27, y: 0.50 },
      { pos: 'MF', label: 'ALA', x: 0.50, y: 0.19 }, { pos: 'MF', label: 'ALA', x: 0.50, y: 0.81 },
      { pos: 'FW', label: 'PIVO', x: 0.72, y: 0.50 },
    ],
  },
  '2-2': {
    name: '2-2', shape: '풋살 두 줄 · 수비 둘 공격 둘', size: 5,
    slots: [
      { pos: 'GK', label: 'GK', x: 0.07, y: 0.50 },
      { pos: 'DF', label: 'CB', x: 0.28, y: 0.33 }, { pos: 'DF', label: 'CB', x: 0.28, y: 0.67 },
      { pos: 'FW', label: 'ST', x: 0.62, y: 0.32 }, { pos: 'FW', label: 'ST', x: 0.62, y: 0.68 },
    ],
  },
  '1-2-2': {
    name: '1-2-2', shape: '풋살 공격적 · 앞선 둘', size: 6,
    slots: [
      { pos: 'GK', label: 'GK', x: 0.07, y: 0.50 },
      { pos: 'DF', label: 'FIXO', x: 0.26, y: 0.50 },
      { pos: 'MF', label: 'ALA', x: 0.47, y: 0.24 }, { pos: 'MF', label: 'ALA', x: 0.47, y: 0.76 },
      { pos: 'FW', label: 'PIVO', x: 0.66, y: 0.33 }, { pos: 'FW', label: 'PIVO', x: 0.66, y: 0.67 },
    ],
  },
  '1-3-1': {
    name: '1-3-1', shape: '풋살 중원 장악', size: 6,
    slots: [
      { pos: 'GK', label: 'GK', x: 0.07, y: 0.50 },
      { pos: 'DF', label: 'FIXO', x: 0.24, y: 0.50 },
      { pos: 'MF', label: 'ALA', x: 0.48, y: 0.18 }, { pos: 'MF', label: 'ALA', x: 0.46, y: 0.50 },
      { pos: 'MF', label: 'ALA', x: 0.48, y: 0.82 },
      { pos: 'FW', label: 'PIVO', x: 0.70, y: 0.50 },
    ],
  },
};
for (const [id, f] of Object.entries(FUTSAL_FORMATIONS)) FORMATIONS[id] = f;
/* 포메이션 한 개가 세우는 선수 수 — 풋살 포메이션이 아니면 11인제 */
export const sizeOfFormation = (id) => FUTSAL_FORMATIONS[id]?.size || 11;
/* 그 규모에서 고를 수 있는 포메이션 목록 */
export const formationsFor = (size) => Object.keys(FORMATIONS).filter((id) => sizeOfFormation(id) === Number(size));
export const isFutsalFormation = (id) => !!FUTSAL_FORMATIONS[id];
/* 11인제 포메이션 7종 — 커리어(구단 선택·전술) 화면은 이 목록만 씁니다. */
export const FORMATION_IDS = Object.keys(FORMATIONS).filter((id) => !FUTSAL_FORMATIONS[id]);
export const POS_LABEL = { GK: '골키퍼', DF: '수비수', MF: '미드필더', FW: '공격수' };

/* ─────────────────────────── 10개 구단 ─────────────────────────── */
export const TEAM_DEFS = [
  {
    id: 'gs', name: '금산 유나이티드', short: '금산', nick: '금빛 군단', city: '금산',
    primary: '#0abbee', secondary: '#ffffff', ink: '#101014',
    power: 84, budget: 420, wage: 5200, stadium: '금산종합운동장', capacity: 18400,
    formation: '4-3-3', tactic: { line: 0.5, pass: -0.5, press: 0.3, route: 0 },
    bio: '리그 최고의 자금력. 화려한 패스 축구로 우승을 노리는 명문.',
  },
  {
    id: 'bm', name: '별무리 FC', short: '별무리', nick: '별의 아이들', city: '금산',
    primary: '#ffdc1a', secondary: '#101014', ink: '#101014',
    power: 78, budget: 260, wage: 3900, stadium: '별무리 광장', capacity: 6200,
    formation: '4-3-3', tactic: { line: 0.7, pass: 0.2, press: 0.8, route: 0.2 },
    bio: '관중의 목소리가 곧 전술. 쉼 없이 달리는 압박 축구의 표본.',
  },
  {
    id: 'dj', name: '대전 로켓스', short: '대전', nick: '로켓', city: '대전',
    primary: '#ff614a', secondary: '#ffffff', ink: '#101014',
    power: 80, budget: 300, wage: 4400, stadium: '대전 로켓파크', capacity: 15200,
    formation: '4-2-3-1', tactic: { line: 0.2, pass: 0.6, press: 0.1, route: 0.5 },
    bio: '빠른 발과 긴 패스. 한 번 잡으면 3초 만에 골문 앞까지 갑니다.',
  },
  {
    id: 'ns', name: '논산 파머스', short: '논산', nick: '농부들', city: '논산',
    primary: '#02c245', secondary: '#ffffff', ink: '#101014',
    power: 72, budget: 180, wage: 3000, stadium: '논산 들판구장', capacity: 8800,
    formation: '4-4-2', tactic: { line: -0.8, pass: 0.4, press: -0.5, route: 0.6 },
    bio: '단단한 두 줄 수비와 측면 크로스. 알뜰한 운영의 달인.',
  },
  {
    id: 'jj', name: '전주 아츠', short: '전주', nick: '예술가', city: '전주',
    primary: '#7e65c1', secondary: '#ffffff', ink: '#ffffff',
    power: 76, budget: 240, wage: 3600, stadium: '전주 예술마당', capacity: 12100,
    formation: '4-2-3-1', tactic: { line: 0, pass: -0.8, press: 0, route: -0.5 },
    bio: '짧은 패스의 향연. 점유율 60%를 기본값으로 두는 기술파.',
  },
  {
    id: 'ks', name: '군산 씨독스', short: '군산', nick: '바닷개', city: '군산',
    primary: '#2b59ff', secondary: '#ffffff', ink: '#ffffff',
    power: 74, budget: 200, wage: 3300, stadium: '군산 항구구장', capacity: 9600,
    formation: '4-3-3', tactic: { line: 0.6, pass: 0.3, press: 0.9, route: 0 },
    bio: '바닷바람 같은 압박. 상대 미드필더를 숨 못 쉬게 만듭니다.',
  },
  {
    id: 'gj', name: '공주 레인저스', short: '공주', nick: '레인저', city: '공주',
    primary: '#ff9f1a', secondary: '#101014', ink: '#101014',
    power: 70, budget: 150, wage: 2700, stadium: '공주 숲속구장', capacity: 7300,
    formation: '4-4-2', tactic: { line: -0.4, pass: 0.9, press: -0.3, route: 0.7 },
    bio: '롱볼 하나로 뒤집는 역습 전문. 예산은 적어도 한 방이 있습니다.',
  },
  {
    id: 'by', name: '부여 킹스', short: '부여', nick: '왕관', city: '부여',
    primary: '#ff5ea8', secondary: '#101014', ink: '#101014',
    power: 75, budget: 210, wage: 3400, stadium: '부여 왕궁구장', capacity: 10400,
    formation: '4-3-3', tactic: { line: 0.3, pass: -0.3, press: 0.2, route: -0.7 },
    bio: '중앙 돌파의 대가. 에이스의 개인기에 모든 걸 겁니다.',
  },
  {
    id: 'sc', name: '서천 웨이브스', short: '서천', nick: '파도', city: '서천',
    primary: '#00c2a8', secondary: '#08313d', ink: '#08313d',
    power: 69, budget: 140, wage: 2400, stadium: '서천 해변구장', capacity: 5900,
    formation: '3-5-2', tactic: { line: 0.1, pass: -0.2, press: 0.4, route: 0.4 },
    bio: '평균 나이 23세. 젊은 다리로 중원을 넓게 쓰는 팀.',
  },
  {
    id: 'ik', name: '익산 워리어스', short: '익산', nick: '전사', city: '익산',
    primary: '#c9c9d4', secondary: '#101014', ink: '#101014',
    power: 67, budget: 120, wage: 2200, stadium: '익산 철도구장', capacity: 5100,
    formation: '4-4-2', tactic: { line: -0.6, pass: 0.7, press: 0.5, route: 0.1 },
    bio: '몸싸움과 제공권. 이기는 축구보다 지지 않는 축구를 합니다.',
  },
];

/* ─────────────────────────── 이름 ─────────────────────────── */
const SURNAMES = ['김', '이', '박', '최', '정', '강', '조', '윤', '장', '임', '한', '오', '서', '신', '권', '황', '안', '송', '류', '홍', '전', '고', '문', '손', '양', '배', '백', '허', '유', '남', '심', '노', '하', '곽', '성', '차', '주', '우', '구', '민'];
const GIVEN = ['민준', '서준', '도윤', '시우', '하준', '주원', '지호', '준서', '건우', '현우', '우진', '선우', '서진', '연우', '유준', '정우', '승우', '승현', '시윤', '준혁', '은우', '지환', '승민', '지훈', '유찬', '윤우', '민성', '준영', '시후', '진우', '지원', '수호', '재윤', '동현', '태윤', '민규', '재원', '한결', '민재', '현준', '선호', '정민', '성민', '규민', '동건', '도현', '태민', '승호', '재현', '영민', '진호', '상우', '광민', '혁주', '대웅', '명수', '병철', '상현', '석진', '윤석', '태양', '호준', '인성', '경수', '세준', '용준', '원준', '찬영', '하람', '도진', '시온', '이안', '로건', '건율'];

const uniqueName = (rng, used) => {
  for (let i = 0; i < 60; i++) {
    const n = pick(rng, SURNAMES) + pick(rng, GIVEN);
    if (!used.has(n)) { used.add(n); return n; }
  }
  return pick(rng, SURNAMES) + pick(rng, GIVEN) + (used.size % 9);
};
/* 다른 모듈(세계 생성·시즌 유스)이 같은 이름 규칙을 쓰도록 열어 둡니다. */
export const randomName = (rng, used) => uniqueName(rng, used);

/* ─────────────────────────── 능력치 ─────────────────────────── */
export const STAT_KEYS = ['spd', 'sho', 'pas', 'dri', 'def', 'vis', 'sta', 'gk'];
export const STAT_LABEL = { spd: '스피드', sho: '슈팅', pas: '패스', dri: '드리블', def: '수비', vis: '시야', sta: '체력', gk: 'GK' };
const WEIGHTS = {
  GK: { gk: 0.74, vis: 0.08, def: 0.06, pas: 0.06, spd: 0.04, sta: 0.02 },
  DF: { def: 0.34, spd: 0.2, sta: 0.16, pas: 0.14, vis: 0.1, dri: 0.06 },
  MF: { pas: 0.27, vis: 0.19, dri: 0.18, sta: 0.16, def: 0.1, spd: 0.1 },
  FW: { sho: 0.31, dri: 0.23, spd: 0.22, vis: 0.12, pas: 0.12 },
};

export function overall(p) {
  const w = WEIGHTS[p.pos] || WEIGHTS.MF;
  let sum = 0, tw = 0;
  for (const k in w) { sum += p.stats[k] * w[k]; tw += w[k]; }
  let o = sum / tw;
  if (p.age <= 22) o += 1; else if (p.age >= 33) o -= 1;
  return Math.round(clamp(o, 30, 99));
}

export function valueOf(p) {
  const o = p.ovr ?? overall(p);
  const base = Math.exp((o - 62) / 11) * 1.1;
  const a = p.age;
  const af = a <= 21 ? 1.4 : a <= 24 ? 1.28 : a <= 27 ? 1.05 : a <= 29 ? 0.85 : a <= 31 ? 0.62 : a <= 33 ? 0.4 : a <= 35 ? 0.24 : 0.12;
  return Math.round(clamp(base * af, 0.3, 70) * 10) / 10;
}
export function wageOf(p) {
  const o = p.ovr ?? overall(p);
  return Math.round((valueOf(p) * 16 + Math.pow(Math.max(o - 45, 1), 1.55) * 1.6) / 10) * 10;
}

export function genStats(rng, pos, target) {
  const st = {};
  for (const k of STAT_KEYS) {
    const emphasis = WEIGHTS[pos][k] ?? 0.02;
    const bump = emphasis * 90;
    let v = target - 12 + bump * 0.55 + gauss(rng) * 7;
    if (k === 'gk' && pos !== 'GK') v = target - 55 + gauss(rng) * 8;
    st[k] = Math.round(clamp(v, 25, 99));
  }
  return st;
}

/* 목표 종합에 맞춘 능력치 — 포지션 강조 항목을 키우되, 종합이 target 이 되도록
   가중 능력치를 한꺼번에 보정합니다. (실제 선수 데이터를 그대로 싣기 위해) */
export function statsFor(rng, pos, target, age = 25) {
  const stats = genStats(rng, pos, target);
  const w = WEIGHTS[pos] || WEIGHTS.MF;
  for (let i = 0; i < 6; i++) {
    const o = overall({ pos, age, stats });
    const diff = Math.round(target - o);
    if (!diff) break;
    for (const k of STAT_KEYS) {
      if ((w[k] || 0) <= 0.02) continue;
      stats[k] = clamp(stats[k] + diff, 25, 99);
    }
  }
  return stats;
}

let PID = 0;
export function newPlayerId() { PID += 1; return `p${PID}`; }

/* 한 구단 20명: GK 3, DF 7, MF 6, FW 4 */
const POS_PLAN = ['GK', 'GK', 'GK', 'DF', 'DF', 'DF', 'DF', 'DF', 'DF', 'DF', 'MF', 'MF', 'MF', 'MF', 'MF', 'MF', 'FW', 'FW', 'FW', 'FW'];

export function buildSquad(rng, team, usedNames) {
  const plan = shuffle(rng, POS_PLAN);
  // GK 는 한 명은 주전, 한 명은 유망주로
  const squad = [];
  let gkIdx = 0;
  for (let i = 0; i < plan.length; i++) {
    const pos = plan[i];
    let target = team.power + gauss(rng) * 9 - 3;
    if (pos === 'GK') { target += gkIdx === 0 ? 3 : -4; gkIdx += 1; }
    if (i === 0) target += 7; // 에이스
    target = clamp(target, 48, 94);
    const age = pos === 'GK' ? rint(rng, 23, 36) : rint(rng, 19, 35);
    const stats = genStats(rng, pos, target);
    const p = {
      id: newPlayerId(), name: uniqueName(rng, usedNames), pos, age,
      num: 0, stats, teamId: team.id,
      form: 0, season: null, career: { apps: 0, goals: 0, assists: 0 },
    };
    p.ovr = overall(p);
    p.value = valueOf(p);
    p.wage = wageOf(p);
    squad.push(p);
  }
  // 등번호: GK 1번, 나머지 2~40 중복 없이, 주전급은 낮은 번호
  squad.sort((a, b) => b.ovr - a.ovr);
  const gks = squad.filter((p) => p.pos === 'GK');
  gks.forEach((p, i) => { p.num = i === 0 ? 1 : 12 + i; });
  const used = new Set(gks.map((p) => p.num));
  for (const p of squad) {
    if (p.pos === 'GK') continue;
    let n = rint(rng, 2, 40);
    while (used.has(n)) n = rint(rng, 2, 40);
    used.add(n);
    p.num = n;
  }
  return squad;
}

export function freshSeasonStats() {
  return { apps: 0, starts: 0, subs: 0, goals: 0, assists: 0, shots: 0, onTarget: 0, saves: 0, tackles: 0, ratingSum: 0, ratingCount: 0, cleanSheets: 0, yellow: 0, red: 0 };
}
