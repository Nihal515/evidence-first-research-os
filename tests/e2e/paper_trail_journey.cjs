// Paper Trail journey: landing page, live hero check, hand-off of a pasted list,
// More menu (How it works, Integrity Lab, House rules, tour, Lights off) and a full
// live Integrity Lab run. Desktop and phone. All checks are live.
const { chromium } = require(process.env.PLAYWRIGHT_PATH || 'playwright');
const fs = require('fs');
const BASE = process.env.BASE || 'http://127.0.0.1:4173';
const OUT = process.env.OUT || 'e2e-output';
const RUN_LAB = process.env.RUN_LAB !== '0';
fs.mkdirSync(`${OUT}/shots`, { recursive: true });
const results = [];
const ok = (name, cond, extra = '') => { const line = `${cond ? 'PASS' : 'FAIL'} ${name}${extra ? ' — ' + extra : ''}`; results.push(line); console.log(line); };

async function run(mobile) {
  const tag = mobile ? 'phone' : 'desktop';
  const browser = await chromium.launch({
    executablePath: process.env.CHROME_PATH || undefined,
    proxy: BASE.startsWith('https') && process.env.HTTPS_PROXY ? { server: process.env.HTTPS_PROXY } : undefined,
    args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader'],
  });
  const context = await browser.newContext(mobile
    ? { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 }
    : { viewport: { width: 1440, height: 900 } });
  const page = await context.newPage();
  page.setDefaultTimeout(25000);
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e).slice(0, 200)));
  const shot = (n) => page.screenshot({ path: `${OUT}/shots/pt-${tag}-${n}.png` });

  // ---------------------------------------------------------------- landing
  await page.goto(BASE + '/');
  await page.getByRole('heading', { name: 'Eighteen in a hundred of these papers do not exist.' }).waitFor();
  ok(`${tag}: landing title is Paper Trail`, (await page.title()) === 'Paper Trail');
  ok(`${tag}: landing nav shows the name`, await page.locator('header nav').isVisible() || mobile, '');
  await page.waitForTimeout(1500);
  await shot('01-landing');

  // the four example chips, each through the live checker
  const expect = { 'A real paper': 'Verified', 'An invented DOI': 'Not found', 'A retracted paper': 'Verified', 'A hijacked DOI': 'Not found' };
  for (const [chip, label] of Object.entries(expect)) {
    await page.getByRole('button', { name: chip, exact: true }).click();
    const stamp = page.locator('article .stamp');
    await stamp.waitFor();
    await page.waitForFunction((want) => document.querySelector('article .stamp')?.textContent?.includes(want), label, { timeout: 25000 }).catch(() => null);
    const text = (await stamp.textContent()) || '';
    ok(`${tag}: example "${chip}" is ${label}`, text.includes(label), text.trim());
    if (chip === 'A retracted paper') {
      const r = await page.locator('article').textContent();
      ok(`${tag}: retracted example shows the retraction`, /Retracted/.test(r || ''));
    }
    if (chip === 'An invented DOI') {
      ok(`${tag}: a Not found result offers no save button`, (await page.locator('article button', { hasText: 'Save to' }).count()) === 0);
    }
  }
  await shot('02-receipt');

  // a single typed reference with the Enter key
  await page.locator('#hero-check').fill('10.1038/nature14539');
  await page.locator('#hero-check').press('Enter');
  await page.waitForFunction(() => document.querySelector('article')?.textContent?.includes('Deep learning'), null, { timeout: 25000 }).catch(() => null);
  ok(`${tag}: typed DOI is checked`, ((await page.locator('article').textContent()) || '').includes('Deep learning'));

  // claim demo and dial still work
  await page.getByRole('button', { name: '13%' }).click();
  ok(`${tag}: claim demo switches to Supported`, ((await page.locator('p[aria-live]').filter({ hasText: 'Supported' }).count()) > 0));
  ok(`${tag}: dial marks unbuilt agents as planned`, (await page.getByText('Analyst (planned)').count()) === 1 && (await page.getByText('Planner (planned)').count()) === 0);

  // tour from the landing page
  await page.getByRole('button', { name: 'Play the 60-second tour' }).click();
  const tour = page.getByRole('dialog', { name: /trust label/ });
  await tour.waitFor();
  ok(`${tag}: tour opens from the landing page`, await tour.isVisible());
  await page.getByRole('button', { name: 'Next' }).click();
  ok(`${tag}: tour advances`, (await page.getByText('2 of 6').count()) === 1);
  await shot('03-tour');
  await page.getByRole('button', { name: 'Close the tour' }).click();

  // a pasted list hands off to the workspace import
  await page.evaluate(() => window.scrollTo(0, 0));
  const list = '10.1038/nature14539\n10.1073/pnas.1523821113';
  await page.locator('#hero-check').evaluate((el, text) => {
    const dt = new DataTransfer();
    dt.setData('text/plain', text);
    el.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
  }, list);
  await page.waitForURL(/\/check$/);
  ok(`${tag}: pasted list opens /check`, page.url().endsWith('/check'));
  // no project yet: the start screen explains, then the list opens after creating one
  await page.getByText('Start a research project first').waitFor();
  ok(`${tag}: /check without a project asks for one first`, true);
  await page.getByLabel('Project title').fill('Paper Trail journey');
  await page.getByRole('button', { name: 'Create project' }).click();
  const dlg = page.locator('.dialog');
  await dlg.waitFor();
  const rowsText = await dlg.locator('.import-row').allTextContents();
  ok(`${tag}: handed-over list loads into Import with 2 rows`, rowsText.length === 2, String(rowsText.length));
  await dlg.getByRole('button', { name: /Check all 2 live/ }).click();
  await page.waitForFunction(() => document.querySelectorAll('.dialog .import-row .lbl').length >= 2, null, { timeout: 40000 }).catch(() => null);
  const labels = await dlg.locator('.import-row .lbl').allTextContents();
  ok(`${tag}: pasted list labelled Verified and Not found`, labels.includes('Verified') && labels.includes('Not found'), labels.join(', '));
  await shot('04-handoff');
  await dlg.getByRole('button', { name: 'Close' }).click();
  await page.waitForURL(/\/home$/);
  ok(`${tag}: closing the check returns to /home`, page.url().endsWith('/home'));

  // back on the landing, Save to: project
  await page.goto(BASE + '/');
  await page.getByRole('button', { name: 'A real paper', exact: true }).click();
  const save = page.locator('article button', { hasText: 'Save to: Paper Trail journey' });
  await save.waitFor();
  await save.click();
  await page.locator('article button', { hasText: 'Saved to: Paper Trail journey' }).waitFor();
  ok(`${tag}: landing saves a Verified paper to the project with one click`, true);
  await page.getByRole('link', { name: 'Open workspace' }).first().click().catch(async () => page.goto(BASE + '/home'));
  await page.waitForURL(/\/home$/);
  const lib = mobile ? page.locator('.ref-card') : page.locator('.ref-table tbody tr');
  await lib.first().waitFor();
  ok(`${tag}: saved paper is in the library`, ((await lib.allTextContents()).join(' ')).includes('productivity effects'));

  // ---------------------------------------------------------------- More menu
  const openMore = async () => {
    if (mobile) await page.locator('.tabs-bottom').getByRole('button', { name: 'More' }).click();
    else await page.locator('.rail').getByRole('button', { name: 'More' }).click();
    await page.getByRole('menu', { name: 'More' }).waitFor();
  };
  for (const [item, heading, path] of [['How it works', 'How Paper Trail works', '/guide'], ['House rules', 'House rules', '/rules'], ['Integrity Lab', 'Integrity Lab', '/lab']]) {
    await openMore();
    await page.getByRole('menuitem', { name: item }).click();
    await page.getByRole('heading', { level: 1, name: heading }).waitFor();
    ok(`${tag}: More → ${item} opens ${path}`, page.url().endsWith(path));
  }
  // the Lab table has every column from Paper Trail's table
  await page.locator('.lab-table tbody tr').first().waitFor();
  const heads = await page.locator('.lab-table thead th').allTextContents();
  const want = ['Family', 'Cases', 'Real matched', 'Expected retraction', 'Caught', 'Missed', 'False alarm', 'Could not check', 'Other unresolved / error', 'Active', 'Cancelled', 'Not run', 'Coverage gaps'];
  ok(`${tag}: Lab table has all 13 columns`, want.every((w) => heads.includes(w)), heads.join(' | '));
  const fams = await page.locator('.lab-table tbody th').allTextContents();
  ok(`${tag}: Lab table has the 6 families`, fams.length === 6, fams.join(', '));
  ok(`${tag}: Lab lists 24 cases`, (await page.locator('.lab-case').count()) === 24);

  if (RUN_LAB && !mobile) {
    await page.getByRole('button', { name: 'Run all 24 live' }).click();
    await page.getByRole('button', { name: 'Run all 24 again' }).waitFor({ timeout: 240000 });
    const foot = await page.locator('.lab-table tfoot td').allTextContents();
    // Cases, Real matched, Expected retraction, Caught, Missed, False alarm, Could not check, Error, Active, Cancelled, Not run, Gaps
    const [cases, real, retr, caught, missed, fa, cnc, err, active, cancelled, notRun] = foot.map(Number);
    ok(`desktop: Lab ran all 24`, cases === 24 && notRun === 0 && active === 0 && cancelled === 0, foot.join(','));
    ok(`desktop: Lab — no invented reference Verified (missed = 0)`, missed === 0, `missed ${missed}`);
    ok(`desktop: Lab — no false alarms`, fa === 0, `false alarms ${fa}`);
    ok(`desktop: Lab — results`, true, `real ${real}, retraction ${retr}, caught ${caught}, could not check ${cnc}, errors ${err}`);
    await page.locator('.lab-case').first().locator('summary').click();
    ok(`desktop: Lab case shows its evidence`, ((await page.locator('.lab-case').first().textContent()) || '').includes('Checker said'));
    await shot('05-lab');
  } else {
    await shot('05-lab');
  }

  // cancel works (desktop only: phone already covered by the table checks)
  if (!mobile) {
    await page.getByRole('button', { name: /Run all 24/ }).click();
    await page.getByRole('button', { name: 'Cancel' }).click();
    await page.getByRole('button', { name: 'Run all 24 again' }).waitFor({ timeout: 60000 });
    const foot = (await page.locator('.lab-table tfoot td').allTextContents()).map(Number);
    ok('desktop: Lab Cancel stops the run and marks the rest cancelled', foot[9] > 0, `cancelled ${foot[9]}`);
  }

  // tour and Lights off from the More menu
  await openMore();
  await page.getByRole('menuitem', { name: 'Take the tour' }).click();
  ok(`${tag}: More → Take the tour opens the tour`, await page.getByRole('dialog', { name: /trust label/ }).isVisible());
  await page.keyboard.press('Escape');
  await openMore();
  await page.getByRole('menuitemcheckbox', { name: 'Lights off' }).click();
  ok(`${tag}: Lights off switches to dark`, (await page.evaluate(() => document.documentElement.dataset.theme)) === 'dark');
  await page.getByRole('heading', { level: 1 }).first().waitFor();
  await shot('06-dark');
  await page.reload();
  await page.getByRole('heading', { level: 1 }).first().waitFor();
  ok(`${tag}: dark theme is remembered`, (await page.evaluate(() => document.documentElement.dataset.theme)) === 'dark');
  await page.goto(BASE + '/');
  await page.getByRole('heading', { name: 'Eighteen in a hundred of these papers do not exist.' }).waitFor();
  ok(`${tag}: landing stays light in dark mode`, (await page.evaluate(() => document.documentElement.dataset.theme)) === 'light');
  await page.goto(BASE + '/home');
  await page.locator('.content').waitFor();
  await openMore();
  await page.getByRole('menuitemcheckbox', { name: 'Lights on' }).click();
  ok(`${tag}: Lights on switches back`, (await page.evaluate(() => document.documentElement.dataset.theme)) === 'light');

  // browser Back follows the routes
  await page.goto(BASE + '/rules');
  await page.getByRole('heading', { level: 1, name: 'House rules' }).waitFor();
  await page.goBack();
  await page.locator('.content').waitFor();
  ok(`${tag}: Back returns from /rules to /home`, page.url().endsWith('/home'));

  ok(`${tag}: no page errors`, errors.length === 0, errors.join(' | '));
  await browser.close();
}

(async () => {
  try {
    await run(false);
    await run(true);
  } catch (e) {
    ok('journey completed', false, String(e).slice(0, 400));
  }
  const failed = results.filter((r) => r.startsWith('FAIL')).length;
  console.log(`\n${results.length - failed}/${results.length} passed`);
  fs.writeFileSync(`${OUT}/paper_trail_results.txt`, results.join('\n') + '\n');
  process.exit(failed ? 1 : 0);
})();
