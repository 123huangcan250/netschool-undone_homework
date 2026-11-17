import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer as createHttpServer } from 'node:http';
import { once } from 'node:events';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createServer } from '../src/server.js';
import { mockLearn, projectDir, testConfig, writeSubmission } from './helpers.js';

test('official MCP client reads details, downloads an attachment, and submits via SDK transport', async t => {
  const env = await testConfig(); t.after(env.cleanup); const mock = mockLearn();
  const server = createServer(env.config, mock.runtime);
  const client = new Client({ name: 'contract-test', version: '1' });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(a); await client.connect(b);
  t.after(async () => { await client.close(); await server.close(); });
  const { tools } = await client.listTools();
  assert.deepEqual(tools.map(v => v.name), ['get_course_list', 'get_homework_list', 'get_homework_detail', 'download_homework_attachment', 'submit_homework']);
  assert.ok(tools.every(tool => tool.outputSchema && tool.inputSchema.type === 'object'));
  assert.equal(tools[4]!.annotations?.destructiveHint, true);
  const destinationPath = join(env.root, 'assignment.pdf');
  const cases = [
    ['get_course_list', {}],
    ['get_homework_list', { courseId: 'course-1' }],
    ['get_homework_detail', { homeworkId: 'student-hw-1' }],
    ['download_homework_attachment', { homeworkId: 'student-hw-1', attachmentIndex: 0, destinationPath }],
    ['submit_homework', { homeworkId: 'student-hw-1', filePath: await writeSubmission(env.root), remarks: '已完成' }],
  ] as const;
  for (const [name, args] of cases) {
    const result = await client.callTool({ name, arguments: args });
    assert.equal(result.isError, false, JSON.stringify(result));
    assert.equal((result.structuredContent as { ok: boolean }).ok, true);
  }
  assert.deepEqual(await readFile(destinationPath), Buffer.from([0, 1, 127, 128, 255]));
  const duplicate = await client.callTool({ name: 'download_homework_attachment', arguments: { homeworkId: 'student-hw-1', attachmentIndex: 0, destinationPath } });
  assert.equal(duplicate.isError, true);
  assert.deepEqual(await readFile(destinationPath), Buffer.from([0, 1, 127, 128, 255]));
  const bad = await client.callTool({ name: 'submit_homework', arguments: { homeworkId: 'student-hw-1' } });
  assert.equal(bad.isError, true); assert.equal(mock.state.posts, 1);
});

test('MCP operational errors include isError and safe structured guidance', async t => {
  const env = await testConfig(); t.after(env.cleanup); env.config.cookie = '';
  const server = createServer(env.config);
  const client = new Client({ name: 'error-test', version: '1' });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(a); await client.connect(b);
  t.after(async () => { await client.close(); await server.close(); });
  const result = await client.callTool({ name: 'get_course_list', arguments: {} });
  assert.equal(result.isError, true);
  assert.equal((result.structuredContent as { error: { code: string } }).error.code, 'AUTH_REQUIRED');
  assert.ok(!JSON.stringify(result).includes('test-session'));
});

test('real stdio subprocess negotiates MCP, lists tools, and fetches courses over loopback with actual spacing', async t => {
  const env = await testConfig(); t.after(env.cleanup);
  const mock = mockLearn(); const starts: number[] = [];
  const httpServer = createHttpServer(async (req, res) => {
    starts.push(Date.now());
    const response = await mock.handler(new URL(req.url!, 'http://127.0.0.1'), { method: req.method, headers: req.headers as Record<string, string> });
    res.writeHead(response.status, Object.fromEntries(response.headers));
    res.end(await response.text());
  });
  httpServer.listen(0, '127.0.0.1'); await once(httpServer, 'listening');
  t.after(() => new Promise<void>((resolve, reject) => httpServer.close(error => error ? reject(error) : resolve())));
  const address = httpServer.address() as { port: number };
  const { protocol, configPath, ...raw } = env.config;
  raw.baseUrl = `http://127.0.0.1:${address.port}`;
  raw.protocolFile = join(projectDir, 'config/protocol.json');
  await writeFile(configPath, JSON.stringify(raw));
  const client = new Client({ name: 'stdio-contract-test', version: '1' });
  const transport = new StdioClientTransport({ command: process.execPath, args: [join(projectDir, 'dist/index.js'), '--config', configPath], stderr: 'pipe' });
  let stderr = ''; transport.stderr?.on('data', chunk => { stderr += String(chunk); });
  await client.connect(transport);
  t.after(async () => { await client.close(); });
  assert.equal((await client.listTools()).tools.length, 5);
  const result = await client.callTool({ name: 'get_course_list', arguments: {} });
  assert.equal(result.isError, false, JSON.stringify(result));
  assert.equal((result.structuredContent as { data: { courses: unknown[] } }).data.courses.length, 1);
  assert.equal(starts.length, 3);
  for (let i = 1; i < starts.length; i++) assert.ok(starts[i]! - starts[i - 1]! >= 990, `Request interval ${starts[i]! - starts[i - 1]!}ms`);
  assert.ok(!stderr.includes('test-session'));
});
