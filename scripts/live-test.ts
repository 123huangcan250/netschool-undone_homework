import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { z } from 'zod';
import { loadConfig } from '../src/config.js';
import { AppError, asAppError } from '../src/errors.js';
import { CourseSchema, HomeworkSchema, HomeworkDetailSchema } from '../src/models.js';

// Uses the real compiled stdio server, and calls only its three read-only tools.
const args = process.argv.slice(2);
function arg(name: string): string | undefined {
  const index = args.indexOf(name);
  if (index < 0) return undefined;
  const value = args[index + 1];
  if (!value || value.startsWith('--')) throw new AppError('INVALID_INPUT', `${name} 缺少参数。`);
  return value;
}

async function main(): Promise<void> {
  const config = await loadConfig(arg('--config'));
  if (!config.cookie.trim()) throw new AppError('AUTH_REQUIRED', '本地 Cookie 配置为空，尚不能执行 MCP 真实接口测试。', false, '将正常登录后网络学堂请求的 Cookie 值写入本地配置。');
  const requestedCourse = arg('--course');
  const reportPath = resolve(arg('--report') ?? '.state/live-validation.json');
  const client = new Client({ name: 'thu-learn-live-validation', version: '1' });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [fileURLToPath(new URL('../dist/index.js', import.meta.url)), '--config', config.configPath],
    stderr: 'pipe',
  });
  // Drain child stderr without echoing any unexpected sensitive content.
  transport.stderr?.on('data', () => {});
  async function call<T>(name: string, input: Record<string, string>, schema: z.ZodType<T>): Promise<T> {
    if (!['get_course_list', 'get_homework_list', 'get_homework_detail'].includes(name)) throw new Error('Read-only test boundary');
    const result = await client.callTool({ name, arguments: input }, undefined, { timeout: 120000 });
    const output = result.structuredContent as { ok?: boolean; data?: unknown; error?: { code?: string } } | undefined;
    if (result.isError || !output?.ok) {
      const code = output?.error?.code;
      const known = ['AUTH_REQUIRED', 'CSRF_INVALID', 'NETWORK_ERROR', 'RATE_LIMITED', 'PROTOCOL_CHANGED', 'UPSTREAM_ERROR', 'NOT_FOUND'];
      throw new AppError(known.includes(code ?? '') ? code as AppError['code'] : 'PROTOCOL_CHANGED', `真实调用 ${name} 未通过。`, false, '核对本地会话及接口响应结构；没有回显 Cookie 或服务器原始内容。');
    }
    return schema.parse(output.data);
  }
  try {
    await client.connect(transport);
    const tools = await client.listTools();
    const expected = ['get_course_list', 'get_homework_list', 'get_homework_detail', 'submit_homework'];
    if (!expected.every(name => tools.tools.some(tool => tool.name === name))) throw new AppError('PROTOCOL_CHANGED', 'stdio 工具发现不完整。');
    const courses = await call('get_course_list', {}, z.object({ semesterId: z.string(), courses: z.array(CourseSchema) }));
    process.stdout.write(JSON.stringify({ stage: 'courses', ok: true, count: courses.courses.length }) + '\n');
    const candidates = requestedCourse ? courses.courses.filter(course => course.courseId === requestedCourse) : courses.courses;
    if (requestedCourse && !candidates.length) throw new AppError('NOT_FOUND', '指定课程不在本学期课程列表中。');
    const report: Record<string, unknown> = { observedAt: new Date().toISOString(), transport: 'stdio', readOnly: true, toolCount: tools.tools.length, courseCount: courses.courses.length, submissionTested: false };
    for (const course of candidates) {
      const list = await call('get_homework_list', { courseId: course.courseId }, z.object({ homeworks: z.array(HomeworkSchema) }));
      if (!list.homeworks.length && !requestedCourse) continue;
      const statusCounts = Object.fromEntries(['unsubmitted', 'submitted', 'graded'].map(status => [status, list.homeworks.filter(item => item.status === status).length]));
      report.homeworkCount = list.homeworks.length;
      report.statusCounts = statusCounts;
      process.stdout.write(JSON.stringify({ stage: 'homeworks', ok: true, count: list.homeworks.length, statusCounts }) + '\n');
      const details: Record<string, unknown>[] = [];
      for (const status of ['unsubmitted', 'submitted', 'graded'] as const) {
        const sample = list.homeworks.find(item => item.status === status);
        if (!sample) continue;
        const detail = await call('get_homework_detail', { homeworkId: sample.homeworkId }, HomeworkDetailSchema);
        if (detail.status !== sample.status || detail.deadline !== sample.deadline) throw new AppError('PROTOCOL_CHANGED', '列表与详情的状态或截止时间不一致，请重试读取以排除并发更新。');
        const check = { status, attachmentCount: detail.attachments.length, submittedAttachmentCount: detail.submission.attachments.length, deadlineMatches: true, maxRemarksLength: detail.requirements.maxRemarksLength, maxFileBytes: detail.requirements.maxFileBytes };
        details.push(check);
        process.stdout.write(JSON.stringify({ stage: 'detail', ok: true, ...check }) + '\n');
      }
      report.details = details;
      break;
    }
    await mkdir(dirname(reportPath), { recursive: true });
    await writeFile(reportPath, JSON.stringify(report, null, 2) + '\n', { mode: 0o600 });
    process.stdout.write(JSON.stringify({ stage: 'complete', ok: true, readOnly: true, report: reportPath }) + '\n');
  } finally { await client.close(); }
}

main().catch(error => {
  const e = asAppError(error);
  process.stdout.write(JSON.stringify({ ok: false, error: { code: e.code, message: e.message, remediation: e.remediation } }) + '\n');
  process.exitCode = 1;
});
