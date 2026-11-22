// 화면 렌더 — 문자열 HTML + data-act 버튼. 상태는 app 객체에서 읽습니다.
import { FORMATIONS, STAT_LABEL, STAT_KEYS } from './data.js';
import { KL_TEAMS, KL_DIVISIONS, KL_ROSTERS } from './kleague2026.js';
import * as W from './world.js';
import { AXES, STEPS, stepLabel, tacticWords, MENTALITY, mentalityOf, mentalityEffect, roleLabel, roleShort, roleEffect, rolesForLabel, defaultRole, nextRole, ROLE_TUNING, SET_PIECES, SET_PIECE_TYPES, resolveSetPiece, setPieceKey, setPieceLabel, setPieceEffect } from './tactics.js';
import { scoutReport } from './scout.js';
import { getEntry, STAT_FIELDS, STAT_LABELS, unpackStats, logInfo } from './history.js';
import { readPresets } from './presets.js';
import { readSlots, slotMeta, slotsBytes, SLOT_COUNT } from './saves.js';

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

/* 저장 시각 · 용량 표기 */
const whenText = (ts) => {
  if (!ts) return '';
  const d = new Date(ts);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}.${p(d.getMonth() + 1)}.${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
};
const kbText = (bytes) => (!bytes ? '0KB' : bytes >= 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(1)}MB` : `${Math.max(1, Math.round(bytes / 1024))}KB`);
const compLabel = (w, round) => (round.type === 'cup' ? W.cupLabelOf(w, round.stage) : (W.isKL(w) ? `${W.divName(w, round.div || W.divOf(w, w.myTeamId))} 리그 ${round.leagueRound}R` : `리그 ${round.leagueRound}R`));
const resWord = (res) => (res === 'W' ? '승' : res === 'L' ? '패' : res === 'D' ? '무' : '');

/* 성장·훈련 표시 도우미 */
const statWords = (keys) => [...new Set(keys || [])].map((k) => STAT_LABEL[k] || k);
// 성장 기록의 능력치를 부호와 함께 (+1 스피드 / -1 체력)
const logWords = (l) => {
  if (!l) return '';
  if (Array.isArray(l.up) || Array.isArray(l.dn)) {
    return [...new Set([...(l.up || []).map((k) => '+' + (STAT_LABEL[k] || k)), ...(l.dn || []).map((k) => '-' + (STAT_LABEL[k] || k))])].join(' · ');
  }
  return statWords(l.st).join(' · ');
};
const statDelta = (l) => (l ? (l.up?.length || 0) - (l.dn?.length || 0) : 0);
const deltaChip = (d) => (d > 0 ? `<b class="grow-up">+${d}</b>` : d < 0 ? `<b class="grow-down">${d}</b>` : '<span class="muted xs">—</span>');
// 선수단 '최근' 열 — 종합이 움직였으면 종합 증감, 아니면 능력치 포인트 증감
const recentCell = (p) => {
  const d = W.recentDelta(p);
  if (d) return deltaChip(d);
  const last = (p.growthLog || []).slice(-1)[0];
  const n = statDelta(last);
  if (!n) return '<span class="muted xs">—</span>';
  return `<b class="${n > 0 ? 'grow-up' : 'grow-down'}" title="능력치 포인트 ${n > 0 ? '+' : ''}${n}">${n > 0 ? '+' : ''}${n}<small class="grow-k">능</small></b>`;
};
const statusPill = (p) => {
  const s = W.growthStatus(p);
  return `<span class="pill xs g-${s.key}" title="${esc(s.note)}">${esc(s.label)}</span>`;
};
const potOf = (p) => (Number.isFinite(p.pot) ? p.pot : p.ovr);

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
  if (!t) return '';
  return `<button type="button" class="tl" data-act="club" data-team="${id}" title="${esc(t.name)} 선수단 보기">${badge(t)}<b>${esc(t.short)}</b></button>`;
}

/* ─────────────────────────── 구단 선택 ─────────────────────────── */
export function renderSelect(app) {
  const hasSave = !!app.savedGame;
  const mode = app.state.pickMode === 'kleague' ? 'kleague' : 'custom';
  const div = Number(app.state.pickDiv) || 1;
  const clip = mode === 'kleague' ? KL_TEAMS.filter((t) => t.div === div) : Object.values(app.defs).filter((t) => !t.div);
  const cards = clip.map((t) => {
    const divTag = mode === 'kleague' ? `<span class="divtag k${t.div}">${esc(W.divName({ divisions: KL_DIVISIONS }, t.div))}</span>` : '';
    const rec = mode === 'kleague' && t.id === 'geumsan' ? '<span class="rec-tag">추천 시작</span>' : '';
    return `<button class="team-card" data-act="team" data-team="${t.id}" type="button">
      <span class="tc-top">${badge(t)}<span class="tc-name"><b>${esc(t.name)}</b><small>${esc(t.nick)} · ${esc(t.city)}</small></span>${divTag}${rec}</span>
      <span class="tc-meta">
        <span><b>${t.power}</b> 전력</span>
        ${mode === 'kleague' ? `<span class="tc-stadium">${esc(t.stadium)}</span>` : `<span><b>${won(t.budget)}</b> 자금</span>`}
        <span><b>${esc(t.formation)}</b> 포메이션</span>
      </span>
      <span class="tc-words">${esc(tacticWords(t.tactic))}</span>
      <span class="tc-bio">${esc(t.bio)}</span>
      <span class="tc-go">감독 취임 →</span>
    </button>`;
  }).join('');
  const modeTabs = `<div class="mode-tabs" role="group" aria-label="리그 선택">
    <button type="button" class="mode-tab ${mode === 'custom' ? 'on' : ''}" data-act="pick-mode" data-mode="custom" aria-pressed="${mode === 'custom'}">
      <b>커스텀 리그</b><small>기존 10개 구단 · 단일 리그 18라운드 + 컵</small>
    </button>
    <button type="button" class="mode-tab ${mode === 'kleague' ? 'on' : ''}" data-act="pick-mode" data-mode="kleague" aria-pressed="${mode === 'kleague'}">
      <b>K리그 2026</b><small>실제 56개 구단 · K4→K1 승강제 + 코리아컵</small>
    </button>
  </div>`;
  const divTabs = mode === 'kleague' ? `<div class="div-tabs" role="group" aria-label="디비전">
    ${KL_DIVISIONS.map((d) => {
      const n = KL_TEAMS.filter((t) => t.div === d.id).length;
      return `<button type="button" class="div-tab k${d.id} ${d.id === div ? 'on' : ''}" data-act="pick-div" data-div="${d.id}" aria-pressed="${d.id === div}">
        <b>${esc(d.name)}</b><small>${n}팀 · ${d.lo}~${d.hi}</small></button>`;
    }).join('')}
  </div>` : '';
  const savedName = hasSave ? app.savedGame.teams[app.savedGame.myTeamId].name : '';
  const savedSub = hasSave
    ? `${esc(savedName)} · ${esc(W.seasonLabel(app.savedGame))}${W.isKL(app.savedGame) ? ` · ${esc(W.divName(app.savedGame, W.divOf(app.savedGame, app.savedGame.myTeamId)))}` : ''}`
    : '';

  return `
  ${hasSave ? `<div class="resume">
    <div><b>저장된 커리어가 있습니다</b><span class="sm">${savedSub}</span></div>
    <button class="btn primary" data-act="continue" type="button">커리어 이어하기</button>
  </div>` : ''}
  <section class="hero">
    <div class="hero-copy">
      <span class="eyebrow">GOODWAY APPS · FOOTBALL MANAGER</span>
      <h1>미니 <span class="hl">풋볼 매니저</span></h1>
      <p class="hero-desc">2D 바둑알 매치 엔진 · K리그 1~4부 승강제 · 코리아컵 · 전술 4축 · 이적 시장</p>
      <ul class="feat">
        <li>90분을 360틱으로 실시간 시뮬레이션</li>
        <li>K4에서 시작해 K1까지 올라가는 커리어</li>
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
  <div class="sec-head"><h2>리그를 고르세요</h2><p class="hint">K리그 2026은 실제 2026 시즌 K1~K4 56개 구단의 선수 명단으로 시작합니다. K4부터 올라가는 커리어를 권합니다.</p></div>
  ${modeTabs}
  ${divTabs}
  <div class="sec-head"><h2>${mode === 'kleague' ? `${esc(W.divName({ divisions: KL_DIVISIONS }, div))} 구단 ${clip.length}개` : '구단을 선택하세요'}</h2><p class="hint">팀마다 전력·예산·주력 전술이 다릅니다. 언제든 새 게임으로 다시 시작할 수 있습니다.</p></div>
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
  const divRounds = W.isKL(w) ? (w.calendar.filter((r) => r.type === 'league' && r.div === W.divOf(w, w.myTeamId)).length || 1) : 18;
  const divNow = W.isKL(w) ? W.divName(w, W.divOf(w, w.myTeamId)) : null;
  const body = { schedule: scheduleTab, squad: squadTab, market: marketTab, records: recordsTab }[app.state.tab] || scheduleTab;
  return `
  <section class="clubbar">
    <div class="club-id">${badge(me, 'big')}
      <div><h2>${esc(me.name)}</h2><p class="sm">${divNow ? `<span class="divtag k${W.divOf(w, w.myTeamId)}">${esc(divNow)}</span> · ` : ''}${esc(me.nick)} · ${esc(me.stadium)}</p></div>
    </div>
    <div class="club-stats">
      <div><small>시즌</small><b>${esc(W.seasonLabel(w))}</b></div>
      <div><small>리그 순위</small><b>${myRow && myRow.play > 0 ? rankLabel(myRow.rank) : '—'}</b></div>
      <div><small>이적 자금</small><b>${won(me.budget)}</b></div>
      <div><small>주급</small><b>${W.fmt(W.teamWageTotal(w, w.myTeamId))}<span class="unit">만/주</span></b></div>
      <div><small>스쿼드 전력</small><b>${W.teamPower(w, w.myTeamId)}</b></div>
      <div><small>리그 라운드</small><b>${lr > divRounds ? '종료' : `${lr} / ${divRounds}R`}</b></div>
    </div>
    <div class="club-acts">
      <button class="btn small ghost" data-act="saves" type="button">💾 저장/불러오기</button>
      <button class="btn small ghost" data-act="new-game" type="button">새 게임</button>
    </div>
  </section>
  <nav class="tabs" aria-label="앱 탭">${TABS.map((t) => `<button type="button" class="tab ${app.state.tab === t.id ? 'on' : ''}" data-act="tab" data-tab="${t.id}" aria-current="${app.state.tab === t.id}">${t.label}${t.id === 'market' && (w.offers || []).length ? ` <span class="tab-n">${w.offers.length}</span>` : ''}</button>`).join('')}</nav>
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
  const label = round.type === 'cup' ? W.cupLabelOf(w, round.stage) : `리그 ${round.leagueRound}R`;
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
        <p class="sp-note"><b>세트피스</b> 코너 <em>${esc(setPieceLabel('corner', rep.setpiece.corner))}</em> · 프리킥 <em>${esc(setPieceLabel('freekick', rep.setpiece.freekick))}</em></p>
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
  const label = round.type === 'cup' ? W.cupLabelOf(w, round.stage) : `리그 ${round.leagueRound}R`;
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
    // 치른 경기는 눌러서 그날의 기록(득점자·슈팅·점유율·평점)을 다시 봅니다
    const attr = played ? ` class="clickable ${mine ? 'mine' : ''}" data-act="match" data-round="${round.no}" data-home="${f.home}" data-away="${f.away}" tabindex="0"` : ` class="${mine ? 'mine' : ''}"`;
    return `<li${attr}>
      ${teamLine(w, f.home)}
      <span class="score">${played ? `${f.hg} : ${f.ag}` : 'vs'}</span>
      ${teamLine(w, f.away)}
      ${played ? `<button class="mini-link" type="button" data-act="match" data-round="${round.no}" data-home="${f.home}" data-away="${f.away}" aria-label="${esc(w.teams[f.home]?.short || '')} ${esc(w.teams[f.away]?.short || '')} 경기 기록">기록 ▸</button>` : '<span class="muted xs">예정</span>'}
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
    return `<li class="clickable" data-act="match" data-round="${x.round.no}" data-home="${f.home}" data-away="${f.away}" tabindex="0"><i class="f-${res}">${res === 'W' ? '승' : res === 'L' ? '패' : '무'}</i>${teamLine(w, oppId)}<span class="score">${g} : ${o}</span><button class="mini-link" type="button" data-act="match" data-round="${x.round.no}" data-home="${f.home}" data-away="${f.away}" aria-label="${esc(w.teams[oppId]?.short || '')} 경기 기록">기록 ▸</button></li>`;
  }).join('')}</ul>`;
}

/* ── 지난 라운드 성장 요약 ── */
function growthCard(w) {
  const g = w.lastGrowth;
  const list = (g?.list || []).filter((x) => x.d !== 0 || x.plus.length || x.minus.length);
  if (!list.length) return '';
  const up = list.filter((x) => x.d > 0 || (x.d === 0 && x.plus.length > x.minus.length)).length;
  const down = list.filter((x) => x.d < 0 || (x.d === 0 && x.minus.length > x.plus.length)).length;
  return `<article class="card growth-card">
    <div class="card-head"><h3>📈 지난 경기 선수 성장</h3><span class="pill">${up}명 상승 · ${down}명 하락</span></div>
    <ul class="growth">${list.slice(0, 14).map((x) => {
      const words = logWords({ up: x.plus, dn: x.minus });
      const p = w.players[x.pid];
      const gain = x.d > 0 || (x.d === 0 && x.plus.length > x.minus.length);
      return `<li><b>${esc(x.name)}</b><span class="muted xs">${esc(x.pos)} · ${x.age}세</span><b class="${gain ? 'up' : 'down'}">${x.from === x.to ? `${x.to}` : `${x.from}→${x.to}`}</b><small class="gr-words">${esc(words || '변화 없음')}</small>${p ? statusPill(p) : ''}</li>`;
    }).join('')}</ul>
    <p class="hint">출전·평점·득점에 따라 매 라운드 자랍니다. 잠재력 가까이 간 선수는 성장이 둔해지고, 30대는 서서히 내려갑니다.</p>
  </article>`;
}

function scheduleTab(app, w) {
  return `<div class="grid2">
    ${nextMatchCard(app, w)}
    <article class="card">
      <div class="card-head"><h3>${(() => { const nx = W.userNextMatch(w); if (!nx) return '이번 라운드'; return nx.round.type === 'cup' ? W.cupLabelOf(w, nx.round.stage) : `리그 ${nx.round.leagueRound}라운드`; })()}</h3><span class="pill">다른 경기</span></div>
      ${roundFixtures(app, w)}
      <h4 class="sub">최근 경기</h4>
      ${recentList(app, w)}
    </article>
  </div>
  ${scoutCard(w)}
  ${growthCard(w)}
  <article class="card">
    <div class="card-head"><h3>시즌 일정</h3><span class="pill">${w.season}시즌</span></div>
    <div class="table-wrap"><table class="tbl sched">
      <thead><tr><th>#</th><th>종류</th><th>상대</th><th>홈/원정</th><th>결과</th></tr></thead>
      <tbody>${W.myFixtures(w).map((x) => {
        const f = x.fixture;
        const isHome = f.home === w.myTeamId;
        const oppId = isHome ? f.away : f.home;
        const r = W.resultOf(w, x.round, w.myTeamId);
        return `<tr${r ? ` class="clickable" data-act="match" data-round="${x.round.no}" data-home="${f.home}" data-away="${f.away}" tabindex="0"` : ''}><td>${x.round.no}</td><td>${x.round.type === 'cup' ? W.cupLabelOf(w, x.round.stage) : '리그'}</td><td>${teamLine(w, oppId)}</td><td>${isHome ? '홈' : '원정'}</td><td>${r ? `<b class="res-${r.res}">${r.mine} : ${r.opp}</b> <button class="mini-link" type="button" data-act="match" data-round="${x.round.no}" data-home="${f.home}" data-away="${f.away}" aria-label="${esc(w.teams[oppId]?.short || '')} 경기 기록">기록 ▸</button>` : '<span class="muted">예정</span>'}</td></tr>`;
      }).join('')}</tbody>
    </table></div>
  </article>`;
}

/* ── 세트피스 지시 줄 ──────────────────────────────────────────
   전술 탭·경기 중 시트(전술 변경)·하프타임 라커룸이 같은 줄을 씁니다.
   attr(type, key) 로 화면마다 다른 클릭 속성(data-act / data-msp / data-htsp)을 붙입니다. */
export function setPieceRows(sp, attr, opts = {}) {
  const cur = resolveSetPiece(sp);
  return SET_PIECE_TYPES.map((t) => {
    const now = cur[t];
    return `<li class="axis sp-row">
      <div class="axis-head"><b>${SET_PIECES[t].icon} ${esc(SET_PIECES[t].name)}</b><span class="axis-val">${esc(setPieceLabel(t, now))}</span></div>
      <div class="axis-ctl"><span class="seg">${SET_PIECES[t].opts.map((o) => `<button type="button" class="${o.key === now ? 'on' : ''}" ${attr(t, o.key)} aria-pressed="${o.key === now}">${esc(o.label)}</button>`).join('')}</span></div>
      ${opts.compact ? '' : `<p class="axis-eff">${esc(setPieceEffect(t, now))}</p>`}
    </li>`;
  }).join('');
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
  const team = w.teams[p.teamId];
  const full = !!opts.full;
  const stats = STAT_KEYS.map((k) => {
    const v = p.stats[k];
    return `<li><span>${STAT_LABEL[k]}</span><i class="bar"><i data-w="${v}"></i></i><b>${v}</b></li>`;
  }).join('');
  const avg = st.ratingCount ? (st.ratingSum / st.ratingCount).toFixed(2) : '—';
  const recent = (p.recent || []).slice(-5);
  const logs = (p.growthLog || []).slice(-4).reverse();
  return `<div class="pcard ${full ? 'full' : ''}">
    ${full ? '' : `<div class="pc-head">
      ${team ? badge(team) : ''}
      <span class="pc-num">${p.num}</span>
      <div><h4>${esc(p.name)}</h4><p class="sm">${p.pos} · ${esc({ GK: '골키퍼', DF: '수비수', MF: '미드필더', FW: '공격수' }[p.pos] || p.pos)} · ${p.age}세${team ? ` · ${esc(team.short)}` : ''}${p.loan ? ' · 임대' : ''}</p></div>
      <span class="pc-ovr">${p.ovr}</span>
    </div>`}
    ${full ? `<div class="pc-top">
      <div><span class="pc-label">${esc(team ? team.name : '자유계약')}</span><span class="pc-label">#${p.num}</span><span class="pc-label">${p.pos}</span><span class="pc-label">${p.age}세</span></div>
      <b class="pc-ovr sm">${p.ovr}</b>
    </div>` : ''}
    <ul class="stats8">${stats}</ul>
    <div class="pc-meta">
      <div><small>몸값</small><b>${won(p.value)}</b></div>
      <div><small>주급</small><b>${W.fmt(p.wage)}만</b></div>
      <div><small>잠재력</small><b>${potOf(p)}</b></div>
      <div><small>출전</small><b>${st.apps || 0}경기</b></div>
      <div><small>선발/교체</small><b>${st.starts || 0} / ${st.subs || 0}</b></div>
      <div><small>득점/도움</small><b>${st.goals || 0} / ${st.assists || 0}</b></div>
      <div><small>평균 평점</small><b>${avg}</b></div>
      <div><small>경고/퇴장</small><b>${st.yellow || 0} / ${st.red || 0}</b></div>
    </div>
    <div class="pc-recent">
      <small>최근 평점</small>
      <span class="ratings">${recent.length ? recent.map((r) => `<i class="rt ${r >= 7.5 ? 'hot' : r < 6 ? 'cold' : ''}">${r.toFixed(1)}</i>`).join('') : '<span class="muted xs">경기 기록 없음</span>'}</span>
    </div>
    ${(() => {
      const gs = W.growthStatus(p);
      return `<div class="grow-box">
        <div class="gb-head"><b>성장</b>${statusPill(p)}<span class="sm">잠재력 <b>${potOf(p)}</b> · ${esc(gs.note)}</span></div>
        <ul class="grow-log">${logs.map((l) => `<li><span class="muted xs">${l.s}시즌</span>${l.d ? deltaChip(l.d) : ''}<span>${logWords(l) || '능력치 변화 없음'}</span></li>`).join('') || '<li class="muted sm">아직 경기 기록이 없습니다.</li>'}</ul>
      </div>`;
    })()}
    ${st.cleanSheets ? `<p class="hint">무실점 ${st.cleanSheets}경기</p>` : ''}
    ${(p.bans > 0 || p.inj > 0) ? `<p class="warn-bar">${p.bans > 0 ? `⛔ 출전 정지 ${p.bans}경기` : ''}${p.bans > 0 && p.inj > 0 ? ' · ' : ''}${p.inj > 0 ? `🚑 부상 ${p.inj}경기 결장` : ''}</p>` : ''}
    ${opts.note ? `<p class="hint">${opts.note}</p>` : ''}
  </div>`;
}

function trainingCard(w) {
  const cur = W.trainingOf(w, w.myTeamId);
  const opts = W.TRAINING_IDS.map((k) => `<button type="button" class="train-btn ${k === cur ? 'on' : ''}" data-act="training" data-key="${k}" aria-pressed="${k === cur}">
      <b>${W.TRAINING[k].icon} ${esc(W.TRAINING[k].name)}</b><small>${esc(W.TRAINING[k].note)}</small></button>`).join('');
  return `<article class="card">
    <div class="card-head"><h3>주간 팀 훈련</h3><span class="pill">${esc(W.TRAINING[cur].name)}</span></div>
    <div class="train-row" role="group" aria-label="주간 훈련 방향">${opts}</div>
    <p class="hint">경기에 나선 선수는 <b>출전·평점(7.0 이상 가산)·득점·도움</b>만큼 매 라운드 성장합니다. 잠재력이 높은 어린 선수는 훈련 방향에 따라 자라는 능력치가 달라지고, 30대는 서서히 내려갑니다.</p>
  </article>`;
}

/* ── 선수단 필터·정렬 ── */
const POS_ORDER = { GK: 0, DF: 1, MF: 2, FW: 3 };
export function sortSquad(list, app) {
  const pos = app.state.posFilter || 'ALL';
  const key = app.state.sortKey || 'ovr';
  const dir = app.state.sortDir === 1 ? 1 : -1;
  const out = list.filter((p) => pos === 'ALL' || p.pos === pos);
  out.sort((a, b) => {
    let d = 0;
    if (key === 'age') d = a.age - b.age;
    else if (key === 'value') d = a.value - b.value;
    else if (key === 'pos') d = (POS_ORDER[a.pos] - POS_ORDER[b.pos]) || (a.ovr - b.ovr);
    else if (key === 'name') d = String(a.name).localeCompare(String(b.name), 'ko');
    else d = a.ovr - b.ovr;
    return d * dir || a.num - b.num;
  });
  return out;
}

function filterBar(app, opts = {}) {
  const pos = app.state.posFilter || 'ALL';
  const key = app.state.sortKey || 'ovr';
  const dir = app.state.sortDir === 1 ? 1 : -1;
  const chips = [['ALL', '전체'], ['GK', 'GK'], ['DF', 'DF'], ['MF', 'MF'], ['FW', 'FW']];
  const sorts = [['ovr', '종합'], ['age', '나이'], ['value', '몸값'], ['pos', '포지션'], ['name', '이름']];
  return `<div class="filter-bar">
    ${opts.noPos ? '' : `<span class="seg" role="group" aria-label="포지션">${chips.map(([k, l]) => `<button type="button" class="${pos === k ? 'on' : ''}" data-act="pos-filter" data-pos="${k}" aria-pressed="${pos === k}">${l}</button>`).join('')}</span>`}
    <span class="seg" role="group" aria-label="정렬">${sorts.map(([k, l]) => `<button type="button" class="${key === k ? 'on' : ''}" data-act="sort" data-key="${k}" aria-pressed="${key === k}">${l}${key === k ? (dir === 1 ? '↑' : '↓') : ''}</button>`).join('')}</span>
    <input class="search" type="search" placeholder="${esc(opts.placeholder || '선수 이름·포지션 검색')}" data-filter-input aria-label="선수 검색" />
  </div>`;
}
const squadFilterBar = (app) => filterBar(app);

/* ── 전술·명단 프리셋 ──
   지금 설정을 이름 붙여 저장해 두고, 다음에 한 번에 되살립니다.
   불러오기는 presets.js 가 실제 폴백(이적·부상·정원)까지 처리합니다. */
function presetCard(w) {
  const list = readPresets().list;
  return `<article class="card presets">
    <div class="card-head"><h3>전술·명단 프리셋</h3><span class="pill">${list.length}개 저장됨</span></div>
    <div class="preset-save">
      <input id="preset-name" class="search" maxlength="24" placeholder="프리셋 이름 (예: 홈 4-2-3-1 압박)" aria-label="새 프리셋 이름" />
      <button class="btn small primary" data-act="preset-save" type="button">현재 설정 저장</button>
    </div>
    ${list.length ? `<ul class="preset-list">${list.map((p) => {
      const n = (p.starters || []).filter(Boolean).length;
      return `<li class="preset" data-act="preset-load" data-id="${esc(p.id)}" tabindex="0" title="눌러서 이 프리셋을 불러옵니다">
        <div class="pr-main">
          <b>${esc(p.name)}</b>
          <small>${esc(p.formation)} · ${esc(tacticWords(p.tactic || {}))} · ${esc(p.div || '')}</small>
          <small class="muted">${esc(whenText(p.at))} · 선발 ${n}명 · 훈련 ${esc(W.TRAINING[p.training]?.name || '—')}</small>
        </div>
        <div class="pr-ops">
          <button class="btn small primary" data-act="preset-load" data-id="${esc(p.id)}" type="button">불러오기</button>
          <button class="btn small" data-act="preset-overwrite" data-id="${esc(p.id)}" type="button" title="지금 설정으로 이 프리셋을 덮어씁니다">덮어쓰기</button>
          <button class="btn small ghost" data-act="preset-delete" data-id="${esc(p.id)}" type="button">삭제</button>
        </div>
      </li>`;
    }).join('')}</ul>`
      : '<p class="muted sm">아직 저장한 프리셋이 없습니다. 지금 만든 전술·선발을 이름 붙여 저장하면 다음에 한 번에 불러올 수 있습니다.</p>'}
    <p class="hint">포메이션 · 전술 4축 · 팀 성향 · 세트피스 · 포지션별 역할 · 주간 훈련 · 선발 11명(과 후보)을 함께 저장합니다. 불러올 때 이적·부상·정지로 빠진 선수는 같은 포지션의 뛸 수 있는 선수로 자동 보정합니다.</p>
  </article>`;
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
        ${Object.keys(FORMATIONS).map((f) => `<button type="button" class="btn small ${l.formation === f ? 'on' : ''}" data-act="formation" data-formation="${f}" title="${esc(FORMATIONS[f].shape)}" aria-pressed="${l.formation === f}">${f}</button>`).join('')}
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
      ${presetCard(w)}
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
        <div class="card-head"><h3>세트피스 지시</h3><span class="pill">경기 중에도 변경</span></div>
        <ul class="axes sp-axes">${setPieceRows(l.setpiece, (t, k) => `data-act="setpiece" data-type="${t}" data-key="${k}"`)}</ul>
      </article>
      ${trainingCard(w)}
      <article class="card">
        <div class="card-head"><h3>전술 4축</h3><span class="pill">경기 중에도 변경</span></div>
        <ul class="axes">${axes}</ul>
      </article>
    </div>
  </div>
  <article class="card">
    <div class="card-head"><h3>선수단 ${w.teams[w.myTeamId].squad.length}명</h3><span class="pill">주급 합계 ${W.fmt(W.teamWageTotal(w, w.myTeamId))}만/주</span></div>
    ${squadFilterBar(app)}
    <div class="table-wrap"><table class="tbl squad" id="squad-table">
      <thead><tr><th>#</th><th>이름</th><th>포지션</th><th>나이</th><th>종합</th><th>잠재</th><th>최근</th><th>스피드</th><th>슈팅</th><th>패스</th><th>수비</th><th>체력</th><th>몸값</th><th>출전</th></tr></thead>
      <tbody>${sortSquad(W.squadOf(w, w.myTeamId), app).map((p) => `<tr class="${p.id === selPid ? 'on' : ''}" data-act="player" data-pid="${p.id}" data-fname="${esc(p.name)} ${p.pos}"><td>${p.num}</td><td><b>${esc(p.name)}</b>${p.bans > 0 ? ' <span class="pill xs" title="출전 정지">정지</span>' : ''}${p.inj > 0 ? ' <span class="pill xs" title="부상">부상</span>' : ''}${p.loan ? ' <span class="pill xs" title="임대">임대</span>' : ''}</td><td>${p.pos}</td><td>${p.age}</td><td><b>${p.ovr}</b></td><td>${potOf(p)}</td><td>${recentCell(p)}</td><td>${p.stats.spd}</td><td>${p.stats.sho}</td><td>${p.stats.pas}</td><td>${p.stats.def}</td><td>${p.stats.sta}</td><td>${won(p.value)}</td><td>${p.season?.apps || 0}</td></tr>`).join('')}</tbody>
    </table></div>
    <p class="hint">이름을 누르면 오른쪽 카드에 상세 능력치가 나옵니다. <b>포지션·정렬·검색</b>으로 원하는 선수를 바로 찾을 수 있습니다.</p>
  </article>`;
}

/* ── 이적 시장 탭 ── */
function offersCard(w) {
  const offers = w.offers || [];
  return `<article class="card offers">
    <div class="card-head"><h3>📨 우리 선수 영입 오퍼</h3><span class="pill">${offers.length ? `${offers.length}건 대기` : '없음'}</span></div>
    ${offers.length ? `<ul class="offer-list">${offers.map((o) => {
      const p = w.players[o.pid], from = w.teams[o.from];
      if (!p || !from) return '';
      return `<li class="offer">
        <div class="of-top">${badge(from)}<div class="of-who"><b>${esc(p.name)}</b><small>${p.pos} · ${p.age}세 · 종합 ${p.ovr} · 잠재 ${potOf(p)}</small></div><span class="of-price">${won(o.price)}</span></div>
        <p class="of-line">${esc(from.name)} · ${esc(W.divName(w, from.div || 1))} · 제안 ${won(o.price)} <span class="muted">(${o.round}R)</span></p>
        <div class="of-acts">
          <button class="btn small primary" data-act="offer-accept" data-id="${o.id}" type="button">수락</button>
          <button class="btn small" data-act="offer-counter" data-id="${o.id}" type="button">역제안</button>
          <button class="btn small ghost" data-act="offer-reject" data-id="${o.id}" type="button">거절</button>
        </div>
      </li>`;
    }).join('')}</ul>` : '<p class="muted sm">아직 오퍼가 없습니다. 라운드가 진행되면 AI 구단이 우리 선수에게 접근해 옵니다.</p>'}
    <p class="hint">수락하면 이적료가 들어오고 선수가 빠집니다. 역제안으로 더 높은 이적료를 부를 수 있고, 거절하면 당분간 같은 구단의 접근이 줄어듭니다.</p>
  </article>`;
}

const FEED_ICON = { ai: '🔁', in: '🟢', out: '🔴', offer: '📨', reject: '✋', 'loan-in': '🤝', 'counter-no': '💬' };

function transferFeed(w) {
  const list = (w.transfers || []).slice(0, 12);
  return `<article class="card">
    <div class="card-head"><h3>이적 소식</h3><span class="pill">최근 ${list.length}건</span></div>
    <ul class="tfeed">${list.map((t) => `<li class="tf-${esc(t.type)}"><span class="tf-ic" aria-hidden="true">${FEED_ICON[t.type] || '•'}</span><span class="tf-t">${esc(t.text)}</span><span class="muted xs">${t.s}시즌</span></li>`).join('') || '<li class="muted sm">아직 이적 소식이 없습니다. 라운드를 진행하면 AI 구단끼리 선수를 사고팝니다.</li>'}</ul>
  </article>`;
}

function marketTab(app, w) {
  const me = W.myTeam(w);
  const wage = W.teamWageTotal(w, w.myTeamId);
  const kl = W.isKL(w);
  const myDiv = W.divOf(w, w.myTeamId);
  const divFilter = Number(app.state.marketDiv) || 0;
  const posFilter = app.state.posFilter || 'ALL';
  const key = app.state.sortKey || 'ovr';
  const dir = app.state.sortDir === 1 ? 1 : -1;
  const entries = w.market.filter((e) => {
    const p = w.players[e.pid];
    if (!p) return false;
    if (posFilter !== 'ALL' && p.pos !== posFilter) return false;
    if (kl && divFilter && e.from && W.divOf(w, e.from) !== divFilter) return false;
    return true;
  }).sort((a, b) => {
    const pa = w.players[a.pid], pb = w.players[b.pid];
    let d = key === 'age' ? pa.age - pb.age : key === 'value' ? pa.value - pb.value : pa.ovr - pb.ovr;
    return d * dir;
  });
  const rows = entries.map((e) => {
    const p = w.players[e.pid];
    const from = e.from ? w.teams[e.from] : null;
    const c = W.canSign(w, e);
    const price = e.loan ? `임대 ${won(e.fee ?? 0)}` : e.price ? won(e.price) : '무료';
    const acts = e.loan
      ? `<button type="button" class="btn small" data-act="loan" data-pid="${p.id}" title="시즌 임대 — 시즌이 끝나면 원소속으로 돌아갑니다">임대</button>`
      : e.from
        ? `<span class="act-pair"><button type="button" class="btn small ${c.ok ? 'primary' : ''}" data-act="sign" data-pid="${p.id}" ${c.ok ? '' : `disabled title="${esc(c.why)}"`}>영입</button><button type="button" class="btn small" data-act="negotiate" data-pid="${p.id}">협상</button></span>`
        : `<button type="button" class="btn small ${c.ok ? 'primary' : ''}" data-act="sign" data-pid="${p.id}" ${c.ok ? '' : `disabled title="${esc(c.why)}"`}>FA 영입</button>`;
    return `<tr class="${e.loan ? 'loan' : ''}" data-fname="${esc(p.name)} ${p.pos}">
      <td><button type="button" class="linkname" data-act="player-modal" data-pid="${p.id}" data-team="${e.from || ''}"><b>${esc(p.name)}</b></button><small class="pos">${p.pos}</small></td>
      <td>${from ? teamLine(w, from.id) : '<span class="pill free">자유계약</span>'}${e.loan ? ' <span class="pill xs">임대</span>' : ''}</td>
      <td>${p.age}</td><td><b>${p.ovr}</b></td><td>${potOf(p)}</td>
      <td>${won(p.value)}</td><td><b>${price}</b></td>
      <td>${W.fmt(p.wage)}만</td>
      <td>${acts}</td>
    </tr>`;
  }).join('');
  const mine = W.squadOf(w, w.myTeamId).sort((a, b) => b.value - a.value).map((p) => `<tr>
      <td><b>${esc(p.name)}</b><small class="pos">${p.pos}</small>${p.loan ? ' <span class="pill xs">임대</span>' : ''}</td>
      <td>${p.age}</td><td>${p.ovr}</td><td>${potOf(p)}</td><td>${won(p.value)}</td><td>${W.fmt(p.wage)}만</td>
      <td>${p.loan ? '<span class="muted xs">임대 중</span>' : won(Math.round(p.value * 0.9 * 10) / 10)}</td>
      <td>${p.loan ? '' : `<button type="button" class="btn small danger" data-act="sell" data-pid="${p.id}">방출</button>`}</td>
    </tr>`).join('');
  const overWage = wage > me.wage;
  const divChips = kl ? `<span class="seg" role="group" aria-label="디비전">${[[0, '전체'], [1, 'K1'], [2, 'K2'], [3, 'K3'], [4, 'K4']].map(([d, l]) => `<button type="button" class="${divFilter === d ? 'on' : ''} ${d ? `k${d}` : ''}" data-act="market-div" data-div="${d}" aria-pressed="${divFilter === d}">${l}</button>`).join('')}</span>` : '';
  return `${offersCard(w)}
  <article class="card">
    <div class="card-head"><h3>이적 시장</h3><span class="pill">${esc(W.seasonLabel(w))} · 라운드마다 갱신</span></div>
    <div class="money-row">
      <div><small>이적 자금</small><b>${won(me.budget)}</b></div>
      <div><small>주급 사용</small><b>${W.fmt(wage)}<span class="unit"> / ${W.fmt(me.wage)}만</span></b></div>
      <div><small>선수단</small><b>${me.squad.length}<span class="unit"> / 24명</span></b></div>
      <div><small>이번 시즌 지출</small><b>${won(w.finance.spent)}</b></div>
      ${kl ? `<div><small>내 디비전</small><b>${esc(W.divName(w, myDiv))}</b></div>` : ''}
    </div>
    ${overWage ? '<p class="warn-bar">주급 예산을 초과했습니다. 선수를 방출해 공간을 만든 뒤 영입할 수 있습니다.</p>' : ''}
    <div class="filter-bar">${divChips}
      <span class="seg" role="group" aria-label="정렬">${[['ovr', '종합'], ['age', '나이'], ['value', '몸값']].map(([k, l]) => `<button type="button" class="${key === k ? 'on' : ''}" data-act="sort" data-key="${k}" aria-pressed="${key === k}">${l}${key === k ? (dir === 1 ? '↑' : '↓') : ''}</button>`).join('')}</span>
      <input class="search" type="search" placeholder="선수 이름 검색" data-filter-input aria-label="이적 시장 검색" />
    </div>
    <div class="table-wrap"><table class="tbl market buy">
      <thead><tr><th>선수</th><th>소속</th><th>나이</th><th>종합</th><th>잠재</th><th>몸값</th><th>이적료</th><th>주급</th><th></th></tr></thead>
      <tbody>${rows || '<tr><td colspan="9" class="muted">조건에 맞는 선수가 없습니다.</td></tr>'}</tbody>
    </table></div>
    <p class="hint"><b>영입</b>은 요청가 그대로, <b>협상</b>은 낮은 금액을 불러 흥정합니다(상대가 받아들일 최저선이 있습니다). <b>FA</b>는 이적료 없이, <b>임대</b>는 임대료만 내고 시즌이 끝나면 원소속으로 돌아갑니다. 주급 예산을 넘으면 영입할 수 없습니다.${kl ? ' 소속 구단을 누르면 그 구단 선수단 전체를 볼 수 있습니다.' : ''}</p>
  </article>
  ${transferFeed(w)}
  <article class="card">
    <div class="card-head"><h3>방출 가능한 선수</h3><span class="pill">몸값의 90% 회수</span></div>
    <div class="table-wrap"><table class="tbl market sell">
      <thead><tr><th>선수</th><th>나이</th><th>종합</th><th>잠재</th><th>몸값</th><th>주급</th><th>예상 이적료</th><th></th></tr></thead>
      <tbody>${mine}</tbody>
    </table></div>
  </article>`;
}

/* ── 순위/기록 탭 ── */
const ZONE = {
  1: { top: 1, up: 0, down: 2, po: 1 },
  2: { top: 1, up: 2, down: 2, po: 2 },
  3: { top: 1, up: 2, down: 2, po: 2 },
  4: { top: 1, up: 2, down: 0, po: 0 },
};

function cupBracket(w) {
  const count = W.cupStageCount(w);
  const names = W.cupNamesOf(w);
  const list = Array.from({ length: count }, (_, i) => w.cup.stages[i] || { name: names[i], matches: [] });
  const active = list.findIndex((s) => s.matches.some((m) => !m.played));
  return list.map((s, i) => {
    const ms = s.matches || [];
    const done = ms.filter((m) => m.played).length;
    const cur = active < 0 ? count - 1 : active;
    const open = i === count - 1 || (i === cur && ms.length <= 8);
    const rd = w.calendar.find((r) => r.type === 'cup' && r.stage === i);
    const rows = ms.map((m) => {
      const winnerSide = m.played ? (m.winner === m.home ? 'h' : 'a') : '';
      const mine = m.home === w.myTeamId || m.away === w.myTeamId;
      const click = m.played && rd ? ` class="cup-match ${mine ? 'mine' : ''} clickable" data-act="match" data-round="${rd.no}" data-home="${m.home}" data-away="${m.away}" tabindex="0"` : ` class="cup-match ${mine ? 'mine' : ''}"`;
      return `<li${click}>
        <span class="cm-team ${winnerSide === 'h' ? 'win' : ''}">${esc(w.teams[m.home]?.short || '?')}</span>
        <span class="cm-score">${m.played ? `${m.hg}<i>:</i>${m.ag}` : 'vs'}</span>
        <span class="cm-team ${winnerSide === 'a' ? 'win' : ''}">${esc(w.teams[m.away]?.short || '?')}</span>
        ${m.aet ? '<small class="aet">연장</small>' : ''}
      </li>`;
    }).join('');
    return `<details class="cup-stage" ${open ? 'open' : ''}>
      <summary>${esc(s.name)}<span class="cup-n">${ms.length ? `${done}/${ms.length}경기` : '대진 미정'}</span></summary>
      <ul>${rows || '<li class="cup-match ghost"><span class="cm-team">대진 미정</span></li>'}</ul>
    </details>`;
  }).join('');
}

function recordsTab(app, w) {
  const kl = W.isKL(w);
  const myDiv = W.divOf(w, w.myTeamId);
  const divs = kl ? W.divisionsOf(w) : [{ id: 1, name: '리그', teams: Object.keys(w.teams) }];
  const cur = kl ? (Number(app.state.divTab) || myDiv) : 1;
  const table = W.standingsFor(w, kl ? cur : null);
  const zone = ZONE[cur] || { top: 1, up: 0, down: 0, po: 0 };
  const n = table.length;
  const rows = table.map((r) => {
    const t = w.teams[r.id];
    const chips = [];
    if (kl) {
      const done = w.calendar.filter((rd) => rd.type === 'league' && rd.div === cur).every((rd) => rd.played);
      if (r.rank === 1) {
        if (cur > 1) chips.push('<span class="zchip up">승격</span>');
        chips.push(`<span class="zchip champ">${done ? '우승' : '선두'}</span>`);
      }
      if (cur > 1 && r.rank === 2) chips.push('<span class="zchip po">승강 PO</span>');
      if (cur < 4 && n > 2 && r.rank === n) chips.push('<span class="zchip down">강등</span>');
      if (cur < 4 && n > 2 && r.rank === n - 1) chips.push('<span class="zchip po">승강 PO</span>');
    }
    return `<tr class="${r.id === w.myTeamId ? 'on' : ''}">
      <td class="rank ${r.rank <= 3 ? 'top' : r.rank >= n - 1 ? 'low' : ''}">${r.rank}</td>
      <td>${teamLine(w, r.id)}${chips.join('')}</td>
      <td>${r.play}</td><td>${r.win}</td><td>${r.draw}</td><td>${r.loss}</td>
      <td>${r.gf}</td><td>${r.ga}</td><td>${r.gd > 0 ? '+' + r.gd : r.gd}</td><td><b>${r.pts}</b></td>
      <td>${formChips(r.form)}</td>
    </tr>`;
  }).join('');

  const divTabs = kl ? `<div class="div-tabs inline" role="group" aria-label="디비전 순위표">
    ${divs.map((d) => `<button type="button" class="div-tab k${d.id} ${d.id === cur ? 'on' : ''}" data-act="divtab" data-div="${d.id}" aria-pressed="${d.id === cur}">
      <b>${esc(d.name)}</b><small>${d.table ? d.table.length : d.teams.length}팀${d.id === myDiv ? ' · 내 리그' : ''}</small></button>`).join('')}
  </div>` : '';

  const board = (kind, title) => {
    const list = W.leaders(w, kind, 5);
    return `<article class="card lb">
      <h3>${title}</h3>
      <ol>${list.map((x, i) => `<li><span class="lb-rank">${i + 1}</span><span class="lb-name">${esc(x.p.name)}<small>${esc(w.teams[x.p.teamId]?.short || '')} · ${x.p.pos}</small></span><b>${x.value}</b></li>`).join('') || '<li class="muted sm">기록 없음</li>'}</ol>
    </article>`;
  };

  return `${divTabs}
  <div class="grid2">
    <article class="card">
      <div class="card-head"><h3>${esc(kl ? W.divName(w, cur) : '리그')} 순위표</h3><span class="pill">${esc(W.seasonLabel(w))} · ${table.length}팀</span></div>
      <div class="table-wrap"><table class="tbl standings">
        <thead><tr><th>순위</th><th>팀</th><th>경기</th><th>승</th><th>무</th><th>패</th><th>득</th><th>실</th><th>득실</th><th>승점</th><th>최근</th></tr></thead>
        <tbody>${rows}</tbody>
      </table></div>
      <p class="hint">${kl
        ? `<b>${esc(W.divName(w, cur))}</b> · 각 경계(1↔2부, 2↔3부, 3↔4부)에서 꼴찌↔1위가 맞교대하고, 2번째끼리 승강 플레이오프를 치릅니다. ${cur < 4 ? '상위 디비전으로 올라가면 예산·주급 상한·스폰서가 커집니다.' : '위로 올라가는 것이 이 게임의 목표입니다.'}`
        : '1위 우승 · 9~10위는 다음 시즌을 다시 준비합니다. 컵대회는 별도 토너먼트입니다.'}</p>
    </article>
    <article class="card">
      <div class="card-head"><h3>${kl ? '코리아컵' : '컵대회'} 대진</h3><span class="pill">${kl ? `56팀 · ${W.cupStageCount(w)}단계` : '10팀 토너먼트'}</span></div>
      <div class="bracket">${cupBracket(w)}</div>
    </article>
  </div>
  <div class="grid3">${board('goals', '⚽ 득점왕')}${board('assists', '🅰️ 도움왕')}${board('rating', '⭐ 평점 리더')}</div>
  <article class="card">
    <div class="card-head"><h3>구단 소식</h3><span class="pill">최근</span></div>
    <ul class="news">${w.news.slice(0, 8).map((n2) => `<li><span class="pill xs">${n2.year || n2.season}시즌</span>${esc(n2.text)}</li>`).join('') || '<li class="muted sm">소식이 없습니다.</li>'}</ul>
  </article>`;
}

/* ── 시즌 결산 ── */
function promoRows(w, moves, done) {
  return moves.map((m) => {
    const mine = (id) => id === w.myTeamId;
    if (m.kind === 'direct') {
      return `<li class="${mine(m.up) || mine(m.down) ? 'on' : ''}"><span class="pill xs">맞교대</span>
        <b>${esc(w.teams[m.up]?.short || m.upName || '?')}</b> <span class="up">▲</span>
        <span class="muted">/</span>
        <b>${esc(w.teams[m.down]?.short || m.downName || '?')}</b> <span class="down">▼</span></li>`;
    }
    const winId = done ? m.winner : m.winner;
    const loseId = done ? m.loser : (m.winner === m.upper ? m.lower : m.upper);
    return `<li class="${mine(m.upper) || mine(m.lower) ? 'on' : ''}"><span class="pill xs">승강 PO</span>
      <b>${esc(w.teams[m.upper]?.short || '?')}</b> vs <b>${esc(w.teams[m.lower]?.short || '?')}</b>
      <span class="muted xs">${done ? `→ ${esc(w.teams[winId]?.short || '')} 승리` : '단판 · 상위 리그 홈'}</span></li>`;
  }).join('');
}

export function renderSeason(app) {
  const w = app.world;
  const r = app.state.seasonResult;
  const s = r.summary;
  const my = s.table.find((x) => x.id === w.myTeamId);
  const done = app.state.seasonPhase === 'done';
  const kl = W.isKL(w);
  const myDiv = s.myDiv || 1;
  const label = kl ? W.divName(w, myDiv) : '리그';
  const myTeamNow = w.teams[w.myTeamId];
  const nextDiv = kl ? W.divOf(w, w.myTeamId) : 1;
  const moved = kl && done && nextDiv !== myDiv;
  const moves = done ? (r.promo || []) : (s.moves || []);
  return `<section class="season">
    <span class="eyebrow">${esc(r.seasonLabel || r.label || (kl ? W.seasonLabel(w) : `${r.season || w.season}시즌`))} 결산 · ${esc(label)}</span>
    <h1>${s.myRank === 1 ? '🏆 리그 우승!' : `${s.myRank}위로 시즌 마감`}${moved ? ` <span class="move-tag ${nextDiv < myDiv ? 'up' : 'down'}">${nextDiv < myDiv ? '승격' : '강등'}</span>` : ''}</h1>
    <p class="hero-desc">${esc(myTeamNow.name)} · 승점 ${my?.pts ?? 0} · ${my?.win ?? 0}승 ${my?.draw ?? 0}무 ${my?.loss ?? 0}패 (${my?.gf ?? 0}-${my?.ga ?? 0})</p>
    <div class="season-grid">
      <article class="card"><div class="card-head"><h3>${esc(label)} 최종 순위</h3><span class="pill">${kl ? `${esc(W.divName(w, myDiv))} 우승 ${s.champion ? esc(w.teams[s.champion].short) : '—'}` : `리그 우승 ${s.champion ? esc(w.teams[s.champion].short) : '—'}`}</span></div>
        <ol class="final-table">${s.table.map((x) => `<li class="${x.id === w.myTeamId ? 'on' : ''}"><span>${x.rank}</span>${teamLine(w, x.id)}<b>${x.pts}</b><small>${x.gf}:${x.ga}</small></li>`).join('')}</ol>
      </article>
      <article class="card"><h3>${kl ? '코리아컵' : '컵대회'}</h3>
        <p class="cup-result">${s.cupWinner ? `${teamLine(w, s.cupWinner)} <b>우승</b>` : '결승 미완료'}</p>
        <p class="sm">${esc(myTeamNow.short)} — ${esc(s.cupOut)}</p>
        <h3 class="sub">재정</h3>
        <div class="money-row">
          ${done ? `<div><small>리그 상금</small><b>${won(r.prize - r.cupPrize - (r.sponsor || 0))}</b></div>
          <div><small>컵 상금</small><b>${won(r.cupPrize)}</b></div>
          ${r.sponsor ? `<div><small>스폰서</small><b>${won(r.sponsor)}</b></div>` : ''}` : '<div><small>상금</small><b>다음 시즌 시작 시 정산</b></div>'}
          <div><small>현재 이적 자금</small><b>${won(myTeamNow.budget)}</b></div>
        </div>
      </article>
    </div>
    ${kl ? `<article class="card">
      <div class="card-head"><h3>${kl ? '승격 · 강등' : ''}</h3><span class="pill">${done ? '확정' : '예상'} · 1↔2↔3↔4부</span></div>
      <ul class="promo-list">${promoRows(w, moves, done) || '<li class="muted sm">아직 결정된 이동이 없습니다.</li>'}</ul>
      ${done ? `<p class="hint">다음 시즌 ${esc(W.divName(w, nextDiv))}에서 시작합니다. 승격하면 예산·주급 상한·스폰서 수입이 함께 커집니다.</p>` : '<p class="hint">다음 시즌을 시작하면 승격·강등이 확정되고 예산·주급 상한이 새 디비전 기준으로 다시 잡힙니다.</p>'}
    </article>` : ''}
    ${s.divs?.length ? `<article class="card"><div class="card-head"><h3>디비전별 최종 순위</h3><span class="pill">${esc(r.seasonLabel || r.label || W.seasonLabel(w))}</span></div>
      <div class="div-finals">${s.divs.map((d) => `<div class="df-col"><h4>${esc(d.name)}</h4><ol>${d.table.slice(0, 6).map((x) => `<li class="${x.id === w.myTeamId ? 'on' : ''}"><span>${x.rank}</span>${teamLine(w, x.id)}<b>${x.pts}</b></li>`).join('')}</ol></div>`).join('')}</div>
    </article>` : ''}
    ${done ? `<article class="card"><h3>선수 성장 · 노쇠</h3>
      <ul class="growth">${r.growth.map((g) => `<li>${teamLine(w, g.teamId)}<span>${esc(g.name)}</span><b class="${g.to >= g.from ? 'up' : 'down'}">${g.from} → ${g.to}</b></li>`).join('') || '<li class="muted sm">큰 변화가 없습니다.</li>'}</ul>
      ${r.retired?.length ? `<p class="hint">은퇴·방출: ${r.retired.slice(0, 12).map(esc).join(', ')}${r.retired.length > 12 ? ` 외 ${r.retired.length - 12}명` : ''}</p>` : ''}
    </article>` : '<p class="hint">다음 시즌을 시작하면 상금 정산과 함께 선수들이 한 살씩 먹고 성장·노쇠합니다.</p>'}
    <div class="actions center"><button class="btn primary big" data-act="${done ? 'close-season' : 'next-season'}" type="button">${done ? '새 시즌 시작 →' : '다음 시즌 시작 →'}</button></div>
  </section>`;
}


/* ── 경기 요약 모달 ────────────────────────────────────────────
   이미 치른 경기를 누르면 그날의 스코어·득점자·주요 기록·평점을 다시 보여 줍니다.
   기록은 history.js 의 경량 요약(내 경기·AI 경기 모두)을 읽고, 그 이전 세이브는
   경기 이벤트(득점자 ID)만으로 최소한의 장면을 보여 줍니다. */
function matchSummaryModal(app, m) {
  const w = app.world;
  if (!w) return '';
  const round = w.calendar.find((r) => r.no === Number(m.round));
  if (!round) return '';
  const list = round.type === 'league' ? round.fixtures : (w.cup.stages[round.stage]?.matches || []);
  const f = list.find((x) => x.home === m.home && x.away === m.away);
  if (!f || !f.played) return '';
  const home = w.teams[m.home], away = w.teams[m.away];
  if (!home || !away) return '';
  const entry = getEntry(w, round, m.home, m.away);
  const mine = f.home === w.myTeamId || f.away === w.myTeamId;

  // 골 장면 — 요약 → (없으면) 예전 세이브의 경기 이벤트
  let goals = (entry?.g || []).slice();
  if (!goals.length && Array.isArray(f.events)) {
    goals = f.events.filter((e) => e.type === 'goal').map((e) => [
      Math.max(1, Math.round(e.minute || 1)),
      e.teamId === m.home ? 'h' : 'a',
      w.players[e.scorerId]?.name || '',
      w.players[e.assistId]?.name || '',
    ]);
  }
  const goalRows = goals.slice().sort((a, b) => a[0] - b[0]).map((g) => {
    const side = g[1] === 'a' ? 'away' : 'home';
    const team = side === 'home' ? home : away;
    return `<li class="goal-${side}"><span class="gm-min">${g[0]}'</span>${badge(team)}<span class="gm-name">${esc(g[2] || '득점')}</span>${g[3] ? `<small class="gm-assist">도움 ${esc(g[3])}</small>` : ''}</li>`;
  }).join('');

  const st = entry?.s ? { home: unpackStats(entry.s.h), away: unpackStats(entry.s.a) } : null;
  const statRows = st ? STAT_FIELDS.map((k) => {
    const h = st.home[k], a = st.away[k];
    if (!h && !a) return '';
    const val = (v) => (k === 'poss' ? `${v}%` : k === 'xg' ? Number(v).toFixed(2) : String(v));
    return `<tr><td class="sv ${h >= a ? 'lead' : ''}">${val(h)}</td><th>${STAT_LABELS[k]}</th><td class="sv ${a > h ? 'lead' : ''}">${val(a)}</td></tr>`;
  }).join('') : '';

  const ratings = (arr) => (Array.isArray(arr) && arr.length
    ? `<ul class="mrlist">${arr.map(([num, name, pos, rating, g, a2]) => `<li><span class="rn">${num}</span><span class="rname">${esc(name)}</span><span class="pos">${esc(pos)}</span>${g ? `<i class="g" title="득점">⚽${g > 1 ? g : ''}</i>` : ''}${a2 ? `<i class="a" title="도움">🅰${a2 > 1 ? a2 : ''}</i>` : ''}<b class="${rating >= 7.5 ? 'hi' : rating < 6 ? 'lo' : ''}">${Number(rating).toFixed(1)}</b></li>`).join('')}</ul>`
    : '<p class="muted sm">이 경기의 선수 평점은 남아 있지 않습니다.</p>');

  const scoreLine = `${f.hg} : ${f.ag}`;
  const extras = [];
  if (f.aet) extras.push('연장');
  if (f.pens) extras.push(`승부차기 ${esc(f.pens)}`);
  const back = m.back;

  return `<div class="modal-back" data-act="modal-close"><div class="modal wide match-modal" role="dialog" aria-modal="true" aria-labelledby="m-title">
    <div class="modal-head">
      <div><h3 id="m-title">${esc(home.name)} <span class="muted">vs</span> ${esc(away.name)}</h3>
        <p class="sm">${esc(compLabel(w, round))}${mine ? ' · 내 경기' : ''}${extras.length ? ` · ${extras.join(' · ')}` : ''}</p></div>
      <button class="btn small ghost modal-x" data-act="modal-close" type="button">닫기</button>
    </div>
    <div class="mres">
      <div class="mres-side">${badge(home, 'mid')}<b>${esc(home.short)}</b></div>
      <div class="mres-score">${scoreLine}</div>
      <div class="mres-side">${badge(away, 'mid')}<b>${esc(away.short)}</b></div>
    </div>
    <h4 class="sub">득점 장면</h4>
    ${goalRows ? `<ul class="mgoals">${goalRows}</ul>` : '<p class="muted sm">득점 없이 끝난 경기입니다.</p>'}
    ${statRows ? `<h4 class="sub">주요 기록</h4>
      <div class="mstat-head"><b>${esc(home.short)}</b><span></span><b>${esc(away.short)}</b></div>
      <table class="tbl stat-rows">${statRows}</table>` : ''}
    ${entry ? '' : '<p class="warn-bar">이 경기는 스코어만 저장되어 있습니다 (기록 로그가 생기기 전의 경기).</p>'}
    ${entry?.rt ? `<h4 class="sub">출전 선수 평점</h4>
      <div class="mm-ratings"><div class="mm-col"><h5>${esc(home.short)}</h5>${ratings(entry.rt.h)}</div><div class="mm-col"><h5>${esc(away.short)}</h5>${ratings(entry.rt.a)}</div></div>` : ''}
    ${entry?.quick ? '<p class="hint">빠른 시뮬레이션으로 처리된 경기입니다. 스코어·득점자와 큰 흐름(점유율·슈팅·카드)만 기록합니다.</p>' : ''}
    <div class="actions">
      ${back?.kind === 'club' ? `<button class="btn" data-act="club" data-team="${esc(back.team)}" type="button">← ${esc(w.teams[back.team]?.short || '')} 선수단</button>` : ''}
      <button class="btn ghost" data-act="modal-close" type="button">닫기</button>
    </div>
  </div></div>`;
}

/* ── 저장 / 불러오기 모달 ──────────────────────────────────── */
function autosaveBytes(w) {
  if (!w) return 0;
  try { return JSON.stringify({ ...w, savedAt: 0 }).length; } catch { return 0; }
}

function confirmBar(app) {
  const c = app.state.modal?.confirm;
  if (!c) return '';
  const slots = readSlots();
  const s = c.i != null ? slots.list[c.i] : null;
  if (c.op === 'save') {
    return `<div class="confirm-bar">
      <p><b>슬롯 ${c.i + 1}</b>에 지금 커리어를 덮어쓸까요?${s ? ` 기존 세이브(${esc(s.meta.teamName)} · ${esc(s.meta.season)} · ${esc(s.meta.round)})는 사라집니다.` : ''}</p>
      <div class="actions"><button class="btn small danger" data-act="slot-confirm" data-i="${c.i}" data-op="save" type="button">덮어쓰기</button><button class="btn small" data-act="slot-cancel" type="button">취소</button></div>
    </div>`;
  }
  if (c.op === 'load') {
    return `<div class="confirm-bar">
      <p><b>슬롯 ${c.i + 1}</b>(${esc(s?.meta.teamName || '')} · ${esc(s?.meta.season || '')} · ${esc(s?.meta.round || '')})으로 돌아갑니다. <b>지금 진행 중인 커리어는 이 슬롯에 저장하지 않으면 사라집니다.</b></p>
      <div class="actions"><button class="btn small primary" data-act="slot-confirm" data-i="${c.i}" data-op="load" type="button">불러오기</button><button class="btn small" data-act="slot-cancel" type="button">취소</button></div>
    </div>`;
  }
  if (c.op === 'delete') {
    return `<div class="confirm-bar">
      <p><b>슬롯 ${c.i + 1}</b>의 세이브를 지울까요? 되돌릴 수 없습니다.</p>
      <div class="actions"><button class="btn small danger" data-act="slot-confirm" data-i="${c.i}" data-op="delete" type="button">삭제</button><button class="btn small" data-act="slot-cancel" type="button">취소</button></div>
    </div>`;
  }
  if (c.op === 'import') {
    const meta = c.meta || {};
    return `<div class="confirm-bar">
      <p>파일에서 <b>${esc(meta.teamName || '커리어')}</b> · ${esc(meta.season || '')} · ${esc(meta.round || '')} 세이브를 불러옵니다. <b>지금 커리어는 사라집니다.</b></p>
      <div class="actions"><button class="btn small primary" data-act="slot-confirm" data-op="import" type="button">파일 세이브 불러오기</button><button class="btn small" data-act="slot-cancel" type="button">취소</button></div>
    </div>`;
  }
  return '';
}

function savesModal(app) {
  const w = app.world || app.savedGame;
  const slots = readSlots();
  const info = logInfo(w);
  const meta = w ? slotMeta(w) : null;
  const row = (s, i) => (s
    ? `<li class="slot on">
        <div class="sl-main"><b>슬롯 ${i + 1} · ${esc(s.meta?.teamName || '')}</b>
          <small>${esc(s.meta?.div || '')} · ${esc(s.meta?.season || '')} · ${esc(s.meta?.round || '')} · ${Number(s.meta?.played || 0)}경기 진행</small>
          <small class="muted">${esc(whenText(s.at))} 저장 · ${kbText(s.bytes)}</small>
        </div>
        <div class="sl-ops">
          <button class="btn small primary" data-act="slot-load" data-i="${i}" type="button">불러오기</button>
          <button class="btn small" data-act="slot-save" data-i="${i}" type="button">덮어쓰기</button>
          <button class="btn small ghost" data-act="slot-delete" data-i="${i}" type="button">삭제</button>
        </div>
      </li>`
    : `<li class="slot empty">
        <div class="sl-main"><b>슬롯 ${i + 1}</b><small class="muted">비어 있음</small></div>
        <div class="sl-ops"><button class="btn small ${w ? 'primary' : ''}" data-act="slot-save" data-i="${i}" type="button" ${w ? '' : 'disabled'}>여기에 저장</button></div>
      </li>`);

  return `<div class="modal-back" data-act="modal-close"><div class="modal wide saves-modal" role="dialog" aria-modal="true" aria-labelledby="m-title">
    <div class="modal-head">
      <div><h3 id="m-title">저장 / 불러오기</h3>
        <p class="sm">${w && meta ? `${esc(meta.teamName)} · ${esc(meta.div)} · ${esc(meta.season)} · ${esc(meta.round)}` : '아직 커리어가 없습니다. 슬롯이나 파일에서 불러오세요.'}</p></div>
      <button class="btn small ghost modal-x" data-act="modal-close" type="button">닫기</button>
    </div>
    <p class="hint">경기는 행동마다 <b>자동 저장</b>됩니다. 아래 <b>수동 슬롯 ${SLOT_COUNT}개</b>는 지금 시점을 따로 남겨 두었다가 언제든 돌아오는 곳입니다.</p>
    <ul class="slot-list">${slots.list.map((s, i) => row(s, i)).join('')}</ul>
    ${confirmBar(app)}
    <div class="file-row">
      <button class="btn primary" data-act="save-export" type="button" ${w ? '' : 'disabled'}>⬇ JSON 파일로 내보내기</button>
      <button class="btn" data-act="save-import" type="button">⬆ 파일에서 불러오기</button>
      <input type="file" id="save-file" accept=".json,application/json" data-import hidden />
    </div>
    <p class="hint">파일로 내보내면 다른 기기·브라우저에서 그대로 이어서 할 수 있습니다. 저장 용량 — 자동 저장 <b>${kbText(autosaveBytes(w))}</b> · 슬롯 <b>${kbText(slotsBytes())}</b> · 경기 기록 <b>${kbText(info.bytes)}</b> (${info.total}경기)</p>
  </div></div>`;
}

/* ── 프리셋 삭제 확인 ── */
function presetDeleteModal(app, m) {
  const p = readPresets().list.find((x) => x.id === m.id);
  if (!p) return '';
  return `<div class="modal-back" data-act="modal-close"><div class="modal" role="dialog" aria-modal="true" aria-labelledby="m-title">
    <h3 id="m-title">프리셋 '${esc(p.name)}'을 지울까요?</h3>
    <p>${esc(p.formation)} · ${esc(tacticWords(p.tactic || {}))} · ${esc(whenText(p.at))} 저장. 저장한 설정은 사라지고 지금 전술은 그대로입니다.</p>
    <div class="actions"><button class="btn danger" data-act="preset-delete-confirm" data-id="${esc(p.id)}" type="button">프리셋 삭제</button><button class="btn" data-act="modal-close" type="button">취소</button></div>
  </div></div>`;
}

/* ── 타 구단 경기 결과 ─────────────────────────────────────────
   순위표·이적시장·일정에서 연 구단 모달에 그 구단의 이번 시즌 경기 결과를 붙입니다.
   줄을 누르면 같은 경기 요약 모달이 열립니다. */
function clubMatchesBlock(w, teamId) {
  const all = W.teamFixtures(w, teamId);
  const played = all.filter((x) => x.played);
  if (!played.length) return `<h4 class="sub">경기 결과</h4><p class="muted sm">이번 시즌 치른 경기가 없습니다.</p>`;
  const win = played.filter((x) => x.res === 'W').length;
  const draw = played.filter((x) => x.res === 'D').length;
  const loss = played.filter((x) => x.res === 'L').length;
  const row = (x) => `<button type="button" class="mrow" data-act="match" data-round="${x.round.no}" data-home="${x.home}" data-away="${x.away}" data-back="club" data-back-team="${teamId}">
    <i class="f-${x.res}">${resWord(x.res)}</i>
    <span class="mr-comp">${esc(compLabel(w, x.round))}</span>
    <span class="mr-opp">${x.isHome ? '홈' : '원정'} vs ${esc(w.teams[x.oppId]?.short || '?')}</span>
    <b class="mr-score">${x.gf} : ${x.ga}</b>
    <small class="muted xs">기록 ▸</small>
  </button>`;
  const recent = played.slice(-5).reverse();
  return `<h4 class="sub">경기 결과 <span class="muted xs">— ${played.length}경기 ${win}승 ${draw}무 ${loss}패 · 누르면 그 경기 기록</span></h4>
    <div class="club-matches">${recent.map(row).join('')}</div>
    ${played.length > recent.length ? `<details class="club-all"><summary>이번 시즌 경기 결과 ${played.length}경기 모두 보기</summary>${played.slice().reverse().map(row).join('')}</details>` : ''}`;
}

/* ── 확인 모달 ── */
export function renderModal(app) {
  const m = app.state.modal;
  if (!m) return '';
  if (m.kind === 'match') return matchSummaryModal(app, m);
  if (m.kind === 'saves') return savesModal(app);
  if (m.kind === 'preset-delete') return presetDeleteModal(app, m);
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
  if (m.kind === 'offer-counter') {
    const o = (app.world?.offers || []).find((x) => x.id === m.id);
    const p = o ? app.world.players[o.pid] : null;
    const club = o ? app.world.teams[o.from] : null;
    if (!o || !p || !club) return '';
    const opts = [0.1, 0.2, 0.3].map((rate) => {
      const price = Math.round(o.price * (1 + rate) * 10) / 10;
      return `<button class="btn" data-act="offer-counter-send" data-id="${o.id}" data-price="${price}" type="button">${won(price)} <small class="muted">+${Math.round(rate * 100)}%</small></button>`;
    }).join('');
    return `<div class="modal-back" data-act="modal-close"><div class="modal" role="dialog" aria-modal="true" aria-labelledby="m-title">
      <h3 id="m-title">${esc(p.name)} 역제안</h3>
      <p>${esc(club.name)}의 오퍼 <b>${won(o.price)}</b> · 몸값 ${won(p.value)} · 종합 ${p.ovr} · 잠재 ${potOf(p)}</p>
      <p class="sm">부를 금액을 고르세요. 상대 구단이 낼 수 있는 상한을 넘기면 거절하고, 대신 자기들이 낼 수 있는 최대액을 다시 제시합니다.</p>
      <div class="actions">${opts}<button class="btn ghost" data-act="modal-close" type="button">닫기</button></div>
    </div></div>`;
  }
  if (m.kind === 'negotiate') {
    const e = (app.world?.market || []).find((x) => x.pid === m.pid);
    const p = app.world?.players?.[m.pid];
    if (!e || !p) return '';
    const opts = [0, 0.1, 0.2].map((rate) => {
      const price = Math.round(e.price * (1 - rate) * 10) / 10;
      return `<button class="btn" data-act="negotiate-send" data-pid="${p.id}" data-price="${price}" type="button">${won(price)} <small class="muted">${rate ? `-${Math.round(rate * 100)}%` : '요청가'}</small></button>`;
    }).join('');
    return `<div class="modal-back" data-act="modal-close"><div class="modal" role="dialog" aria-modal="true" aria-labelledby="m-title">
      <h3 id="m-title">${esc(p.name)} 가격 협상</h3>
      <p>${esc(app.world.teams[e.from]?.name || '상대 구단')} 요청가 <b>${won(e.price)}</b> · 몸값 ${won(p.value)} · 종합 ${p.ovr} · 잠재 ${potOf(p)}</p>
      <p class="sm">낮은 금액을 부르면 상대가 받아들일지 판단합니다. 거절하면 자기들이 낼 수 있는 최저선으로 다시 제시합니다.</p>
      <div class="actions">${opts}<button class="btn ghost" data-act="modal-close" type="button">닫기</button></div>
    </div></div>`;
  }
  if (m.kind === 'club') {
    const w = app.world;
    const t = w?.teams?.[m.team];
    if (!t) return '';
    const squad = W.squadOf(w, m.team).slice().sort((a, b) => b.ovr - a.ovr);
    const kl = W.isKL(w);
    const table = W.standingsFor(w, kl ? t.div : null);
    const row = table.find((r) => r.id === t.id);
    const rows = squad.map((p) => {
      const st = p.season || {};
      return `<tr class="prow" data-act="player-modal" data-pid="${p.id}" data-team="${t.id}" tabindex="0">
        <td>${p.num}</td>
        <td><b>${esc(p.name)}</b>${p.bans > 0 ? ' <span class="pill xs">정지</span>' : ''}${p.inj > 0 ? ' <span class="pill xs">부상</span>' : ''}${p.loan ? ' <span class="pill xs">임대</span>' : ''}</td>
        <td>${p.pos}</td><td>${p.age}</td><td><b>${p.ovr}</b></td><td>${potOf(p)}</td>
        <td>${st.apps || 0}</td><td>${st.goals || 0}</td><td>${st.assists || 0}</td>
        <td>${st.ratingCount ? (st.ratingSum / st.ratingCount).toFixed(2) : '—'}</td>
      </tr>`;
    }).join('');
    return `<div class="modal-back" data-act="modal-close"><div class="modal wide" role="dialog" aria-modal="true" aria-labelledby="m-title">
      <div class="modal-head">${badge(t, 'mid')}
        <div><h3 id="m-title">${esc(t.name)}</h3><p class="sm">${kl ? `<span class="divtag k${t.div}">${esc(W.divName(w, t.div))}</span> · ` : ''}${esc(t.nick)} · ${esc(t.stadium)}</p></div>
        <button class="btn small ghost modal-x" data-act="modal-close" type="button">닫기</button>
      </div>
      <div class="money-row">
        <div><small>리그 순위</small><b>${row && row.play > 0 ? `${row.rank}위` : '—'}</b></div>
        <div><small>전력</small><b>${W.teamPower(w, t.id)}</b></div>
        <div><small>이적 자금</small><b>${won(t.budget)}</b></div>
        <div><small>주급 합계</small><b>${W.fmt(W.teamWageTotal(w, t.id))}<span class="unit">만/주</span></b></div>
        <div><small>평균 나이</small><b>${squad.length ? (squad.reduce((a, p) => a + p.age, 0) / squad.length).toFixed(1) : '—'}</b></div>
      </div>
      <p class="sm">${esc(t.bio)}</p>
      ${clubMatchesBlock(w, t.id)}
      <h4 class="sub">선수단 ${squad.length}명 <span class="muted xs">— 선수를 누르면 상세 기록이 열립니다</span></h4>
      <div class="table-wrap"><table class="tbl club-squad">
        <thead><tr><th>#</th><th>이름</th><th>포지션</th><th>나이</th><th>종합</th><th>잠재</th><th>출전</th><th>골</th><th>도움</th><th>평점</th></tr></thead>
        <tbody>${rows}</tbody>
      </table></div>
    </div></div>`;
  }
  if (m.kind === 'player') {
    const w = app.world;
    const p = w?.players?.[m.pid];
    if (!p) return '';
    const t = w.teams[m.team || p.teamId];
    return `<div class="modal-back" data-act="modal-close"><div class="modal wide player-modal" role="dialog" aria-modal="true" aria-labelledby="m-title">
      <div class="modal-head">${t ? badge(t, 'mid') : ''}
        <div><h3 id="m-title">${esc(p.name)} <span class="muted">#${p.num}</span></h3>
        <p class="sm">${t ? `${esc(t.name)} · ${esc(W.divName(w, t.div))}` : '자유계약'} · ${p.pos} · ${p.age}세</p></div>
        <button class="btn small ghost modal-x" data-act="modal-close" type="button">닫기</button>
      </div>
      ${playerCard(w, p, { full: true })}
      <div class="actions">
        ${m.back === 'club' && t ? `<button class="btn" data-act="club" data-team="${t.id}" type="button">← ${esc(t.short)} 선수단</button>` : ''}
        <button class="btn ghost" data-act="modal-close" type="button">닫기</button>
      </div>
    </div></div>`;
  }
  if (m.kind === 'team') {
    const t = app.defs[m.team];
    const kl = !!t.div;
    const roster = kl ? (KL_ROSTERS[t.id] || []).slice(0, 6) : [];
    return `<div class="modal-back" data-act="modal-close"><div class="modal wide" role="dialog" aria-modal="true" aria-labelledby="m-title">
      <div class="modal-head">${badge(t, 'mid')}<div><h3 id="m-title">${esc(t.name)}</h3><p class="sm">${kl ? `<span class="divtag k${t.div}">${esc(W.divName({ divisions: KL_DIVISIONS }, t.div))}</span> · ` : ''}${esc(t.nick)} · ${esc(t.stadium)} (${W.fmtWon(t.capacity)}석)</p></div></div>
      <p>${esc(t.bio)}</p>
      <div class="money-row">
        ${kl ? '' : `<div><small>이적 자금</small><b>${won(t.budget)}</b></div>
        <div><small>주급 예산</small><b>${W.fmt(t.wage)}만/주</b></div>`}
        <div><small>전력</small><b>${t.power}</b></div>
        <div><small>포메이션</small><b>${esc(t.formation)}</b></div>
        ${kl ? `<div><small>홈구장</small><b>${esc(t.stadium)}</b></div>` : ''}
      </div>
      <p class="sm"><b>주 전술</b> ${esc(tacticWords(t.tactic))}</p>
      ${roster.length ? `<h4 class="sub">주요 선수</h4><ul class="roster-preview">${roster.map(([name, pos, age, num, ovr]) => `<li><span class="rn">${num || '—'}</span><b>${esc(name)}</b><small>${pos} · ${age ? age + '세' : '나이 미상'} · 종합 <b>${ovr}</b></small></li>`).join('')}</ul>` : ''}
      <div class="actions"><button class="btn primary" data-act="team-sign" data-team="${t.id}" type="button">이 구단으로 시작</button><button class="btn" data-act="modal-close" type="button">다른 구단 보기</button></div>
    </div></div>`;
  }
  return '';
}
