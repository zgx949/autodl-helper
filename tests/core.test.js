import test from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizeConfig, parseAuthToken, classifyResponse, retryDelaySeconds,
  sanitizeMessage, parseRetryAfter,
} from '../src/core.js';

const NOW = Date.parse('2026-10-28T12:00:00Z');
const UUID = 'pro-test1234';
const jwt = (payload) => `eyJhbGciOiJub25lIn0.${Buffer.from(JSON.stringify(payload)).toString('base64url')}.signature`;

test('configuration defaults to an immediate 60-second task', () => {
  assert.deepEqual(normalizeConfig({ uuid: UUID }, NOW), {
    uuid: UUID, name: UUID, intervalSeconds: 60, maxAttempts: 0, startAt: NOW,
  });
});

test('configuration accepts numeric form values and trims names', () => {
  assert.deepEqual(normalizeConfig({
    uuid: ` ${UUID} `, name: ' Workstation ', intervalSeconds: '30', maxAttempts: '12', startAt: NOW + 60000,
  }, NOW), { uuid: UUID, name: 'Workstation', intervalSeconds: 30, maxAttempts: 12, startAt: NOW + 60000 });
});

test('configuration refuses malformed or unrelated instance identifiers', () => {
  for (const uuid of ['', 'abc', 'pro-a', 'pro-foo/bar', 'https://example.com', 'pro-foo\nbar']) {
    assert.throws(() => normalizeConfig({ uuid }, NOW));
  }
});

test('configuration enforces minimum interval and integer attempt limit', () => {
  for (const intervalSeconds of [0, 29, 30.1, 86401, Infinity, 'NaN']) {
    assert.throws(() => normalizeConfig({ uuid: UUID, intervalSeconds }, NOW));
  }
  for (const maxAttempts of [-1, 1.5, 100001, Infinity]) {
    assert.throws(() => normalizeConfig({ uuid: UUID, maxAttempts }, NOW));
  }
  assert.equal(normalizeConfig({ uuid: UUID, intervalSeconds: 86400, maxAttempts: 100000 }, NOW).maxAttempts, 100000);
});

test('configuration refuses stale and invalid schedule times', () => {
  for (const startAt of [NOW - 60001, NOW + 367 * 86400000, Infinity, 'tomorrow']) {
    assert.throws(() => normalizeConfig({ uuid: UUID, startAt }, NOW));
  }
  assert.equal(normalizeConfig({ uuid: UUID, startAt: NOW - 1000 }, NOW).startAt, NOW);
});

test('auth metadata preserves raw authorization rather than adding Bearer', () => {
  const token = jwt({ uid: 12345, exp: 1800000000 });
  assert.deepEqual(parseAuthToken(token), { token, identity: '12345', expiresAt: 1800000000000 });
});

test('opaque authorization remains usable without guessed expiry', () => {
  assert.deepEqual(parseAuthToken('opaque-value'), { token: 'opaque-value', identity: null, expiresAt: null });
});

test('malformed JWT payload shapes fall back to opaque auth', () => {
  for (const payload of [null, [], 42, 'not-an-object']) {
    const token = jwt(payload);
    assert.deepEqual(parseAuthToken(token), { token, identity: null, expiresAt: null });
  }
});

test('auth rejects empty values and header injection', () => {
  for (const token of ['', '   ', 'a\nb', 'a\rb', 'x'.repeat(16385)]) {
    assert.throws(() => parseAuthToken(token));
  }
});

test('only exact Success in a successful HTTP response counts as accepted', () => {
  assert.equal(classifyResponse(200, { code: 'Success', data: null }).kind, 'success');
  for (const body of [{ code: 'success' }, { code: 0 }, { msg: 'done' }, { code: 'InternalError', msg: '余额不足' }]) {
    assert.equal(classifyResponse(200, body).kind, 'error');
  }
  assert.equal(classifyResponse(500, { code: 'Success' }).kind, 'transient');
});

test('known no-inventory response retries instead of succeeding', () => {
  assert.equal(classifyResponse(200, {
    code: 'InternalError', msg: '当前算力规格暂无库存, 请修改配置或稍等再试',
  }).kind, 'stock');
  assert.equal(classifyResponse(200, { code: 'Other', msg: '当前算力规格暂无库存' }).kind, 'error');
});

test('auth rejection always stops and takes precedence over misleading body', () => {
  for (const status of [401, 403]) assert.equal(classifyResponse(status, { code: 'Success' }).kind, 'auth');
  assert.equal(classifyResponse(200, { code: 'AuthorizeFailed' }).kind, 'auth');
  assert.equal(classifyResponse(500, { code: 'TokenExpired' }).kind, 'auth');
});

test('rate limits and temporary server errors are distinguishable', () => {
  assert.equal(classifyResponse(429, { msg: 'too many requests' }).kind, 'rate-limit');
  assert.equal(classifyResponse(503, null).kind, 'transient');
  assert.equal(classifyResponse(400, { msg: 'bad request' }).kind, 'error');
});

test('malformed bodies never report success', () => {
  for (const body of [null, undefined, '', [], '<html>error</html>', 42]) {
    assert.equal(classifyResponse(200, body).kind, 'error');
  }
});

test('error messages remove auth and push credentials before display', () => {
  const token = jwt({ uid: 1 });
  const pushToken = ['SPT', 'mySecretToken'].join('_');
  const result = sanitizeMessage(`Authorization: ${token}, push ${pushToken}, opaque private-value`, ['private-value']);
  assert.ok(!result.includes(token));
  assert.ok(!result.includes(pushToken));
  assert.ok(!result.includes('private-value'));
  assert.ok(sanitizeMessage('x'.repeat(1000)).length <= 400);
  assert.ok(!sanitizeMessage('a\u0000b').includes('\u0000'));
});

test('transient retries back off while respecting the chosen interval', () => {
  assert.equal(retryDelaySeconds(60, 0), 60);
  assert.equal(retryDelaySeconds(60, 1), 120);
  assert.equal(retryDelaySeconds(60, 2), 240);
  assert.equal(retryDelaySeconds(60, 100), 900);
  assert.equal(retryDelaySeconds(3600, 10), 3600);
  assert.equal(retryDelaySeconds(30, 0, 600), 600);
  assert.equal(retryDelaySeconds(60, 0, 100000), 86400);
});

test('Retry-After supports seconds, HTTP dates and malformed values', () => {
  assert.equal(parseRetryAfter('120', NOW), 120);
  assert.equal(parseRetryAfter('Wed, 28 Oct 2026 12:05:00 GMT', NOW), 300);
  assert.equal(parseRetryAfter('Wed, 28 Oct 2026 11:05:00 GMT', NOW), 0);
  assert.equal(parseRetryAfter('-1', NOW), 0);
  assert.equal(parseRetryAfter('nope', NOW), 0);
});
