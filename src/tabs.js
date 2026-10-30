// All tabs may manage tasks, but only the Web Locks owner executes requests.
// Credentials and notification secrets never travel over the page channel.
export function createTabCoordinator({
  makeScheduler,
  getCredentials,
  openConsole,
  locks = navigator.locks,
  createChannel = () => new BroadcastChannel('autodl-scheduler:commands:v1'),
  makeId = () => crypto.randomUUID(),
  setTimer = (fn, delay) => setTimeout(fn, delay),
  clearTimer = timer => clearTimeout(timer),
  timeoutMs = 8000
}) {
  const remoteCommands = new Set(['GET_STATE', 'START_JOB', 'STOP_JOB', 'DELETE_JOB', 'SET_PREFERENCES', 'CLEAR_LOGS']);
  const unavailable = '未连接到任务管理标签页，请确认所有 AutoDL 标签页均已更新脚本并刷新；操作未自动重发，请确认任务状态后重试';
  const pending = new Map();
  const tabId = makeId();
  const waiting = new AbortController();
  let channel;
  let scheduler;
  let leader = false;
  let canForward = false;
  let destroyed = false;
  let releaseLock;

  function replaceScheduler(isLeader, reason) {
    scheduler?.destroy();
    leader = isLeader;
    scheduler = makeScheduler(isLeader, reason);
  }

  async function receive({ data }) {
    if (destroyed || !data || data.from === tabId) return;
    if (data.kind === 'response' && data.to === tabId) {
      const request = pending.get(data.id);
      if (!request) return;
      clearTimer(request.timer);
      pending.delete(data.id);
      request.resolve(data.result);
      return;
    }
    if (!leader || data.kind !== 'request' || typeof data.id !== 'string') return;
    const owner = scheduler;
    let result;
    try {
      if (data.operation === 'sync') {
        // Read auth in the executing tab, never trust auth supplied by a peer.
        await owner.syncPage({ ...await getCredentials(), instances: data.payload?.instances, pageUrl: data.payload?.pageUrl });
        result = { ok: true };
      } else if (remoteCommands.has(data.operation)) {
        result = await owner.command(data.operation, data.payload);
        if (result.snapshot) result.snapshot.connectionMode = 'remote';
      } else return;
    } catch { result = { ok: false, error: '任务管理标签页未能完成操作，请确认状态后重试' }; }
    if (!destroyed) channel.postMessage({ kind: 'response', from: tabId, to: data.from, id: data.id, result });
  }

  function hold(lock) {
    if (destroyed || !lock) return;
    const lifetime = new Promise(resolve => { releaseLock = resolve; });
    // A new scheduler pauses saved active tasks on takeover, just as on reload.
    replaceScheduler(true);
    return lifetime;
  }

  const ready = (async () => {
    if (!locks?.request) {
      replaceScheduler(false, '浏览器未提供标签页互斥锁，为避免重复开机已停用任务，请更新 Chrome 后重试');
      return;
    }
    try { channel = createChannel(); channel.onmessage = event => { void receive(event); }; }
    catch { /* A sole tab can still execute without a cross-tab channel. */ }
    try {
      // Resolve initialization when the callback starts, not when its lock ends.
      await new Promise((resolve, reject) => {
        locks.request('autodl-scheduler:leader:v1', { ifAvailable: true }, lock => {
          if (destroyed) { resolve(); return; }
          if (!lock) replaceScheduler(false, unavailable);
          const lifetime = hold(lock);
          resolve();
          return lifetime;
        }).catch(reject);
      });
      canForward = Boolean(channel);
      if (!leader && !destroyed) {
        // Queue without stealing the lock or interrupting the owner's requests.
        void locks.request('autodl-scheduler:leader:v1', { signal: waiting.signal }, hold).catch(() => {});
      }
    } catch {
      if (!destroyed) replaceScheduler(false, '无法取得标签页互斥锁，请刷新页面后重试');
    }
  })();

  function forward(operation, payload) {
    if (!canForward) return Promise.resolve({ ok: false, error: unavailable });
    const id = makeId();
    return new Promise(resolve => {
      const timer = setTimer(() => {
        pending.delete(id);
        resolve({ ok: false, error: unavailable });
      }, timeoutMs);
      pending.set(id, { resolve, timer });
      try { channel.postMessage({ kind: 'request', from: tabId, id, operation, payload }); }
      catch {
        clearTimer(timer);
        pending.delete(id);
        resolve({ ok: false, error: unavailable });
      }
    });
  }

  async function command(type, payload = {}) {
    await ready;
    if (destroyed) return { ok: false, error: '脚本已停止，请刷新页面' };
    if (type === 'OPEN_AUTODL') {
      openConsole();
      return command('GET_STATE');
    }
    if (leader) return scheduler.command(type, payload);
    // SPT stays in the owner's private memory instead of being broadcast.
    if (type === 'SET_PUSH') return { ok: false, error: '请在执行任务的标签页配置微信通知，通知密钥不会跨标签页传输' };
    if (!remoteCommands.has(type)) return { ok: false, error: '不支持的操作' };
    const response = await forward(type, payload);
    if (type === 'GET_STATE' && !response.ok) return scheduler.command(type);
    return response;
  }

  async function syncPage(payload) {
    await ready;
    if (destroyed) return;
    if (leader) return scheduler.syncPage(payload);
    // Strip auth and any unexpected fields before sending page observations.
    const response = await forward('sync', { instances: payload.instances, pageUrl: payload.pageUrl });
    if (!response.ok) throw new Error(response.error);
  }

  function destroy() {
    if (destroyed) return;
    destroyed = true;
    waiting.abort();
    scheduler?.destroy();
    releaseLock?.();
    for (const request of pending.values()) {
      clearTimer(request.timer);
      request.resolve({ ok: false, error: '脚本已停止，请刷新页面' });
    }
    pending.clear();
    channel?.close();
  }

  return { command, syncPage, destroy };
}
