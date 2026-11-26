// 커스텀 매치업 화면 — 팀 빌더 · 공유 · 경기 준비 · 결과 요약
// 상태는 app.state.custom / app.state.matchup 에 있습니다 (app.js 가 관리).
import { FORMATIONS, formationsFor, STAT_KEYS, STAT_LABEL, sizeOfFormation } from './data.js';
import { MENTALITY, mentalityOf, mentalityEffect, AXES, STEPS, stepLabel, roleLabel, roleShort, nextRole, rolesForLabel } from './tactics.js';
import { KL_TEAMS, KL_DIVISIONS } from './kleague2026.js';
import { esc } from './views.js';
import {
  FORMATS, formatName, formatOf, readTeams, getTeam, teamShort, teamPowerOf, ovrOf, teamSlotPos,
  slotLabelsOf, teamLink, matchLink, matchSummary,
} from './custom.js';

const TABS = [
  { id: 'build', label: '🛠 팀 만들기' },
  { id: 'match', label: '⚔ 매치업' },
  { id: 'share', label: '🔗 공유·불러오기' },
];

export function renderCustom(app) {
  const st = app.state.custom;
  const db = readTeams();
  const team = st.team || db.list.find((t) => t.id === st.teamId) || db.list[0] || null;
  const tab = st.tab || 'build';
  const head = `
  <section class="cm-head">
    <div>
      <span class="eyebrow">CUSTOM MATCHUP</span>
      <h1>커스텀 <span class="hl">매치업</span></h1>
      <p class="sm">내가 만든 팀으로 친구 팀과, 또는 K리그 구단과 한 판. 11인제 · 5·6인제 풋살까지.</p>
    </div>
    <div class="cm-head-stats">
      <div><small>내 팀</small><b>${db.list.length}개</b></div>
      <div><small>고른 규모</small><b>${team ? formatName(team.size) : '—'}</b></div>
    </div>
  </section>
  <nav class="cm-tabs" role="tablist" aria-label="커스텀 매치업 메뉴">
    ${TABS.map((t) => `<button type="button" role="tab" aria-selected="${tab === t.id}" class="cm-tab ${tab === t.id ? 'on' : ''}" data-act="cm-tab" data-tab="${t.id}">${t.label}</button>`).join('')}
  </nav>
  ${st.msg ? `<p class="cm-msg" role="status">${esc(st.msg)}</p>` : ''}`;
  if (!db.list.length && tab !== 'share') {
    return `${head}<section class="card cm-empty">
      <h3>아직 만든 팀이 없습니다</h3>
      <p class="sm">이름·색·포메이션을 정하고 선수 11명(또는 5·6명)을 채우면 끝입니다. 빈 자리는 버튼 한 번으로 채울 수 있어요.</p>
      <div class="actions"><button class="btn primary" data-act="cm-new" type="button">＋ 새 팀 만들기</button></div>
    </section>`;
  }
  const body = tab === 'match' ? matchupPanel(app, team) : tab === 'share' ? sharePanel(app, team) : buildPanel(app, team);
  return `${head}${body}`;
}

/* ─────────────────────────── 팀 빌더 ─────────────────────────── */
function teamPicker(app, team) {
  const list = readTeams().list;
  return `<div class="cm-picker">
    <label class="cm-lab" for="cm-team-pick">팀 고르기</label>
    <select id="cm-team-pick" class="inp" data-cm="pick">
      ${list.map((t) => `<option value="${t.id}" ${team && t.id === team.id ? 'selected' : ''}>${esc(t.name)} · ${formatName(t.size)}${t.code ? ` · ${t.code}` : ''}</option>`).join('')}
    </select>
    <button class="btn small" data-act="cm-new" type="button">＋ 새 팀</button>
    ${team ? `<button class="btn small ghost" data-act="cm-duplicate" type="button">복제</button>
    <button class="btn small ghost" data-act="cm-delete" data-id="${team.id}" type="button">삭제</button>` : ''}
  </div>`;
}

function slotOptions(team, current) {
  return slotLabelsOf(team.formation).map((l) => `<option value="${l}" ${l === current ? 'selected' : ''}>${l}</option>`).join('');
}

function playerRow(team, p, i) {
  const ovr = ovrOf(team, p);
  const stats = p.stats || null;
  return `<li class="cp-row" data-i="${i}">
    <div class="cp-main">
      <span class="cp-num">${i + 1}</span>
      <select class="inp cp-slot" data-cp="slot" data-i="${i}" aria-label="${i + 1}번째 선수 포지션">${slotOptions(team, p.slot)}</select>
      <input class="inp cp-name" data-cp="name" data-i="${i}" value="${esc(p.name)}" placeholder="선수 이름" maxlength="16" aria-label="${i + 1}번째 선수 이름">
      <label class="cp-ovr"><span>OVR</span>
        <input class="inp" type="number" inputmode="numeric" min="25" max="97" step="1" data-cp="ovr" data-i="${i}" value="${ovr || 60}" aria-label="${i + 1}번째 선수 종합">
      </label>
      <span class="cp-ovr-val ${ovr >= 80 ? 'hi' : ovr && ovr < 60 ? 'lo' : ''}" title="포지션·능력치로 계산한 종합">${ovr || '—'}</span>
    </div>
    <details class="cp-detail">
      <summary>세부 능력치${stats ? '' : ' <span class="muted xs">— OVR을 넣으면 자동으로 깔립니다</span>'}</summary>
      <div class="cp-stats">
        ${STAT_KEYS.map((k) => `<label><span>${STAT_LABEL[k]}</span>
          <input class="inp" type="number" inputmode="numeric" min="25" max="99" step="1" data-cp="stat" data-key="${k}" data-i="${i}" value="${stats ? stats[k] : ''}" placeholder="-" aria-label="${i + 1}번째 선수 ${STAT_LABEL[k]}"></label>`).join('')}
        <label><span>나이</span><input class="inp" type="number" inputmode="numeric" min="15" max="45" step="1" data-cp="age" data-i="${i}" value="${p.age}" aria-label="${i + 1}번째 선수 나이"></label>
        <label><span>포지션</span><input class="inp" type="text" value="${esc(p.slot)} · ${esc(teamSlotPos(team, p.slot))}" readonly aria-label="포지션 분류"></label>
      </div>
    </details>
  </li>`;
}

function buildPanel(app, team) {
  if (!team) return '';
  const filled = team.players.filter((p) => p.name).length;
  const power = teamPowerOf(team);
  return `<div class="cm-grid">
    <section class="card cm-form">
      ${teamPicker(app, team)}
      <label class="cm-field"><span>팀 이름</span>
        <input class="inp" data-cm="name" value="${esc(team.name)}" maxlength="24" placeholder="예: 별무리 풋살단">
      </label>
      <label class="cm-field"><span>약칭 (2~3자)</span>
        <input class="inp" data-cm="short" value="${esc(team.short)}" maxlength="5" placeholder="${esc(teamShort(team))}">
      </label>
      <div class="cm-field"><span>경기 규모</span>
        <div class="seg-wrap" role="group" aria-label="경기 규모">
          ${FORMATS.map((f) => `<button type="button" class="btn small ${team.size === f.size ? 'on' : ''}" data-act="cm-size" data-size="${f.size}" aria-pressed="${team.size === f.size}">${f.name}</button>`).join('')}
        </div>
        <p class="hint">${esc(formatOf(team.size).note)}</p>
      </div>
      <div class="cm-field"><span>포메이션</span>
        <div class="seg-wrap" role="group" aria-label="포메이션">
          ${formationsFor(team.size).map((f) => `<button type="button" class="btn small ${team.formation === f ? 'on' : ''}" data-act="cm-formation" data-formation="${f}" aria-pressed="${team.formation === f}" title="${esc(FORMATIONS[f].shape)}">${f}</button>`).join('')}
        </div>
      </div>
      <div class="cm-field"><span>팀 색</span>
        <div class="cm-colors">
          <label>메인 <input type="color" data-cm="primary" value="${esc(team.colors.primary)}" aria-label="팀 메인 색"></label>
          <label>보조 <input type="color" data-cm="secondary" value="${esc(team.colors.secondary)}" aria-label="팀 보조 색"></label>
          <span class="badge cm-badge" data-team="${team.id}">${esc(teamShort(team))}</span>
        </div>
      </div>
      <div class="cm-summary">
        <div><small>선수</small><b>${filled} / ${team.size}</b></div>
        <div><small>팀 전력</small><b>${power || '—'}</b></div>
        <div><small>포메이션</small><b>${esc(team.formation)}</b></div>
      </div>
      <div class="actions">
        <button class="btn primary" data-act="cm-save" type="button">💾 저장</button>
        <button class="btn" data-act="cm-autofill" type="button">빈 자리 자동 채우기</button>
        <button class="btn ghost" data-act="cm-share" type="button">🔗 공유 코드</button>
      </div>
    </section>

    <section class="card cm-roster">
      <div class="card-head">
        <h3>선수 명단 <span class="pill">${filled}/${team.size}</span></h3>
        <button class="btn small" data-act="cm-bulk-open" type="button">⚡ 빠른 일괄 입력</button>
      </div>
      ${app.state.custom.bulk ? bulkBox(app, team) : ''}
      <ul class="cp-list">${team.players.map((p, i) => playerRow(team, p, i)).join('')}</ul>
      <p class="hint">OVR을 바꾸면 포지션에 맞춰 세부 능력치가 자동으로 배분됩니다. 세부 능력치를 직접 고치면 OVR이 다시 계산됩니다.</p>
    </section>
  </div>`;
}

function bulkBox(app, team) {
  const sample = team.size === 11 ? '김철수 ST 84\n이영희 CB 79\n박민수 MF 76' : '김철수 PIVO 84\n이영희 FIXO 78\n박민수 ALA 75';
  return `<div class="cm-bulk">
    <p class="sm">한 줄에 한 명씩 — <b>이름 포지션 OVR</b> (예: <code>김철수 ST 84</code>). 쉼표로 나눠도 됩니다.</p>
    <textarea class="inp" rows="5" data-cm="bulk" placeholder="${esc(sample)}">${esc(app.state.custom.bulkText || '')}</textarea>
    <div class="actions">
      <button class="btn small primary" data-act="cm-bulk-apply" type="button">명단에 넣기</button>
      <button class="btn small ghost" data-act="cm-bulk-close" type="button">닫기</button>
    </div>
  </div>`;
}

/* ─────────────────────────── 공유·불러오기 ─────────────────────────── */
function sharePanel(app, team) {
  const db = readTeams();
  const sh = app.state.custom.share || {};
  const busy = !!sh.busy;
  return `<div class="cm-grid">
    <section class="card">
      <h3>공유 코드 만들기</h3>
      <p class="sm">팀을 공유 서버에 올리고 <b>6자리 코드</b>와 링크를 받습니다. 코드를 받은 친구는 자기 브라우저에 팀을 저장해 바로 대결할 수 있어요.</p>
      ${team ? `
      <div class="cm-share-team">
        <span class="badge" data-team="${team.id}">${esc(teamShort(team))}</span>
        <div><b>${esc(team.name)}</b><br><small class="muted">${formatName(team.size)} · ${esc(team.formation)} · 전력 ${teamPowerOf(team) || '—'}</small></div>
      </div>
      <div class="actions">
        <button class="btn primary" data-act="cm-publish" data-id="${team.id}" type="button" ${busy ? 'disabled' : ''}>${busy ? '올리는 중…' : '공유 코드 발급'}</button>
        ${team.code ? `<button class="btn ghost" data-act="cm-copy" data-copy="${esc(teamLink(team.code))}" type="button">링크 복사</button>` : ''}
      </div>
      ${team.code ? `<div class="cm-code">
        <small>공유 코드</small>
        <b class="cm-code-val">${esc(team.code)}</b>
        <button class="btn small" data-act="cm-copy" data-copy="${esc(team.code)}" type="button">코드 복사</button>
        <button class="btn small ghost" data-act="cm-copy" data-copy="${esc(teamLink(team.code))}" type="button">링크 복사</button>
        <p class="sm muted">${esc(teamLink(team.code))}</p>
      </div>` : ''}
      ` : '<p class="muted sm">먼저 팀을 만들어 주세요.</p>'}
    </section>

    <section class="card">
      <h3>코드·링크로 불러오기</h3>
      <p class="sm">친구에게 받은 <b>6자리 코드</b>를 넣거나, <code>?team=</code> 링크를 그대로 붙여 넣으세요. 링크는 통째로 넣어도 됩니다.</p>
      <div class="cm-load">
        <input class="inp" data-cm="code" placeholder="예: K7M2QX 또는 https://…?team=K7M2QX" value="${esc(app.state.custom.codeInput || '')}" aria-label="공유 코드 또는 링크">
        <button class="btn" data-act="cm-load" type="button">불러오기</button>
      </div>
      <h4 class="sub">내 팀 ${db.list.length}개</h4>
      <ul class="cm-team-list">
        ${db.list.map((t) => `<li>
          <span class="badge" data-team="${t.id}">${esc(teamShort(t))}</span>
          <span class="cm-tl-name"><b>${esc(t.name)}</b><small class="muted">${formatName(t.size)} · ${esc(t.formation)}${t.code ? ` · 코드 ${t.code}` : ''}${t.from ? ` · ${esc(t.from)}` : ''}</small></span>
          <button class="btn small ghost" data-act="cm-open" data-id="${t.id}" type="button">편집</button>
          ${t.code ? `<button class="btn small ghost" data-act="cm-copy" data-copy="${esc(teamLink(t.code))}" type="button">링크</button>` : ''}
          <button class="btn small ghost" data-act="cm-delete" data-id="${t.id}" type="button">삭제</button>
        </li>`).join('')}
      </ul>
    </section>

    <section class="card cm-link-info">
      <h3>링크로 바로 열기</h3>
      <p class="sm">매치업 링크는 두 팀을 한 번에 엽니다 — <code>?match=내팀코드:상대팀코드</code></p>
      ${team?.code ? `<p class="sm"><code>${esc(matchLink(team.code, '상대코드'))}</code></p>` : ''}
      <p class="sm muted">인터넷이 없거나 공유 서버가 막히면 「긴 링크」로 팀 전체를 링크에 담아 보낼 수 있습니다.</p>
      <div class="actions">${team ? `<button class="btn ghost" data-act="cm-longlink" data-id="${team.id}" type="button">긴 링크 만들기</button>` :
        ''}</div>
      ${app.state.custom.longLink ? `<p class="sm cm-longlink" data-cm="longlink"><code>${esc(app.state.custom.longLink)}</code></p>
        <div class="actions"><button class="btn small" data-act="cm-copy" data-copy="${esc(app.state.custom.longLink)}" type="button">복사</button></div>` : ''}
    </section>
  </div>`;
}

/* ─────────────────────────── 경기 준비 ─────────────────────────── */
function miniPitchSvg(team, flip = false) {
  const slots = FORMATIONS[team.formation]?.slots || [];
  const dots = slots.map((s) => {
    const x = (flip ? 1 - s.x : s.x) * 100;
    const y = s.y * 64;
    return `<circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="${s.pos === 'GK' ? 3.4 : 3}" fill="${esc(team.colors?.primary || '#02c245')}" stroke="#101014" stroke-width="1.2"/>`;
  }).join('');
  return `<svg class="mini-pitch" viewBox="0 0 100 64" role="img" aria-label="${esc(team.name)} ${esc(team.formation)} 배치">
    <rect x="1" y="1" width="98" height="62" fill="#2f9e4f" stroke="#101014" stroke-width="1.5"/>
    <path d="M50 1v62" stroke="#ffffff" stroke-width="1" opacity=".7"/>
    <circle cx="50" cy="32" r="8" fill="none" stroke="#ffffff" stroke-width="1" opacity=".7"/>
    <rect x="1" y="19" width="12" height="26" fill="none" stroke="#ffffff" stroke-width="1" opacity=".7"/>
    <rect x="87" y="19" width="12" height="26" fill="none" stroke="#ffffff" stroke-width="1" opacity=".7"/>
    ${dots}
  </svg>`;
}

const klTeamOf = (id) => KL_TEAMS.find((t) => t.id === id) || null;
const oppName = (mu) => {
  if (mu.oppKind === 'kl') return klTeamOf(mu.oppId)?.name || 'K리그 구단';
  return (mu.oppTeam && mu.oppTeam.name) || '상대 팀';
};

function matchupPanel(app, team) {
  const db = readTeams();
  const mu = app.state.matchup;
  const others = db.list.filter((t) => !team || t.id !== team.id);
  const sizeMis = mu.oppKind === 'custom' && mu.oppTeam && team && mu.oppTeam.size !== team.size;
  return `<div class="cm-grid">
    <section class="card">
      <h3>1. 내 팀</h3>
      ${teamPicker(app, team)}
      ${team ? `<div class="cm-vs-team">
        <span class="badge big" data-team="${team.id}">${esc(teamShort(team))}</span>
        <div><b>${esc(team.name)}</b><p class="sm muted">${formatName(team.size)} · ${esc(team.formation)} · 전력 ${teamPowerOf(team) || '—'}</p></div>
      </div>
      <div class="cm-pitch-wrap">${miniPitchSvg(team)}</div>` : '<p class="muted sm">팀을 먼저 만들어 주세요.</p>'}

      <h3 class="sub">2. 상대</h3>
      <div class="seg-wrap" role="group" aria-label="상대 종류">
        <button type="button" class="btn small ${mu.oppKind === 'custom' ? 'on' : ''}" data-act="mu-oppkind" data-kind="custom" aria-pressed="${mu.oppKind === 'custom'}">친구 팀 (내 팀 목록)</button>
        <button type="button" class="btn small ${mu.oppKind === 'kl' ? 'on' : ''}" data-act="mu-oppkind" data-kind="kl" aria-pressed="${mu.oppKind === 'kl'}">K리그 2026 구단</button>
      </div>
      ${mu.oppKind === 'custom' ? `
        <select class="inp" data-mu="opp" aria-label="상대 팀">
          <option value="">— 상대 팀 고르기 —</option>
          ${others.map((t) => `<option value="${t.id}" ${mu.oppId === t.id ? 'selected' : ''}>${esc(t.name)} · ${formatName(t.size)}</option>`).join('')}
        </select>
        <p class="hint">친구에게 받은 팀은 「공유·불러오기」에서 코드로 먼저 저장해 두세요. 같은 규모끼리 붙습니다.</p>
        ${sizeMis ? '<p class="cm-warn">두 팀의 규모가 다릅니다 — 같은 규모(11/6/5) 팀끼리 경기할 수 있습니다.</p>' : ''}`
      : `
        <select class="inp" data-mu="kl" aria-label="K리그 구단">
          ${KL_DIVISIONS.map((d) => `<optgroup label="${esc(d.name)}">
            ${KL_TEAMS.filter((t) => t.div === d.id).map((t) => `<option value="${t.id}" ${mu.oppId === t.id ? 'selected' : ''}>${esc(t.name)} (${esc(d.short)} · 전력 ${t.power})</option>`).join('')}
          </optgroup>`).join('')}
        </select>
        <p class="hint">${formatName(team?.size || 11)} 경기에 맞춰 그 구단의 선수 중 ${team?.size || 11}명이 나옵니다(포지션·전력 순).</p>`}

      <h3 class="sub">3. 홈 / 원정</h3>
      <div class="seg-wrap" role="group" aria-label="홈 원정">
        <button type="button" class="btn small ${mu.side === 'home' ? 'on' : ''}" data-act="mu-side" data-side="home" aria-pressed="${mu.side === 'home'}">🏠 홈</button>
        <button type="button" class="btn small ${mu.side === 'away' ? 'on' : ''}" data-act="mu-side" data-side="away" aria-pressed="${mu.side === 'away'}">✈ 원정</button>
      </div>
      <div class="cm-match-cta">
        <button class="btn primary big" data-act="mu-start" data-instant="0" type="button">⚽ 경기 시작 (2D 중계)</button>
        <button class="btn" data-act="mu-start" data-instant="1" type="button">즉시 결과</button>
      </div>
    </section>

    <section class="card">
      <h3>전술 — ${esc(team?.name || '내 팀')}</h3>
      <div class="cm-field"><span>팀 성향</span>
        <div class="ment-row" role="group" aria-label="팀 성향">
          ${MENTALITY.map((m) => `<button type="button" class="ment-btn ${Math.abs((team?.tactic.mentality || 0) - m.v) < 0.01 ? 'on' : ''}" data-act="cm-mentality" data-val="${m.v}" aria-pressed="${Math.abs((team?.tactic.mentality || 0) - m.v) < 0.01}" title="${esc(m.effect)}">${esc(m.name)}</button>`).join('')}
        </div>
        <p class="axis-eff">${esc(mentalityEffect(team?.tactic.mentality || 0, true))}</p>
      </div>
      <div class="cm-field"><span>전술 4축</span>
        <ul class="axes compact cm-axes">
          ${AXES.map((a) => {
            const v = team?.tactic?.[a.key] || 0;
            return `<li class="axis"><div class="axis-head"><b>${a.name}</b><span class="axis-val">${stepLabel(v)}</span></div>
            <div class="axis-ctl"><span class="axis-end">${a.left}</span><span class="seg">${STEPS.map((s) => `<button type="button" class="${Math.abs(s - v) < 0.01 ? 'on' : ''}" data-act="cm-tactic" data-axis="${a.key}" data-val="${s}" aria-label="${a.name} ${stepLabel(s)}" aria-pressed="${Math.abs(s - v) < 0.01}">${s > 0 ? '▲' : s < 0 ? '▼' : '●'}</button>`).join('')}</span><span class="axis-end">${a.right}</span></div></li>`;
          }).join('')}
        </ul>
      </div>
      ${team ? `<div class="cm-field"><span>포지션별 역할 <small class="muted">— 누르면 바뀝니다</small></span>
        <div class="role-grid">
          ${team.players.map((p, i) => {
            if (teamSlotPos(team, p.slot) === 'GK') return '';
            const role = (team.roles || [])[i] || 'b2b';
            const next = nextRole(p.slot, role);
            const more = rolesForLabel(p.slot).length > 1;
            return `<button type="button" class="role-row" data-act="cm-role" data-i="${i}" title="${esc(roleLabel(role))} → ${esc(roleLabel(next))}">
              <span class="rr-pos">${esc(p.slot)}</span><span class="rr-name">${esc(p.name || `선수 ${i + 1}`)}</span>
              <span class="rr-role">${esc(roleShort(role))}${more ? ' ↻' : ''}</span></button>`;
          }).join('')}
        </div>
      </div>` : ''}
      <p class="hint">K리그 구단과 붙을 때도 내 팀 전술은 그대로 적용됩니다. 경기 중에도 바꿀 수 있습니다.</p>
    </section>
  </div>`;
}

/* ─────────────────────────── 결과 ─────────────────────────── */
export function renderCustomResult(app) {
  const r = app.state.customResult;
  if (!r) return '';
  const { m, meta } = r;
  const sum = matchSummary(m);
  const home = m.world.teams[m.homeId], away = m.world.teams[m.awayId];
  const mySide = m.userSide;
  const my = mySide === 'home' ? home : away;
  const won = m.score[mySide] > m.score[mySide === 'home' ? 'away' : 'home'];
  const drew = m.score.home === m.score.away;
  const st = sum.stats;
  const bar = (h, a) => {
    const total = (h || 0) + (a || 0) || 1;
    return { h: Math.round((h / total) * 100), a: Math.round((a / total) * 100) };
  };
  const rows = [
    ['점유율', `${st.possession.home}%`, `${st.possession.away}%`, null],
    ['슈팅', st.shots.home, st.shots.away, bar(st.shots.home, st.shots.away)],
    ['유효 슈팅', st.onTarget.home, st.onTarget.away, null],
    ['패스 성공', st.passes.home, st.passes.away, null],
    ['코너킥', st.corners.home, st.corners.away, null],
    ['파울', st.fouls.home, st.fouls.away, null],
    ['경고', st.yellow.home, st.yellow.away, null],
    ['오프사이드', st.offsides.home, st.offsides.away, null],
  ];
  const goals = sum.goals.slice().sort((a, b) => a.minute - b.minute);
  return `<section class="cm-head">
    <div><span class="eyebrow">CUSTOM MATCHUP · FULL TIME</span>
      <h1>${drew ? '무승부' : won ? '승리!' : '패배'} <span class="hl">${m.score.home} - ${m.score.away}</span></h1>
      <p class="sm">${esc(home.name)} vs ${esc(away.name)} · ${formatName(meta.size)}${meta.instant ? ' · 즉시 결과' : ''}</p>
    </div>
  </section>
  <div class="cm-result-grid">
    <section class="card">
      <div class="cm-score">
        <div class="cm-score-team"><span class="badge big" data-team="${m.homeId}">${esc(home.short)}</span><b>${esc(home.name)}</b><small class="muted">홈</small></div>
        <div class="cm-score-num">${m.score.home}<span>:</span>${m.score.away}${m.pens ? `<small>PK ${esc(m.pens.text)}</small>` : ''}</div>
        <div class="cm-score-team"><span class="badge big" data-team="${m.awayId}">${esc(away.short)}</span><b>${esc(away.name)}</b><small class="muted">원정</small></div>
      </div>
      <h4 class="sub">득점</h4>
      ${goals.length ? `<ul class="cm-goals">${goals.map((g) => `<li><span class="pill xs">${esc(g.label)}</span> <b>${esc(g.scorer)}</b>${g.assist ? ` <small class="muted">도움 ${esc(g.assist)}</small>` : ''} <small class="muted">${g.side === 'home' ? esc(home.short) : esc(away.short)}</small> <b class="cm-goal-score">${g.score.home}-${g.score.away}</b></li>`).join('')}</ul>` : '<p class="muted sm">득점 없이 끝났습니다.</p>'}
      <h4 class="sub">MOM</h4>
      ${sum.mom ? `<p class="cm-mom"><span class="badge" data-team="${sum.mom.side === 'home' ? m.homeId : m.awayId}">${esc(sum.mom.e.side === 'home' ? home.short : away.short)}</span> <b>${esc(sum.mom.e.name)}</b> <span class="pill">${sum.mom.rating}</span> <small class="muted">${sum.mom.e.st.goals ? `골 ${sum.mom.e.st.goals}` : ''}${sum.mom.e.st.assists ? ` 도움 ${sum.mom.e.st.assists}` : ''}</small></p>` : ''}
      <div class="actions cm-result-actions">
        <button class="btn primary" data-act="mu-rematch" type="button">🔁 재대결</button>
        <button class="btn" data-act="cm-tab" data-tab="match" type="button">상대 바꾸기</button>
        <button class="btn ghost" data-act="cm-copy-result" type="button">결과 텍스트 복사</button>
        <button class="btn ghost" data-act="cm-back" type="button">커스텀 매치업으로</button>
      </div>
    </section>
    <section class="card">
      <h3>경기 기록</h3>
      <div class="table-wrap"><table class="tbl cm-stats">
        <thead><tr><th>${esc(home.short)}</th><th></th><th>${esc(away.short)}</th></tr></thead>
        <tbody>${rows.map(([label, h, a]) => `<tr><td>${h}</td><td class="cm-stat-label">${label}</td><td>${a}</td></tr>`).join('')}</tbody>
      </table></div>
    </section>
  </div>`;
}
