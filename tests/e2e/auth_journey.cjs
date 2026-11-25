// Sign-in journey against a LOCAL stand-in for Neon Auth (127.0.0.1:8100) — test accounts only.
const { chromium } = require(process.env.PLAYWRIGHT_PATH || 'playwright');
const fs = require('fs');
const BASE = 'http://127.0.0.1:4173';
const OUT = process.env.OUT || 'e2e-output/auth';
fs.mkdirSync(OUT, { recursive: true });
const results = [];
const ok = (n, c, x = '') => { const l = `${c ? 'PASS' : 'FAIL'} ${n}${x ? ' — ' + x : ''}`; results.push(l); console.log(l); };
const EMAIL = `tester-${Date.now()}@example.test`;
const PASSWORD = 'local-test-only-' + Math.random().toString(36).slice(2, 10);

async function run(mobile) {
  const tag = mobile ? 'phone' : 'desktop';
  const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || undefined });
  const ctx = await browser.newContext(mobile ? { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true } : { viewport: { width: 1440, height: 900 } });
  const page = await ctx.newPage();
  page.setDefaultTimeout(15000);
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  const email = mobile ? EMAIL.replace('tester', 'phone') : EMAIL;

  await page.goto(BASE);
  await page.getByRole('heading', { name: 'Start a research project' }).waitFor();
  await page.getByLabel('Project title').fill(`Guest library ${tag} (test)`);
  await page.getByRole('button', { name: 'Create project' }).click();
  await page.getByRole('heading', { name: 'Your library is empty' }).waitFor();
  const pid = await page.evaluate(() => localStorage.getItem('efro.projectId'));

  // open the login page
  if (mobile) { await page.locator('.tabs-bottom button:has-text("Project")').click(); await page.getByRole('button', { name: /Sign in or create an account/ }).click(); }
  else await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await page.getByRole('heading', { name: 'Sign in' }).waitFor();
  await page.screenshot({ path: `${OUT}/${tag}-1-login.png` });
  ok(`[${tag}] login page shown`, true);
  if (mobile) ok('[phone] login page fits the screen', !(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1)));

  // validation happens before any request
  await page.getByLabel('Email').fill('not-an-email');
  await page.getByLabel('Password').fill('short');
  await page.locator('.login-card form').getByRole('button', { name: 'Sign in' }).click();
  ok(`[${tag}] invalid email rejected in the form`, (await page.locator('.login-card .error').innerText()).includes('valid email'));

  // create an account
  await page.getByRole('tab', { name: 'Create account' }).click();
  await page.getByLabel(/Name/).fill('Test Student');
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Password').fill(PASSWORD);
  await page.locator('.login-card form').getByRole('button', { name: 'Create account' }).click();
  await page.locator('.confirm-bar', { hasText: 'Save' }).waitFor();
  ok(`[${tag}] account created and signed in`, true);
  ok(`[${tag}] offered to save the guest library`, (await page.locator('.confirm-bar').innerText()).includes(`Guest library ${tag} (test)`));
  await page.getByRole('button', { name: 'Save to my account' }).click();
  await page.locator('.notice-ok', { hasText: 'saved to your account' }).waitFor();
  ok(`[${tag}] library saved to the account`, true);

  // private: a request without the token cannot see it
  const guestStatus = await page.evaluate(async (id) => (await fetch(`/api/projects/${id}`)).status, pid);
  ok(`[${tag}] saved library is private to the account`, guestStatus === 404, String(guestStatus));

  // session survives a reload (first-party cookie through /api/auth)
  await page.reload();
  await page.getByRole('heading', { name: 'Your library is empty' }).waitFor();
  const signedHint = await page.evaluate(() => localStorage.getItem('efro.signedIn'));
  ok(`[${tag}] still signed in after reload`, signedHint === '1');
  const cookies = await ctx.cookies(BASE);
  const sc = cookies.find((c) => c.name.includes('session_token'));
  ok(`[${tag}] session cookie is first-party on our host, path /`, Boolean(sc) && sc.domain.replace(/^\./, '') === '127.0.0.1' && sc.path === '/' && sc.httpOnly,
    sc ? `${sc.domain} ${sc.path} httpOnly=${sc.httpOnly}` : 'none');

  // sign out → private library is left
  if (mobile) { await page.locator('.tabs-bottom button:has-text("Project")').click(); await page.locator('.account-panel').getByRole('button', { name: /Sign out/ }).click(); }
  else { await page.getByRole('button', { name: 'Account' }).click(); await page.getByRole('menuitem', { name: /Sign out/ }).click(); }
  await page.getByRole('heading', { name: 'Start a research project' }).waitFor();
  ok(`[${tag}] signing out leaves the private library`, (await page.evaluate(() => localStorage.getItem('efro.projectId'))) === null);

  // wrong password
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Password').fill(PASSWORD + 'x');
  await page.locator('.login-card form').getByRole('button', { name: 'Sign in' }).click();
  await page.locator('.login-card .error').waitFor();
  ok(`[${tag}] wrong password is refused`, /invalid|incorrect/i.test(await page.locator('.login-card .error').innerText()));

  // sign in again → the account's library opens
  await page.getByLabel('Password').fill(PASSWORD);
  await page.locator('.login-card form').getByRole('button', { name: 'Sign in' }).click();
  await page.getByRole('heading', { name: 'Your library is empty' }).waitFor();
  ok(`[${tag}] signing in reopens the account's library`, (await page.evaluate(() => localStorage.getItem('efro.projectId'))) === pid);
  await page.screenshot({ path: `${OUT}/${tag}-2-signed-in.png` });
  ok(`[${tag}] no JavaScript errors`, errors.length === 0, errors.join(' | '));
  await browser.close();
}

(async () => {
  for (const m of [false, true]) { try { await run(m); } catch (e) { ok(`${m ? 'phone' : 'desktop'} crashed`, false, e.message.split('\n')[0]); } }
  console.log(`\n${results.filter((r) => r.startsWith('PASS')).length} passed, ${results.filter((r) => r.startsWith('FAIL')).length} failed`);
})();
