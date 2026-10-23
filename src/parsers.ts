import * as cheerio from 'cheerio';
import { DateTime } from 'luxon';
import { interpolate, type LoadedConfig } from './config.js';
import type { Attachment, Homework, HomeworkDetail, Requirements, Status, TimeNode } from './models.js';
import { protocolError } from './errors.js';

export type Row = Record<string, unknown>;
export function record(value: unknown): Row {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw protocolError('接口对象结构不符合预期。');
  return value as Row;
}
export function decode(value: unknown): string {
  return cheerio.load(`<body>${String(value ?? '')}</body>`).text().trim();
}
export function cleanHtml(value: string): string {
  const $ = cheerio.load(value, {}, false);
  $('script,style,iframe,object,embed').remove();
  $('*').each((_, el) => {
    if (!('attribs' in el)) return;
    for (const key of Object.keys(el.attribs)) {
      if (/^on/i.test(key) || (['href', 'src'].includes(key) && /^\s*(javascript|data):/i.test(el.attribs[key]!))) $(el).removeAttr(key);
    }
  });
  return $.html().trim();
}
export function htmlText(value: string): string {
  const $ = cheerio.load(value);
  $('br').replaceWith('\n');
  $('p,div,li,tr,h1,h2,h3').append('\n');
  return $.text().replace(/\u00a0/g, ' ').replace(/[ \t]+/g, ' ').replace(/\n\s*\n/g, '\n').trim();
}
export function normalizeTime(value: unknown, zone: string): string | null {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value === 'number') {
    const dt = DateTime.fromMillis(value < 1e11 ? value * 1000 : value);
    return dt.isValid ? dt.toUTC().toISO({ suppressMilliseconds: true }) : null;
  }
  const raw = String(value).trim().replace(/年|月/g, '-').replace(/日/g, '').replace(/\//g, '-');
  if (!raw) return null;
  let dt = DateTime.fromISO(raw, { zone, setZone: true });
  if (!dt.isValid) dt = DateTime.fromSQL(raw, { zone, setZone: true });
  if (!dt.isValid) for (const format of ['yyyy-M-d H:m:s', 'yyyy-M-d H:m', 'yyyy-M-d']) {
    dt = DateTime.fromFormat(raw, format, { zone });
    if (dt.isValid) break;
  }
  return dt.isValid ? dt.toUTC().toISO({ suppressMilliseconds: true }) : null;
}

export function classify(title: string, description = ''): Homework['type'] {
  const text = `${title}\n${description}`;
  if (/测验|测试题|随堂测试|quiz|考试/i.test(title)) return 'quiz';
  if (/实验|预习报告|\blab\b|\blaboratory\b|\bexperiment\b/i.test(text)) return 'lab_report';
  if (/论文|文献综述|paper\b|essay\b/i.test(text)) return 'paper';
  return 'ordinary';
}
const numeric = (v: unknown): number | null => v === '' || v === null || v === undefined || !Number.isFinite(Number(v)) ? null : Number(v);

export function normalizeHomework(row: Row, courseId: string, status: Status, config: LoadedConfig, now: number): Homework {
  if (!row.xszyid || !row.zyid || typeof row.bt !== 'string') throw protocolError('作业记录缺少 xszyid、zyid 或 bt。');
  const nodes: TimeNode[] = [];
  const time = (key: string, label: string): string | null => {
    const raw = row[key];
    const iso = normalizeTime(raw, config.timezone);
    if (raw !== undefined && raw !== null && raw !== '') nodes.push({ label, raw: String(raw), iso });
    return iso;
  };
  const publishedAt = time('fbsj', '发布时间');
  const startAt = time('kssj', '开始时间');
  const deadline = time('jzsj', '截止时间');
  const lateDeadline = time('bjjzsj', '补交截止时间');
  const submittedAt = time('scsj', '提交时间');
  const gradedAt = time('pysj', '批阅时间');
  for (const [key, value] of Object.entries(row)) {
    if (/(sj|rq)$/i.test(key) && !['fbsj', 'kssj', 'jzsj', 'bjjzsj', 'scsj', 'pysj'].includes(key) && value !== null && value !== '') {
      const iso = normalizeTime(value, config.timezone);
      if (iso) nodes.push({ label: key, raw: String(value), iso });
    }
  }
  const warnings: string[] = [];
  if (!publishedAt) warnings.push('列表未提供可解析的发布时间。');
  if (!deadline) warnings.push('截止时间缺失或无法解析。');
  if (nodes.some(n => !n.iso)) warnings.push('部分原始时间无法解析，已保留原文。');
  const title = decode(row.bt);
  const remainingSeconds = deadline ? Math.floor((Date.parse(deadline) - now) / 1000) : null;
  return {
    homeworkId: String(row.xszyid), assignmentId: String(row.zyid), courseId, title,
    type: classify(title), typeSource: 'heuristic', status,
    publishedAt, startAt, deadline, lateDeadline, submittedAt, gradedAt,
    remainingSeconds, overdue: deadline ? Date.parse(deadline) <= now : null,
    score: typeof row.cj === 'number' || typeof row.cj === 'string' ? row.cj : null,
    maxScore: numeric(row.zf ?? row.mf),
    completionType: numeric(row.zywcfs), submissionType: numeric(row.zytjfs),
    timeNodes: nodes, warnings,
    url: new URL(interpolate(config.protocol.homeworkPages?.[status] ?? config.protocol.homeworkPage, {
      courseId, homeworkId: String(row.xszyid), assignmentId: String(row.zyid),
      expiredFlag: deadline && Date.parse(deadline) <= now ? '1' : '0',
    }), config.baseUrl).href,
  };
}

export function deduplicate(items: Homework[]): Homework[] {
  const ranks: Record<Status, number> = { unsubmitted: 0, submitted: 1, graded: 2 };
  const byId = new Map<string, Homework>();
  for (const item of items) {
    const key = `${item.courseId}:${item.homeworkId}`;
    const prior = byId.get(key);
    if (!prior || ranks[item.status] >= ranks[prior.status]) byId.set(key, item);
  }
  return [...byId.values()];
}

export function extractTimeNodes(text: string, zone: string): TimeNode[] {
  const nodes: TimeNode[] = [];
  const pattern = /\d{4}[-/年]\d{1,2}[-/月]\d{1,2}日?(?:[ T]\d{1,2}:\d{2}(?::\d{2})?(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})?)?/g;
  for (const match of text.matchAll(pattern)) {
    const before = text.slice(Math.max(0, match.index! - 32), match.index!).split('\n').pop() ?? '';
    const raw = match[0];
    const iso = normalizeTime(raw, zone);
    nodes.push({ label: before.trim().replace(/[：:]\s*$/, '') || '正文时间', raw, iso });
  }
  return nodes.filter((n, i) => nodes.findIndex(o => o.raw === n.raw && o.label === n.label) === i);
}

function attachmentUrl(href: string, baseUrl: string): { url: string; id: string | null } | null {
  try {
    const source = new URL(href, baseUrl);
    const nested = source.searchParams.get('downloadUrl');
    const url = nested ? new URL(nested, baseUrl) : source;
    if (url.origin !== baseUrl || !/^https?:$/.test(url.protocol)) return null;
    const id = source.searchParams.get('fileId') ?? source.searchParams.get('wjid') ?? null;
    url.searchParams.delete('_csrf');
    return { url: url.href, id };
  } catch { return null; }
}

export function parseDetail(homework: Homework, html: string, json: unknown, config: LoadedConfig): HomeworkDetail {
  const metadata = record(json);
  if (metadata.result !== 'success' || typeof metadata.msg !== 'string') throw protocolError('作业详情 JSON 缺少成功结果或 msg 正文。');
  const $ = cheerio.load(html);
  let description = metadata.msg;
  if (/&lt;\/?[a-z]/i.test(description)) description = decode(description);
  const descriptionHtml = cleanHtml(description || $(config.protocol.selectors.description).first().html() || '');
  const descriptionText = htmlText(descriptionHtml);
  const attachments: Attachment[] = [];
  const roles: Attachment['role'][] = ['assignment', 'answer', 'submitted', 'feedback'];
  $(config.protocol.selectors.attachmentGroups).each((index, el) => {
    const role = roles[index];
    if (!role) return;
    const group = $(el);
    group.find('.ftitle > a, .fl > a').each((_, node) => {
      const href = $(node).attr('href');
      if (!href) return;
      const link = attachmentUrl(href, config.baseUrl);
      if (!link) return;
      const name = $(node).text().trim();
      if (!name || attachments.some(a => a.url === link.url && a.role === role)) return;
      attachments.push({ ...link, name, role, sizeText: group.find('.fl > span[class^="color"]').first().text().trim() || null });
    });
  });
  const submittedHtml = $('div.boxbox').eq(1).find('div.right').eq(2).html() ?? $(config.protocol.selectors.submittedContent).eq(2).html() ?? $('textarea[name="zynr"]').text() ?? '';
  const contentHtml = cleanHtml(submittedHtml);
  const timeNodes = [...homework.timeNodes, ...extractTimeNodes(`${descriptionText}\n${htmlText(html)}`, config.timezone)];
  const uniqueNodes = timeNodes.filter((n, i) => timeNodes.findIndex(o => o.label === n.label && o.raw === n.raw) === i);
  const publishedAt = homework.publishedAt ?? uniqueNodes.find(n => /发布/.test(n.label))?.iso ?? null;
  return {
    ...homework, publishedAt, timeNodes: uniqueNodes,
    type: classify(homework.title, descriptionText), descriptionHtml, descriptionText, attachments,
    warnings: publishedAt ? homework.warnings.filter(w => !w.startsWith('列表未提供')) : homework.warnings,
    requirements: { instructions: descriptionText, acceptedExtensions: [], maxFileBytes: null, maxRemarksLength: null, acceptsSource: 'unknown' },
    submission: { contentHtml, contentText: htmlText(contentHtml), attachments: attachments.filter(a => a.role === 'submitted') },
  };
}

export interface SubmitForm {
  hidden: Record<string, string>;
  requirements: Requirements;
  disabled: boolean;
}
export function parseSubmitForm(html: string, config: LoadedConfig): SubmitForm {
  const $ = cheerio.load(html);
  const input = $(config.protocol.selectors.fileInput).filter((_, el) => $(el).attr('name') === config.protocol.fields.file).first();
  if (!input.length) throw protocolError('提交页面未找到文件输入框，未尝试提交。');
  const fieldName = input.attr('name');
  if (fieldName && fieldName !== config.protocol.fields.file) throw protocolError('提交页面附件字段与协议配置不一致。');
  const form = input.closest('form').length ? input.closest('form') : $('form').first();
  const action = form.attr('action');
  if (action && new URL(action, config.baseUrl).origin !== config.baseUrl) throw protocolError('提交表单指向其他源。');
  const hidden: Record<string, string> = {};
  form.find('input[type=hidden][name]').each((_, el) => { hidden[$(el).attr('name')!] = $(el).attr('value') ?? ''; });
  const accept = input.attr('accept')?.split(',').map(v => v.trim().toLowerCase()).filter(Boolean) ?? [];
  const limit = input.attr('data-limit')?.trim().match(/^(\d+(?:\.\d+)?)\s*(B|K|KB|M|MB|G|GB)?$/i);
  const units: Record<string, number> = { B: 1, K: 1024, KB: 1024, M: 1048576, MB: 1048576, G: 1073741824, GB: 1073741824 };
  // The live fileupload control uses a numeric data-limit in MiB.
  const limitBytes = limit ? Number(limit[1]) * units[(limit[2] ?? 'M').toUpperCase()]! : null;
  const maxFileBytes = limitBytes !== null && Number.isSafeInteger(limitBytes) && limitBytes > 0 ? limitBytes : null;
  const remarksField = form.find('textarea[name]').filter((_, el) => $(el).attr('name') === config.protocol.fields.content).first();
  const lengthRaw = remarksField.attr('maxlength');
  const maxRemarksLength = lengthRaw !== undefined && /^\d+$/.test(lengthRaw) && Number.isSafeInteger(Number(lengthRaw)) ? Number(lengthRaw) : null;
  return {
    hidden,
    requirements: { instructions: htmlText(form.length ? form.html() ?? '' : html), acceptedExtensions: accept, maxFileBytes, maxRemarksLength, acceptsSource: accept.length ? 'form' : 'unknown' },
    disabled: input.is('[disabled]') || form.find('button[type=submit][disabled], input[type=submit][disabled]').length > 0,
  };
}
