// 2D 바둑알 매치 엔진 — 90분을 360틱(1분=4틱)으로 시뮬레이션
// 화면(DOM)에 의존하지 않으므로 '즉시 결과'에서도 그대로 돌릴 수 있습니다.
import { makeRng, clamp, rint, gauss } from './rng.js';
import { FORMATIONS } from './data.js';
import { posFactor, autoLineup, squadOf } from './world.js';

export const W = 100, H = 64, CY = 32, GOAL_HALF = 3.7;
const TICKS = 360, TICKS_ET = 480;
const SUBSTEPS = 3;

const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
// 골문 쪽으로 얼마나 전진했는지 (0=자기 골문, 100=상대 골문)
const prog = (x, dir) => (dir > 0 ? x : W - x);

function makeEntity(world, pid, slot, dir, side) {
  const p = world.players[pid];
  if (!p) return null;
  return {
    p, id: pid, name: p.name, num: p.num, pos: slot.pos, label: slot.label, slot, dir, side,
    x: 0, y: 0, stamina: 100, rating: 6.0, rd: 0,
    st: { goals: 0, assists: 0, shots: 0, onTarget: 0, saves: 0, tackles: 0, passes: 0, passOk: 0, keyPasses: 0, yellow: 0, red: 0, minutes: 0 },
    decCd: 0, tackleCd: 0, factor: posFactor(slot.pos, p.pos),
    rx: 0, ry: 0, rt: 0, onPitch: true, x0: 0, y0: 0, vx: 0, vy: 0, touched: 0,
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
    this.lastEventId = 0;
    this.pens = null;
    this.aet = false;
    this.total = cup ? TICKS : TICKS;
    this.sides = {
      home: this.buildSide(homeId, homeLineup, 1, 'home'),
      away: this.buildSide(awayId, awayLineup, -1, 'away'),
    };
    this.ball = { x: W / 2, y: CY, owner: null, mode: 'carry', from: null, to: null, t: 0, dur: 0, passer: null, receiver: null, cross: false, tx: 0, ty: 0, vx: 0, vy: 0, lastShot: null };
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
      e.x0 = e.x; e.y0 = e.y;
    }
    const bench = (lineup.bench || []).map((pid) => {
      const e = makeEntity(this.world, pid, { pos: this.world.players[pid]?.pos || 'MF', label: 'SUB', x: 0.5, y: 0.5 }, dir, side);
      if (e) { e.onPitch = false; e.x = dir > 0 ? W * 0.1 : W * 0.9; e.y = CY; }
      return e;
    }).filter(Boolean);
    return {
      name: side, teamId, dir, team, formation: lineup.formation || '4-3-3',
      tactic: { line: 0, pass: 0, press: 0, route: 0, ...(lineup.tactic || team.tactic) },
      players: starters, bench, subsUsed: 0,
      stats: { shots: 0, onTarget: 0, xg: 0, possTicks: 0, passes: 0, passOk: 0, tackles: 0, saves: 0, corners: 0, shotDist: 0 },
    };
  }

  /* ───────────── 기본 도우미 ───────────── */
  get opposing() { return { home: 'away', away: 'home' }; }
  sideOf(e) { return e.side; }
  eff(e, key) {
    const base = e.p.stats[key] || 30;
    const sf = 0.7 + 0.3 * (e.stamina / 100);
    return base * sf * e.factor;
  }
  minute() { return Math.min(90 + (this.aet ? 30 : 0), Math.floor(this.t / 4) + 1); }
  clock() {
    const m = Math.min(this.aet ? 120 : 90, Math.floor(this.t / 4));
    return `${String(m).padStart(2, '0')}'`;
  }
  pushEvent(ev) {
    ev.id = ++this.lastEventId;
    ev.minute = this.minute();
    this.lastEventId = ev.id;
    this.events.push(ev);
    if (ev.text) {
      this.commentary.unshift({ id: ev.id, minute: ev.minute, text: ev.text, type: ev.type || 'info', side: ev.side || null });
      if (this.commentary.length > 60) this.commentary.pop();
    }
  }

  startPossession(sideName, reason = '') {
    const side = this.sides[sideName];
    const mids = side.players.filter((e) => e.pos === 'MF');
    const carrier = mids.length ? mids[Math.floor(this.rng() * mids.length)] : side.players.find((e) => e.pos !== 'GK') || side.players[0];
    if (!carrier) return;
    // 중앙 근처로 위치 보정 (킥오프/재개)
    if (reason === 'kickoff' || reason === 'goal') {
      for (const e of side.players) { e.x = e.dir > 0 ? e.slot.x * W : W - e.slot.x * W; e.y = e.slot.y * H; }
      for (const e of this.sides[this.opposing[sideName]].players) { e.x = e.dir > 0 ? e.slot.x * W : W - e.slot.x * W; e.y = e.slot.y * H; }
      carrier.x = 48; carrier.y = CY;
    }
    this.ball.owner = carrier;
    this.ball.mode = 'carry';
    this.ball.x = carrier.x; this.ball.y = carrier.y;
    this.possessionStart = this.t;
  }

  /* ───────────── 틱 ───────────── */
  tick() {
    if (this.done) return;
    if (this.pause > 0) {
      this.pause -= 1;
      this.updateStamina(true);
      if (this.pause === 0 && this.phase === 'goal' && this.pendingRestart) {
        this.startPossession(this.pendingRestart, 'goal');
        this.pendingRestart = null;
        this.phase = 'play';
      }
      return;
    }
    this.t += 1;
    // 한 틱(=경기 15초) 안에서 두 번의 플레이 단계를 돌린다 — 패스·슛이 더 자주 나온다
    for (let i = 0; i < SUBSTEPS; i++) {
      this.updateStamina(false);
      this.updateDrift();
      this.thinkCarrier();
      this.movePlayers();
      this.moveBall();
      if (this.pause > 0) break;
      this.contests();
      this.countPossession();
      if (this.done) return;
    }
    this.aiAdjust();

    if (this.t === 180 && !this.aet) {
      this.pause = 6;
      this.phase = 'half';
      this.pushEvent({ type: 'half', text: `전반 종료 — ${this.scoreText()}` });
    }
    if (!this.aet && this.t >= TICKS) {
      if (this.cup && this.score.home === this.score.away) {
        this.aet = true;
        this.total = TICKS_ET;
        this.pause = 4;
        this.pushEvent({ type: 'aet', text: `연장전 돌입 — ${this.scoreText()}` });
      } else {
        this.finish();
      }
    } else if (this.aet && this.t >= TICKS_ET) {
      if (this.score.home === this.score.away) this.shootout();
      this.finish();
    }
  }

  scoreText() { return `${this.world.teams[this.homeId].short} ${this.score.home} - ${this.score.away} ${this.world.teams[this.awayId].short}`; }

  finish() {
    if (this.done) return;
    this.done = true;
    this.phase = 'full';
    const winner = this.pens ? this.pens.winner : this.score.home > this.score.away ? 'home' : this.score.home < this.score.away ? 'away' : null;
    this.result = { hg: this.score.home, ag: this.score.away, winner, pens: this.pens };
    this.pushEvent({ type: 'full', text: `경기 종료 — ${this.scoreText()}${this.pens ? ` (승부차기 ${this.pens.text} ${winner === 'home' ? this.world.teams[this.homeId].short : this.world.teams[this.awayId].short} 승)` : ''}` });
    this.settlePlayers();
  }

  shootout() {
    const order = ['home', 'away'];
    const kicks = { home: [], away: [] };
    const takers = (s) => this.sides[s].players.filter((e) => e.pos !== 'GK').sort((a, b) => this.eff(b, 'sho') - this.eff(a, 'sho')).slice(0, 5);
    for (let round = 0; round < 5; round++) {
      for (const s of order) {
        const taker = takers(s)[round % 5];
        const gk = this.sides[this.opposing[s]].players.find((e) => e.pos === 'GK');
        const pGoal = clamp(0.62 + this.eff(taker, 'sho') / 320 - this.eff(gk, 'gk') / 380, 0.45, 0.92);
        const goal = this.rng() < pGoal;
        kicks[s].push(goal ? 'O' : 'X');
        if (goal) { taker.st.assists += 0; taker.rd += 0.05; }
        else if (gk) gk.rd += 0.12;
        this.pushEvent({ type: 'pen', side: s, text: `승부차기 ${round + 1}번째 — ${taker.name} ${goal ? '성공' : '실패'}` });
      }
    }
    let h = kicks.home.filter((x) => x === 'O').length, a = kicks.away.filter((x) => x === 'O').length;
    let guard = 0;
    while (h === a && guard < 10) {
      guard++;
      for (const s of order) {
        const taker = takers(s)[guard % 5];
        const gk = this.sides[this.opposing[s]].players.find((e) => e.pos === 'GK');
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
      for (const e of this.sides[s].players) if (e.onPitch) e.st.minutes = Math.max(1, this.minute());
    }
  }

  /* ───────────── 체력 ───────────── */
  updateStamina(paused) {
    for (const s of ['home', 'away']) {
      const press = this.sides[s].tactic.press || 0;
      for (const e of this.sides[s].players) {
        if (!e.onPitch) continue;
        const moved = e.moved || 0;
        if (paused) { e.stamina = clamp(e.stamina + 0.02, 0, 100); continue; }
        const drain = (0.004 + moved * 0.011) * (1.72 - e.p.stats.sta * 0.009) * (1 + Math.max(0, press) * 0.16) / SUBSTEPS;
        e.stamina = clamp(e.stamina - drain, 0, 100);
      }
    }
  }

  updateDrift() {
    for (const s of ['home', 'away']) {
      for (const e of this.sides[s].players) {
        e.rt -= 1;
        if (e.rt <= 0) {
          e.rt = rint(this.rng, 14, 34);
          e.rx = (this.rng() - 0.5) * 5;
          e.ry = (this.rng() - 0.5) * 5;
        }
      }
    }
  }

  countPossession() {
    if (this.ball.owner) {
      const side = this.sides[this.ball.owner.side];
      side.stats.possTicks += 1;
      const p = prog(this.ball.x, side.dir);
      side.stats.ballX = (side.stats.ballX || 0) + p;
      if (p > 66) side.stats.finalTicks = (side.stats.finalTicks || 0) + 1;
      if (p > 82 && Math.abs(this.ball.y - CY) < 16) side.stats.boxTicks = (side.stats.boxTicks || 0) + 1;
    }
  }

  /* ───────────── 이동 ───────────── */
  movePlayers() {
    const owningSide = this.ball.owner ? this.ball.owner.side : null;
    for (const s of ['home', 'away']) {
      const side = this.sides[s];
      const hasBall = owningSide === s;
      for (const e of side.players) {
        if (!e.onPitch) continue;
        const tgt = this.targetFor(e, side, hasBall);
        const dx = tgt.x - e.x, dy = tgt.y - e.y;
        const d = Math.hypot(dx, dy);
        let sp = (0.42 + this.eff(e, 'spd') / 100 * 0.62);
        if (e === this.ball.owner) sp *= 1.06;
        else if (e.press) sp *= 1.12;
        if (e.pos === 'GK') sp *= 0.8;
        const step = Math.min(d, sp);
        if (d > 0.05) {
          e.x0 = e.x; e.y0 = e.y;
          e.x += (dx / d) * step;
          e.y += (dy / d) * step;
          e.moved = step;
        } else e.moved = 0;
        e.x = clamp(e.x, 1, W - 1); e.y = clamp(e.y, 1, H - 1);
        e.press = false;
      }
    }
  }

  targetFor(e, side, hasBall) {
    const ball = this.ball;
    const dir = side.dir;
    if (e.pos === 'GK') {
      const gx = dir > 0 ? 3 : W - 3;
      const ty = clamp(CY + (ball.y - CY) * 0.55, CY - 8, CY + 8);
      const rush = ball.x < 20 && dir < 0 && Math.abs(ball.x - gx) < 16 ? 4 : 0;
      return { x: gx + dir * rush, y: ty };
    }
    const baseY = e.slot.y * H;
    const ballP = prog(ball.x, dir);
    const line = side.tactic.line || 0;
    let p, ty;

    if (hasBall) {
      if (e.pos === 'DF') p = 24 + (ballP - 50) * 0.28;
      else if (e.pos === 'MF') p = 45 + (ballP - 50) * 0.30;
      else p = 74 + (ballP - 50) * 0.16;
      if (e.pos === 'FW' && ballP > 58) p += 12;     // 박스 침투
      p += line * 6;
      ty = baseY * 0.76 + CY * 0.24 + (ball.y - CY) * 0.22;
    } else {
      if (e.pos === 'DF') p = 19 + (ballP - 50) * 0.34;
      else if (e.pos === 'MF') p = 35 + (ballP - 50) * 0.34;
      else p = 53 + (ballP - 50) * 0.22;
      p += line * 5;
      ty = baseY * 0.70 + CY * 0.30 + (ball.y - CY) * 0.26;
    }

    if (!hasBall) {
      // 수비: 공에 가까운 선수들이 압박
      const press = side.tactic.press || 0;
      const numPress = press > 0.35 ? 3 : 2;
      const sorted = side.players.filter((x) => x.pos !== 'GK').sort((a, b) => dist(a, ball) - dist(b, ball));
      const idx = sorted.indexOf(e);
      if (idx >= 0 && idx < numPress && dist(e, ball) < 34) {
        e.press = true;
        return { x: clamp(ball.x + dir * 0.6, 2, W - 2), y: clamp(ball.y, 3, H - 3) };
      }
      if (idx === numPress) {
        return { x: (ball.x + (dir > 0 ? 0 : W)) / 2, y: (ball.y + CY) / 2 };
      }
    } else if (e === this.ball.owner) {
      return this.carrierTarget(e);
    } else {
      // 패스 옵션: 공 소유자와 가까운 두 명이 지원
      const mates = side.players.filter((x) => x.onPitch && x !== this.ball.owner && x.pos !== 'GK');
      mates.sort((a, b) => dist(a, ball) - dist(b, ball));
      const rank = mates.indexOf(e);
      if (rank >= 0 && rank < 2 && ballP > 35) {
        const sideSign = e.slot.y < 0.5 ? -1 : 1;
        return {
          x: clamp(ball.x + dir * (7 + rank * 5), 4, W - 4),
          y: clamp(ball.y + sideSign * (11 - rank * 3), 6, H - 6),
        };
      }
      const ahead = (e.x - ball.x) * dir;
      if (e.pos === 'FW' && ahead < 4) p += 5;
      ty = ty * 0.7 + ball.y * 0.3;
    }
    p = clamp(p + (e.rx || 0) * 0.8, 6, hasBall ? 91 : 88);
    ty = clamp(ty + (e.ry || 0) * 0.8, 4, H - 4);
    return { x: dir > 0 ? p : W - p, y: ty };
  }

  carrierTarget(e) {
    const dir = e.dir;
    const opp = this.sides[this.opposing[e.side]].players.filter((x) => x.onPitch);
    let nearest = null, nd = 1e9;
    for (const o of opp) { const d = dist(o, e); if (d < nd) { nd = d; nearest = o; } }
    const p = prog(e.x, dir);
    let ty = e.y + (CY - e.y) * 0.07;
    if (nearest && nd < 9) ty += e.y - nearest.y > 0 ? 3 : -3;
    if (p > 52) ty += (CY - e.y) * 0.16;
    const wide = this.sides[e.side].tactic.route || 0;
    if (wide > 0.3 && p > 55 && e.pos === 'FW') ty += e.y < CY ? -1.6 : 1.6;
    return { x: clamp(e.x + dir * (p > 68 ? 6 : 4), 2, W - 2), y: clamp(ty, 3, H - 3) };
  }

  /* ───────────── 공 소유자의 판단 ───────────── */
  pressureOn(e) {
    const opp = this.sides[this.opposing[e.side]].players;
    let n = 0;
    for (const o of opp) { if (o.onPitch && dist(o, e) < 6.5) n += 1; }
    return n;
  }

  thinkCarrier() {
    const ball = this.ball;
    if (ball.mode !== 'carry' || !ball.owner) return;
    const c = ball.owner;
    c.decCd -= 1;
    if (c.decCd > 0) return;
    const gx = c.dir > 0 ? W : 0;
    const dGoal = Math.hypot(gx - c.x, CY - c.y);
    const pressure = this.pressureOn(c);
    const side = this.sides[c.side];

    // 슈팅
    if (c.pos !== 'GK' && dGoal < 27) {
      const angle = 1 - Math.abs(c.y - CY) / H;
      let urge = clamp((25 - dGoal) / 24, 0, 1) * 0.8 * (this.eff(c, 'sho') / 70) * angle;
      if (side.tactic.route < -0.4) urge *= 1.2;
      urge *= 1 - Math.min(pressure, 3) * 0.14;
      if (this.rng() < clamp(urge, 0.01, 0.72)) return this.shoot(c, dGoal, pressure);
    }

    // 패스
    const best = this.bestPass(c, pressure);
    if (best) {
      let passP = clamp(0.5 + pressure * 0.08 + best.score * 0.06, 0.15, 0.96);
      if (best.score < 0.6) passP *= 0.5;
      if (this.rng() < passP) return this.passTo(c, best.mate, best.cross);
    }
    // 드리블 지속
    c.decCd = rint(this.rng, 1, 2);
  }

  bestPass(c, pressure) {
    const side = this.sides[c.side];
    const opp = this.sides[this.opposing[c.side]].players.filter((e) => e.onPitch);
    const style = side.tactic.pass || 0;
    const route = side.tactic.route || 0;
    let best = null;
    for (const m of side.players) {
      if (!m.onPitch || m === c) continue;
      if (m.pos === 'GK') continue;
      const dx = m.x - c.x, dy = m.y - c.y;
      const d = Math.hypot(dx, dy);
      if (d < 4 || d > 68) continue;
      const forward = (dx * c.dir) / Math.max(d, 0.001);
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
      let score = forward * 1.55 - d * 0.012 - risk * 1.7 + Math.min(open, 12) * 0.12;
      score += (m.pos === 'FW' ? 0.15 : 0) + (m.pos === 'MF' ? 0.08 : 0);
      score += this.rng() * 0.7;
      if (style < 0) score += clamp(28 - d, -24, 14) * 0.028; // 짧은 패스 선호
      if (style > 0) score += clamp(d - 26, -20, 30) * 0.022; // 롱볼 선호
      const mProg = prog(m.x, c.dir);
      const inFinal = mProg > 62;
      const inBox = mProg > 78 && Math.abs(m.y - CY) < 15;
      if (inBox) score += 0.6;
      if (route > 0.3 && inFinal && Math.abs(m.y - CY) > 14) score += 0.5; // 측면 크로스
      if (route < -0.3 && inFinal && Math.abs(m.y - CY) < 14) score += 0.45; // 중앙
      if (forward < -0.2) score -= 0.7; // 뒤로 패스는 최후
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
    ball.mode = 'pass';
    ball.from = { x: c.x, y: c.y };
    ball.to = { x: m.x + m.vx * 0.5, y: m.y };
    ball.t = 0;
    ball.dur = clamp(Math.round(d / 30), 1, 3);
    ball.passer = c;
    ball.receiver = m;
    ball.cross = !!cross;
    ball.owner = null;
    ball.travel = 0;
    c.decCd = rint(this.rng, 0, 1);
    c.st.passes += 1;
    this.sides[c.side].stats.passes += 1;
    this.lastPass = { from: c, to: m, t: this.t };
  }

  /* ───────────── 슈팅 ───────────── */
  xgFor(c, dGoal, pressure) {
    const angle = 1 - Math.abs(c.y - CY) / 42;
    const base = 1.1 * Math.exp(-dGoal / 8.6) * clamp(angle, 0.15, 1);
    const skill = 0.72 + this.eff(c, 'sho') / 210;
    const press = 1 - Math.min(pressure, 3) * 0.11;
    return clamp(base * skill * press, 0.02, 0.72);
  }

  shoot(c, dGoal, pressure, header = false) {
    const side = this.sides[c.side];
    const gx = c.dir > 0 ? W : 0;
    const xg = this.xgFor(c, dGoal, pressure) * (header ? 0.75 : 1);
    const aimY = CY + (this.rng() - 0.5) * 9;
    const ball = this.ball;
    ball.mode = 'shot';
    ball.from = { x: c.x, y: c.y };
    ball.to = { x: gx, y: aimY };
    ball.t = 0;
    ball.dur = clamp(Math.round(dGoal / 26), 1, 3);
    ball.owner = null;
    ball.shot = { shooter: c, xg, pressure, header };
    ball.passer = null;
    c.st.shots += 1;
    side.stats.shots += 1;
    side.stats.xg += xg;
    side.stats.shotDist += dGoal;
    c.decCd = 2;
    // 도움 기록 후보
    if (this.lastPass && this.t - this.lastPass.t <= 6 && this.lastPass.from.side === c.side) {
      this.assistCand = this.lastPass.from;
      this.lastPass.from.st.keyPasses += 1;
      this.lastPass.from.rd += 0.06;
    } else this.assistCand = null;
    this.pushEvent({ type: 'shot', side: c.side, text: `${c.name} 슛! (xG ${xg.toFixed(2)})` });
  }

  resolveShot() {
    const ball = this.ball;
    const s = ball.shot;
    if (!s) { ball.mode = 'loose'; ball.owner = null; return; }
    const c = s.shooter;
    const side = this.sides[c.side];
    const oppSide = this.sides[this.opposing[c.side]];
    const gk = oppSide.players.find((e) => e.pos === 'GK' && e.onPitch);
    const r = this.rng();
    const onTargetP = clamp(0.36 + this.eff(c, 'sho') / 260 + (33 - Math.hypot((c.dir > 0 ? W : 0) - c.x, CY - c.y)) / 70 - s.pressure * 0.06, 0.18, 0.9);
    if (r < s.xg) {
      // 골
      this.goal(c, s);
      return;
    }
    if (r < s.xg + onTargetP * 0.62) {
      // 유효슈팅 — 골키퍼 선방
      side.stats.onTarget += 1;
      if (gk) { gk.st.saves += 1; gk.rd += 0.16; oppSide.stats.saves += 1; }
      c.st.onTarget += 1;
      c.rd += 0.04;
      this.pushEvent({ type: 'save', side: c.side, text: `${gk ? gk.name : '골키퍼'} 선방! ${c.name}의 슛을 막아냅니다.` });
      // 리바운드: 절반은 공격수 앞으로 흘러 다시 기회
      const gx2 = c.dir > 0 ? W : 0;
      const atk = side.players.filter((e) => e.onPitch && e.pos !== 'GK' && Math.hypot(gx2 - e.x, CY - e.y) < 18);
      if (atk.length && this.rng() < 0.5) {
        atk.sort((a, b2) => Math.hypot(gx2 - a.x, CY - a.y) - Math.hypot(gx2 - b2.x, CY - b2.y));
        const r2 = atk[0];
        this.ball.owner = r2; this.ball.mode = 'carry'; this.ball.x = r2.x; this.ball.y = r2.y; r2.decCd = 0;
        this.pushEvent({ type: 'rebound', side: c.side, text: `리바운드! ${r2.name}에게 흘러갑니다.` });
        return;
      }
      this.ball.owner = gk || oppSide.players.find((e) => e.pos !== 'GK') || oppSide.players[0];
      if (this.ball.owner) { this.ball.owner.decCd = 2; this.ball.mode = 'carry'; this.ball.x = this.ball.owner.x; this.ball.y = this.ball.owner.y; }
      else this.ball.mode = 'loose';
    } else {
      this.pushEvent({ type: 'miss', side: c.side, text: `${c.name}의 슛이 골문을 벗어납니다.` });
      const restart = gk || oppSide.players[0];
      this.ball.owner = restart; this.ball.mode = 'carry';
      if (restart) { this.ball.x = restart.x; this.ball.y = restart.y; restart.decCd = 2; }
    }
    ball.shot = null;
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
    if (opp.players) for (const e of opp.players) if (e.pos === 'GK' || e.pos === 'DF') e.rd -= 0.05;
    this.pushEvent({ type: 'goal', side: c.side, text: `⚽ ${this.clock()} ${this.world.teams[side.teamId].short} ${c.name}의 골!${c.assistName ? ` (도움 ${c.assistName})` : ''} — ${this.scoreText()}` });
    this.ball.mode = 'carry';
    this.ball.shot = null;
    this.ball.owner = null;
    this.pause = 8;
    this.phase = 'goal';
    this.goalFlash = { side: c.side, name: c.name, at: this.t };
    // 재개: 실점 팀 킥오프
    this.pendingRestart = this.opposing[c.side];
  }

  /* ───────────── 볼 이동 ───────────── */
  moveBall() {
    const b = this.ball;
    if (b.mode === 'carry' && b.owner) {
      b.x = b.owner.x + b.owner.dir * 0.9;
      b.y = b.owner.y;
      b.owner.touched = this.t;
      return;
    }
    if (b.mode === 'pass' || b.mode === 'shot') {
      b.t += 1;
      const p = clamp(b.t / Math.max(b.dur, 1), 0, 1);
      b.x = b.from.x + (b.to.x - b.from.x) * p;
      b.y = b.from.y + (b.to.y - b.from.y) * p;
      if (b.mode === 'pass') {
        // 길목 차단
        const opps = this.sides[this.opposing[b.passer.side]].players.filter((e) => e.onPitch && e.pos !== 'GK');
        for (const o of opps) {
          const d = Math.hypot(o.x - b.x, o.y - b.y);
          if (d < 1.9 && this.rng() < 0.07 + this.eff(o, 'def') / 1000) {
            this.intercept(o, b.passer);
            return;
          }
        }
      }
      if (p >= 1) {
        if (b.mode === 'shot') return this.resolveShot();
        const rec = b.receiver;
        if (!rec) { b.mode = 'loose'; b.owner = null; return; }
        // 수신 경합
        const opps = this.sides[this.opposing[rec.side]].players.filter((e) => e.onPitch && e.pos !== 'GK');
        const near = opps.filter((o) => dist(o, rec) < 3.2).sort((a, c2) => dist(a, rec) - dist(c2, rec))[0];
        if (near && this.rng() < 0.13 + this.eff(near, 'def') / 950) {
          b.passer.st.passOk += 1;
          this.intercept(near, b.passer);
          return;
        }
        b.owner = rec; b.mode = 'carry';
        b.passer.st.passOk += 1;
        this.sides[b.passer.side].stats.passOk += 1;
        rec.decCd = 0;
        // 박스 안에서 공을 받으면 바로 슈팅 (원터치)
        if (rec.pos !== 'GK' && prog(rec.x, rec.dir) > 81 && Math.abs(rec.y - CY) < 13) {
          const pr = this.pressureOn(rec);
          const dG = Math.hypot((rec.dir > 0 ? W : 0) - rec.x, CY - rec.y);
          if (pr < 2.6 && this.rng() < 0.62) { this.shoot(rec, dG, pr); return; }
        }
        // 크로스 → 헤더 슛
        if (b.cross && Math.abs(rec.y - CY) < 13 && prog(rec.x, rec.dir) > 70 && rec.pos === 'FW') {
          const dGoal = Math.hypot((rec.dir > 0 ? W : 0) - rec.x, CY - rec.y);
          if (this.rng() < 0.55) { this.pushEvent({ type: 'cross', side: rec.side, text: `${rec.name} 헤더!` }); this.shoot(rec, dGoal, this.pressureOn(rec), true); return; }
        }
        b.cross = false;
      }
      return;
    }
    if (b.mode === 'loose') {
      b.x += b.vx; b.y += b.vy;
      b.vx *= 0.92; b.vy *= 0.92;
      if (b.x < 2 || b.x > W - 2) b.vx *= -0.6;
      if (b.y < 2 || b.y > H - 2) b.vy *= -0.6;
      // 가장 가까운 선수가 줍기
      const all = [...this.sides.home.players, ...this.sides.away.players].filter((e) => e.onPitch && e !== b.owner);
      let best = null, bd = 1e9;
      for (const e of all) { const d = dist(e, b); if (d < bd) { bd = d; best = e; } }
      if (best && bd < 1.6) { b.owner = best; b.mode = 'carry'; best.decCd = 1; }
    }
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
    this.pushEvent({ type: 'tackle', side: defender.side, text: `${defender.name}가 패스 길목을 차단합니다.` });
  }

  contests() {
    const b = this.ball;
    if (b.mode !== 'carry' || !b.owner) return;
    const c = b.owner;
    const opp = this.sides[this.opposing[c.side]].players.filter((e) => e.onPitch && e.pos !== 'GK');
    for (const d of opp) {
      if (dist(d, c) > 2.6) continue;
      d.tackleCd -= 1;
      if (d.tackleCd > 0) continue;
      d.tackleCd = rint(this.rng, 5, 10);
      const def = this.eff(d, 'def') + this.eff(d, 'spd') * 0.25;
      const dri = this.eff(c, 'dri') * 0.8 + this.eff(c, 'spd') * 0.45 + this.eff(c, 'vis') * 0.1;
      const p = clamp((def / (def + dri)) * 0.42, 0.05, 0.42);
      if (this.rng() < p) {
        // 파울 판정
        if (this.rng() < 0.26) {
          const card = this.rng() < 0.14;
          c.rd += 0.02;
          if (card) { d.st.yellow += 1; d.rd -= 0.25; this.pushEvent({ type: 'card', side: d.side, text: `🟨 ${d.name} 경고 — ${c.name}에게 반칙.` }); }
          else this.pushEvent({ type: 'foul', side: d.side, text: `반칙! ${d.name}가 ${c.name}를 막아섰습니다.` });
          c.decCd = 1;
          b.x = c.x; b.y = c.y;
          return;
        }
        b.owner = d; b.mode = 'carry';
        d.decCd = 1;
        d.st.tackles += 1; d.rd += 0.09;
        this.sides[d.side].stats.tackles += 1;
        c.rd -= 0.04;
        this.pushEvent({ type: 'tackle', side: d.side, text: `${d.name} 태클 성공! ${c.name}의 공을 빼앗습니다.` });
        return;
      } else {
        c.decCd = Math.min(c.decCd, 1);
      }
    }
  }

  /* ───────────── AI 전술 조정 ───────────── */
  aiAdjust() {
    if (this.t % 60 !== 0) return;
    for (const s of ['home', 'away']) {
      const side = this.sides[s];
      if (s === this.userSide) continue; // 내 팀은 감독이 직접
      const diff = this.score[s] - this.score[this.opposing[s]];
      const t = side.tactic;
      if (diff < 0) { t.line = clamp(t.line + 0.15, -1, 1); t.press = clamp(t.press + 0.15, -1, 1); }
      else if (diff > 0) { t.line = clamp(t.line - 0.1, -1, 1); t.press = clamp(t.press - 0.1, -1, 1); }
      if (this.t > 300 && diff < 0) { t.route = 0.5; }
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
    // 포지션별 재배치 (선수는 그대로, 슬롯만 바꿈)
    const outfield = side.players.filter((e) => e.onPitch && e.pos !== 'GK');
    const gk = side.players.find((e) => e.pos === 'GK');
    const used = new Set();
    slots.forEach((slot, i) => {
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
    const idx = side.players.findIndex((e) => e.id === outPid && e.onPitch);
    const bIdx = side.bench.findIndex((e) => e.id === inPid);
    if (idx < 0 || bIdx < 0) return { ok: false, why: '선수를 찾을 수 없습니다.' };
    const out = side.players[idx];
    const inn = side.bench[bIdx];
    const slot = out.slot;
    inn.slot = slot; inn.pos = slot.pos; inn.label = out.label; inn.factor = posFactor(slot.pos, inn.p.pos);
    inn.x = out.x; inn.y = out.y; inn.stamina = 100; inn.onPitch = true; inn.st.minutes = 0;
    side.players[idx] = inn;
    side.bench.splice(bIdx, 1);
    out.onPitch = false;
    side.subsUsed += 1;
    if (this.ball.owner === out) { this.ball.owner = inn; }
    this.pushEvent({ type: 'sub', side: this.userSide, text: `🔁 교체 — ${out.name} OUT, ${inn.name} IN` });
    return { ok: true };
  }

  /* ───────────── 화면용 요약 ───────────── */
  stats() {
    const h = this.sides.home.stats, a = this.sides.away.stats;
    const total = h.possTicks + a.possTicks || 1;
    return {
      possession: { home: Math.round((h.possTicks / total) * 100), away: 100 - Math.round((h.possTicks / total) * 100) },
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
    };
  }
  ratings(sideName) {
    return this.sides[sideName].players.filter((e) => e.onPitch).map((e) => ({
      e, rating: Math.round(clamp(6.0 + e.rd, 4.2, 10) * 10) / 10,
    })).sort((a, b) => b.rating - a.rating);
  }
}

/* ─────────── 라인업 준비 ─────────── */
export function lineupFor(world, teamId) {
  const t = world.teams[teamId];
  if (teamId === world.myTeamId) return world.myLineup;
  return autoLineup(world, teamId, t.formation);
}

/* 다른 경기의 결과를 세계에 반영 */
export function applyResult(world, m) {
  const st = m.stats();
  for (const s of ['home', 'away']) {
    const teamId = s === 'home' ? m.homeId : m.awayId;
    for (const e of m.sides[s].players) {
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
      const r = clamp(6.0 + e.rd, 4.2, 10);
      p.season.ratingSum += r;
      p.season.ratingCount += 1;
    }
    // 벤치 선수는 출전 기록 없음
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
  while (!m.done && guard < 2000) { m.tick(); guard += 1; }
  if (!m.done) m.finish();
  return m;
}
