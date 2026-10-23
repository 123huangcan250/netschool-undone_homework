import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { unzipSync } from 'fflate';
import { normalizeTime, normalizeHomework, classify, deduplicate } from '../src/parsers.js';
import { LearnService } from '../src/learn.js';
import { SubmissionService } from '../src/submission.js';
import { prepareUpload } from '../src/files.js';
import { testConfig, mockLearn, row, writeSubmission, virtualRuntime, json } from './helpers.js';

test('dates use Asia/Shanghai independent of host timezone; invalid dates remain null', () => {
  assert.equal(normalizeTime('2030-11-30 23:59:59', 'Asia/Shanghai'), '2030-11-30T15:59:59Z');
  assert.equal(normalizeTime('2030年11月30日 23:59', 'Asia/Shanghai'), '2030-11-30T15:59:00Z');
  assert.equal(normalizeTime('2030-11-30T23:59:59+08:00', 'Asia/Shanghai'), '2030-11-30T15:59:59Z');
  assert.equal(normalizeTime('2030-02-31 12:00:00', 'Asia/Shanghai'), null);
  assert.equal(normalizeTime(null, 'Asia/Shanghai'), null);
});
test('ID deduplication preserves distinct assignments sharing a title and prefers graded state', async t => {
  const env = await testConfig(); t.after(env.cleanup);
  const a = normalizeHomework(row('a', 'same'), 'course-1', 'unsubmitted', env.config, Date.now());
  const b = normalizeHomework(row('b', 'same'), 'course-1', 'submitted', env.config, Date.now());
  const result = deduplicate([a, b, { ...a, status: 'graded', score: 0 }]);
  assert.equal(result.length, 2); assert.equal(result[0]!.status, 'graded'); assert.equal(result[0]!.score, 0);
});
test('homework types are explicitly heuristic', () => {
  assert.equal(classify('实验预习报告'), 'lab_report'); assert.equal(classify('期末论文'), 'paper');
  assert.equal(classify('Quiz 1'), 'quiz'); assert.equal(classify('作业一'), 'ordinary');
  assert.equal(classify('Experiment I Report'), 'lab_report');
});
test('all three lists merge, detail uses assignmentId, and HTML attachments/content parse', async t => {
  const env = await testConfig(); t.after(env.cleanup); const mock = mockLearn();
  const learn = new LearnService(env.config, mock.runtime);
  const courses = await learn.getCourseList(); assert.equal(courses.courses[0]!.name, '模拟课程 & 实验');
  const list = await learn.getHomeworkList('course-1'); assert.equal(list.homeworks.length, 1);
  assert.equal(list.homeworks[0]!.deadline, '2030-11-30T15:59:59Z');
  const detail = await learn.getHomeworkDetail('student-hw-1');
  assert.equal(detail.attachments[0]!.name, '题目.pdf');
  assert.ok(detail.timeNodes.some(node => node.iso === '2030-11-01T04:00:00Z'));
  assert.deepEqual(detail.requirements.acceptedExtensions, ['.pdf', '.zip']);
  const request = mock.requests.find(r => r.url.pathname.endsWith('/detail'))!;
  assert.equal((request.init.body as FormData).get('id'), 'assignment-student-hw-1');
});
test('pagination follows totals and detects server ignoring offsets', async t => {
  const env = await testConfig(); t.after(env.cleanup); env.config.csrfToken = 'test'; env.config.pageSize = 1;
  const runtime = virtualRuntime((url, init) => {
    const params = JSON.parse(String((init.body as FormData).get('aoData')));
    const start = params.find((v: { name: string }) => v.name === 'iDisplayStart')?.value ?? 0;
    const isNew = url.pathname.endsWith('zyListWj');
    return json({ result: 'success', object: { aaData: isNew ? [row(start ? 'two' : 'one')] : [], iTotalRecords: isNew ? 2 : 0 } });
  });
  const list = await new LearnService(env.config, runtime).getHomeworkList('course-1');
  assert.equal(list.homeworks.length, 2);
  const broken = virtualRuntime(() => json({ result: 'success', object: { aaData: [row()], iTotalRecords: 2 } }));
  await assert.rejects(new LearnService(env.config, broken).getHomeworkList('course-1'), { code: 'PROTOCOL_CHANGED' });
});
test('one multipart upload sends student ID, hidden tokens, file bytes, and escaped remarks; replay verifies without repost', async t => {
  const env = await testConfig(); t.after(env.cleanup); const mock = mockLearn();
  const path = await writeSubmission(env.root);
  const submissions = new SubmissionService(new LearnService(env.config, mock.runtime));
  const result = await submissions.submit('student-hw-1', [path], '完成 <实验>\n说明');
  assert.equal(result.status, 'verified'); assert.equal(mock.state.posts, 1);
  assert.equal(mock.state.lastForm!.get('xszyid'), 'student-hw-1');
  assert.equal(mock.state.lastForm!.get('otherToken'), 'hidden-value');
  assert.equal(mock.state.lastForm!.get('isDeleted'), '0');
  assert.equal(mock.state.lastForm!.get('zynr'), '完成 &lt;实验&gt;<br>说明');
  assert.equal(await (mock.state.lastForm!.get('fileupload') as File).text(), 'synthetic coursework fixture');
  const second = await submissions.submit('student-hw-1', [path], '完成 <实验>\n说明');
  assert.equal(second.alreadySubmitted, true); assert.equal(mock.state.posts, 1);
});
test('multiple input files produce one valid ZIP and enforce final format', async t => {
  const env = await testConfig(); t.after(env.cleanup);
  const a = await writeSubmission(env.root, 'a.pdf', 'A'); const b = await writeSubmission(env.root, 'b.pdf', 'B');
  const requirements = { instructions: '', acceptedExtensions: ['.zip'], acceptsSource: 'form' as const, maxFileBytes: null, maxRemarksLength: null };
  const upload = await prepareUpload([a, b], requirements, env.config);
  const unzipped = unzipSync(upload.bytes);
  assert.equal(new TextDecoder().decode(unzipped['a.pdf']), 'A'); assert.equal(Object.keys(unzipped).length, 2);
  assert.equal(upload.packagedAsZip, true);
  assert.equal(upload.sha256, (await prepareUpload([a, b], requirements, env.config)).sha256);
  await assert.rejects(prepareUpload([a, b], { ...requirements, acceptedExtensions: ['.pdf'] }, env.config), { code: 'FILE_NOT_ALLOWED' });
});
test('file validation rejects paths outside allowed roots, empty files, and oversize uploads', async t => {
  const env = await testConfig(); t.after(env.cleanup);
  const requirements = { instructions: '', acceptedExtensions: [], acceptsSource: 'unknown' as const, maxFileBytes: null, maxRemarksLength: null };
  const outside = join(env.root, 'outside.pdf'); await writeFile(outside, 'outside');
  await assert.rejects(prepareUpload([outside], requirements, env.config), { code: 'FILE_NOT_ALLOWED' });
  const empty = await writeSubmission(env.root, 'empty.pdf', '');
  await assert.rejects(prepareUpload([empty], requirements, env.config), { code: 'FILE_NOT_ALLOWED' });
  env.config.submission.maxFileBytes = 2;
  const big = await writeSubmission(env.root, 'big.pdf', 'big');
  await assert.rejects(prepareUpload([big], requirements, env.config), { code: 'FILE_NOT_ALLOWED' });
});
test('expired deadline prevents mutation', async t => {
  const env = await testConfig(); t.after(env.cleanup); const mock = mockLearn(); mock.state.expired = true;
  const path = await writeSubmission(env.root);
  await assert.rejects(new SubmissionService(new LearnService(env.config, mock.runtime)).submit('student-hw-1', [path]), { code: 'DEADLINE_PASSED' });
  assert.equal(mock.state.posts, 0);
});
test('lost acknowledgement is recovered using read-only verification without retrying POST', async t => {
  const env = await testConfig(); t.after(env.cleanup); const mock = mockLearn(); mock.state.throwAfterPost = true;
  const path = await writeSubmission(env.root);
  const result = await new SubmissionService(new LearnService(env.config, mock.runtime)).submit('student-hw-1', [path]);
  assert.equal(result.status, 'verified'); assert.equal(mock.state.posts, 1);
});
test('unknown result is durable across restart and repeated calls never retransmit', async t => {
  const env = await testConfig(); t.after(env.cleanup); const mock = mockLearn(); mock.state.throwBeforePost = true;
  const path = await writeSubmission(env.root);
  await assert.rejects(new SubmissionService(new LearnService(env.config, mock.runtime)).submit('student-hw-1', [path]), { code: 'SUBMISSION_UNCERTAIN' });
  assert.equal(mock.state.posts, 1);
  const receipts = JSON.parse(await readFile(env.config.submission.receiptFile, 'utf8')); assert.equal(receipts[0].state, 'uncertain');
  const restarted = new SubmissionService(new LearnService(env.config, mock.runtime));
  await assert.rejects(restarted.submit('student-hw-1', [path]), { code: 'SUBMISSION_UNCERTAIN' });
  assert.equal(mock.state.posts, 1);
});
test('cross-process lock prevents concurrent mutation', async t => {
  const env = await testConfig(); t.after(env.cleanup); const mock = mockLearn();
  await mkdir(join(env.root, 'state')); await writeFile(`${env.config.submission.receiptFile}.lock`, 'test');
  await assert.rejects(new SubmissionService(new LearnService(env.config, mock.runtime)).submit('student-hw-1', [await writeSubmission(env.root)]), { code: 'SUBMISSION_BUSY' });
  assert.equal(mock.state.posts, 0);
});

test('deadline crossing while waiting for rate limiter prevents actual POST', async t => {
  const env = await testConfig(); t.after(env.cleanup); const mock = mockLearn();
  const start = Date.parse('2030-10-23T00:00:00Z');
  const runtime = virtualRuntime((url, init) => {
    if (url.pathname.endsWith('zyListWj')) return json({ result: 'success', object: { aaData: [{ ...row(), jzsj: new Date(start + 9500).toISOString() }], iTotalRecords: 1 } });
    return mock.handler(url, init);
  }, start);
  await assert.rejects(new SubmissionService(new LearnService(env.config, runtime)).submit('student-hw-1', [await writeSubmission(env.root)]), { code: 'DEADLINE_PASSED' });
  assert.equal(mock.state.posts, 0);
});

test('missing deadline is not guessed and blocks mutation by default', async t => {
  const env = await testConfig(); t.after(env.cleanup); const mock = mockLearn();
  const runtime = virtualRuntime((url, init) => {
    if (url.pathname.endsWith('zyListWj')) return json({ result: 'success', object: { aaData: [{ ...row(), jzsj: '' }], iTotalRecords: 1 } });
    return mock.handler(url, init);
  });
  await assert.rejects(new SubmissionService(new LearnService(env.config, runtime)).submit('student-hw-1', [await writeSubmission(env.root)]), { code: 'DEADLINE_UNKNOWN' });
  assert.equal(mock.state.posts, 0);
});

test('pre-existing same filename and content cannot falsely verify an unconfirmed overwrite', async t => {
  const env = await testConfig(); t.after(env.cleanup); const mock = mockLearn();
  mock.state.submitted = true; mock.state.filename = 'report.pdf'; mock.state.content = '';
  mock.state.throwBeforePost = true;
  const service = new SubmissionService(new LearnService(env.config, mock.runtime));
  await assert.rejects(service.submit('student-hw-1', [await writeSubmission(env.root)]), { code: 'SUBMISSION_UNCERTAIN' });
  assert.equal(mock.state.posts, 1);
});

test('live detail routing uses viewZy, viewTj, and viewCj according to submission state', async t => {
  const env = await testConfig(); t.after(env.cleanup);
  const now = Date.parse('2030-10-23T00:00:00Z');
  for (const [status, endpoint] of [['unsubmitted', 'viewZy'], ['submitted', 'viewTj'], ['graded', 'viewCj']] as const) {
    const homework = normalizeHomework(row(), 'course-1', status, env.config, now);
    const url = new URL(homework.url);
    assert.ok(url.pathname.endsWith(`/${endpoint}`));
    assert.equal(url.searchParams.get('zyid'), 'assignment-student-hw-1');
    assert.equal(url.searchParams.get('xszyid'), 'student-hw-1');
  }
  env.config.protocol.homeworkPages = undefined;
  assert.ok(normalizeHomework(row(), 'course-1', 'unsubmitted', env.config, now).url.includes('/viewCj?'));
});

test('remarks exceeding live maxlength are rejected before upload or submission', async t => {
  const env = await testConfig(); t.after(env.cleanup); const mock = mockLearn(); mock.state.remarksLimit = 500;
  const service = new SubmissionService(new LearnService(env.config, mock.runtime));
  await assert.rejects(service.submit('student-hw-1', [await writeSubmission(env.root)], '字'.repeat(501)), { code: 'INVALID_INPUT' });
  assert.equal(mock.state.posts, 0);
});

test('expired submitted homework remains readable when its submission page has closed', async t => {
  const env = await testConfig(); t.after(env.cleanup); const mock = mockLearn();
  mock.state.submitted = true; mock.state.expired = true; mock.state.filename = 'report.pdf';
  const runtime = virtualRuntime(async (url, init) => {
    if (url.pathname.endsWith('/tijiao')) throw new Error('Closed submission page must not be requested');
    const response = await mock.handler(url, init);
    if (/zyList/.test(url.pathname)) {
      const data = await response.json();
      for (const item of data.object.aaData) item.bjjzsj = null;
      return json(data);
    }
    return response;
  });
  const learn = new LearnService(env.config, runtime);
  const detail = await learn.getHomeworkDetail('student-hw-1');
  assert.equal(detail.status, 'submitted');
  assert.equal(detail.submission.attachments[0]!.name, 'report.pdf');
  assert.equal(detail.requirements.maxRemarksLength, null);
  assert.ok(detail.warnings.some(w => w.includes('窗口已关闭')));
  await assert.rejects(new SubmissionService(learn).submit('student-hw-1', [await writeSubmission(env.root)]), { code: 'DEADLINE_PASSED' });
  assert.equal(mock.state.posts, 0);
});

test('a verified receipt can be checked after deadline without reopening submission form', async t => {
  const env = await testConfig(); t.after(env.cleanup); const mock = mockLearn();
  let closedPageRequests = 0;
  const runtime = virtualRuntime(async (url, init) => {
    if (url.pathname.endsWith('/tijiao') && mock.state.expired) {
      closedPageRequests++; throw new Error('Submission page closed');
    }
    const response = await mock.handler(url, init);
    if (/zyList/.test(url.pathname)) {
      const data = await response.json();
      for (const item of data.object.aaData) item.bjjzsj = null;
      return json(data);
    }
    return response;
  });
  const submissions = new SubmissionService(new LearnService(env.config, runtime));
  const path = await writeSubmission(env.root);
  assert.equal((await submissions.submit('student-hw-1', [path])).status, 'verified');
  mock.state.expired = true;
  assert.equal((await submissions.submit('student-hw-1', [path])).alreadySubmitted, true);
  assert.equal(closedPageRequests, 0); assert.equal(mock.state.posts, 1);
});
