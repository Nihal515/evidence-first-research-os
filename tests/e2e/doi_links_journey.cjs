// Add three papers, then check the library's links: every DOI opens doi.org, free copies open separately.
const { chromium } = require(process.env.PLAYWRIGHT_PATH || 'playwright');
const BASE = process.env.BASE || 'http://127.0.0.1:4173';
const res = []; const ok = (n, c, x = '') => { const l = `${c ? 'PASS' : 'FAIL'} ${n}${x ? ' — ' + x : ''}`; res.push(l); console.log(l); };
(async () => {
  for (const mobile of [false, true]) {
    const tag = mobile ? 'phone' : 'desktop';
    const b = await chromium.launch({ executablePath: process.env.CHROME_PATH, proxy: BASE.startsWith('https') ? { server: process.env.HTTPS_PROXY } : undefined, args: ['--ignore-certificate-errors'] });
    const ctx = await b.newContext(mobile ? { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, ignoreHTTPSErrors: true } : { viewport: { width: 1440, height: 900 }, ignoreHTTPSErrors: true });
    const page = await ctx.newPage(); page.setDefaultTimeout(30000);
    await page.goto(BASE + '/home');
    await page.getByLabel('Project title').fill(`DOI links ${tag}`);
    await page.getByRole('button', { name: 'Create project' }).click();
    await page.locator('.content').waitFor();
    const pid = await page.evaluate(() => localStorage.getItem('efro.projectId'));
    // approve three papers through the same API the Add button uses
    for (const doi of ['10.1126/science.adh2586', '10.1002/sd.3221', '10.1109/jiot.2023.3278329']) {
      const r = await page.evaluate(async ([pid, doi]) => (await fetch(`/api/projects/${pid}/references`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ mode: 'doi', doi }) })).status, [pid, doi]);
      ok(`${tag}: added ${doi}`, r === 201, String(r));
    }
    await page.reload();
    const sel = mobile ? '.ref-card' : '.ref-table tbody tr';
    await page.locator(sel).first().waitFor();
    for (const doi of ['10.1126/science.adh2586', '10.1002/sd.3221', '10.1109/jiot.2023.3278329']) {
      const link = page.locator(`a[href="https://doi.org/${doi}"][aria-label^="Open the article page"]`);
      ok(`${tag}: ${doi} has an Open article link to doi.org`, (await link.count()) === 1);
    }
    // click one: the new tab lands on doi.org / the publisher
    const [tab] = await Promise.all([ctx.waitForEvent('page'), page.locator('a[href="https://doi.org/10.1126/science.adh2586"][aria-label^="Open the article page"]').click()]);
    await tab.waitForLoadState('domcontentloaded').catch(() => null);
    const u = tab.url();
    ok(`${tag}: clicking it opens the DOI page`, /doi\.org\/10\.1126|science\.org\/doi\/10\.1126/.test(u), u.slice(0, 90));
    await tab.close();
    // free copies: arXiv PDF stays a separate link; Wiley publisher copy collapses into the article page
    ok(`${tag}: arXiv free PDF is a separate link`, (await page.locator('a[href="https://arxiv.org/pdf/2111.09673"]').count()) === 1);
    ok(`${tag}: no Wiley pdfdirect link`, (await page.locator('a[href*="pdfdirect"]').count()) === 0);
    const ssrn = await page.locator('a[href="https://doi.org/10.2139/ssrn.4375283"]').getAttribute('aria-label').catch(() => '');
    ok(`${tag}: SSRN preprint is labelled as a free preprint copy`, /preprint/.test(ssrn || ''), ssrn || '');
    // detail panel has the Open article button
    await page.locator(sel).filter({ hasText: 'productivity effects' }).first().locator(mobile ? '.ref-card-main' : 'td.col-title').click();
    const btn = page.getByRole('link', { name: 'Open article (doi.org)' });
    await btn.waitFor();
    ok(`${tag}: details have Open article (doi.org)`, (await btn.getAttribute('href')) === 'https://doi.org/10.1126/science.adh2586');
    await page.screenshot({ path: `${process.env.OUT || '/tmp'}/doi-${tag}.png` });
    await b.close();
  }
  const f = res.filter((r) => r.startsWith('FAIL')).length; console.log(`${res.length - f}/${res.length} passed`); process.exit(f ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
