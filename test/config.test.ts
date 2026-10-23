import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { ConfigSchema, loadConfig } from '../src/config.js';
import { parseSubmitForm } from '../src/parsers.js';
import { projectDir, testConfig } from './helpers.js';

test('configuration rejects weak rate limits, invalid timezone, Cookie newlines, and non-loopback HTTP', async t => {
  const env = await testConfig(); t.after(env.cleanup);
  const { protocol, configPath, ...raw } = env.config;
  assert.equal(ConfigSchema.safeParse(raw).success, true);
  for (const bad of [{ requestIntervalMs: 999 }, { timezone: 'not/a/zone' }, { cookie: 'a=b\r\nBad: true' }, { cookie: 'Cookie: a=b' }, { cookie: 'not-a-cookie' }, { baseUrl: 'http://learn.tsinghua.edu.cn' }, { retryCount: 3 }]) {
    assert.equal(ConfigSchema.safeParse({ ...raw, ...bad }).success, false);
  }
});
test('configuration resolves all filesystem paths relative to config file, not cwd', async t => {
  const env = await testConfig(); t.after(env.cleanup);
  const { protocol, configPath, ...raw } = env.config;
  raw.protocolFile = join(projectDir, 'config/protocol.json');
  raw.submission.allowedRoots = ['submissions']; raw.submission.receiptFile = 'state/receipts.json';
  await writeFile(configPath, JSON.stringify(raw));
  const loaded = await loadConfig(configPath);
  assert.equal(loaded.submission.allowedRoots[0], join(dirname(configPath), 'submissions'));
  assert.equal(loaded.submission.receiptFile, join(dirname(configPath), 'state/receipts.json'));
});
test('missing or changed upload form is not treated as a valid submission form', async t => {
  const env = await testConfig(); t.after(env.cleanup);
  assert.throws(() => parseSubmitForm('<html>changed layout</html>', env.config), { code: 'PROTOCOL_CHANGED' });
  assert.throws(() => parseSubmitForm('<form><input type=file name=unknown></form>', env.config), { code: 'PROTOCOL_CHANGED' });
  assert.throws(() => parseSubmitForm('<form action="https://example.org/upload"><input type=file name=fileupload></form>', env.config), { code: 'PROTOCOL_CHANGED' });
});

test('live form selects homework file rather than avatar and extracts 1024MiB and 500-character constraints', async t => {
  const env = await testConfig(); t.after(env.cleanup);
  const html = await readFile(join(projectDir, 'test/fixtures/live-submit.anonymized.html'), 'utf8');
  // Also cover existing installations whose configured selector is still broad.
  env.config.protocol.selectors.fileInput = 'input[type=file]';
  const result = parseSubmitForm(html, env.config);
  assert.equal(result.requirements.maxFileBytes, 1073741824);
  assert.equal(result.requirements.maxRemarksLength, 500);
  assert.deepEqual(result.requirements.acceptedExtensions, []);
  assert.equal(result.disabled, false);
  assert.equal(result.hidden.xszyid, 'synthetic-student-homework-id');
  assert.equal(result.hidden.avatarToken, undefined);
});

test('malformed or missing form limits remain unknown rather than coercing to zero', async t => {
  const env = await testConfig(); t.after(env.cleanup);
  const result = parseSubmitForm('<form><input type="file" name="fileupload" data-limit="unknown"><textarea name="zynr" maxlength="unknown"></textarea></form>', env.config);
  assert.equal(result.requirements.maxFileBytes, null);
  assert.equal(result.requirements.maxRemarksLength, null);
});
