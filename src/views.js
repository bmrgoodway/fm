// 화면 렌더 — 문자열 HTML + data-act 버튼. 상태는 app 객체에서 읽습니다.
import { FORMATIONS } from './data.js';
import * as W from './world.js';
import { AXES, STEPS, stepLabel, tacticWords, MENTALITY, mentalityOf, mentalityEffect, roleLabel, roleShort, roleEffect, rolesForLabel, defaultRole, nextRole, ROLE_TUNING } from './tactics.js';
import { scoutReport } from './scout.js';

export const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

/* 팀 색·게이지·피치 좌표를 CSS 변수로 주입 (인라인 style 속성 없이) */
export function applyTeamColors(root, world) {
  root.querySelectorAll('[data-team]').forEach((el) => {
    const t = world?.teams?.[el.getAttribute('data-team')];
    if (!t) return;
    el.style.setProperty('--c1', t.primary);
    el.style.setProperty('--c2', t.secondary);
    el.style.setProperty('--cink', t.ink || '#101014');
  });
  root.querySelectorAll('[data-w]').forEach((el) => el.style.setProperty('--w', el.getAttribute('data-w') + '%'));
  root.querySelectorAll('[data-px]').forEach((el) => {
    el.style.setProperty('--left', Number(el.dataset.py) * 100 + '%');
    el.style.setProperty('--top', (1 - Number(el.dataset.px)) * 100 + '%');
  });
}
export const badge = (t, cls = '') => `<span class="badge ${cls}" data-team="${t.id}" aria-hidden="true">${esc(t.short.slice(0, 2))}</span>`;
const formChips = (rec) => (rec && rec.length ? `<span class="form">${rec.map((r) => `<i class="f-${r}" title="${{ W: '승', D: '무', L: '패' }[r]}">${r === 'W' ? '승' : r === 'D' ? '무' : '패'}</i>`).join('')}</span>` : '<span class="muted sm">경기 없음</span>');
const won = (v) => `${W.fmt(v)}억`;

/* 작은 포메이션 미리보기 (SVG) */
function miniPitch(formation, team, flip) {
  const slots = FORMATIONS[formation]?.slots || [];
  const dots = slots.map((s) => {
    const x = (flip ? 1 - s.x : s.x) * 100;
    const y = s.y * 64;
    const big = s.pos === 'GK';
    return `<circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="${big ? 3.4 : 3}" fill="${team.primary}" stroke="#101014" stroke-width="1.2"/>`;
  }).join('');
  return `<svg class="mini-pitch" viewBox="0 0 100 64" role="img" aria-label="${esc(team.short)} ${esc(formation)} 예상 배치">
    <rect x="1" y="1" width="98" height="62" fill="#2f9e4f" stroke="#101014" stroke-width="1.5"/>
    <path d="M50 1v62" stroke="#ffffff" stroke-width="1" opacity=".7"/>
    <circle cx="50" cy="32" r="8" fill="none" stroke="#ffffff" stroke-width="1" opacity=".7"/>
    <rect x="1" y="19" width="12" height="26" fill="none" stroke="#ffffff" stroke-width="1" opacity=".7"/>
    <rect x="87" y="19" width="12" height="26" fill="none" stroke="#ffffff" stroke-width="1" opacity=".7"/>
    ${dots}
  </svg>`;
}

const rankLabel = (n) => `${n}위`;

function teamLine(w, id) {
  const t = w.teams[id];
  return `<span class="tl">${badge(t)}<b>${esc(t.short)}</b></span>`;
}

/* ─────────────────────────── 구단 선택 ─────────────────────────── */
export function renderSelect(app) {
  const hasSave = !!app.savedGame;
  const cards = Object.values(app.defs).map((t) => {
    const w = { ...t };
    return `<button class="team-card" data-act="team" data-team="${t.id}" type="button">
      <span class="tc-top">${badge(t)}<span class="tc-name"><b>${esc(t.name)}</b><small>${esc(t.nick)}</small></span></span>
      <span class="tc-meta">
        <span><b>${t.power}</b> 기본 전력</span><span><b>${won(t.budget)}</b> 자금</span>
        <span><b>${esc(t.formation)}</b> 포메이션</span>
      </span>
      <span class="tc-words">${esc(tacticWords(t.tactic))}</span>
      <span class="tc-bio">${esc(t.bio)}</span>
      <span class="tc-go">감독 취임 →</span>
    </button>`;
  }).join('');

  return `
  ${hasSave ? `<div class="resume">
    <div><b>저장된 커리어가 있습니다</b><span class="sm">${esc(app.savedGame.teams[app.savedGame.myTeamId].name)} · ${app.savedGame.season}시즌</span></div>
    <button class="btn primary" data-act="continue" type="button">커리어 이어하기</button>
  </div>` : ''}
  <section class="hero">
    <div class="hero-copy">
      <span class="eyebrow">GOODWAY APPS · FOOTBALL MANAGER</span>
      <h1>미니 <span class="hl">풋볼 매니저</span></h1>
      <p class="hero-desc">2D 바둑알 매치 엔진 · 10팀 리그 + 컵대회 · 전술 4축 · 이적 시장</p>
      <ul class="feat">
        <li>90분을 360틱으로 실시간 시뮬레이션</li>
        <li>감독 개입 — 배속·전술 변경·선수 교체</li>
        <li>로그인 없이 이 브라우저에 세이브</li>
      </ul>
    </div>
    <div class="hero-art" aria-hidden="true">
      <svg viewBox="0 0 240 200" role="img" aria-label="바둑알 축구장 그림">
        <rect x="8" y="8" width="224" height="184" fill="#2f9e4f" stroke="#101014" stroke-width="4"/>
        <path d="M8 100h224M120 8v184" stroke="#ffffff" stroke-width="3" opacity=".85"/>
        <circle cx="120" cy="100" r="30" fill="none" stroke="#ffffff" stroke-width="3" opacity=".85"/>
        <rect x="8" y="58" width="34" height="84" fill="none" stroke="#ffffff" stroke-width="3"/>
        <rect x="198" y="58" width="34" height="84" fill="none" stroke="#ffffff" stroke-width="3"/>
        <g stroke="#101014" stroke-width="3.4">
          <circle cx="72" cy="78" r="12" fill="#0abbee"/><circle cx="98" cy="128" r="12" fill="#0abbee"/>
          <circle cx="150" cy="66" r="12" fill="#ff614a"/><circle cx="176" cy="116" r="12" fill="#ff614a"/>
          <circle cx="120" cy="100" r="6.5" fill="#ffffff"/>
        </g>
      </svg>
    </div>
  </section>
  <div class="sec-head"><h2>구단을 선택하세요</h2><p class="hint">팀마다 예산·전력·주력 전술이 다릅니다. 언제든 새 게임으로 다시 시작할 수 있습니다.</p></div>
  <div class="team-grid">${cards}</div>`;
}

/* ─────────────────────────── 허브 ─────────────────────────── */
const TABS = [
  { id: 'schedule', label: '📅 일정/다음 경기' },
  { id: 'squad', label: '📋 전술/선수단' },
  { id: 'market', label: '🔄 이적 시장' },
  { id: 'records', label: '🏆 순위/기록' },
];

export function renderHub(app) {
  const w = app.world, me = W.myTeam(w);
  const table = W.standings(w);
  const myRow = table.find((r) => r.id === w.myTeamId);
  const lr = W.leagueRoundOf(w);
  const body = { schedule: scheduleTab, squad: squadTab, market: marketTab, records: recordsTab }[app.state.tab] || scheduleTab;
  return `
  <section class="clubbar">
    <div class="club-id">${badge(me, 'big')}
      <div><h2>${esc(me.name)}</h2><p class="sm">${esc(me.nick)} · ${esc(me.stadium)}</p></div>
    </div>
    <div class="club-stats">
      <div><small>시즌</small><b>${w.season}</b></div>
      <div><small>리그 순위</small><b>${myRow && myRow.play > 0 ? rankLabel(myRow.rank) : '—'}</b></div>
      <div><small>이적 자금</small><b>${won(me.budget)}</b></div>
      <div><small>주급</small><b>${W.fmt(W.teamWageTotal(w, w.myTeamId))}<span class="unit">만/주</span></b></div>
      <div><small>스쿼드 전력</small><b>${W.teamPower(w, w.myTeamId)}</b></div>
      <div><small>리그 라운드</small><b>${lr > 18 ? '종료' : lr + 'R'}</b></div>
    </div>
    <button class="btn small ghost" data-act="new-game" type="button">새 게임</button>
  </section>
  <nav class="tabs" aria-label="앱 탭">${TABS.map((t) => `<button type="button" class="tab ${app.state.tab === t.id ? 'on' : ''}" data-act="tab" data-tab="${t.id}" aria-current="${app.state.tab === t.id}">${t.label}</button>`).join('')}</nav>
  <section class="tab-body">${body(app, w)}</section>`;
}

/* ── 상대 스카우팅 ───────────────────────────────────────────────
   scout.js 가 뽑은 실제 라인업·전술·선수 데이터를 그대로 그립니다.
   다음 경기 카드에는 요약, 일정 탭 아래에는 상세 보고서를 둡니다. */
function scoutPitch(rep, team, big = false) {
  const dots = rep.lineupDetail.map((x) => {
    const pos = boardPos(x.slot, x.role, rep.tactic);
    // 깊게 내려서는 팀은 수비수가 골키퍼와 겹쳐 보이므로, 골키퍼와 최소 간격만 띄웁니다.
    const gx = x.p.pos === 'GK' ? pos.x : Math.max(pos.x, 0.15);
    const cx = (gx * 100).toFixed(1), cy = (pos.y * 64).toFixed(1);
    const r = x.p.pos === 'GK' ? 3.6 : 3.2;
    const labelY = Number(cy) > 51 ? Number(cy) - 4.4 : Number(cy) + 6.1;
    return `<g><circle cx="${cx}" cy="${cy}" r="${r}" fill="${esc(team.primary)}" stroke="#101014" stroke-width="1.1"/>
      <text x="${cx}" y="${Number(cy) + 1.1}" text-anchor="middle" font-size="2.9" font-weight="900" fill="#101014">${x.p.num}</text>
      ${big ? `<text x="${cx}" y="${labelY}" text-anchor="middle" font-size="2.9" font-weight="900" fill="#ffffff" stroke="#101014" stroke-width=".7" paint-order="stroke">${esc(x.slot.label)}</text>` : ''}</g>`;
  }).join('');
  return `<svg class="scout-pitch ${big ? 'big' : 'sm'}" viewBox="0 0 100 64" role="img" aria-label="${esc(team.short)} ${esc(rep.formation)} 예상 배치">
    <rect x="1" y="1" width="98" height="62" fill="#2f9e4f" stroke="#101014" stroke-width="1.5"/>
    <path d="M50 1v62" stroke="#ffffff" stroke-width="1" opacity=".7"/>
    <circle cx="50" cy="32" r="8" fill="none" stroke="#ffffff" stroke-width="1" opacity=".7"/>
    <rect x="1" y="19" width="12" height="26" fill="none" stroke="#ffffff" stroke-width="1" opacity=".7"/>
    <rect x="87" y="19" width="12" height="26" fill="none" stroke="#ffffff" stroke-width="1" opacity=".7"/>
    ${dots}
  </svg>`;
}

const axisChips = (rep) => `<div class="axis-chips">${rep.axes.map((a) => `<span class="axis-chip ${a.value > 0.2 ? 'hi' : a.value < -0.2 ? 'lo' : ''}" title="${esc(a.note)}"><i>${esc(a.name)}</i><b>${esc(a.word)}</b></span>`).join('')}</div>`;

function scoutMini(rep, label) {
  const keys = rep.keyPlayers.map((k) => `<span class="sk"><b>${esc(k.name)}</b><small>${esc(k.slot)} · ${esc(k.roleShort || k.roleLabel)} · ${k.ovr}</small></span>`).join('<span class="vs-sep">·</span>');
  return `<div class="scout-mini">
    <div class="sm-head"><b>🔍 상대 스카우팅</b><span class="pill xs">${esc(rep.mentality.name)}</span></div>
    <dl class="sm-facts">
      <div><dt>예상 포메이션</dt><dd><b>${esc(rep.formation)}</b> · ${esc(rep.shape)}</dd></div>
      <div><dt>주 전술 스타일</dt><dd>${esc(rep.words)}</dd></div>
      <div><dt>핵심 경계</dt><dd class="sk-row">${keys}</dd></div>
    </dl>
    ${axisChips(rep)}
    <ul class="sm-hints">${rep.hints.slice(0, 2).map((h) => `<li><b>${esc(h.tag)}</b><span>${esc(h.text)}</span></li>`).join('')}</ul>
    <a class="btn small ghost sm-more" href="#scout-report">스카우팅 상세 보고서 ↓</a>
  </div>`;
}

function scoutCard(w) {
  const nx = W.userNextMatch(w);
  if (!nx) return '';
  const { round, fixture } = nx;
  const oppId = fixture.home === w.myTeamId ? fixture.away : fixture.home;
  const opp = w.teams[oppId];
  const rep = scoutReport(w, oppId);
  if (!rep) return '';
  const label = round.type === 'cup' ? (W.CUP_LABEL[round.stage] || '컵') : `리그 ${round.leagueRound}R`;
  const form = rep.form.length
    ? `<span class="form">${rep.form.map((r) => `<i class="f-${r}" title="${{ W: '승', D: '무', L: '패' }[r]}">${r === 'W' ? '승' : r === 'D' ? '무' : '패'}</i>`).join('')}</span>`
    : '<span class="muted sm">경기 없음</span>';
  return `<article class="card scout" id="scout-report">
    <div class="card-head"><h3>🔍 상대 스카우팅 · ${esc(opp.name)}</h3><span class="pill">${label} · ${esc(rep.mentality.name)}</span></div>
    <div class="scout-grid">
      <div class="scout-left">
        ${scoutPitch(rep, opp, true)}
        <p class="hint">${esc(rep.formation)} · ${esc(rep.shape)} — 역할(윙백·인사이드 포워드·홀딩…)까지 반영한 실제 예상 배치입니다.</p>
        <ul class="xi-list">${rep.xi.map((x) => `<li><span class="xnum">${x.num}</span><span class="xname">${esc(x.name)}</span><small>${esc(x.slot)} · ${esc(x.roleShort)}</small></li>`).join('')}</ul>
      </div>
      <div class="scout-right">
        <div class="sa-head"><b>주 전술 스타일</b><span class="pill xs">${esc(rep.words)}</span></div>
        <ul class="scout-axes">${rep.axes.map((a) => `<li class="${a.value > 0.2 ? 'hi' : a.value < -0.2 ? 'lo' : ''}"><span>${esc(a.name)}</span><b>${esc(a.word)}</b><small>${esc(a.note)}</small></li>`).join('')}</ul>
        <h4 class="sub">핵심 경계 선수</h4>
        <ul class="key-list">${rep.keyPlayers.map((k) => `<li class="key-card">
          <div class="kc-top"><span class="kc-num">${k.num}</span><div><b>${esc(k.name)}</b><small>${esc(k.slot)} · ${esc(k.roleLabel)} · 종합 ${k.ovr}</small></div></div>
          <div class="kc-stats">${k.stats.map((s) => `<span>${esc(s.label)} <b>${s.value}</b></span>`).join('')}</div>
          <p class="kc-mark">${esc(k.mark)}</p>
        </li>`).join('')}</ul>
        <p class="hint">상대 전력 <b>${rep.power}</b> · 리그 <b>${rep.rank ?? '—'}위</b> · 최근 ${form}</p>
      </div>
    </div>
    <h4 class="sub">맞춤 공략 힌트</h4>
    <ul class="hint-list">${rep.hints.map((h) => `<li><b>${esc(h.tag)}</b><span>${esc(h.text)}</span></li>`).join('')}</ul>
  </article>`;
}

/* ── 일정 탭 ── */
function nextMatchCard(app, w) {
  const nx = W.userNextMatch(w);
  if (!nx) {
    return `<article class="card next none"><h3>다음 경기</h3><p>이번 시즌 모든 경기를 마쳤습니다.</p>
      <button class="btn primary" data-act="season-end" type="button">시즌 결산 보기</button></article>`;
  }
  const { round, fixture } = nx;
  const isHome = fixture.home === w.myTeamId;
  const oppId = isHome ? fixture.away : fixture.home;
  const opp = w.teams[oppId], me = W.myTeam(w);
  const myP = W.teamPower(w, w.myTeamId), oppP = W.teamPower(w, oppId);
  const label = round.type === 'cup' ? (W.CUP_LABEL[round.stage] || '컵') : `리그 ${round.leagueRound}R`;
  const oppForm = w.form?.[oppId] || [];
  const myForm = me.recent || [];
  // 상대 스카우팅 — 상대의 실제 라인업·전술 데이터를 그대로 읽습니다.
  const rep = scoutReport(w, oppId);
  // 내 팀의 '예상'은 감독이 실제로 저장한 라인업·전술이어야 합니다 (팀 기본값이 아니라)
  const mySetup = W.mySetup(w);
  const myTactic = mySetup.tactic;
  const myFormation = mySetup.formation;
  const inj = W.myLineup?.starters?.map((id) => (id ? w.players[id] : null)).filter((p) => p && (p.inj > 0 || p.bans > 0)) || [];
  const unavailable = W.squadOf(w, w.myTeamId).filter((p) => p.bans > 0 || p.inj > 0);
  const bar = (a, b) => `<span class="cmp-bar"><i class="me" data-w="${Math.round((a / (a + b)) * 100)}"></i></span>`;
  return `<article class="card next">
    <div class="card-head"><h3>다음 경기</h3><span class="pill">${label} · ${isHome ? '홈' : '원정'}</span></div>
    <div class="vs">
      <div class="vs-side">${badge(me, 'mid')}<b>${esc(me.short)}</b><small>${myP}</small></div>
      <div class="vs-mid"><span class="vs-word">VS</span><small>${esc(me.stadium)}</small></div>
      <div class="vs-side">${badge(opp, 'mid')}<b>${esc(opp.short)}</b><small>${oppP}</small></div>
    </div>
    <dl class="cmp">
      <div><dt>전력</dt><dd>${bar(myP, oppP)}<span>${myP} : ${oppP}</span></dd></div>
      <div><dt>최근 5경기</dt><dd>${formChips(myForm.slice(-5))}<span class="vs-sep">vs</span>${formChips(opp.recent?.slice(-5) || [])}</dd></div>
      <div><dt>예상 포메이션</dt><dd class="mini-row">${miniPitch(myFormation, me, false)}<span class="vs-sep">vs</span>${miniPitch(rep ? rep.formation : opp.formation, opp, true)}</dd></div>
      <div><dt>주 전술</dt><dd class="tac"><span>${esc(tacticWords(myTactic))}</span><span class="vs-sep">vs</span><span>${esc(rep ? rep.words : tacticWords(opp.tactic))}</span></dd></div>
      ${unavailable.length ? `<div><dt>결장</dt><dd class="tac"><span class="pill xs">${unavailable.length}명</span><span class="sm">${unavailable.map((p) => `${esc(p.name)}(${W.ifUnavailable(p)})`).join(', ')}</span></dd></div>` : ''}
    </dl>
    ${inj.length ? `<p class="warn-bar">🚑 선발에 뛸 수 없는 선수가 ${inj.length}명 있습니다 (${inj.map((p) => esc(p.name)).join(', ')}). 경기를 시작하면 자동으로 교체됩니다.</p>` : ''}
    ${rep ? scoutMini(rep, label) : ''}
    <div class="actions">
      <button class="btn primary" data-act="play" type="button">경기 시작 ▶</button>
      <button class="btn" data-act="instant" type="button">즉시 결과 ⏩</button>
      <button class="btn ghost" data-act="tab" data-tab="squad" type="button">전술 손보기</button>
    </div>
  </article>`;
}

function roundFixtures(app, w) {
  const nx = W.userNextMatch(w);
  if (!nx) return '<p class="muted">이번 시즌 일정이 끝났습니다.</p>';
  const round = nx.round;
  const fx = round.type === 'league' ? round.fixtures : (w.cup.stages[round.stage]?.matches || []);
  const rows = fx.map((f) => {
    const played = f.played;
    const mine = f.home === w.myTeamId || f.away === w.myTeamId;
    return `<li class="${mine ? 'mine' : ''}">
      ${teamLine(w, f.home)}
      <span class="score">${played ? `${f.hg} : ${f.ag}` : 'vs'}</span>
      ${teamLine(w, f.away)}
      ${played ? '' : '<span class="muted xs">예정</span>'}
    </li>`;
  }).join('');
  return `<ul class="fixtures">${rows}</ul>`;
}

function recentList(app, w) {
  const mine = W.myFixtures(w).filter((x) => x.fixture.played).slice(-6).reverse();
  if (!mine.length) return '<p class="muted sm">아직 치른 경기가 없습니다.</p>';
  return `<ul class="results">${mine.map((x) => {
    const f = x.fixture;
    const isHome = f.home === w.myTeamId;
    const oppId = isHome ? f.away : f.home;
    const g = isHome ? f.hg : f.ag, o = isHome ? f.ag : f.hg;
    const res = g > o ? 'W' : g < o ? 'L' : 'D';
    return `<li><i class="f-${res}">${res === 'W' ? '승' : res === 'L' ? '패' : '무'}</i>${teamLine(w, oppId)}<span class="score">${g} : ${o}</span><span class="muted xs">${x.round.type === 'cup' ? W.CUP_LABEL[x.round.stage] : '리그 ' + x.round.leagueRound + 'R'}</span></li>`;
  }).join('')}</ul>`;
}

function scheduleTab(app, w) {
  return `<div class="grid2">
    ${nextMatchCard(app, w)}
    <article class="card">
      <div class="card-head"><h3>${(() => { const nx = W.userNextMatch(w); if (!nx) return '이번 라운드'; return nx.round.type === 'cup' ? W.CUP_LABEL[nx.round.stage] : `리그 ${nx.round.leagueRound}라운드`; })()}</h3><span class="pill">다른 경기</span></div>
      ${roundFixtures(app, w)}
      <h4 class="sub">최근 경기</h4>
      ${recentList(app, w)}
    </article>
  </div>
  ${scoutCard(w)}
  <article class="card">
    <div class="card-head"><h3>시즌 일정</h3><span class="pill">${w.season}시즌</span></div>
    <div class="table-wrap"><table class="tbl sched">
      <thead><tr><th>#</th><th>종류</th><th>상대</th><th>홈/원정</th><th>결과</th></tr></thead>
      <tbody>${W.myFixtures(w).map((x) => {
        const f = x.fixture;
        const isHome = f.home === w.myTeamId;
        const oppId = isHome ? f.away : f.home;
        const r = W.resultOf(w, x.round, w.myTeamId);
        return `<tr><td>${x.round.no}</td><td>${x.round.type === 'cup' ? W.CUP_LABEL[x.round.stage] : '리그'}</td><td>${teamLine(w, oppId)}</td><td>${isHome ? '홈' : '원정'}</td><td>${r ? `<b class="res-${r.res}">${r.mine} : ${r.opp}</b>` : '<span class="muted">예정</span>'}</td></tr>`;
      }).join('')}</tbody>
    </table></div>
  </article>`;
}

/* ── 전술/선수단 탭 ── */
/* ── 전술 보드 좌표 ─────────────────────────────────────────────
   슬롯 좌표만 그리면 역할(윙백·IF·홀딩…)과 팀 성향(잠그기~총공세)을 바꿔도
   그림이 1px도 움직이지 않습니다. 경기 엔진이 쓰는 것과 같은 값을 그대로 옮겨
   '내가 바꾼 것'이 보드에서 눈에 보이게 만듭니다. */
export function boardPos(slot, role, tactic) {
  const t = tactic || {};
  const ment = Number(t.mentality) || 0;
  const line = Number(t.line) || 0;
  const route = Number(t.route) || 0;
  if (slot.pos === 'GK') return { x: slot.x, y: slot.y };
  const tune = ROLE_TUNING[role] || {};
  const lineW = slot.pos === 'DF' ? 1 : slot.pos === 'MF' ? 0.9 : 0.6;
  const mentW = slot.pos === 'DF' ? 0.065 : slot.pos === 'MF' ? 0.095 : 0.055;
  let x = slot.x + (tune.depth || 0) / 100 + ment * mentW + line * 0.075 * lineW;
  // 성향 — 잠그기는 간격을 좁히고(두 줄 블록), 총공세는 벌립니다
  const spread = 1 + (ment < 0 ? ment * 0.16 : ment * 0.08);
  let y = 0.5 + (slot.y - 0.5) * (tune.width || 1) * spread;
  // 측면 루트는 폭을 조금 더 벌립니다
  if (Math.abs(slot.y - 0.5) > 0.3) y = 0.5 + (y - 0.5) * (1 + Math.max(0, route) * 0.07);
  return { x: Math.max(0.06, Math.min(0.95, x)), y: Math.max(0.06, Math.min(0.94, y)) };
}

function chipFor(slot, entry, idx, selected, myId, tactic) {
  const role = (entry && entry.role) || defaultRole(slot.label);
  const pos = boardPos(slot, role, tactic);
  const at = `data-px="${pos.x.toFixed(4)}" data-py="${pos.y.toFixed(4)}"`;
  if (!entry || !entry.p) {
    return `<div class="chip empty ${selected ? 'sel' : ''}" ${at}>
      <button class="chip-main" data-act="slot" data-slot="${idx}" type="button" aria-label="${esc(slot.label)} 자리 · 비어 있음">
        <span class="chip-num">+</span><span class="chip-name">비어 있음</span>
      </button>
      <span class="chip-pos">${esc(slot.label)}</span>
    </div>`;
  }
  const p = entry.p;
  const bad = entry.factor < 0.99;
  const gk = slot.pos === 'GK';
  const off = p.inj > 0 || p.bans > 0;
  return `<div class="chip ${selected ? 'sel' : ''} ${bad ? 'bad-pos' : ''} ${gk ? 'gk' : ''}" ${at} data-team="${myId}">
    <button class="chip-main" data-act="slot" data-slot="${idx}" type="button" aria-label="${esc(p.name)} ${esc(slot.label)} 선택${off ? ' · 출전 불가' : ''}">
      <span class="chip-num">${p.num}</span>
      <span class="chip-name">${esc(p.name)}</span>
    </button>
    ${gk
      ? ''
      : `<button class="chip-pos" data-act="role-cycle" data-slot="${idx}" type="button" title="눌러서 역할 바꾸기 — ${esc(roleEffect(role))}" aria-label="${esc(slot.label)} 역할 ${esc(roleLabel(role))} · 눌러서 바꾸기">${esc(slot.label)} · ${esc(roleShort(role))}${bad ? ` <em>↯ ${Math.round(entry.factor * 100)}%</em>` : ''}${off ? ' 🚑' : ''}</button>`}
  </div>`;
}

/* 선택한 포지션의 역할 2~3종 + 1줄 효과 */
function roleBar(info, selSlot, slots) {
  let idx = selSlot != null && slots[selSlot] && slots[selSlot].pos !== 'GK' ? selSlot : -1;
  if (idx < 0) idx = slots.findIndex((s) => s.pos !== 'GK');
  if (idx < 0) return '';
  const slot = slots[idx];
  const cur = info.roles[idx];
  const opts = rolesForLabel(slot.label);
  return `<div class="role-bar">
    <div class="rb-head">
      <b>${esc(slot.label)} 역할</b>
      <span class="rb-now">${esc(roleLabel(cur))}</span>
    </div>
    <div class="rb-opts" role="group" aria-label="${esc(slot.label)} 선수 역할">
      ${opts.map((k) => `<button type="button" class="role-btn ${k === cur ? 'on' : ''}" data-act="role" data-slot="${idx}" data-role="${k}" aria-pressed="${k === cur}">${esc(roleLabel(k))}</button>`).join('')}
    </div>
    <p class="rb-eff"><b>${esc(roleLabel(cur))}</b> — ${esc(roleEffect(cur))}</p>
  </div>`;
}

function pitchBoard(app, w, info) {
  const l = w.myLineup;
  const slots = FORMATIONS[l.formation].slots;
  return `<div class="pitchboard" role="group" aria-label="선발 라인업">
    <div class="pb-lines" aria-hidden="true"><i></i><i></i><i></i><i></i></div>
    ${slots.map((s, i) => chipFor(s, info.slots[i], i, app.state.selSlot === i, w.myTeamId, l.tactic)).join('')}
    <span class="pb-goal top">상대 골문</span><span class="pb-goal bottom">우리 골문</span>
  </div>`;
}

function playerCard(w, p, opts = {}) {
  if (!p) return '<p class="muted">선수를 선택하세요.</p>';
  const st = p.season || {};
  const stats = ['spd', 'sho', 'pas', 'dri', 'def', 'vis', 'sta', 'gk'].map((k) => {
    const label = { spd: '스피드', sho: '슈팅', pas: '패스', dri: '드리블', def: '수비', vis: '시야', sta: '체력', gk: 'GK' }[k];
    return `<li><span>${label}</span><i class="bar"><i data-w="${p.stats[k]}"></i></i><b>${p.stats[k]}</b></li>`;
  }).join('');
  return `<div class="pcard">
    <div class="pc-head">
      <span class="pc-num">${p.num}</span>
      <div><h4>${esc(p.name)}</h4><p class="sm">${p.pos} · ${p.age}세 · 종합 <b>${p.ovr}</b></p></div>
      <span class="pc-ovr">${p.ovr}</span>
    </div>
    <ul class="stats8">${stats}</ul>
    <div class="pc-meta">
      <div><small>몸값</small><b>${won(p.value)}</b></div>
      <div><small>주급</small><b>${W.fmt(p.wage)}만</b></div>
      <div><small>시즌 출전</small><b>${st.apps || 0}경기</b></div>
      <div><small>득점/도움</small><b>${st.goals || 0} / ${st.assists || 0}</b></div>
      <div><small>평균 평점</small><b>${st.ratingCount ? (st.ratingSum / st.ratingCount).toFixed(2) : '—'}</b></div>
    </div>
    ${(p.bans > 0 || p.inj > 0) ? `<p class="warn-bar">${p.bans > 0 ? `⛔ 출전 정지 ${p.bans}경기` : ''}${p.bans > 0 && p.inj > 0 ? ' · ' : ''}${p.inj > 0 ? `🚑 부상 ${p.inj}경기 결장` : ''}</p>` : ''}
    ${opts.note ? `<p class="hint">${opts.note}</p>` : ''}
  </div>`;
}

function squadTab(app, w) {
  const info = W.lineupInfo(w);
  const l = w.myLineup;
  const selPid = app.state.selPid;
  const selP = selPid ? w.players[selPid] : (info.slots[app.state.selSlot ?? 0]?.p || null);
  const bench = l.bench.map((id) => w.players[id]).filter(Boolean);
  const selIdx = selP ? info.slots.findIndex((s) => s.p && s.p.id === selP.id) : -1;
  const selNote = selIdx >= 0 && info.slots[selIdx].slot.pos !== 'GK'
    ? `역할 · <b>${esc(roleLabel(info.roles[selIdx]))}</b> — ${esc(roleEffect(info.roles[selIdx]))}` : '';
  const mismatch = info.slots.filter((s) => s.p && s.factor < 0.99).length;
  const outMen = info.slots.filter((s) => s.p && (s.p.inj > 0 || s.p.bans > 0));
  const slices = FORMATIONS[l.formation].slots;
  const ment = Number(l.tactic.mentality) || 0;
  const mentNow = mentalityOf(ment);
  const axes = AXES.map((a) => {
    const v = l.tactic[a.key] || 0;
    return `<li class="axis">
      <div class="axis-head"><b>${a.name}</b><span class="axis-val">${stepLabel(v)}</span></div>
      <div class="axis-ctl" role="group" aria-label="${a.name}">
        <span class="axis-end">${a.left}</span>
        <span class="seg">${STEPS.map((s) => `<button type="button" class="${Math.abs(s - v) < 0.01 ? 'on' : ''}" data-act="tactic" data-axis="${a.key}" data-val="${s}" aria-label="${a.name} ${stepLabel(s)} ${s > 0 ? a.right : s < 0 ? a.left : ''}">${s > 0 ? '▲' : s < 0 ? '▼' : '●'}</button>`).join('')}</span>
        <span class="axis-end">${a.right}</span>
      </div>
      <p class="axis-eff">${a.effect(v)}</p>
    </li>`;
  }).join('');

  return `<div class="grid2 squad-grid">
    <article class="card">
      <div class="card-head"><h3>전술 보드</h3><span class="pill">${esc(l.formation)}${mismatch ? ` · 위치 보정 ${mismatch}` : ' · 최적 배치'}</span></div>
      <div class="form-row" role="group" aria-label="포메이션">
        ${Object.keys(FORMATIONS).map((f) => `<button type="button" class="btn small ${l.formation === f ? 'on' : ''}" data-act="formation" data-formation="${f}">${f}</button>`).join('')}
        <button type="button" class="btn small ghost right" data-act="auto-lineup">자동 선발</button>
      </div>
      ${outMen.length ? `<p class="warn-bar">🚑 선발 중 뛸 수 없는 선수 ${outMen.length}명 — ${outMen.map((s) => esc(s.p.name)).join(', ')}. 경기를 시작하면 자동으로 교체됩니다.</p>` : ''}
      ${pitchBoard(app, w, info)}
      ${roleBar(info, app.state.roleSlot ?? app.state.selSlot, slices)}
      <p class="hint">선발을 누른 뒤 후보 선수를 누르면 자리가 바뀝니다. <b>↯</b> 는 포지션 불일치 보정입니다. 포지션 이름(<b>LB · 풀백</b>)을 누르면 역할이 바로 바뀝니다.</p>
      <h4 class="sub">후보 7명</h4>
      <ul class="bench">${bench.map((p) => `<li><button type="button" class="bench-btn ${app.state.selBench === p.id ? 'sel' : ''}" data-act="bench" data-pid="${p.id}"><span class="bn">${p.num}</span><span>${esc(p.name)}</span><small>${p.pos} · ${p.ovr}</small></button></li>`).join('') || '<li class="muted sm">후보가 없습니다.</li>'}</ul>
    </article>
    <div class="stack">
      <article class="card">${playerCard(w, selP, selNote)}</article>
      <article class="card">
        <div class="card-head"><h3>팀 성향</h3><span class="pill">${esc(mentNow.name)}</span></div>
        <div class="ment-row" role="group" aria-label="팀 성향(멘탈리티)">
          ${MENTALITY.map((m) => `<button type="button" class="ment-btn ${Math.abs(m.v - ment) < 0.01 ? 'on' : ''}" data-act="mentality" data-val="${m.v}" aria-pressed="${Math.abs(m.v - ment) < 0.01}">
            <b>${esc(m.name)}</b><small>${esc(m.tag)}</small></button>`).join('')}
        </div>
        <p class="axis-eff">${esc(mentalityEffect(ment, true))} · 수비 시 ${esc(mentalityEffect(ment, false))}</p>
      </article>
      <article class="card">
        <div class="card-head"><h3>전술 4축</h3><span class="pill">경기 중에도 변경</span></div>
        <ul class="axes">${axes}</ul>
      </article>
    </div>
  </div>
  <article class="card">
    <div class="card-head"><h3>선수단 ${w.teams[w.myTeamId].squad.length}명</h3><span class="pill">주급 합계 ${W.fmt(W.teamWageTotal(w, w.myTeamId))}만/주</span></div>
    <div class="table-wrap"><table class="tbl squad">
      <thead><tr><th>#</th><th>이름</th><th>포지션</th><th>나이</th><th>종합</th><th>스피드</th><th>슈팅</th><th>패스</th><th>수비</th><th>체력</th><th>몸값</th><th>출전</th></tr></thead>
      <tbody>${W.squadOf(w, w.myTeamId).sort((a, b) => b.ovr - a.ovr).map((p) => `<tr class="${p.id === selPid ? 'on' : ''}" data-act="player" data-pid="${p.id}"><td>${p.num}</td><td><b>${esc(p.name)}</b>${p.bans > 0 ? ' <span class="pill xs" title="출전 정지">정지</span>' : ''}${p.inj > 0 ? ' <span class="pill xs" title="부상">부상</span>' : ''}</td><td>${p.pos}</td><td>${p.age}</td><td><b>${p.ovr}</b></td><td>${p.stats.spd}</td><td>${p.stats.sho}</td><td>${p.stats.pas}</td><td>${p.stats.def}</td><td>${p.stats.sta}</td><td>${won(p.value)}</td><td>${p.season?.apps || 0}</td></tr>`).join('')}</tbody>
    </table></div>
  </article>`;
}

/* ── 이적 시장 탭 ── */
function marketTab(app, w) {
  const me = W.myTeam(w);
  const wage = W.teamWageTotal(w, w.myTeamId);
  const rows = w.market.map((e) => {
    const p = w.players[e.pid];
    if (!p) return '';
    const from = e.from ? w.teams[e.from] : null;
    const c = W.canSign(w, e);
    return `<tr>
      <td><b>${esc(p.name)}</b><small class="pos">${p.pos}</small></td>
      <td>${from ? `<span class="tl">${badge(from)}${esc(from.short)}</span>` : '<span class="pill free">자유계약</span>'}</td>
      <td>${p.age}</td><td><b>${p.ovr}</b></td>
      <td>${won(p.value)}</td><td><b>${e.price ? won(e.price) : '무료'}</b></td>
      <td>${W.fmt(p.wage)}만</td>
      <td><button type="button" class="btn small ${c.ok ? 'primary' : ''}" data-act="sign" data-pid="${p.id}" ${c.ok ? '' : 'disabled title="' + esc(c.why) + '"'}>영입</button></td>
    </tr>`;
  }).join('');
  const mine = W.squadOf(w, w.myTeamId).sort((a, b) => b.value - a.value).map((p) => `<tr>
      <td><b>${esc(p.name)}</b><small class="pos">${p.pos}</small></td>
      <td>${p.age}</td><td>${p.ovr}</td><td>${won(p.value)}</td><td>${W.fmt(p.wage)}만</td>
      <td>${won(Math.round(p.value * 0.9 * 10) / 10)}</td>
      <td><button type="button" class="btn small danger" data-act="sell" data-pid="${p.id}">방출</button></td>
    </tr>`).join('');
  const overWage = wage > me.wage;
  return `<article class="card">
    <div class="card-head"><h3>이적 시장</h3><span class="pill">${w.season}시즌 · 다음 시즌 개막 때 갱신</span></div>
    <div class="money-row">
      <div><small>이적 자금</small><b>${won(me.budget)}</b></div>
      <div><small>주급 사용</small><b>${W.fmt(wage)}<span class="unit"> / ${W.fmt(me.wage)}만</span></b></div>
      <div><small>선수단</small><b>${me.squad.length}<span class="unit"> / 24명</span></b></div>
      <div><small>이번 시즌 지출</small><b>${won(w.finance.spent)}</b></div>
    </div>
    ${overWage ? '<p class="warn-bar">주급 예산을 초과했습니다. 선수를 방출해 공간을 만든 뒤 영입할 수 있습니다.</p>' : ''}
    <div class="table-wrap"><table class="tbl market">
      <thead><tr><th>선수</th><th>소속</th><th>나이</th><th>종합</th><th>몸값</th><th>이적료</th><th>주급</th><th></th></tr></thead>
      <tbody>${rows || '<tr><td colspan="8" class="muted">시장에 나온 선수가 없습니다.</td></tr>'}</tbody>
    </table></div>
    <p class="hint">영입하면 이적 자금이 빠지고 주급이 늘어납니다. 주급 예산을 넘으면 영입할 수 없습니다.</p>
  </article>
  <article class="card">
    <div class="card-head"><h3>방출 가능한 선수</h3><span class="pill">몸값의 90% 회수</span></div>
    <div class="table-wrap"><table class="tbl market">
      <thead><tr><th>선수</th><th>나이</th><th>종합</th><th>몸값</th><th>주급</th><th>예상 이적료</th><th></th></tr></thead>
      <tbody>${mine}</tbody>
    </table></div>
  </article>`;
}

/* ── 순위/기록 탭 ── */
function recordsTab(app, w) {
  const table = W.standings(w);
  const rows = table.map((r) => {
    const t = w.teams[r.id];
    return `<tr class="${r.id === w.myTeamId ? 'on' : ''}">
      <td class="rank ${r.rank <= 3 ? 'top' : r.rank >= 9 ? 'low' : ''}">${r.rank}</td>
      <td>${teamLine(w, r.id)}</td>
      <td>${r.play}</td><td>${r.win}</td><td>${r.draw}</td><td>${r.loss}</td>
      <td>${r.gf}</td><td>${r.ga}</td><td>${r.gd > 0 ? '+' + r.gd : r.gd}</td><td><b>${r.pts}</b></td>
      <td>${formChips(r.form)}</td>
    </tr>`;
  }).join('');

  const stageList = [0, 1, 2, 3].map((i) => w.cup.stages[i] || { name: W.CUP_NAMES[i], matches: [] });
  const stages = stageList.map((s) => {
    const ms = s.matches.map((m) => {
      const winnerSide = m.played ? (m.winner === m.home ? 'h' : 'a') : '';
      return `<li class="cup-match">
        <span class="cm-team ${winnerSide === 'h' ? 'win' : ''}">${esc(w.teams[m.home]?.short || '?')}</span>
        <span class="cm-score">${m.played ? `${m.hg}<i>:</i>${m.ag}` : 'vs'}</span>
        <span class="cm-team ${winnerSide === 'a' ? 'win' : ''}">${esc(w.teams[m.away]?.short || '?')}</span>
        ${m.aet ? '<small class="aet">연장</small>' : ''}
      </li>`;
    }).join('');
    const placeholder = `<li class="cup-match ghost"><span class="cm-team">대진 미정</span></li>`;
    return `<div class="cup-stage"><h4>${s.name}</h4><ul>${ms || placeholder}</ul></div>`;
  }).join('');

  const board = (kind, title) => {
    const list = W.leaders(w, kind, 5);
    return `<article class="card lb">
      <h3>${title}</h3>
      <ol>${list.map((x, i) => `<li><span class="lb-rank">${i + 1}</span><span class="lb-name">${esc(x.p.name)}<small>${esc(w.teams[x.p.teamId]?.short || '')} · ${x.p.pos}</small></span><b>${x.value}</b></li>`).join('') || '<li class="muted sm">기록 없음</li>'}</ol>
    </article>`;
  };

  return `<div class="grid2">
    <article class="card">
      <div class="card-head"><h3>리그 순위표</h3><span class="pill">${w.season}시즌 · 10팀 18라운드</span></div>
      <div class="table-wrap"><table class="tbl standings">
        <thead><tr><th>순위</th><th>팀</th><th>경기</th><th>승</th><th>무</th><th>패</th><th>득</th><th>실</th><th>득실</th><th>승점</th><th>최근</th></tr></thead>
        <tbody>${rows}</tbody>
      </table></div>
      <p class="hint">1위 우승 · 9~10위는 다음 시즌을 다시 준비합니다. 컵대회는 별도 토너먼트입니다.</p>
    </article>
    <article class="card">
      <div class="card-head"><h3>컵대회 대진</h3><span class="pill">10팀 토너먼트</span></div>
      <div class="bracket">${stages}</div>
    </article>
  </div>
  <div class="grid3">${board('goals', '⚽ 득점왕')}${board('assists', '🅰️ 도움왕')}${board('rating', '⭐ 평점 리더')}</div>
  <article class="card">
    <div class="card-head"><h3>구단 소식</h3><span class="pill">최근</span></div>
    <ul class="news">${w.news.slice(0, 8).map((n) => `<li><span class="pill xs">${n.season}시즌</span>${esc(n.text)}</li>`).join('') || '<li class="muted sm">소식이 없습니다.</li>'}</ul>
  </article>`;
}

/* ── 시즌 결산 ── */
export function renderSeason(app) {
  const w = app.world;
  const r = app.state.seasonResult;
  const s = r.summary;
  const my = s.table.find((x) => x.id === w.myTeamId);
  const done = app.state.seasonPhase === 'done';
  return `<section class="season">
    <span class="eyebrow">${r.season || w.season}시즌 결산</span>
    <h1>${s.myRank === 1 ? '🏆 리그 우승!' : `${s.myRank}위로 시즌 마감`}</h1>
    <p class="hero-desc">${esc(w.teams[w.myTeamId].name)} · 승점 ${my?.pts ?? 0} · ${my?.win ?? 0}승 ${my?.draw ?? 0}무 ${my?.loss ?? 0}패 (${my?.gf ?? 0}-${my?.ga ?? 0})</p>
    <div class="season-grid">
      <article class="card"><div class="card-head"><h3>최종 순위</h3><span class="pill">리그 우승 ${s.champion ? esc(w.teams[s.champion].short) : '—'}</span></div>
        <ol class="final-table">${s.table.map((x) => `<li class="${x.id === w.myTeamId ? 'on' : ''}"><span>${x.rank}</span>${teamLine(w, x.id)}<b>${x.pts}</b><small>${x.gf}:${x.ga}</small></li>`).join('')}</ol>
      </article>
      <article class="card"><h3>컵대회</h3>
        <p class="cup-result">${s.cupWinner ? `${teamLine(w, s.cupWinner)} <b>우승</b>` : '결승 미완료'}</p>
        <p class="sm">${esc(w.teams[w.myTeamId].short)} — ${esc(s.cupOut)}</p>
        <h3 class="sub">재정</h3>
        <div class="money-row">
          ${done ? `<div><small>리그 상금</small><b>${won(r.prize - r.cupPrize)}</b></div>
          <div><small>컵 상금</small><b>${won(r.cupPrize)}</b></div>` : '<div><small>상금</small><b>다음 시즌 시작 시 정산</b></div>'}
          <div><small>현재 이적 자금</small><b>${won(w.teams[w.myTeamId].budget)}</b></div>
        </div>
      </article>
    </div>
    ${done ? `<article class="card"><h3>선수 성장 · 노쇠</h3>
      <ul class="growth">${r.growth.map((g) => `<li>${teamLine(w, g.teamId)}<span>${esc(g.name)}</span><b class="${g.to >= g.from ? 'up' : 'down'}">${g.from} → ${g.to}</b></li>`).join('') || '<li class="muted sm">큰 변화가 없습니다.</li>'}</ul>
      ${r.retired?.length ? `<p class="hint">은퇴: ${r.retired.map(esc).join(', ')}</p>` : ''}
    </article>` : '<p class="hint">다음 시즌을 시작하면 상금 정산과 함께 선수들이 한 살씩 먹고 성장·노쇠합니다.</p>'}
    <div class="actions center"><button class="btn primary big" data-act="${done ? 'close-season' : 'next-season'}" type="button">${done ? '새 시즌 시작 →' : '다음 시즌 시작 →'}</button></div>
  </section>`;
}

/* ── 확인 모달 ── */
export function renderModal(app) {
  const m = app.state.modal;
  if (!m) return '';
  if (m.kind === 'new-game') {
    return `<div class="modal-back" data-act="modal-close"><div class="modal" role="dialog" aria-modal="true" aria-labelledby="m-title">
      <h3 id="m-title">새 게임을 시작할까요?</h3>
      <p>지금 커리어(시즌 ${app.world?.season ?? 1}, ${esc(app.world ? app.world.teams[app.world.myTeamId].name : '')})는 이 브라우저에서 사라집니다.</p>
      <div class="actions"><button class="btn danger" data-act="new-game-confirm" type="button">삭제하고 구단 선택</button><button class="btn" data-act="modal-close" type="button">취소</button></div>
    </div></div>`;
  }
  if (m.kind === 'sell') {
    const p = app.world.players[m.pid];
    return `<div class="modal-back" data-act="modal-close"><div class="modal" role="dialog" aria-modal="true" aria-labelledby="m-title">
      <h3 id="m-title">${esc(p?.name)} 선수를 방출할까요?</h3>
      <p>${esc(p?.pos)} · 종합 ${p?.ovr} · 예상 이적료 ${won(Math.round((p?.value || 0) * 0.9 * 10) / 10)}. 선수단에서 빠지고 이적 자금이 늘어납니다.</p>
      <div class="actions"><button class="btn danger" data-act="sell-confirm" data-pid="${m.pid}" type="button">방출하기</button><button class="btn" data-act="modal-close" type="button">취소</button></div>
    </div></div>`;
  }
  if (m.kind === 'overwrite') {
    const t = app.defs[m.team];
    const old = app.savedGame?.teams?.[app.savedGame.myTeamId] || (app.world ? app.world.teams[app.world.myTeamId] : null);
    return `<div class="modal-back" data-act="modal-close"><div class="modal" role="dialog" aria-modal="true" aria-labelledby="m-title">
      <h3 id="m-title">기존 커리어를 지우고 새로 시작할까요?</h3>
      <p>${old ? `${esc(old.name)} · ${(app.savedGame || app.world).season}시즌 커리어` : '저장된 커리어'}가 이 브라우저에서 사라집니다. 되돌릴 수 없습니다.</p>
      <p class="sm"><b>${esc(t.name)}</b> 감독으로 새로 시작합니다.</p>
      <div class="actions"><button class="btn danger" data-act="overwrite-confirm" data-team="${t.id}" type="button">지우고 새로 시작</button><button class="btn" data-act="modal-close" type="button">취소</button></div>
    </div></div>`;
  }
  if (m.kind === 'team') {
    const t = app.defs[m.team];
    return `<div class="modal-back" data-act="modal-close"><div class="modal wide" role="dialog" aria-modal="true" aria-labelledby="m-title">
      <div class="modal-head">${badge(t, 'mid')}<div><h3 id="m-title">${esc(t.name)}</h3><p class="sm">${esc(t.nick)} · ${esc(t.stadium)} (${W.fmtWon(t.capacity)}석)</p></div></div>
      <p>${esc(t.bio)}</p>
      <div class="money-row">
        <div><small>이적 자금</small><b>${won(t.budget)}</b></div>
        <div><small>주급 예산</small><b>${W.fmt(t.wage)}만/주</b></div>
        <div><small>전력</small><b>${t.power}</b></div>
        <div><small>포메이션</small><b>${esc(t.formation)}</b></div>
      </div>
      <p class="sm"><b>주 전술</b> ${esc(tacticWords(t.tactic))}</p>
      <div class="actions"><button class="btn primary" data-act="team-sign" data-team="${t.id}" type="button">이 구단으로 시작</button><button class="btn" data-act="modal-close" type="button">다른 구단 보기</button></div>
    </div></div>`;
  }
  return '';
}
