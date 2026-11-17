import { CookieJar } from 'tough-cookie';
import * as cheerio from 'cheerio';
import type { LoadedConfig } from './config.js';
import { AppError, protocolError } from './errors.js';

export interface Runtime {
  fetch: typeof fetch;
  now: () => number;
  sleep: (ms: number) => Promise<void>;
}
export const defaultRuntime: Runtime = {
  fetch: globalThis.fetch,
  now: () => Date.now(),
  sleep: ms => new Promise(resolve => setTimeout(resolve, ms)),
};
export interface RequestOptions {
  method?: 'GET' | 'POST';
  body?: () => FormData;
  replaySafe?: boolean;
  csrf?: boolean;
  referer?: string;
  beforeSend?: () => void;
}

/** Session expiry can be an HTTP 200 HTML dialog without a login form. */
function isLoginPage(body: string): boolean {
  if (/<input[^>]+type\s*=\s*["']?password|id\s*=\s*["']loginButtonId["']|login_timeout/i.test(body)) return true;
  if (!/^\s*</.test(body) || !/<(?:html|head|title|body)(?:\s|>)/i.test(body)) return false;
  const $ = cheerio.load(body);
  const title = $('title').text().trim();
  if (/^(?:登录超时|登录失效|登录过期|会话失效|会话过期|Login Timeout|Session Expired)$/i.test(title)) return true;
  const page = $('body').clone();
  page.find('script,style').remove();
  const text = page.text().replace(/\s+/g, ' ').trim();
  return /^您(?:未登录|尚未登录)(?:或登录失效)?[。！\s]*(?:(?:登录网络学堂|请重新登录|重新登录|关闭|返回首页)[。！\s]*)*$/.test(text);
}

/** One FIFO for every request, redirect, and retry in this process. */
export class LearnHttpClient {
  private readonly jar = new CookieJar();
  private readonly seeded: Promise<void>;
  private queue: Promise<void> = Promise.resolve();
  private nextStart = 0;
  private csrfToken: string | null;
  private csrfHeader: string;
  private bootstrap: Promise<void> | undefined;

  constructor(readonly config: LoadedConfig, readonly runtime: Runtime = defaultRuntime) {
    this.csrfToken = config.csrfToken;
    this.csrfHeader = config.protocol.csrf.defaultHeader;
    this.seeded = this.seed();
  }

  private async seed(): Promise<void> {
    for (const item of this.config.cookie.split(';')) {
      if (item.trim()) await this.jar.setCookie(`${item.trim()}; Path=/${this.config.baseUrl.startsWith('https:') ? '; Secure' : ''}`, this.config.baseUrl);
    }
  }

  /** For local persistence only. Never include this value in tool output or logs. */
  async exportCookieHeader(): Promise<string> {
    await this.seeded;
    return this.jar.getCookieString(this.config.baseUrl + '/');
  }

  private async gated<T>(fn: () => Promise<T>): Promise<T> {
    const previous = this.queue;
    let release!: () => void;
    this.queue = new Promise<void>(resolve => { release = resolve; });
    await previous;
    try {
      while (this.nextStart > this.runtime.now()) await this.runtime.sleep(this.nextStart - this.runtime.now());
      this.nextStart = this.runtime.now() + this.config.requestIntervalMs;
      return await fn();
    } finally {
      // Cool down after completion as well: header preparation/initial connection
      // latency must not compress the spacing observed by the upstream server.
      this.nextStart = Math.max(this.nextStart, this.runtime.now() + this.config.requestIntervalMs);
      release();
    }
  }

  async ensureSession(): Promise<void> {
    if (!this.config.cookie.trim()) throw new AppError('AUTH_REQUIRED', '未配置网络学堂 Cookie。', false, '在浏览器正常登录 learn.tsinghua.edu.cn，将该站请求的 Cookie 值写入本地配置后重启服务。');
    if (this.csrfToken) return;
    if (!this.bootstrap) this.bootstrap = this.readToken().finally(() => { this.bootstrap = undefined; });
    await this.bootstrap;
  }

  private async readToken(): Promise<void> {
    const html = await this.text(this.config.protocol.homePage, { csrf: false, replaySafe: true });
    const $ = cheerio.load(html);
    const meta = $('meta[name="_csrf"]').attr('content');
    const hidden = $('input[name="_csrf"]').attr('value');
    let linked: string | undefined;
    $('[href], [src], [action]').each((_, el) => {
      const ref = $(el).attr('href') ?? $(el).attr('src') ?? $(el).attr('action');
      if (ref && !linked) {
        try { linked = new URL(ref, this.config.baseUrl).searchParams.get(this.config.protocol.csrf.queryName) ?? undefined; } catch { /* non-URL links */ }
      }
    });
    const script = html.match(/[?&](?:amp;)?_csrf=([^\s"'<>;&]+)/)?.[1];
    try { this.csrfToken = meta ?? hidden ?? linked ?? (script ? decodeURIComponent(script) : null); }
    catch { throw protocolError('主页 CSRF 字段编码无效。'); }
    this.csrfHeader = $('meta[name="_csrf_header"]').attr('content') ?? this.config.protocol.csrf.defaultHeader;
    if (!/^X-[A-Za-z0-9-]+$/i.test(this.csrfHeader)) throw protocolError('CSRF Header 名称不符合预期。');
    if (!this.csrfToken) throw protocolError('已读取主页，但未找到 CSRF 字段。请核对会话与页面结构。');
  }

  async json(path: string, options: RequestOptions = {}): Promise<unknown> {
    const body = await this.text(path, options);
    let value: unknown;
    try { value = JSON.parse(body); }
    catch { throw protocolError('接口未返回有效 JSON，可能是会话失效或页面结构变化。'); }
    if (value && typeof value === 'object') {
      const record = value as Record<string, unknown>;
      const message = String(record.message ?? record.msg ?? '');
      const successful = record.result === 'success' || record.message === 'success';
      if (!successful && /未登录|登录超时|会话失效|not.?logged|session.?expired/i.test(message)) this.authError();
    }
    return value;
  }

  private authError(): never {
    this.csrfToken = null;
    throw new AppError('AUTH_REQUIRED', '网络学堂会话已失效或无权访问。', false, '在浏览器重新登录该账号，更新本地 Cookie 后重启服务。');
  }

  async text(path: string, options: RequestOptions = {}): Promise<string> {
    return new TextDecoder().decode(await this.request(path, options, false));
  }

  async download(path: string): Promise<Uint8Array> {
    return this.request(path, {}, true);
  }

  private async request(path: string, options: RequestOptions, binary: boolean): Promise<Uint8Array> {
    await this.seeded;
    const withCsrf = options.csrf !== false;
    if (withCsrf) await this.ensureSession();
    const initial = new URL(path, this.config.baseUrl);
    if (initial.origin !== this.config.baseUrl) throw new AppError('CONFIG_ERROR', '请求目标必须与 baseUrl 同源。');
    if (withCsrf && this.csrfToken) initial.searchParams.set(this.config.protocol.csrf.queryName, this.csrfToken);
    const method = options.method ?? 'GET';
    const safe = options.replaySafe ?? method === 'GET';

    for (let attempt = 0; attempt <= (safe ? this.config.retryCount : 0); attempt++) {
      try {
        let target = initial;
        for (let hop = 0; hop < 6; hop++) {
          const { response, bytes } = await this.gated(async () => {
            const headers: Record<string, string> = {
              'User-Agent': this.config.userAgent,
              Accept: 'application/json, text/html;q=0.9, */*;q=0.8',
              'Accept-Language': this.config.language === 'zh' ? 'zh-CN,zh;q=0.9' : 'en-US,en;q=0.9',
              Referer: new URL(options.referer ?? this.config.protocol.homePage, this.config.baseUrl).href,
              Cookie: await this.jar.getCookieString(target.href),
            };
            if (target.pathname.startsWith('/b/')) headers['X-Requested-With'] = 'XMLHttpRequest';
            if (method === 'POST') headers.Origin = this.config.baseUrl;
            if (withCsrf && this.csrfToken) headers[this.csrfHeader] = this.csrfToken;
            options.beforeSend?.();
            const response = await this.runtime.fetch(target, {
              method, headers, body: options.body?.(), redirect: 'manual',
              signal: AbortSignal.timeout(this.config.requestTimeoutMs),
            });
            for (const value of response.headers.getSetCookie()) await this.jar.setCookie(value, target.href);
            const chunks: Uint8Array[] = [];
            let size = 0;
            const limit = binary ? 100 * 1024 * 1024 : 20 * 1024 * 1024;
            if (response.body) {
              const reader = response.body.getReader();
              try {
                while (true) {
                  const { done, value } = await reader.read();
                  if (done) break;
                  size += value.length;
                  if (size > limit) {
                    await reader.cancel();
                    throw new AppError('FILE_NOT_ALLOWED', '服务器响应超过大小限制。', false, '请在浏览器下载较大的附件。');
                  }
                  chunks.push(value);
                }
              } finally {
                reader.releaseLock();
              }
            }
            const bytes = Buffer.concat(chunks);
            return { response, bytes };
          });
          const body = new TextDecoder().decode(bytes.subarray(0, binary ? Math.min(bytes.length, 1024 * 1024) : bytes.length));

          if (response.status >= 300 && response.status < 400) {
            const location = response.headers.get('location');
            if (!location) throw protocolError('重定向缺少 Location。');
            const next = new URL(location, target);
            if (/login|login_timeout|id\.tsinghua\.edu\.cn/i.test(next.href)) this.authError();
            if (next.origin !== this.config.baseUrl) throw new AppError('AUTH_REQUIRED', '接口重定向到其他站点，未转发 Cookie。', false, '通过浏览器正常完成统一身份认证后更新网络学堂 Cookie。');
            if (method !== 'GET') throw new AppError(safe ? 'PROTOCOL_CHANGED' : 'SUBMISSION_UNCERTAIN', 'POST 返回意外重定向，未自动重放。', false, '先在浏览器查看提交记录，再核对接口。');
            target = next;
            continue;
          }
          if (response.status === 401) this.authError();
          if (response.status === 403) {
            if (/csrf|跨站请求/i.test(body)) {
              this.csrfToken = null;
              throw new AppError('CSRF_INVALID', 'CSRF 校验失败。', false, '重新获取该会话 Cookie；csrfToken 留空以从主页重新读取，随后重启服务。');
            }
            this.authError();
          }
          if ((!binary || /html|json|text/i.test(response.headers.get('content-type') ?? '') || /^\s*</.test(body)) && isLoginPage(body)) this.authError();
          if ([408, 429, 500, 502, 503, 504].includes(response.status)) {
            const retryAfter = response.headers.get('retry-after');
            const delay = retryAfter && /^\d+$/.test(retryAfter) ? Number(retryAfter) * 1000 : retryAfter ? Date.parse(retryAfter) - this.runtime.now() : 0;
            if (delay > 0 && Number.isFinite(delay)) this.nextStart = Math.max(this.nextStart, this.runtime.now() + Math.min(delay, 120000));
            throw new AppError(response.status === 429 ? 'RATE_LIMITED' : 'UPSTREAM_ERROR', `网络学堂暂不可用（HTTP ${response.status}）。`, true, '稍后重试读取操作；提交操作先核对浏览器记录。');
          }
          if (!response.ok) throw new AppError('UPSTREAM_ERROR', `网络学堂返回 HTTP ${response.status}。`, false, '核对账号权限及接口文档。');
          if (binary && /html|json/i.test(response.headers.get('content-type') ?? '')) {
            throw protocolError('附件接口返回网页或 JSON，未保存为文件。');
          }
          return bytes;
        }
        throw protocolError('同源重定向次数过多。');
      } catch (error) {
        const appError = error instanceof AppError ? error : new AppError('NETWORK_ERROR', '网络请求失败或超时。', true, '检查网络连接；会话信息不会输出到日志。');
        if (!safe && (appError.retryable || appError.code === 'PROTOCOL_CHANGED')) {
          throw new AppError('SUBMISSION_UNCERTAIN', '提交请求的处理结果不确定，未自动重发。', false, '先通过详情或浏览器核对最新提交记录。');
        }
        if (!safe || !appError.retryable || attempt === this.config.retryCount) throw appError;
        this.nextStart = Math.max(this.nextStart, this.runtime.now() + this.config.requestIntervalMs * 2 ** attempt);
      }
    }
    throw new AppError('NETWORK_ERROR', '重试次数已用尽。');
  }
}
