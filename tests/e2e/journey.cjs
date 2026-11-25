// End-to-end journey for the library redesign, on desktop and phone viewports.
// Covers the five must-pass checks plus collections, favourites, Trash, details,
// exports and import. All checks run against live Crossref / doi.org / OpenAlex.
const { chromium } = require(process.env.PLAYWRIGHT_PATH || 'playwright');
const fs = require('fs');
const BASE = process.env.BASE || 'http://127.0.0.1:4173';
const OUT = process.env.OUT || 'e2e-output';
fs.mkdirSync(`${OUT}/shots`, { recursive: true });
const results = [];
let CURRENT = null;
const ok = (name, cond, extra = '') => { const line = `${cond ? 'PASS' : 'FAIL'} ${name}${extra ? ' — ' + extra : ''}`; results.push(line); console.log(line); };
const LECUN_APA = 'LeCun, Y., Bengio, Y., & Hinton, G. (2015). Deep learning. Nature, 521(7553), 436–444. https://doi.org/10.1038/nature14539';

async function run(mobile) {
  const tag = mobile ? 'phone' : 'desktop';
  const browser = await chromium.launch({
    executablePath: process.env.CHROME_PATH || undefined,
    proxy: BASE.startsWith('https') && process.env.HTTPS_PROXY ? { server: process.env.HTTPS_PROXY } : undefined,
  });
  const context = await browser.newContext(mobile
    ? { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2, acceptDownloads: true }
    : { viewport: { width: 1440, height: 900 }, acceptDownloads: true });
  await context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: BASE });
  const page = await context.newPage();
  page.setDefaultTimeout(20000);
  CURRENT = page;
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e).slice(0, 160)));
  const shot = (n) => page.screenshot({ path: `${OUT}/shots/${tag}-${n}.png` });
  const rows = () => page.locator(mobile ? '.ref-card' : '.ref-table tbody tr');
  const dialog = () => page.locator('.dialog');
  const openAdd = async () => {
    await (mobile ? page.getByRole('button', { name: 'Add references' }).first() : page.locator('.btn-add')).click();
    await dialog().waitFor();
  };
  const closeAdd = async () => { await dialog().getByRole('button', { name: 'Close' }).click(); await dialog().waitFor({ state: 'detached' }); };
  const goView = async (name) => {
    if (mobile) await page.getByRole('button', { name: 'Open library menu' }).click();
    await page.locator('.sidebar').getByRole('button', { name: new RegExp(`^${name}`) }).first().click();
    if (mobile) await page.locator('.drawer').waitFor({ state: 'detached' });
  };
  const goPage = async (full, short) => {
    if (mobile) await page.locator(`.tabs-bottom button:has-text("${short}")`).click();
    else await page.getByRole('button', { name: full, exact: true }).click();
  };
  const check = async () => {
    await dialog().getByRole('button', { name: /^Check live$/ }).click();
    await dialog().locator('.result').waitFor({ timeout: 45000 });
    return (await dialog().locator('.result .lbl').first().innerText()).trim();
  };

  // ------------------------------------------------------------ project
  await page.goto(BASE);
  await page.getByRole('heading', { name: 'Start a research project' }).waitFor();
  await page.getByLabel('Project title').fill('AI tutoring in secondary schools (test)');
  await page.getByLabel(/Research question/).fill('Does AI tutoring improve maths outcomes?');
  await page.getByRole('button', { name: 'Create project' }).click();
  await page.getByRole('heading', { name: 'Your library is empty' }).waitFor();
  await page.reload();
  await page.getByRole('heading', { name: 'Your library is empty' }).waitFor();
  ok(`[${tag}] project created and kept after reload`, true);

  const legend = await page.locator('.legend').innerText();
  ok(`[${tag}] trust labels explained on screen (all four)`,
    ['Verified', 'Not yet verified', 'AI suggestion', 'Not found'].every((l) => legend.includes(l)) && legend.includes('No match in the databases checked'));
  await page.locator('.legend-more').click();
  ok(`[${tag}] full label meanings one click away`, (await page.locator('.legend').innerText()).includes('It may not exist'));
  await shot('01-empty');

  // ------------------------------------------------------------ collection
  if (mobile) await page.getByRole('button', { name: 'Open library menu' }).click();
  await page.locator('.sidebar').getByRole('button', { name: 'New collection', exact: true }).click();
  await page.getByLabel('New collection name').fill('Chapter 2');
  await page.getByRole('button', { name: 'Create collection' }).click();
  await page.locator('.side-coll', { hasText: 'Chapter 2' }).waitFor();
  ok(`[${tag}] collection created`, true);
  if (mobile) await page.getByRole('button', { name: 'Close menu' }).click();

  // ------------------------------------------------------------ 1. fake reference test
  await openAdd();
  await dialog().getByRole('tab', { name: 'Check a reference' }).click();
  await dialog().getByLabel('Title').fill('Quantum banana cognition in Martian classrooms');
  await dialog().getByLabel('Authors').fill('Zxqvort, T.');
  await dialog().getByLabel('Year').fill('2024');
  await dialog().getByLabel(/DOI/).fill('10.1234/this-doi-does-not-exist-2026');
  let label = await check();
  await shot('02-fake');
  ok(`[${tag}] made-up DOI is Not found`, label === 'Not found', label);
  ok(`[${tag}] no approve button for a fake reference`, (await dialog().locator('.result button:has-text("Approve")').count()) === 0);
  ok(`[${tag}] fake reference says it was not added`, (await dialog().locator('.result').innerText()).includes('Not added'));
  await dialog().getByLabel(/DOI/).fill('');
  label = await check();
  ok(`[${tag}] made-up title and author (no DOI) is Not found`, label === 'Not found', label);
  await dialog().getByLabel(/DOI/).fill('10.1038/nature14539');
  await dialog().getByLabel('Authors').fill('');
  await dialog().getByLabel('Year').fill('');
  label = await check();
  ok(`[${tag}] real DOI with made-up title is Not found`, label === 'Not found' && (await dialog().locator('.result-reason').innerText()).includes('belongs to'), label);

  // ------------------------------------------------------------ 2. real reference, one-click approval
  await dialog().getByRole('tab', { name: 'Paste a reference' }).click();
  await dialog().getByLabel('Full reference or DOI').fill('LeCun, Y., Bengio, Y., & Hinton, G. (2015). Deep learning. Nature, 521(7553), 436–444.');
  label = await check();
  ok(`[${tag}] real pasted reference is Verified`, label === 'Verified', label);
  await dialog().locator('.result button:has-text("Approve & add to library")').click();
  await dialog().locator('.result .pill-done').waitFor({ timeout: 45000 });
  ok(`[${tag}] one click adds the verified reference`, true);

  // ------------------------------------------------------------ 3. search adds nothing until approved
  await dialog().getByRole('tab', { name: 'Search databases' }).click();
  await dialog().getByLabel('Search scholarly records').fill('Reducing the dimensionality of data with neural networks Hinton Salakhutdinov');
  await dialog().getByRole('button', { name: /^Search$/ }).click();
  await dialog().locator('.cards .card').first().waitFor({ timeout: 45000 });
  const firstLabel = (await dialog().locator('.cards .card .lbl').first().innerText()).trim();
  ok(`[${tag}] search results carry a trust label`, firstLabel === 'Verified', firstLabel);
  await closeAdd();
  ok(`[${tag}] searching added nothing automatically`, (await rows().count()) === 1, String(await rows().count()));
  await openAdd();
  await dialog().getByLabel('Search scholarly records').fill('Reducing the dimensionality of data with neural networks Hinton Salakhutdinov');
  await dialog().getByRole('button', { name: /^Search$/ }).click();
  await dialog().locator('.cards .card').first().waitFor({ timeout: 45000 });
  await shot('03-search');
  await dialog().locator('.cards .card').first().locator('button:has-text("Approve & add")').click();
  await dialog().locator('.cards .card').first().locator('.pill-done').waitFor({ timeout: 45000 });

  // ------------------------------------------------------------ import (BibTeX): real duplicate + made-up entry
  await dialog().getByRole('tab', { name: 'Import file' }).click();
  const bib = `@article{lecun2015, title={Deep learning}, author={LeCun, Yann and Bengio, Yoshua and Hinton, Geoffrey}, year={2015}, doi={10.1038/nature14539}}
@article{fake2023, title={Holographic empathy engines for lunar schools}, author={Quillbright, Tamsin}, year={2023}}`;
  await dialog().locator('input[type=file]').setInputFiles({ name: 'library.bib', mimeType: 'text/plain', buffer: Buffer.from(bib) });
  await dialog().locator('.import-row').nth(1).waitFor();
  await dialog().getByRole('button', { name: /Check all 2 live/ }).click();
  await dialog().locator('.import-row').nth(1).locator('.lbl').waitFor({ timeout: 60000 });
  await page.waitForTimeout(300);
  const imp = await dialog().locator('.import-list').innerText();
  ok(`[${tag}] import: existing paper recognised, made-up one Not found and not added`,
    imp.includes('Already in library') && imp.includes('Not found') && imp.includes('Not added'), imp.replace(/\s+/g, ' ').slice(0, 90));
  await shot('04-import');
  await closeAdd();

  // ------------------------------------------------------------ library
  await rows().nth(1).waitFor();
  ok(`[${tag}] library shows the 2 approved sources`, (await rows().count()) === 2, String(await rows().count()));
  const lbls = await rows().locator('.lbl').allInnerTexts();
  ok(`[${tag}] every reference shows a trust label`, lbls.length === 2 && lbls.every((l) => l.trim() === 'Verified'), lbls.join(','));
  await rows().first().locator('button.star').click();
  await page.waitForTimeout(600);
  await goView('Favourites');
  ok(`[${tag}] favourite filed under Favourites`, (await rows().count()) === 1);
  await goView('All references');

  if (mobile) await page.getByRole('button', { name: 'Select', exact: true }).click();
  for (let i = 0; i < 2; i++) await rows().nth(i).locator('input[type=checkbox]').check();
  await page.locator('.bulk-bar').getByRole('button', { name: /Add to collection/ }).click();
  await page.locator('.bulk-bar .menu').getByRole('menuitem', { name: 'Chapter 2' }).click();
  await page.locator('.notice-ok').waitFor();
  ok(`[${tag}] bulk-filed into a collection`, (await page.locator('.notice-ok').innerText()).includes('Filed 2'));
  await goView('Chapter 2');
  await rows().nth(1).waitFor({ timeout: 10000 }).catch(() => {});
  ok(`[${tag}] collection shows its references`, (await rows().count()) === 2, String(await rows().count()));
  await shot('05-collection');
  await goView('All references');

  // detail + APA 7 cite box
  await rows().filter({ hasText: 'Deep learning' }).first().locator(mobile ? '.ref-card-main' : 'td.col-title').click();
  await page.locator('.detail').waitFor();
  const cite = (await page.locator('.detail .apa-one').innerText()).trim();
  ok(`[${tag}] detail panel shows the exact APA 7 reference`, cite === LECUN_APA, cite.slice(0, 50));
  ok(`[${tag}] detail panel explains the label`, (await page.locator('.detail').innerText()).includes('WHY THIS LABEL'));
  await shot('06-detail');
  // trash and restore
  await page.locator('.detail').getByRole('button', { name: 'Move to Trash' }).click();
  await page.locator('.detail').waitFor({ state: 'detached' });
  await page.waitForTimeout(500);
  ok(`[${tag}] moved to Trash leaves 1 in the library`, (await rows().count()) === 1);
  await goView('Trash');
  ok(`[${tag}] Trash holds it`, (await rows().count()) === 1);
  await rows().first().locator(mobile ? '.ref-card-main' : 'td.col-title').click();
  await page.locator('.detail').getByRole('button', { name: 'Restore' }).click();
  await page.locator('.detail .success').waitFor();
  if (mobile) await page.getByRole('button', { name: 'Back to library' }).click();
  else await page.getByRole('button', { name: 'Close details' }).click();
  await goView('All references');
  ok(`[${tag}] restored from Trash`, (await rows().count()) === 2);

  // ------------------------------------------------------------ 4. APA 7 list
  await goPage('Reference list (APA 7)', 'APA list');
  await page.locator('.apa-entry').first().waitFor();
  const entries = await page.locator('.apa-entry').allInnerTexts();
  ok(`[${tag}] APA 7 entry is exact`, entries.includes(LECUN_APA), entries[0]?.slice(0, 40));
  ok(`[${tag}] APA list sorted by author`, entries.length === 2 && entries[0] < entries[1], entries.map((e) => e.slice(0, 10)).join(' | '));
  await page.getByRole('button', { name: 'Copy APA 7 list' }).click();
  await page.locator('.export .success').waitFor();
  const clip = await page.evaluate(() => navigator.clipboard.readText());
  ok(`[${tag}] copy puts the APA list on the clipboard`, clip.includes('LeCun, Y., Bengio, Y., & Hinton, G. (2015)'));
  const [dl] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: 'Download Word (.docx)' }).click()]);
  await dl.saveAs(`${OUT}/${tag}-references.docx`);
  ok(`[${tag}] Word download saved`, fs.statSync(`${OUT}/${tag}-references.docx`).size > 2000);
  const [bibDl] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: 'Download BibTeX (.bib)' }).click()]);
  await bibDl.saveAs(`${OUT}/${tag}-references.bib`);
  const bibText = fs.readFileSync(`${OUT}/${tag}-references.bib`, 'utf8');
  ok(`[${tag}] BibTeX download`, bibText.includes('@article{lecun2015deep') && bibText.includes('doi = {10.1038/nature14539}'));
  const [risDl] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: 'Download RIS (.ris)' }).click()]);
  await risDl.saveAs(`${OUT}/${tag}-references.ris`);
  ok(`[${tag}] RIS download`, fs.readFileSync(`${OUT}/${tag}-references.ris`, 'utf8').includes('DO  - 10.1038/nature14539'));
  await shot('07-apa');

  // ------------------------------------------------------------ 5. AI-use statement
  await goPage('AI-use statement', 'AI use');
  await page.locator('textarea.statement').waitFor();
  const statement = await page.locator('textarea.statement').inputValue();
  ok(`[${tag}] statement reports the real checks`, /It checked \d+ references live against/.test(statement));
  ok(`[${tag}] statement reports one-click approval`, statement.includes('I approved each of the 2 sources in my reference list myself with one click'));
  ok(`[${tag}] statement says no generative AI was used`, statement.includes('No generative AI was used'));
  await page.getByRole('button', { name: 'Copy statement' }).click();
  await page.locator('.panel .success').waitFor();
  ok(`[${tag}] statement copies to the clipboard`, (await page.evaluate(() => navigator.clipboard.readText())).startsWith('AI-use statement'));
  ok(`[${tag}] activity log is shown`, (await page.locator('.log li').count()) >= 8);
  await shot('08-statement');

  if (mobile) {
    await goPage('Library', 'Library');
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1);
    ok('[phone] no sideways scrolling on a phone screen', !overflow);
  }
  ok(`[${tag}] no JavaScript errors`, errors.length === 0, errors.join(' | '));
  await browser.close();
}

(async () => {
  const which = process.env.ONLY ? [process.env.ONLY === 'phone'] : [false, true];
  for (const mobile of which) {
    try { await run(mobile); } catch (e) { if (CURRENT) await CURRENT.screenshot({ path: `${OUT}/shots/crash-${mobile ? 'phone' : 'desktop'}.png` }).catch(() => {}); const m = `FAIL ${mobile ? 'phone' : 'desktop'} crashed: ` + e.message.split('\n')[0]; results.push(m); console.log(m); }
  }
  console.log(`\n${results.filter((r) => r.startsWith('PASS')).length} passed, ${results.filter((r) => r.startsWith('FAIL')).length} failed`);
})();
