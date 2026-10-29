import test from 'node:test';
import assert from 'node:assert/strict';
import { requestInstancePowerOn } from '../src/entry.js';

test('each instance uses its own power-on API regardless of the current page', async (t) => {
  const response = { status: 200 };
  const fetch = t.mock.method(globalThis, 'fetch', async () => response);
  const signal = new AbortController().signal;
  for (const [uuid, path, body] of [
    ['demo000001-00000001', 'instance/power_on', { instance_uuid: 'demo000001-00000001', payload: '' }],
    ['pro-demo0001', 'instance/pro/power_on', { instance_uuid: 'pro-demo0001', payload: '' }],
  ]) {
    assert.equal(await requestInstancePowerOn({ uuid, token: 'test-auth', appVersion: 'test-version', signal }), response);
    const [url, options] = fetch.mock.calls.at(-1).arguments;
    assert.equal(url, `https://www.autodl.com/api/v1/${path}`);
    assert.deepEqual(JSON.parse(options.body), body);
    assert.equal(options.method, 'POST');
    assert.equal(options.headers.authorization, 'test-auth');
    assert.equal(options.headers.appversion, 'test-version');
    assert.equal(options.credentials, 'include');
    assert.equal(options.redirect, 'error');
    assert.equal(options.signal, signal);
  }
  assert.throws(() => requestInstancePowerOn({ uuid: 'invalid', token: 'test-auth' }));
  assert.equal(fetch.mock.callCount(), 2, 'Invalid IDs must never send a request');
});

test('power-on omits unavailable application version metadata', async (t) => {
  const fetch = t.mock.method(globalThis, 'fetch', async () => ({}));
  await requestInstancePowerOn({ uuid: 'demo000001-00000001', token: 'test-auth' });
  assert.equal(Object.hasOwn(fetch.mock.calls[0].arguments[1].headers, 'appversion'), false);
});
