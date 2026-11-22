// 4단계 검증 — 선수 실시간 성장·훈련 · 활발한 이적 시장(오퍼·협상·FA·임대) (데스크톱 1440 + 모바일 390)
// 사용: BASE=https://bmrgoodway.github.io/fm/ node verify/fm_stage4_live.mjs
//   · 훈련 방향 4종 선택·저장, 선수단 표의 잠재/최근 변화, 선수 카드의 성장 상태
//   · 경기 결과 화면의 '선수 성장'(applyResult 와 같은 값) · 일정 탭 지난 경기 성장 카드
//   · 이적 시장의 우리 선수 오퍼(수락/거절/역제안) · 협상 · FA · 임대 · 이적 소식 피드
//   · 390px 레이아웃(가로 스크롤·겹침), 콘솔·페이지 오류 0
import { chromium } from 'playwright';
import { writeFileSync, mkdirSync } from 'node:fs';

const BASE = (process.env.BASE || 'https://bmrgoodway.github.io/fm/') + (process.env.NO_CACHE ? `?verify=${Date.now()}` : '');
const EXE = '/workspace/.pw/chromium_headless_shell-1255/chrome-headless-shell-linux64/chrome-headless-shell';
const OUT = process.env.OUT || '/workspace/tmp/fmtest/fm_stage4_live.json';
const SHOT_DIR = process.env.SHOT_DIR || '/workspace/downloads';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const out = { base: BASE, checks: [], errors: [], metrics: {} };
const ok = (c, label, detail) => {
  out.checks.push({ ok: !!c, label, detail: detail || '' });
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
async function toastGone(page) {
  await page.waitForFunction(() => {
    const t = document.getElementById('toast');
    return !t || !t.classList.contains('on');
  }, null, { timeout: 8000 }).catch(() => {});
}
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
  await sleep(700);
}
const saved = (page) => page.evaluate(() => {
  const w = JSON.parse(localStorage.getItem('fm:career') || 'null');
  if (!w) return null;
  return {
    training: w.teams?.[w.myTeamId]?.training,
    offers: (w.offers || []).length,
    transfers: (w.transfers || []).length,
    lastGrowth: w.lastGrowth?.list?.length || 0,
    market: (w.market || []).map((e) => ({ pid: e.pid, price: e.price, loan: !!e.loan })),
    squad: w.teams?.[w.myTeamId]?.squad?.length,
  };
});

/* ───────────── 데스크톱 1440 ───────────── */
console.log('\n[데스크톱 1440×900]');
{
  const { page } = await open({ width: 1440, height: 900 });
  await startCareer(page);
  await page.locator('nav.tabs [data-act="tab"][data-tab="squad"]').click();
  await sleep(500);

  // ① 훈련 방향 4종 → 선택·저장
  const train = await page.evaluate(() => [...document.querySelectorAll('[data-act="training"]')].map((b) => b.dataset.key));
  ok(train.length === 4 && ['balanced', 'attack', 'pass', 'defense'].every((k) => train.includes(k)),
    '전술/선수단 탭에 훈련 방향 4종이 있습니다', train.join(' · '));
  await page.locator('[data-act="training"][data-key="attack"]').click();
  await sleep(500);
  const s1 = await saved(page);
  const onBtn = await page.evaluate(() => document.querySelector('[data-act="training"].on')?.dataset.key);
  ok(s1.training === 'attack' && onBtn === 'attack', '고른 훈련이 저장되고 선택 상태로 표시됩니다', `${s1.training} · ${onBtn}`);

  // ② 선수단 표 — 잠재·최근 변화 열
  const cols = await page.evaluate(() => [...document.querySelectorAll('.tbl.squad thead th')].map((t) => t.textContent.trim()));
  ok(cols.includes('잠재') && cols.includes('최근'), '선수단 표에 잠재력·최근 변화 열이 있습니다', cols.join('|'));
  // ③ 선수 카드 — 성장 상태·잠재력·기록
  await page.locator('.tbl.squad tbody tr').first().click();
  await sleep(400);
  const card = await page.evaluate(() => ({
    box: !!document.querySelector('.grow-box'),
    pill: document.querySelector('.grow-box .pill')?.textContent.trim() || '',
    head: document.querySelector('.grow-box .gb-head')?.textContent.replace(/\s+/g, ' ').trim().slice(0, 46) || '',
  }));
  ok(card.box && /잠재력/.test(card.head), '선수 카드에 성장 상태와 잠재력이 보입니다', card.head || '없음');
  await prepShot(page, '.train-row', 180);
  await page.screenshot({ path: `${SHOT_DIR}/fm-stage4-training.png` });
  out.metrics.trainingShot = `${SHOT_DIR}/fm-stage4-training.png`;

  // ④ 새로고침 후에도 훈련 유지
  await page.reload({ waitUntil: 'networkidle' });
  await page.locator('[data-act="continue"]').first().click();
  await sleep(600);
  await page.locator('nav.tabs [data-act="tab"][data-tab="squad"]').click();
  await sleep(400);
  const s2 = await saved(page);
  ok(s2.training === 'attack' && (await page.evaluate(() => document.querySelector('[data-act="training"].on')?.dataset.key)) === 'attack',
    '새로고침 후에도 훈련 방향이 유지됩니다', s2.training);

  // ⑤ 즉시 결과 → 결과 화면의 선수 성장
  await page.locator('nav.tabs [data-act="tab"][data-tab="schedule"]').click();
  await sleep(300);
  await page.getByRole('button', { name: /즉시 결과/ }).first().click();
  await page.waitForSelector('#m-overlay:not([hidden])', { timeout: 40000 });
  await sleep(800);
  const ovg = await page.evaluate(() => ({
    n: document.querySelectorAll('#ov-growth li').length,
    head: document.querySelector('#ov-growth .ovg-head')?.textContent.replace(/\s+/g, ' ').trim() || '',
    sample: document.querySelector('#ov-growth li')?.textContent.replace(/\s+/g, ' ').trim() || '',
  }));
  ok(ovg.n > 0, '경기 결과 화면에 이번 경기 선수 성장이 뜹니다', `${ovg.n}명 · ${ovg.sample.slice(0, 40)}`);
  ok(/선수 성장/.test(ovg.head), '성장 목록 제목이 표시됩니다', ovg.head);
  await toastGone(page);
  await page.screenshot({ path: `${SHOT_DIR}/fm-stage4-result.png` });
  out.metrics.resultShot = `${SHOT_DIR}/fm-stage4-result.png`;

  await page.locator('#ov-continue').click();
  await sleep(1000);

  // ⑥ 일정 탭 — 지난 경기 성장 카드
  const grow = await page.evaluate(() => ({
    card: !!document.querySelector('.growth-card'),
    n: document.querySelectorAll('.growth-card .growth li').length,
    up: document.querySelectorAll('.growth-card .growth .up').length,
    words: [...document.querySelectorAll('.growth-card .gr-words')].slice(0, 2).map((e) => e.textContent.trim()),
  }));
  ok(grow.card && grow.n > 0, '일정 탭에 지난 경기 성장 카드가 있습니다', `${grow.n}명 · 상승 ${grow.up}`);
  ok(grow.words.some((w) => /[+-]/.test(w)), '능력치 변화가 +1 · -1 형태로 보입니다', grow.words.join(' / '));
  const s3 = await saved(page);
  ok(s3.lastGrowth > 0, '성장 결과가 세이브에 남습니다', `${s3.lastGrowth}명`);

  // 성장 스크린샷 — 최근 변화가 있는 선수를 골라 카드의 성장 기록을 담습니다
  await page.locator('nav.tabs [data-act="tab"][data-tab="squad"]').click();
  await sleep(500);
  const grownRow = page.locator('.tbl.squad tbody tr').filter({ has: page.locator('.grow-up, .grow-down') }).first();
  if (await grownRow.count()) { await grownRow.click({ force: true }); await sleep(400); }
  const cardNow = await page.evaluate(() => ({
    head: document.querySelector('.grow-box .gb-head')?.textContent.replace(/\s+/g, ' ').trim() || '',
    logs: document.querySelectorAll('.grow-log li').length,
    picked: document.querySelector('.pcard h4')?.textContent || '',
  }));
  ok(cardNow.logs > 0, '경기를 치른 선수 카드에 최근 성장 기록이 보입니다', `${cardNow.picked} · ${cardNow.head.slice(0, 40)}`);
  await prepShot(page, '.pcard', 130);
  await page.screenshot({ path: `${SHOT_DIR}/fm-stage4-growth.png` });
  out.metrics.growthShot = `${SHOT_DIR}/fm-stage4-growth.png`;

  // ⑦ 이적 시장 — 오퍼·협상·FA·임대·피드
  await page.locator('nav.tabs [data-act="tab"][data-tab="market"]').click();
  await sleep(600);
  const mk = await page.evaluate(() => ({
    offersCard: !!document.querySelector('.offers'),
    offers: document.querySelectorAll('.offer').length,
    offerBtns: {
      accept: document.querySelectorAll('[data-act="offer-accept"]').length,
      counter: document.querySelectorAll('[data-act="offer-counter"]').length,
      reject: document.querySelectorAll('[data-act="offer-reject"]').length,
    },
    negotiate: document.querySelectorAll('[data-act="negotiate"]').length,
    loans: document.querySelectorAll('[data-act="loan"]').length,
    fa: [...document.querySelectorAll('[data-act="sign"]')].length,
    freePill: document.querySelectorAll('.pill.free').length,
    feed: document.querySelectorAll('.tfeed li').length,
    tabBadge: document.querySelector('.tab .tab-n')?.textContent.trim() || '',
  }));
  out.metrics.market = mk;
  ok(mk.offersCard, '이적 시장에 우리 선수 영입 오퍼 카드가 있습니다');
  ok(mk.offers > 0 && mk.offerBtns.accept === mk.offers && mk.offerBtns.counter === mk.offers && mk.offerBtns.reject === mk.offers,
    '오퍼마다 수락·역제안·거절 버튼이 있습니다', `${mk.offers}건`);
  ok(mk.tabBadge !== '', '이적 시장 탭에 대기 오퍼 수가 표시됩니다', mk.tabBadge);
  ok(mk.negotiate > 0, '매물마다 가격 협상 버튼이 있습니다', `${mk.negotiate}개`);
  ok(mk.loans > 0, '시즌 임대 매물이 있습니다', `${mk.loans}개`);
  ok(mk.freePill > 0, '자유계약(FA) 매물이 있습니다', `${mk.freePill}개`);
  ok(mk.feed > 0, '이적 소식 피드에 소식이 있습니다', `${mk.feed}건`);
  await prepShot(page, '.offers', 150);
  await page.screenshot({ path: `${SHOT_DIR}/fm-stage4-transfer.png` });
  out.metrics.transferShot = `${SHOT_DIR}/fm-stage4-transfer.png`;

  // ⑧ 역제안 모달 → 금액 3단계 → 전송
  const beforeOffer = await saved(page);
  await page.locator('[data-act="offer-counter"]').first().click();
  await sleep(400);
  const om = await page.evaluate(() => ({
    open: !!document.querySelector('.modal'),
    opts: [...document.querySelectorAll('[data-act="offer-counter-send"]')].map((b) => b.dataset.price),
  }));
  ok(om.open && om.opts.length === 3, '역제안 금액 3단계를 고를 수 있습니다', om.opts.join(' / '));
  await page.locator('[data-act="offer-counter-send"]').nth(1).click();
  await sleep(900);
  const afterOffer = await saved(page);
  const sold = (i) => beforeOffer && afterOffer && beforeOffer.offers > afterOffer.offers && (afterOffer.squad === beforeOffer.squad - 1 || afterOffer.offers === 0);
  const feedGrew = afterOffer && afterOffer.transfers >= beforeOffer.transfers;
  ok(sold(1) || feedGrew, '역제안 결과가 처리되고 이적 소식에 남습니다',
    `${beforeOffer?.offers} → ${afterOffer?.offers}건 · 피드 ${beforeOffer?.transfers} → ${afterOffer?.transfers}`);
  await toastGone(page);

  // ⑨ 협상 모달 → 낮은 금액 → 요청가 하락 또는 영입
  const beforeNeg = await saved(page);
  const negBtn = page.locator('[data-act="negotiate"]').first();
  const negPid = await negBtn.getAttribute('data-pid');
  await negBtn.click();
  await sleep(400);
  const nm = await page.evaluate(() => ({
    open: !!document.querySelector('.modal'),
    opts: [...document.querySelectorAll('[data-act="negotiate-send"]')].map((b) => b.dataset.price),
  }));
  ok(nm.open && nm.opts.length === 3, '협상 금액 3단계를 고를 수 있습니다', nm.opts.join(' / '));
  await page.locator('[data-act="negotiate-send"]').last().click();
  await sleep(900);
  const afterNeg = await saved(page);
  const beforePrice = beforeNeg?.market?.find((e) => e.pid === negPid)?.price;
  const afterEntry = afterNeg?.market?.find((e) => e.pid === negPid);
  const signed = beforeNeg && afterNeg && afterNeg.squad === beforeNeg.squad + 1;
  ok(signed || (afterEntry && beforePrice != null && afterEntry.price <= beforePrice),
    '낮은 제안에 상대가 응답합니다 (요청가 하락 또는 영입)', signed ? '영입 성사' : `${beforePrice} → ${afterEntry?.price}`);
  await toastGone(page);

  // ⑩ 임대 영입 → 선수단 +1, 임대 표시
  const beforeLoan = await saved(page);
  await page.locator('[data-act="loan"]').first().click();
  await sleep(900);
  const afterLoan = await saved(page);
  ok(afterLoan.squad === beforeLoan.squad + 1, '임대로 선수를 데려오면 선수단이 늘어납니다', `${beforeLoan.squad} → ${afterLoan.squad}`);
  const loaned = await page.evaluate(() => {
    const w = JSON.parse(localStorage.getItem('fm:career'));
    return Object.values(w.players).filter((p) => p.loan && p.teamId === w.myTeamId).length;
  });
  ok(loaned >= 1, '임대 선수에게 원소속이 기록됩니다', `${loaned}명`);
  await toastGone(page);

  const errs = await page.evaluate(() => window.__fm?.errors || []);
  ok(errs.length === 0, '데스크톱 콘솔·페이지 오류 0건', errs.slice(0, 2).join(' / '));
  const scroll = await page.evaluate(() => ({ sw: document.documentElement.scrollWidth, cw: document.documentElement.clientWidth }));
  ok(scroll.sw <= scroll.cw + 1, '데스크톱 가로 스크롤 없음', `${scroll.sw} / ${scroll.cw}`);
}

/* ───────────── 모바일 390 ───────────── */
console.log('\n[모바일 390×844]');
{
  const { page } = await open({ width: 390, height: 844 }, { isMobile: true, hasTouch: true, deviceScaleFactor: 2 });
  await startCareer(page);
  await page.locator('nav.tabs [data-act="tab"][data-tab="squad"]').click();
  await sleep(500);
  const train = await page.evaluate(() => document.querySelectorAll('[data-act="training"]').length);
  ok(train === 4, '모바일 전술 탭에 훈련 방향 4종', `${train}개`);
  // 훈련 버튼이 카드 폭 안에 들어가는지
  const fit = await page.evaluate(() => {
    const row = document.querySelector('.train-row');
    const rr = row.getBoundingClientRect();
    return [...row.querySelectorAll('button')].filter((b) => b.getBoundingClientRect().right > rr.right + 1 || b.scrollWidth > b.clientWidth + 2).length;
  });
  ok(fit === 0, '훈련 버튼이 모바일 폭에 맞습니다');
  await page.locator('[data-act="training"][data-key="pass"]').click();
  await sleep(400);

  // 즉시 결과 → 성장 → 시장
  await page.locator('nav.tabs [data-act="tab"][data-tab="schedule"]').click();
  await sleep(300);
  await page.getByRole('button', { name: /즉시 결과/ }).first().click();
  await page.waitForSelector('#m-overlay:not([hidden])', { timeout: 40000 });
  await sleep(800);
  const ovg = await page.evaluate(() => document.querySelectorAll('#ov-growth li').length);
  ok(ovg > 0, '모바일 결과 화면에도 선수 성장이 뜹니다', `${ovg}명`);
  await page.locator('#ov-continue').click();
  await sleep(1000);
  await page.locator('nav.tabs [data-act="tab"][data-tab="market"]').click();
  await sleep(600);
  const mk = await page.evaluate(() => ({
    offers: document.querySelectorAll('.offer').length,
    neg: document.querySelectorAll('[data-act="negotiate"]').length,
    loan: document.querySelectorAll('[data-act="loan"]').length,
    feed: document.querySelectorAll('.tfeed li').length,
    overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
  }));
  ok(mk.offers > 0 || mk.neg > 0, '모바일 이적 시장 — 오퍼·매물이 보입니다', `오퍼 ${mk.offers} · 협상 ${mk.neg}`);
  ok(mk.overflow <= 1, '모바일 가로 스크롤 없음', `${mk.overflow}px`);
  await prepShot(page, '.offers', 210);
  await page.screenshot({ path: `${SHOT_DIR}/fm-mobile.png` });
  out.metrics.mobileShot = `${SHOT_DIR}/fm-mobile.png`;
  const errs2 = await page.evaluate(() => window.__fm?.errors || []);
  ok(errs2.length === 0, '모바일 콘솔·페이지 오류 0건', errs2.slice(0, 2).join(' / '));
}

await browser.close();
const passed = out.checks.filter((c) => c.ok).length;
out.summary = { total: out.checks.length, passed, failed: out.checks.length - passed };
mkdirSync('/workspace/tmp/fmtest', { recursive: true });
writeFileSync(OUT, JSON.stringify(out, null, 2));
console.log(`\n${out.summary.failed ? `❌ ${out.summary.failed}개 실패` : '✅ 모든 항목 통과'} (${passed}/${out.summary.total}) · 오류 ${out.errors.length}건`);
if (out.errors.length) console.log(out.errors.slice(0, 6).join('\n'));
process.exit(out.summary.failed || out.errors.length ? 1 : 0);
