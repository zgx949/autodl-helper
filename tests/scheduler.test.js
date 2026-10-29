import test from 'node:test';
import assert from 'node:assert/strict';
import { createScheduler } from '../src/scheduler.js';

const UUID = 'pro-test1234';
const NOW = Date.parse('2026-10-28T12:00:00Z');
const jwt = (uid = 12345) => `eyJhbGciOiJub25lIn0.${Buffer.from(JSON.stringify({ uid, exp: 4000000000 })).toString('base64url')}.signature`;
const tick = () => new Promise((resolve) => setImmediate(resolve));

async function harness({ request, saved = null, canRun = () => true, initialCredentials, sendPush, notify } = {}) {
  let currentTime = NOW;
  let sequence = 0;
  let persisted = structuredClone(saved);
  let writes = 0;
  let credentials = initialCredentials || { token: jwt(), appVersion: 'v6.51.0', isSubUser: false };
  const timers = new Map();
  const calls = [];
  const notices = [];
  const pushes = [];
  const scheduler = createScheduler({
    storage: { async get() { return structuredClone(persisted); }, async set(state) { persisted = structuredClone(state); writes++; } },
    getCredentials: () => structuredClone(credentials),
    requestPowerOn: async (options) => {
      calls.push(options);
      if (!request) throw new Error('Unexpected request in test');
      return request(options);
    },
    sendPush: sendPush || (async (...args) => { pushes.push(args); }),
    notify: notify || (async (...args) => { notices.push(args); }),
    openConsole: () => {},
    canRun,
    now: () => currentTime,
    setTimer: (fn, delay) => { const id = ++sequence; timers.set(id, { fn, at: currentTime + delay }); return id; },
    clearTimer: (id) => timers.delete(id),
    makeId: () => `run-${++sequence}`,
  });
  async function settle() { for (let i = 0; i < 8; i++) await tick(); }
  async function state() {
    const result = await scheduler.command('GET_STATE');
    assert.equal(result.ok, true, result.error);
    return result.snapshot;
  }
  async function start(config = {}) {
    const result = await scheduler.command('START_JOB', { config: { uuid: UUID, intervalSeconds: 60, maxAttempts: 0, ...config } });
    assert.equal(result.ok, true, result.error);
    return result.snapshot;
  }
  async function runNext() {
    assert.ok(timers.size, 'Expected a pending timer');
    const [id, timer] = [...timers].sort((a, b) => a[1].at - b[1].at)[0];
    timers.delete(id);
    currentTime = Math.max(currentTime, timer.at);
    timer.fn();
    await settle();
    return state();
  }
  await state();
  return {
    ...scheduler, start, state, runNext, settle, timers, calls, notices, pushes,
    credentials: (next) => { credentials = next; },
    persisted: () => structuredClone(persisted), writes: () => writes, now: () => currentTime,
    advanceTime: (milliseconds) => { currentTime += milliseconds; },
  };
}

const response = (status, body, retryAfter = null) => ({ status, headers: { get: () => retryAfter }, async json() { return body; } });
const stock = () => response(200, { code: 'InternalError', msg: '当前算力规格暂无库存, 请修改配置或稍等再试' });

test('standard instances sync, retry GPU shortages and finish without affecting a Pro task', async () => {
  const uuid = 'demo000001-00000001';
  let attempts = 0;
  const h = await harness({ request: async () => ++attempts === 1
    ? response(200, { code: 'InternalError', msg: '主机的空闲GPU不足，请稍后再试' })
    : response(200, { code: 'Success' }) });
  await h.syncPage({ token: jwt(), instances: [
    { uuid, name: 'Standard demo', status: '已关机', canPowerOn: true },
    { uuid: UUID, name: 'Pro demo', status: '已关机', canPowerOn: true },
    { uuid: 'invalid', status: '已关机' },
  ] });
  assert.equal((await h.state()).instances.length, 2);
  await h.start({ startAt: NOW + 3600000 });
  await h.start({ uuid });
  let state = await h.runNext();
  const job = state.jobs.find(job => job.uuid === uuid);
  assert.equal(job.name, 'Standard demo');
  assert.equal(job.status, 'retrying');
  assert.equal(job.nextRunAt, NOW + 60000);
  state = await h.runNext();
  assert.equal(state.jobs.find(job => job.uuid === uuid).status, 'success');
  assert.ok(state.jobs.find(job => job.uuid === UUID).enabled);
  assert.deepEqual(h.calls.map(call => call.uuid), [uuid, uuid]);
  assert.equal(h.notices[0][2], uuid, 'Notification must retain the target instance type');
  h.destroy();
});

test('a standard task stops before requesting if the page reports it already running', async () => {
  const uuid = 'demo000001-00000001';
  const h = await harness();
  await h.start({ uuid });
  await h.syncPage({ token: jwt(), instances: [{ uuid, status: '运行中', canPowerOn: false }] });
  assert.equal((await h.runNext()).jobs[0].status, 'stopped');
  assert.equal(h.calls.length, 0);
  h.destroy();
});

test('standard GPU shortages keep polling at a fixed interval beyond five attempts until success', async () => {
  const uuid = 'demo000001-00000001';
  let attempts = 0;
  const h = await harness({ request: async () => ++attempts <= 8
    ? response(200, { code: 'Other', msg: '当前机器没有足够的空闲GPU，请稍后再试' })
    : response(200, { code: 'Success' }) });
  await h.start({ uuid, intervalSeconds: 45 });
  for (let attempt = 1; attempt <= 8; attempt++) {
    const job = (await h.runNext()).jobs[0];
    assert.equal(job.enabled, true);
    assert.equal(job.status, 'retrying');
    assert.equal(job.attempts, attempt);
    assert.equal(job.maxAttempts, 0);
    assert.equal(job.consecutiveFailures, 0);
    assert.equal(job.nextRunAt, h.now() + 45000);
    assert.equal(h.notices.length, 0);
  }
  const job = (await h.runNext()).jobs[0];
  assert.equal(job.status, 'success');
  assert.equal(job.enabled, false);
  assert.equal(h.calls.length, 9);
  assert.equal(h.timers.size, 0);
  assert.equal(h.notices.length, 1);
  h.destroy();
});

test('manual stop cancels a standard GPU-shortage retry without sending another request', async () => {
  const uuid = 'demo000001-00000001';
  const h = await harness({ request: async () => response(200, { code: 'Other', msg: 'GPU不足' }) });
  await h.start({ uuid });
  assert.equal((await h.runNext()).jobs[0].status, 'retrying');
  assert.equal(h.timers.size, 1);
  const result = await h.command('STOP_JOB', { uuid });
  assert.equal(result.ok, true);
  assert.equal(result.snapshot.jobs[0].enabled, false);
  assert.equal(result.snapshot.jobs[0].status, 'stopped');
  h.advanceTime(3600000);
  await h.settle();
  assert.equal(h.calls.length, 1);
  assert.equal(h.timers.size, 0);
  h.destroy();
});

test('scheduler needs auth, validates config and sends no requests before timer fires', async () => {
  const h = await harness({ initialCredentials: { token: '' } });
  assert.equal((await h.command('START_JOB', { config: { uuid: UUID } })).ok, false);
  h.credentials({ token: jwt(), appVersion: 'v6.51.0' });
  assert.equal((await h.command('START_JOB', { config: { uuid: UUID, intervalSeconds: 1 } })).ok, false);
  await h.start();
  assert.equal(h.calls.length, 0);
  h.destroy();
});

test('exact Success stops polling and notifies that the request was accepted', async () => {
  const h = await harness({ request: async () => response(200, { code: 'Success' }) });
  await h.start();
  const state = await h.runNext();
  assert.equal(state.jobs[0].enabled, false);
  assert.equal(state.jobs[0].status, 'success');
  assert.equal(state.jobs[0].attempts, 1);
  assert.equal(h.calls.length, 1);
  assert.equal(h.calls[0].uuid, UUID);
  assert.equal(h.calls[0].token, jwt());
  assert.equal(h.calls[0].appVersion, 'v6.51.0');
  assert.equal(h.notices.length, 1);
  assert.match(h.notices[0][1], /受理/);
  assert.equal(h.timers.size, 0);
  assert.ok(!JSON.stringify(state).includes(jwt()));
  assert.ok(!JSON.stringify(h.persisted()).includes(jwt()));
  h.destroy();
});

test('stock response retries at the configured interval and maximum attempts stop exactly', async () => {
  const h = await harness({ request: async () => stock() });
  await h.start({ maxAttempts: 2 });
  let state = await h.runNext();
  assert.equal(state.jobs[0].status, 'retrying');
  assert.equal(state.jobs[0].nextRunAt, NOW + 60000);
  assert.equal(h.notices.length, 0);
  state = await h.runNext();
  assert.equal(state.jobs[0].status, 'exhausted');
  assert.equal(state.jobs[0].attempts, 2);
  assert.equal(h.calls.length, 2);
  assert.equal(h.timers.size, 0);
  h.destroy();
});

test('scheduled task waits until its requested time before its first request', async () => {
  const h = await harness({ request: async () => stock() });
  await h.start({ startAt: NOW + 3600000 });
  assert.equal((await h.state()).jobs[0].status, 'scheduled');
  assert.equal(h.calls.length, 0);
  const state = await h.runNext();
  assert.equal(h.now(), NOW + 3600000);
  assert.equal(h.calls.length, 1);
  assert.equal(state.jobs[0].status, 'retrying');
  h.destroy();
});

test('long schedules rearm after the one-day timer cap without early requests', async () => {
  const h = await harness({ request: async () => stock() });
  await h.start({ startAt: NOW + 2 * 86400000 });
  await h.runNext();
  assert.equal(h.now(), NOW + 86400000);
  assert.equal(h.calls.length, 0);
  await h.runNext();
  assert.equal(h.calls.length, 1);
  h.destroy();
});

test('429 honors Retry-After while unknown business and network errors stop', async (t) => {
  for (const [name, request, expected] of [
    ['rate limit', async () => response(429, {}, '600'), 'retrying'],
    ['business error', async () => response(200, { code: 'InternalError', msg: '余额不足' }), 'error'],
    ['network error', async () => { throw new Error('disconnected'); }, 'error'],
    ['malformed JSON', async () => ({ status: 200, async json() { throw new Error('bad JSON'); } }), 'error'],
  ]) await t.test(name, async () => {
    const h = await harness({ request });
    await h.start();
    const state = await h.runNext();
    assert.equal(state.jobs[0].status, expected);
    assert.equal(h.calls.length, 1);
    if (name === 'rate limit') assert.equal(state.jobs[0].nextRunAt, NOW + 600000);
    else assert.equal(h.timers.size, 0);
    h.destroy();
  });
});

test('five consecutive server errors stop and each retry backs off', async () => {
  const h = await harness({ request: async () => response(503, null) });
  await h.start();
  let state;
  for (let i = 0; i < 5; i++) state = await h.runNext();
  assert.equal(state.jobs[0].status, 'error');
  assert.equal(state.jobs[0].attempts, 5);
  assert.equal(h.calls.length, 5);
  assert.equal(h.timers.size, 0);
  assert.match(state.jobs[0].lastMessage, /5/);
  h.destroy();
});

test('401 clears auth and stops every active instance', async () => {
  const h = await harness({ request: async () => response(401, { code: 'AuthorizeFailed' }) });
  await h.start({ uuid: 'pro-other1234', startAt: NOW + 3600000 });
  await h.start();
  const state = await h.runNext();
  assert.equal(state.auth.available, false);
  assert.ok(state.jobs.every((job) => !job.enabled && job.status === 'error'));
  assert.equal(h.calls.length, 1);
  assert.equal(h.timers.size, 0);
  h.destroy();
});

test('current credentials are re-read before attempts and account changes prevent requests', async () => {
  const h = await harness({ request: async () => stock() });
  await h.start();
  h.credentials({ token: jwt(99999), appVersion: 'v6.52.0' });
  const state = await h.runNext();
  assert.equal(state.jobs[0].enabled, false);
  assert.equal(state.jobs[0].status, 'error');
  assert.equal(h.calls.length, 0);
  h.destroy();
});

test('a stopped in-flight request cannot overwrite the user stop with a late success', async () => {
  let resolve;
  const h = await harness({ request: () => new Promise((done) => { resolve = done; }) });
  await h.start();
  await h.runNext();
  const stopped = await h.command('STOP_JOB', { uuid: UUID });
  assert.equal(stopped.ok, true);
  assert.equal(h.calls[0].signal.aborted, true);
  resolve(response(200, { code: 'Success' }));
  await h.settle();
  const state = await h.state();
  assert.equal(state.jobs[0].status, 'stopped');
  assert.equal(h.notices.length, 0);
  h.destroy();
});

test('request timeout aborts and stops with an uncertain-result message', async () => {
  const h = await harness({ request: ({ signal }) => new Promise((resolve, reject) => {
    signal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true });
  }) });
  await h.start();
  await h.runNext();
  const state = await h.runNext();
  assert.equal(h.now(), NOW + 20000);
  assert.equal(state.jobs[0].status, 'error');
  assert.match(state.jobs[0].lastMessage, /未确认/);
  h.destroy();
});

test('refreshing the page pauses saved active tasks instead of silently repeating a paid request', async () => {
  const saved = { version: 1, jobs: [{ uuid: UUID, name: 'old', enabled: true, status: 'retrying', attempts: 3, nextRunAt: NOW - 1000 }], instances: [], logs: [] };
  const h = await harness({ saved });
  const state = await h.state();
  assert.equal(state.jobs[0].status, 'stopped');
  assert.equal(state.jobs[0].enabled, false);
  assert.equal(h.calls.length, 0);
  assert.equal(h.timers.size, 0);
  h.destroy();
});

test('a secondary tab is read-only and never writes shared state or sends requests', async () => {
  const saved = { version: 1, jobs: [{ uuid: UUID, name: 'leader job', enabled: true, status: 'retrying', attempts: 3, nextRunAt: NOW + 1000 }], instances: [], logs: [] };
  const h = await harness({ saved, canRun: () => false });
  const state = await h.state();
  assert.equal(state.readOnly, true);
  assert.equal(state.jobs[0].enabled, true);
  assert.equal((await h.command('START_JOB', { config: { uuid: UUID } })).ok, false);
  assert.equal((await h.command('STOP_JOB', { uuid: UUID })).ok, false);
  assert.equal((await h.command('DELETE_JOB', { uuid: UUID })).ok, false);
  assert.equal((await h.command('SET_PUSH', { token: ['SPT', 'test12345678'].join('_') })).ok, false);
  await h.syncPage({ token: jwt(), instances: [] });
  assert.equal(h.writes(), 0);
  assert.equal(h.calls.length, 0);
  assert.equal(h.timers.size, 0);
  h.destroy();
});

test('push secret is kept in memory, sends only after success and is absent from snapshots', async () => {
  const h = await harness({ request: async () => response(200, { code: 'Success' }) });
  const token = ['SPT', 'thisIsOnlyAMockedSecret'].join('_');
  assert.equal((await h.command('SET_PUSH', { token })).ok, true);
  await h.start();
  const state = await h.runNext();
  assert.equal(h.pushes.length, 1);
  assert.equal(h.pushes[0][0], token);
  assert.ok(!JSON.stringify(state).includes(token));
  assert.ok(!JSON.stringify(h.persisted()).includes(token));
  h.destroy();
});

test('destroy clears scheduled tasks and prevents subsequent commands', async () => {
  const h = await harness({ request: async () => stock() });
  await h.start({ startAt: NOW + 3600000 });
  h.destroy();
  assert.equal(h.timers.size, 0);
  assert.equal((await h.command('GET_STATE')).ok, false);
  assert.equal(h.calls.length, 0);
});

test('malformed credentials encountered during a retry stop the task instead of leaving it stuck', async () => {
  const h = await harness({ request: async () => stock() });
  await h.start();
  h.credentials({ token: 'invalid\nheader', appVersion: 'v6.51.0' });
  const state = await h.runNext();
  assert.equal(state.jobs[0].enabled, false);
  assert.equal(state.jobs[0].status, 'error');
  assert.equal(h.calls.length, 0);
  h.destroy();
});

test('one-click tasks use saved advanced preferences without requiring form fields', async () => {
  const h = await harness({ request: async () => stock() });
  assert.deepEqual((await h.state()).preferences, { intervalSeconds: 60, maxAttempts: 0, startAt: null });
  const preferences = { intervalSeconds: 90, maxAttempts: 4, startAt: NOW + 3600000 };
  const saved = await h.command('SET_PREFERENCES', { config: preferences });
  assert.equal(saved.ok, true, saved.error);
  assert.deepEqual(saved.snapshot.preferences, preferences);
  assert.deepEqual(h.persisted().preferences, preferences);
  const started = await h.command('START_JOB', { config: { uuid: UUID, name: 'One click' } });
  assert.equal(started.ok, true, started.error);
  const job = started.snapshot.jobs[0];
  assert.equal(job.name, 'One click');
  assert.equal(job.intervalSeconds, 90);
  assert.equal(job.maxAttempts, 4);
  assert.equal(job.nextRunAt, NOW + 3600000);
  assert.equal(job.status, 'scheduled');
  assert.equal(h.calls.length, 0);
  h.destroy();
});

test('explicit task configuration can override advanced defaults', async () => {
  const h = await harness({ request: async () => stock() });
  assert.equal((await h.command('SET_PREFERENCES', { config: { intervalSeconds: 120, maxAttempts: 8, startAt: NOW + 3600000 } })).ok, true);
  const started = await h.command('START_JOB', { config: { uuid: UUID, intervalSeconds: 45, maxAttempts: 2, startAt: null } });
  assert.equal(started.ok, true, started.error);
  const job = started.snapshot.jobs[0];
  assert.equal(job.intervalSeconds, 45);
  assert.equal(job.maxAttempts, 2);
  assert.equal(job.nextRunAt, NOW);
  h.destroy();
});

test('expired saved start time falls back to an immediate one-click task', async () => {
  const h = await harness({ request: async () => stock() });
  assert.equal((await h.command('SET_PREFERENCES', { config: { intervalSeconds: 90, maxAttempts: 3, startAt: NOW + 60000 } })).ok, true);
  h.advanceTime(120000);
  const started = await h.command('START_JOB', { config: { uuid: UUID } });
  assert.equal(started.ok, true, started.error);
  assert.equal(started.snapshot.jobs[0].nextRunAt, h.now());
  assert.equal(started.snapshot.jobs[0].intervalSeconds, 90);
  assert.equal(started.snapshot.jobs[0].status, 'running');
  h.destroy();
});

test('saving preferences does not create requests or reschedule active tasks', async () => {
  const h = await harness({ request: async () => stock() });
  const emptySaved = await h.command('SET_PREFERENCES', { config: { intervalSeconds: 75, maxAttempts: 5, startAt: null } });
  assert.equal(emptySaved.ok, true, emptySaved.error);
  assert.equal(emptySaved.snapshot.jobs.length, 0);
  assert.equal(h.timers.size, 0);
  assert.equal(h.calls.length, 0);
  await h.start({ startAt: NOW + 3600000 });
  const original = (await h.state()).jobs[0];
  const timerBefore = [...h.timers.values()][0].at;
  assert.equal((await h.command('SET_PREFERENCES', { config: { intervalSeconds: 300, maxAttempts: 1, startAt: NOW + 7200000 } })).ok, true);
  const unchanged = (await h.state()).jobs[0];
  assert.equal(unchanged.nextRunAt, original.nextRunAt);
  assert.equal(unchanged.intervalSeconds, original.intervalSeconds);
  assert.equal(unchanged.maxAttempts, original.maxAttempts);
  assert.equal([...h.timers.values()][0].at, timerBefore);
  assert.equal(h.calls.length, 0);
  h.destroy();
});

test('invalid preferences are rejected without changing saved defaults', async () => {
  const h = await harness();
  const previous = (await h.state()).preferences;
  for (const config of [
    { intervalSeconds: 1, maxAttempts: 0, startAt: null },
    { intervalSeconds: 60, maxAttempts: -1, startAt: null },
    { intervalSeconds: 60, maxAttempts: 0, startAt: NOW - 120000 },
    { intervalSeconds: 60, maxAttempts: 0, startAt: 'invalid' },
  ]) {
    const saved = await h.command('SET_PREFERENCES', { config });
    assert.equal(saved.ok, false);
    assert.deepEqual((await h.state()).preferences, previous);
  }
  assert.equal(h.calls.length, 0);
  assert.equal(h.timers.size, 0);
  h.destroy();
});

test('a powered-off instance can start a new round after a successful request without deleting history', async () => {
  const h = await harness({ request: async () => response(200, { code: 'Success' }) });
  await h.syncPage({ token: jwt(), instances: [{ uuid: UUID, name: 'Reusable instance', status: '已关机', canPowerOn: true }] });
  await h.start();
  const accepted = await h.runNext();
  assert.equal(accepted.jobs[0].status, 'success');
  const oldRunId = h.persisted().jobs[0].runId;
  const restarted = await h.command('START_JOB', { config: { uuid: UUID } });
  assert.equal(restarted.ok, true, restarted.error);
  assert.equal(restarted.snapshot.jobs.length, 1);
  assert.equal(restarted.snapshot.jobs[0].attempts, 0);
  assert.equal(restarted.snapshot.jobs[0].enabled, true);
  assert.equal(restarted.snapshot.jobs[0].nextRunAt, h.now());
  assert.notEqual(h.persisted().jobs[0].runId, oldRunId);
  assert.equal(h.calls.length, 1);
  assert.equal((await h.runNext()).jobs[0].status, 'success');
  assert.equal(h.calls.length, 2);
  h.destroy();
});

test('each ended record can be deleted without changing instances or another active task', async (t) => {
  for (const status of ['success', 'stopped', 'error', 'exhausted']) await t.test(status, async () => {
    const saved = { version: 1, jobs: [{ uuid: UUID, name: 'Ended job', enabled: false, status, attempts: 2 }],
      instances: [{ uuid: UUID, name: 'Reusable instance', status: '已关机' }], logs: [] };
    const h = await harness({ saved });
    await h.start({ uuid: 'pro-other1234', startAt: NOW + 3600000 });
    const result = await h.command('DELETE_JOB', { uuid: UUID });
    assert.equal(result.ok, true, result.error);
    assert.ok(!result.snapshot.jobs.some(job => job.uuid === UUID));
    assert.ok(result.snapshot.jobs.some(job => job.uuid === 'pro-other1234' && job.enabled));
    assert.ok(result.snapshot.instances.some(instance => instance.uuid === UUID));
    assert.equal(h.calls.length, 0);
    assert.equal(h.timers.size, 1);
    h.destroy();
  });
});

test('an active record must be stopped before deletion and remains scheduled if deletion is refused', async () => {
  const h = await harness();
  await h.start({ startAt: NOW + 3600000 });
  await h.start({ uuid: 'pro-other1234', startAt: NOW + 7200000 });
  const refused = await h.command('DELETE_JOB', { uuid: UUID });
  assert.equal(refused.ok, false);
  assert.match(refused.error, /停止/);
  assert.equal((await h.state()).jobs.filter(job => job.enabled).length, 2);
  assert.equal(h.timers.size, 2);
  assert.equal(h.calls.length, 0);
  assert.equal((await h.command('STOP_JOB', { uuid: UUID })).ok, true);
  assert.equal((await h.command('DELETE_JOB', { uuid: UUID })).ok, true);
  assert.equal(h.timers.size, 1);
  h.destroy();
});

test('confirmed running and starting instances reject a new task regardless of old successful history', async (t) => {
  for (const status of ['已开机', '运行中', '开机中']) await t.test(status, async () => {
    const saved = { version: 1, jobs: [{ uuid: UUID, name: 'Old success', enabled: false, status: 'success', attempts: 1 }], instances: [], logs: [] };
    const h = await harness({ saved });
    await h.syncPage({ token: jwt(), instances: [{ uuid: UUID, name: 'Running instance', status, canPowerOn: false }] });
    const result = await h.command('START_JOB', { config: { uuid: UUID } });
    assert.equal(result.ok, false);
    assert.equal((await h.state()).jobs[0].status, 'success');
    assert.equal(h.calls.length, 0);
    assert.equal(h.timers.size, 0);
    h.destroy();
  });
});

test('a current power-off update unlocks a previously running instance for a new task', async () => {
  const h = await harness({ request: async () => stock() });
  await h.syncPage({ token: jwt(), instances: [{ uuid: UUID, status: '运行中', canPowerOn: false }] });
  assert.equal((await h.command('START_JOB', { config: { uuid: UUID } })).ok, false);
  await h.syncPage({ token: jwt(), instances: [{ uuid: UUID, status: '已关机', canPowerOn: true }] });
  assert.equal((await h.command('START_JOB', { config: { uuid: UUID } })).ok, true);
  assert.equal((await h.runNext()).jobs[0].status, 'retrying');
  assert.equal(h.calls.length, 1);
  h.destroy();
});

test('a queued task does not send another power-on request after the page reports the instance running', async () => {
  const h = await harness({ request: async () => stock() });
  await h.syncPage({ token: jwt(), instances: [{ uuid: UUID, status: '已关机', canPowerOn: true }] });
  await h.start({ startAt: NOW + 3600000 });
  await h.syncPage({ token: jwt(), instances: [{ uuid: UUID, status: '运行中', canPowerOn: false }] });
  const state = await h.runNext();
  assert.equal(state.jobs[0].enabled, false);
  assert.equal(h.calls.length, 0);
  assert.equal(h.timers.size, 0);
  h.destroy();
});
