#!/usr/bin/env node
// 공간·패스 패턴 계측 — 오픈 플레이 겹침(중앙 밀집)과 전술별 전개 양상을 잽니다.
// 사용: node scripts/fm-patterns.mjs [경기수]
//   · 겹침: 같은 팀 선수끼리 4u 이내로 붙은 비율, 최근접 동료 거리, 한 선수 주변 5u 몰림
//   · 패턴: 패스 거리·종류(사이드 전환/스루/원투/컷백/크로스), 드리블 판단 횟수
//   · 공간: 팀 평균 폭(|y-CY|)·깊이(진행도), 공이 측면에 있는 시간 비율
// 전술 4축의 극단값을 각각 돌려 '체감 차이'를 숫자로 비교합니다.
import { createWorld } from '../src/world.js';
import { Match, lineupFor } from '../src/match.js';

const N = Number(process.argv[2] || 6);
const world = createWorld('gs', 20261122);
const DIST = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);

function probe(tactic, seed) {
  const m = new Match({
    world, homeId: 'gs', awayId: 'dj',
    homeLineup: lineupFor(world, 'gs'), awayLineup: lineupFor(world, 'dj'),
    seed, cup: false, userSide: 'home',
  });
  if (tactic) m.sides.home.tactic = { line: 0, pass: 0, press: 0, route: 0, ...tactic };
  const acc = { frames: 0, nn: 0, nnN: 0, close: 0, pairN: 0, swarm: 0, cluster: 0, wide: 0 };
  let guard = 0;
  while (!m.done && guard < 9000) {
    m.tick(); guard++;
    if (m.phase !== 'play' || !m.ball.owner) continue;
    const b = m.ball;
    for (const s of ['home', 'away']) {
      const ps = m.sides[s].players.filter((e) => e.onPitch);
      const out = ps.filter((e) => e.pos !== 'GK');
      for (const e of ps) {
        let nn = 1e9;
        for (const o of ps) if (o !== e) nn = Math.min(nn, DIST(o, e));
        acc.nn += nn; acc.nnN += 1;
      }
      for (let i = 0; i < out.length; i++) for (let j = i + 1; j < out.length; j++) {
        acc.pairN += 1;
        if (DIST(out[i], out[j]) < 4) acc.close += 1;
      }
      acc.swarm += ps.filter((e) => DIST(e, b) < 6).length;
      // 한 선수 주변 5u 안에 동료가 몇 명까지 몰리는지
      let worst = 0;
      for (const e of out) {
        const near = out.filter((o) => o !== e && DIST(o, e) < 5).length;
        if (near > worst) worst = near;
      }
      acc.cluster += worst;
    }
    acc.frames += 1;
    if (Math.abs(b.y - 32) > 14) acc.wide += 1;
  }
  if (!m.done) m.finish();
  const s = m.stats();
  return { acc, s, goals: m.score.home + m.score.away };
}

function run(name, preset, n = N) {
  const agg = {
    nn: 0, close: 0, swarm: 0, cluster: 0, wide: 0, goals: 0,
    passLen: 0, long: 0, sw: 0, th: 0, gg: 0, cb: 0, cr: 0, passN: 0,
    width: 0, depth: 0, dribble: 0,
  };
  for (let i = 0; i < n; i++) {
    const { acc, s, goals } = probe(preset, `pat-${JSON.stringify(preset)}-${i}`);
    agg.nn += acc.nn / Math.max(acc.nnN, 1) / n;
    agg.close += (acc.close / Math.max(acc.pairN, 1)) * 100 / n;
    agg.swarm += acc.swarm / Math.max(acc.frames, 1) / n;
    agg.cluster += acc.cluster / Math.max(acc.frames, 1) / n;
    agg.wide += (acc.wide / Math.max(acc.frames, 1)) * 100 / n;
    agg.goals += goals / n;
    const h = s.patterns;
    const homePass = s.passAtt.home || 1;
    agg.passN += homePass / n;
    agg.passLen += s.passLen.home / n;
    agg.long += (h.long.home / homePass) * 100 / n;
    agg.sw += (h.switch.home / homePass) * 100 / n;
    agg.th += (h.through.home / homePass) * 100 / n;
    agg.gg += (h.givego.home / homePass) * 100 / n;
    agg.cb += (h.cutback.home / homePass) * 100 / n;
    agg.cr += (h.cross.home / homePass) * 100 / n;
    agg.width += s.width.home / n;
    agg.depth += s.depth.home / n;
    agg.dribble += (s.dribble?.home ?? 0) / n;
  }
  console.log(`\n[${name}] 겹침: 최근접 ${agg.nn.toFixed(2)}u · 4u이내 쌍 ${agg.close.toFixed(1)}% · 5u 몰림 최대 ${agg.cluster.toFixed(2)}명 · 공주변 ${agg.swarm.toFixed(2)}명`);
  console.log(`  공간: 폭 ${agg.width.toFixed(1)}u · 깊이 ${agg.depth.toFixed(1)}u · 측면 시간 ${agg.wide.toFixed(0)}% · 득점 ${agg.goals.toFixed(1)}`);
  console.log(`  패스: ${agg.passN.toFixed(0)}개 · 평균 ${agg.passLen.toFixed(1)}u · 30u+ ${agg.long.toFixed(0)}% · 전환 ${agg.sw.toFixed(0)}%`
    + ` · 스루 ${agg.th.toFixed(0)}% · 원투 ${agg.gg.toFixed(0)}% · 컷백 ${agg.cb.toFixed(0)}% · 크로스 ${agg.cr.toFixed(0)}% · 드리블 ${agg.dribble.toFixed(0)}회`);
  return agg;
}

const PRESETS = [
  ['균형', null],
  ['짧은패스·중앙', { pass: -1, route: -1 }],
  ['롱볼·측면', { pass: 1, route: 1 }],
  ['높은라인·강압박', { line: 1, press: 1 }],
  ['낮은라인·대기', { line: -1, press: -1 }],
  ['잠그기', { mentality: -1 }],
  ['총공세', { mentality: 1 }],
];

console.log(`\n=== 공간·패스 패턴 계측 (전술당 ${N}경기) ===`);
for (const [name, preset] of PRESETS) run(name, preset);
console.log('');
