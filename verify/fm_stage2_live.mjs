// 2단계 검증 — 상대 스카우팅 · AI 감독 실시간 맞대응 (데스크톱 1440 + 모바일 390)
// 사용: BASE=https://bmrgoodway.github.io/fm/ node verify/fm_stage2_live.mjs
//   · 다음 경기 카드의 스카우팅 요약과 상세 보고서가 '저장된 상대 팀 데이터'와 맞는지
//   · 예상 11명·포메이션·전술 축·경계 선수·공략 힌트가 실제로 그려지는지
//   · 경기 중 AI 감독이 열세·리드에 따라 성향을 바꾸고, 중계·배지가 함께 갱신되는지
//   · 390px 레이아웃(가로 스크롤·겹침), 콘솔·페이지 오류 0
import { chromium } from 'playwright';
import { writeFileSync, mkdirSync } from 'node:fs';

const BASE = (process.env.BASE || 'https://bmrgoodway.github.io/fm/') + (process.env.BASE ? '' : `?verify=${Date.now()}`);
const EXE = '/workspace/.pw/chromium_headless_shell-1255/chrome-headless-shell-linux64/chrome-headless-shell';
const OUT = process.env.OUT || '/workspace/tmp/fmtest/fm_stage2_live.json';
const SHOT_DIR = process.env.SHOT_DIR || '/workspace/downloads';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const out = { base: BASE, checks: [], errors: [], metrics: {} };
const ok = (c, label, detail) => {
  out.checks.push({ ok: !!c, label, detail });
  console.log(`${c ? '  ✅' : '  ❌'} ${label}${detail ? ' — ' + detail : ''}`);
};
mkdirSync(SHOT_DIR, { recursive: true });

const browser = await chromium.launch({ executablePath: EXE, args: ['--no-sandbox', '--disable-dev-shm-usage', '--hide-scrollbars', '--force-color-profile=srgb'] });

async function open(viewport, opts = {}) {
  const ctx = await browser.newContext({ viewport, locale: 'ko-KR', ...opts });
  const page = await ctx.newPage();
  page.on('pageerror', (e) => out.errors.push('pageerror: ' + e.message));
  page.on('console', (m) => { if (m.type() === 'error') out.errors.push('console: ' + m.text()); });
  await page.goto(BASE, { waitUntil: 'networkidle', timeout: 45000 });
  return { ctx, page };
}
async function startCareer(page) {
  const cont = page.locator('[data-act="continue"]');
  if (await cont.count()) { await cont.first().click(); await sleep(500); return; }
  await page.locator('[data-act="team"][data-team="gs"]').click();
  await sleep(300);
  await page.getByRole('button', { name: /이 구단으로 시작/ }).click();
  await sleep(700);
}
// 저장된 커리어에서 다음 경기 상대를 읽습니다 (화면과 같은 출처)
async function toastGone(page) {
  await page.waitForFunction(() => {
    const t = document.getElementById('toast');
    return !t || !t.classList.contains('on');
  }, null, { timeout: 8000 }).catch(() => {});
}
/* 스크린샷용 — 토스트를 완전히 숨기고, 대상 카드가 머리·탭바에 가리지 않게 위치시킵니다. */
async function prepShot(page, selector, offset = 130) {
  await toastGone(page);
  await page.evaluate(({ sel, off }) => {
    const t = document.getElementById('toast');
    if (t) { t.classList.remove('on'); t.style.display = 'none'; }
    const el = document.querySelector(sel);
    if (!el) return;
    const y = el.getBoundingClientRect().top + window.scrollY - off;
    window.scrollTo(0, Math.max(0, y));
  }, { sel: selector, off: offset });
  await sleep(600);
}
const nextOpp = (page) => page.evaluate(() => {
  const w = JSON.parse(localStorage.getItem('fm:career') || 'null');
  if (!w) return null;
  for (const r of w.calendar) {
    const fx = r.type === 'league' ? r.fixtures : (w.cup.stages?.[r.stage]?.matches || []);
    const f = fx.find((x) => !x.played && (x.home === w.myTeamId || x.away === w.myTeamId));
    if (f) {
      const oppId = f.home === w.myTeamId ? f.away : f.home;
      const t = w.teams[oppId];
      return { oppId, name: t.name, short: t.short, formation: t.formation, tactic: t.tactic, type: r.type, label: r.type === 'cup' ? '컵' : `리그 ${r.leagueRound}R` };
    }
  }
  return null;
});
// 상대 팀 스쿼드(이름) — 스카우팅 11명이 실제 선수인지 확인
const squadNames = (page, oppId) => page.evaluate((id) => {
  const w = JSON.parse(localStorage.getItem('fm:career') || 'null');
  const t = w?.teams?.[id];
  return t ? t.squad.map((pid) => w.players[pid]?.name).filter(Boolean) : [];
}, oppId);

/* ───────────── 데스크톱 1440 ───────────── */
console.log('\n[데스크톱 1440×900]');
{
  const { page } = await open({ width: 1440, height: 900 });
  await startCareer(page);
  const opp = await nextOpp(page);
  const names = await squadNames(page, opp.oppId);
  await sleep(300);

  // ① 다음 경기 카드 안의 스카우팅 요약
  const mini = await page.evaluate(() => {
    const el = document.querySelector('.next .scout-mini');
    if (!el) return null;
    return {
      text: el.innerText.replace(/\n/g, ' | '),
      keys: [...el.querySelectorAll('.sk b')].map((b) => b.textContent.trim()),
      hints: el.querySelectorAll('.sm-hints li').length,
      axes: [...el.querySelectorAll('.axis-chip b')].map((b) => b.textContent.trim()),
    };
  });
  ok(!!mini, '다음 경기 카드에 상대 스카우팅 요약이 있습니다');
  ok(mini && mini.text.includes(opp.formation), '예상 포메이션이 상대 팀의 실제 포메이션과 같습니다', `${opp.formation}`);
  const wordCount = mini ? mini.axes.filter((v) => v && v !== '균형').length : 0;
  ok(mini && mini.axes.length === 4 && wordCount >= 1, '주 전술 스타일 4축이 표시됩니다', mini ? mini.axes.join(' / ') : '');
  ok(mini && mini.keys.length >= 1 && mini.keys.every((n) => names.includes(n)), '핵심 경계 선수가 상대 실제 선수단에 있습니다', mini ? mini.keys.join(', ') : '');
  ok(mini && mini.hints >= 2, '맞춤 공략 힌트가 카드에 나옵니다', `${mini ? mini.hints : 0}개`);
  out.metrics.scoutMini = mini;

  // 상세 보고서로 이동하는 링크
  await page.locator('.next .scout-mini a.sm-more').click();
  await sleep(700);
  const anchor = await page.evaluate(() => {
    const r = document.querySelector('#scout-report').getBoundingClientRect();
    return { top: Math.round(r.top), ok: r.top > 40 && r.top < 220 };
  });
  ok(anchor.ok, '‘스카우팅 상세 보고서’ 링크가 보고서로 이동합니다(머리·탭바에 가리지 않음)', `보고서 top ${anchor.top}px`);

  // ② 상세 보고서
  const full = await page.evaluate(() => {
    const el = document.querySelector('#scout-report');
    if (!el) return null;
    return {
      head: el.querySelector('.card-head')?.innerText.replace(/\n/g, ' '),
      dots: el.querySelectorAll('.scout-pitch g').length,
      xi: [...el.querySelectorAll('.xi-list li .xname')].map((x) => x.textContent.trim()),
      roles: [...el.querySelectorAll('.xi-list li small')].map((x) => x.textContent.trim()),
      axes: el.querySelectorAll('.scout-axes li').length,
      keys: [...el.querySelectorAll('.key-card .kc-top b')].map((b) => b.textContent.trim()),
      keyStats: el.querySelectorAll('.key-card .kc-stats span').length,
      hints: [...el.querySelectorAll('.hint-list li b')].map((b) => b.textContent.trim()),
      text: el.innerText.replace(/\n/g, ' | '),
    };
  });
  ok(!!full, '상세 스카우팅 보고서 카드가 있습니다');
  ok(full && full.dots === 11, '예상 배치에 11명이 그려집니다', `${full ? full.dots : 0}명`);
  ok(full && full.xi.length === 11 && full.xi.every((n) => names.includes(n)), '상세 11명이 상대 실제 선수단과 일치합니다', full ? full.xi.slice(0, 3).join(', ') + ' …' : '');
  ok(full && full.roles.every((r) => /·/.test(r)), '자리·역할까지 표시됩니다', full ? full.roles.slice(0, 3).join(' / ') : '');
  ok(full && full.axes === 4 && full.keys.length >= 1, '전술 4축 · 경계 선수 카드', full ? `${full.axes}축 · ${full.keys.join(', ')}` : '');
  ok(full && full.hints.length >= 3, '공략 힌트가 3개 이상입니다', full ? full.hints.join('·') : '');
  // 피치 라벨이 피치 밖으로 나가지 않는지 (SVG viewBox 안)
  const pitchFit = await page.evaluate(() => {
    const svg = document.querySelector('#scout-report .scout-pitch');
    if (!svg) return null;
    const vb = svg.viewBox.baseVal;
    const bad = [...svg.querySelectorAll('text')].filter((t) => {
      const b = t.getBBox();
      return b.y < vb.y - 0.5 || b.y + b.height > vb.y + vb.height + 0.5 || b.x < vb.x - 0.5 || b.x + b.width > vb.x + vb.width + 0.5;
    }).length;
    return { bad, vb: [vb.width, vb.height] };
  });
  ok(pitchFit && pitchFit.bad === 0, '예상 배치의 이름·자리 라벨이 피치 밖으로 나가지 않습니다', `${pitchFit ? pitchFit.bad : '?'}개 이탈`);
  const hs = await page.evaluate(() => ({ sw: document.documentElement.scrollWidth, cw: document.documentElement.clientWidth }));
  ok(hs.sw <= hs.cw + 1, '데스크톱 가로 스크롤이 없습니다', `${hs.sw} ≤ ${hs.cw}`);
  await prepShot(page, '#scout-report', 132);
  await page.screenshot({ path: `${SHOT_DIR}/fm-scouting.png` });
  out.metrics.scoutFull = full;

  // ③ 경기 중 AI 맞대응
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.getByRole('button', { name: /경기 시작/ }).first().click();
  await page.waitForSelector('#pitch');
  await sleep(800);
  await page.locator('.spd[data-speed="4"]').click();
  await sleep(200);
  // 후반 73분 · AI 열세로 맞춰 둡니다
  const forced = await page.evaluate(() => {
    const m = window.__fm.match;
    const ai = m.userSide === 'home' ? 'away' : 'home';
    m.pause = 0; m.half = 2; m.t = 73 * 4; m.phase = 'play';
    m.score = { home: 0, away: 0 };
    m.score[ai] = 0; m.score[m.userSide] = 1;
    return { ai, userSide: m.userSide };
  });
  // 티커는 다음 멘트가 오면 곧바로 바뀌므로, 화면이 실제로 지나간 문구를 기록해 둡니다.
  await page.evaluate(() => {
    window.__tkLog = [];
    const el = document.getElementById('tk-text');
    if (!el) return;
    new MutationObserver(() => window.__tkLog.push(el.textContent || '')).observe(el, { childList: true, characterData: true, subtree: true });
  });
  await sleep(600);
  const trail = await page.evaluate(() => ({
    diag: window.__fm.mentality(),
    my: document.getElementById('ml-my')?.textContent,
    opp: document.getElementById('ml-opp')?.textContent,
    chipH: document.getElementById('m-ment-home')?.textContent,
    chipA: document.getElementById('m-ment-away')?.textContent,
    feed: [...document.querySelectorAll('.feed .ev-ai-tactic')].map((li) => li.innerText.replace(/\n/g, ' ')),
    ticker: document.getElementById('tk-text')?.textContent,
  }));
  const aiChip = forced.ai === 'home' ? trail.chipH : trail.chipA;
  ok(['공격적', '총공세'].includes(aiChip), '경기 중 AI(열세)의 성향 배지가 공격적으로 갱신됩니다', `배지 "${aiChip}" · 기록 "${trail.opp}"`);
  ok(trail.diag.log.length >= 1, 'AI 감독 전술 변경이 기록에 남습니다', JSON.stringify(trail.diag.log.slice(0, 2)));
  ok(trail.feed.length >= 1 && /감독/.test(trail.feed[0] || ''), '중계 피드에 전술 변경 멘트가 나옵니다', (trail.feed[0] || '').slice(0, 80));
  const tkLog = await page.evaluate(() => window.__tkLog || []);
  const tickerHit = tkLog.find((t) => /감독/.test(t)) || '';
  ok(/감독/.test(tickerHit), '티커에도 전술 변경 멘트가 지나갑니다', (tickerHit || `기록 ${tkLog.length}건`).slice(0, 80));
  out.metrics.trail = trail;

  // ④ 종반 리드 → 잠그기/수비적
  await page.evaluate(() => {
    const m = window.__fm.match;
    const ai = m.userSide === 'home' ? 'away' : 'home';
    m.pause = 0; m.half = 2; m.t = 85 * 4; m.phase = 'play';
    m.score = { home: 0, away: 0 };
    m.score[ai] = 2; m.score[m.userSide] = 0;
  });
  await sleep(2200);
  const lead = await page.evaluate(() => ({
    diag: window.__fm.mentality(),
    my: document.getElementById('ml-my')?.textContent,
    opp: document.getElementById('ml-opp')?.textContent,
    chipH: document.getElementById('m-ment-home')?.textContent,
    chipA: document.getElementById('m-ment-away')?.textContent,
    feed: [...document.querySelectorAll('.feed .ev-ai-tactic')].map((li) => li.innerText.replace(/\n/g, ' ')),
  }));
  const aiChip2 = forced.ai === 'home' ? lead.chipH : lead.chipA;
  ok(['수비적', '잠그기'].includes(aiChip2), '이기고 있는 AI는 수비적/잠그기로 내립니다', `배지 "${aiChip2}" · 기록 "${lead.opp}"`);
  ok(lead.diag.log.length >= 2, '성향 변경이 두 번 이상 기록됩니다', JSON.stringify(lead.diag.log.map((c) => `${c.minute}' ${c.from}→${c.to}`)));
  // 스크린샷용 — 경기를 멈추고 중계 로그의 AI 멘트를 보이게 한 뒤 찍습니다.
  await page.locator('#m-pause').click();
  await page.evaluate(() => document.querySelector('.feed .ev-ai-tactic')?.scrollIntoView({ block: 'nearest' }));
  await sleep(350);
  await page.screenshot({ path: `${SHOT_DIR}/fm-ai-adapt.png` });
  out.metrics.lead = lead;
  await page.close();
}

/* ───────────── 모바일 390 ───────────── */
console.log('\n[모바일 390×844]');
{
  const { page } = await open({ width: 390, height: 844 }, { deviceScaleFactor: 2, isMobile: true, hasTouch: true });
  await startCareer(page);
  await sleep(400);
  const hs = await page.evaluate(() => ({ sw: document.documentElement.scrollWidth, cw: document.documentElement.clientWidth }));
  ok(hs.sw <= hs.cw + 1, '모바일 가로 스크롤이 없습니다', `${hs.sw} ≤ ${hs.cw}`);
  const miniW = await page.evaluate(() => {
    const el = document.querySelector('.next .scout-mini');
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { w: Math.round(r.width), parent: Math.round(el.parentElement.getBoundingClientRect().width) };
  });
  ok(miniW && miniW.w <= miniW.parent + 1, '스카우팅 요약이 카드 폭을 넘지 않습니다', `${miniW ? miniW.w : '?'} ≤ ${miniW ? miniW.parent : '?'}px`);
  const stack = await page.evaluate(() => {
    const g = document.querySelector('.scout-grid');
    if (!g) return null;
    const cs = getComputedStyle(g);
    const cols = cs.gridTemplateColumns.split(' ').filter(Boolean).length;
    return { cols, display: cs.display };
  });
  ok(stack && stack.cols === 1, '상세 보고서가 모바일에서 한 줄로 쌓입니다', stack ? `${stack.cols}열` : '없음');
  const tiny = await page.evaluate(() => {
    const els = [...document.querySelectorAll('#scout-report .hint-list li, #scout-report .key-card .kc-mark, .scout-mini .sm-hints li')];
    return els.filter((e) => parseFloat(getComputedStyle(e).fontSize) < 10.5).length;
  });
  ok(tiny === 0, '공략 힌트 글자가 10.5px 이상입니다', `${tiny}개 작음`);
  await prepShot(page, '.next .scout-mini', 205);
  await page.screenshot({ path: `${SHOT_DIR}/fm-mobile.png` });
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.locator('#scout-report').scrollIntoViewIfNeeded();
  await sleep(250);
  const mh = await page.evaluate(() => ({ sw: document.documentElement.scrollWidth, cw: document.documentElement.clientWidth }));
  ok(mh.sw <= mh.cw + 1, '상세 보고서까지 스크롤해도 가로 스크롤이 없습니다', `${mh.sw} ≤ ${mh.cw}`);
  await page.screenshot({ path: `${SHOT_DIR}/fm-scouting-mobile.png` });

  // 모바일 경기 — 성향 배지가 잘리지 않는지
  await page.getByRole('button', { name: /경기 시작/ }).first().click();
  await page.waitForSelector('#pitch');
  await sleep(900);
  await page.locator('.spd[data-speed="4"]').click();
  await sleep(200);
  await page.evaluate(() => {
    const m = window.__fm.match;
    const ai = m.userSide === 'home' ? 'away' : 'home';
    m.pause = 0; m.half = 2; m.t = 74 * 4; m.phase = 'play';
    m.score = { home: 0, away: 0 };
    m.score[ai] = 0; m.score[m.userSide] = 1;
  });
  await sleep(2000);
  const mob = await page.evaluate(() => {
    const bar = document.querySelector('.scorebar').getBoundingClientRect();
    const chips = [...document.querySelectorAll('.ment-chip')].map((e) => {
      const r = e.getBoundingClientRect();
      return { t: e.textContent, inside: r.left >= -1 && r.right <= window.innerWidth + 1 && r.top >= bar.top - 1 && r.bottom <= bar.bottom + 1, w: Math.round(r.width) };
    });
    return { chips, ov: document.documentElement.scrollWidth - document.documentElement.clientWidth };
  });
  ok(mob.chips.length === 2 && mob.chips.every((c) => c.inside && c.w > 20), '모바일 스코어바의 성향 배지가 잘리지 않습니다', mob.chips.map((c) => `${c.t} ${c.w}px`).join(' · '));
  ok(mob.ov <= 1, '경기 화면도 가로 스크롤이 없습니다', `over ${mob.ov}px`);
  await page.screenshot({ path: `${SHOT_DIR}/fm-ai-adapt-mobile.png` });
}

ok(out.errors.length === 0, '콘솔·페이지 오류 0건', out.errors.slice(0, 3).join(' | ') || '없음');
await browser.close();
const fails = out.checks.filter((c) => !c.ok).length;
mkdirSync(OUT.replace(/\/[^/]+$/, ''), { recursive: true });
writeFileSync(OUT, JSON.stringify(out, null, 2));
console.log(`\n${fails ? `❌ ${fails}개 실패` : '✅ 모든 항목 통과'} (${out.checks.length}개 점검) → ${OUT}`);
process.exit(fails ? 1 : 0);
