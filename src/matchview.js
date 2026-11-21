// 라이브 매치 화면 — Canvas 2D 피치 + 60fps 보간 + 배속/전술/교체/실시간 기록
// · 엔진은 틱(경기 15초)마다 상태를 만들고, 화면은 매 프레임 이전 좌표→현재 좌표를 보간(lerp)합니다.
// · 득점 연출(슛 궤적·골키퍼 다이빙·골망), 하프타임 라커룸, 실시간 자막 티커를 담습니다.
import { W as PW, H as PH, CY, GOAL_HALF } from './match.js';
import { AXES, STEPS, stepLabel } from './tactics.js';
import { FORMATIONS } from './data.js';
import * as X from './world.js';
import { esc } from './views.js';

const SPEEDS = [{ v: 1, label: '1x' }, { v: 2, label: '2x' }, { v: 4, label: '4x' }, { v: 0, label: '즉시' }];
const BASE_MS = 230;          // 1x 에서 한 틱(경기 15초)에 걸리는 실제 시간
const lerp = (a, b, t) => a + (b - a) * t;

export function mountMatch(app, m, meta) {
  m.holdHalf = true;          // 하프타임 카드를 보여 주는 동안 엔진을 멈춥니다
  const root = document.getElementById('app');
  const w = app.world;
  const home = w.teams[m.homeId], away = w.teams[m.awayId];
  const isHome = m.userSide === 'home';
  const myTeam = isHome ? home : away;
  let speed = 1, raf = 0, lastT = performance.now(), acc = 0, alpha = 0;
  let lastStats = 0, lastRatings = 0, outPid = null, drawer = null, flashTimer = 0, halfShown = false;
  let paused = false;

  // 브라우저 자동 점검에서 읽는 진단 훅 (프레임 수·보간 계수·최근 이벤트)
  const diag = (window.__fm = window.__fm || { errors: [] });
  diag.match = m; diag.frames = 0; diag.alpha = 0; diag.score = () => `${m.score.home}-${m.score.away}`;

  root.innerHTML = `<section class="matchview">
    <div class="scorebar">
      <div class="sb-team" data-team="${home.id}">
        <span class="badge mid" data-team="${home.id}">${esc(home.short.slice(0, 2))}</span>
        <div><b>${esc(home.name)}</b><small>홈</small></div>
      </div>
      <div class="sb-mid">
        <span class="sb-score" id="m-score">0 - 0</span>
        <span class="sb-clock" id="m-clock">0'</span>
        <span class="sb-phase"><i class="half-pill" id="m-half">전반</i><i class="dir-pill" id="m-dir">${esc(home.short)} →</i></span>
      </div>
      <div class="sb-team away" data-team="${away.id}">
        <div><b>${esc(away.name)}</b><small>원정</small></div>
        <span class="badge mid" data-team="${away.id}">${esc(away.short.slice(0, 2))}</span>
      </div>
    </div>

    <div class="stage">
      <canvas id="pitch" aria-label="2D 경기장"></canvas>
      <div class="goalflash" id="goalflash" hidden></div>
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
      <button type="button" class="btn small ghost" data-mact="ff">즉시 결과 ⏩</button>
    </div>

    <div class="drawer" id="drawer" hidden></div>

    <div class="mpanels">
      <div class="card mstats">
        <div class="card-head"><h3>실시간 기록</h3><span class="pill" id="m-label">${esc(meta.label)}</span></div>
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
        <button class="btn primary big" id="ov-continue" type="button">계속 →</button>
      </div>
    </div>
  </section>`;

  const $ = (id) => document.getElementById(id);
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

  /* ── 피치 그리기 ── */
  const pos = (e, a) => ({ x: lerp(e.px, e.x, a), y: lerp(e.py, e.y, a) });

  function draw(a = 0) {
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
    const netShake = m.goalFlash && (m.t - m.goalFlash.at) < 14 && m.phase === 'goal' ? 1 : 0;
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
        const off = (1.6 * scale * i) / 3 + (netShake ? Math.sin(m.t * 1.7 + i) * 1.6 : 0);
        ctx.beginPath(); ctx.moveTo(nx0 + off, CYp(CY - GOAL_HALF)); ctx.lineTo(nx0 + off, CYp(CY + GOAL_HALF)); ctx.stroke();
      }
      ctx.strokeStyle = c.ink; ctx.lineWidth = Math.max(2, scale * 0.55);
      ctx.strokeRect(gx === 0 ? CX(-1.6) : CX(PW), CYp(CY - GOAL_HALF), 1.6 * scale, GOAL_HALF * 2 * scale);
    }

    // 세트피스 표시 (코너·프리킥 지점)
    if (m.sp) {
      const sx = CX(m.sp.x), sy = CYp(m.sp.y);
      ctx.beginPath(); ctx.arc(sx, sy, Math.max(8, scale * 1.6), 0, Math.PI * 2);
      ctx.strokeStyle = '#ffdc1a'; ctx.lineWidth = 2.4; ctx.setLineDash([4, 3]); ctx.stroke(); ctx.setLineDash([]);
    }

    // 선수
    const r = Math.max(6, scale * 2.05);
    for (const sideName of ['home', 'away']) {
      const side = m.sides[sideName];
      const t = side.team;
      for (const e of side.players) {
        if (!e.onPitch) continue;
        const p = pos(e, a);
        const px = CX(p.x), py = CYp(p.y);
        // 그림자
        ctx.fillStyle = 'rgba(0,0,0,.28)';
        ctx.beginPath(); ctx.ellipse(px + r * 0.22, py + r * 0.3, r * 0.95, r * 0.75, 0, 0, Math.PI * 2); ctx.fill();
        // 골키퍼 다이빙
        const dive = e.pos === 'GK' && e.dive && (m.t - e.dive.at) < 4 ? e.dive : null;
        if (dive) {
          const reach = (m.t - dive.at + a) / 4;
          const dy = Math.sign(dive.to || 1) * Math.min(Math.abs(dive.to), 6) * scale * 0.9 * reach;
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
        if (m.ball.owner === e) {
          ctx.beginPath(); ctx.arc(px, py, r + 3.2, 0, Math.PI * 2);
          ctx.strokeStyle = '#ffffff'; ctx.lineWidth = 2.2; ctx.setLineDash([3, 3]); ctx.stroke(); ctx.setLineDash([]);
        }
        // 체력 30% 이하
        if (e.stamina < 32) {
          ctx.beginPath(); ctx.arc(px, py, r + 6, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * (e.stamina / 100));
          ctx.strokeStyle = '#ff614a'; ctx.lineWidth = 2; ctx.stroke();
        }
        // 카드·부상 배지
        let bx = px + r * 0.85, by = py - r * 1.15;
        if (e.st.yellow > 0 && e.st.red === 0) {
          ctx.fillStyle = '#ffdc1a'; ctx.strokeStyle = '#101014'; ctx.lineWidth = 1;
          ctx.fillRect(bx, by, r * 0.52, r * 0.72); ctx.strokeRect(bx, by, r * 0.52, r * 0.72);
          bx -= r * 0.62;
        }
        if (e.st.red > 0) {
          ctx.fillStyle = '#ff614a';
          ctx.fillRect(px + r * 0.85, py - r * 1.15, r * 0.52, r * 0.72);
          ctx.strokeStyle = '#101014'; ctx.strokeRect(px + r * 0.85, py - r * 1.15, r * 0.52, r * 0.72);
        }
        if (e.injured) {
          ctx.strokeStyle = '#ffffff'; ctx.lineWidth = Math.max(2, r * 0.28);
          const ix = px - r * 1.1, iy = py - r * 1.2, s2 = r * 0.42;
          ctx.beginPath(); ctx.moveTo(ix - s2, iy); ctx.lineTo(ix + s2, iy); ctx.moveTo(ix, iy - s2); ctx.lineTo(ix, iy + s2); ctx.stroke();
          ctx.strokeStyle = '#ff614a'; ctx.lineWidth = Math.max(1.2, r * 0.16);
          ctx.beginPath(); ctx.moveTo(ix - s2, iy); ctx.lineTo(ix + s2, iy); ctx.moveTo(ix, iy - s2); ctx.lineTo(ix, iy + s2); ctx.stroke();
        }
        // 득점자 강조
        if (m.goalFlash && m.goalFlash.name === e.name && (m.t - m.goalFlash.at) < 20) {
          const pulse = 1 + Math.sin(performance.now() / 160) * 0.12;
          ctx.beginPath(); ctx.arc(px, py, (r + 7) * pulse, 0, Math.PI * 2);
          ctx.strokeStyle = '#ffdc1a'; ctx.lineWidth = 3; ctx.stroke();
        }
      }
    }

    // 공 + 슛 궤적(trail)
    const b = m.ball;
    const ballX = b.mode === 'net' ? b.x : lerp(b.px, b.x, a);
    const ballY = b.mode === 'net' ? b.y : lerp(b.py, b.y, a);
    const bx = CX(ballX), by = CYp(ballY), br = Math.max(3.4, scale * 0.95);
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

    // 구단 약칭 + 공격 방향 (코너)
    ctx.font = '900 11px "Pretendard Variable", Pretendard, sans-serif';
    ctx.fillStyle = c.ink; ctx.globalAlpha = 0.8;
    const arrow = (dir) => (dir > 0 ? '▶' : '◀');
    ctx.textAlign = 'left'; ctx.fillText(`${m.sides.home.team.short} ${arrow(m.sides.home.dir)}`, 8, 16);
    ctx.textAlign = 'right'; ctx.fillText(`${arrow(m.sides.away.dir)} ${m.sides.away.team.short}`, cssW - 8, 16);
    ctx.globalAlpha = 1;
  }

  function contrastFor(c) {
    const hex = String(c || '#ffffff').replace('#', '');
    const r = parseInt(hex.slice(0, 2), 16), g = parseInt(hex.slice(2, 4), 16), b = parseInt(hex.slice(4, 6), 16);
    const lum = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
    return lum > 0.62 ? '#101014' : '#ffffff';
  }

  /* ── 패널 갱신 ── */
  const statRows = [
    ['shots', '슈팅'], ['onTarget', '유효슈팅'], ['xg', '기대득점(xG)'], ['saves', '선방'],
    ['corners', '코너킥'], ['fouls', '파울'], ['yellow', '경고'], ['red', '퇴장'],
  ];
  function renderStats() {
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
    $('m-score').textContent = `${m.score.home} - ${m.score.away}`;
    $('m-clock').textContent = m.clock();
    $('m-half').textContent = m.aet ? (m.t > m.ft90 ? '연장 후반' : '연장') : m.half === 1 ? '전반' : '후반';
    $('m-dir').textContent = `${m.sides.home.team.short} ${m.sides.home.dir > 0 ? '→' : '←'}`;
    $('m-events').textContent = `${m.events.length}개`;
  }

  function renderFeed() {
    $('feed').innerHTML = m.commentary.slice(0, 24).map((c) =>
      `<li class="ev-${c.type} ${c.side ? 'side-' + c.side : ''}"><span class="min">${c.label || c.minute + "'"}</span><span>${esc(c.text)}</span></li>`).join('');
  }

  let lastTickerId = 0;
  function renderTicker() {
    const c = m.commentary[0];
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
      <span class="gf-score">${m.score.home} - ${m.score.away}</span>`;
    flash.dataset.team = t.id;
    flash.hidden = false;
    clearTimeout(flashTimer);
    flashTimer = setTimeout(() => { flash.hidden = true; }, 2600);
  }

  /* ── 드로어(전술·교체) ── */
  function renderDrawer() {
    const el = $('drawer');
    if (!drawer) { el.hidden = true; el.innerHTML = ''; return; }
    el.hidden = false;
    if (drawer === 'tactics') {
      const side = m.sides[m.userSide];
      el.innerHTML = `<div class="drawer-head"><h3>전술 즉시 변경</h3><button class="btn small" data-mact="close">닫기</button></div>
      <div class="form-row">${Object.keys(FORMATIONS).map((f) => `<button type="button" class="btn small ${side.formation === f ? 'on' : ''}" data-mform="${f}">${f}</button>`).join('')}</div>
      <ul class="axes compact">${AXES.map((a) => {
        const v = side.tactic[a.key] || 0;
        return `<li class="axis"><div class="axis-head"><b>${a.name}</b><span class="axis-val">${stepLabel(v)}</span></div>
        <div class="axis-ctl"><span class="axis-end">${a.left}</span><span class="seg">${STEPS.map((s) => `<button type="button" class="${Math.abs(s - v) < 0.01 ? 'on' : ''}" data-mtactic="${a.key}" data-val="${s}" aria-label="${a.name}">${s > 0 ? '▲' : s < 0 ? '▼' : '●'}</button>`).join('')}</span><span class="axis-end">${a.right}</span></div>
        <p class="axis-eff">${a.effect(v)}</p></li>`;
      }).join('')}</ul>`;
      el.querySelectorAll('[data-mtactic]').forEach((b) => b.addEventListener('click', () => {
        m.setTactic({ [b.dataset.mtactic]: Number(b.dataset.val) });
        app.world.myLineup.tactic = { ...m.sides[m.userSide].tactic };
        app.save(); renderDrawer();
      }));
      el.querySelectorAll('[data-mform]').forEach((b) => b.addEventListener('click', () => {
        m.setFormation(b.dataset.mform);
        app.world.myLineup.formation = b.dataset.mform;
        app.save(); renderDrawer(); draw(1);
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
    el.querySelectorAll('[data-mact="close"]').forEach((b) => b.addEventListener('click', () => { drawer = null; renderDrawer(); }));
  }

  /* ── 하프타임(라커룸) ── */
  function renderHalftime() {
    const side = m.sides[m.userSide];
    const s = m.stats();
    $('ht-score').textContent = `${m.score.home} - ${m.score.away}`;
    const my = m.userSide === 'home' ? s.shots.home : s.shots.away;
    const opp = m.userSide === 'home' ? s.shots.away : s.shots.home;
    $('ht-note').textContent = `전반 ${m.clock()} 종료 — 슈팅 ${my} : ${opp}. 라커룸에서 전술·선수를 정비하세요.`;
    const axes = AXES.map((a) => {
      const v = side.tactic[a.key] || 0;
      return `<li class="axis"><div class="axis-head"><b>${a.name}</b><span class="axis-val">${stepLabel(v)}</span></div>
        <div class="axis-ctl"><span class="axis-end">${a.left}</span>
        <span class="seg">${STEPS.map((x) => `<button type="button" class="${Math.abs(x - v) < 0.01 ? 'on' : ''}" data-ht="${a.key}" data-val="${x}">${x > 0 ? '▲' : x < 0 ? '▼' : '●'}</button>`).join('')}</span>
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
      <div><h4>전술 정비</h4><ul class="axes compact">${axes}</ul></div>
      <div><h4>선수 교체 <span class="pill">${5 - side.subsUsed}명 남음</span></h4>
        <p class="hint">나갈 선수를 고른 뒤 들어올 후보를 누르세요.</p>
        <div class="sub-cols ht-subcols">
          <div><h5>나갈 선수</h5><ul class="sub-list">${subs}</ul></div>
          <div><h5>들어올 후보</h5><ul class="sub-list">${bench.map((e) => `<li><button type="button" class="sub-btn" data-htin="${e.id}" ${outPid ? '' : 'disabled'}><span>${esc(e.name)}</span><small>${posLabel(e)} ${e.p.ovr}</small></button></li>`).join('') || '<li class="muted sm">후보가 없습니다.</li>'}</ul></div>
        </div>
      </div>
    </div>`;
    $('ht-body').querySelectorAll('[data-ht]').forEach((b) => b.addEventListener('click', () => {
      m.setTactic({ [b.dataset.ht]: Number(b.dataset.val) });
      app.world.myLineup.tactic = { ...m.sides[m.userSide].tactic };
      app.save(); renderHalftime();
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
      ['경고 / 퇴장', `${s.yellow.home} / ${s.red.home}`, `${s.yellow.away} / ${s.red.away}`],
    ].map(([k, h, a]) => `<div class="ov-row"><b>${h}</b><span>${k}</span><b>${a}</b></div>`).join('');
    $('m-overlay').hidden = false;
    cancelAnimationFrame(raf); raf = 0;
    renderStats(); renderRatings(); renderFeed(); draw(1);
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
    // 세트피스·득점 연출 중에는 자리 배치를 그대로 보여 줍니다
    const a = (m.phase === 'setpiece' || m.phase === 'goal') ? 1 : alpha;
    draw(a);

    if (m.events.length !== lastStats) {
      const fresh = m.events.slice(lastStats);
      lastStats = m.events.length;
      renderStats(); renderFeed(); renderTicker();
      for (const ev of fresh) {
        if (ev.type === 'goal') showFlash(ev);
        if (ev.type === 'injury' && ev.side === m.userSide) app.toast('🚑 부상 — 교체를 검토하세요', 'warn');
        if (ev.type === 'card' && ev.side === m.userSide) app.toast('🟨 경고 — 몸조심', 'warn');
      }
      if (m.events.length - lastRatings > 5) { renderRatings(); lastRatings = m.events.length; }
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
    speed = Number(b.dataset.speed);
    root.querySelectorAll('.spd').forEach((x) => x.classList.toggle('on', x === b));
    $('m-pause').textContent = '일시정지';
    $('m-pause').setAttribute('aria-pressed', 'false');
    paused = false;
    if (m.done) return;
    if (speed === 0) { cancelAnimationFrame(raf); raf = 0; stepToEnd(); return; }
    start();
  }));
  $('m-pause').addEventListener('click', () => {
    paused = !paused;
    $('m-pause').textContent = paused ? '재생' : '일시정지';
    $('m-pause').setAttribute('aria-pressed', String(paused));
    if (!paused && !raf) start();
  });
  root.querySelectorAll('[data-mact]').forEach((b) => b.addEventListener('click', () => {
    const act = b.dataset.mact;
    if (act === 'tactics' || act === 'subs') { drawer = drawer === act ? null : act; renderDrawer(); }
    if (act === 'ff') { cancelAnimationFrame(raf); raf = 0; stepToEnd(); }
  }));
  $('ht-start').addEventListener('click', () => {
    $('halftime').hidden = true;
    m.startSecondHalf();
    halfShown = false;
    lastStats = m.events.length; lastRatings = m.events.length;   // 지난 이벤트를 다시 띄우지 않습니다
    renderStats(); renderFeed(); renderTicker(); renderRatings();
    start();
  });
  $('ov-continue').addEventListener('click', () => {
    cleanup();
    app.endMatch(m, meta);
  });

  const onResize = () => { resize(); draw(m.done ? 1 : alpha); };
  window.addEventListener('resize', onResize);
  document.documentElement.addEventListener('fm-theme', onResize);
  function cleanup() {
    cancelAnimationFrame(raf); raf = 0;
    window.removeEventListener('resize', onResize);
    document.documentElement.removeEventListener('fm-theme', onResize);
    clearTimeout(flashTimer);
  }

  resize();
  draw(0);
  renderStats();
  renderFeed();
  renderTicker();
  renderRatings();
  $('m-label').textContent = meta.label;
  start();
  return cleanup;
}
