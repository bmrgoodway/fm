// 전술 4축 정의 — 화면과 경기 엔진이 함께 씁니다.
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
export const tacticWords = (t) => {
  const w = [];
  if ((t.press || 0) > 0.35) w.push('게겐프레싱');
  if ((t.line || 0) > 0.35) w.push('높은 라인');
  if ((t.line || 0) < -0.35) w.push('내려앉기');
  if ((t.pass || 0) < -0.35) w.push('짧은 패스');
  if ((t.pass || 0) > 0.35) w.push('롱볼');
  if ((t.route || 0) > 0.35) w.push('측면 크로스');
  if ((t.route || 0) < -0.35) w.push('중앙 돌파');
  return w.length ? w.join(' · ') : '균형';
};
