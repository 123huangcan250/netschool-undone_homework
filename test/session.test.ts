import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { testConfig, projectDir } from './helpers.js';

const { cookieHeader, saveCookie, readJson } = await import(new URL('../desktop-app/session-cookie.mjs', import.meta.url).href);
const { refreshErrorEvent } = await import(new URL('../desktop-app/refresh-errors.mjs', import.meta.url).href);
const { syncBrowserSession, browserSessionEnabled } = await import(new URL('../desktop-app/browser-session.mjs', import.meta.url).href);
const { submitStoredLogin } = await import(new URL('../desktop-app/automatic-login.mjs', import.meta.url).href);

test('stored login only fills the official password form and yields to a visible verification prompt', async () => {
  let url = 'https://id.tsinghua.edu.cn.example.org/do/off/ui/auth/login/form/abcd/0';
  let challenge = false;
  const actions: string[] = [];
  const form = { locator: (selector: string) => ({
    isVisible: async () => selector !== '#i_code' || challenge,
    elementHandle: async () => ({
      evaluate: async () => true,
      fill: async (value: string) => { actions.push(value); },
      click: async () => { actions.push('click'); },
    }),
  }) };
  const page = { url: () => url, locator: () => form };
  const load = async () => { actions.push('load'); return { username: 'test-user', password: 'test-password' }; };
  const mark = async () => { actions.push('mark'); };
  assert.equal(await submitStoredLogin(page, load, mark), 'unavailable');
  assert.deepEqual(actions, []);
  url = 'https://id.tsinghua.edu.cn/do/off/ui/auth/login/form/abcd/0';
  challenge = true;
  assert.equal(await submitStoredLogin(page, load, mark), 'challenge');
  assert.deepEqual(actions, []);
  challenge = false;
  assert.equal(await submitStoredLogin(page, load, mark), 'submitted');
  assert.deepEqual(actions, ['load', 'test-user', 'test-password', 'mark', 'click']);
});

test('browser cookie export includes only valid school/root cookies including HttpOnly', () => {
  const cookies = [
    { name: 'JSESSIONID', value: 'valid', domain: 'learn.tsinghua.edu.cn', path: '/', expires: -1, httpOnly: true },
    { name: 'shared', value: 'applicable', domain: '.tsinghua.edu.cn', path: '/', expires: -1 },
    { name: 'identity', value: 'do-not-export', domain: 'id.tsinghua.edu.cn', path: '/', expires: -1 },
    { name: 'other', value: 'do-not-export', domain: 'example.com', path: '/', expires: -1 },
    { name: 'expired', value: 'do-not-export', domain: 'learn.tsinghua.edu.cn', path: '/', expires: 1 },
    { name: 'scoped', value: 'do-not-export', domain: 'learn.tsinghua.edu.cn', path: '/private', expires: -1 },
  ];
  assert.equal(cookieHeader(cookies, 'https://learn.tsinghua.edu.cn', 10), 'JSESSIONID=valid; shared=applicable');
});

test('session persistence saves rotations and preserves a newer manual configuration', async t => {
  const env = await testConfig(); t.after(env.cleanup);
  const path = join(env.root, 'local.json');
  await writeFile(path, JSON.stringify({ cookie: 'JSESSIONID=old', csrfToken: 'old-csrf', unrelated: 42 }));
  assert.equal(await saveCookie(path, 'JSESSIONID=new', 'JSESSIONID=old'), true);
  assert.deepEqual(await readJson(path), { cookie: 'JSESSIONID=new', csrfToken: null, unrelated: 42 });
  assert.equal(await saveCookie(path, 'JSESSIONID=stale-refresh', 'JSESSIONID=old'), false);
  assert.equal((await readJson(path)).cookie, 'JSESSIONID=new');
});

test('refresh errors are actionable and never echo raw session values or paths', () => {
  const auth = refreshErrorEvent({ code: 'AUTH_REQUIRED', message: 'Cookie=secret-session' });
  assert.equal(auth.code, 'AUTH_REQUIRED');
  assert.match(auth.message, /浏览器登录/);
  assert.ok(!JSON.stringify(auth).includes('secret-session'));
  assert.equal(refreshErrorEvent({ code: 'NETWORK_ERROR' }).code, 'NETWORK_ERROR');
  assert.equal(refreshErrorEvent({ code: 'ERR_MODULE_NOT_FOUND', message: 'C:/private/path' }).code, 'CONFIG_ERROR');
  assert.equal(refreshErrorEvent(Error('Cookie=secret-session')).code, 'INTERNAL_ERROR');
});

test('dedicated browser sync validates before saving, persists opt-in, and closes its own context', async t => {
  const env = await testConfig(); t.after(env.cleanup);
  const { configPath, protocol, ...raw } = env.config;
  raw.protocolFile = join(projectDir, 'config/protocol.json');
  await writeFile(configPath, JSON.stringify(raw));
  const settingsPath = join(env.root, 'app-settings.json');
  await writeFile(settingsPath, JSON.stringify({ projectDir, configPath }));
  let closed = false;
  let validated = false;
  const schoolCookies = [{ name: 'JSESSIONID', value: 'browser-session', domain: 'learn.tsinghua.edu.cn', path: '/', expires: -1, httpOnly: true, secure: true, sameSite: 'Lax' }];
  const page = { goto: async () => {}, isClosed: () => false, url: () => 'https://learn.tsinghua.edu.cn/f/wlxt/index/course/student/' };
  const context = { cookies: async () => schoolCookies, addCookies: async () => {}, clearCookies: async () => {}, pages: () => [page], close: async () => { closed = true; } };
  const browser = { launchPersistentContext: async (profile: string, options: { headless: boolean }) => {
    assert.equal(profile, join(env.root, 'data', 'browser-profile'));
    assert.equal(options.headless, false);
    return context;
  } };
  const result = await syncBrowserSession(settingsPath, { interactive: true, chromium: browser,
    validateSession: async (cookie: string) => { validated = true; assert.equal(cookie, 'JSESSIONID=browser-session'); return 'JSESSIONID=verified-session'; } });
  assert.equal(result.event, 'loginComplete');
  assert.equal(validated, true);
  assert.equal(closed, true);
  assert.equal((await readJson(configPath)).cookie, 'JSESSIONID=verified-session');
  assert.equal(await browserSessionEnabled(settingsPath), true);
});

test('silent browser sync requires opt-in and does not save an invalid session', async t => {
  const env = await testConfig(); t.after(env.cleanup);
  const { configPath, protocol, ...raw } = env.config;
  raw.protocolFile = join(projectDir, 'config/protocol.json');
  await writeFile(configPath, JSON.stringify(raw));
  const settingsPath = join(env.root, 'app-settings.json');
  await writeFile(settingsPath, JSON.stringify({ projectDir, configPath }));
  await assert.rejects(syncBrowserSession(settingsPath), { code: 'AUTH_REQUIRED' });
  await mkdir(join(env.root, 'data'), { recursive: true });
  await writeFile(join(env.root, 'data', 'browser-session.json'), JSON.stringify({ enabled: true }));
  let closed = false;
  const page = { goto: async () => {}, isClosed: () => false, url: () => 'https://learn.tsinghua.edu.cn/f/login' };
  const context = { cookies: async () => [{ name: 'JSESSIONID', value: 'invalid', domain: 'learn.tsinghua.edu.cn', path: '/' }],
    pages: () => [page], close: async () => { closed = true; } };
  await assert.rejects(syncBrowserSession(settingsPath, { chromium: { launchPersistentContext: async () => context },
    validateSession: async () => { throw Object.assign(Error('expired'), { code: 'AUTH_REQUIRED' }); } }), { code: 'AUTH_REQUIRED' });
  assert.equal((await readJson(configPath)).cookie, raw.cookie);
  assert.equal(closed, true);
});
