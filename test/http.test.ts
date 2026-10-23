import test from 'node:test';
import assert from 'node:assert/strict';
import { LearnHttpClient } from '../src/http.js';
import { testConfig, virtualRuntime, json } from './helpers.js';

test('all concurrent requests, redirects, and retries respect >= 1000ms spacing', async t => {
  const env = await testConfig(); t.after(env.cleanup); env.config.csrfToken = 'test';
  let count = 0;
  const runtime = virtualRuntime(url => {
    if (url.pathname === '/redirect') return new Response('', { status: 302, headers: { Location: '/final' } });
    if (url.pathname === '/retry' && ++count < 3) return json({}, 503);
    return json({ ok: true });
  });
  const client = new LearnHttpClient(env.config, runtime);
  await Promise.all([client.json('/retry'), client.json('/redirect'), client.json('/other')]);
  assert.equal(count, 3);
  for (let i = 1; i < runtime.starts.length; i++) assert.ok(runtime.starts[i]! - runtime.starts[i - 1]! >= 1000);
});
test('read failure retries exactly twice; 400 does not retry', async t => {
  const env = await testConfig(); t.after(env.cleanup); env.config.csrfToken = 'test';
  let calls = 0;
  const runtime = virtualRuntime(() => { calls++; throw new TypeError('network with secret'); });
  const client = new LearnHttpClient(env.config, runtime);
  await assert.rejects(client.json('/read'), { code: 'NETWORK_ERROR' }); assert.equal(calls, 3);
  const bad = virtualRuntime(() => json({}, 400));
  await assert.rejects(new LearnHttpClient(env.config, bad).json('/read'), { code: 'UPSTREAM_ERROR' });
  assert.equal(bad.starts.length, 1);
});

test('slow response still leaves a full cooldown before the next request', async t => {
  const env = await testConfig(); t.after(env.cleanup); env.config.csrfToken = 'test';
  const runtime = virtualRuntime(() => { runtime.advance(800); return json({ ok: true }); });
  const client = new LearnHttpClient(env.config, runtime);
  await client.json('/first');
  await client.json('/second');
  assert.ok(runtime.starts[1]! - runtime.starts[0]! >= 1800);
});
test('Retry-After delays subsequent request without bypassing rate limiter', async t => {
  const env = await testConfig(); t.after(env.cleanup); env.config.csrfToken = 'test';
  let calls = 0;
  const runtime = virtualRuntime(() => ++calls === 1 ? new Response('', { status: 429, headers: { 'Retry-After': '5' } }) : json({ ok: true }));
  await new LearnHttpClient(env.config, runtime).json('/read');
  assert.ok(runtime.starts[1]! - runtime.starts[0]! >= 5000);
});
test('mutating POST is sent once on timeout or HTTP 503', async t => {
  const env = await testConfig(); t.after(env.cleanup); env.config.csrfToken = 'test';
  for (const response of ['timeout', '503']) {
    const runtime = virtualRuntime(() => { if (response === 'timeout') throw new Error('lost response'); return json({}, 503); });
    await assert.rejects(new LearnHttpClient(env.config, runtime).json('/submit', { method: 'POST', body: () => new FormData() }), { code: 'SUBMISSION_UNCERTAIN' });
    assert.equal(runtime.starts.length, 1);
  }
});
test('login redirect is AUTH_REQUIRED and never forwards cookies to identity provider', async t => {
  const env = await testConfig(); t.after(env.cleanup); env.config.csrfToken = 'test';
  const runtime = virtualRuntime(() => new Response('', { status: 302, headers: { Location: 'https://id.tsinghua.edu.cn/login' } }));
  await assert.rejects(new LearnHttpClient(env.config, runtime).json('/read'), { code: 'AUTH_REQUIRED' });
  assert.equal(runtime.starts.length, 1);
});
test('HTML login page, 401, generic 403, and CSRF 403 are recognized', async t => {
  const env = await testConfig(); t.after(env.cleanup); env.config.csrfToken = 'test';
  const cases = [
    [200, '<input type="password">', 'AUTH_REQUIRED'], [401, '', 'AUTH_REQUIRED'],
    [403, 'Forbidden', 'AUTH_REQUIRED'], [403, 'Invalid CSRF token', 'CSRF_INVALID'],
  ] as const;
  for (const [status, body, code] of cases) {
    const runtime = virtualRuntime(() => new Response(body, { status }));
    await assert.rejects(new LearnHttpClient(env.config, runtime).json('/read'), { code });
    assert.equal(runtime.starts.length, 1);
  }
});
test('session bootstrap extracts linked CSRF, sends headers, and accepts Set-Cookie rotation', async t => {
  const env = await testConfig(); t.after(env.cleanup);
  let headers: Headers;
  const runtime = virtualRuntime((url, init) => {
    if (url.pathname.endsWith('/student/')) return new Response('<a href="/b/data?a=1&amp;_csrf=linked-token">data</a>', { headers: { 'Set-Cookie': 'JSESSIONID=rotated; Path=/; Secure' } });
    headers = new Headers(init.headers);
    assert.equal(url.searchParams.get('_csrf'), 'linked-token');
    assert.equal(headers.get('x-csrf-token'), 'linked-token');
    assert.ok(headers.get('cookie')?.includes('JSESSIONID=rotated'));
    assert.equal(headers.get('origin'), env.config.baseUrl);
    return json({ ok: true });
  });
  await new LearnHttpClient(env.config, runtime).json('/b/read', { method: 'POST', replaySafe: true, body: () => new FormData() });
});
test('empty Cookie produces actionable error before network; malformed response fails closed', async t => {
  const env = await testConfig(); t.after(env.cleanup);
  env.config.cookie = '';
  const runtime = virtualRuntime(() => { throw new Error('must not send'); });
  await assert.rejects(new LearnHttpClient(env.config, runtime).json('/read'), { code: 'AUTH_REQUIRED' });
  assert.equal(runtime.starts.length, 0);
  env.config.cookie = 'JSESSIONID=test'; env.config.csrfToken = 'test';
  await assert.rejects(new LearnHttpClient(env.config, virtualRuntime(() => new Response('<html>unexpected</html>'))).json('/read'), { code: 'PROTOCOL_CHANGED' });
});
