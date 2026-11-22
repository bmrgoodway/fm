// 라이브 검증 — 팀 성향(멘탈리티) 5단계 + 포지션별 역할(Role) + 기존 세이브 호환
// 사용: BASE=https://bmrgoodway.github.io/fm/ node verify/fm_roles_live.mjs
//   · 전술 화면: 역할 버튼·피치 배지 순환·1줄 효과·팀 성향 5단계·새로고침 유지
//   · 경기 중: 전술 모달에서 잠그기 ↔ 총공세를 바꾸면 피치의 수비 라인이 실제로 움직이는지
//   · 모바일 390px: 가로 스크롤 없음, 성향·역할 버튼 노출
//   · 콘솔·페이지 오류 0건, 스크린샷(fm-tactics-role·fm-desktop·fm-mobile·fm-tactics-mobile)
import { chromium } from 'playwright';
import { writeFileSync } from 'node:fs';

const BASE = (process.env.BASE || 'https://bmrgoodway.github.io/fm/') + '?verify=' + Date.now();
const EXE = '/workspace/.pw/chromium_headless_shell-1255/chrome-headless-shell-linux64/chrome-headless-shell';
const OUT = process.env.OUT || '/workspace/tmp/fmtest/fm_roles_live.json';
const SHOT_DIR = process.env.SHOT_DIR || '/workspace/downloads';
const out = { base: BASE, checks: [], errors: [], metrics: {} };
const ok = (cond, label, detail) => {
  out.checks.push({ ok: !!cond, label, detail });
  console.log(`${cond ? '  ✅' : '  ❌'} ${label}${detail ? ` — ${detail}` : ''}`);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const browser = await chromium.launch({ executablePath: EXE, args: ['--no-sandbox', '--disable-dev-shm-usage', '--hide-scrollbars', '--force-color-profile=srgb'] });

async function openApp(viewport, dsf = 1) {
  const ctx = await browser.newContext({ viewport, deviceScaleFactor: dsf, locale: 'ko-KR' });
  const page = await ctx.newPage();
  page.on('pageerror', (e) => out.errors.push('pageerror: ' + e.message));
  page.on('console', (m) => { if (m.type() === 'error') out.errors.push('console: ' + m.text()); });
  await page.goto(BASE, { waitUntil: 'networkidle', timeout: 45000 });
  return { ctx, page };
}
async function startCareer(page) {
  // 이미 커리어가 있으면 '이어하기'
  const cont = page.getByRole('button', { name: /이어서 하기|이어하기|계속하기/ });
  if (await cont.count()) { await cont.first().click(); await sleep(600); return; }
  await page.getByRole('button', { name: /금산 유나이티드/ }).first().click();
  await page.getByRole('button', { name: '이 구단으로 시작' }).click();
  await sleep(500);
}
async function openSquad(page) {
  await page.getByRole('button', { name: /전술\/선수단/ }).first().click();
  await page.waitForSelector('.pitchboard', { timeout: 10000 });
  await sleep(350);
}

/* ───────────── 1. 세이브 호환 (구버전 saves) ───────────── */
console.log('\n[1] 기존 세이브 호환');
{
  const { ctx, page } = await openApp({ width: 1440, height: 900 });
  // 이전 버전 세이브를 흉내: 역할·멘탈리티 없는 커리어를 먼저 만들어 넣습니다
  await startCareer(page);
  const seeded = await page.evaluate(() => {
    const raw = localStorage.getItem('fm:career');
    if (!raw) return null;
    const w = JSON.parse(raw);
    delete w.myLineup.roles;
    delete w.myLineup.tactic.mentality;
    for (const t of Object.values(w.teams)) delete t.tactic.mentality;
    localStorage.setItem('fm:career', JSON.stringify(w));
    return { formation: w.myLineup.formation, hasRoles: 'roles' in w.myLineup };
  });
  out.metrics.seeded = seeded;
  await page.goto(BASE.replace('?verify=' + BASE.split('?verify=')[1], '') + '?verify=' + Date.now(), { waitUntil: 'networkidle' });
  await page.getByRole('button', { name: /이어서 하기|이어하기|계속하기/ }).first().click();
  await sleep(700);
  await openSquad(page);
  // 보정된 역할·성향이 실제로 저장되는지 — 균형 버튼을 한 번 눌러 저장을 태웁니다
  await page.locator('.ment-btn', { hasText: '균형' }).first().click();
  await sleep(250);
  const legacy = await page.evaluate(() => {
    const w = JSON.parse(localStorage.getItem('fm:career'));
    const chips = [...document.querySelectorAll('.chip-pos')].map((b) => b.textContent.trim());
    const mentOn = document.querySelector('.ment-btn.on')?.textContent.replace(/\s+/g, ' ').trim();
    return { roles: w.myLineup.roles, ment: w.myLineup.tactic.mentality, chips: chips.slice(0, 6), mentOn };
  });
  out.metrics.legacy = legacy;
  ok(Array.isArray(legacy.roles) && legacy.roles.length === 11, '역할 없던 세이브를 열면 lineup.roles 가 자동으로 채워짐', String(legacy.roles?.slice(0, 5)));
  ok(legacy.ment === 0, '팀 성향은 균형(0)으로 보정', String(legacy.ment));
  ok(legacy.chips.some((c) => c.includes('풀백') || c.includes('커버')), '전술 화면 칩에 기본 역할이 표시됨', legacy.chips.join(' / '));
  ok((legacy.mentOn || '').includes('균형'), '팀 성향 버튼이 균형에 켜져 있음', legacy.mentOn);
  await ctx.close();
}

/* ───────────── 2. 데스크톱: 역할·성향 UI ───────────── */
console.log('\n[2] 데스크톱 1440×900 — 역할·성향 화면');
let desk = null;
{
  const { ctx, page } = await openApp({ width: 1440, height: 900 });
  await startCareer(page);
  await openSquad(page);
  desk = { ctx, page };
  const ui = await page.evaluate(() => {
    const w = JSON.parse(localStorage.getItem('fm:career'));
    return {
      mentBtns: [...document.querySelectorAll('.ment-btn')].map((b) => b.textContent.replace(/\s+/g, ' ').trim()),
      roleBtns: [...document.querySelectorAll('.role-btn')].map((b) => b.textContent.trim()),
      roleEff: document.querySelector('.rb-eff')?.textContent.trim(),
      chipRoles: [...document.querySelectorAll('.chip-pos')].map((b) => b.textContent.trim()).slice(0, 11),
      formation: w.myLineup.formation,
      scrollX: document.documentElement.scrollWidth > window.innerWidth + 1,
    };
  });
  out.metrics.desktopUI = ui;
  const mentNames = ['잠그기', '수비적', '균형', '공격적', '총공세'];
  ok(ui.mentBtns.length === 5 && mentNames.every((n, i) => ui.mentBtns[i].startsWith(n)),
    '팀 성향 5단계 버튼', ui.mentBtns.join(' · '));
  ok(ui.roleBtns.length >= 2, '선택한 자리의 역할 버튼(2~3종)', ui.roleBtns.join(' / '));
  ok(!!ui.roleEff && ui.roleEff.length > 6, '역할 1줄 효과 표시', ui.roleEff);
  ok(ui.chipRoles.filter((c) => c && !c.startsWith('GK')).length >= 8, '피치 칩마다 포지션·역할 표시', ui.chipRoles.slice(0, 6).join(' / '));

  // 역할 버튼으로 LB를 윙백으로
  const lbRole = page.locator('.role-btn', { hasText: '윙백' }).first();
  const hasLb = await lbRole.count();
  ok(hasLb > 0, '측면 수비 역할에 윙백 버튼이 있음');
  if (hasLb) {
    await lbRole.click();
    await sleep(300);
    const after = await page.evaluate(() => {
      const w = JSON.parse(localStorage.getItem('fm:career'));
      return { roles: w.myLineup.roles, eff: document.querySelector('.rb-eff')?.textContent.trim(), toast: document.getElementById('toast')?.textContent };
    });
    out.metrics.afterRoleClick = after;
    ok(after.roles.includes('wingback'), '역할 버튼 클릭 → lineup.roles 에 윙백 저장', after.roles.join(','));
    ok(/윙백/.test(after.eff || ''), '바뀐 역할의 1줄 효과로 갱신', after.eff);
  }

  // 칩의 역할 배지를 눌러 순환
  const chipRole = page.locator('.chip .chip-pos[data-act="role-cycle"]').nth(2);
  const before = await chipRole.textContent();
  await chipRole.click();
  await sleep(250);
  const cycled = await page.evaluate(() => {
    const w = JSON.parse(localStorage.getItem('fm:career'));
    return { roles: w.myLineup.roles.join(',') };
  });
  const afterTxt = await page.locator('.chip .chip-pos[data-act="role-cycle"]').nth(2).textContent();
  out.metrics.chipCycle = { before: before.trim(), after: afterTxt.trim(), roles: cycled.roles };
  ok(before.trim() !== afterTxt.trim(), '피치 칩의 역할 배지를 누르면 역할이 순환', `${before.trim()} → ${afterTxt.trim()}`);

  // 팀 성향: 총공세
  await page.locator('.ment-btn', { hasText: '총공세' }).first().click();
  await sleep(300);
  const ment = await page.evaluate(() => {
    const w = JSON.parse(localStorage.getItem('fm:career'));
    return { v: w.myLineup.tactic.mentality, eff: document.querySelector('.ment-btn.on')?.textContent.replace(/\s+/g, ' ').trim(), axisEff: [...document.querySelectorAll('.axis-eff')].map((p) => p.textContent.trim()).filter((t) => t.includes('센터백')) };
  });
  out.metrics.mentality = ment;
  ok(ment.v === 1, '총공세 선택 → tactic.mentality = 1 저장', String(ment.v));
  ok((ment.eff || '').includes('총공세'), '선택한 성향 버튼이 켜짐', ment.eff);

  // 새로고침 후 유지
  await page.reload({ waitUntil: 'networkidle' });
  await page.getByRole('button', { name: /이어서 하기|이어하기|계속하기/ }).first().click();
  await sleep(600);
  await openSquad(page);
  const kept = await page.evaluate(() => {
    const w = JSON.parse(localStorage.getItem('fm:career'));
    return { ment: w.myLineup.tactic.mentality, roles: w.myLineup.roles.join(','), onMent: document.querySelector('.ment-btn.on')?.textContent.replace(/\s+/g, ' ').trim() };
  });
  out.metrics.kept = kept;
  ok(kept.ment === 1 && kept.roles.includes('wingback'), '새로고침해도 역할·성향 유지', `mentality ${kept.ment} · ${kept.onMent}`);

  // 역할 화면 스크린샷 — 보드와 역할 바가 함께 보이도록 화면을 키우고 LB 슬롯을 고릅니다
  await page.locator('.chip-main').nth(1).click();      // LB 슬롯 선택
  await sleep(300);
  await page.setViewportSize({ width: 1440, height: 1250 });
  await sleep(400);
  await page.evaluate(() => { const el = document.querySelector('.squad-grid'); if (el) window.scrollTo(0, el.getBoundingClientRect().top + window.scrollY - 90); });
  await sleep(400);
  await page.screenshot({ path: `${SHOT_DIR}/fm-tactics-role.png`, fullPage: false });
  await page.setViewportSize({ width: 1440, height: 900 });
  await sleep(300);
}

/* ───────────── 3. 경기 중 성향 변경 ───────────── */
console.log('\n[3] 경기 중 전술 변경 모달 — 팀 성향');
{
  const { page } = desk;
  await page.getByRole('button', { name: /일정|경기/ }).first().click().catch(() => {});
  await page.getByRole('button', { name: /경기 시작/ }).first().click();
  await page.waitForSelector('#pitch', { timeout: 15000 });
  await page.getByRole('button', { name: '2x' }).click();
  await sleep(1200);
  await page.getByRole('button', { name: '전술 변경' }).click();
  await page.waitForSelector('.drawer [data-mment]', { timeout: 5000 });
  const inMatch = await page.evaluate(() => ({
    ment: window.__fm.match.sides[window.__fm.match.userSide].tactic.mentality,
    btns: [...document.querySelectorAll('.drawer [data-mment]')].map((b) => b.textContent.trim()),
  }));
  ok(inMatch.btns.length === 5, '경기 중 모달에도 팀 성향 5단계', inMatch.btns.join(' · '));
  // 수비 라인은 '한 순간'이 아니라 몇 초간 여러 번 재어 평균합니다 (세트피스 직후는 제외)
  async function sampleDF(want = 10, maxMs = 16000) {
    await page.evaluate(() => {
      const m = window.__fm.match;
      window.__dfSamples = [];
      clearInterval(window.__dfTimer);
      window.__dfTimer = setInterval(() => {
        const s = m.sides[m.userSide];
        if (!s || m.phase !== 'play') return;
        if (m.t - (m.lastKickoffT ?? -99) < 8 || m.t - (m.lastSetPieceT ?? -99) < 8) return;
        const pr = (x) => (s.dir > 0 ? x : 100 - x);
        const dfs = s.players.filter((e) => e.onPitch && e.pos === 'DF' && !e.press);
        if (dfs.length) window.__dfSamples.push(dfs.reduce((a, e) => a + pr(e.x), 0) / dfs.length);
      }, 120);
    });
    const t0 = Date.now();
    for (;;) {
      await sleep(400);
      const n = await page.evaluate(() => (window.__dfSamples || []).length);
      if (n >= want || Date.now() - t0 > maxMs) break;
    }
    return page.evaluate(() => {
      clearInterval(window.__dfTimer);
      const a = window.__dfSamples || [];
      const s = window.__fm.match.sides[window.__fm.match.userSide];
      return { n: a.length, avg: a.length ? +(a.reduce((x, y) => x + y, 0) / a.length).toFixed(1) : null, ment: s.tactic.mentality };
    });
  }
  await page.locator('.drawer [data-mment="-1"]').first().click();   // 잠그기
  await sleep(600);
  const lockMent = await page.evaluate(() => ({
    ment: window.__fm.match.sides[window.__fm.match.userSide].tactic.mentality,
    saved: JSON.parse(localStorage.getItem('fm:career')).myLineup.tactic.mentality,
  }));
  ok(lockMent.ment === -1, '경기 중 잠그기로 즉시 변경', `tactic.mentality ${lockMent.ment} · 저장 ${lockMent.saved}`);
  const lockLine = await sampleDF();
  await page.locator('.drawer [data-mment="1"]').first().click();   // 총공세
  await sleep(600);
  const atkMent = await page.evaluate(() => window.__fm.match.sides[window.__fm.match.userSide].tactic.mentality);
  const atkLine = await sampleDF();
  out.metrics.inMatch = { lockLine, atkLine };
  ok(atkMent === 1, '경기 중 총공세로 즉시 변경', `tactic.mentality ${atkMent}`);
  ok(lockLine.avg != null && atkLine.avg != null && atkLine.avg - lockLine.avg > 3,
    '잠그기 → 총공세로 바꾸면 피치의 수비 라인이 실제로 올라감',
    `수비 라인 평균 ${lockLine.avg} → ${atkLine.avg} (Δ${(atkLine.avg - lockLine.avg).toFixed(1)}) · 샘플 ${lockLine.n}/${atkLine.n}`);
  await page.locator('.drawer [data-mact="close"]').first().click().catch(() => {});
  await sleep(400);
  await page.screenshot({ path: `${SHOT_DIR}/fm-desktop.png` });
  out.errors.push(...(await page.evaluate(() => window.__fm.errors || [])));
}

/* ───────────── 4. 모바일 390×844 ───────────── */
console.log('\n[4] 모바일 390×844');
{
  const { ctx, page } = await openApp({ width: 390, height: 844 }, 2);
  await startCareer(page);
  await openSquad(page);
  const mob = await page.evaluate(() => {
    const r = (sel) => { const el = document.querySelector(sel); if (!el) return null; const b = el.getBoundingClientRect(); return { w: Math.round(b.width), h: Math.round(b.height) }; };
    return {
      vw: window.innerWidth, scrollW: document.documentElement.scrollWidth,
      overflowX: document.documentElement.scrollWidth > window.innerWidth + 1,
      board: r('.pitchboard'), roleBar: r('.role-bar'), mentRow: r('.ment-row'),
      mentBtns: document.querySelectorAll('.ment-btn').length,
      roleBtns: document.querySelectorAll('.role-btn').length,
    };
  });
  out.metrics.mobileSquad = mob;
  ok(!mob.overflowX, '390px에서 가로 스크롤 없음(전술 화면)', `scrollW ${mob.scrollW} / vw ${mob.vw}`);
  ok(mob.mentBtns === 5 && mob.roleBtns >= 2, '모바일에서도 성향·역할 버튼이 모두 보임', `성향 ${mob.mentBtns} · 역할 ${mob.roleBtns}`);
  await page.evaluate(() => { const el = document.querySelector('.role-bar'); if (el) window.scrollTo(0, el.getBoundingClientRect().top + window.scrollY - 320); });
  await sleep(350);
  await page.screenshot({ path: `${SHOT_DIR}/fm-tactics-mobile.png` });
  // 경기 화면 모바일
  await page.getByRole('button', { name: /일정|경기/ }).first().click().catch(() => {});
  await page.getByRole('button', { name: /경기 시작/ }).first().click();
  await page.waitForSelector('#pitch', { timeout: 15000 });
  await page.getByRole('button', { name: '2x' }).click();
  await sleep(2500);
  const mobMatch = await page.evaluate(() => {
    const cv = document.getElementById('pitch')?.getBoundingClientRect();
    return { vw: window.innerWidth, scrollW: document.documentElement.scrollWidth, canvas: cv ? Math.round(cv.width) : null };
  });
  out.metrics.mobileMatch = mobMatch;
  ok(mobMatch.scrollW <= mobMatch.vw + 1 && mobMatch.canvas <= mobMatch.vw, '390px 경기 화면 가로 스크롤 없음', `피치 ${mobMatch.canvas}px / vw ${mobMatch.vw}`);
  await page.screenshot({ path: `${SHOT_DIR}/fm-mobile.png` });
  out.errors.push(...(await page.evaluate(() => window.__fm.errors || [])));
  await ctx.close();
}

await desk.ctx.close();
await browser.close();
writeFileSync(OUT, JSON.stringify(out, null, 2));
const failed = out.checks.filter((c) => !c.ok).length;
console.log(`\n${failed ? `❌ ${failed}건 실패` : '✅ 전부 통과'} · 오류 ${out.errors.length}건 · ${OUT}`);
process.exit(failed || out.errors.length ? 1 : 0);
