import { readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';

export function cookieHeader(cookies, origin, now = Date.now() / 1000) {
  const hostname = new URL(origin).hostname;
  const result = new Map();
  for (const cookie of cookies) {
    const domain = String(cookie.domain ?? '').replace(/^\./, '').toLowerCase();
    if (!domain || (hostname !== domain && !hostname.endsWith('.' + domain))) continue;
    if (cookie.expires > 0 && cookie.expires <= now) continue;
    if (!/^[^=;:\s]+$/.test(cookie.name) || /[;\r\n]/.test(cookie.value)) continue;
    // Match root-path requests used by the service; don't leak narrow-path cookies.
    if (cookie.path && cookie.path !== '/') continue;
    result.set(cookie.name, cookie.value);
  }
  return [...result].map(([name, value]) => `${name}=${value}`).join('; ');
}

export async function readJson(path) {
  return JSON.parse((await readFile(path, 'utf8')).replace(/^\uFEFF/, ''));
}

export async function writeJsonAtomic(path, value) {
  const temporary = path + '.' + randomUUID() + '.tmp';
  try {
    await writeFile(temporary, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 });
    await rename(temporary, path);
  } finally { await unlink(temporary).catch(() => {}); }
}

export async function saveCookie(configPath, cookie, expectedCookie) {
  if (!cookie || /[\r\n]/.test(cookie)) throw Error('Invalid session value');
  const latest = await readJson(configPath);
  // Don't overwrite a manual login already saved while this refresh was running.
  if (expectedCookie !== undefined && latest.cookie !== expectedCookie) return false;
  if (latest.cookie === cookie && latest.csrfToken === null) return false;
  latest.cookie = cookie;
  latest.csrfToken = null;
  await writeJsonAtomic(configPath, latest);
  return true;
}
