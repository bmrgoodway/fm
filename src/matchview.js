// 라이브 매치 화면 — Canvas 2D 피치 + 60fps 보간 + 배속/전술/교체/실시간 기록
// · 엔진은 틱(경기 15초)마다 상태를 만들고, 화면은 매 프레임 이전 좌표→현재 좌표를 보간(lerp)합니다.
// · 득점 연출(슛 궤적·골키퍼 다이빙·골망), 하프타임 라커룸, 실시간 자막 티커를 담습니다.
import { W as PW, H as PH, CY, GOAL_HALF, diveProgress, growthPreview } from './match.js';
import { AXES, STEPS, stepLabel, MENTALITY, mentalityOf, mentalityEffect, roleLabel, roleShort, roleEffect, rolesForLabel, nextRole, defaultRole, setPieceLabel, SET_PIECES } from './tactics.js';
import { FORMATIONS, STAT_LABEL, formationsFor } from './data.js';
import * as X from './world.js';
import { esc, setPieceRows } from './views.js';

const SPEEDS = [{ v: 1, label: '1x' }, { v: 2, label: '2x' }, { v: 4, label: '4x' }, { v: 0, label: '즉시' }];

/* 미니 체력 바 색 — 70% 이상 초록, 45~70% 노랑, 45% 미만 빨강.
   화면과 자체 점검이 같은 기준을 쓰도록 한곳에 둡니다. */
export const STAMINA_COLORS = { good: '#2fe36b', warn: '#ffdc1a', low: '#ff614a' };
export function staminaColor(stamina) {
  const v = Number.isFinite(stamina) ? stamina : 100;
  return v >= 70 ? STAMINA_COLORS.good : v >= 45 ? STAMINA_COLORS.warn : STAMINA_COLORS.low;
}
const BASE_MS = 230;          // 1x 에서 한 틱(경기 15초)에 걸리는 실제 시간
const lerp = (a, b, t) => a + (b - a) * t;
const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);

export function mountMatch(app, m, meta) {
  m.holdHalf = true;          // 하프타임 카드를 보여 주는 동안 엔진을 멈춥니다
  const root = document.getElementById('app');
  const w = app.world;
  const home = w.teams[m.homeId], away = w.teams[m.awayId];
  const isHome = m.userSide === 'home';
  const myTeam = isHome ? home : away;
  let speed = 1, raf = 0, lastT = performance.now(), acc = 0, alpha = 0;
  let lastStats = 0, lastRatings = 0, outPid = null, drawer = null, flashTimer = 0, halfShown = false;
  let paused = false, goalPhase = false;   // 득점 연출이 끝나 재개되는 순간 배너를 닫기 위한 표시

  // 브라우저 자동 점검에서 읽는 진단 훅 (프레임 수·보간 계수·최근 이벤트)
  const diag = (window.__fm = window.__fm || { errors: [] });
  diag.match = m; diag.frames = 0; diag.alpha = 0; diag.score = () => `${m.score.home}-${m.score.away}`;
  diag.trace = [];
  diag.ball = () => ({ mode: m.ball.mode, x: Math.round(m.ball.x * 10) / 10, y: Math.round(m.ball.y * 10) / 10, t: Math.round(m.ball.t * 100) / 100, dur: Math.round(m.ball.dur * 100) / 100, phase: m.phase });
  diag.flash = () => ({ hidden: flash.hidden, score: $('m-score').textContent });
  diag.replaying = false;
  diag.speed = () => ({ speed, paused, phase: m.phase, half: m.half });
  diag.shotFrames = 0; diag.shotFramesBad = 0;   // 슛 비행 중 배너가 떠 있던 프레임 수(점검용)
  diag.gk = () => {
    const out = [];
    for (const s of ['home', 'away']) {
      for (const e of m.sides[s].players) {
        if (e.pos !== 'GK') continue;
        out.push({ id: e.id, name: e.name, side: s, dive: e.dive ? { at: e.dive.at, landAt: e.dive.landAt, p: Math.round(diveProgress(e.dive, m.t, alpha) * 100) / 100 } : null, hold: e.holdT != null });
      }
    }
    return out;
  };
  diag.offside = () => ({ offsides: m.stats().offsides, goals: m.offsideGoals, flash: m.offsideFlash ? { at: m.offsideFlash.at, x: Math.round(m.offsideFlash.x * 10) / 10, y: Math.round(m.offsideFlash.y * 10) / 10, lineX: Math.round((m.offsideFlash.lineX || 0) * 10) / 10 } : null });
  diag.gkPose = () => {
    const out = {};
    for (const s of ['home', 'away']) {
      const e = m.sides[s].players.find((p) => p.onPitch && p.pos === 'GK');
      if (!e) continue;
      const own = m.sides[s].dir > 0 ? 0 : 100;
      out[s] = { x: Math.round(e.x * 10) / 10, y: Math.round(e.y * 10) / 10, out: Math.round(Math.abs(e.x - own) * 10) / 10, ballOut: Math.round(Math.abs(m.ball.x - own) * 10) / 10 };
    }
    return out;
  };
  diag.ballAt = () => ({ x: Math.round(m.ball.x * 10) / 10, y: Math.round(m.ball.y * 10) / 10, mode: m.ball.mode, owner: m.ball.owner ? m.ball.owner.name : null, ownerPos: m.ball.owner ? m.ball.owner.pos : null });
  /* 체력 바·카드 배지의 '화면 좌표와 색' — 자동 점검이 캔버스 픽셀과 대조합니다 */
  diag.bars = () => {
    const pad = 2.0;
    const scale = Math.min(cssW / (PW + pad * 2), cssH / (PH + pad * 2));
    const ox = (cssW - (PW + pad * 2) * scale) / 2 + pad * scale;
    const oy = (cssH - (PH + pad * 2) * scale) / 2 + pad * scale;
    const r = Math.max(6, scale * 2.05);
    const barW = Math.max(10, r * 1.9), barH = Math.max(2.4, r * 0.3);
    const list = [];
    for (const s of ['home', 'away']) {
      for (const e of m.sides[s].players) {
        if (!e.onPitch) continue;
        list.push({
          side: s, num: e.num, stamina: Math.round(e.stamina), color: staminaColor(e.stamina), yellow: e.st.yellow,
          x: ox + e.x * scale, y: oy + e.y * scale - r - barH - Math.max(2.4, r * 0.44),
          w: barW, h: barH,
        });
      }
    }
    return { dpr, cssW, cssH, scale, list };
  };
  diag.mentality = () => ({
    home: Number(m.sides.home.tactic.mentality) || 0, away: Number(m.sides.away.tactic.mentality) || 0,
    log: (m.coachLog || []).map((c) => ({ minute: c.minute, side: c.side, from: c.from, to: c.to })),
  });

  // 슛·골 판정은 공이 도착한 틱에 확정되지만, 화면에는 '공이 닿은 다음 틱'에 공개합니다.
  // 그래야 배너·스코어·중계 자막이 공의 실제 도착과 같은 순간에 나옵니다.
  const HOLD = new Set(['goal', 'save', 'supersave', 'woodwork', 'miss', 'rebound', 'clear']);
  const held = new Map();
  const shownScore = { home: 0, away: 0 };
  const syncScore = () => { shownScore.home = m.score.home; shownScore.away = m.score.away; };

  root.innerHTML = `<section class="matchview">
    <div class="scorebar">
      <div class="sb-team" data-team="${home.id}">
        <span class="badge mid" data-team="${home.id}">${esc(home.short.slice(0, 2))}</span>
        <div><b>${esc(home.name)}</b><small>홈</small><i class="ment-chip" id="m-ment-home" data-v="bal">균형</i></div>
      </div>
      <div class="sb-mid">
        <span class="sb-score" id="m-score">0 - 0</span>
        <span class="sb-clock" id="m-clock">0'</span>
        <span class="sb-phase"><i class="half-pill" id="m-half">전반</i><i class="dir-pill" id="m-dir">${esc(home.short)} →</i></span>
      </div>
      <div class="sb-team away" data-team="${away.id}">
        <div><b>${esc(away.name)}</b><small>원정</small><i class="ment-chip" id="m-ment-away" data-v="bal">균형</i></div>
        <span class="badge mid" data-team="${away.id}">${esc(away.short.slice(0, 2))}</span>
      </div>
    </div>

    <div class="stage">
      <canvas id="pitch" aria-label="2D 경기장"></canvas>
      <div class="goalflash" id="goalflash" hidden></div>
      <button type="button" class="goal-replay" id="goal-replay" hidden>🎬 득점 리플레이</button>
      <div class="replaybar" id="replaybar" hidden>
        <span class="rb-badge">REPLAY 0.35x</span>
        <span class="rb-info" id="rb-info"></span>
        <span class="rb-track"><i id="rb-fill"></i></span>
        <button type="button" class="btn small ghost" id="rb-skip">건너뛰기</button>
        <button type="button" class="btn small" id="rb-close">닫기</button>
      </div>
    </div>

    <div class="ticker" id="ticker" aria-live="polite">
      <span class="tk-min" id="tk-min">0'</span>
      <span class="tk-text" id="tk-text">${esc(meta.label)} — 킥오프를 기다립니다.</span>
    </div>

    <div class="mcontrols">
      <div class="seg speeds" role="group" aria-label="배속">
        ${SPEEDS.map((s) => `<button type="button" class="spd ${s.v === 1 ? 'on' : ''}" data-speed="${s.v}">${s.label}</button>`).join('')}
      </div>
      <button type="button" class="btn small" id="m-pause" aria-pressed="false">일시정지</button>
      <button type="button" class="btn small" data-mact="tactics">전술 변경</button>
      <button type="button" class="btn small" data-mact="subs">선수 교체 <span id="sub-count">5</span></button>
      <button type="button" class="btn small replay-btn" id="m-replay" disabled>🎬 득점 리플레이</button>
      <button type="button" class="btn small ghost" data-mact="ff">즉시 결과 ⏩</button>
    </div>

    <div class="drawer-back" id="drawer-back" hidden></div>
    <div class="drawer" id="drawer" role="dialog" aria-label="경기 중 전술" hidden></div>

    <div class="mpanels">
      <div class="card mstats">
        <div class="card-head"><h3>실시간 기록</h3><span class="pill" id="m-label">${esc(meta.label)}</span></div>
        <div class="ment-live" aria-live="polite">
          <span class="ml"><i>우리 ${esc(myTeam.short)}</i><b id="ml-my" data-v="bal">균형</b></span>
          <span class="ml"><i>상대 ${esc((isHome ? away : home).short)}</i><b id="ml-opp" data-v="bal">균형</b></span>
          <span class="ml-note" id="m-coach-note">AI 감독 맞대응</span>
        </div>
        <div class="poss"><div class="poss-bar"><i class="ph" id="poss-h"></i><i class="pa" id="poss-a"></i></div><div class="poss-lab"><b id="poss-hl">50%</b><span>점유율</span><b id="poss-al">50%</b></div></div>
        <table class="tbl stat-rows" id="m-statrows"></table>
      </div>
      <div class="card mfeed">
        <div class="card-head"><h3>문자 중계</h3><span class="pill" id="m-events">0</span></div>
        <ul class="feed" id="feed" aria-live="polite"></ul>
      </div>
      <div class="card mratings">
        <div class="card-head"><h3>선수 평점</h3><span class="pill">6.0 ~ 10.0</span></div>
        <div class="rating-cols">
          <div><h4>${esc(myTeam.short)} <small>우리 팀</small></h4><ul id="ratings-my"></ul></div>
          <div><h4>${esc((isHome ? away : home).short)} <small>상대</small></h4><ul id="ratings-opp"></ul></div>
        </div>
      </div>
    </div>

    <div class="overlay halftime" id="halftime" hidden>
      <div class="overlay-card half-card">
        <span class="eyebrow">HALF TIME · 라커룸</span>
        <h2 id="ht-score">0 - 0</h2>
        <p class="sm" id="ht-note">전반이 끝났습니다. 전술을 손보고 선수를 교체할 수 있습니다.</p>
        <div class="half-body" id="ht-body"></div>
        <div class="actions center">
          <button class="btn primary big" id="ht-start" type="button">후반 시작 →</button>
        </div>
        <p class="hint">후반에는 양 팀 진영(공격 방향)이 바뀝니다.</p>
      </div>
    </div>

    <div class="overlay" id="m-overlay" hidden>
      <div class="overlay-card">
        <span class="eyebrow" id="ov-eyebrow">FULL TIME</span>
        <h2 id="ov-title">0 - 0</h2>
        <p class="sm" id="ov-sub"></p>
        <div class="ov-stats" id="ov-stats"></div>
        <div class="ov-growth" id="ov-growth"></div>
        <button class="btn big" id="ov-replay" type="button" hidden>🎬 득점 리플레이</button>
        <button class="btn primary big" id="ov-continue" type="button">계속 →</button>
      </div>
    </div>
  </section>`;

  const $ = (id) => document.getElementById(id);
  $('drawer-back').addEventListener('click', () => { drawer = null; setDrawerPause(false); renderDrawer(); });
  const canvas = $('pitch');
  const ctx = canvas.getContext('2d');
  const flash = $('goalflash');
  let dpr = 1, cssW = 800, cssH = 500;

  /* ── 색 ── */
  const theme = () => document.documentElement.getAttribute('data-theme') || 'day';
  const colors = () => (theme() === 'night'
    ? { grass: '#14603a', grass2: '#115232', line: 'rgba(255,255,255,.82)', ink: '#f4f4f8', net: 'rgba(255,255,255,.35)' }
    : { grass: '#2f9e4f', grass2: '#2a8f47', line: 'rgba(255,255,255,.9)', ink: '#101014', net: 'rgba(16,16,20,.35)' });

  function resize() {
    dpr = Math.min(window.devicePixelRatio || 1, 2.5);
    const host = canvas.closest('.matchview') || canvas.parentElement;
    const stageW = Math.max(280, host.clientWidth - 8);
    const ratio = (PW + 4.0) / (PH + 4.0);
    let w2 = stageW;
    let h = w2 / ratio;
    const wide = window.innerWidth >= 1040;
    const maxH = Math.max(240, Math.round(window.innerHeight * (wide ? 0.6 : 0.66)));
    if (h > maxH) { h = maxH; w2 = h * ratio; }
    cssW = Math.round(w2); cssH = Math.round(h);
    canvas.style.width = cssW + 'px';
    canvas.style.height = cssH + 'px';
    canvas.style.margin = '0 auto';
    canvas.width = Math.round(cssW * dpr);
    canvas.height = Math.round(cssH * dpr);
    const mv = canvas.closest('.matchview');
    if (mv) mv.style.setProperty('--pitch-h', cssH + 'px');
  }

  /* ── 득점 리플레이 ─────────────────────────────────────────────────
     화면에 보이는 그대로(보간된 좌표)를 45ms 간격 링 버퍼에 담아 두고,
     골이 들어오면 그 순간부터 거슬러 올라간 장면을 한 클립으로 잘라 보관합니다.
     0.35x 로 다시 재생하고, 끝나면 생방송으로 복귀합니다. */
  const CAP_MS = 45;            // 스냅샷 간격 (약 22fps)
  const CLIP_BEFORE_TICKS = 8;  // 골 직전 몇 틱부터 (벽시계가 아니라 경기 틱 기준)
  const CLIP_AFTER_TICKS = 1;   // 골망에 들어가는 순간까지
  const REPLAY_RATE = 0.35;
  const rec = { frames: [], next: 0, recording: null };
  const clips = [];
  let lastClip = null, clipSeq = 0, goalCtaTimer = 0;
  const replay = { on: false, clip: null, from: 0, to: 0, startedAt: 0, raf: 0, endedAt: 0, overlay: null };

  // 지금 화면에 그려지는 좌표 그대로 한 장면을 찍습니다
  function capture(now, a) {
    const b = m.ball;
    const f = {
      t: now, tick: m.t, phase: m.phase,
      sp: m.sp ? { x: m.sp.x, y: m.sp.y, type: m.sp.type, key: m.spDirective(m.sp.type, m.sp.side) } : null,
      netShake: !!(m.goalFlash && (m.t - m.goalFlash.at) < 14 && m.phase === 'goal'),
      goalFlash: m.goalFlash && (m.t - m.goalFlash.at) < 20 ? { name: m.goalFlash.name, side: m.goalFlash.side } : null,
      score: { ...m.score },
      ball: {
        x: lerp(b.px, b.x, a),
        y: lerp(b.py, b.y, a),
        mode: b.mode,
        ownerId: b.owner ? b.owner.id : null,
        receiverId: b.mode === 'pass' && b.receiver ? b.receiver.id : null,
        trail: b.trail.slice(-16).map((q) => [q.x, q.y]),
      },
      sides: { home: [], away: [] },
    };
    for (const s of ['home', 'away']) {
      f.sides[s] = m.sides[s].players.map((e) => {
        const dip = e.dive ? diveProgress(e.dive, m.t, a) : 0;
        return [
          e.id, e.num, e.name, e.pos, e.dir, lerp(e.px, e.x, a), lerp(e.py, e.y, a),
          e.onPitch ? 1 : 0, Math.round(e.stamina), e.st.yellow, e.st.red, e.injured ? 1 : 0,
          dip > 0.02 ? dip : 0, e.dive ? (e.dive.to || 0) : 0,
        ];
      });
    }
    return f;
  }

  // 한 장면(또는 두 장면 사이 보간값)을 draw() 가 읽는 모양으로 바꿉니다
  function sceneOf(f) {
    const sides = {};
    const byId = { home: new Map(), away: new Map() };
    for (const s of ['home', 'away']) {
      const side = m.sides[s];
      sides[s] = {
        kit: side.kit, dir: side.dir, team: side.team,
        players: f.sides[s].map((r) => ({
          id: r[0], num: r[1], name: r[2], pos: r[3], dir: r[4],
          x: r[5], y: r[6], px: r[5], py: r[6],
          onPitch: !!r[7], stamina: r[8], st: { yellow: r[9], red: r[10] },
          injured: !!r[11], dive: r[12] > 0 ? { p: r[12], to: r[13], at: 0, dur: 1 } : null,
        })),
      };
      for (const p of sides[s].players) byId[s].set(p.id, p);
    }
    const ball = {
      x: f.ball.x, y: f.ball.y, px: f.ball.x, py: f.ball.y, mode: f.ball.mode,
      owner: null, receiver: null, trail: (f.ball.trail || []).map(([x, y]) => ({ x, y })),
    };
    for (const s of ['home', 'away']) {
      if (f.ball.ownerId != null) ball.owner = byId[s].get(f.ball.ownerId) || ball.owner;
      if (f.ball.receiverId != null) ball.receiver = byId[s].get(f.ball.receiverId) || ball.receiver;
    }
    return { t: 0, phase: f.phase, sp: f.sp, netShake: f.netShake, goalFlash: f.goalFlash, ball, sides, score: f.score };
  }

  function sceneAt(clip, time) {
    const F = clip.frames;
    let lo = 0, hi = F.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (F[mid].t <= time) lo = mid; else hi = mid - 1;
    }
    const A = F[lo], B = F[Math.min(lo + 1, F.length - 1)];
    const k = B.t > A.t ? clamp01((time - A.t) / (B.t - A.t)) : 0;
    const bMap = { home: new Map(B.sides.home.map((r) => [r[0], r])), away: new Map(B.sides.away.map((r) => [r[0], r])) };
    const sides = { home: [], away: [] };
    for (const s of ['home', 'away']) {
      sides[s] = A.sides[s].map((r) => {
        const r2 = bMap[s].get(r[0]) || r;
        const out = r.slice();
        out[5] = lerp(r[5], r2[5], k);
        out[6] = lerp(r[6], r2[6], k);
        out[12] = Math.max(r[12], r2[12]);
        out[13] = r2[13] || r[13];
        return out;
      });
    }
    const f = {
      t: A.t, phase: A.phase, sp: A.sp,
      netShake: A.netShake || B.netShake,
      goalFlash: A.goalFlash || B.goalFlash,
      score: A.score,
      ball: {
        x: lerp(A.ball.x, B.ball.x, k), y: lerp(A.ball.y, B.ball.y, k),
        mode: A.ball.mode, ownerId: A.ball.ownerId, receiverId: A.ball.receiverId,
        trail: (A.ball.trail.length >= B.ball.trail.length ? A.ball.trail : B.ball.trail),
      },
      sides,
    };
    return sceneOf(f);
  }

  function clipSpan(clip) {
    const F = clip.frames;
    return F.length > 1 ? F[F.length - 1].t - F[0].t : 0;
  }

  // 골이 났을 때: 링 버퍼에서 '골 직전'부터 틱 기준으로 잘라 둡니다
  // — 재개(킥오프) 순간이동이 클립에 들어가지 않도록 마지막 킥오프 뒤부터만 담습니다
  function beginClip(ev) {
    const gTick = ev.tick;
    const from = Math.max(gTick - CLIP_BEFORE_TICKS, (m.lastKickoffT ?? -1) + 1);
    const untilTick = gTick + CLIP_AFTER_TICKS;
    const frames = rec.frames.filter((f) => f.tick >= from && f.tick <= untilTick);
    if (frames.length < 3) return;
    rec.recording = {
      id: ev.id, seq: ++clipSeq, scorer: ev.scorer || '', label: ev.label || '',
      scoreText: `${m.score.home} - ${m.score.away}`, side: ev.side || null,
      frames, fromTick: from, untilTick, goalTick: gTick, max: frames.length + 4,
    };
  }

  function finalizeClip() {
    const c = rec.recording;
    rec.recording = null;
    if (!c || c.frames.length < 3) return;
    clips.push(c);
    while (clips.length > 6) clips.shift();
    lastClip = c;
    $('m-replay').disabled = false;
    $('goal-replay').hidden = false;
    clearTimeout(goalCtaTimer);
    goalCtaTimer = setTimeout(() => { $('goal-replay').hidden = true; }, 9000);
    if (m.done) $('ov-replay').hidden = false;
  }

  function startReplay(clip) {
    if (!clip || clip.frames.length < 3) { app.toast('아직 리플레이할 장면이 없습니다.'); return; }
    if (replay.on) return;
    replay.on = true; replay.clip = clip;
    replay.from = clip.frames[0].t;
    replay.to = clip.frames[clip.frames.length - 1].t;
    replay.startedAt = performance.now();
    replay.endedAt = 0;
    replay.overlay = null;
    for (const id of ['halftime', 'm-overlay']) {
      const el = $(id);
      if (el && !el.hidden) { replay.overlay = id; el.hidden = true; }
    }
    cancelAnimationFrame(raf); raf = 0;
    flash.hidden = true;                 // 생방송 득점 배너가 리플레이 화면을 덮지 않게
    clearTimeout(flashTimer);
    $('goal-replay').hidden = true;
    $('replaybar').hidden = false;
    replay.ticker = { min: $('tk-min').textContent, text: $('tk-text').textContent };
    $('tk-min').textContent = clip.label || '🎬';
    $('tk-text').textContent = `🎬 득점 리플레이 0.35x — ${clip.scorer || ''}${clip.scoreText ? ` · ${clip.scoreText}` : ''}`;
    $('rb-info').textContent = `${clip.label} ${clip.scorer}`.trim() + (clip.scoreText ? ` · ${clip.scoreText}` : '');
    $('rb-fill').style.width = '0%';
    diag.replaying = true;
    replayLoop(performance.now());
  }

  function replayLoop(now) {
    if (!replay.on) return;
    const src = replay.from + (now - replay.startedAt) * REPLAY_RATE;
    const t = Math.min(src, replay.to);
    draw(1, sceneAt(replay.clip, t));
    $('rb-fill').style.width = `${clamp01((t - replay.from) / Math.max(replay.to - replay.from, 1)) * 100}%`;
    if (src >= replay.to) {
      if (!replay.endedAt) replay.endedAt = now + 700;      // 마지막 장면을 잠깐 보여 주고 돌아갑니다
      else if (now >= replay.endedAt) { endReplay(); return; }
    }
    replay.raf = requestAnimationFrame(replayLoop);
  }

  function endReplay() {
    if (!replay.on) return;
    replay.on = false;
    replay.endedAt = 0;
    cancelAnimationFrame(replay.raf); replay.raf = 0;
    $('replaybar').hidden = true;
    diag.replaying = false;
  diag.speed = () => ({ speed, paused, phase: m.phase, half: m.half });
  diag.shotFrames = 0; diag.shotFramesBad = 0;   // 슛 비행 중 배너가 떠 있던 프레임 수(점검용)
    if (replay.ticker) {
      $('tk-min').textContent = replay.ticker.min;
      $('tk-text').textContent = replay.ticker.text;
      replay.ticker = null;
    }

    if (replay.overlay === 'halftime') { $('halftime').hidden = false; draw(1); return; }
    if (replay.overlay === 'm-overlay' || m.done) { showResult(); return; }
    // 생방송 재개
    lastT = performance.now(); acc = 0;
    start();
  }

  /* ── 피치 그리기 ── */
  const pos = (e, a) => ({ x: lerp(e.px, e.x, a), y: lerp(e.py, e.y, a) });

  // S = 그릴 장면. 생방송에서는 m(경기 엔진), 리플레이에서는 버퍼에 담아 둔 스냅샷입니다.
  /* 라이브 세트피스의 지시 키 — m.sp 에는 key 필드가 없어 매 프레임 읽습니다 (리플레이 스냅숏은 key 를 들고 있습니다) */
  function liveSpKey(S, type) {
    if (S !== m) return null;
    try { return m.spDirective(type, m.sp.side); } catch { return null; }
  }

  function draw(a = 0, S = m) {
    const c = colors();
    const pad = 2.0;
    const scale = Math.min(cssW / (PW + pad * 2), cssH / (PH + pad * 2));
    const ox = (cssW - (PW + pad * 2) * scale) / 2 + pad * scale;
    const oy = (cssH - (PH + pad * 2) * scale) / 2 + pad * scale;
    const CX = (x) => ox + x * scale, CYp = (y) => oy + y * scale;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, cssW, cssH);

    // 잔디
    ctx.fillStyle = c.grass;
    ctx.fillRect(CX(0), CYp(0), PW * scale, PH * scale);
    ctx.fillStyle = c.grass2;
    for (let i = 0; i < 10; i += 2) ctx.fillRect(CX((PW / 10) * i), CYp(0), (PW / 10) * scale, PH * scale);

    // 선
    ctx.strokeStyle = c.line;
    ctx.lineWidth = Math.max(1.2, scale * 0.28);
    ctx.strokeRect(CX(0), CYp(0), PW * scale, PH * scale);
    ctx.beginPath(); ctx.moveTo(CX(PW / 2), CYp(0)); ctx.lineTo(CX(PW / 2), CYp(PH)); ctx.stroke();
    ctx.beginPath(); ctx.arc(CX(PW / 2), CYp(CY), 9.15 / 105 * PW * scale, 0, Math.PI * 2); ctx.stroke();
    ctx.beginPath(); ctx.arc(CX(PW / 2), CYp(CY), scale * 0.8, 0, Math.PI * 2); ctx.fillStyle = c.line; ctx.fill();
    const paD = 16.5 / 105 * PW, paW = 40.32 / 68 * PH;
    ctx.strokeRect(CX(0), CYp(CY - paW / 2), paD * scale, paW * scale);
    ctx.strokeRect(CX(PW - paD), CYp(CY - paW / 2), paD * scale, paW * scale);
    const gaD = 5.5 / 105 * PW, gaW = 18.32 / 68 * PH;
    ctx.strokeRect(CX(0), CYp(CY - gaW / 2), gaD * scale, gaW * scale);
    ctx.strokeRect(CX(PW - gaD), CYp(CY - gaW / 2), gaD * scale, gaW * scale);

    // 골문 + 골망
    const netShake = S.netShake != null ? (S.netShake ? 1 : 0)
      : (S.goalFlash && (S.t - S.goalFlash.at) < 14 && S.phase === 'goal' ? 1 : 0);
    for (const gx of [0, PW]) {
      ctx.fillStyle = 'rgba(255,255,255,.10)';
      ctx.fillRect(gx === 0 ? CX(-1.6) : CX(PW), CYp(CY - GOAL_HALF), 1.6 * scale, GOAL_HALF * 2 * scale);
      ctx.strokeStyle = c.net; ctx.lineWidth = Math.max(0.8, scale * 0.12);
      const nx0 = gx === 0 ? CX(-1.6) : CX(PW);
      for (let i = 1; i <= 4; i++) {
        const off = (GOAL_HALF * 2 * scale * i) / 5;
        ctx.beginPath(); ctx.moveTo(nx0, CYp(CY - GOAL_HALF) + off); ctx.lineTo(nx0 + 1.6 * scale, CYp(CY - GOAL_HALF) + off); ctx.stroke();
      }
      for (let i = 0; i <= 3; i++) {
        const off = (1.6 * scale * i) / 3 + (netShake ? Math.sin(S.t * 1.7 + i) * 1.6 : 0);
        ctx.beginPath(); ctx.moveTo(nx0 + off, CYp(CY - GOAL_HALF)); ctx.lineTo(nx0 + off, CYp(CY + GOAL_HALF)); ctx.stroke();
      }
      ctx.strokeStyle = c.ink; ctx.lineWidth = Math.max(2, scale * 0.55);
      ctx.strokeRect(gx === 0 ? CX(-1.6) : CX(PW), CYp(CY - GOAL_HALF), 1.6 * scale, GOAL_HALF * 2 * scale);
    }

    // 오프사이드 — 판정 순간 잠깐 라인과 깃발을 비춥니다 (공이 다음 플레이로 넘어가면 사라짐)
    if (S === m && m.offsideFlash && m.t - m.offsideFlash.at <= 6) {
      const f = m.offsideFlash;
      const k = clamp01((m.t - f.at + a) / 6);
      ctx.save();
      ctx.globalAlpha = 1 - k * 0.65;
      if (f.lineX != null) {
        ctx.strokeStyle = '#ffdc1a'; ctx.lineWidth = 2; ctx.setLineDash([6, 5]);
        ctx.beginPath(); ctx.moveTo(CX(f.lineX), CYp(0)); ctx.lineTo(CX(f.lineX), CYp(PH)); ctx.stroke();
        ctx.setLineDash([]);
      }
      const fx = CX(f.x), fy = CYp(f.y) - Math.max(14, scale * 3.0);
      const label = '🚩 오프사이드';
      ctx.font = `900 ${Math.max(11, Math.round(scale * 1.55))}px "Pretendard Variable", Pretendard, sans-serif`;
      ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      const tw = ctx.measureText(label).width + 16, th = Math.max(20, scale * 2.6);
      ctx.fillStyle = 'rgba(16,16,20,.86)';
      ctx.fillRect(fx - tw / 2, fy - th / 2, tw, th);
      ctx.strokeStyle = '#ffdc1a'; ctx.lineWidth = 1.6;
      ctx.strokeRect(fx - tw / 2, fy - th / 2, tw, th);
      ctx.fillStyle = '#ffdc1a';
      ctx.fillText(label, fx, fy + 0.5);
      ctx.restore();
    }

    // 세트피스 표시 (코너·프리킥 지점) + 지금 지시(니어 포스트·박스 투입…)를 함께
    if (S.sp) {
      const sx = CX(S.sp.x), sy = CYp(S.sp.y);
      ctx.beginPath(); ctx.arc(sx, sy, Math.max(8, scale * 1.6), 0, Math.PI * 2);
      ctx.strokeStyle = '#ffdc1a'; ctx.lineWidth = 2.4; ctx.setLineDash([4, 3]); ctx.stroke(); ctx.setLineDash([]);
      const spKeyLive = S.sp.key || (S.sp.type ? liveSpKey(S, S.sp.type) : null);
      if (spKeyLive) {
        const label = `${SET_PIECES[S.sp.type]?.name || ''} · ${setPieceLabel(S.sp.type, spKeyLive)}`;
        ctx.font = `900 ${Math.max(9, Math.round(scale * 1.15))}px "Pretendard Variable", Pretendard, sans-serif`;
        ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
        const tw = ctx.measureText(label).width + 10, th = Math.max(15, scale * 1.9);
        // 위가 아니면 지점 아래로 — 모서리 팀 이름(금산 ▶)과 겹치지 않게
        const up = Math.max(16, scale * 2.4);
        const lx = Math.min(cssW - tw / 2 - 2, Math.max(tw / 2 + 2, sx));
        const ly = (sy - up >= th / 2 + 16) ? sy - up : Math.min(cssH - th / 2 - 2, sy + up);
        ctx.fillStyle = 'rgba(16,16,20,.82)';
        ctx.fillRect(lx - tw / 2, ly - th / 2, tw, th);
        ctx.fillStyle = '#ffdc1a';
        ctx.fillText(label, lx, ly + 0.5);
      }
    }

    // 공의 '지금 화면 위치' — 선수 링·궤적도 이 위치에 맞춰 그립니다
    const b = S.ball;
    const ballX = lerp(b.px ?? b.x, b.x, a);
    const ballY = lerp(b.py ?? b.y, b.y, a);

    // 선수
    const r = Math.max(6, scale * 2.05);
    for (const sideName of ['home', 'away']) {
      const side = S.sides[sideName];
      const t = side.team;
      for (const e of side.players) {
        if (!e.onPitch) continue;
        const p = pos(e, a);
        const px = CX(p.x), py = CYp(p.y);
        // 그림자
        ctx.fillStyle = 'rgba(0,0,0,.28)';
        ctx.beginPath(); ctx.ellipse(px + r * 0.22, py + r * 0.3, r * 0.95, r * 0.75, 0, 0, Math.PI * 2); ctx.fill();
        // 골키퍼 다이빙
        // 다이빙 진행도(p)는 슛이 날아오는 틱 수에 맞춰 — 공이 도착할 때 손끝이 닿습니다
        const dip = e.dive
          ? (e.dive.p != null ? e.dive.p : diveProgress(e.dive, S.t, a))
          : 0;
        const dive = e.pos === 'GK' && e.dive && dip > 0.02 ? { to: e.dive.to, p: dip } : null;
        if (dive) {
          const reach = dive.p;
          const dy = Math.sign(dive.to || 1) * Math.min(Math.abs(dive.to), 8) * scale * 0.9 * reach;
          const dx = (e.dir > 0 ? -1 : 1) * r * 0.5 * reach;
          ctx.save();
          ctx.translate(px + dx, py + dy);
          ctx.rotate(Math.atan2(dy, dx || 0.001) * 0.6);
          ctx.beginPath(); ctx.ellipse(0, 0, r * 1.5, r * 0.78, 0, 0, Math.PI * 2);
          ctx.fillStyle = side.kit || t.primary; ctx.fill();
          ctx.lineWidth = Math.max(1.6, r * 0.22); ctx.strokeStyle = '#101014'; ctx.stroke();
          ctx.restore();
          // 뻗은 손
          ctx.beginPath(); ctx.arc(px + dx * 1.5, py + dy * 1.5, r * 0.42, 0, Math.PI * 2);
          ctx.fillStyle = '#ffe0c2'; ctx.fill();
          ctx.strokeStyle = '#101014'; ctx.lineWidth = 1.4; ctx.stroke();
        } else {
          // 몸
          ctx.beginPath(); ctx.arc(px, py, r, 0, Math.PI * 2);
          ctx.fillStyle = side.kit || t.primary; ctx.fill();
          ctx.lineWidth = Math.max(1.6, r * 0.24); ctx.strokeStyle = '#101014'; ctx.stroke();
        }
        // 등번호
        ctx.fillStyle = contrastFor(side.kit || t.primary);
        ctx.font = `900 ${Math.round(r * 1.02)}px "Pretendard Variable", Pretendard, sans-serif`;
        ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
        ctx.fillText(String(e.num), px, py + r * 0.04);

        // 공 소유 표시
        // 공 소유 링은 공이 발밑에 실제로 닿았을 때만 켜집니다 (비행 중·도착 전에는 안 붙음)
        if (S.ball.owner === e && Math.hypot(CX(ballX) - px, CYp(ballY) - py) < Math.max(6, r * 0.8)) {
          ctx.beginPath(); ctx.arc(px, py, r + 3.2, 0, Math.PI * 2);
          ctx.strokeStyle = '#ffffff'; ctx.lineWidth = 2.2; ctx.setLineDash([3, 3]); ctx.stroke(); ctx.setLineDash([]);
        }
        // 패스가 날아가는 동안: 받을 선수를 노란 점선 링으로 비춥니다(포커스)
        if (S.ball.mode === 'pass' && S.ball.receiver === e) {
          const pulse = 1 + Math.sin(performance.now() / 190) * 0.1;
          ctx.beginPath(); ctx.arc(px, py, (r + 4.4) * pulse, 0, Math.PI * 2);
          ctx.strokeStyle = '#ffdc1a'; ctx.lineWidth = 2.4; ctx.setLineDash([5, 4]); ctx.stroke(); ctx.setLineDash([]);
        }
        // ── 미니 체력 바 ──────────────────────────────────────────
        // 바둑알 바로 위에 얇게 — 등번호(원 안)와 공(발밑)을 가리지 않는 자리입니다.
        // 70%+ 초록 · 45~70% 노랑 · 45% 미만 빨강: 교체 타이밍을 피치에서 바로 읽습니다.
        const stv = clamp01((Number.isFinite(e.stamina) ? e.stamina : 100) / 100);
        const barW = Math.max(10, r * 1.9), barH = Math.max(2.4, r * 0.3);
        const barX = px - barW / 2, barY = py - r - barH - Math.max(2.4, r * 0.44);
        ctx.fillStyle = 'rgba(16,16,20,.85)';
        ctx.fillRect(barX - 0.9, barY - 0.9, barW + 1.8, barH + 1.8);
        ctx.fillStyle = staminaColor(e.stamina);
        ctx.fillRect(barX, barY, Math.max(0.9, barW * stv), barH);
        // 카드·부상 배지 — 체력 바와 같은 줄의 양 끝에 붙여 도트 위를 깔끔하게 유지합니다
        const cardW = Math.max(2.8, r * 0.44), cardH = Math.max(4, r * 0.62);
        if (e.st.yellow > 0 && e.st.red === 0) {
          const cxx = barX + barW + 1.6, cyy = barY - (cardH - barH) / 2;
          ctx.fillStyle = '#ffdc1a'; ctx.strokeStyle = '#101014'; ctx.lineWidth = 1;
          ctx.fillRect(cxx, cyy, cardW, cardH); ctx.strokeRect(cxx, cyy, cardW, cardH);
        }
        if (e.st.red > 0) {
          const cxx = barX + barW + 1.6, cyy = barY - (cardH - barH) / 2;
          ctx.fillStyle = '#ff614a'; ctx.strokeStyle = '#101014'; ctx.lineWidth = 1;
          ctx.fillRect(cxx, cyy, cardW, cardH); ctx.strokeRect(cxx, cyy, cardW, cardH);
        }
        if (e.injured) {
          const s2 = Math.max(1.8, r * 0.28), ix = barX - cardW - 2.2, iy = barY + barH / 2;
          ctx.strokeStyle = '#ffffff'; ctx.lineWidth = Math.max(2, r * 0.24);
          ctx.beginPath(); ctx.moveTo(ix - s2, iy); ctx.lineTo(ix + s2, iy); ctx.moveTo(ix, iy - s2); ctx.lineTo(ix, iy + s2); ctx.stroke();
          ctx.strokeStyle = '#ff614a'; ctx.lineWidth = Math.max(1.1, r * 0.13);
          ctx.beginPath(); ctx.moveTo(ix - s2, iy); ctx.lineTo(ix + s2, iy); ctx.moveTo(ix, iy - s2); ctx.lineTo(ix, iy + s2); ctx.stroke();
        }
        // 득점자 강조
        if (S.goalFlash && S.goalFlash.name === e.name && (S.t - (S.goalFlash.at || 0)) < 20) {
          const pulse = 1 + Math.sin(performance.now() / 160) * 0.12;
          ctx.beginPath(); ctx.arc(px, py, (r + 7) * pulse, 0, Math.PI * 2);
          ctx.strokeStyle = '#ffdc1a'; ctx.lineWidth = 3; ctx.stroke();
        }
      }
    }

    // 공 + 슛 궤적(trail)
    const bx = CX(ballX), by = CYp(ballY), br = Math.max(3.4, scale * 0.95);
    // 슛이 날아가는 동안 공에 포커스를 줍니다
    if (b.mode === 'shot') {
      const pulse = 1 + Math.sin(performance.now() / 120) * 0.12;
      ctx.beginPath(); ctx.arc(bx, by, br * 2.5 * pulse, 0, Math.PI * 2);
      ctx.strokeStyle = 'rgba(255,220,26,.75)'; ctx.lineWidth = 2; ctx.setLineDash([2, 3]); ctx.stroke(); ctx.setLineDash([]);
    }
    if (b.trail && b.trail.length > 1 && (b.mode === 'shot' || b.mode === 'pass')) {
      ctx.lineCap = 'round';
      for (let i = 1; i < b.trail.length; i++) {
        const q0 = b.trail[i - 1], q1 = b.trail[i];
        const fade = i / b.trail.length;
        ctx.beginPath(); ctx.moveTo(CX(q0.x), CYp(q0.y)); ctx.lineTo(CX(q1.x), CYp(q1.y));
        ctx.strokeStyle = b.mode === 'shot' ? `rgba(255,220,26,${0.16 + fade * 0.55})` : `rgba(255,255,255,${0.1 + fade * 0.35})`;
        ctx.lineWidth = (b.mode === 'shot' ? 3.2 : 1.8) * fade + 0.6;
        ctx.stroke();
      }
      ctx.lineCap = 'butt';
    }
    ctx.beginPath(); ctx.arc(bx + 1.2, by + 1.6, br, 0, Math.PI * 2); ctx.fillStyle = 'rgba(0,0,0,.3)'; ctx.fill();
    ctx.beginPath(); ctx.arc(bx, by, br, 0, Math.PI * 2); ctx.fillStyle = '#ffffff'; ctx.fill();
    ctx.lineWidth = Math.max(1.4, br * 0.35); ctx.strokeStyle = '#101014'; ctx.stroke();
    ctx.fillStyle = '#101014';
    ctx.beginPath(); ctx.arc(bx, by, br * 0.34, 0, Math.PI * 2); ctx.fill();

    // 골대 강타·선방 스파크 (엔진의 fx 채널을 화면에 그립니다)
    if (S === m) drawFx(CX, CYp, scale, a);

    // 구단 약칭 + 공격 방향 (코너)
    ctx.font = '900 11px "Pretendard Variable", Pretendard, sans-serif';
    ctx.fillStyle = c.ink; ctx.globalAlpha = 0.8;
    const arrow = (dir) => (dir > 0 ? '▶' : '◀');
    ctx.textAlign = 'left'; ctx.fillText(`${S.sides.home.team.short} ${arrow(S.sides.home.dir)}`, 8, 16);
    ctx.textAlign = 'right'; ctx.fillText(`${arrow(S.sides.away.dir)} ${S.sides.away.team.short}`, cssW - 8, 16);
    ctx.globalAlpha = 1;
  }

  /* ── fx 채널 그리기 — 골대 강타(흰 스파크) · 선방(스파크) · 카드(선수 위로 떠오름) ── */
  const FX_TICKS = 1.4;
  function drawFx(CX, CYp, scale, a) {
    const list = m.fx;
    if (!list || !list.length) return;
    for (let i = Math.max(0, list.length - 24); i < list.length; i++) {
      const f = list[i];
      if (!f) continue;
      const age = m.t - f.at + a;
      if (age < 0 || age > FX_TICKS) continue;
      const k = clamp01(age / FX_TICKS);
      if (f.kind === 'woodwork') {
        // 골대를 맞은 자리에서 흰 스파크가 터집니다
        const x = CX(f.x), y = CYp(f.y);
        ctx.save();
        ctx.globalAlpha = 1 - k * 0.9;
        ctx.strokeStyle = '#ffffff'; ctx.lineWidth = Math.max(2, scale * 0.3);
        ctx.beginPath(); ctx.arc(x, y, (1.0 + k * 4.6) * scale, 0, Math.PI * 2); ctx.stroke();
        for (let s2 = 0; s2 < 8; s2++) {
          const ang = (s2 / 8) * Math.PI * 2 + k * 0.8;
          const r0 = (0.5 + k * 1.5) * scale, r1 = (1.9 + k * 5.0) * scale;
          ctx.beginPath();
          ctx.moveTo(x + Math.cos(ang) * r0, y + Math.sin(ang) * r0);
          ctx.lineTo(x + Math.cos(ang) * r1, y + Math.sin(ang) * r1);
          ctx.stroke();
        }
        ctx.restore();
      } else if (f.kind === 'save') {
        // 키퍼 손끝에서 공을 쳐낸 스파크
        const x = CX(f.x), y = CYp(f.y);
        ctx.save();
        ctx.globalAlpha = 1 - k * 0.85;
        ctx.strokeStyle = f.big ? '#ffdc1a' : '#ffffff';
        ctx.lineWidth = Math.max(2, scale * 0.28);
        ctx.beginPath(); ctx.arc(x, y, (0.9 + k * 4.0) * scale, 0, Math.PI * 2); ctx.stroke();
        for (let s2 = 0; s2 < 6; s2++) {
          const ang = -Math.PI / 2 + (s2 - 2.5) * 0.42;
          const r0 = (0.4 + k * 1.3) * scale, r1 = (1.7 + k * 4.0) * scale;
          ctx.beginPath();
          ctx.moveTo(x + Math.cos(ang) * r0, y + Math.sin(ang) * r0);
          ctx.lineTo(x + Math.cos(ang) * r1, y + Math.sin(ang) * r1);
          ctx.stroke();
        }
        ctx.restore();
      } else if (f.kind === 'card') {
        let who = null;
        for (const s2 of ['home', 'away']) who = who || m.sides[s2].players.find((e) => e.id === f.pid);
        if (!who) continue;
        const x = CX(who.x), y = CYp(who.y) - (2.0 + k * 2.6) * scale;
        ctx.save();
        ctx.globalAlpha = 1 - k * 0.7;
        ctx.fillStyle = f.color === 'red' ? '#ff614a' : '#ffdc1a';
        ctx.strokeStyle = '#101014'; ctx.lineWidth = 1.4;
        const cw = Math.max(4, scale * 0.62), ch = cw * 1.45;
        ctx.fillRect(x - cw / 2, y - ch / 2, cw, ch);
        ctx.strokeRect(x - cw / 2, y - ch / 2, cw, ch);
        ctx.restore();
      }
    }
  }

  function contrastFor(c) {
    const hex = String(c || '#ffffff').replace('#', '');
    const r = parseInt(hex.slice(0, 2), 16), g = parseInt(hex.slice(2, 4), 16), b = parseInt(hex.slice(4, 6), 16);
    const lum = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
    return lum > 0.62 ? '#101014' : '#ffffff';
  }

  /* ── 패널 갱신 ── */
  const statRows = [    ['shots', '슈팅'], ['onTarget', '유효슈팅'], ['xg', '기대득점(xG)'], ['saves', '선방'],
    ['corners', '코너킥'], ['fouls', '파울'], ['offsides', '오프사이드'], ['yellow', '경고'], ['red', '퇴장'],
  ];
  /* ── 성향 배지 ──
     상단 스코어바와 실시간 기록에 두 팀의 '지금' 성향을 그립니다.
     AI 감독이 맞대응으로 성향을 바꾸면 같은 순간 중계·기록과 함께 이 배지가 갱신됩니다. */
  const mentLevel = (v) => (v >= 0.75 ? 'all' : v >= 0.25 ? 'atk' : v <= -0.75 ? 'lock' : v <= -0.25 ? 'def' : 'bal');
  function renderMentality() {
    const hv = Number(m.sides.home.tactic.mentality) || 0;
    const av = Number(m.sides.away.tactic.mentality) || 0;
    for (const [id, v] of [['m-ment-home', hv], ['m-ment-away', av]]) {
      const el = $(id);
      if (!el) continue;
      el.textContent = mentalityOf(v).name;
      el.dataset.v = mentLevel(v);
      el.title = `현재 팀 성향 · ${mentalityOf(v).name}`;
    }
    const myV = Number(m.sides[m.userSide].tactic.mentality) || 0;
    const oppSide = m.userSide === 'home' ? 'away' : 'home';
    const oppV = Number(m.sides[oppSide].tactic.mentality) || 0;
    const my = $('ml-my'), opp = $('ml-opp');
    if (my) { my.textContent = mentalityOf(myV).name; my.dataset.v = mentLevel(myV); }
    if (opp) { opp.textContent = mentalityOf(oppV).name; opp.dataset.v = mentLevel(oppV); }
    const note = $('m-coach-note');
    if (note) {
      const log = m.coachLog || [];
      const last = log.length ? log[log.length - 1] : null;
      note.textContent = last ? `AI 감독 ${last.minute}' 변경 ×${log.length}` : 'AI 감독 맞대응';
      note.dataset.on = last ? '1' : '0';
    }
  }

  function renderStats() {
    renderMentality();
    const s = m.stats();
    $('poss-h').style.width = s.possession.home + '%';
    $('poss-a').style.width = s.possession.away + '%';
    $('poss-hl').textContent = s.possession.home + '%';
    $('poss-al').textContent = s.possession.away + '%';
    $('m-statrows').innerHTML = statRows.map(([k, label]) => {
      const h = s[k].home, a = s[k].away;
      const fmtv = k === 'xg' ? (v) => Number(v).toFixed(2) : (v) => v;
      return `<tr><td class="sv ${h >= a ? 'lead' : ''}">${fmtv(h)}</td><th>${label}</th><td class="sv ${a > h ? 'lead' : ''}">${fmtv(a)}</td></tr>`;
    }).join('');
    $('m-score').textContent = `${shownScore.home} - ${shownScore.away}`;
    $('m-clock').textContent = m.clock();
    $('m-half').textContent = m.aet ? (m.t > m.ft90 ? '연장 후반' : '연장') : m.half === 1 ? '전반' : '후반';
    $('m-dir').textContent = `${m.sides.home.team.short} ${m.sides.home.dir > 0 ? '→' : '←'}`;
    $('m-events').textContent = `${m.events.length}개`;
  }

  function renderFeed() {
    $('feed').innerHTML = m.commentary.filter((c) => !held.has(c.id)).slice(0, 24).map((c) =>
      `<li class="ev-${c.type} ${c.side ? 'side-' + c.side : ''}"><span class="min">${c.label || c.minute + "'"}</span><span>${esc(c.text)}</span>${
        c.type === 'goal' ? `<button type="button" class="feed-rp" data-replay="${c.id}" title="이 득점 장면을 0.35x 리플레이로" aria-label="득점 리플레이">🎬</button>` : ''}</li>`).join('');
  }

  let lastTickerId = 0;
  function renderTicker() {
    const c = m.commentary.find((x) => !held.has(x.id));
    if (!c || c.id === lastTickerId) return;
    lastTickerId = c.id;
    $('tk-min').textContent = c.label || `${c.minute}'`;
    const el = $('tk-text');
    // 골 멘트는 이미 분을 달고 있어 티커에서 한 번만 보이게 정리합니다
    el.textContent = c.text.replace(/^⚽\s*\d+(?:\+\d+)?'\s*/, '⚽ ');
    el.classList.remove('tk-in');
    void el.offsetWidth;
    el.classList.add('tk-in');
  }

  function badgeFor(e) {
    let out = '';
    if (e.st.yellow > 0 && e.st.red === 0) out += `<i class="cb y" title="경고">▮</i>`;
    if (e.st.red > 0) out += `<i class="cb r" title="퇴장">▮</i>`;
    if (e.injured) out += `<i class="cb i" title="부상">+</i>`;
    return out;
  }

  function renderRatings() {
    const opp = m.userSide === 'home' ? 'away' : 'home';
    const row = (e, rating) => `<li class="${e.onPitch ? '' : 'off'}">
      <span class="rn">${e.num}</span><span class="rname">${esc(e.name)}</span><span class="pos">${e.pos}</span>
      ${badgeFor(e)}<b class="${rating >= 7.5 ? 'hi' : rating < 6 ? 'lo' : ''}">${rating.toFixed(1)}</b>${e.st.goals ? `<i class="g">${'⚽'.repeat(Math.min(e.st.goals, 3))}</i>` : ''}</li>`;
    $('ratings-my').innerHTML = m.ratings(m.userSide).map((x) => row(x.e, x.rating)).join('');
    $('ratings-opp').innerHTML = m.ratings(opp).map((x) => row(x.e, x.rating)).join('');
  }

  function showFlash(ev) {
    const t = w.teams[ev.side === 'home' ? m.homeId : m.awayId];
    flash.innerHTML = `<span class="gf-badge" data-team="${t.id}">${esc(t.short)}</span>
      <b>⚽ GOAL!</b>
      <span class="gf-name">${esc(ev.scorer || '')}${ev.assist ? ` <small>도움 ${esc(ev.assist)}</small>` : ''}</span>
      <span class="gf-score">${(ev.score || m.score).home} - ${(ev.score || m.score).away}</span>`;
    flash.dataset.team = t.id;
    flash.hidden = false;
    clearTimeout(flashTimer);
    flashTimer = setTimeout(() => { flash.hidden = true; }, 2600);
  }

  /* ── 드로어(전술·교체) ──
     화면 밖으로 잘리던 사이드 패널을 '화면 안 고정 시트'로 바꿨습니다.
     열면 경기가 자동으로 멈추고(초 단위로 흘러가며 조작을 놓치지 않게), 닫으면 원래 배속으로 돌아옵니다. */
  let pauseBeforeDrawer = null;      // 드로어를 열기 전에 이미 멈춰 있었는지
  function setDrawerPause(open) {
    const pauseBtn = $('m-pause');
    if (open) {
      if (pauseBeforeDrawer == null) pauseBeforeDrawer = paused;
      if (!paused) {
        paused = true;
        if (pauseBtn) { pauseBtn.textContent = '재생'; pauseBtn.setAttribute('aria-pressed', 'true'); }
      }
    } else if (pauseBeforeDrawer === false) {
      paused = false;
      if (pauseBtn) { pauseBtn.textContent = '일시정지'; pauseBtn.setAttribute('aria-pressed', 'false'); }
      if (!raf && !m.done && speed !== 0) start();
    }
    if (!open) pauseBeforeDrawer = null;
  }

  // 역할 목록 — 지금 이 자리에 선 선수와 그 역할
  function mySlots() {
    const side = m.sides[m.userSide];
    return side.players.map((e) => ({ e, label: e.label || e.slot?.label || e.pos, role: m.roleOf(e), num: e.num, name: e.name, pos: e.pos }));
  }

  function roleGridHtml() {
    return `<div class="role-grid" role="group" aria-label="포지션별 역할">
      ${mySlots().filter((r) => r.pos !== 'GK').map((r) => {
        const opts = rolesForLabel(r.label);
        const next = nextRole(r.label, r.role);
        return `<button type="button" class="role-row" data-mrole="${r.e.id}" title="${esc(roleLabel(r.role))} — 누르면 ${esc(roleLabel(next))}"
          aria-label="${esc(r.label)} ${esc(r.name)} · ${esc(roleLabel(r.role))} · 눌러서 ${esc(roleLabel(next))}로 바꾸기" aria-pressed="true">
          <span class="rr-pos">${esc(r.label)}</span>
          <span class="rr-name">${esc(r.name)}</span>
          <span class="rr-role">${esc(roleShort(r.role))}${opts.length > 1 ? ' ↻' : ''}</span>
        </button>`;
      }).join('')}
    </div>`;
  }

  // 경기 중 역할 변경을 커리어 세이브(자리별 역할)에도 남깁니다
  function syncRoles() {
    const side = m.sides[m.userSide];
    const slots = FORMATIONS[side.formation]?.slots || [];
    app.world.myLineup.formation = side.formation;
    app.world.myLineup.roles = slots.map((sl) => {
      const e = side.players.find((p) => p.onPitch && p.slot === sl);
      return e ? m.roleOf(e) : defaultRole(sl.label);
    });
    app.save();
  }

  function renderDrawer() {
    const el = $('drawer');
    if (!drawer) { el.hidden = true; el.innerHTML = ''; document.body.classList.remove('drawer-open'); return; }
    el.hidden = false;
    document.body.classList.add('drawer-open');
    if (drawer === 'tactics') {
      const side = m.sides[m.userSide];
      const ment = Number(side.tactic.mentality) || 0;
      el.innerHTML = `<div class="drawer-head"><h3>전술 즉시 변경 <span class="pill">${esc(mentalityOf(ment).name)}</span></h3><button class="btn small" data-mact="close">닫기</button></div>
      <div class="drawer-sec"><h4>팀 성향</h4>
        <div class="ment-row in-game" role="group" aria-label="팀 성향">
          ${MENTALITY.map((mt) => `<button type="button" class="ment-btn ${Math.abs(mt.v - ment) < 0.01 ? 'on' : ''}" data-mment="${mt.v}" aria-pressed="${Math.abs(mt.v - ment) < 0.01}">${esc(mt.name)}</button>`).join('')}
        </div>
        <p class="axis-eff">${esc(mentalityEffect(ment, true))}</p>
      </div>
      <div class="drawer-sec"><h4>포메이션</h4>
        <div class="form-row">${formationsFor(side.players.length).map((f) => `<button type="button" class="btn small ${side.formation === f ? 'on' : ''}" data-mform="${f}" aria-pressed="${side.formation === f}">${f}</button>`).join('')}</div>
      </div>
      <div class="drawer-sec"><h4>포지션별 역할 <span class="hint-inline">자리를 누르면 역할이 바뀝니다</span></h4>
        ${roleGridHtml()}
      </div>
      <div class="drawer-sec"><h4>세트피스 지시 <span class="hint-inline">다음 세트피스부터</span></h4>
        <ul class="axes compact sp-axes">${setPieceRows(side.setpiece, (t, k) => `data-msp="${t}" data-key="${k}"`, { compact: true })}</ul>
      </div>
      <div class="drawer-sec"><h4>전술 4축</h4>
        <ul class="axes compact">${AXES.map((a) => {
          const v = side.tactic[a.key] || 0;
          return `<li class="axis"><div class="axis-head"><b>${a.name}</b><span class="axis-val">${stepLabel(v)}</span></div>
          <div class="axis-ctl"><span class="axis-end">${a.left}</span><span class="seg">${STEPS.map((s) => `<button type="button" class="${Math.abs(s - v) < 0.01 ? 'on' : ''}" data-mtactic="${a.key}" data-val="${s}" aria-label="${a.name}" aria-pressed="${Math.abs(s - v) < 0.01}">${s > 0 ? '▲' : s < 0 ? '▼' : '●'}</button>`).join('')}</span><span class="axis-end">${a.right}</span></div>
          <p class="axis-eff">${a.effect(v)}</p></li>`;
        }).join('')}</ul>
      </div>`;
      el.querySelectorAll('[data-mment]').forEach((b) => b.addEventListener('click', () => {
        const v = Number(b.dataset.mment);
        m.setTactic({ mentality: v });
        app.world.myLineup.tactic = { ...m.sides[m.userSide].tactic };
        app.save(); renderDrawer(); draw(1);
        app.toast?.(`팀 성향 · ${mentalityOf(v).name}`, 'ok');
      }));
      el.querySelectorAll('[data-mtactic]').forEach((b) => b.addEventListener('click', () => {
        m.setTactic({ [b.dataset.mtactic]: Number(b.dataset.val) });
        app.world.myLineup.tactic = { ...m.sides[m.userSide].tactic };
        app.save(); renderDrawer();
      }));
      el.querySelectorAll('[data-mform]').forEach((b) => b.addEventListener('click', () => {
        const prev = app.world.myLineup.formation;
        m.setFormation(b.dataset.mform);
        app.world.myLineup.formation = b.dataset.mform;
        app.world.myLineup.roles = X.remapRoles(app.world.myLineup.roles, prev, b.dataset.mform);
        syncRoles();
        renderDrawer(); draw(1);
      }));
      el.querySelectorAll('[data-msp]').forEach((b) => b.addEventListener('click', () => {
        const got = m.setSetPiece({ [b.dataset.msp]: b.dataset.key });
        if (!got) return;
        app.world.myLineup.setpiece = { ...got };
        app.save(); renderDrawer();
        app.toast?.(`세트피스 · ${setPieceLabel(b.dataset.msp, got[b.dataset.msp])}`, 'ok');
      }));
      el.querySelectorAll('[data-mrole]').forEach((b) => b.addEventListener('click', () => {
        const e = m.sides[m.userSide].players.find((p) => p.id === b.dataset.mrole && p.onPitch);
        if (!e) return;
        const label = e.label || e.slot?.label || e.pos;
        const got = m.setRoleAt(e, nextRole(label, m.roleOf(e)));
        if (!got) return;
        syncRoles();
        app.toast?.(`${label} · ${roleLabel(got)} — ${roleEffect(got)}`, 'ok');
        renderDrawer();
      }));
    }
    if (drawer === 'subs') {
      const side = m.sides[m.userSide];
      const left = 5 - side.subsUsed;
      el.innerHTML = `<div class="drawer-head"><h3>선수 교체 <span class="pill">${left}명 남음</span></h3><button class="btn small" data-mact="close">닫기</button></div>
        <p class="hint">나갈 선수를 먼저 누르고, 들어올 후보를 누르세요. 부상(🚑) 선수는 교체를 권합니다.</p>
        <div class="sub-cols">
          <div><h4>나갈 선수</h4><ul class="sub-list">${side.players.filter((e) => e.onPitch).map((e) => `<li><button type="button" class="sub-btn ${outPid === e.id ? 'sel' : ''}" data-out="${e.id}"><span class="rn">${e.num}</span><span>${esc(e.name)}</span><small>${e.pos} · 체력 ${Math.round(e.stamina)}%${e.injured ? ' · 🚑' : ''}${e.st.yellow ? ' · 🟨' : ''}</small></button></li>`).join('')}</ul></div>
          <div><h4>들어올 후보</h4><ul class="sub-list">${side.bench.filter((e) => !e.onPitch).map((e) => `<li><button type="button" class="sub-btn" data-in="${e.id}" ${outPid ? '' : 'disabled'}><span class="rn">${e.num}</span><span>${esc(e.name)}</span><small>${e.pos} · ${e.p.ovr}</small></button></li>`).join('') || '<li class="muted sm">후보가 없습니다.</li>'}</ul></div>
        </div>`;
      el.querySelectorAll('[data-out]').forEach((b) => b.addEventListener('click', () => { outPid = b.dataset.out; renderDrawer(); }));
      el.querySelectorAll('[data-in]').forEach((b) => b.addEventListener('click', () => {
        if (!outPid) return;
        const r = m.sub(outPid, b.dataset.in);
        if (!r.ok) { app.toast(r.why); return; }
        app.world.myLineup = { ...app.world.myLineup, starters: m.sides[m.userSide].players.map((e) => e.id), bench: m.sides[m.userSide].bench.filter((e) => !e.onPitch).map((e) => e.id) };
        outPid = null;
        $('sub-count').textContent = String(5 - m.sides[m.userSide].subsUsed);
        renderDrawer(); renderRatings(); renderFeed();
        app.save();
      }));
    }
    el.querySelectorAll('[data-mact="close"]').forEach((b) => b.addEventListener('click', () => { drawer = null; setDrawerPause(false); renderDrawer(); }));
  }

  /* ── 하프타임(라커룸) ── */
  function renderHalftime() {
    const side = m.sides[m.userSide];
    const s = m.stats();
    $('ht-score').textContent = `${m.score.home} - ${m.score.away}`;
    const my = m.userSide === 'home' ? s.shots.home : s.shots.away;
    const opp = m.userSide === 'home' ? s.shots.away : s.shots.home;
    $('ht-note').textContent = `전반 ${m.clock()} 종료 — 슈팅 ${my} : ${opp}. 라커룸에서 전술·역할·선수를 정비하세요.`;
    const ment = Number(side.tactic.mentality) || 0;
    const axes = AXES.map((a) => {
      const v = side.tactic[a.key] || 0;
      return `<li class="axis"><div class="axis-head"><b>${a.name}</b><span class="axis-val">${stepLabel(v)}</span></div>
        <div class="axis-ctl"><span class="axis-end">${a.left}</span>
        <span class="seg">${STEPS.map((x) => `<button type="button" class="${Math.abs(x - v) < 0.01 ? 'on' : ''}" data-ht="${a.key}" data-val="${x}" aria-pressed="${Math.abs(x - v) < 0.01}">${x > 0 ? '▲' : x < 0 ? '▼' : '●'}</button>`).join('')}</span>
        <span class="axis-end">${a.right}</span></div></li>`;
    }).join('');
    const bench = side.bench.filter((e) => !e.onPitch);
    const posLabel = (e) => (e.injured ? '🚑 ' : '') + e.pos;
    const subs = side.players.filter((e) => e.onPitch).map((e) => `<li>
        <button type="button" class="sub-btn ${outPid === e.id ? 'sel' : ''}" data-htout="${e.id}">
          <span class="rn">${e.num}</span><span>${esc(e.name)}</span>
          <small>${e.pos} · 체력 ${Math.round(e.stamina)}%${e.injured ? ' · 🚑' : ''}</small>
        </button></li>`).join('');
    $('ht-body').innerHTML = `<div class="ht-cols">
      <div><h4>팀 성향 <span class="pill">${esc(mentalityOf(ment).name)}</span></h4>
        <div class="ment-row in-game" role="group" aria-label="팀 성향">
          ${MENTALITY.map((mt) => `<button type="button" class="ment-btn ${Math.abs(mt.v - ment) < 0.01 ? 'on' : ''}" data-htment="${mt.v}" aria-pressed="${Math.abs(mt.v - ment) < 0.01}">${esc(mt.name)}</button>`).join('')}
        </div>
        <p class="axis-eff">${esc(mentalityEffect(ment, true))}</p>
        <ul class="axes compact">${axes}</ul>
        <h4 class="ht-sub">포지션별 역할 <span class="hint-inline">자리를 누르면 역할이 바뀝니다</span></h4>
        ${roleGridHtml()}
        <h4 class="ht-sub">포메이션 <span class="hint-inline">후반 시작부터</span></h4>
        <div class="form-row" role="group" aria-label="포메이션">
          ${formationsFor(side.players.length).map((f) => `<button type="button" class="btn small ${side.formation === f ? 'on' : ''}" data-htform="${f}" aria-pressed="${side.formation === f}" title="${esc(FORMATIONS[f].shape)}">${f}</button>`).join('')}
        </div>
        <h4 class="ht-sub">세트피스 지시</h4>
        <ul class="axes compact sp-axes">${setPieceRows(side.setpiece, (t, k) => `data-htsp="${t}" data-key="${k}"`, { compact: true })}</ul>
      </div>
      <div><h4>선수 교체 <span class="pill">${5 - side.subsUsed}명 남음</span></h4>
        <p class="hint">나갈 선수를 고른 뒤 들어올 후보를 누르세요.</p>
        <div class="sub-cols ht-subcols">
          <div><h5>나갈 선수</h5><ul class="sub-list">${subs}</ul></div>
          <div><h5>들어올 후보</h5><ul class="sub-list">${bench.map((e) => `<li><button type="button" class="sub-btn" data-htin="${e.id}" ${outPid ? '' : 'disabled'}><span>${esc(e.name)}</span><small>${posLabel(e)} ${e.p.ovr}</small></button></li>`).join('') || '<li class="muted sm">후보가 없습니다.</li>'}</ul></div>
        </div>
      </div>
    </div>`;
    $('ht-body').querySelectorAll('[data-htment]').forEach((b) => b.addEventListener('click', () => {
      const v = Number(b.dataset.htment);
      m.setTactic({ mentality: v });
      app.world.myLineup.tactic = { ...m.sides[m.userSide].tactic };
      app.save(); renderHalftime();
      app.toast?.(`팀 성향 · ${mentalityOf(v).name} — ${mentalityEffect(v, true)}`, 'ok');
    }));
    $('ht-body').querySelectorAll('[data-ht]').forEach((b) => b.addEventListener('click', () => {
      m.setTactic({ [b.dataset.ht]: Number(b.dataset.val) });
      app.world.myLineup.tactic = { ...m.sides[m.userSide].tactic };
      app.save(); renderHalftime();
    }));
    $('ht-body').querySelectorAll('[data-mrole]').forEach((b) => b.addEventListener('click', () => {
      const e = m.sides[m.userSide].players.find((p) => p.id === b.dataset.mrole && p.onPitch);
      if (!e) return;
      const label = e.label || e.slot?.label || e.pos;
      const got = m.setRoleAt(e, nextRole(label, m.roleOf(e)));
      if (!got) return;
      syncRoles();
      app.toast?.(`${label} · ${roleLabel(got)} — ${roleEffect(got)}`, 'ok');
      renderHalftime();
    }));
    $('ht-body').querySelectorAll('[data-htform]').forEach((b) => b.addEventListener('click', () => {
      const prev = app.world.myLineup.formation || side.formation;
      m.setFormation(b.dataset.htform);
      app.world.myLineup.formation = b.dataset.htform;
      app.world.myLineup.roles = X.remapRoles(app.world.myLineup.roles, prev, b.dataset.htform);
      syncRoles();
      app.toast?.(`포메이션 · ${b.dataset.htform} — 후반부터 이 모양으로 섭니다`, 'ok');
      renderHalftime();
    }));
    $('ht-body').querySelectorAll('[data-htsp]').forEach((b) => b.addEventListener('click', () => {
      const got = m.setSetPiece({ [b.dataset.htsp]: b.dataset.key });
      if (!got) return;
      app.world.myLineup.setpiece = { ...got };
      app.save();
      app.toast?.(`세트피스 · ${setPieceLabel(b.dataset.htsp, got[b.dataset.htsp])}`, 'ok');
      renderHalftime();
    }));
    $('ht-body').querySelectorAll('[data-htout]').forEach((b) => b.addEventListener('click', () => { outPid = b.dataset.htout; renderHalftime(); }));
    $('ht-body').querySelectorAll('[data-htin]').forEach((b) => b.addEventListener('click', () => {
      if (!outPid) return;
      const r = m.sub(outPid, b.dataset.htin);
      if (!r.ok) { app.toast(r.why); return; }
      outPid = null;
      $('sub-count').textContent = String(5 - m.sides[m.userSide].subsUsed);
      app.save(); renderHalftime(); renderRatings(); renderFeed();
    }));
    $('halftime').hidden = false;
  }

  /* ── 결과 ── */
  function showResult() {
    const s = m.stats();
    held.clear();          // 남아 있던 판정도 결과 화면에서는 모두 공개
    const isMyWin = (m.result?.winner || (m.score.home > m.score.away ? 'home' : m.score.home < m.score.away ? 'away' : null)) === m.userSide;
    const isDraw = !m.pens && m.score.home === m.score.away;
    $('ov-eyebrow').textContent = meta.cup ? (m.aet ? 'EXTRA TIME · FULL TIME' : 'CUP · FULL TIME') : 'FULL TIME';
    $('ov-title').textContent = `${m.score.home} - ${m.score.away}${m.pens ? ` (PK ${m.pens.text})` : ''}`;
    $('ov-sub').textContent = isDraw ? '무승부 — 승점 1점씩 나눠 가집니다.' : isMyWin ? '승리! 순위표에 승점 3점이 더해집니다.' : '패배 — 다음 경기에서 만회합시다.';
    $('ov-stats').innerHTML = [
      ['점유율', `${s.possession.home}%`, `${s.possession.away}%`],
      ['슈팅', s.shots.home, s.shots.away],
      ['유효슈팅', s.onTarget.home, s.onTarget.away],
      ['xG', s.xg.home.toFixed(2), s.xg.away.toFixed(2)],
      ['코너킥', s.corners.home, s.corners.away],
      ['파울', s.fouls.home, s.fouls.away],
      ['오프사이드', s.offsides.home, s.offsides.away],
      ['경고 / 퇴장', `${s.yellow.home} / ${s.red.home}`, `${s.yellow.away} / ${s.red.away}`],
    ].map(([k, h, a]) => `<div class="ov-row"><b>${h}</b><span>${k}</span><b>${a}</b></div>`).join('');
    // 이번 경기로 자라는 선수 — applyResult 가 그대로 반영할 값입니다.
    const grow = (() => {
      try { return growthPreview(app.world, m); } catch { return []; }
    })();
    const moved = grow.filter((g) => g.d !== 0 || g.plus.length || g.minus.length);
    $('ov-growth').innerHTML = moved.length
      ? `<div class="ovg-head"><b>선수 성장</b><span>출전·평점·득점 반영</span></div>
        <ul class="ovg-list">${moved.slice(0, 5).map((g) => {
          const words = [...new Set([...g.plus.map((k) => '+' + (STAT_LABEL[k] || k)), ...g.minus.map((k) => '-' + (STAT_LABEL[k] || k))])].join(' · ');
          return `<li><b>${esc(g.name)}</b><span class="ovg-num ${g.d < 0 ? 'down' : 'up'}">${g.d ? `${g.from}→${g.to}` : g.to}</span><small>${esc(words || '변화 없음')} · 잠재 ${g.pot}</small></li>`;
        }).join('')}</ul>
        ${moved.length > 5 ? `<p class="ovg-more">외 ${moved.length - 5}명은 선수단 표에서 볼 수 있습니다</p>` : ''}`
      : '';
    $('m-overlay').hidden = false;
    if (lastClip) $('ov-replay').hidden = false;
    cancelAnimationFrame(raf); raf = 0;
    syncScore();
    renderStats(); renderRatings(); renderFeed(); draw(1);
  }

  /* ── 방금 공개된 중계 이벤트 처리 ── */
  function applyEvents(evs) {
    for (const ev of evs) {
      if (ev.type === 'shot') {
        diag.trace.push({ k: 'shot', t: m.t, evTick: ev.tick, ms: performance.now(), flashHidden: flash.hidden, score: `${m.score.home}-${m.score.away}`, shown: `${shownScore.home}-${shownScore.away}`, x: Math.round(m.ball.x * 10) / 10, mode: m.ball.mode });
      }
      if (ev.type === 'goal') {
        if (ev.score) syncScoreTo(ev.score);
        diag.trace.push({ k: 'goal', t: m.t, evTick: ev.tick, ms: performance.now(), score: `${m.score.home}-${m.score.away}`, shown: `${shownScore.home}-${shownScore.away}`, x: Math.round(m.ball.x * 10) / 10, flashWasHidden: flash.hidden });
        showFlash(ev);
        beginClip(ev);
      }
      if (ev.type === 'injury' && ev.side === m.userSide) app.toast('🚑 부상 — 교체를 검토하세요', 'warn');
      if (ev.type === 'card' && ev.side === m.userSide) app.toast('🟨 경고 — 몸조심', 'warn');
    }
  }
  function syncScoreTo(sc) {
    shownScore.home = sc.home;
    shownScore.away = sc.away;
  }

  /* ── 루프 ── */
  function stepToEnd() {
    m.holdHalf = false;
    let guard = 0;
    while (!m.done && guard < 4000) { m.tick(); guard++; }
    if (!m.done) m.finish();
    showResult();
  }

  function frame(now) {
    if (!raf) return;
    const dt = Math.min(now - lastT, 400);
    lastT = now;
    diag.frames = (diag.frames || 0) + 1;
    if (speed === 0) { raf = 0; stepToEnd(); return; }
    const interval = BASE_MS / speed;
    if (!paused && m.phase !== 'half') {
      acc += dt;
      let guard = 0;
      while (acc >= interval && !m.done && m.phase !== 'half' && guard < 8) { acc -= interval; m.tick(); guard++; }
      if (m.done) { raf = 0; showResult(); return; }
    }
    alpha = paused ? 1 : Math.min(acc / interval, 1);
    diag.alpha = alpha;
    // 모든 국면(세트피스·득점 연출 포함)을 같은 규칙으로 보간합니다 — 화면이 멈춰 보이지 않게
    const a = alpha;
    // 득점 연출이 끝나고 재개되는 프레임에 GOAL 배너를 닫습니다 — 다음 플레이를 가리지 않게
    if (m.phase === 'goal') goalPhase = true;
    else if (goalPhase) { goalPhase = false; clearTimeout(flashTimer); flash.hidden = true; }
    draw(a);

    // 점검용: 슛이 날아가는 프레임에 GOAL 배너가 떠 있으면 세어 둡니다
    if (m.ball.mode === 'shot') { diag.shotFrames += 1; if (!flash.hidden) diag.shotFramesBad += 1; }

    // 리플레이용 링 버퍼 — 화면에 보이는 좌표를 그대로 남깁니다
    if (!replay.on && now >= rec.next) {
      rec.next = now + CAP_MS;
      const f = capture(now, a);
      rec.frames.push(f);
      if (rec.frames.length > 260) rec.frames.shift();   // 약 11초
      if (rec.recording) {
        // 골 직후 연출(경기 시계가 멈춘 구간)은 몇 프레임만 담고 바로 클립을 닫습니다
        // — 재개(킥오프) 장면이 클립에 섞이지 않게.
        const rc = rec.recording;
        if (rc.frames.length < rc.max) rc.frames.push(f);
        if (f.tick > rc.untilTick || rc.frames.length >= rc.max) finalizeClip();
      }
    }

    if (m.events.length !== lastStats) {
      const fresh = m.events.slice(lastStats);
      lastStats = m.events.length;
      // 공이 아직 날아오는 중인 판정은 잠시 보류하고, 도착한 다음 틱에 보여 줍니다
      const nowShown = [];
      for (const ev of fresh) {
        // 한 틱(= 화면에서 공이 목표까지 날아가는 시간)만큼만 늦춰 공개합니다.
        // 득점 세리머니처럼 경기 시계가 멈춘 구간에서도 배너가 바로 뜨도록 시간 기준을 씁니다.
        if (HOLD.has(ev.type) && ev.tick >= m.t) held.set(ev.id, { ev, at: now + BASE_MS / Math.max(speed || 1, 0.25) });
        else nowShown.push(ev);
      }
      applyEvents(nowShown);
      renderStats(); renderFeed(); renderTicker();
      if (m.events.length - lastRatings > 5) { renderRatings(); lastRatings = m.events.length; }
    }
    // 도착 다음 틱 — 보류했던 판정(골·선방·골대·빗나감)을 공개합니다
    if (held.size) {
      const due = [];
      for (const [id, h] of held) if (now >= h.at) { due.push(h.ev); held.delete(id); }
      if (due.length) {
        applyEvents(due);
        renderStats(); renderFeed(); renderTicker();
        if (m.events.length - lastRatings > 5) { renderRatings(); lastRatings = m.events.length; }
      }
    }
    if (m.phase === 'half' && !halfShown) {
      halfShown = true;
      renderHalftime();
      renderStats(); renderRatings(); renderFeed(); renderTicker();
      draw(1);
    }
    raf = requestAnimationFrame(frame);
  }

  function start() {
    cancelAnimationFrame(raf);
    lastT = performance.now(); acc = 0;
    raf = requestAnimationFrame(frame);
  }

  /* ── 조작 ── */
  root.querySelectorAll('[data-speed]').forEach((b) => b.addEventListener('click', () => {
    if (replay.on) endReplay();
    speed = Number(b.dataset.speed);
    m.setSpeed(speed || 1);        // 득점 연출 길이를 배속에 맞춥니다(벽시계 2.3초 고정)
    root.querySelectorAll('.spd').forEach((x) => x.classList.toggle('on', x === b));
    $('m-pause').textContent = '일시정지';
    $('m-pause').setAttribute('aria-pressed', 'false');
    paused = false;
    if (m.done) return;
    if (speed === 0) { cancelAnimationFrame(raf); raf = 0; stepToEnd(); return; }
    start();
  }));
  $('m-pause').addEventListener('click', () => {
    if (replay.on) return;
    paused = !paused;
    $('m-pause').textContent = paused ? '재생' : '일시정지';
    $('m-pause').setAttribute('aria-pressed', String(paused));
    if (!paused && !raf) start();
  });
  root.querySelectorAll('[data-mact]').forEach((b) => b.addEventListener('click', () => {
    if (replay.on) endReplay();
    const act = b.dataset.mact;
    if (act === 'tactics' || act === 'subs') {
      const opening = drawer !== act;
      drawer = opening ? act : null;
      setDrawerPause(opening);
      renderDrawer();
      if (opening) $('drawer').scrollTop = 0;
    }
    if (act === 'ff') { cancelAnimationFrame(raf); raf = 0; stepToEnd(); }
  }));
  $('ht-start').addEventListener('click', () => {
    $('halftime').hidden = true;
    const keepSpeed = speed;
    m.startSecondHalf();
    // 후반에도 고른 배속(2x·4x)을 그대로 유지합니다 — 1x로 돌아가던 버그
    speed = keepSpeed;
    m.setSpeed(keepSpeed || 1);
    root.querySelectorAll('.spd').forEach((x) => x.classList.toggle('on', Number(x.dataset.speed) === keepSpeed));
    syncScore();
    halfShown = false;
    lastStats = m.events.length; lastRatings = m.events.length;   // 지난 이벤트를 다시 띄우지 않습니다
    renderStats(); renderFeed(); renderTicker(); renderRatings();
    start();
  });
  $('ov-continue').addEventListener('click', () => {
    cleanup();
    app.endMatch(m, meta);
  });

  /* ── 리플레이 조작 ── */
  const openReplay = () => startReplay(lastClip || clips[clips.length - 1]);
  $('m-replay').addEventListener('click', openReplay);
  $('goal-replay').addEventListener('click', openReplay);
  $('ov-replay').addEventListener('click', openReplay);
  $('rb-close').addEventListener('click', endReplay);
  $('rb-skip').addEventListener('click', endReplay);
  $('feed').addEventListener('click', (ev) => {
    const b = ev.target.closest('[data-replay]');
    if (!b) return;
    const clip = clips.find((c) => c.id === Number(b.dataset.replay));
    if (clip) startReplay(clip);
  });
  diag.clips = () => clips.map((c) => ({ id: c.id, scorer: c.scorer, frames: c.frames.length, span: Math.round(clipSpan(c)), score: c.scoreText, fromTick: c.fromTick, goalTick: c.goalTick, untilTick: c.untilTick, kickoff: m.lastKickoffT }));
  diag.replayState = () => ({ on: replay.on, rate: REPLAY_RATE, bar: !$('replaybar').hidden, clip: replay.clip ? replay.clip.id : null });

  const onResize = () => { resize(); draw(m.done ? 1 : alpha); };
  window.addEventListener('resize', onResize);
  document.documentElement.addEventListener('fm-theme', onResize);
  function cleanup() {
    cancelAnimationFrame(raf); raf = 0;
    cancelAnimationFrame(replay.raf); replay.raf = 0; replay.on = false;
    clearTimeout(goalCtaTimer);
    window.removeEventListener('resize', onResize);
    document.documentElement.removeEventListener('fm-theme', onResize);
    clearTimeout(flashTimer);
  }

  resize();
  m.setSpeed(speed);
  draw(0);
  renderStats();
  renderFeed();
  renderTicker();
  renderRatings();
  $('m-label').textContent = meta.label;
  start();
  return cleanup;
}
