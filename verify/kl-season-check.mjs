// K리그 2026 — 한 시즌을 즉시 결과로 끝까지 치르고 결산·승격 화면까지 확인합니다.
import { chromium } from 'playwright';
import http from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { extname, join } from 'node:path';

const ROOT = '/workspace/repos/fm/dist';
const PORT = 8143;
const EXE = '/workspace/.pw/chromium_headless_shell-1255/chrome-headless-shell-linux64/chrome-headless-shell';
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.woff2': 'font/woff2', '.svg': 'image/svg+xml' };
const server = http.createServer(async (req, res) => {
  let p = decodeURIComponent(req.url.split('?')[0]);
  if (!p.startsWith('/fm/')) { res.writeHead(404); res.end(); return; }
  p = p.slice(4) || '/';
  let f = join(ROOT, p);
  try { if ((await stat(f)).isDirectory()) f = join(f, 'index.html'); } catch { f = join(ROOT, 'index.html'); }
  res.writeHead(200, { 'Content-Type': MIME[extname(f)] || 'application/octet-stream' });
  res.end(await readFile(f));
});
await new Promise((r) => server.listen(PORT, '127.0.0.1', r));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const errs = [];
const ok = (cond, label, detail = '') => console.log(`${cond ? '  ✅' : '  ❌'} ${label}${detail ? ` — ${detail}` : ''}`);

const b = await chromium.launch({ executablePath: EXE, args: ['--no-sandbox', '--disable-dev-shm-usage', '--hide-scrollbars'] });
const page = await (await b.newContext({ viewport: { width: 1440, height: 900 }, locale: 'ko-KR' })).newPage();
page.on('pageerror', (e) => errs.push('pageerror: ' + e.message));
page.on('console', (m) => { if (m.type() === 'error') errs.push('console: ' + m.text()); });
await page.goto(`http://127.0.0.1:${PORT}/fm/`, { waitUntil: 'networkidle' });

// 커스텀 리그 탭도 그대로 동작하는지
await page.locator('.mode-tab[data-mode="custom"]').click();
await sleep(300);
ok((await page.locator('.team-card').count()) === 10, '커스텀 리그 탭은 기존 10개 구단을 보여 줍니다');
await page.screenshot({ path: '/workspace/downloads/fm-custom-select.png' });
await page.locator('.mode-tab[data-mode="kleague"]').click();
await sleep(300);
await page.locator('.team-card[data-team="geumsan"]').click();
await sleep(200);
await page.getByRole('button', { name: '이 구단으로 시작' }).click();
await sleep(600);

let played = 0;
for (let i = 0; i < 40; i++) {
  const hasInstant = await page.locator('.next [data-act="instant"]').count();
  if (!hasInstant) break;
  await page.locator('.next [data-act="instant"]').click();
  await page.locator('#ov-continue').click({ timeout: 20000 });
  await page.waitForSelector('.tabs', { timeout: 20000 });
  played += 1;
  await sleep(120);
}
console.log(`  경기 ${played}회 진행`);
const empty = await page.locator('.next.none').count();
ok(empty === 1 && played >= 24, '시즌 모든 경기를 치르면 결산 버튼이 나옵니다', `${played}경기`);
await page.locator('[data-act="season-end"]').click();
await sleep(1500);
ok(await page.locator('.season').isVisible(), '시즌 결산 화면이 열립니다');
const promo = await page.locator('.promo-list li').count();
ok(promo === 6, '승격·강등 6건(맞교대 3·승강 PO 3)이 표시됩니다', `${promo}건`);
const divFinals = await page.locator('.div-finals .df-col').count();
ok(divFinals === 4, 'K1~K4 최종 순위가 모두 나옵니다', `${divFinals}개`);
await page.screenshot({ path: '/workspace/downloads/fm-kleague-season.png', fullPage: true });
await page.locator('[data-act="next-season"]').click();
await sleep(2500);
ok(await page.locator('.season').isVisible(), '다음 시즌 정산 화면(승격 확정)이 나옵니다');
await page.screenshot({ path: '/workspace/downloads/fm-kleague-promotion.png', fullPage: false });
await page.locator('[data-act="close-season"]').click();
await sleep(800);
const header = await page.locator('.brand small').innerText();
ok(header.includes('2027'), '새 시즌은 2027 시즌으로 시작합니다', header);
const rounds = await page.locator('.club-stats > div').last().innerText();
ok(/^\d+ \/ \d+R$/.test(rounds.trim()), '리그 라운드가 새 시즌 라운드로 시작합니다', rounds.replace(/\n/g, ' '));
await page.screenshot({ path: '/workspace/downloads/fm-kleague-newseason.png' });
ok(errs.length === 0, '콘솔 오류 0건', errs.slice(0, 3).join(' | '));
await b.close();
server.close();
