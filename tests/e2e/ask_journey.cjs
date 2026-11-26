// Ask: one research question through all nine agents with both human checkpoints, the live
// flow diagram and the AI agents (when AI is set up). Desktop and phone.
const { chromium } = require(process.env.PLAYWRIGHT_PATH || 'playwright');
const fs = require('fs');
const BASE = process.env.BASE || 'http://127.0.0.1:4173';
const OUT = process.env.OUT || 'e2e-output';
const AI = process.env.AI !== '0';
fs.mkdirSync(`${OUT}/shots`, { recursive: true });
const res = []; const ok = (n, c, x = '') => { const l = `${c ? 'PASS' : 'FAIL'} ${n}${x ? ' — ' + x : ''}`; res.push(l); console.log(l); };

async function run(mobile) {
  const tag = mobile ? 'phone' : 'desktop';
  const b = await chromium.launch({ executablePath: process.env.CHROME_PATH || undefined, args: ['--ignore-certificate-errors'],
    proxy: BASE.startsWith('https') && process.env.HTTPS_PROXY ? { server: process.env.HTTPS_PROXY } : undefined });
  const ctx = await b.newContext(mobile ? { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, ignoreHTTPSErrors: true }
    : { viewport: { width: 1440, height: 900 }, ignoreHTTPSErrors: true });
  await ctx.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: BASE });
  const page = await ctx.newPage(); page.setDefaultTimeout(40000);
  const errors = []; page.on('pageerror', (e) => errors.push(String(e).slice(0, 200)));
  const shot = (n, full = false) => page.screenshot({ path: `${OUT}/shots/ask-${tag}-${n}.png`, fullPage: full });
  const status = (name) => page.evaluate((n) => {
    const svg = [...document.querySelectorAll('.flow-node')].find((g) => g.querySelector('.flow-name')?.textContent === n);
    if (svg) return [...svg.classList].find((c) => c.startsWith('st-'))?.slice(3);
    const li = [...document.querySelectorAll('.flow-v li')].find((l) => l.querySelector('b')?.textContent === n);
    return li?.dataset.status;
  }, name);

  await page.goto(BASE + '/home');
  await page.getByLabel('Project title').fill(`Ask journey ${tag}`);
  await page.getByLabel(/Research question/).fill('Does working from home change employee performance?');
  await page.getByRole('button', { name: 'Create project' }).click();
  await page.locator('.content').waitFor();
  if (mobile) await page.locator('.tabs-bottom').getByRole('button', { name: 'Ask' }).click();
  else await page.locator('.rail').getByRole('button', { name: /Ask/ }).click();
  await page.getByRole('heading', { level: 1, name: 'Ask Paper Trail' }).waitFor();
  ok(`${tag}: Ask page opens at /ask`, page.url().endsWith('/ask'));
  ok(`${tag}: flow shows all 12 steps`, (await page.locator(mobile ? '.flow-v li' : '.flow-node').count()) === 12);
  ok(`${tag}: question is pre-filled from the project`, (await page.getByLabel('Research question').inputValue()).includes('working from home'));
  await page.getByLabel('Sources you need').selectOption('3');
  await page.getByLabel('Published from').fill('2010');
  await page.getByLabel(/Must-include keywords/).fill('remote work');
  await page.getByLabel(/Sentences from your draft/).fill('Home working lifted employee performance by 31%.');
  await shot('01-ask');
  await page.getByRole('button', { name: 'Start the research flow' }).click();

  // checkpoint 1
  await page.getByRole('button', { name: /Approve \d+ terms and search/ }).waitFor({ timeout: 45000 });
  ok(`${tag}: run stops at checkpoint 1 (You approve)`, (await status('You approve')) === 'waiting');
  ok(`${tag}: Planner ${AI ? 'done' : 'handled'}`, AI ? (await status('Planner')) === 'done' : ['done', 'error'].includes(await status('Planner')), await status('Planner'));
  const terms = await page.locator('.ask-term').evaluateAll((els) => els.map((e) => e.value));
  ok(`${tag}: search terms listed`, terms.length >= 1, terms.join(' | '));
  if (AI) ok(`${tag}: Planner terms labelled AI suggestion`, (await page.locator('#step-planner .lbl', { hasText: 'AI suggestion' }).count()) === 1);
  // keep 3 terms to be quick
  const boxes = page.locator('.ask-terms input[type="checkbox"]');
  for (let i = 3; i < (await boxes.count()); i++) await boxes.nth(i).uncheck();
  await shot('02-gate1');
  await page.getByRole('button', { name: /Approve \d+ terms and search/ }).click();

  // Scout → Checker → Analyst → checkpoint 2
  await page.waitForTimeout(1500);
  ok(`${tag}: Scout runs after approval`, ['running', 'done'].includes(await status('Scout')), await status('Scout'));
  await page.getByRole('button', { name: /Add \d+ to my library and continue/ }).waitFor({ timeout: 150000 });
  ok(`${tag}: Scout, Checker and Analyst done`, (await status('Scout')) === 'done' && (await status('Checker')) === 'done' && (await status('Analyst')) === 'done',
    `${await status('Scout')}/${await status('Checker')}/${await status('Analyst')}`);
  ok(`${tag}: run stops at checkpoint 2 (You choose)`, (await status('You choose')) === 'waiting');
  const cands = await page.locator('.ask-cand').count();
  const labelled = await page.locator('.ask-cand .lbl').count();
  ok(`${tag}: candidates checked and labelled`, cands > 0 && labelled === cands, `${labelled}/${cands}`);
  ok(`${tag}: relevance bars from the Analyst`, (await page.locator('.ask-rel').count()) > 0);
  const ticked = await page.locator('.ask-cand input:checked').count();
  ok(`${tag}: Analyst pre-ticked the top 3, nothing added yet`, ticked === 3 && (await page.locator('.ask-cand .pill-done').count()) === 0, String(ticked));
  const libBefore = await page.evaluate(async () => (await (await fetch(`/api/projects/${localStorage.getItem('efro.projectId')}/references`)).json()).length);
  ok(`${tag}: library still empty before your click`, libBefore === 0, String(libBefore));
  await shot('03-gate2', true);
  await page.getByRole('button', { name: /Add \d+ to my library and continue/ }).click();

  // Reader → Quote guard → Challenger → Reviewer → Clerk
  await page.getByRole('button', { name: /Copy APA 7 list/ }).waitFor({ timeout: 150000 });
  ok(`${tag}: Clerk done at the end`, (await status('Clerk')) === 'done');
  const libAfter = await page.evaluate(async () => (await (await fetch(`/api/projects/${localStorage.getItem('efro.projectId')}/references`)).json()).length);
  ok(`${tag}: 3 sources added by your click`, libAfter === 3, String(libAfter));
  if (AI) {
    ok(`${tag}: Reader quoted the kept sources`, (await status('Reader')) === 'done' && (await page.locator('#step-reader .ask-read q').count()) > 0);
    ok(`${tag}: Quote guard ran`, (await status('Quote guard')) === 'done');
    const v = (await page.locator('#step-challenger').textContent().catch(() => '')) || '';
    ok(`${tag}: Challenger tested the 31% claim`, /Not supported as written|does not say|discarded|Supported by the abstract/.test(v), v.slice(0, 200));
  }
  const review = await page.locator('.ask-review li').count();
  ok(`${tag}: Reviewer lists what a marker could question`, review >= 4, String(review));
  await page.getByRole('button', { name: /Copy APA 7 list/ }).click();
  await page.locator('#step-clerk .notice').waitFor();
  ok(`${tag}: APA 7 list copied`, /Copied/i.test(await page.locator('#step-clerk .notice').textContent()));
  await shot('04-done', true);
  await page.evaluate(() => window.scrollTo(0, 0));
  await shot('05-flow');
  await page.getByRole('button', { name: 'Open the AI-use statement' }).click().catch(async () => {
    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
  });
  await page.locator('.statement').waitFor();
  await page.waitForFunction(() => (document.querySelector('.statement')?.value || '').includes('guided workflow'), null, { timeout: 15000 }).catch(() => null);
  ok(`${tag}: statement records the guided workflow`, (await page.locator('.statement').inputValue()).includes('guided workflow'));
  ok(`${tag}: no page errors`, errors.length === 0, errors.join(' | '));
  await b.close();
}

(async () => {
  try { await run(false); await run(true); } catch (e) { ok('journey completed', false, String(e).slice(0, 400)); }
  const f = res.filter((r) => r.startsWith('FAIL')).length;
  console.log(`\n${res.length - f}/${res.length} passed`);
  process.exit(f ? 1 : 0);
})();
