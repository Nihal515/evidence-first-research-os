// "Your paper": upload the SAMPLE draft (Word and PDF), find its references and citations,
// check every reference live, add the Verified ones with one click, and (when AI is set up)
// let the Challenger test the sentence that misquotes a number. Desktop and phone.
const { chromium } = require(process.env.PLAYWRIGHT_PATH || 'playwright');
const fs = require('fs');
const path = require('path');
const BASE = process.env.BASE || 'http://127.0.0.1:4173';
const OUT = process.env.OUT || 'e2e-output';
const AI = process.env.AI !== '0';
const FIX = path.join(__dirname, 'fixtures');
fs.mkdirSync(`${OUT}/shots`, { recursive: true });
const res = []; const ok = (n, c, x = '') => { const l = `${c ? 'PASS' : 'FAIL'} ${n}${x ? ' — ' + x : ''}`; res.push(l); console.log(l); };

async function run(mobile) {
  const tag = mobile ? 'phone' : 'desktop';
  const b = await chromium.launch({ executablePath: process.env.CHROME_PATH || undefined, args: ['--ignore-certificate-errors'],
    proxy: BASE.startsWith('https') && process.env.HTTPS_PROXY ? { server: process.env.HTTPS_PROXY } : undefined });
  const ctx = await b.newContext(mobile ? { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, ignoreHTTPSErrors: true }
    : { viewport: { width: 1440, height: 900 }, ignoreHTTPSErrors: true });
  const page = await ctx.newPage(); page.setDefaultTimeout(40000);
  const errors = []; page.on('pageerror', (e) => errors.push(String(e).slice(0, 200)));
  const shot = (n) => page.screenshot({ path: `${OUT}/shots/paper-${tag}-${n}.png`, fullPage: true });
  const tiles = async () => Object.fromEntries(await page.locator('.paper-tiles li').evaluateAll((els) => els.map((e) => [e.querySelector('span').textContent.replace(/ under.*| found/, ''), Number(e.querySelector('b').textContent)])));

  await page.goto(BASE + '/home');
  await page.getByLabel('Project title').fill(`Paper journey ${tag}`);
  await page.getByRole('button', { name: 'Create project' }).click();
  await page.locator('.content').waitFor();
  if (mobile) await page.locator('.tabs-bottom').getByRole('button', { name: 'Paper' }).click();
  else await page.locator('.rail').getByRole('button', { name: /Your paper/ }).click();
  await page.getByRole('heading', { level: 1, name: 'Your paper' }).waitFor();
  ok(`${tag}: Your paper page opens at /paper`, page.url().endsWith('/paper'));

  const formats = mobile ? ['docx'] : ['pdf', 'docx'];
  for (const fmt of formats) {
    await page.getByLabel(/Upload your paper/).setInputFiles(path.join(FIX, `SAMPLE-draft.${fmt}`));
    await page.getByText(`Loaded SAMPLE-draft.${fmt}`).waitFor();
    const t = await tiles();
    ok(`${tag}: ${fmt} — 5 references found`, t['References'] === 5, JSON.stringify(t));
    ok(`${tag}: ${fmt} — 5 in-text citations found`, t['In-text citations'] === 5);
    ok(`${tag}: ${fmt} — 1 citation not in the list (Smith & Jones, 2020)`, t['Cited but not in your list'] === 1 &&
      (await page.locator('.paper-cite[data-ok="false"] code').allTextContents()).join(' ').includes('Smith & Jones, 2020'));
    ok(`${tag}: ${fmt} — 1 reference never cited (Okafor)`, t['Listed but never cited'] === 1 &&
      (await page.locator('.paper-refs li', { hasText: 'Not cited anywhere' }).textContent()).includes('Okafor'));
  }
  await shot('01-loaded');

  await page.getByRole('button', { name: 'Check all 5 live' }).click();
  await page.waitForFunction(() => document.querySelector('.paper-refs') && [...document.querySelectorAll('.paper-refs .lbl')].length >= 5, null, { timeout: 90000 }).catch(() => null);
  const labels = await page.locator('.paper-refs li').evaluateAll((els) => els.map((e) => (e.querySelector('.lbl')?.textContent || '-') + ' ' + e.querySelector('.paper-ref-text').textContent.slice(3, 14)));
  ok(`${tag}: Bloom, LeCun and Noy Verified`, ['Bloom', 'LeCun', 'Noy'].every((n) => labels.some((l) => l.startsWith('Verified') && l.includes(n))), labels.join(' | '));
  ok(`${tag}: invented Hargrove reference is not Verified`, labels.some((l) => l.includes('Hargrove') && !l.startsWith('Verified')));
  ok(`${tag}: Okafor (invented) is not Verified`, labels.some((l) => l.includes('Okafor') && !l.startsWith('Verified')));
  ok(`${tag}: a Not found reference cannot be added`, (await page.locator('.paper-refs li', { hasText: 'Hargrove' }).getByRole('button', { name: 'Add to library' }).count()) === 0);

  await page.getByRole('button', { name: /Add all 3 Verified/ }).click();
  await page.waitForFunction(() => document.querySelectorAll('.paper-refs .pill-done').length >= 3, null, { timeout: 60000 }).catch(() => null);
  ok(`${tag}: 3 Verified references added with one click`, (await page.locator('.paper-refs .pill-done').count()) === 3);
  await shot('02-checked');

  if (AI) {
    const cite = page.locator('.paper-cite', { hasText: '31%' });
    await cite.getByRole('button', { name: 'Check this sentence with AI' }).click();
    await cite.locator('.ai-verdict').waitFor({ timeout: 45000 }).catch(() => null);
    const v = (await cite.locator('.ai-verdict').textContent().catch(() => '')) || (await cite.locator('.error').textContent().catch(() => ''));
    ok(`${tag}: AI Challenger does not support the 31% sentence from the paper`, /Not supported as written|does not say|discarded/.test(v) && !/Supported by the abstract/.test(v), v.slice(0, 180));
    await shot('03-ai');
  }

  // library has the 3 sources; statement mentions the draft
  if (mobile) await page.locator('.tabs-bottom').getByRole('button', { name: 'Library' }).click();
  else await page.locator('.rail').getByRole('button', { name: 'Library' }).click();
  const rows = page.locator(mobile ? '.ref-card' : '.ref-table tbody tr');
  await rows.first().waitFor();
  ok(`${tag}: library shows the 3 added sources`, (await rows.count()) === 3);
  if (mobile) await page.locator('.tabs-bottom').getByRole('button', { name: 'AI use' }).click();
  else await page.locator('.rail').getByRole('button', { name: 'AI-use statement' }).click();
  await page.locator('.statement').waitFor();
  await page.waitForFunction(() => (document.querySelector('.statement')?.value || '').includes('draft'), null, { timeout: 15000 }).catch(() => null);
  ok(`${tag}: statement records that the draft was read in the browser`, (await page.locator('.statement').inputValue()).includes('read my draft in the browser'));
  ok(`${tag}: no page errors`, errors.length === 0, errors.join(' | '));
  await b.close();
}

(async () => {
  try { await run(false); await run(true); } catch (e) { ok('journey completed', false, String(e).slice(0, 300)); }
  const f = res.filter((r) => r.startsWith('FAIL')).length;
  console.log(`\n${res.length - f}/${res.length} passed`);
  process.exit(f ? 1 : 0);
})();
