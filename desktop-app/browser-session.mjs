import { access, mkdir, rm } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { cookieHeader, readJson, saveCookie, writeJsonAtomic } from './session-cookie.mjs';
import { followSchoolLogin, readCredentials, submitStoredLogin } from './automatic-login.mjs';

const exists = async path => access(path).then(() => true, () => false);

/** An application-owned browser profile; never opens the user's normal profile. */
export async function syncBrowserSession(settingsPath, { interactive = false, emit = () => {}, chromium: injectedBrowser, signal, validateSession } = {}) {
  const settings = await readJson(settingsPath);
  const moduleUrl = name => pathToFileURL(resolve(settings.projectDir, 'dist', name)).href;
  const [{ loadConfig }, { LearnService }, { AppError }] = await Promise.all([
    import(moduleUrl('config.js')), import(moduleUrl('learn.js')), import(moduleUrl('errors.js')),
  ]);
  const config = await loadConfig(settings.configPath);
  if (config.baseUrl !== 'https://learn.tsinghua.edu.cn') throw new AppError('CONFIG_ERROR', '独立登录窗口仅支持网络学堂 HTTPS 站点。');
  const dataDir = resolve(dirname(settingsPath), 'data');
  const statePath = resolve(dataDir, 'browser-session.json');
  const profile = resolve(dataDir, 'browser-profile');
  const credentialsPath = resolve(dataDir, 'credentials.dpapi');
  const attemptPath = resolve(dataDir, 'login-attempt.json');
  const hasCredentials = !interactive && settings.pythonPath && await exists(credentialsPath);
  let state = {};
  try { state = await readJson(statePath); } catch { /* optional until enabled */ }
  if (!interactive && !state.enabled && !hasCredentials) throw new AppError('AUTH_REQUIRED', '尚未启用独立浏览器登录。');
  await mkdir(profile, { recursive: true });
  const chromium = injectedBrowser ?? createRequire(resolve(settings.projectDir, 'package.json'))('playwright-core').chromium;
  let context;
  let channel;
  const cancel = () => { if (context) context.close().catch(() => {}); };
  signal?.addEventListener('abort', cancel, { once: true });
  try {
    for (const candidate of [...new Set([state.channel, settings.browserChannel, 'chrome', 'msedge'].filter(Boolean))]) {
      if (!['chrome', 'msedge'].includes(candidate)) continue;
      try {
        context = await chromium.launchPersistentContext(profile, {
          channel: candidate, headless: !interactive, viewport: null, timeout: 15000,
          ignoreDefaultArgs: ['--password-store=basic'],
        });
        channel = candidate;
        break;
      } catch { /* try the next installed supported browser */ }
    }
    if (!context) throw new AppError('CONFIG_ERROR', '无法打开独立浏览器，请安装 Chrome 或 Edge，并关闭旧的独立登录窗口。');
    // Bootstrap only the learn.tsinghua.edu.cn session the user already supplied.
    // No credential database, password manager, or unrelated browser cookie is read.
    if (config.cookie && (!state.enabled || !(await context.cookies(config.baseUrl)).length)) {
      if (!state.enabled) await context.clearCookies();
      await context.addCookies(config.cookie.split(';').map(part => {
        const index = part.indexOf('=');
        return { name: part.slice(0, index).trim(), value: part.slice(index + 1).trim(), url: config.baseUrl, secure: true };
      }).filter(c => c.name));
    }
    const page = context.pages()[0] ?? await context.newPage();
    emit({ event: 'loginProgress', message: interactive ? '请在独立浏览器中手动完成网络学堂登录，成功后会自动保存 Cookie。' : '正在尝试同步独立浏览器的有效会话。' });
    try { await page.goto(new URL(config.protocol.homePage, config.baseUrl).href, { waitUntil: 'domcontentloaded', timeout: 30000 }); }
    catch { if (!interactive) throw new AppError('AUTH_REQUIRED', '独立会话无法自动恢复，请重新登录。'); }
    const deadline = Date.now() + (interactive ? 600000 : 10000);
    let lastFingerprint = '';
    let lastAttemptAt = 0;
    let submitted = false;
    let submissionDeadline = 0;
    let openedLogin = false;
    while (Date.now() < Math.max(deadline, submissionDeadline)) {
      if (signal?.aborted) throw new AppError('AUTH_REQUIRED', '登录操作已取消。');
      const pages = context.pages().filter(p => !p.isClosed());
      if (!pages.length) throw new AppError('AUTH_REQUIRED', '登录窗口已关闭，未保存新的会话。');
      const onSchoolPage = pages.some(p => p.url().startsWith(config.baseUrl + '/f/wlxt/'));
      const cookies = await context.cookies(config.baseUrl);
      const cookie = cookieHeader(cookies, config.baseUrl);
      const fingerprint = createHash('sha256').update(cookie).digest('hex');
      if (cookie && (onSchoolPage || (!interactive && !hasCredentials)) && (fingerprint !== lastFingerprint || Date.now() - lastAttemptAt >= 15000)) {
        lastFingerprint = fingerprint;
        lastAttemptAt = Date.now();
        try {
          const verified = validateSession ? await validateSession(cookie) : await (async () => {
            const service = new LearnService({ ...config, cookie, csrfToken: null, semesterId: null });
            await service.getCourseList();
            return service.http.exportCookieHeader();
          })();
          const saved = await saveCookie(settings.configPath, verified, config.cookie);
          if ((await readJson(settings.configPath)).cookie !== verified) {
            throw new AppError('CONFIG_ERROR', '登录期间本地配置已改变，请重试以确认当前账号。');
          }
          // Retain server rotations in this dedicated profile too.
          const current = new Map(cookies.map(c => [c.name, c]));
          await context.addCookies(verified.split(';').map(part => {
            const index = part.indexOf('=');
            const name = part.slice(0, index).trim();
            const old = current.get(name);
            return old ? { ...old, value: part.slice(index + 1).trim() }
              : { name, value: part.slice(index + 1).trim(), url: config.baseUrl, secure: true };
          }));
          await writeJsonAtomic(statePath, { enabled: true, channel, lastSyncedAt: new Date().toISOString() });
          await rm(attemptPath, { force: true });
          return { event: 'loginComplete', saved, message: '登录会话已验证并自动同步，今后会定期维护。' };
        } catch (error) {
          if (!['AUTH_REQUIRED', 'CSRF_INVALID', 'PROTOCOL_CHANGED'].includes(error?.code)) throw error;
          if (!interactive && !hasCredentials) throw error;
        }
      }
      if (hasCredentials && !submitted) {
        const currentUrl = new URL(page.url());
        if (!openedLogin && currentUrl.origin === config.baseUrl) {
          openedLogin = true;
          if (currentUrl.pathname !== '/f/login') {
            await page.goto(config.baseUrl + '/f/login', { waitUntil: 'domcontentloaded', timeout: 15000 });
          }
          await followSchoolLogin(page);
        }
        const candidate = pages.find(p => p.url().startsWith('https://id.tsinghua.edu.cn/'));
        if (candidate) {
          if (await exists(attemptPath)) throw Object.assign(new Error(), { code: 'RELOGIN_PAUSED' });
          const outcome = await submitStoredLogin(candidate, () => readCredentials(settings.pythonPath, credentialsPath), async () => {
            await writeJsonAtomic(attemptPath, { submittedAt: new Date().toISOString() });
            submitted = true;
            submissionDeadline = Date.now() + 30000;
            emit({ event: 'loginProgress', message: '会话已失效，正在通过清华统一身份认证重新登录。' });
          });
          if (outcome === 'challenge') throw Object.assign(new Error(), { code: 'RELOGIN_CHALLENGE' });
        }
      }
      if (!interactive && !hasCredentials) break;
      await new Promise(resolve => setTimeout(resolve, 1000));
    }
    if (submitted) throw Object.assign(new Error(), { code: 'RELOGIN_PAUSED' });
    throw new AppError('AUTH_REQUIRED', '尚未完成有效登录，请再次点击“浏览器登录”。');
  } finally {
    signal?.removeEventListener('abort', cancel);
    if (context) await context.close().catch(() => {});
  }
}

export async function browserSessionEnabled(settingsPath) {
  try {
    if (await exists(resolve(dirname(settingsPath), 'data', 'credentials.dpapi'))) return true;
    const state = await readJson(resolve(dirname(settingsPath), 'data', 'browser-session.json'));
    await access(resolve(dirname(settingsPath), 'data', 'browser-profile'));
    return state.enabled === true;
  } catch { return false; }
}
