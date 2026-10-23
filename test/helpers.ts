import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { LoadedConfig } from '../src/config.js';
import { ProtocolSchema } from '../src/config.js';
import type { Runtime } from '../src/http.js';

export const projectDir = fileURLToPath(new URL('../', import.meta.url));
export async function testConfig(): Promise<{ config: LoadedConfig; root: string; cleanup: () => Promise<void> }> {
  const root = await mkdtemp(join(tmpdir(), 'thu-learn-test-'));
  await mkdir(join(root, 'submissions'));
  const raw = JSON.parse(await readFile(join(projectDir, 'config/example.json'), 'utf8'));
  const protocol = ProtocolSchema.parse(JSON.parse(await readFile(join(projectDir, 'config/protocol.json'), 'utf8')));
  const config: LoadedConfig = { ...raw, cookie: 'JSESSIONID=test-session; XSRF-TOKEN=test-xsrf', protocol, configPath: join(root, 'config.json') };
  config.submission.allowedRoots = [join(root, 'submissions')];
  config.submission.receiptFile = join(root, 'state', 'receipts.json');
  return { config, root, cleanup: async () => {
    const actual = await realpath(root);
    const parent = await realpath(tmpdir());
    if (!basename(actual).startsWith('thu-learn-test-') || resolve(actual, '..').toLowerCase() !== parent.toLowerCase()) throw Error('Unsafe test cleanup target');
    await rm(actual, { recursive: true, force: true });
  } };
}
export const row = (id = 'student-hw-1', title = '实验报告一') => ({
  xszyid: id, zyid: `assignment-${id}`, wlkcid: 'course-1', bt: title,
  jzsj: '2030-11-30 23:59:59', fbsj: '2030-10-01 08:00:00', bjjzsj: '2030-12-02 23:59:59',
  scsj: null, pysj: null, cj: null, zf: 100, zywcfs: 1, zytjfs: 2,
});
export function virtualRuntime(handler: (url: URL, init: RequestInit) => Promise<Response> | Response, start = Date.parse('2030-10-23T00:00:00Z')): Runtime & { starts: number[]; advance: (ms: number) => void } {
  let current = start;
  const starts: number[] = [];
  return {
    starts, now: () => current, sleep: async ms => { current += ms; }, advance: ms => { current += ms; },
    fetch: (async (input: RequestInfo | URL, init: RequestInit = {}) => {
      starts.push(current);
      return handler(new URL(String(input)), init);
    }) as typeof fetch,
  };
}
export const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json' } });

export function mockLearn() {
  const state = { submitted: false, posts: 0, filename: '', content: '', throwAfterPost: false, throwBeforePost: false, reject: false, expired: false, accept: '.pdf,.zip', remarksLimit: null as number | null, lastForm: undefined as FormData | undefined };
  const requests: { url: URL; init: RequestInit }[] = [];
  const handler = async (url: URL, init: RequestInit): Promise<Response> => {
    requests.push({ url, init });
    if (url.pathname === '/f/wlxt/index/course/student/') return new Response('<meta name="_csrf" content="test-csrf"><meta name="_csrf_header" content="X-CSRF-TOKEN">');
    if (url.pathname.endsWith('getCurrentAndNextSemester')) return json({ message: 'success', result: { id: '2030-2031-1' } });
    if (url.pathname.includes('loadCourseBySemesterId')) return json({ message: 'success', resultList: [{ wlkcid: 'course-1', zywkcm: '模拟课程 &amp; 实验', jsm: '模拟教师' }] });
    if (/zyList/.test(url.pathname)) {
      const target = url.pathname.split('/').pop();
      const active = state.submitted ? target === 'zyListYjwg' : target === 'zyListWj';
      const item = { ...row(), jzsj: state.expired ? '2020-01-01 00:00:00' : row().jzsj, scsj: state.submitted ? '2030-10-23 08:01:00' : null };
      return json({ result: 'success', object: { aaData: active ? [item] : [], iTotalRecords: active ? 1 : 0 } });
    }
    if (/\/(viewZy|viewTj|viewCj)$/.test(url.pathname)) {
      const group = (body: string) => `<div class="list fujian clearfix"><div class="fl">${body}</div></div>`;
      const submitted = state.submitted ? `<a href="/download?fileId=uploaded-file">${state.filename}</a>` : '';
      return new Response(`<div class="boxbox">assignment</div><div class="boxbox"><div class="right"></div><div class="right"></div><div class="right">${state.content}</div></div>${group('<a href="/download?fileId=teacher-file">题目.pdf</a>')}${group('')}${group(submitted)}${group('')}`);
    }
    if (url.pathname.endsWith('/detail')) return json({ result: 'success', msg: '<p>提交实验报告。答疑时间：2030-11-01 12:00</p>' });
    if (url.pathname.endsWith('/tijiao')) return new Response(`<form action="/b/wlxt/kczy/zy/student/tjzy" method="POST"><input type="hidden" name="_csrf" value="test-csrf"><input type="hidden" name="otherToken" value="hidden-value"><input type="file" name="fileupload" accept="${state.accept}"><textarea name="zynr"${state.remarksLimit === null ? '' : ` maxlength="${state.remarksLimit}"`}></textarea></form>`);
    if (url.pathname.endsWith('/tjzy')) {
      state.posts++;
      if (state.throwBeforePost) throw new TypeError('simulated network failure');
      state.lastForm = init.body as FormData;
      if (state.reject) return json({ result: 'error', msg: 'rejected' });
      const file = state.lastForm.get('fileupload') as File;
      state.filename = file.name;
      state.content = String(state.lastForm.get('zynr'));
      state.submitted = true;
      if (state.throwAfterPost) throw new TypeError('simulated lost acknowledgement');
      return json({ result: 'success' });
    }
    return new Response('not found', { status: 404 });
  };
  return { state, requests, handler, runtime: virtualRuntime(handler) };
}
export async function writeSubmission(root: string, name = 'report.pdf', text = 'synthetic coursework fixture'): Promise<string> {
  const target = join(root, 'submissions', name);
  await writeFile(target, text);
  return target;
}
