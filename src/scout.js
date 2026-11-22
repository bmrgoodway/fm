// 상대 스카우팅 — 다음 상대의 '실제' 라인업·전술·선수 데이터에서
// 예상 포메이션 · 주 전술 성향 · 핵심 경계 선수 · 맞춤 공략 힌트를 뽑습니다.
// 화면(views.js)과 자체 점검(scripts/fm-selftest.mjs)이 같은 값을 읽으므로,
// 화면에 적힌 내용과 경기에 실제로 들어가는 값이 어긋나지 않습니다.
import { FORMATIONS, POS_LABEL, STAT_LABEL } from './data.js';
import { AXES, stepLabel, tacticWords, mentalityOf, roleLabel, defaultRole, roleShort, resolveSetPiece, setPieceLabel } from './tactics.js';
import { lineupFor } from './match.js';
import { standings, standingsFor, teamPower } from './world.js';

const STAT_ORDER = ['spd', 'sho', 'pas', 'dri', 'def', 'vis', 'sta'];

/* 선수의 가장 강한 능력치 두 개 — 경계 카드에 그대로 적습니다. */
function topStats(p, n = 2) {
  return STAT_ORDER
    .map((k) => ({ key: k, label: STAT_LABEL[k], value: p.stats[k] || 0 }))
    .sort((a, b) => b.value - a.value)
    .slice(0, n);
}

/* 공격 위협 지수 — 슈팅·드리블·스피드를 중심으로 보고, 공격 포지션에 가산합니다.
   (수비수도 세트피스·오버래핑 위협이 있으니 0으로 두지 않습니다) */
export function threatOf(p) {
  const s = p.stats || {};
  const posBonus = p.pos === 'FW' ? 5 : p.pos === 'MF' ? 2 : p.pos === 'DF' ? 0.5 : 0;
  return (s.sho || 0) * 0.34 + (s.dri || 0) * 0.24 + (s.spd || 0) * 0.18
    + (s.pas || 0) * 0.1 + (s.vis || 0) * 0.08 + posBonus;
}

/* 경계 선수 한 명의 '막는 법' — 그 선수의 최고 능력치에 맞춰 문장을 고릅니다. */
function markHint(p, stat) {
  const pos = POS_LABEL[p.pos] || '선수';
  switch (stat.key) {
    case 'sho': return `${pos} · 슈팅 ${stat.value} — 박스 안에서 방아쇠가 빠릅니다. 문전에서 몸을 붙여 슈팅 각을 지우세요.`;
    case 'dri': return `${pos} · 드리블 ${stat.value} — 개인기로 수비를 벗겨냅니다. 태클보다 지연 수비로 2선 지원을 기다리세요.`;
    case 'spd': return `${pos} · 스피드 ${stat.value} — 뒷공간으로 뛰어넘습니다. 수비 라인 뒤 공간 관리를 늦추지 마세요.`;
    case 'pas': return `${pos} · 패스 ${stat.value} — 동료를 살리는 패스를 뿌립니다. 패스 길목을 먼저 막으세요.`;
    case 'vis': return `${pos} · 시야 ${stat.value} — 라인 사이에서 킬패스를 찾습니다. 홀딩으로 그 자리를 덮으세요.`;
    case 'def': return `${pos} · 수비 ${stat.value} — 이 선수를 뚫으면 상대 전개가 흔들립니다. 그쪽으로 압박을 몰아보세요.`;
    default: return `${pos} · 체력 ${stat.value} — 경합에서 잘 버팁니다. 템포를 올려 체력을 먼저 쓰게 만드세요.`;
  }
}

/* 축(라인·패스·압박·루트)에서 나오는 공략 — 경기 엔진이 실제로 반응하는 방향으로 적습니다. */
function axisHints(tactic) {
  const out = [];
  const v = (k) => Number(tactic[k]) || 0;
  if (v('line') >= 0.5) {
    out.push({ tag: '라인', text: '수비 라인이 아주 높습니다. 라인 뒤 공간으로 스루패스·침투 러닝을 노리세요 — 오프사이드 라인만 확인하면 한 번에 결승 찬스가 됩니다.' });
  } else if (v('line') >= 0.25) {
    out.push({ tag: '라인', text: '라인을 조금 올려 상대 진영에서 경기합니다. 뒤로 흘리는 스루패스가 통합니다.' });
  } else if (v('line') <= -0.5) {
    out.push({ tag: '라인', text: '라인을 깊게 내리고 골문 앞을 지킵니다. 문전이 빽빽하니 중거리 슈팅과 크로스·헤더로 흔드세요.' });
  }
  if (v('press') >= 0.5) {
    out.push({ tag: '압박', text: `전방 압박이 강합니다(압박 ${stepLabel(v('press'))}). 길게 끌지 말고 원투·짧은 패스로 1차 압박을 벗기세요. 압박은 체력을 크게 쓰니 후반 65분 이후가 기회입니다.` });
  } else if (v('press') <= -0.5) {
    out.push({ tag: '압박', text: '압박을 아끼고 내려섭니다. 공을 오래 가져도 뺏기지 않으니 조급하게 길게 넘기지 말고, 측면 전환으로 빈 곳을 만드세요.' });
  }
  if (v('pass') >= 0.5) {
    out.push({ tag: '패스', text: '롱볼로 한 번에 뒤로 넘깁니다. 점유율은 우리가 가져오되, 공을 잃은 직후 뒷공간 역습을 조심하세요.' });
  } else if (v('pass') <= -0.5) {
    out.push({ tag: '패스', text: '짧은 패스로 점유를 노립니다. 게겐프레싱으로 빌드업을 압박하면 패스 실수를 끌어낼 수 있습니다.' });
  }
  if (v('route') >= 0.5) {
    out.push({ tag: '루트', text: '측면 크로스가 주무기입니다. 풀백이 겹쳐 올라오므로 측면 2대1을 막고, 중앙 수비는 헤더 경합에 대비하세요.' });
  } else if (v('route') <= -0.5) {
    out.push({ tag: '루트', text: '중앙 돌파를 노립니다. 홀딩·커버로 중앙을 닫고, 에이스의 개인기는 태클보다 지연 수비로 막으세요.' });
  }
  return out;
}

/* 상대의 수비 라인·포메이션에서 나오는 공략 — 축이 중립인 팀에도 힌트가 남도록. */
function squadHints(xi) {
  const out = [];
  const dfs = xi.filter((x) => x.slot.pos === 'DF');
  const avg = (arr, k) => (arr.length ? arr.reduce((a, x) => a + (x.p.stats[k] || 0), 0) / arr.length : 0);
  const dfDef = Math.round(avg(dfs, 'def')), dfSpd = Math.round(avg(dfs, 'spd'));
  if (dfs.length && dfSpd <= 70) {
    out.push({ tag: '수비', text: `상대 수비 라인 스피드가 평균 ${dfSpd}로 느립니다. 뒷공간으로 빠른 침투(포처·스루패스)가 통합니다.` });
  } else if (dfs.length && dfDef <= 70) {
    out.push({ tag: '수비', text: `수비 라인 수비력이 평균 ${dfDef}입니다. 정면 승부를 피하고 빠른 전환·2선 침투로 흔드세요.` });
  } else if (dfs.length) {
    out.push({ tag: '수비', text: `수비 라인이 단단합니다(평균 수비 ${dfDef}·스피드 ${dfSpd}). 무리한 돌파보다 세트피스와 두 번째 공을 노리세요.` });
  }
  return out;
}

/* 포메이션별 약점 — 상대가 서는 모양에 따라 파고들 곳이 다릅니다. */
const FORMATION_HINT = {
  '4-3-3': '측면 공격수가 폭을 크게 벌립니다. 풀백 뒤 공간으로 역습하면 중앙 수비가 벌어진 틈이 나옵니다.',
  '4-4-2': '두 줄 4-4-2입니다. 중원을 3명으로 채워 숫자 우위를 만들고, 측면에서 2대1로 풀백을 끌어내세요.',
  '3-5-2': '윙백이 터치라인 끝까지 올라옵니다. 그 뒤 측면 공간이 비니, 윙어를 넓게 두고 반대쪽 전환으로 노리세요.',
  '4-2-3-1': '수비형 미드필더 두 명 앞, CAM 자리(라인 사이)가 열려 있습니다. 플레이메이커를 그 자리에 두고 킬패스를 받게 하세요.',
  '4-1-4-1': '홀딩 한 명이 수비 앞을 덮는 4-4 두 줄입니다. 그 홀딩을 공 쪽으로 끌어낸 뒤 2선 사이 공간으로 침투하세요.',
  '3-4-3': '3백만 남기고 윙백이 끝까지 올라갑니다. 윙어를 넓게 두고 윙백 뒤 공간으로 역습하되, 중원 4명 사이가 넓어 전환 패스도 통합니다.',
  '4-3-1-2': '중앙에 다이아몬드로 모여 측면 폭이 비어 있습니다. 윙어를 터치라인에 붙이고 풀백 오버랩·측면 크로스로 파고드세요.',
};

/* 상대의 세트피스 지시 — 코너·프리킥을 어떻게 차는지에 맞춰 문전 대비를 적습니다. */
function setPieceHint(sp) {
  const notes = [];
  if (sp.corner === 'near') notes.push('코너는 니어 포스트로 낮게 — 가까운 골대 앞에 수비수를 붙이고 첫 공을 먼저 치우세요.');
  else if (sp.corner === 'short') notes.push('코너는 짧게 연결합니다 — 코너 근처 2대1을 막고 볼을 뺏긴 직후 역습을 조심하세요.');
  else notes.push('코너는 박스 중앙으로 정면 크로스 — 중앙 수비의 헤더 경합에서 몸을 앞에 두세요.');
  if (sp.freekick === 'direct') notes.push('프리킥은 직접 슈팅 — 벽을 4명으로 세우고 골키퍼가 각도를 좁히게 하세요.');
  else if (sp.freekick === 'box') notes.push('프리킥은 박스로 크로스 — 문전 제공권 경합에 수비수를 미리 붙이세요.');
  else notes.push('프리킥은 짧게 넘깁니다 — 공 근처에서 압박을 걸어 전개를 막으세요.');
  return { tag: '세트피스', text: `코너 '${setPieceLabel('corner', sp.corner)}' · 프리킥 '${setPieceLabel('freekick', sp.freekick)}'. ${notes.join(' ')}` };
}

/* 지금 이 상대에게 준비해 둘 대응 — 축과 성향에서 바로 뽑습니다. */
function recommendHint(tactic, ment) {
  const v = (k) => Number(tactic[k]) || 0;
  const rec = [];
  if (v('line') >= 0.25) rec.push('수비 라인 뒤 침투(포처·스루패스)');
  if (v('line') <= -0.25) rec.push('측면 크로스·중거리 슈팅으로 블록 흔들기');
  if (v('press') >= 0.25) rec.push('짧은 패스·원투로 압박 벗기기');
  if (v('press') <= -0.25) rec.push('측면 전환으로 빈 공간 만들기');
  if (v('route') >= 0.25) rec.push('풀백을 수비에 두고 측면 2대1 차단');
  if (v('route') <= -0.25) rec.push('홀딩으로 중앙 패스 길목 차단');
  if (ment.v >= 0.5) rec.push('뺏은 직후 빠른 역습');
  if (ment.v <= -0.5) rec.push('세트피스와 두 번째 공');
  if (!rec.length) rec.push('원투·짧은 패스로 템포를 만들고 기회엔 과감한 슈팅');
  return { tag: '추천', text: `준비해 둘 대응 — ${rec.slice(0, 3).join(' · ')}.` };
}

/* 상대 한 팀의 스카우팅 보고서. */
export function scoutReport(w, teamId) {
  const team = w.teams[teamId];
  if (!team) return null;
  const lineup = lineupFor(w, teamId);
  const slots = FORMATIONS[lineup.formation]?.slots || [];
  const tactic = { line: 0, pass: 0, press: 0, route: 0, mentality: 0, ...(lineup.tactic || team.tactic || {}) };
  const ment = mentalityOf(tactic.mentality);
  const sp = resolveSetPiece(lineup.setpiece || team.setpiece);
  const xi = lineup.starters.map((pid, i) => {
    const p = w.players[pid];
    if (!p) return null;
    const slot = slots[i] || { pos: p.pos, label: p.pos };
    return { p, slot, role: lineup.roles?.[i] || defaultRole(slot.label), ovr: p.ovr };
  }).filter(Boolean);
  const outfield = xi.filter((x) => x.p.pos !== 'GK');
  const keyPlayers = outfield.slice().sort((a, b) => threatOf(b.p) - threatOf(a.p) || b.ovr - a.ovr).slice(0, 2).map((x) => {
    const stats = topStats(x.p, 2);
    return {
      id: x.p.id, name: x.p.name, num: x.p.num, pos: x.p.pos, posLabel: POS_LABEL[x.p.pos] || x.p.pos,
      slot: x.slot.label, role: x.role, roleLabel: roleLabel(x.role), ovr: x.ovr,
      threat: Math.round(threatOf(x.p) * 10) / 10,
      stats, mark: markHint(x.p, stats[0]),
    };
  });
  const table = standingsFor(w, w.teams[teamId]?.div || null);
  const row = table.find((r) => r.id === teamId);
  const hints = [
    ...axisHints(tactic),
    ...(ment.v >= 0.75 ? [{ tag: '성향', text: '전원 전진(총공세) 성향입니다. 뒷공간이 크게 열리니 뺏은 직후 빠른 역습 한 방이 가장 좋은 기회입니다.' }]
      : ment.v <= -0.75 ? [{ tag: '성향', text: '잠그기 성향 — 두 줄로 내려앉아 역시 역습만 노립니다. 세트피스와 측면 크로스로 블록을 흔드세요.' }]
        : ment.v > 0 ? [{ tag: '성향', text: '공격적 성향으로 라인을 올립니다. 우리가 공을 잡았을 때 뒤에 남는 수비가 적으니, 한 번 넘기면 넓은 공간이 나옵니다.' }]
          : ment.v < 0 ? [{ tag: '성향', text: '수비적 성향으로 가담을 줄입니다. 문전 수비가 두터우니 무리한 돌파보다 세트피스·중거리가 낫습니다.' }]
            : []),
    ...squadHints(xi),
    ...(FORMATION_HINT[lineup.formation] ? [{ tag: '포메이션', text: FORMATION_HINT[lineup.formation] }] : []),
    ...(sp.corner !== 'central' || sp.freekick !== 'direct' ? [setPieceHint(sp)] : []),
    recommendHint(tactic, ment),
    ...(keyPlayers[0] ? [{ tag: '경계', text: `${keyPlayers[0].name}(${keyPlayers[0].slot}·${keyPlayers[0].roleLabel}) — ${keyPlayers[0].mark}` }] : []),
  ];
  // 같은 말이 두 번 들어가지 않게, 태그·문장 기준으로 한 번씩만 남깁니다.
  const seen = new Set();
  const unique = hints.filter((h) => {
    const k = `${h.tag}|${h.text}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
  return {
    teamId, name: team.name, short: team.short, nick: team.nick, stadium: team.stadium,
    formation: lineup.formation, formationName: FORMATIONS[lineup.formation]?.name || lineup.formation,
    shape: FORMATIONS[lineup.formation]?.shape || '',
    tactic, mentality: ment, words: tacticWords(tactic), setpiece: sp,
    axes: AXES.map((a) => {
      const val = Number(tactic[a.key]) || 0;
      return {
        key: a.key, name: a.name, value: val, step: stepLabel(val),
        word: val >= 0.75 ? a.right : val >= 0.25 ? a.right : val <= -0.75 ? a.left : val <= -0.25 ? a.left : '균형',
        note: a.effect(val),
      };
    }),
    xi: xi.map((x) => ({ num: x.p.num, name: x.p.name, pos: x.p.pos, slot: x.slot.label, role: x.role, roleShort: roleShort(x.role), ovr: x.ovr })),
    keyPlayers,
    hints: unique.slice(0, 6),
    power: teamPower(w, teamId),
    rank: row?.rank ?? null, play: row?.play ?? 0,
    form: (team.recent || []).slice(-5),
    lineupDetail: xi,
  };
}
