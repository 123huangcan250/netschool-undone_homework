import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import * as cheerio from 'cheerio';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createServer } from '../src/server.js';
import type { Course, Homework, HomeworkDetail } from '../src/models.js';
import { testConfig, projectDir, mockLearn } from './helpers.js';

test('ten offline evaluation answers are verified through read-only MCP tools', async t => {
  const env = await testConfig(); t.after(env.cleanup); const mock = mockLearn();
  const server = createServer(env.config, mock.runtime);
  const client = new Client({ name: 'read-only-evaluation', version: '1' });
  const [a, b] = InMemoryTransport.createLinkedPair(); await server.connect(a); await client.connect(b);
  t.after(async () => { await client.close(); await server.close(); });
  async function call<T>(name: string, args: Record<string, string>): Promise<T> {
    assert.notEqual(name, 'submit_homework');
    const value = await client.callTool({ name, arguments: args }); assert.equal(value.isError, false);
    return (value.structuredContent as { data: T }).data;
  }
  const { courses } = await call<{ courses: Course[] }>('get_course_list', {});
  const { homeworks } = await call<{ homeworks: Homework[] }>('get_homework_list', { courseId: courses[0]!.courseId });
  const detail = await call<HomeworkDetail>('get_homework_detail', { homeworkId: homeworks[0]!.homeworkId });
  const lab = homeworks.find(h => h.type === 'lab_report')!;
  const course = courses.find(c => c.courseId === detail.courseId && c.teacher === '模拟教师')!;
  assert.ok(detail.attachments.some(a => a.name === '题目.pdf'));
  const answers = [
    course.courseId, course.name, lab.deadline, detail.assignmentId,
    detail.timeNodes.find(n => /答疑/.test(n.label))!.iso,
    String(detail.status !== 'unsubmitted'), String(detail.completionType),
    detail.requirements.acceptedExtensions.find(v => v === '.zip'), detail.homeworkId, detail.lateDeadline,
  ];
  const $ = cheerio.load(await readFile(join(projectDir, 'evaluations/offline.xml'), 'utf8'), { xml: true });
  const expected = $('qa_pair > answer').map((_, el) => $(el).text()).get();
  assert.equal(expected.length, 10); assert.deepEqual(answers, expected); assert.equal(mock.state.posts, 0);
});
