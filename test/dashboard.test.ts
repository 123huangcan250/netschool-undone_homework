import test from 'node:test';
import assert from 'node:assert/strict';
import { LearnService } from '../src/learn.js';
import { json, mockLearn, row, testConfig } from './helpers.js';

test('dashboard fetches only unsubmitted category and deduplicates rows', async () => {
  const { config, cleanup } = await testConfig();
  try {
    const mock = mockLearn();
    const originalFetch = mock.runtime.fetch;
    mock.runtime.fetch = (async (input, init) => {
      if (String(input).includes('zyListWj')) {
        mock.requests.push({ url: new URL(String(input)), init: init ?? {} });
        return json({ result: 'success', object: { aaData: [row(), row()], iTotalRecords: 2 } });
      }
      return originalFetch(input, init);
    }) as typeof fetch;
    const result = await new LearnService(config, mock.runtime).getUnsubmittedHomeworkList('course-1');
    assert.equal(result.homeworks.length, 1);
    assert.equal(result.homeworks[0]?.status, 'unsubmitted');
    assert.deepEqual(mock.requests.filter(r => r.url.pathname.includes('zyList')).map(r => r.url.pathname.split('/').pop()), ['zyListWj']);
  } finally { await cleanup(); }
});

test('dashboard reads real description and assignment attachments without re-listing or opening submit form', async () => {
  const { config, cleanup } = await testConfig();
  try {
    const mock = mockLearn();
    const service = new LearnService(config, mock.runtime);
    await assert.rejects(service.getHomeworkContent('unknown'), { code: 'NOT_FOUND' });
    const { homeworks } = await service.getUnsubmittedHomeworkList('course-1');
    const detail = await service.getHomeworkContent(homeworks[0]!.homeworkId);
    assert.match(detail.descriptionText, /提交实验报告/);
    assert.equal(detail.attachments.find(a => a.role === 'assignment')?.name, '题目.pdf');
    assert.equal(mock.requests.filter(r => r.url.pathname.includes('zyList')).length, 1);
    assert.equal(mock.requests.filter(r => /tijiao|tjzy/.test(r.url.pathname)).length, 0);
    const metadata = mock.requests.find(r => r.url.pathname.endsWith('/detail'));
    assert.equal((metadata?.init.body as FormData).get('id'), homeworks[0]!.assignmentId);
  } finally { await cleanup(); }
});
