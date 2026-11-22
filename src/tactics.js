// 전술 4축 + 팀 성향(멘탈리티) + 포지션별 역할(Role) 정의 — 화면과 경기 엔진이 함께 씁니다.
export const AXES = [
  {
    key: 'line', name: '수비 라인 높이', left: '낮은 라인', right: '높은 라인',
    lo: '뒷공간 차단', hi: '전방 압박',
    effect: (v) => (v > 0.25 ? '상대 진영에서 경기 · 뒷공간 노출' : v < -0.25 ? '골문 앞을 지킴 · 역습에 강함' : '중간 지점에서 균형'),
  },
  {
    key: 'pass', name: '패스 스타일', left: '짧은 패스', right: '롱볼',
    lo: '점유', hi: '역습',
    effect: (v) => (v > 0.25 ? '한 번에 뒤로 넘김 · 점유율 낮음' : v < -0.25 ? '짧게 이어가는 점유 · 패스 실수 위험' : '상황에 따라 섞어 씀'),
  },
  {
    key: 'press', name: '압박 강도', left: '대기', right: '게겐프레싱',
    lo: '체력 아낌', hi: '체력 소모',
    effect: (v) => (v > 0.25 ? '공을 뺏는 힘 ↑ · 후반 체력 ↓' : v < -0.25 ? '체력 유지 · 상대에게 시간 허용' : '무리하지 않는 압박'),
  },
  {
    key: 'route', name: '공격 루트', left: '중앙', right: '측면',
    lo: '중앙 돌파', hi: '측면 크로스',
    effect: (v) => (v > 0.25 ? '측면 크로스 · 헤더 기회' : v < -0.25 ? '중앙 침투 · 밀집 수비에 약함' : '중앙과 측면을 함께'),
  },
];
export const STEPS = [-1, -0.5, 0, 0.5, 1];
export const stepLabel = (v) => (v <= -0.75 ? '최소' : v <= -0.25 ? '낮음' : v < 0.25 ? '보통' : v < 0.75 ? '높음' : '최대');

/* ─────────────────────────── 팀 성향(멘탈리티) ───────────────────────────
   팀 전체를 앞으로 밀거나 뒤로 내리고, 공격 가담 인원과 위험 감수를 함께 바꿉니다.
   경기 엔진(computeShape·targetFor·bestPass)과 화면이 같은 5단계를 씁니다. */
export const MENTALITY = [
  {
    v: -1, name: '잠그기', tag: '두 줄 수비',
    effect: '두 줄로 내려앉아 공간을 지우고, 이기면 역습 한 방만 노립니다',
    line: (hasBall) => (hasBall ? '공을 잡아도 수비수는 올라가지 않고 역습 패스만 찾습니다' : '두 줄 블록 · 최후방에서 버팀'),
  },
  {
    v: -0.5, name: '수비적', tag: '라인 낮춤',
    effect: '라인을 낮추고 공격 가담을 줄여 실점을 아낍니다',
    line: (hasBall) => (hasBall ? '공격 가담을 줄이고 안전한 패스를 고릅니다' : '블록을 내리고 뒷공간을 덮습니다'),
  },
  {
    v: 0, name: '균형', tag: '기본값',
    effect: '공수 균형 — 라인과 가담 수가 기본값입니다',
    line: () => '공수 균형',
  },
  {
    v: 0.5, name: '공격적', tag: '라인 올림',
    effect: '라인을 올리고 전진 패스·슈팅이 늘어납니다',
    line: (hasBall) => (hasBall ? '전진 패스·슈팅이 늘고 풀백도 올라갑니다' : '블록이 올라와 상대를 조입니다'),
  },
  {
    v: 1, name: '총공세', tag: '전원 전진',
    effect: '수비수까지 올라가 문전을 채웁니다 — 뒷공간은 내줍니다',
    line: (hasBall) => (hasBall ? '센터백까지 문전으로 올라갑니다' : '수비수도 하프라인 위에서 맞습니다 · 뒷공간 노출'),
  },
];
export const MENTALITY_VALUES = MENTALITY.map((m) => m.v);
export function mentalityOf(v) {
  const n = Number(v) || 0;
  return MENTALITY.find((m) => Math.abs(m.v - n) < 0.01) || MENTALITY[2];
}
export const mentalityLabel = (v) => mentalityOf(v).name;
export const mentalityEffect = (v, hasBall = true) => mentalityOf(v).line(hasBall);

/* ─────────────────────────── 포지션별 역할(Role) ───────────────────────────
   슬롯 라벨(LB·CB·DM·LW·ST …)로 그룹을 정하고, 그룹마다 2~3개의 역할을 둡니다.
   역할은 '자리(오프더볼 좌표) · 슈팅/크로스/스루패스 선택 · 압박 반경'을 바꿉니다. */
export const ROLE_GROUPS = {
  gk: { label: '골키퍼', roles: ['goalkeeper'] },
  fb: { label: '측면 수비', roles: ['fullback', 'wingback'] },
  cb: { label: '중앙 수비', roles: ['cover', 'stopper'] },
  mid: { label: '미드필더', roles: ['holding', 'b2b', 'playmaker'] },
  wide: { label: '측면 공격', roles: ['winger', 'inside'] },
  st: { label: '중앙 공격', roles: ['poacher', 'target'] },
};

export const SLOT_GROUP = {
  GK: 'gk',
  LB: 'fb', RB: 'fb',
  CB: 'cb',
  DM: 'mid', CM: 'mid', CAM: 'mid', LM: 'mid', RM: 'mid', LWB: 'mid', RWB: 'mid',
  LW: 'wide', RW: 'wide', LAM: 'wide', RAM: 'wide',
  ST: 'st',
};

export const ROLES = {
  goalkeeper: { label: '골키퍼', short: 'GK', group: 'gk', effect: '골문을 지키고 짧게·길게 배급합니다' },
  fullback: { label: '풀백', short: '풀백', group: 'fb', effect: '겹쳐 올라가지 않고 수비 라인 뒤를 지킵니다' },
  wingback: { label: '윙백', short: '윙백', group: 'fb', effect: '터치라인 끝까지 오르내리며 크로스를 올립니다' },
  cover: { label: '커버', short: '커버', group: 'cb', effect: '한 발 물러서 가장 깊은 공간을 덮습니다' },
  stopper: { label: '스토퍼', short: '스토퍼', group: 'cb', effect: '앞으로 나가 먼저 끊고 압박 반경을 넓힙니다' },
  holding: { label: '홀딩', short: '홀딩', group: 'mid', effect: '수비 라인 앞을 막고 안전한 패스로 돌립니다' },
  b2b: { label: '박스투박스', short: 'B2B', group: 'mid', effect: '우리 박스부터 상대 박스까지 왕복하며 가담합니다' },
  playmaker: { label: '플레이메이커', short: '플메', group: 'mid', effect: '라인 사이에서 공을 받아 킬패스·전환을 조율합니다' },
  winger: { label: '윙어', short: '윙어', group: 'wide', effect: '터치라인까지 벌려 서서 크로스를 올립니다' },
  inside: { label: '인사이드 포워드', short: 'IF', group: 'wide', effect: '하프스페이스로 접어 들어와 슈팅을 노립니다' },
  poacher: { label: '포처', short: '포처', group: 'st', effect: '수비 라인을 타고 뒷공간을 파고들어 마무리합니다' },
  target: { label: '타깃맨', short: '타깃', group: 'st', effect: '등지고 버티며 연계·헤더로 동료를 살립니다' },
};

/* 역할별 수치 — 경기 엔진이 그대로 읽습니다.
   depth: 기준 자리에서 앞(+)/뒤(-) 로 몇 u · width: 좌우 벌림 배수
   press: 압박 반경 가산(u) · shoot: 슈팅 성향 배수 · run: 침투 러닝 성향
   cross/through: 패스 선택 가산 · crossRecv: 크로스 받을 때 가산 · overlap: 0~1 풀백 오버랩 */
export const ROLE_TUNING = {
  goalkeeper: { depth: 0, width: 1, press: 0, shoot: 0, run: 0, cross: 0, through: 0, crossRecv: 0, overlap: 0 },
  fullback: { depth: -1.5, width: 0.92, press: -1, shoot: 0.7, run: 0, cross: -0.08, through: 0, crossRecv: 0, overlap: 0 },
  wingback: { depth: 6, width: 1.14, press: 0.5, shoot: 0.85, run: 0.3, cross: 0.26, through: 0, crossRecv: 0, overlap: 1 },
  cover: { depth: -3.5, width: 0.9, press: -2.5, shoot: 0.5, run: 0, cross: 0, through: 0, crossRecv: 0, overlap: 0 },
  stopper: { depth: 4.5, width: 0.96, press: 3.5, shoot: 0.55, run: 0, cross: 0, through: 0, crossRecv: 0, overlap: 0 },
  holding: { depth: -4, width: 0.9, press: -1.5, shoot: 0.7, run: 0, cross: 0, through: -0.2, crossRecv: 0, overlap: 0 },
  b2b: { depth: 3, width: 1.05, press: 2, shoot: 1.05, run: 1, cross: 0.04, through: 0, crossRecv: 0, overlap: 0 },
  playmaker: { depth: 1.5, width: 0.85, press: -1, shoot: 0.78, run: 0, cross: 0.04, through: 0.28, crossRecv: 0, overlap: 0 },
  winger: { depth: 0.5, width: 1.18, press: -1, shoot: 0.85, run: 1, cross: 0.3, through: 0, crossRecv: -0.1, overlap: 0 },
  inside: { depth: 2, width: 0.66, press: -0.5, shoot: 1.18, run: 1, cross: -0.22, through: 0.16, crossRecv: -0.12, overlap: 0 },
  poacher: { depth: 2.5, width: 0.8, press: -3, shoot: 1.25, run: 1.4, cross: 0, through: 0.1, crossRecv: 0.06, overlap: 0 },
  target: { depth: -2.5, width: 0.7, press: -2, shoot: 0.95, run: -1, cross: 0.2, through: -0.1, crossRecv: 0.3, overlap: 0 },
};
export const NEUTRAL_TUNING = ROLE_TUNING.goalkeeper;

/* 슬롯 라벨별 기본 역할 — 세이브에 역할이 없으면(구버전) 이 값이 자동 적용됩니다. */
export const DEFAULT_ROLE = {
  GK: 'goalkeeper',
  LB: 'fullback', RB: 'fullback',
  CB: 'cover',
  DM: 'holding', CM: 'b2b', CAM: 'playmaker',
  LM: 'b2b', RM: 'b2b', LWB: 'b2b', RWB: 'b2b',
  LW: 'winger', RW: 'winger', LAM: 'winger', RAM: 'winger',
  ST: 'poacher',
};

export function groupOf(label) { return SLOT_GROUP[label] || 'mid'; }
export function rolesForLabel(label) { return ROLE_GROUPS[groupOf(label)].roles; }
export function defaultRole(label) { return DEFAULT_ROLE[label] || (groupOf(label) === 'gk' ? 'goalkeeper' : 'b2b'); }
export function roleLabel(key) { return (ROLES[key] || ROLES.b2b).label; }
export function roleShort(key) { return (ROLES[key] || ROLES.b2b).short; }
export function roleEffect(key) { return (ROLES[key] || ROLES.b2b).effect; }
export function roleTuning(key) { return ROLE_TUNING[key] || NEUTRAL_TUNING; }
/* 이 슬롯에서 쓸 수 있는 역할인지 확인하고, 아니면 기본값으로 돌립니다. */
export function roleFor(label, key) {
  const opts = rolesForLabel(label);
  return opts.includes(key) ? key : defaultRole(label);
}
/* 화면의 역할 버튼을 순환합니다 (슬롯 라벨 기준). */
export function nextRole(label, key) {
  const opts = rolesForLabel(label);
  const i = opts.indexOf(key);
  return opts[(i + 1) % opts.length];
}
/* 포메이션 슬롯 배열 → 기본 역할 배열 */
export function defaultRoles(slots) { return slots.map((s) => defaultRole(s.label)); }
/* 저장된 역할 배열을 보정합니다 (길이·불일치·구버전 세이브). */
export function resolveRoles(roles, slots) {
  return slots.map((s, i) => roleFor(s.label, Array.isArray(roles) ? roles[i] : null));
}

export const tacticWords = (t) => {
  const w = [];
  if ((t.press || 0) > 0.35) w.push('게겐프레싱');
  if ((t.line || 0) > 0.35) w.push('높은 라인');
  if ((t.line || 0) < -0.35) w.push('내려앉기');
  if ((t.pass || 0) < -0.35) w.push('짧은 패스');
  if ((t.pass || 0) > 0.35) w.push('롱볼');
  if ((t.route || 0) > 0.35) w.push('측면 크로스');
  if ((t.route || 0) < -0.35) w.push('중앙 돌파');
  const m = Number(t.mentality) || 0;
  if (m <= -0.75) w.push('잠그기');
  else if (m <= -0.25) w.push('수비적');
  else if (m >= 0.75) w.push('총공세');
  else if (m >= 0.25) w.push('공격적');
  return w.length ? w.join(' · ') : '균형';
};
