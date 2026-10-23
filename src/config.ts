import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DateTime } from 'luxon';
import { z } from 'zod';
import { AppError } from './errors.js';

const PathSchema = z.string().min(1).refine(v => v.startsWith('/') && !v.startsWith('//') && !v.includes('\\'), '必须为同源绝对路径');
export const ProtocolSchema = z.object({
  sourceCommit: z.string(), homePage: PathSchema, currentSemester: PathSchema,
  courseList: PathSchema,
  homeworkLists: z.object({ unsubmitted: PathSchema, submitted: PathSchema, graded: PathSchema }),
  homeworkPage: PathSchema, homeworkDetail: PathSchema, submitPage: PathSchema, submit: PathSchema,
  homeworkPages: z.object({ unsubmitted: PathSchema, submitted: PathSchema, graded: PathSchema }).optional(),
  csrf: z.object({ queryName: z.string().min(1), defaultHeader: z.string().min(1) }),
  fields: z.object({ homeworkId: z.string().min(1), content: z.string().min(1), file: z.string().min(1), deleted: z.string().min(1) }),
  selectors: z.object({ description: z.string(), attachmentGroups: z.string(), submittedContent: z.string(), fileInput: z.string() }),
}).strict();

export const ConfigSchema = z.object({
  baseUrl: z.string().url().refine(v => {
    const u = new URL(v);
    return !u.username && !u.password && u.pathname === '/' && !u.search && !u.hash &&
      (u.protocol === 'https:' || (u.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(u.hostname)));
  }, 'baseUrl 必须为 HTTPS 源地址，本地测试可用 loopback HTTP'),
  cookie: z.string().refine(v => !/[\r\n]/.test(v) && (!v.trim() || v.split(';').every(item => !item.trim() || /^[^=;:\s]+=[^;\r\n]*$/.test(item.trim()))), 'Cookie 必须为请求头值，不含前缀或换行'),
  semesterId: z.string().min(1).nullable(),
  language: z.enum(['zh', 'en']),
  timezone: z.string().refine(v => DateTime.now().setZone(v).isValid, '无效时区'),
  requestIntervalMs: z.number().int().min(1000),
  requestTimeoutMs: z.number().int().min(1000).max(120000),
  retryCount: z.literal(2),
  pageSize: z.number().int().min(1).max(1000), maxPages: z.number().int().min(1).max(1000),
  userAgent: z.string().min(1), csrfToken: z.string().min(1).nullable(), protocolFile: z.string().min(1),
  submission: z.object({
    allowedRoots: z.array(z.string().min(1)).min(1),
    allowedExtensions: z.array(z.string().regex(/^\.[a-zA-Z0-9]+$/)),
    maxFileBytes: z.number().int().positive(), maxTotalBytes: z.number().int().positive(),
    maxFiles: z.number().int().min(1).max(100),
    multiFileMode: z.enum(['zip', 'reject']),
    archiveName: z.string().regex(/^[^\\/\r\n]+\.zip$/i),
    allowUnknownDeadline: z.boolean(), allowLateSubmission: z.boolean(),
    verificationAttempts: z.number().int().min(1).max(10), receiptFile: z.string().min(1),
  }).strict(),
}).strict();

export type Config = z.infer<typeof ConfigSchema>;
export type Protocol = z.infer<typeof ProtocolSchema>;
export type LoadedConfig = Config & { configPath: string; protocol: Protocol };

export async function loadConfig(path?: string): Promise<LoadedConfig> {
  const configPath = resolve(path ?? process.env.THU_LEARN_CONFIG ?? fileURLToPath(new URL('../config/local.json', import.meta.url)));
  let raw: unknown;
  try { raw = JSON.parse(await readFile(configPath, 'utf8')); }
  catch { throw new AppError('CONFIG_ERROR', '无法读取本地配置 JSON。', false, '复制 config/example.json 为 config/local.json，或使用 --config 指定绝对路径。'); }
  const parsed = ConfigSchema.safeParse(raw);
  if (!parsed.success) throw new AppError('CONFIG_ERROR', `配置字段无效：${parsed.error.issues.map(i => i.path.join('.')).join('、')}。`, false, '参考 config/example.json 修正字段；Cookie 只填请求头的值。');
  const config = parsed.data;
  let protocol: Protocol;
  try { protocol = ProtocolSchema.parse(JSON.parse(await readFile(resolve(dirname(configPath), config.protocolFile), 'utf8'))); }
  catch { throw new AppError('CONFIG_ERROR', '接口配置 protocolFile 不可读取或结构无效。', false, '将 config/protocol.json 放在配置指定位置。'); }
  config.submission.allowedRoots = config.submission.allowedRoots.map(p => resolve(dirname(configPath), p));
  config.submission.receiptFile = resolve(dirname(configPath), config.submission.receiptFile);
  return { ...config, baseUrl: new URL(config.baseUrl).origin, configPath, protocol };
}

export function interpolate(template: string, params: Record<string, string>): string {
  return template.replace(/\{(\w+)\}/g, (_, key: string) => {
    if (!(key in params)) throw new AppError('CONFIG_ERROR', '接口模板缺少参数。');
    return encodeURIComponent(params[key]!);
  });
}
