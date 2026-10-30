import test from 'node:test';
import assert from 'node:assert/strict';
import { createTabCoordinator } from '../src/tabs.js';
import { createScheduler } from '../src/scheduler.js';

const UUIDS = ['pro-demo0001', 'demo000001-00000001'];
const tick = () => new Promise(resolve => setImmediate(resolve));

// One origin-wide lock, including queued acquisition and AbortSignal cleanup.
function fakeLocks() {
  let held = false;
  const queue = [];
  function acquire(entry) {
    held = true;
    Promise.resolve().then(() => entry.callback({ name: 'test-lock' })).then(entry.resolve, entry.reject).finally(() => {
      held = false;
      const next = queue.shift();
      if (next) acquire(next);
    });
  }
  return {
    request(name, options, callback) {
      return new Promise((resolve, reject) => {
        if (options.signal?.aborted) { reject(new Error('aborted')); return; }
        const entry = { callback, resolve, reject };
        if (!held) acquire(entry);
        else if (options.ifAvailable) Promise.resolve().then(() => callback(null)).then(resolve, reject);
        else {
          queue.push(entry);
          options.signal?.addEventListener('abort', () => {
            const index = queue.indexOf(entry);
            if (index >= 0) { queue.splice(index, 1); reject(new Error('aborted')); }
          }, { once: true });
        }
      });
    }
  };
}

function network() {
  const peers = new Set();
  const messages = [];
  return {
    messages,
    createChannel() {
      const channel = {
        onmessage: null,
        postMessage(value) {
          const data = structuredClone(value);
          messages.push(data);
          for (const peer of peers) if (peer !== channel) queueMicrotask(() => {
            if (peers.has(peer)) peer.onmessage?.({ data: structuredClone(data) });
          });
        },
        close() { peers.delete(channel); }
      };
      peers.add(channel);
      return channel;
    }
  };
}

function setup(t, { locks = fakeLocks(), channelAvailable = true, timeoutMs = 50, seed = null } = {}) {
  const bus = network();
  const calls = [];
  const timers = new Map();
  let stored = seed;
  let id = 0;
  let writes = 0;
  const credentials = { token: 'mock-private-credential', appVersion: 'test' };
  const tabs = [];
  const storage = { get: async () => structuredClone(stored), set: async value => { writes++; stored = structuredClone(value); } };
  function tab() {
    const executions = [];
    const coordinator = createTabCoordinator({
      locks, timeoutMs, makeId: () => `id-${++id}`,
      createChannel: () => { if (!channelAvailable) throw new Error('unsupported'); return bus.createChannel(); },
      getCredentials: () => credentials,
      openConsole: () => executions.push('open'),
      makeScheduler: (isLeader, blockedReason) => createScheduler({
        storage, canRun: () => isLeader, blockedReason, getCredentials: () => credentials,
        requestPowerOn: async ({ uuid }) => {
          calls.push(uuid);
          return { status: 200, json: async () => ({ code: 'InternalError', msg: 'GPU数量不足' }) };
        },
        setTimer: (fn, delay) => { const key = ++id; timers.set(key, { fn, delay, owner: coordinator }); return key; },
        clearTimer: key => timers.delete(key)
      })
    });
    tabs.push(coordinator);
    return { ...coordinator, executions };
  }
  t.after(() => { for (const item of tabs) item.destroy(); });
  return { tab, calls, timers, bus, credentials, writes: () => writes, saved: () => stored };
}

async function state(tab) {
  const result = await tab.command('GET_STATE');
  assert.equal(result.ok, true);
  return result.snapshot;
}

for (const uuid of UUIDS) {
  test(`${uuid}: a second tab can retry ended jobs, stop and delete via the sole executor`, async t => {
    const h = setup(t, { seed: { version: 1, jobs: [{ uuid, enabled: false, status: 'success', attempts: 25 }], instances: [], logs: [] } });
    const owner = h.tab();
    await state(owner);
    const peer = h.tab();
    const peerState = await state(peer);
    assert.equal(peerState.readOnly, false, 'The second tab must not disable retry/delete');
    assert.equal(peerState.connectionMode, 'remote');
    await peer.syncPage({ ...h.credentials, instances: [{ uuid, name: 'peer instance', status: '已关机', canPowerOn: true }] });
    const result = await peer.command('START_JOB', { config: { uuid } });
    assert.equal(result.ok, true);
    assert.equal(result.snapshot.jobs[0].attempts, 0);
    assert.equal((await state(owner)).jobs[0].enabled, true);
    assert.equal(h.timers.size, 1, 'Only the owner schedules work');
    const [timerId, timer] = [...h.timers][0];
    h.timers.delete(timerId);
    timer.fn();
    await tick();
    assert.deepEqual(h.calls, [uuid]);
    assert.equal((await state(peer)).jobs[0].status, 'retrying');
    assert.equal((await peer.command('STOP_JOB', { uuid })).ok, true);
    assert.equal(h.timers.size, 0);
    assert.equal((await peer.command('START_JOB', { config: { uuid } })).ok, true, 'Stopped history is retryable too');
    assert.equal((await peer.command('STOP_JOB', { uuid })).ok, true);
    assert.equal((await peer.command('DELETE_JOB', { uuid })).ok, true);
    assert.equal((await state(owner)).jobs.length, 0);
    assert.ok(!JSON.stringify(h.bus.messages).includes(h.credentials.token), 'Auth is never broadcast');
  });
}

test('simultaneous starts from multiple tabs create only one job and timer', async t => {
  const h = setup(t);
  const owner = h.tab();
  await state(owner);
  const peerA = h.tab();
  const peerB = h.tab();
  await Promise.all([state(peerA), state(peerB)]);
  const results = await Promise.all([peerA.command('START_JOB', { config: { uuid: UUIDS[0] } }), peerB.command('START_JOB', { config: { uuid: UUIDS[0] } })]);
  assert.equal(results.filter(item => item.ok).length, 1);
  assert.equal((await state(owner)).jobs.length, 1);
  assert.equal(h.timers.size, 1);
});

test('owner closure automatically promotes a waiting tab and pauses active history', async t => {
  const h = setup(t);
  const owner = h.tab();
  await state(owner);
  const peer = h.tab();
  await state(peer);
  await owner.command('START_JOB', { config: { uuid: UUIDS[0] } });
  owner.destroy();
  await tick();
  const next = await state(peer);
  assert.equal(next.readOnly, false);
  assert.notEqual(next.connectionMode, 'remote');
  assert.equal(next.jobs[0].status, 'stopped');
  assert.equal(h.timers.size, 0);
  assert.equal(h.calls.length, 0, 'Takeover must never replay a paid request');
  assert.equal((await peer.command('START_JOB', { config: { uuid: UUIDS[0] } })).ok, true);
});

test('closing a waiting tab cancels its lock request and does not block the next tab', async t => {
  const h = setup(t);
  const owner = h.tab();
  await state(owner);
  const closing = h.tab();
  await state(closing);
  const next = h.tab();
  await state(next);
  closing.destroy();
  owner.destroy();
  await tick();
  assert.equal((await state(next)).readOnly, false);
  assert.equal((await next.command('START_JOB', { config: { uuid: UUIDS[1] } })).ok, true);
});

test('a stale running observation is replaced by the current peer page before retry', async t => {
  const h = setup(t);
  const owner = h.tab();
  await state(owner);
  const uuid = UUIDS[0];
  await owner.syncPage({ ...h.credentials, instances: [{ uuid, status: '运行中' }] });
  const peer = h.tab();
  await state(peer);
  assert.equal((await peer.command('START_JOB', { config: { uuid } })).ok, false);
  await peer.syncPage({ ...h.credentials, instances: [{ uuid, status: '已关机', canPowerOn: true }] });
  assert.equal((await peer.command('START_JOB', { config: { uuid } })).ok, true);
});

test('an old or unresponsive owner yields an explanatory read-only state without replaying commands', async t => {
  const locks = fakeLocks();
  let release;
  void locks.request('owner', {}, () => new Promise(resolve => { release = resolve; }));
  await tick();
  const h = setup(t, { locks, timeoutMs: 5 });
  const peer = h.tab();
  assert.equal((await state(peer)).readOnly, true);
  assert.match((await state(peer)).blockedReason, /更新脚本/);
  const result = await peer.command('START_JOB', { config: { uuid: UUIDS[0] } });
  assert.equal(result.ok, false);
  assert.match(result.error, /未自动重发/);
  release();
  await tick();
  assert.equal(h.calls.length, 0);
  assert.equal((await state(peer)).jobs.length, 0);
});

test('missing channels preserve the sole owner and explain why other tabs cannot mutate', async t => {
  const h = setup(t, { channelAvailable: false });
  const owner = h.tab();
  assert.equal((await state(owner)).readOnly, false);
  const peer = h.tab();
  assert.equal((await state(peer)).readOnly, true);
  const before = h.writes();
  assert.equal((await peer.command('START_JOB', { config: { uuid: UUIDS[0] } })).ok, false);
  assert.equal(h.writes(), before);
});

test('missing Web Locks never permits local execution', async t => {
  const h = setup(t, { locks: {} });
  const peer = h.tab();
  assert.equal((await state(peer)).readOnly, true);
  assert.match((await state(peer)).blockedReason, /互斥锁/);
  assert.equal((await peer.command('START_JOB', { config: { uuid: UUIDS[0] } })).ok, false);
  assert.equal(h.writes(), 0);
});

test('notification secrets and unsupported commands are never sent to the page channel', async t => {
  const h = setup(t);
  const owner = h.tab();
  await state(owner);
  const peer = h.tab();
  await state(peer);
  const before = h.bus.messages.length;
  assert.equal((await peer.command('SET_PUSH', { token: ['SPT', 'mock12345678'].join('_') })).ok, false);
  assert.equal((await peer.command('UNSUPPORTED', { token: h.credentials.token })).ok, false);
  assert.equal(h.bus.messages.length, before);
  assert.equal((await peer.command('SET_PREFERENCES', { config: { intervalSeconds: 0.1 } })).ok, true);
  assert.equal((await state(owner)).preferences.intervalSeconds, 0.1);
});
