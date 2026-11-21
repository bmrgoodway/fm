// 라이브 매치 화면 — Canvas 2D 피치 + 배속/전술/교체/실시간 기록
import { W as PW, H as PH, CY, GOAL_HALF } from './match.js';
import { AXES, STEPS, stepLabel } from './tactics.js';
import { FORMATIONS } from './data.js';
import * as X from './world.js';
import { esc } from './views.js';

const SPEEDS = [{ v: 1, label: '1x' }, { v: 2, label: '2x' }, { v: 4, label: '4x' }, { v: 0, label: '즉시' }];
const BASE_MS = 230;

export function mountMatch(app, m, meta) {
  const root = document.getElementById('app');
  const w = app.world;
  const home = w.teams[m.homeId], away = w.teams[m.awayId];
  const isHome = m.userSide === 'home';
  const myTeam = isHome ? home : away;
  let speed = 1, raf = 0, lastT = performance.now(), acc = 0, lastStats = 0, lastRatings = 0;
  let outPid = null, drawer = null, flashTimer = 0;

  root.innerHTML = `<section class="matchview">
    <div class="scorebar">
      <div class="sb-team" data-team="${home.id}">
        <span class="badge mid" data-team="${home.id}">${esc(home.short.slice(0, 2))}</span>
        <div><b>${esc(home.name)}</b><small>홈</small></div>
      </div>
      <div class="sb-mid">
        <span class="sb-score" id="m-score">0 - 0</span>
        <span class="sb-clock" id="m-clock">0'</span>
        <span class="sb-phase" id="m-phase">${esc(meta.label)}</span>
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
        <div class="card-head"><h3>실시간 기록</h3><span class="pill" id="m-half">전반</span></div>
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
    ? { grass: '#14603a', grass2: '#115232', line: 'rgba(255,255,255,.82)', ink: '#f4f4f8' }
    : { grass: '#2f9e4f', grass2: '#2a8f47', line: 'rgba(255,255,255,.9)', ink: '#101014' });

  function resize() {
    dpr = Math.min(window.devicePixelRatio || 1, 2.5);
    const host = canvas.closest('.matchview') || canvas.parentElement;
    const stageW = Math.max(280, host.clientWidth - 8);
    const ratio = (PW + 4.0) / (PH + 4.0); // 피치 비율 그대로 — 여백 없이 꽉 채운다
    let w = stageW;
    let h = w / ratio;
    const maxH = Math.max(240, Math.round(window.innerHeight * 0.66));
    if (h > maxH) { h = maxH; w = h * ratio; }
    cssW = Math.round(w); cssH = Math.round(h);
    canvas.style.width = cssW + 'px';
    canvas.style.height = cssH + 'px';
    canvas.style.margin = '0 auto';
    canvas.width = Math.round(cssW * dpr);
    canvas.height = Math.round(cssH * dpr);
  }

  function draw() {
    const c = colors();
    const pad = 2.0;
    const scale = Math.min(cssW / (PW + pad * 2), cssH / (PH + pad * 2));
    const ox = (cssW - (PW + pad * 2) * scale) / 2 + pad * scale;
    const oy = (cssH - (PH + pad * 2) * scale) / 2 + pad * scale;
    const X = (x) => ox + x * scale, Y = (y) => oy + y * scale;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, cssW, cssH);

    // 잔디
    ctx.fillStyle = c.grass;
    ctx.fillRect(X(0), Y(0), PW * scale, PH * scale);
    ctx.fillStyle = c.grass2;
    for (let i = 0; i < 10; i += 2) ctx.fillRect(X((PW / 10) * i), Y(0), (PW / 10) * scale, PH * scale);

    // 선
    ctx.strokeStyle = c.line;
    ctx.lineWidth = Math.max(1.2, scale * 0.28);
    ctx.strokeRect(X(0), Y(0), PW * scale, PH * scale);
    ctx.beginPath(); ctx.moveTo(X(PW / 2), Y(0)); ctx.lineTo(X(PW / 2), Y(PH)); ctx.stroke();
    ctx.beginPath(); ctx.arc(X(PW / 2), Y(CY), 9.15 / 105 * PW * scale, 0, Math.PI * 2); ctx.stroke();
    ctx.beginPath(); ctx.arc(X(PW / 2), Y(CY), scale * 0.8, 0, Math.PI * 2); ctx.fillStyle = c.line; ctx.fill();
    // 페널티 박스
    const paD = 16.5 / 105 * PW, paW = 40.32 / 68 * PH;
    ctx.strokeRect(X(0), Y(CY - paW / 2), paD * scale, paW * scale);
    ctx.strokeRect(X(PW - paD), Y(CY - paW / 2), paD * scale, paW * scale);
    const gaD = 5.5 / 105 * PW, gaW = 18.32 / 68 * PH;
    ctx.strokeRect(X(0), Y(CY - gaW / 2), gaD * scale, gaW * scale);
    ctx.strokeRect(X(PW - gaD), Y(CY - gaW / 2), gaD * scale, gaW * scale);
    // 골문
    ctx.strokeStyle = c.ink; ctx.lineWidth = Math.max(2, scale * 0.55);
    ctx.strokeRect(X(-1.6), Y(CY - GOAL_HALF), 1.6 * scale, GOAL_HALF * 2 * scale);
    ctx.strokeRect(X(PW), Y(CY - GOAL_HALF), 1.6 * scale, GOAL_HALF * 2 * scale);

    // 선수
    const r = Math.max(6, scale * 2.05);
    for (const sideName of ['home', 'away']) {
      const side = m.sides[sideName];
      const t = side.team;
      const ink = t.ink || '#101014';
      for (const e of side.players) {
        if (!e.onPitch) continue;
        const px = X(e.x), py = Y(e.y);
        // 그림자
        ctx.fillStyle = 'rgba(0,0,0,.28)';
        ctx.beginPath(); ctx.ellipse(px + r * 0.22, py + r * 0.3, r * 0.95, r * 0.75, 0, 0, Math.PI * 2); ctx.fill();
        // 몸
        ctx.beginPath(); ctx.arc(px, py, r, 0, Math.PI * 2);
        ctx.fillStyle = t.primary; ctx.fill();
        ctx.lineWidth = Math.max(1.6, r * 0.24); ctx.strokeStyle = '#101014'; ctx.stroke();
        // 등번호
        ctx.fillStyle = contrastFor(t);
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
      }
    }
    // 공
    const b = m.ball;
    const bx = X(b.x), by = Y(b.y), br = Math.max(3.4, scale * 0.95);
    if (b.mode === 'pass' || b.mode === 'shot') {
      ctx.beginPath(); ctx.moveTo(X(b.from.x), Y(b.from.y)); ctx.lineTo(bx, by);
      ctx.strokeStyle = 'rgba(255,255,255,.45)'; ctx.lineWidth = 1.6; ctx.setLineDash([4, 4]); ctx.stroke(); ctx.setLineDash([]);
    }
    ctx.beginPath(); ctx.arc(bx + 1.2, by + 1.6, br, 0, Math.PI * 2); ctx.fillStyle = 'rgba(0,0,0,.3)'; ctx.fill();
    ctx.beginPath(); ctx.arc(bx, by, br, 0, Math.PI * 2); ctx.fillStyle = '#ffffff'; ctx.fill();
    ctx.lineWidth = Math.max(1.4, br * 0.35); ctx.strokeStyle = '#101014'; ctx.stroke();
    ctx.fillStyle = '#101014';
    ctx.beginPath(); ctx.arc(bx, by, br * 0.34, 0, Math.PI * 2); ctx.fill();

    // 구단 약칭 (코너)
    ctx.font = '900 11px "Pretendard Variable", Pretendard, sans-serif';
    ctx.fillStyle = c.ink; ctx.globalAlpha = 0.75;
    ctx.textAlign = 'left'; ctx.fillText(m.sides.home.team.short, 8, 16);
    ctx.textAlign = 'right'; ctx.fillText(m.sides.away.team.short, cssW - 8, 16);
    ctx.globalAlpha = 1;
  }

  function contrastFor(t) {
    // 배경색 밝기로 글자색 결정
    const hex = (t.primary || '#ffffff').replace('#', '');
    const r = parseInt(hex.slice(0, 2), 16), g = parseInt(hex.slice(2, 4), 16), b = parseInt(hex.slice(4, 6), 16);
    const lum = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
    return lum > 0.62 ? '#101014' : (t.secondary && t.secondary !== '#ffffff' ? t.secondary : '#ffffff');
  }

  /* ── 패널 갱신 ── */
  const statRows = [
    ['shots', '슈팅'], ['onTarget', '유효슈팅'], ['xg', '기대득점(xG)'], ['passes', '패스 성공'], ['tackles', '태클'], ['saves', '선방'],
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
    $('m-clock').textContent = m.aet ? `${Math.min(120, Math.floor(m.t / 4))}'` : `${Math.min(90, Math.floor(m.t / 4))}'`;
    $('m-half').textContent = m.aet ? '연장' : m.t < 180 ? '전반' : '후반';
    $('m-events').textContent = `${m.events.length}개`;
  }

  function renderFeed() {
    const feed = $('feed');
    feed.innerHTML = m.commentary.slice(0, 24).map((c) => `<li class="ev-${c.type} ${c.side ? 'side-' + c.side : ''}"><span class="min">${c.minute}'</span><span>${esc(c.text)}</span></li>`).join('');
  }

  function renderRatings() {
    const opp = m.userSide === 'home' ? 'away' : 'home';
    const row = (e, rating) => `<li class="${e.onPitch ? '' : 'off'}"><span class="rn">${e.num}</span><span class="rname">${esc(e.name)}</span><span class="pos">${e.pos}</span><b class="${rating >= 7.5 ? 'hi' : rating < 6 ? 'lo' : ''}">${rating.toFixed(1)}</b>${e.st.goals ? `<i class="g">${'⚽'.repeat(Math.min(e.st.goals, 3))}</i>` : ''}</li>`;
    $('ratings-my').innerHTML = m.ratings(m.userSide).map((x) => row(x.e, x.rating)).join('');
    $('ratings-opp').innerHTML = m.ratings(opp).map((x) => row(x.e, x.rating)).join('');
  }

  function showFlash(ev) {
    const t = w.teams[ev.side === 'home' ? m.homeId : m.awayId];
    flash.innerHTML = `<span class="gf-badge" data-team="${t.id}">${esc(t.short)}</span><b>GOAL!</b><span class="gf-name">${esc(ev.text.replace('⚽ ', '').split('—')[0])}</span>`;
    flash.dataset.team = t.id;
    flash.hidden = false;
    clearTimeout(flashTimer);
    flashTimer = setTimeout(() => { flash.hidden = true; }, 2200);
  }

  /* ── 드로어 ── */
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
        app.save();
        renderDrawer();
      }));
      el.querySelectorAll('[data-mform]').forEach((b) => b.addEventListener('click', () => {
        m.setFormation(b.dataset.mform);
        app.world.myLineup.formation = b.dataset.mform;
        app.save();
        renderDrawer();
        draw();
      }));
    }
    if (drawer === 'subs') {
      const side = m.sides[m.userSide];
      const left = 5 - side.subsUsed;
      el.innerHTML = `<div class="drawer-head"><h3>선수 교체 <span class="pill">${left}명 남음</span></h3><button class="btn small" data-mact="close">닫기</button></div>
        <p class="hint">나갈 선수를 먼저 누르고, 들어올 후보를 누르세요.</p>
        <div class="sub-cols">
          <div><h4>나갈 선수</h4><ul class="sub-list">${side.players.filter((e) => e.onPitch).map((e) => `<li><button type="button" class="sub-btn ${outPid === e.id ? 'sel' : ''}" data-out="${e.id}"><span class="rn">${e.num}</span><span>${esc(e.name)}</span><small>${e.pos} · 체력 ${Math.round(e.stamina)}%</small></button></li>`).join('')}</ul></div>
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

  /* ── 결과 ── */
  function showResult() {
    const s = m.stats();
    const isMyWin = (m.result?.winner || (m.score.home > m.score.away ? 'home' : m.score.home < m.score.away ? 'away' : null)) === m.userSide;
    const isDraw = !m.pens && m.score.home === m.score.away;
    $('ov-eyebrow').textContent = meta.cup ? (m.aet ? 'EXTRA TIME · FULL TIME' : 'CUP · FULL TIME') : 'FULL TIME';
    $('ov-title').textContent = `${m.score.home} - ${m.score.away}${m.pens ? ` (PK ${m.pens.text})` : ''}`;
    $('ov-sub').textContent = isDraw ? '무승부 — 승점 1점씩 나눠 가집니다.' : isMyWin ? '승리! 순위표에 승점 3점이 더해집니다.' : '패배 — 다음 경기에서 만회합시다.';
    $('ov-stats').innerHTML = `<div class="ov-row"><b>${s.possession.home}%</b><span>점유율</span><b>${s.possession.away}%</b></div>
      <div class="ov-row"><b>${s.shots.home}</b><span>슈팅</span><b>${s.shots.away}</b></div>
      <div class="ov-row"><b>${s.xg.home.toFixed(2)}</b><span>xG</span><b>${s.xg.away.toFixed(2)}</b></div>
      <div class="ov-row"><b>${s.onTarget.home}</b><span>유효슈팅</span><b>${s.onTarget.away}</b></div>`;
    $('m-overlay').hidden = false;
    cancelAnimationFrame(raf);
    raf = 0;
    renderStats(); renderRatings(); renderFeed();
    draw();
  }

  /* ── 루프 ── */
  function step(n) {
    for (let i = 0; i < n && !m.done; i++) m.tick();
    if (m.done) { showResult(); return true; }
    return false;
  }

  function frame(now) {
    if (!raf) return;
    const dt = Math.min(now - lastT, 400);
    lastT = now;
    if (speed === 0) { step(1000); return; }
    acc += dt;
    const interval = BASE_MS / speed;
    let guard = 0;
    while (acc >= interval && !m.done && guard < 8) { acc -= interval; m.tick(); guard++; }
    if (m.done) { showResult(); return; }
    draw();
    if (m.events.length !== lastStats) {
      const fresh = m.events.slice(lastStats);
      lastStats = m.events.length;
      renderStats();
      renderFeed();
      for (const ev of fresh) if (ev.type === 'goal') showFlash(ev);
      if (m.events.length - lastRatings > 6) { renderRatings(); lastRatings = m.events.length; }
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
    if (m.done) return;
    if (speed === 0) { step(1000); return; }
    start();
  }));
  $('m-pause').addEventListener('click', () => {
    const paused = $('m-pause').getAttribute('aria-pressed') === 'true';
    if (paused) { $('m-pause').textContent = '일시정지'; $('m-pause').setAttribute('aria-pressed', 'false'); start(); }
    else { cancelAnimationFrame(raf); raf = 0; $('m-pause').textContent = '재생'; $('m-pause').setAttribute('aria-pressed', 'true'); }
  });
  root.querySelectorAll('[data-mact]').forEach((b) => b.addEventListener('click', () => {
    const act = b.dataset.mact;
    if (act === 'tactics' || act === 'subs') { drawer = drawer === act ? null : act; renderDrawer(); }
    if (act === 'ff') { cancelAnimationFrame(raf); raf = 0; step(1000); }
  }));
  $('ov-continue').addEventListener('click', () => {
    cleanup();
    app.endMatch(m, meta);
  });

  const onResize = () => { resize(); draw(); };
  window.addEventListener('resize', onResize);
  document.documentElement.addEventListener('fm-theme', onResize);
  function cleanup() {
    cancelAnimationFrame(raf); raf = 0;
    window.removeEventListener('resize', onResize);
    document.documentElement.removeEventListener('fm-theme', onResize);
    clearTimeout(flashTimer);
  }

  resize();
  draw();
  renderStats();
  renderFeed();
  renderRatings();
  start();
  return cleanup;
}
