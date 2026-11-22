import { chromium } from 'playwright';
const BASE = 'https://bmrgoodway.github.io/fm/';
const EXE = '/workspace/.pw/chromium_headless_shell-1255/chrome-headless-shell-linux64/chrome-headless-shell';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const errs = [];
const ok = (c, l, d = '') => console.log(`${c ? '  ✅' : '  ❌'} ${l}${d ? ' — ' + d : ''}`);
const b = await chromium.launch({ executablePath: EXE, args: ['--no-sandbox', '--disable-dev-shm-usage', '--hide-scrollbars'] });

async function open({ width, height }, dsf = 1) {
  const ctx = await b.newContext({ viewport: { width, height }, deviceScaleFactor: dsf, locale: 'ko-KR' });
  const page = await ctx.newPage();
  page.on('pageerror', (e) => errs.push('pageerror: ' + e.message));
  page.on('console', (m) => { if (m.type() === 'error') errs.push('console: ' + m.text()); });
  await page.goto(BASE + '?live=' + Date.now(), { waitUntil: 'networkidle', timeout: 60000 });
  return { ctx, page };
}

console.log('[실서버 데스크톱]');
const { ctx: dc, page } = await open({ width: 1440, height: 900 });
await sleep(600);
ok((await page.locator('.mode-tab').count()) === 2, 'K리그 2026 모드 탭이 실서버에 보입니다');
await page.locator('.team-card[data-team="geumsan"]').click();
await sleep(250);
await page.getByRole('button', { name: '이 구단으로 시작' }).click();
await sleep(800);
ok((await page.evaluate(() => document.body.dataset.view)) === 'hub', '금산 인삼 FC 감독으로 시작합니다');
await page.locator('.tabs [data-act="tab"][data-tab="records"]').click();
await sleep(500);
await page.locator('.div-tab[data-div="1"]').click();
await sleep(400);
ok((await page.locator('.standings tbody tr').count()) === 12, 'K1 12팀 순위표가 나옵니다');
await page.locator('.standings tbody tr .tl').first().click();
await sleep(400);
ok(await page.locator('.modal .club-squad').isVisible(), '타 구단 선수단이 열립니다');
await page.locator('.modal .club-squad tbody tr').first().click();
await sleep(350);
ok((await page.locator('.player-modal .stats8 li').count()) === 8, '선수 상세 8개 능력치가 나옵니다');
await page.screenshot({ path: '/workspace/downloads/fm-kleague-live.png' });
await dc.close();

console.log('[실서버 모바일 390]');
const { ctx: mc, page: mp } = await open({ width: 390, height: 844 }, 3);
await sleep(500);
const ov = await mp.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
ok(ov <= 1, '모바일 390px에서 가로 넘침이 없습니다', `${ov}px`);
await mp.screenshot({ path: '/workspace/downloads/fm-kleague-mobile.png' });
await mc.close();
ok(errs.length === 0, '콘솔 오류 0건', errs.slice(0, 3).join(' | '));
await b.close();
