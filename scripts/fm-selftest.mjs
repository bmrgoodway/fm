#!/usr/bin/env node
// 매치 엔진 자체 점검 — 브라우저 없이 node 로 돌립니다.
//   1) 전술 4축이 선수 좌표를 실제로 얼마나 바꾸는지
//   2) 하프타임 정지·후반 진영 교대
//   3) 세트피스(코너) 배치와 전개
//   4) 경고 누적 퇴장 · 부상 · 10명 수적 열세
//   5) 프레임 보간용 이전 좌표(px,py) 기록
//   6) 다경기 밸런스(득점·xG·코너·프리킥·골킥·파울·카드·부상)
// 사용: node scripts/fm-selftest.mjs [경기수]
import { createWorld } from '../src/world.js';
import { Match, lineupFor, applyResult } from '../src/match.js';

const N = Number(process.argv[2] || 24);
let fails = 0;
const ok = (cond, label, detail = '') => {
  console.log(`${cond ? '  ✅' : '  ❌'} ${label}${detail ? ` — ${detail}` : ''}`);
  if (!cond) fails += 1;
};

const world = createWorld('gs', 20261122);
const ids = Object.keys(world.teams);

function newMatch(homeId = 'gs', awayId = 'dj', seed = 'selftest') {
  const m = new Match({
    world, homeId, awayId,
    homeLineup: lineupFor(world, homeId),
    awayLineup: lineupFor(world, awayId),
    seed, cup: false, userSide: 'home',
  });
  m.holdHalf = true;
  return m;
}

/* ── 1. 전술 → 좌표 ── */
// 공을 중앙에 고정하고 '목표 좌표'만 계산해 네 축의 효과를 정확히 잽니다.
function shapeProbe(tactic, hasBall = true) {
  const m = newMatch('gs', 'dj', 'shape');
  m.sides.home.tactic = { line: 0, pass: 0, press: 0, route: 0, ...tactic };
  const side = m.sides.home;
  const gk = side.players.find((e) => e.onPitch && e.pos === 'GK');
  m.ball.x = 50; m.ball.y = 32;
  m.ball.owner = hasBall ? gk : m.sides.away.players.find((e) => e.onPitch && e.pos === 'MF');
  side._shape = m.computeShape(side, hasBall);
  side._pressers = hasBall ? [] : side.players.filter((e) => e.onPitch && e.pos !== 'GK')
    .sort((a, b) => Math.hypot(a.x - m.ball.x, a.y - m.ball.y) - Math.hypot(b.x - m.ball.x, b.y - m.ball.y));
  // 지원 패스 옵션(가장 가까운 두 명)은 공 옆으로 붙으므로 평균에서 제외합니다
  const mates = side.players.filter((e) => e.onPitch && e.pos !== 'GK' && e !== m.ball.owner)
    .sort((a, b) => Math.hypot(a.x - m.ball.x, a.y - m.ball.y) - Math.hypot(b.x - m.ball.x, b.y - m.ball.y));
  const skip = new Set(hasBall ? mates.slice(0, 2) : []);
  const out = { df: 0, mf: 0, fw: 0, wing: 0, pressN: side._shape.pressCount, shape: side._shape };
  const c = { df: 0, mf: 0, fw: 0, wing: 0 };
  for (const e of side.players) {
    if (!e.onPitch || e.pos === 'GK' || e === m.ball.owner || skip.has(e)) continue;
    const t = m.targetFor(e, side, hasBall);
    if (e.pos === 'DF') { out.df += t.x; c.df += 1; }
    if (e.pos === 'MF') { out.mf += t.x; c.mf += 1; }
    if (e.pos === 'FW') { out.fw += t.x; c.fw += 1; }
    if (e.pos === 'FW' && Math.abs(e.slot.y - 0.5) > 0.3) { out.wing += Math.abs(t.y - 32); c.wing += 1; }
  }
  for (const k of ['df', 'mf', 'fw', 'wing']) out[k] /= Math.max(c[k], 1);
  return out;
}

// 경기 중에도 실제로 그렇게 서는지 (압박 인원·라인 높이)
function liveProbe(tactic, ticks = 120) {
  const m = newMatch('gs', 'dj', `live-${JSON.stringify(tactic)}`);
  m.sides.home.tactic = { line: 0, pass: 0, press: 0, route: 0, ...tactic };
  m.sides.away.tactic = { line: 0, pass: 0, press: 0, route: 0 };
  let df = 0, press = 0, n = 0, pn = 0;
  for (let i = 0; i < ticks; i++) {
    m.tick();
    if (m.phase !== 'play') continue;
    const s = m.sides.home;
    if (Math.abs(m.ball.x - 50) < 16) df += s.players.filter((e) => e.onPitch && e.pos === 'DF').reduce((a, e) => a + e.x, 0) / 4;
    if (m.ball.owner && m.ball.owner.side === 'away') {
      // 실제로 '압박하러 달려든' 선수 수
      press += s.players.filter((e) => e.onPitch && e.press).length;
      pn += 1;
    }
    if (Math.abs(m.ball.x - 50) < 16) n += 1;
  }
  return { df: df / Math.max(n, 1), press: press / Math.max(pn, 1) };
}

console.log('\n[1] 전술 4축 → 좌표 변화');
{
  const low = shapeProbe({ line: -1 }), high = shapeProbe({ line: 1 });
  ok(high.df - low.df > 8, '높은 라인 vs 낮은 라인 — 수비 라인이 눈에 띄게 전진', `DF 목표 x ${low.df.toFixed(1)} → ${high.df.toFixed(1)} (Δ${(high.df - low.df).toFixed(1)})`);
  ok(high.mf - low.mf > 8, '높은 라인 — 미드필더도 함께 올라감', `MF 목표 x ${low.mf.toFixed(1)} → ${high.mf.toFixed(1)} (Δ${(high.mf - low.mf).toFixed(1)})`);
  const lowDef = shapeProbe({ line: -1 }, false), highDef = shapeProbe({ line: 1 }, false);
  ok(highDef.df - lowDef.df > 8, '수비 시에도 라인 높이 차이 유지(블록 형성)', `수비 DF ${lowDef.df.toFixed(1)} → ${highDef.df.toFixed(1)}`);
  const central = shapeProbe({ route: -1 }), wide = shapeProbe({ route: 1 });
  ok(wide.wing - central.wing > 5, '측면 집중 vs 중앙 — 윙어가 터치라인까지 벌어짐', `윙어 중앙이탈 ${central.wing.toFixed(1)} → ${wide.wing.toFixed(1)} (Δ${(wide.wing - central.wing).toFixed(1)})`);
  ok(central.fw - central.mf > 0 && wide.fw > central.fw - 12, '중앙 집중 시 공격수는 좁게, 측면 집중 시 폭을 씀');
  const pl = shapeProbe({ press: -1 }, false), ph = shapeProbe({ press: 1 }, false);
  ok(ph.pressN - pl.pressN >= 2, '강한 압박 — 볼 주변 압박 인원 1명 → 3명 이상', `${pl.pressN}명 → ${ph.pressN}명`);
  const passShort = shapeProbe({ pass: -1 }), passLong = shapeProbe({ pass: 1 });
  ok(Math.abs(passLong.fw - passShort.fw) > 3, '롱볼 vs 짧은 패스 — 최전방 높이 차이', `FW x ${passShort.fw.toFixed(1)} → ${passLong.fw.toFixed(1)}`);
  // 경기 안에서도 실제 좌표가 달라지는지
  const l1 = liveProbe({ line: -1 }), l2 = liveProbe({ line: 1 });
  ok(Math.abs(l2.df - l1.df) > 3, '경기 중 실제 수비 라인 위치도 달라짐', `DF x ${l1.df.toFixed(1)} → ${l2.df.toFixed(1)}`);
  const p1 = liveProbe({ press: -1 }), p2 = liveProbe({ press: 1 });
  ok(p2.press - p1.press > 0.5, '경기 중 볼 주변 압박 인원 차이', `${p1.press.toFixed(2)}명 → ${p2.press.toFixed(2)}명`);
}

/* ── 2. 하프타임 · 진영 교대 ── */
console.log('\n[2] 하프타임 · 진영 교대');
{
  const m = newMatch('gs', 'dj', 'half');
  let g = 0;
  while (m.phase !== 'half' && g < 2000) { m.tick(); g++; }
  ok(m.phase === 'half', '전반 종료 시 하프타임 진입', `${m.t}틱 / ${m.minute()}분`);
  const t0 = m.t;
  m.tick(); m.tick();
  ok(m.t === t0, '하프타임에는 경기 시간이 멈춤(감독이 전술·교체 정비)', `${t0} → ${m.t}`);
  const before = m.sides.home.dir;
  m.startSecondHalf();
  ok(m.half === 2 && m.sides.home.dir === -before && m.sides.away.dir === before, '후반 시작 시 양 팀 공격 방향 교대',
    `home ${before} → ${m.sides.home.dir}`);
  const dfX = m.sides.home.players.filter((e) => e.onPitch && e.pos === 'DF').reduce((a, e) => a + e.x, 0) / 4;
  ok(dfX > 100 - dfX, '후반 좌표가 실제로 반대편으로 이동', `home DF 평균 x ${dfX.toFixed(1)}`);
  ok(m.phase === 'play' && !!m.ball.owner, '후반 킥오프로 재개');
}

/* ── 3. 세트피스 ── */
console.log('\n[3] 세트피스');
{
  const m = newMatch('gs', 'dj', 'setpiece');
  for (let i = 0; i < 10; i++) m.tick();
  m.setPiece('corner', 'home', 99, 1);
  ok(m.phase === 'setpiece', '코너킥 선언');
  for (let i = 0; i < 3; i++) m.tick();
  const inBox = m.sides.home.players.filter((e) => e.onPitch && e.x > 84 && Math.abs(e.y - 32) < 23).length;
  ok(inBox >= 3, '코너 시 공격수들이 박스로 모임', `박스 안 ${inBox}명`);
  const defInBox = m.sides.away.players.filter((e) => e.onPitch && e.x > 82).length;
  ok(defInBox >= 5, '수비수들도 문전에 배치', `수비 ${defInBox}명`);
  // 배치가 끝나면 실제로 차서 흐름이 이어져야 합니다 (수비 걷어내기·파울로 새 세트피스가 나올 수 있음)
  let g = 0;
  while (m.phase === 'setpiece' && m.sp && m.sp.type === 'corner' && g < 20) { m.tick(); g++; }
  ok(!(m.phase === 'setpiece' && m.sp && m.sp.type === 'corner'), '준비 후 킥 전개', `phase=${m.phase}${m.sp ? ' · ' + m.sp.type : ''} · ${g}틱`);
}
{
  const m = newMatch('gs', 'dj', 'gk');
  for (let i = 0; i < 8; i++) m.tick();
  const s = m.stats();
  const before = s.goalKicks.home + s.goalKicks.away;
  const gk = m.goalKickSpot('away');
  m.setPiece('goalkick', 'away', gk.x, gk.y);
  for (let i = 0; i < 6; i++) m.tick();
  const after = m.stats().goalKicks.home + m.stats().goalKicks.away;
  ok(after === before + 1, '골킥 집계', `${before} → ${after}`);
}

/* ── 4. 카드 · 퇴장 · 부상 ── */
console.log('\n[4] 경고 · 퇴장 · 부상');
{
  const m = newMatch('gs', 'dj', 'cards');
  for (let i = 0; i < 10; i++) m.tick();
  const side = m.sides.home;
  const p = side.players.find((e) => e.onPitch && e.pos !== 'GK');
  m.giveCard(p, 'yellow');
  ok(p.st.yellow === 1 && p.onPitch, '옐로카드 1장 — 계속 출전');
  m.giveCard(p, 'yellow');
  ok(p.sentOff && !p.onPitch && side.players.filter((e) => e.onPitch).length === 10, '경고 누적 2장 → 퇴장·10명', `${side.players.filter((e) => e.onPitch).length}명`);
  ok(side.reds === 1 && side.stats.red === 1, '퇴장 기록 집계');
  const q = side.players.find((e) => e.onPitch && e.pos !== 'GK');
  const before = q.factor;
  m.injure(q, side, 'test');
  ok(q.injured && q.factor < before && side.stats.injuries === 1, '부상 — 능력치 저하와 부상 집계', `factor ${before.toFixed(2)} → ${q.factor.toFixed(2)}`);
  ok(m.events.some((e) => e.type === 'injury') && m.events.some((e) => e.type === 'card'), '중계 기록에 부상·카드 이벤트');
}

/* ── 4-2. 다음 경기 출전 정지 · 부상 결장 연결 ── */
console.log('\n[4-2] 다음 경기 출전 정지 · 부상');
{
  const m = newMatch('gs', 'dj', 'susp');
  for (let i = 0; i < 6; i++) m.tick();
  const side = m.sides[m.userSide];
  const victim = side.players.find((e) => e.onPitch && e.pos === 'DF');
  const hurt = side.players.find((e) => e.onPitch && e !== victim && e.pos === 'MF');
  m.giveCard(victim, 'red');
  m.injure(hurt, side, 'test');
  let g = 0;
  while (!m.done && g < 4000) { m.tick(); g++; }
  if (!m.done) m.finish();
  applyResult(world, m);
  const pv = world.players[victim.id], ph = world.players[hurt.id];
  ok(pv.bans === 1, '퇴장 → 다음 경기 출전 정지 1경기', `${pv.name} bans=${pv.bans}`);
  ok(ph.inj >= 1, '부상 → 결장 경기 수 기록', `${ph.name} inj=${ph.inj}`);
  const l = lineupFor(world, world.myTeamId);
  ok(!l.starters.includes(pv.id), '정지 선수는 다음 경기 선발에서 빠짐', `${pv.name}`);
  ok(!l.starters.includes(ph.id), '부상 선수도 선발에서 빠짐', `${ph.name}`);
}

/* ── 5. 보간용 이전 좌표 ── */
console.log('\n[5] 프레임 보간 데이터');
{
  const m = newMatch('gs', 'dj', 'lerp');
  for (let i = 0; i < 6; i++) m.tick();
  let moving = 0, total = 0;
  for (const s of ['home', 'away']) for (const e of m.sides[s].players) {
    if (!e.onPitch) continue;
    total += 1;
    if (Math.hypot(e.x - e.px, e.y - e.py) > 0.01) moving += 1;
  }
  ok(moving >= Math.min(10, total), '선수마다 이전 좌표(px,py)와 현재 좌표가 다름', `${moving}/${total}명 이동`);
  const b = m.ball;
  ok(Number.isFinite(b.px) && Number.isFinite(b.py), '공도 이전 좌표를 남김', `ball ${b.px.toFixed(2)},${b.py.toFixed(2)} → ${b.x.toFixed(2)},${b.y.toFixed(2)}`);
}

/* ── 6. 다경기 밸런스 ── */
console.log(`\n[6] 다경기 시뮬레이션 밸런스 (${N}경기)`);
{
  const acc = { goals: 0, xg: 0, shots: 0, onTarget: 0, corners: 0, fouls: 0, fk: 0, gk: 0, yellow: 0, red: 0, inj: 0, saves: 0 };
  const gd = [];
  for (let i = 0; i < N; i++) {
    const home = ids[i % ids.length];
    const away = ids[(i * 3 + 1) % ids.length];
    const m = new Match({
      world, homeId: home, awayId: away,
      homeLineup: lineupFor(world, home), awayLineup: lineupFor(world, away),
      seed: `bal-${i}`, cup: i % 6 === 0, userSide: 'home',
    });
    let g = 0;
    while (!m.done && g < 5000) { m.tick(); g++; }
    if (!m.done) m.finish();
    const s = m.stats(), sum = (k) => s[k].home + s[k].away;
    acc.goals += m.score.home + m.score.away;
    acc.xg += s.xg.home + s.xg.away;
    acc.shots += sum('shots'); acc.onTarget += sum('onTarget');
    acc.corners += sum('corners'); acc.fouls += sum('fouls');
    acc.fk += sum('freeKicks'); acc.gk += sum('goalKicks');
    acc.yellow += sum('yellow'); acc.red += sum('red'); acc.inj += sum('injuries');
    acc.saves += sum('saves');
    gd.push(m.score.home + m.score.away);
  }
  const avg = (k) => acc[k] / N;
  const show = (label, v, lo, hi) => ok(v >= lo && v <= hi, `${label} ${v.toFixed(2)} (현실 ${lo}~${hi})`);
  show('경기당 득점', avg('goals'), 2.2, 3.6);
  show('경기당 xG', avg('xg'), 2.0, 3.4);
  show('경기당 슈팅', avg('shots'), 16, 32);
  show('경기당 유효슈팅', avg('onTarget'), 6, 13);
  show('경기당 코너킥', avg('corners'), 6, 14);
  show('경기당 파울', avg('fouls'), 10, 28);
  show('경기당 프리킥', avg('fk'), 10, 28);
  show('경기당 골킥', avg('gk'), 6, 20);
  show('경기당 경고', avg('yellow'), 1.5, 6);
  show('경기당 퇴장', avg('red'), 0, 0.45);
  show('경기당 부상', avg('inj'), 0, 0.9);
  console.log(`  · 득점 분포: ${gd.join(', ')}`);
}

/* ── 7. 오픈 플레이 공간 분포 (중앙 과밀 해소) ── */
console.log('\n[7] 오픈 플레이 공간 분포');
{
  const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
  const acc = { frames: 0, nn: 0, nnN: 0, close: 0, pairN: 0, swarm: 0, cluster: 0 };
  for (let i = 0; i < 6; i++) {
    const m = newMatch('gs', 'dj', `space-${i}`);
    m.holdHalf = false;      // 전·후반 전체를 재야 공간 분포가 대표성을 가집니다
    let g = 0;
    while (!m.done && g < 4000) {
      m.tick(); g++;
      if (m.phase !== 'play' || !m.ball.owner) continue;
      for (const s of ['home', 'away']) {
        const ps = m.sides[s].players.filter((e) => e.onPitch);
        const out = ps.filter((e) => e.pos !== 'GK');
        for (const e of ps) {
          let nn = 1e9;
          for (const o of ps) if (o !== e) nn = Math.min(nn, dist(o, e));
          acc.nn += nn; acc.nnN += 1;
        }
        for (let a = 0; a < out.length; a++) for (let b = a + 1; b < out.length; b++) {
          acc.pairN += 1;
          if (dist(out[a], out[b]) < 4) acc.close += 1;
        }
        acc.swarm += ps.filter((e) => dist(e, m.ball) < 6).length;
        let worst = 0;
        for (const e of out) worst = Math.max(worst, out.filter((o) => o !== e && dist(o, e) < 5).length);
        acc.cluster += worst;
      }
      acc.frames += 1;
    }
  }
  const nn = acc.nn / Math.max(acc.nnN, 1);
  const closePct = (acc.close / Math.max(acc.pairN, 1)) * 100;
  const swarm = acc.swarm / Math.max(acc.frames, 1);
  const cluster = acc.cluster / Math.max(acc.frames, 1);
  ok(closePct < 2.5, '같은 팀 선수가 4u 안에 겹치는 비율 낮음', `${closePct.toFixed(1)}% (개선 전 5%대)`);
  ok(nn > 8, '최근접 동료와의 간격 충분', `평균 ${nn.toFixed(2)}u`);
  ok(swarm < 3.2, '공 주변에 몰리는 선수가 적당', `평균 ${swarm.toFixed(2)}명`);
  ok(cluster < 3.2, '한 선수 주변 5u 안에 동료가 몰리지 않음', `최대 ${cluster.toFixed(2)}명`);
}

/* ── 8. 전술별 전개 패턴·공간 분포 차이 ── */
console.log('\n[8] 전술별 패스 패턴·공간');
{
  const mix = (preset, n = 12) => {
    const a = { len: 0, sw: 0, th: 0, gg: 0, cb: 0, cr: 0, width: 0, depth: 0, wide: 0, pass: 0, goals: 0 };
    for (let i = 0; i < n; i++) {
      const m = newMatch('gs', 'dj', `mix-${JSON.stringify(preset)}-${i}`);
      if (preset) m.sides.home.tactic = { line: 0, pass: 0, press: 0, route: 0, ...preset };
      m.holdHalf = false;
      let g = 0;
      while (!m.done && g < 4000) { m.tick(); g++; }
      if (!m.done) m.finish();
      const s = m.stats();
      const nAtt = s.passAtt.home || 1;
      a.len += s.passLen.home / n;
      a.sw += (s.patterns.switch.home / nAtt) * 100 / n;
      a.th += (s.patterns.through.home / nAtt) * 100 / n;
      a.gg += (s.patterns.givego.home / nAtt) * 100 / n;
      a.cb += (s.patterns.cutback.home / nAtt) * 100 / n;
      a.cr += (s.patterns.cross.home / nAtt) * 100 / n;
      a.width += s.width.home / n;
      a.depth += s.depth.home / n;
      a.wide += s.wideShare.home / n;
      a.pass += nAtt / n;
      a.goals += (m.score.home + m.score.away) / n;
    }
    return a;
  };
  const bal = mix(null);
  const shortC = mix({ pass: -1, route: -1 });
  const longW = mix({ pass: 1, route: 1 });
  const highP = mix({ line: 1, press: 1 });
  const lowP = mix({ line: -1, press: -1 });
  const f = (v) => v.toFixed(1);
  ok(longW.len - shortC.len > 8, '롱볼 vs 짧은 패스 — 평균 패스 거리가 뚜렷이 다름', `${f(shortC.len)}u → ${f(longW.len)}u`);
  ok(longW.sw - shortC.sw > 8, '롱볼·측면은 사이드 전환이 훨씬 많음', `전환 ${f(shortC.sw)}% → ${f(longW.sw)}%`);
  ok(shortC.gg >= bal.gg * 0.6, '짧은 패스 축은 원투(원-투) 연계를 유지', `원투 ${f(shortC.gg)}% (기준 ${f(bal.gg)}%)`);
  ok(longW.cb + longW.cr > shortC.cb + shortC.cr, '측면 루트는 크로스·컷백이 더 많음', `크로스+컷백 ${f(shortC.cb + shortC.cr)}% → ${f(longW.cb + longW.cr)}%`);
  ok(longW.width - shortC.width > 1.2, '측면 루트는 선수 평균 폭이 넓음', `폭 ${f(shortC.width)}u → ${f(longW.width)}u`);
  ok(longW.wide - shortC.wide > 8, '측면 루트는 공이 측면에 머무는 시간이 길다', `측면 점유 ${f(shortC.wide)}% → ${f(longW.wide)}%`);
  ok(highP.depth - lowP.depth > 3, '높은 라인은 평균 깊이(진행도)가 높음', `깊이 ${f(lowP.depth)}u → ${f(highP.depth)}u`);
  ok(bal.th > 2, '기본 전개에도 스루패스가 나옴', `스루 ${f(bal.th)}%`);
  // 네 축을 바꿨을 때 득점이 한쪽으로 무너지지 않는지
  const gl = [bal, shortC, longW, highP, lowP].map((x) => x.goals);
  ok(Math.max(...gl) - Math.min(...gl) < 2.2, '전술별 득점 편차가 과하지 않음', gl.map(f).join(' / '));
}

console.log(`\n${fails ? `❌ ${fails}개 점검 실패` : '✅ 모든 점검 통과'}\n`);
process.exit(fails ? 1 : 0);
