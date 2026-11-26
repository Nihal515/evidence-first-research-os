// AI agents end to end, against the real model on the live site: Planner search terms,
// Reader quotes (quote guard), Challenger with the 13% / 31% test, the AI level enforced,
// and the AI-use statement. Desktop and phone.
const { chromium } = require(process.env.PLAYWRIGHT_PATH || 'playwright');
const fs = require('fs');
const BASE = process.env.BASE || 'http://127.0.0.1:4173';
const OUT = process.env.OUT || 'e2e-output';
fs.mkdirSync(`${OUT}/shots`, { recursive: true });
const res = []; const ok = (n, c, x = '') => { const l = `${c ? 'PASS' : 'FAIL'} ${n}${x ? ' — ' + x : ''}`; res.push(l); console.log(l); };
const BLOOM = '10.1093/qje/qju032';

async function run(mobile) {
  const tag = mobile ? 'phone' : 'desktop';
  const b = await chromium.launch({ executablePath: process.env.CHROME_PATH || undefined, args: ['--ignore-certificate-errors'],
    proxy: BASE.startsWith('https') && process.env.HTTPS_PROXY ? { server: process.env.HTTPS_PROXY } : undefined });
  const ctx = await b.newContext(mobile ? { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, ignoreHTTPSErrors: true }
    : { viewport: { width: 1440, height: 900 }, ignoreHTTPSErrors: true });
  await ctx.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: BASE });
  const page = await ctx.newPage(); page.setDefaultTimeout(40000);
  const errors = []; page.on('pageerror', (e) => errors.push(String(e).slice(0, 200)));
  const shot = (n) => page.screenshot({ path: `${OUT}/shots/ai-${tag}-${n}.png`, fullPage: false });

  await page.goto(BASE + '/home');
  await page.getByLabel('Project title').fill(`AI journey ${tag}`);
  await page.getByLabel(/Research question/).fill('Does working from home change employee performance?');
  await page.getByRole('button', { name: 'Create project' }).click();
  await page.locator('.content').waitFor();

  // Planner
  await (mobile ? page.getByRole('button', { name: 'Add references' }).first() : page.locator('.btn-add')).click();
  const dlg = page.locator('.dialog'); await dlg.waitFor();
  await dlg.getByRole('button', { name: 'Suggest search terms with AI' }).click();
  const chips = dlg.locator('.ai-chip');
  await chips.first().waitFor({ timeout: 45000 }).catch(() => null);
  const n = await chips.count();
  const err = await dlg.locator('.error').allTextContents();
  ok(`${tag}: Planner suggests search terms`, n >= 3, n ? (await chips.allTextContents()).join(' | ') : err.join(' '));
  ok(`${tag}: Planner output is labelled AI suggestion`, (await dlg.locator('.ai-tag .lbl', { hasText: 'AI suggestion' }).count()) >= 1);
  if (n) {
    await chips.first().click();
    await dlg.locator('.cards .card').first().waitFor({ timeout: 40000 }).catch(() => null);
    const cards = await dlg.locator('.cards .card').count();
    ok(`${tag}: clicking a term searches the registries`, cards > 0, `${cards} results`);
    ok(`${tag}: results carry registry trust labels`, (await dlg.locator('.cards .card .lbl', { hasText: 'Verified' }).count()) > 0);
  }
  await shot('01-planner');
  await dlg.getByRole('button', { name: 'Close' }).click();

  // add Bloom et al. (the paper behind the landing page's 13% / 31% demo)
  const pid = await page.evaluate(() => localStorage.getItem('efro.projectId'));
  const st = await page.evaluate(async ([pid, doi]) => (await fetch(`/api/projects/${pid}/references`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ mode: 'doi', doi }) })).status, [pid, BLOOM]);
  ok(`${tag}: Bloom et al. added with one click (API)`, st === 201, String(st));
  await page.reload();
  const row = page.locator(mobile ? '.ref-card' : '.ref-table tbody tr').first();
  await row.waitFor();
  await row.locator(mobile ? '.ref-card-main' : 'td.col-title').click();

  // Reader
  const readBtn = page.getByRole('button', { name: 'Read the abstract with AI' });
  await readBtn.waitFor();
  await readBtn.click();
  await page.locator('.ai-reading').waitFor({ timeout: 45000 }).catch(() => null);
  const quotes = await page.locator('.ai-reading q').allTextContents();
  const rErr = await page.locator('.ai-tools .error').allTextContents();
  ok(`${tag}: Reader returns quotes from the abstract`, quotes.length >= 2, quotes.length ? `${quotes.length} quotes` : rErr.join(' '));
  const abstract = await page.evaluate(async ([pid]) => (await (await fetch(`/api/projects/${pid}/references`)).json())[0].abstract || '', [pid]);
  const norm = (s) => s.toLowerCase().replace(/[“”"’']/g, "'").replace(/\s+/g, ' ').trim();
  ok(`${tag}: every Reader quote is word for word in the abstract`, quotes.length > 0 && quotes.every((q) => norm(abstract).includes(norm(q).replace(/^'|'$/g, ''))));
  ok(`${tag}: quote guard result is shown`, (await page.getByText(/Quote guard \(code\)/).count()) === 1);
  await shot('02-reader');

  // Challenger: the 31% sentence must not pass; the 13% sentence should
  const box = page.locator('textarea[id^="claim-"]');
  await box.fill('Home working lifted employee performance by 31%.');
  await page.getByRole('button', { name: 'Check my sentence' }).click();
  await page.locator('.ai-verdict').waitFor({ timeout: 45000 }).catch(() => null);
  const v31 = (await page.locator('.ai-verdict').textContent().catch(() => '')) || (await page.locator('.ai-tools .error').allTextContents()).join(' ');
  ok(`${tag}: Challenger does not support the 31% sentence`, /Not supported as written|does not say|discarded/.test(v31) && !/Supported by the abstract/.test(v31), v31.slice(0, 160));
  await shot('03-challenger-31');
  await box.fill('Home working led to a 13% performance increase.');
  await page.getByRole('button', { name: 'Check my sentence' }).click();
  await page.waitForFunction(() => document.querySelector('.ai-verdict')?.textContent?.includes('13%') || document.querySelector('.ai-verdict')?.textContent?.includes('Supported'), null, { timeout: 45000 }).catch(() => null);
  const v13 = (await page.locator('.ai-verdict').textContent().catch(() => '')) || '';
  ok(`${tag}: Challenger answers the 13% sentence`, v13.length > 0, v13.slice(0, 160));

  // AI level enforced: set to 1, Reader and Challenger lock
  await page.getByRole('button', { name: mobile ? 'Back to library' : 'Close details' }).click();
  if (mobile) await page.locator('.tabs-bottom').getByRole('button', { name: 'Project' }).click();
  else await page.locator('.rail').getByRole('button', { name: 'Project' }).click();
  await page.getByRole('radio', { name: /1\s*Find and check/ }).click();
  await page.getByRole('radio', { name: /1\s*Find and check/, checked: true }).waitFor();
  const deny = await page.evaluate(async ([pid]) => {
    const refs = await (await fetch(`/api/projects/${pid}/references`)).json();
    return (await fetch(`/api/projects/${pid}/references/${refs[0].id}/ai/read?refresh=true`, { method: 'POST' })).status;
  }, [pid]);
  ok(`${tag}: at level 1 the server refuses the Reader`, deny === 403, String(deny));
  ok(`${tag}: dial shows Reader locked`, (await page.locator('.ai-agents li[data-on="false"]', { hasText: 'Reader' }).count()) === 1);
  await shot('04-dial');
  await page.getByRole('radio', { name: /3\s*Challenge my draft/ }).click();

  // AI-use statement lists the AI use
  if (mobile) await page.locator('.tabs-bottom').getByRole('button', { name: 'AI use' }).click();
  else await page.locator('.rail').getByRole('button', { name: 'AI-use statement' }).click();
  await page.locator('.statement').waitFor();
  await page.waitForFunction(() => (document.querySelector('.statement')?.value || '').includes('generative AI'), null, { timeout: 20000 }).catch(() => null);
  const statement = await page.locator('.statement').inputValue();
  ok(`${tag}: AI-use statement lists the AI features and model`, /suggest search terms/.test(statement) && /Gemini|Groq/.test(statement) && /word for word/.test(statement), statement.slice(0, 400));
  await shot('05-statement');
  ok(`${tag}: no page errors`, errors.length === 0, errors.join(' | '));
  await b.close();
}

(async () => {
  try { await run(false); await run(true); } catch (e) { ok('journey completed', false, String(e).slice(0, 300)); }
  const f = res.filter((r) => r.startsWith('FAIL')).length;
  console.log(`\n${res.length - f}/${res.length} passed`);
  fs.writeFileSync(`${OUT}/ai_results.txt`, res.join('\n') + '\n');
  process.exit(f ? 1 : 0);
})();
