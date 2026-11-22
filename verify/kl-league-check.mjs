// K리그 2026 모드 화면 점검 — 로컬 dist 를 띄우고 데스크톱·모바일에서 확인합니다.
import { chromium } from 'playwright';
import http from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { extname, join } from 'node:path';

const ROOT = '/workspace/repos/fm/dist';
const PORT = 8141;
const EXE = '/workspace/.pw/chromium_headless_shell-1255/chrome-headless-shell-linux64/chrome-headless-shell';
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.woff2': 'font/woff2', '.svg': 'image/svg+xml', '.png': 'image/png', '.json': 'application/json' };

const server = http.createServer(async (req, res) => {
  try {
    let p = decodeURIComponent(req.url.split('?')[0]);
    if (!p.startsWith('/fm/')) { res.writeHead(404); res.end('no'); return; }
    p = p.slice(4) || '/';
    let f = join(ROOT, p);
    try { if ((await stat(f)).isDirectory()) f = join(f, 'index.html'); } catch { f = join(ROOT, 'index.html'); }
    const data = await readFile(f);
    res.writeHead(200, { 'Content-Type': MIME[extname(f)] || 'application/octet-stream' });
    res.end(data);
  } catch { res.writeHead(404); res.end('not found'); }
});
await new Promise((r) => server.listen(PORT, '127.0.0.1', r));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const errors = [];
const ok = (cond, label, detail = '') => console.log(`${cond ? '  ✅' : '  ❌'} ${label}${detail ? ` — ${detail}` : ''}`);
const BASE = `http://127.0.0.1:${PORT}/fm/`;

const browser = await chromium.launch({ executablePath: EXE, args: ['--no-sandbox', '--disable-dev-shm-usage', '--hide-scrollbars'] });

async function open({ width, height }, dsf = 1) {
  const ctx = await browser.newContext({ viewport: { width, height }, deviceScaleFactor: dsf, locale: 'ko-KR' });
  const page = await ctx.newPage();
  page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
  page.on('console', (m) => { if (m.type() === 'error') errors.push('console: ' + m.text()); });
  await page.goto(BASE, { waitUntil: 'networkidle' });
  return { ctx, page };
}

/* ── 데스크톱 ── */
console.log('\n[데스크톱 1440×900]');
const { ctx: dc, page } = await open({ width: 1440, height: 900 });
await sleep(400);
ok((await page.locator('.mode-tab').count()) === 2, '리그 모드 선택(커스텀/K리그)이 보입니다');
ok((await page.locator('.div-tab').count()) === 4, '디비전 탭 K1~K4가 보입니다');
const cards4 = await page.locator('.team-card').count();
ok(cards4 === 13, 'K4 13개 구단 카드가 나옵니다', `${cards4}개`);
ok((await page.locator('.rec-tag').count()) === 1, '금산 인삼 FC 추천 표시가 있습니다');
await page.screenshot({ path: '/workspace/downloads/fm-kleague-select.png', fullPage: false });

// 구단 상세 → 시작
await page.locator('.team-card[data-team="geumsan"]').click();
await sleep(250);
ok(await page.locator('.modal .roster-preview li').first().isVisible(), '구단 모달에 실제 선수 미리보기가 있습니다');
await page.screenshot({ path: '/workspace/downloads/fm-kleague-club.png' });
await page.getByRole('button', { name: '이 구단으로 시작' }).click();
await sleep(700);
ok((await page.evaluate(() => document.body.dataset.view)) === 'hub', '감독 취임 후 허브로 들어갑니다');
ok((await page.locator('.clubbar .divtag').first().innerText()).includes('K4'), '클럽바에 소속 디비전(K4)이 보입니다');
await page.screenshot({ path: '/workspace/downloads/fm-kleague-hub.png' });

// 순위/기록 — 디비전 전환
await page.locator('.tabs [data-act="tab"][data-tab="records"]').click();
await sleep(400);
ok((await page.locator('.standings tbody tr').count()) === 13, '내 디비전(K4) 13팀 순위표가 나옵니다');
await page.locator('.div-tab[data-div="1"]').click();
await sleep(350);
ok((await page.locator('.standings tbody tr').count()) === 12, 'K1 탭으로 바꾸면 12팀 순위표가 나옵니다');
ok((await page.locator('.standings .zchip').count()) > 0, '승격·강등 구역 표시가 있습니다');
await page.screenshot({ path: '/workspace/downloads/fm-kleague-table.png' });

// 타 구단 선수단 → 선수 상세
await page.locator('.standings tbody tr .tl').nth(1).click();
await sleep(350);
ok(await page.locator('.modal .club-squad tbody tr').first().isVisible(), '타 구단 이름을 누르면 선수단이 열립니다');
const rows = await page.locator('.modal .club-squad tbody tr').count();
ok(rows === 20, '구단 선수단 20명이 표로 나옵니다', `${rows}행`);
await page.locator('.modal .club-squad tbody tr').first().click();
await sleep(350);
ok((await page.locator('.player-modal .stats8 li').count()) === 8, '선수 상세에 8개 능력치가 있습니다');
ok((await page.locator('.player-modal .pc-meta > div').count()) >= 6, '나이·몸값·주급·출전·선발/교체·평점이 있습니다');
await page.screenshot({ path: '/workspace/downloads/fm-kleague-player.png' });
await page.keyboard.press('Escape');
await sleep(200);

// 선수단 탭 — 필터
await page.locator('.tabs [data-act="tab"][data-tab="squad"]').click();
await sleep(400);
await page.locator('.filter-bar [data-pos="GK"]').click();
await sleep(300);
const gk = await page.locator('#squad-table tbody tr').count();
ok(gk === 3, '포지션 필터로 GK 3명만 볼 수 있습니다', `${gk}명`);
await page.locator('.filter-bar [data-pos="ALL"]').click();
await sleep(200);
await page.fill('.filter-bar .search', '김');
await sleep(250);
const filtered = await page.locator('#squad-table tbody tr:visible').count();
ok(filtered >= 1 && filtered < 20, '이름 검색으로 선수단이 걸러집니다', `${filtered}명`);
await page.screenshot({ path: '/workspace/downloads/fm-kleague-squad.png' });

// 경기 1회 즉시 결과
await page.locator('.tabs [data-act="tab"][data-tab="schedule"]').click();
await sleep(300);
await page.getByRole('button', { name: /즉시 결과/ }).click();
await page.locator('#ov-continue').click({ timeout: 20000 });
await page.waitForSelector('.tabs [data-act="tab"][data-tab="market"]', { timeout: 20000 });
ok((await page.evaluate(() => document.body.dataset.view)) === 'hub', '즉시 결과로 경기가 끝나고 허브로 돌아옵니다');

// 이적 시장
await page.locator('.tabs [data-act="tab"][data-tab="market"]').click();
await sleep(400);
const marketRows = await page.locator('.market.buy tbody tr').count();
ok(marketRows > 0, '이적 시장 매물이 나옵니다', `${marketRows}건`);
await page.screenshot({ path: '/workspace/downloads/fm-kleague-market.png' });

await dc.close();

/* ── 모바일 390 ── */
console.log('\n[모바일 390×844]');
const { ctx: mc, page: mp } = await open({ width: 390, height: 844 }, 3);
await sleep(400);
const overflow = await mp.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
ok(overflow <= 1, '구단 선택 화면이 390px에서 가로로 넘치지 않습니다', `넘침 ${overflow}px`);
await mp.locator('.team-card[data-team="geumsan"]').click();
await sleep(250);
await mp.getByRole('button', { name: '이 구단으로 시작' }).click();
await sleep(700);
await mp.locator('.tabs [data-act="tab"][data-tab="records"]').click();
await sleep(400);
const overflow2 = await mp.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
ok(overflow2 <= 1, '순위표 탭도 390px에서 넘치지 않습니다', `넘침 ${overflow2}px`);
await mp.screenshot({ path: '/workspace/downloads/fm-kleague-mobile.png' });
await mp.locator('.standings tbody tr .tl').nth(2).click();
await sleep(300);
await mp.locator('.modal .club-squad tbody tr').nth(1).click();
await sleep(300);
const overflow3 = await mp.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
ok(overflow3 <= 1, '선수 상세 모달도 390px에서 넘치지 않습니다', `넘침 ${overflow3}px`);
await mp.screenshot({ path: '/workspace/downloads/fm-kleague-mobile-player.png' });
await mc.close();

ok(errors.length === 0, '콘솔 오류 0건', errors.slice(0, 3).join(' | '));
await browser.close();
server.close();
console.log(`\n${errors.length ? '❌ 오류 있음' : '✅ 화면 점검 통과'}\n`);
