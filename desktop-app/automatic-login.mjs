import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

const execute = promisify(execFile);
const identityOrigin = 'https://id.tsinghua.edu.cn';
const schoolOrigin = 'https://learn.tsinghua.edu.cn';
const identityForm = /^\/do\/off\/ui\/auth\/login\/form\/[0-9a-f]+\/0\/?$/i;
const helper = fileURLToPath(new URL('./windows_credentials.py', import.meta.url));

export async function readCredentials(pythonPath, path) {
  try {
    const { stdout } = await execute(pythonPath, [helper, path], { windowsHide: true, timeout: 5000, maxBuffer: 16384 });
    const { username, password } = JSON.parse(stdout);
    if (typeof username === 'string' && username && typeof password === 'string' && password) return { username, password };
  } catch { /* never forward subprocess output or arguments in errors */ }
  throw Object.assign(new Error('Unable to decrypt stored credentials'), { code: 'CREDENTIALS_UNREADABLE' });
}

export async function followSchoolLogin(page) {
  if (new URL(page.url()).origin !== schoolOrigin) return;
  const button = page.locator('#loginButtonId');
  if (await button.isVisible()) await button.click({ timeout: 5000 });
}

export async function submitStoredLogin(page, loadCredentials, beforeSubmit) {
  const isIdentityForm = () => {
    const url = new URL(page.url());
    return url.origin === identityOrigin && identityForm.test(url.pathname);
  };
  if (!isIdentityForm()) return 'unavailable';
  const form = page.locator('form#theform[action="/do/off/ui/auth/login/check"]');
  const controls = [
    form.locator('#i_user'),
    form.locator('#i_pass[type="password"]'),
    form.locator('a[onclick="doLogin(); return false;"]'),
  ];
  if (await form.locator('#i_code').isVisible()) return 'challenge';
  if (!(await Promise.all(controls.map(control => control.isVisible()))).every(Boolean)) return 'unavailable';
  const [username, password, submit] = await Promise.all(controls.map(control => control.elementHandle({ timeout: 2000 })));
  // Handles are bound to one document. Navigation cannot retarget a password fill.
  for (const control of [username, password, submit]) {
    const trusted = await control.evaluate((node, origin) => node.ownerDocument.location?.origin === origin, identityOrigin);
    if (!trusted) return 'unavailable';
  }
  const credentials = await loadCredentials();
  if (!isIdentityForm()) return 'unavailable';
  await username.fill(credentials.username, { timeout: 4000 });
  if (!isIdentityForm()) return 'unavailable';
  await password.fill(credentials.password, { timeout: 4000 });
  if (!isIdentityForm()) return 'unavailable';
  if (await form.locator('#i_code').isVisible()) return 'challenge';
  await beforeSubmit();
  if (!isIdentityForm()) return 'unavailable';
  await submit.click({ timeout: 5000 });
  return 'submitted';
}
