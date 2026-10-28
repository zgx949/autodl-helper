import { normalizeConfig, parseAuthToken, classifyResponse, retryDelaySeconds, parseRetryAfter, sanitizeMessage, instanceCanStart } from "./core.js";

export function createScheduler({
  storage,
  getCredentials = () => ({}),
  requestPowerOn,
  sendPush = async () => {},
  notify = async () => {},
  openConsole = () => window.open("https://www.autodl.com/console/instance/pro/list", "_blank", "noopener"),
  canRun = () => true,
  blockedReason = "另一个 AutoDL 标签页正在管理任务，请切回原页面；若原页面已关闭，请刷新本页",
  now = () => Date.now(),
  setTimer = (fn, delay) => setTimeout(fn, delay),
  clearTimer = timer => clearTimeout(timer),
  makeId = () => crypto.randomUUID()
} = {}) {
  const defaultPreferences = { intervalSeconds: 60, maxAttempts: 0, startAt: null };
  let state = { version: 1, preferences: { ...defaultPreferences }, jobs: [], instances: [], logs: [] };
  let auth = null;
  let pushToken = "";
  let queue = Promise.resolve();
  let destroyed = false;
  const timers = new Map();
  const requests = new Map();

  function locked(operation) {
    const result = queue.then(operation);
    queue = result.catch(() => {});
    return result;
  }
  function safe(value) { return sanitizeMessage(value, [auth?.token, pushToken]); }
  function log(level, message, uuid = "") {
    state.logs.unshift({ at: now(), level, uuid, message: safe(message) });
    state.logs.length = Math.min(state.logs.length, 150);
  }
  function hasAuth() { return Boolean(auth?.token && (!auth.expiresAt || auth.expiresAt > now())); }
  function normalizePreferences(input, allowExpired = false) {
    const startAt = input.startAt == null || input.startAt === "" ? null : Number(input.startAt);
    if (startAt !== null && (!Number.isFinite(startAt) || (!allowExpired && startAt <= now()))) {
      throw new Error("请选择未来的开始时间，或留空立即抢机");
    }
    const validated = normalizeConfig({
      uuid: "pro-defaults", intervalSeconds: input.intervalSeconds, maxAttempts: input.maxAttempts,
      startAt: startAt !== null && startAt > now() ? startAt : null
    }, now());
    return { intervalSeconds: validated.intervalSeconds, maxAttempts: validated.maxAttempts,
      startAt: startAt !== null && startAt > now() ? startAt : null };
  }
  function currentPreferences() {
    return { ...state.preferences, startAt: state.preferences.startAt > now() ? state.preferences.startAt : null };
  }
  async function persist() { await storage.set(structuredClone(state)); }
  function snapshot() {
    return structuredClone({
      instances: state.instances, preferences: currentPreferences(),
      auth: { available: hasAuth(), expiresAt: auth?.expiresAt || null, capturedAt: auth?.capturedAt || null, appVersion: auth?.appVersion || "", isSubUser: Boolean(auth?.isSubUser) },
      pushConfigured: Boolean(pushToken), readOnly: !canRun(), blockedReason: !canRun() ? blockedReason : "",
      jobs: state.jobs.map(({ runId, authIdentity, inFlightAt, ...job }) => job), logs: state.logs
    });
  }
  function clearJobTimer(uuid) {
    if (timers.has(uuid)) clearTimer(timers.get(uuid));
    timers.delete(uuid);
  }
  function arm(job) {
    clearJobTimer(job.uuid);
    if (!job.enabled || !job.nextRunAt || destroyed || !canRun()) return;
    // A one-day cap also avoids setTimeout's signed 32-bit delay overflow.
    const delay = Math.max(0, Math.min(86400000, job.nextRunAt - now()));
    timers.set(job.uuid, setTimer(() => {
      timers.delete(job.uuid);
      void executeJob(job.uuid).catch(() => {});
    }, delay));
  }
  function stopJob(job, message, status = "stopped") {
    job.enabled = false;
    job.status = status;
    job.nextRunAt = null;
    job.inFlightAt = null;
    job.updatedAt = now();
    job.lastMessage = safe(message);
    job.runId = makeId();
    clearJobTimer(job.uuid);
    requests.get(job.uuid)?.abort();
    requests.delete(job.uuid);
    log(status === "error" ? "error" : status === "success" ? "success" : "info", message, job.uuid);
  }
  async function updateAuth(credentials) {
    const token = typeof credentials?.token === "string" ? credentials.token.trim() : "";
    if (!token) {
      if (auth) {
        auth = null;
        for (const job of state.jobs.filter(item => item.enabled)) stopJob(job, "登录信息已清除，请重新登录后启动任务", "error");
        log("warn", "当前页面没有可用的登录鉴权");
      }
      return;
    }
    const parsed = parseAuthToken(token);
    const changedAccount = auth?.identity && parsed.identity && auth.identity !== parsed.identity;
    const changedMode = auth && Boolean(auth.isSubUser) !== Boolean(credentials.isSubUser);
    if (changedAccount || changedMode) {
      for (const job of state.jobs.filter(item => item.enabled)) stopJob(job, "登录账户已切换，请确认实例后重新启动任务", "error");
      state.instances = [];
      log("warn", "检测到登录账户切换，原账户的任务已停止");
    }
    const appVersion = String(credentials.appVersion || "").slice(0, 40);
    if (/[\r\n]/.test(appVersion)) throw new Error("应用版本格式无效");
    const previousToken = auth?.token;
    auth = { ...parsed, appVersion, isSubUser: Boolean(credentials.isSubUser), capturedAt: previousToken === token ? auth.capturedAt : now() };
    if (previousToken !== token) log(hasAuth() ? "info" : "warn", hasAuth() ? "已读取当前页面的登录鉴权" : "登录鉴权已过期，请重新登录");
  }
  function load(data) {
    if (!data || data.version !== 1) return;
    let preferences;
    try { preferences = normalizePreferences(data.preferences || defaultPreferences, true); }
    catch { preferences = { ...defaultPreferences }; }
    state = { version: 1, preferences, jobs: Array.isArray(data.jobs) ? data.jobs.slice(0, 100) : [],
      instances: Array.isArray(data.instances) ? data.instances.slice(0, 200) : [],
      logs: Array.isArray(data.logs) ? data.logs.slice(0, 150) : [] };
  }
  const ready = (async () => {
    load(await storage.get());
    await updateAuth(await getCredentials());
    if (!canRun()) return;
    // Reloading a page must never silently replay an old paid operation.
    for (const job of state.jobs.filter(item => item.enabled)) {
      stopJob(job, job.inFlightAt ? "页面上次关闭时请求结果未确认，请先到控制台检查再重新启动" : "页面已重新加载，任务已暂停；确认配置后请重新启动", "stopped");
    }
    await persist();
  })();

  async function report(title, message, uuid) {
    try { await notify(title, safe(message)); }
    catch {
      await locked(async () => { log("warn", "系统通知未发送成功，请在面板查看任务结果", uuid); await persist(); });
    }
  }
  async function executeJob(uuid) {
    await ready;
    if (destroyed || !canRun()) return;
    const attempt = await locked(async () => {
      const job = state.jobs.find(item => item.uuid === uuid);
      if (!job?.enabled || job.inFlightAt || requests.has(uuid)) return null;
      if (job.nextRunAt > now()) { arm(job); return null; }
      // Read the current token for each attempt, including after a background-tab delay.
      try { await updateAuth(await getCredentials()); }
      catch {
        stopJob(job, "无法读取有效的页面登录信息，请刷新页面后重新启动任务", "error");
        await persist();
        return null;
      }
      if (!job.enabled) { await persist(); return null; }
      if (!hasAuth() || (job.authIdentity && auth?.identity !== job.authIdentity) || auth?.isSubUser) {
        stopJob(job, "登录鉴权失效或账户已改变，请重新登录个人账户后启动任务", "error");
        await persist();
        void report("AutoDL 任务已停止", job.lastMessage, uuid);
        return null;
      }
      const instance = state.instances.find(item => item.uuid === uuid);
      if (!instanceCanStart(instance)) {
        stopJob(job, `实例当前${instance?.status || "不可开机"}，已停止后续抢机尝试`, "stopped");
        await persist();
        return null;
      }
      job.attempts += 1;
      job.status = "running";
      job.inFlightAt = now();
      job.nextRunAt = null;
      job.updatedAt = now();
      job.lastMessage = `正在发送第 ${job.attempts} 次开机请求`;
      log("info", job.lastMessage, uuid);
      await persist();
      return { runId: job.runId, token: auth.token, appVersion: auth.appVersion };
    });
    if (!attempt || destroyed || !canRun()) return;
    const jobBeforeRequest = state.jobs.find(item => item.uuid === uuid);
    if (!jobBeforeRequest?.enabled || jobBeforeRequest.runId !== attempt.runId) return;
    const controller = new AbortController();
    requests.set(uuid, controller);
    const timeout = setTimer(() => controller.abort(), 20000);
    let result;
    let retryAfter = 0;
    try {
      const response = await requestPowerOn({ uuid, token: attempt.token, appVersion: attempt.appVersion, signal: controller.signal });
      let body = null;
      try { body = await response.json(); } catch { /* A non-JSON response cannot count as success. */ }
      retryAfter = parseRetryAfter(response.headers?.get?.("retry-after"), now());
      result = classifyResponse(response.status, body);
      result.message = sanitizeMessage(result.message, [attempt.token, auth?.token, pushToken]);
    } catch {
      result = { kind: "error", message: "网络连接失败或请求超时，开机结果尚未确认；请到控制台确认状态后重新启动任务" };
    } finally {
      clearTimer(timeout);
      if (requests.get(uuid) === controller) requests.delete(uuid);
    }
    if (destroyed) return;
    let notification = null;
    let success = null;
    await locked(async () => {
      const job = state.jobs.find(item => item.uuid === uuid);
      if (!job?.enabled || job.runId !== attempt.runId) return;
      job.inFlightAt = null;
      job.updatedAt = now();
      job.lastMessage = result.message;
      if (result.kind === "success") {
        stopJob(job, result.message, "success");
        notification = ["AutoDL 开机请求已受理", `${job.name}：${result.message}`, uuid];
        success = { uuid, name: job.name, token: pushToken };
      } else if (result.kind === "auth") {
        auth = null;
        for (const active of state.jobs.filter(item => item.enabled)) stopJob(active, result.message, "error");
        notification = ["AutoDL 登录已失效", result.message, uuid];
      } else if (["stock", "rate-limit", "transient"].includes(result.kind)) {
        job.consecutiveFailures = result.kind === "stock" ? 0 : (job.consecutiveFailures || 0) + 1;
        if (job.maxAttempts && job.attempts >= job.maxAttempts) {
          stopJob(job, `${result.message}；已达到最大尝试次数`, "exhausted");
          notification = ["AutoDL 任务已结束", job.lastMessage, uuid];
        } else if (job.consecutiveFailures >= 5) {
          stopJob(job, "服务连续异常 5 次，已停止任务，请检查 AutoDL 控制台", "error");
          notification = ["AutoDL 任务已停止", job.lastMessage, uuid];
        } else {
          const delay = result.kind === "stock" ? job.intervalSeconds : retryDelaySeconds(job.intervalSeconds, job.consecutiveFailures, retryAfter);
          job.status = "retrying";
          job.nextRunAt = now() + delay * 1000;
          log("warn", `${result.message}；${delay} 秒后重试`, uuid);
          arm(job);
        }
      } else {
        stopJob(job, result.message, "error");
        notification = ["AutoDL 任务已停止", `${job.name}：${result.message}`, uuid];
      }
      await persist();
    });
    if (notification) await report(...notification);
    if (success?.token) {
      let sent = false;
      try { await sendPush(success.token, `${success.name}（${success.uuid}）开机请求已受理，请到控制台确认运行状态`); sent = true; } catch { /* Never include the service URL or secret in logs. */ }
      await locked(async () => { log(sent ? "info" : "warn", sent ? "微信通知已发送" : "微信通知未发送成功；开机结果已保留，请检查推送密钥", uuid); await persist(); });
    }
  }
  async function syncPage(payload) {
    await ready;
    if (destroyed || !canRun()) return;
    return locked(async () => {
      await updateAuth(payload);
      const byId = new Map(state.instances.map(item => [item.uuid, item]));
      for (const item of Array.isArray(payload.instances) ? payload.instances.slice(0, 200) : []) {
        if (!/^pro-[a-z0-9]{4,64}$/.test(item?.uuid || "")) continue;
        byId.set(item.uuid, { uuid: item.uuid, name: String(item.name || item.uuid).slice(0, 80), status: String(item.status || "").slice(0, 40),
          canPowerOn: typeof item.canPowerOn === "boolean" ? item.canPowerOn : null });
      }
      state.instances = [...byId.values()].slice(-200);
      await persist();
    });
  }
  async function command(type, payload = {}) {
    try {
      await ready;
      if (destroyed) throw new Error("脚本已停止，请刷新页面");
      if (type === "OPEN_AUTODL") { openConsole(); return { ok: true, snapshot: snapshot() }; }
      if (!canRun()) {
        if (type !== "GET_STATE") throw new Error(blockedReason);
        load(await storage.get());
        return { ok: true, snapshot: snapshot() };
      }
      return await locked(async () => {
        switch (type) {
          case "GET_STATE": return { ok: true, snapshot: snapshot() };
          case "START_JOB": {
            if (!payload.config || typeof payload.config !== "object") throw new Error("任务配置无效");
            const config = normalizeConfig({ ...currentPreferences(), ...payload.config }, now());
            await updateAuth(await getCredentials());
            if (!hasAuth()) throw new Error("请先登录 AutoDL 并刷新实例页面");
            if (auth.isSubUser) throw new Error("当前脚本支持个人账户 Pro 实例，请切换个人账户后重试");
            let job = state.jobs.find(item => item.uuid === config.uuid);
            if (job?.enabled) throw new Error("该实例任务已运行，请先停止后修改");
            if (state.jobs.filter(item => item.enabled).length >= 20) throw new Error("最多同时运行 20 个实例任务");
            if (!job && state.jobs.length >= 100) throw new Error("请先删除不需要的历史任务，最多保存 100 个");
            const instance = state.instances.find(item => item.uuid === config.uuid);
            if (!instanceCanStart(instance)) throw new Error(`实例当前${instance?.status || "不可开机"}，请在关机后再抢机`);
            const next = { ...config, name: config.name === config.uuid && instance ? instance.name : config.name,
              enabled: true, status: config.startAt > now() + 1000 ? "scheduled" : "running", attempts: 0, consecutiveFailures: 0,
              nextRunAt: config.startAt, updatedAt: now(), startedAt: now(), inFlightAt: null,
              lastMessage: "任务已启动，等待执行", runId: makeId(), authIdentity: auth.identity };
            if (job) Object.assign(job, next); else { job = next; state.jobs.push(job); }
            log("info", `任务已启动，每 ${job.intervalSeconds} 秒尝试一次`, job.uuid);
            await persist();
            arm(job);
            break;
          }
          case "SET_PREFERENCES": {
            if (!payload.config || typeof payload.config !== "object") throw new Error("高级设置无效");
            const preferences = normalizePreferences({ ...currentPreferences(), ...payload.config });
            state.preferences = preferences;
            log("info", "高级设置已保存，将用于之后添加的抢机任务");
            break;
          }
          case "STOP_JOB": {
            const job = state.jobs.find(item => item.uuid === payload.uuid);
            if (job?.enabled) stopJob(job, "任务已手动停止；已发出的请求仍可能被服务端处理");
            break;
          }
          case "DELETE_JOB": {
            const job = state.jobs.find(item => item.uuid === payload.uuid);
            if (job?.enabled) throw new Error("请先停止任务再删除");
            state.jobs = state.jobs.filter(item => item.uuid !== payload.uuid);
            break;
          }
          case "SET_PUSH": {
            const token = String(payload.token || "").trim();
            if (token && !/^SPT_[A-Za-z0-9_-]{8,200}$/.test(token)) throw new Error("请输入有效的 WxPusher SPT 密钥");
            pushToken = token;
            log("info", token ? "已配置微信通知（仅当前页面有效）" : "已关闭微信通知");
            break;
          }
          case "CLEAR_LOGS": state.logs = []; break;
          default: throw new Error("不支持的操作");
        }
        await persist();
        return { ok: true, snapshot: snapshot() };
      });
    } catch (error) { return { ok: false, error: safe(error?.message || "操作失败") }; }
  }
  function destroy() {
    destroyed = true;
    for (const timer of timers.values()) clearTimer(timer);
    timers.clear();
    for (const controller of requests.values()) controller.abort();
    requests.clear();
  }
  return { command, syncPage, destroy };
}
