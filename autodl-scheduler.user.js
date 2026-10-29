// ==UserScript==
// @name         AutoDL Helper · 一键抢机
// @namespace    autodl-scheduler.local
// @version      1.2.0
// @description  在 AutoDL 实例行一键抢机、自动重试，直接查看进度；定时和间隔可在高级设置中调整。
// @author       zgx949
// @license      MIT
// @homepageURL  https://github.com/zgx949/autodl-helper
// @supportURL   https://github.com/zgx949/autodl-helper/issues
// @downloadURL  https://raw.githubusercontent.com/zgx949/autodl-helper/main/autodl-scheduler.user.js
// @updateURL    https://raw.githubusercontent.com/zgx949/autodl-helper/main/autodl-scheduler.user.js
// @match        https://www.autodl.com/console/*
// @run-at       document-idle
// @noframes
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_xmlhttpRequest
// @grant        GM_notification
// @grant        GM_openInTab
// @connect      wxpusher.zjiecode.com
// ==/UserScript==

(() => {
'use strict';

// Source: src/core.js
const MIN_INTERVAL_SECONDS = 30;
const MAX_INTERVAL_SECONDS = 86400;
const ACTIVE_STATUSES = new Set(["scheduled", "running", "retrying"]);

function instanceType(uuid) {
  if (typeof uuid !== "string") return null;
  if (/^pro-[a-z0-9]{4,64}$/.test(uuid)) return "pro";
  if (/^[a-z0-9]{10}-[a-f0-9]{8}$/.test(uuid)) return "standard";
  return null;
}

function instanceConsoleUrl(uuid) {
  return `https://www.autodl.com/console/instance/${instanceType(uuid) === "pro" ? "pro/" : ""}list`;
}

// A task result describes a past request, not the instance's current power state.
// Only current page evidence can make an otherwise idle instance unavailable.
function instanceCanStart(instance) {
  const status = String(instance?.status || "").replace(/\s+/g, "").toLowerCase();
  if (/(?:已开机|运行中|正在运行|已运行|开机中|正在开机|启动中|正在启动|关机中|正在关机|重启中|正在重启|创建中|释放中|已释放|删除中|已删除|已销毁)/.test(status)) return false;
  if (/^(?:running|starting|restarting|stopping|provisioning|deleting|deleted|released)$/.test(status)) return false;
  if (typeof instance?.canPowerOn === "boolean") return instance.canPowerOn;
  // Missing page information must not turn old success records into a permanent lock.
  return true;
}

function normalizeConfig(input, now = Date.now()) {
  if (!input || typeof input !== "object") throw new Error("任务配置无效");
  const uuid = String(input.uuid || "").trim();
  if (!instanceType(uuid)) throw new Error("请输入有效的普通或 Pro 实例 ID");
  const intervalSeconds = Number(input.intervalSeconds ?? 60);
  if (!Number.isInteger(intervalSeconds) || intervalSeconds < MIN_INTERVAL_SECONDS || intervalSeconds > MAX_INTERVAL_SECONDS) {
    throw new Error("轮询间隔须为 30–86400 秒之间的整数");
  }
  const maxAttempts = Number(input.maxAttempts ?? 0);
  if (!Number.isInteger(maxAttempts) || maxAttempts < 0 || maxAttempts > 100000) throw new Error("最大次数须为 0–100000 的整数，0 表示不限");
  const startAt = input.startAt == null || input.startAt === "" ? now : Number(input.startAt);
  if (!Number.isFinite(startAt) || startAt < now - 60000) throw new Error("开始时间已过，请重新选择或留空立即开始");
  if (startAt > now + 366 * 86400000) throw new Error("开始时间须在未来一年内");
  return { uuid, name: String(input.name || uuid).trim().slice(0, 80) || uuid, intervalSeconds, maxAttempts, startAt: Math.max(now, startAt) };
}

function parseAuthToken(value) {
  const token = String(value || "").trim();
  if (!token || token.length > 16384 || /[\r\n]/.test(token)) throw new Error("鉴权信息为空或格式无效");
  let payload = {};
  try {
    const part = token.replace(/^Bearer\s+/i, "").split(".")[1];
    const base64 = part.replace(/-/g, "+").replace(/_/g, "/");
    const decoded = JSON.parse(atob(base64));
    if (decoded && typeof decoded === "object" && !Array.isArray(decoded)) payload = decoded;
  } catch { /* Opaque tokens remain usable; the server validates them. */ }
  return {
    token,
    expiresAt: Number.isFinite(payload.exp) ? payload.exp * 1000 : null,
    identity: payload.uid != null ? String(payload.uid) : (payload.uuid ? String(payload.uuid) : null)
  };
}

function sanitizeMessage(value, secrets = []) {
  let message = String(value ?? "").replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, "");
  for (const secret of secrets) if (secret) message = message.split(secret).join("[已隐藏]");
  return message.replace(/(?:Bearer\s+)?eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g, "[鉴权已隐藏]")
    .replace(/SPT_[A-Za-z0-9_-]+/g, "[推送密钥已隐藏]").slice(0, 400);
}

function classifyResponse(httpStatus, body) {
  const code = String(body?.code ?? "");
  const message = sanitizeMessage(body?.msg || body?.message || "");
  if ([401, 403].includes(httpStatus) || /^(AuthorizeFailed|Unauthorized|TokenExpired|Unauthenticated)$/i.test(code)) {
    return { kind: "auth", message: "登录鉴权失效，请刷新 AutoDL 页面或重新登录后启动任务" };
  }
  if (httpStatus === 429) return { kind: "rate-limit", message: "请求受到限流，已延长重试间隔" };
  if (httpStatus >= 500) return { kind: "transient", message: `服务暂时不可用（HTTP ${httpStatus}），稍后重试` };
  if (httpStatus < 200 || httpStatus >= 300) return { kind: "error", message: `请求失败（HTTP ${httpStatus}）${message ? `：${message}` : ""}` };
  if (!body || typeof body !== "object" || Array.isArray(body)) return { kind: "error", message: "接口返回格式异常，请到控制台确认实例状态" };
  if (code === "Success") return { kind: "success", message: "开机请求已受理，请到 AutoDL 控制台确认运行状态" };
  if (code === "InternalError" && /(?:当前算力规格暂无库存|(?:空闲|可用)?\s*GPU\s*(?:数量|资源)?不足)/i.test(message)) return { kind: "stock", message };
  return { kind: "error", message: message || `接口返回未识别的结果（${code || "无状态码"}），已停止任务` };
}

function retryDelaySeconds(intervalSeconds, consecutiveFailures = 0, retryAfterSeconds = 0) {
  const base = Math.max(MIN_INTERVAL_SECONDS, Number(intervalSeconds) || 60);
  const exponential = Math.min(900, base * 2 ** Math.min(5, Math.max(0, consecutiveFailures)));
  return Math.max(base, exponential, Math.min(86400, Math.max(0, Number(retryAfterSeconds) || 0)));
}

function parseRetryAfter(value, now = Date.now()) {
  if (!value) return 0;
  const seconds = Number(value);
  if (Number.isFinite(seconds)) return Math.max(0, seconds);
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? Math.max(0, Math.ceil((timestamp - now) / 1000)) : 0;
}


// Source: src/scheduler.js

function createScheduler({
  storage,
  getCredentials = () => ({}),
  requestPowerOn,
  sendPush = async () => {},
  notify = async () => {},
  openConsole = uuid => window.open(instanceConsoleUrl(uuid), "_blank", "noopener"),
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
    try { await notify(title, safe(message), uuid); }
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
        if (!instanceType(item?.uuid)) continue;
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
            if (auth.isSubUser) throw new Error("当前脚本支持个人账户实例，请切换个人账户后重试");
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


// Source: src/panel.js

function createPanel(container, scheduler, { initialUuid = '', onClose = () => {}, beforeStart = async () => {} } = {}) {
  const $ = id => container.querySelector(`#${id}`);
  const mutationButtons = ['save-preferences', 'manual-start', 'save-push', 'clear-push', 'clear-logs'];
  const pendingInstances = new Set();
  let destroyed = false;
  let snapshot = null;
  let refreshPending = false;
  let feedbackTimer;
  let jobsSignature = '';
  let instancesSignature = '';
  let logsSignature = '';
  let preferencesLoaded = false;
  let preferencesDirty = false;
  let selectedUuid = initialUuid;

  function node(tag, className, text) {
    const element = document.createElement(tag);
    if (className) element.className = className;
    if (text !== undefined) element.textContent = text;
    return element;
  }
  function timeText(value) {
    const date = new Date(Number(value));
    return value && !Number.isNaN(date.getTime()) ? date.toLocaleTimeString('zh-CN', { hour12: false }) : '—';
  }
  function localDatetime(value) {
    if (!value || !Number.isFinite(Number(value)) || Number(value) <= Date.now()) return '';
    const date = new Date(Number(value));
    return new Date(date.getTime() - date.getTimezoneOffset() * 60000).toISOString().slice(0, 19);
  }
  function feedback(message, error = false) {
    if (destroyed) return;
    clearTimeout(feedbackTimer);
    $('feedback').textContent = message;
    $('feedback').className = `feedback${error ? ' error' : ''}`;
    $('feedback').hidden = false;
    feedbackTimer = setTimeout(() => { if (!destroyed) $('feedback').hidden = true; }, error ? 14000 : 6000);
  }
  async function request(type, payload = {}) {
    const response = await scheduler.command(type, payload);
    if (!response?.ok) throw new Error(response?.error || '脚本没有响应，请刷新页面后再试');
    if (response.snapshot && !destroyed) render(response.snapshot);
    return response;
  }
  async function refresh(incoming) {
    if (destroyed) return;
    if (incoming && Array.isArray(incoming.jobs)) { render(incoming); return; }
    if (refreshPending) return;
    refreshPending = true;
    try { await request('GET_STATE'); }
    catch (error) { feedback(error.message, true); }
    finally { refreshPending = false; }
  }
  async function perform(button, action) {
    button.disabled = true;
    try { await action(); }
    catch (error) { feedback(error.message || '操作失败，请重试', true); }
    finally {
      if (button.isConnected) button.disabled = Boolean(button.dataset.active === 'true' || button.dataset.unavailable === 'true' || (snapshot?.readOnly && (mutationButtons.includes(button.id) || button.dataset.mutates === 'true')));
    }
  }
  function action(label, className, handler, { disabled = false, uuid = '', mutates = true, unavailable = false } = {}) {
    const button = node('button', className, label);
    button.type = 'button';
    button.dataset.mutates = String(mutates);
    button.dataset.unavailable = String(unavailable);
    if (uuid) button.dataset.instanceUuid = uuid;
    button.disabled = Boolean((snapshot?.readOnly && mutates) || disabled);
    button.addEventListener('click', () => { void perform(button, handler); });
    return button;
  }
  async function startInstance(instance) {
    if (pendingInstances.has(instance.uuid)) return;
    if (snapshot?.jobs?.some(job => job.uuid === instance.uuid && job.enabled)) { focusInstance(instance.uuid); return; }
    pendingInstances.add(instance.uuid);
    try {
      await beforeStart();
      await request('GET_STATE');
      if (snapshot?.jobs?.some(job => job.uuid === instance.uuid && job.enabled)) { focusInstance(instance.uuid); return; }
      const currentInstance = snapshot?.instances?.find(item => item.uuid === instance.uuid) || instance;
      if (!instanceCanStart(currentInstance)) throw new Error('实例当前已开机或正在启动，请关机后再抢机');
      selectedUuid = instance.uuid;
      await request('START_JOB', { config: { uuid: instance.uuid, name: currentInstance.name || instance.name || instance.uuid } });
      feedback('已加入抢机任务，后续会自动重试。');
      focusInstance(instance.uuid);
    } finally { pendingInstances.delete(instance.uuid); }
  }
  function focusInstance(uuid) {
    selectedUuid = uuid || '';
    for (const item of container.querySelectorAll('[data-task-uuid]')) {
      item.classList.toggle('selected', item.dataset.taskUuid === selectedUuid);
    }
    const selected = [...container.querySelectorAll('[data-task-uuid]')].find(item => item.dataset.taskUuid === selectedUuid);
    selected?.scrollIntoView?.({ block: 'nearest', behavior: 'smooth' });
  }
  function statusText(job) {
    if (job.status === 'running') return job.attempts ? '正在尝试' : '准备抢机';
    return { scheduled: '等待开始', retrying: '等待库存', success: '开机已受理', stopped: '已停止', error: '需要处理', exhausted: '次数已用完' }[job.status] || job.status;
  }
  function updateCountdowns() {
    if (destroyed) return;
    for (const item of container.querySelectorAll('[data-next-run-at]')) {
      const seconds = Math.max(0, Math.ceil((Number(item.dataset.nextRunAt) - Date.now()) / 1000));
      const duration = seconds >= 3600 ? `${Math.floor(seconds / 3600)}时${Math.floor(seconds % 3600 / 60)}分` : seconds >= 60 ? `${Math.floor(seconds / 60)}分${seconds % 60}秒` : `${seconds}秒`;
      item.textContent = seconds ? `${duration}后${item.dataset.scheduled === 'true' ? '开始' : '重试'}` : '即将尝试';
    }
  }
  function renderJobs(jobs) {
    const signature = JSON.stringify([jobs, snapshot.instances, Boolean(snapshot.readOnly)]);
    if (signature === jobsSignature) { updateCountdowns(); return; }
    jobsSignature = signature;
    $('jobs-count').textContent = String(jobs.length);
    const content = [];
    const ordered = [...jobs].sort((a, b) => Number(b.enabled) - Number(a.enabled) || Number(b.updatedAt || 0) - Number(a.updatedAt || 0));
    for (const job of ordered) {
      const item = node('article', `job${job.enabled ? ' is-active' : ''}${job.uuid === selectedUuid ? ' selected' : ''}`);
      item.dataset.taskUuid = job.uuid;
      const header = node('div', 'job-header');
      const titleGroup = node('div', 'job-heading');
      titleGroup.append(node('div', 'job-title', job.name || job.uuid));
      const statusClass = job.enabled ? 'active' : job.status === 'success' ? 'success' : ['error', 'exhausted'].includes(job.status) ? 'error' : '';
      header.append(titleGroup, node('span', `job-status ${statusClass}`, statusText(job)));
      const details = node('div', 'job-details');
      details.append(node('strong', 'attempts', `已尝试 ${job.attempts || 0}${job.maxAttempts ? ` / ${job.maxAttempts}` : ''} 次`));
      if (job.enabled && job.nextRunAt) {
        const countdown = node('span', 'countdown');
        countdown.dataset.nextRunAt = String(job.nextRunAt);
        countdown.dataset.scheduled = String(job.status === 'scheduled');
        details.append(countdown);
      }
      item.append(header, details);
      if (job.enabled) item.append(node('div', 'activity-track'));
      if (job.lastMessage) item.append(node('p', 'job-message', job.lastMessage));
      const actions = node('div', 'job-actions');
      actions.append(node('span', 'job-uuid', job.uuid));
      if (job.enabled) actions.append(action('停止任务', 'text-button danger-text', () => request('STOP_JOB', { uuid: job.uuid })));
      else {
        const instance = snapshot.instances?.find(item => item.uuid === job.uuid) || { uuid: job.uuid };
        const canStart = instanceCanStart(instance);
        actions.append(action(canStart ? '重新抢机' : instance.status || '已开机', 'text-button accent-text', () => startInstance(job), { uuid: job.uuid, disabled: !canStart, unavailable: !canStart }));
        actions.append(action('删除记录', 'text-button', () => request('DELETE_JOB', { uuid: job.uuid })));
      }
      item.append(actions);
      content.push(item);
    }
    if (!content.length) {
      const empty = node('div', 'empty-state', '还没有抢机任务');
      empty.append(node('br'), node('span', '', '在实例旁点一下“抢机”，这里就会显示进度'));
      content.push(empty);
    }
    $('jobs').replaceChildren(...content);
    updateCountdowns();
  }
  function renderInstances(instances) {
    const activeIds = new Set((snapshot.jobs || []).filter(job => job.enabled).map(job => job.uuid));
    const signature = JSON.stringify([instances, [...activeIds], snapshot.readOnly, snapshot.auth?.available]);
    if (signature === instancesSignature) return;
    instancesSignature = signature;
    const content = [];
    for (const instance of instances) {
      const item = node('article', 'instance-item');
      const copy = node('div', 'instance-copy');
      copy.append(node('strong', 'instance-title', instance.name || instance.uuid), node('span', 'instance-meta', instance.status || instance.uuid));
      const active = activeIds.has(instance.uuid);
      const canStart = instanceCanStart(instance);
      const button = action(active ? '抢机中' : !canStart ? instance.status || '已开机' : '抢机', `button ${active || !canStart ? 'secondary' : 'primary'} quick-start`, () => startInstance(instance), { disabled: active || !canStart, uuid: instance.uuid, unavailable: !canStart });
      button.dataset.active = String(active);
      button.setAttribute('aria-label', active ? `${instance.name || instance.uuid} 抢机中` : !canStart ? `${instance.name || instance.uuid} ${instance.status || '已开机'}` : `抢机 ${instance.name || instance.uuid}`);
      item.append(copy, button);
      content.push(item);
    }
    if (!content.length) content.push(node('p', 'muted small', '打开实例列表，即可识别可添加的实例。'));
    $('instances').replaceChildren(...content);
  }
  function renderLogs(logs) {
    const signature = JSON.stringify(logs);
    if (signature === logsSignature) return;
    logsSignature = signature;
    const content = [];
    for (const log of [...logs].sort((a, b) => Number(b.at) - Number(a.at)).slice(0, 100)) {
      const level = ['info', 'warn', 'error', 'success'].includes(log.level) ? log.level : 'info';
      const row = node('div', `log ${level}`);
      const copy = node('div', 'log-message', log.message || '');
      if (log.uuid) copy.append(node('span', 'log-instance', log.uuid));
      row.append(node('time', 'log-time', timeText(log.at)), copy);
      content.push(row);
    }
    if (!content.length) content.push(node('p', 'muted small', '暂无运行记录'));
    $('logs').replaceChildren(...content);
  }
  function fillPreferences(preferences = {}) {
    $('interval').value = String(preferences.intervalSeconds ?? 60);
    $('max-attempts').value = String(preferences.maxAttempts ?? 0);
    $('start-at').value = localDatetime(preferences.startAt);
    preferencesLoaded = true;
  }
  function render(state) {
    if (destroyed) return;
    snapshot = state;
    const auth = state.auth || {};
    const available = auth.available && (!auth.expiresAt || Number(auth.expiresAt) > Date.now());
    $('auth-dot').className = `dot${available && !state.readOnly ? ' ready' : ''}`;
    $('auth-status').textContent = state.readOnly ? '当前标签页只读' : available ? '已连接 AutoDL' : '请先登录 AutoDL';
    $('auth-detail').textContent = state.readOnly ? state.blockedReason || '请回到管理任务的标签页' : available ? '点击“抢机”即可自动等待库存' : '登录后刷新实例页面即可';
    $('active-count').textContent = `${(state.jobs || []).filter(job => job.enabled).length} 个进行中`;
    $('push-status').textContent = state.pushConfigured ? '已配置，仅当前页面有效' : '未配置';
    for (const id of mutationButtons) $(id).disabled = Boolean(state.readOnly);
    if (!preferencesLoaded && !preferencesDirty) fillPreferences(state.preferences);
    renderJobs(Array.isArray(state.jobs) ? state.jobs : []);
    renderInstances(Array.isArray(state.instances) ? state.instances : []);
    renderLogs(Array.isArray(state.logs) ? state.logs : []);
  }

  $('preferences-form').addEventListener('input', () => { preferencesDirty = true; });
  $('preferences-form').addEventListener('submit', event => {
    event.preventDefault();
    void perform($('save-preferences'), async () => {
      const startAt = $('start-at').value ? new Date($('start-at').value).getTime() : null;
      if (startAt !== null && (!Number.isFinite(startAt) || startAt <= Date.now())) throw new Error('请选择未来的开始时间，或留空立即开始');
      const response = await request('SET_PREFERENCES', { config: { intervalSeconds: Number($('interval').value), maxAttempts: Number($('max-attempts').value), startAt } });
      preferencesDirty = false;
      fillPreferences(response.snapshot?.preferences);
      feedback('已保存，将用于之后添加的抢机任务。');
    });
  });
  $('manual-form').addEventListener('submit', event => {
    event.preventDefault();
    void perform($('manual-start'), async () => {
      const uuid = $('instance-uuid').value.trim();
      if (!instanceType(uuid)) throw new Error('请输入有效的普通或 Pro 实例 ID');
      await startInstance({ uuid });
      $('instance-uuid').value = '';
    });
  });
  $('open-autodl').addEventListener('click', () => { void perform($('open-autodl'), () => request('OPEN_AUTODL')); });
  $('refresh').addEventListener('click', () => { void refresh(); });
  $('clear-logs').addEventListener('click', () => { void perform($('clear-logs'), () => request('CLEAR_LOGS')); });
  $('save-push').addEventListener('click', () => { void perform($('save-push'), async () => {
    const token = $('push-token').value.trim();
    if (!/^SPT_[A-Za-z0-9_-]+$/.test(token)) throw new Error('请填写有效的 WxPusher SPT');
    await request('SET_PUSH', { token });
    $('push-token').value = '';
    feedback('微信通知已开启，仅当前页面有效。');
  }); });
  $('clear-push').addEventListener('click', () => { void perform($('clear-push'), async () => {
    await request('SET_PUSH', { token: '' });
    $('push-token').value = '';
    feedback('已清除微信通知配置。');
  }); });
  $('close-panel').addEventListener('click', onClose);
  const onKeydown = event => { if (event.key === 'Escape') onClose(); };
  const onVisibilityChange = () => { if (!document.hidden) void refresh(); };
  document.addEventListener('keydown', onKeydown);
  document.addEventListener('visibilitychange', onVisibilityChange);
  const refreshInterval = setInterval(() => { if (!document.hidden) void refresh(); }, 3000);
  const countdownInterval = setInterval(updateCountdowns, 1000);
  void refresh();
  return {
    refresh,
    selectInstance(uuid) { focusInstance(uuid); },
    destroy() {
      destroyed = true;
      clearInterval(refreshInterval);
      clearInterval(countdownInterval);
      clearTimeout(feedbackTimer);
      document.removeEventListener('keydown', onKeydown);
      document.removeEventListener('visibilitychange', onVisibilityChange);
      $('close-panel').removeEventListener('click', onClose);
    }
  };
}


// Source: src/page.js

function installPage(scheduler, panelMarkup, panelCss) {
  const hostId = 'autodl-scheduler-host';
  if (document.getElementById(hostId)) return () => {};

  const host = document.createElement('div');
  host.id = hostId;
  const shadow = host.attachShadow({ mode: 'open' });
  const style = document.createElement('style');
  style.textContent = `${panelCss}\n
    :host { all: initial; display: block; position: fixed; inset: 0;
      z-index: 2147483647; pointer-events: none; font-family: -apple-system,
      BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif; }
    .adls-launcher { pointer-events: auto; position: absolute; right: 24px;
      bottom: 28px; display: flex; align-items: center; gap: 9px;
      padding: 13px 17px; border: 1px solid #219585; border-radius: 13px;
      background: #087f71; color: #fff; box-shadow: 0 6px 24px #075f562e;
      font-family: inherit; font-size: 14px; font-weight: 600; line-height: 22px;
      transition: background .15s, transform .15s; }
    .adls-launcher:hover { background: #066e61; transform: translateY(-2px); }
    .adls-launcher svg { width: 18px; height: 18px; stroke: currentColor; }
    .adls-launcher:focus-visible { outline: 3px solid #7cd9c5; outline-offset: 3px; }
    .adls-count { display: grid; place-items: center; min-width: 20px;
      height: 20px; padding: 0 5px; border-radius: 6px;
      background: #ffffff2b; color: #fff; font-size: 11px; }
    .adls-backdrop { pointer-events: auto; position: absolute; inset: 0;
      display: grid; place-items: center; padding: 16px; background: #0f232b55; }
    .adls-dialog { position: relative; width: min(450px, calc(100vw - 32px));
      height: min(740px, calc(100dvh - 32px)); min-height: 180px;
      overflow: auto; overscroll-behavior: contain; scrollbar-width: thin;
      border: 1px solid #e1eae7; border-radius: 17px; background: #f5f8f8;
      box-shadow: 0 24px 80px #0f232b40; }
    .adls-panel-container { min-width: 0; min-height: 100%; }
    .adls-toast { position: absolute; left: 50%; bottom: 92px; transform: translateX(-50%);
      max-width: min(460px, calc(100vw - 32px)); padding: 12px 17px; border-radius: 10px;
      background: #173e36; color: #fff; font-size: 13px; line-height: 1.6;
      box-shadow: 0 8px 30px #0f232b26; pointer-events: auto; overflow-wrap: anywhere; }
    .adls-toast[data-error] { background: #963d36; }
    .adls-backdrop[hidden], .adls-launcher[hidden], .adls-count[hidden], .adls-toast[hidden] {
      display: none !important; }
    @media (max-width: 480px) {
      .adls-launcher { right: 16px; bottom: 18px; }
      .adls-backdrop { padding: 8px; }
      .adls-dialog { width: calc(100vw - 16px); height: calc(100dvh - 16px); }
    }
    @media (prefers-reduced-motion: reduce) { .adls-launcher { transition: none; } }
  `;
  shadow.append(style);

  const launcher = document.createElement('button');
  launcher.type = 'button';
  launcher.className = 'adls-launcher';
  launcher.setAttribute('aria-label', '打开 AutoDL 抢机任务');
  launcher.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke-width="1.8" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></svg><span>抢机任务</span><span class="adls-count" hidden></span>';
  const countBadge = launcher.querySelector('.adls-count');
  shadow.append(launcher);
  const toast = document.createElement('div');
  toast.className = 'adls-toast';
  toast.setAttribute('role', 'status');
  toast.setAttribute('aria-live', 'polite');
  toast.hidden = true;
  shadow.append(toast);

  const backdrop = document.createElement('div');
  backdrop.className = 'adls-backdrop';
  backdrop.hidden = true;
  const dialog = document.createElement('section');
  dialog.className = 'adls-dialog';
  dialog.setAttribute('role', 'dialog');
  dialog.setAttribute('aria-modal', 'true');
  dialog.setAttribute('aria-label', 'AutoDL 抢机任务');
  const panelContainer = document.createElement('div');
  panelContainer.className = 'panel-container adls-panel-container';
  dialog.append(panelContainer);
  backdrop.append(dialog);
  shadow.append(backdrop);

  let destroyed = false;
  let panel = null;
  let previousFocus = null;
  let debounceTimer;
  let heartbeatTimer;
  let progressTimer;
  let countdownTimer;
  let toastTimer;
  let lastSnapshot = '';
  let syncBusy = false;
  let syncAgain = false;
  let forceAgain = false;
  let refreshing = false;
  let taskSnapshot = null;
  const rowControls = new Map();

  function setText(element, text) {
    if (element.textContent !== text) element.textContent = text;
  }

  function showToast(message, error = false) {
    clearTimeout(toastTimer);
    setText(toast, message);
    toast.toggleAttribute('data-error', error);
    toast.hidden = false;
    toastTimer = setTimeout(() => { toast.hidden = true; }, error ? 9000 : 4500);
  }

  function countdown(timestamp) {
    const seconds = Math.max(0, Math.ceil((timestamp - Date.now()) / 1000));
    if (!seconds) return '即将尝试';
    if (seconds < 60) return `${seconds} 秒后`;
    if (seconds < 3600) return `${Math.floor(seconds / 60)} 分 ${seconds % 60} 秒后`;
    return `${Math.floor(seconds / 3600)} 小时 ${Math.floor(seconds % 3600 / 60)} 分后`;
  }

  function rowInstanceState(row) {
    const status = (row.querySelector('.status')?.textContent || '').trim();
    // AutoDL's native action is a button with a nested, whitespace-padded span.
    // Do not infer a running machine from a missing/disabled action: the site
    // can temporarily disable controls while loading and test fixtures are inert.
    const powerOnAction = [...row.querySelectorAll('button, a, [role="button"]')]
      .find(element => !element.closest('[data-autodl-scheduler-controls="userscript"]') && element.textContent.trim() === '开机');
    const canPowerOn = powerOnAction && !powerOnAction.matches(':disabled') &&
      powerOnAction.getAttribute('aria-disabled') !== 'true' && !powerOnAction.classList.contains('is-disabled') ? true : null;
    return { status, canPowerOn };
  }

  async function syncCurrentPage() {
    await scheduler.syncPage({ ...getCredentials(), instances: readInstances(), pageUrl: location.href });
  }

  function renderRows() {
    const jobs = new Map((taskSnapshot?.jobs || []).map(job => [job.uuid, job]));
    const readOnly = Boolean(taskSnapshot?.readOnly);
    for (const [row, controls] of rowControls) {
      if (!row.isConnected || !controls.wrapper.isConnected) { rowControls.delete(row); continue; }
      const job = jobs.get(controls.uuid);
      const active = Boolean(job?.enabled);
      const instance = rowInstanceState(row);
      const canStart = instanceCanStart(instance);
      const stateLabel = instance.status || '已开机';
      setText(controls.button, active ? '查看进度' : !canStart ? stateLabel : job ? '重新抢机' : '抢机');
      controls.button.disabled = controls.busy || (!active && (readOnly || !canStart));
      controls.button.style.opacity = controls.button.disabled ? '.55' : '1';
      controls.button.style.cursor = controls.button.disabled ? 'default' : 'pointer';
      controls.button.title = readOnly && !active ? taskSnapshot.blockedReason || '请在管理任务的标签页操作' : !active && !canStart ? '实例当前已开机或正在启动，请关机后再抢机' : '';
      controls.button.setAttribute('aria-label', active ? `查看 ${controls.name} 的抢机进度` : !canStart ? `${controls.name} ${stateLabel}` : `为 ${controls.name} 抢机`);
      controls.progress.hidden = !job;
      controls.progress.style.display = job ? 'flex' : 'none';
      controls.stop.hidden = !active;
      controls.stop.style.display = active ? 'inline-block' : 'none';
      controls.stop.disabled = controls.busy || readOnly;
      controls.stop.style.opacity = controls.stop.disabled ? '.55' : '1';
      controls.stop.title = readOnly ? taskSnapshot.blockedReason || '请在管理任务的标签页操作' : '停止后续抢机尝试';
      controls.remove.hidden = !job || active;
      controls.remove.style.display = job && !active ? 'inline-block' : 'none';
      controls.remove.disabled = controls.busy || readOnly;
      controls.remove.style.opacity = controls.remove.disabled ? '.55' : '1';
      controls.remove.title = readOnly ? taskSnapshot.blockedReason || '请在管理任务的标签页操作' : '只删除抢机记录，不修改 AutoDL 实例';
      if (job) {
        const stateText = job.status === 'success' && canStart ? '上次已受理' : { scheduled: '等待开始', running: '正在抢机', retrying: '等待重试', success: '开机已受理', stopped: '已停止', error: '需检查', exhausted: '次数已用完' }[job.status] || '等待中';
        const detail = `${stateText} · 已尝试 ${job.attempts || 0} 次${active && job.nextRunAt ? ` · ${countdown(job.nextRunAt)}` : ''}`;
        setText(controls.status, detail);
        controls.status.title = job.lastMessage || '';
        controls.status.style.color = ['error', 'exhausted'].includes(job.status) ? '#b65c42' : job.status === 'success' ? '#16815f' : '#69817b';
      }
    }
  }

  function applySnapshot(snapshot) {
    if (!snapshot || destroyed) return;
    taskSnapshot = snapshot;
    const count = (snapshot.jobs || []).filter(job => job.enabled).length;
    setText(countBadge, String(count));
    countBadge.hidden = count === 0;
    launcher.setAttribute('aria-label', `打开 AutoDL 抢机任务${count ? `，${count} 个任务进行中` : ''}`);
    renderRows();
    if (panel && !backdrop.hidden) void panel.refresh?.(snapshot);
  }

  async function refreshTasks() {
    if (refreshing || destroyed) return;
    refreshing = true;
    try {
      const response = await scheduler.command('GET_STATE');
      if (response?.ok) applySnapshot(response.snapshot);
    } catch { /* Credentials and raw errors never enter the page or console. */ }
    finally { refreshing = false; }
  }

  async function rowCommand(controls, type) {
    if (controls.busy || destroyed) return;
    controls.busy = true;
    renderRows();
    try {
      if (type === 'START_JOB') {
        if (!instanceCanStart(rowInstanceState(controls.row))) throw new Error('实例当前已开机或正在启动，请关机后再抢机');
        // The user may have just shut down the instance. Sync its current DOM
        // state before START_JOB so a stale running snapshot cannot block it.
        await syncCurrentPage();
      }
      const response = await scheduler.command(type, type === 'START_JOB' ? { config: { uuid: controls.uuid, name: controls.name } } : { uuid: controls.uuid });
      if (!response?.ok) throw new Error(response?.error || '操作未完成，请稍后重试');
      applySnapshot(response.snapshot);
      showToast(type === 'START_JOB' ? (response.snapshot?.jobs?.find(job => job.uuid === controls.uuid)?.status === 'scheduled' ? '已添加抢机任务，将在预约时间开始' : '已开始抢机，暂无库存时会自动重试') : type === 'DELETE_JOB' ? '已删除抢机记录' : '已停止后续抢机尝试');
    } catch (error) { showToast(error.message || '操作未完成，请稍后重试', true); }
    finally { controls.busy = false; renderRows(); }
  }

  function mountHost() {
    if (!host.isConnected && !destroyed) (document.body || document.documentElement).append(host);
  }

  function closePanel() {
    if (backdrop.hidden) return;
    backdrop.hidden = true;
    if (previousFocus instanceof HTMLElement && previousFocus.isConnected) previousFocus.focus();
    else launcher.focus();
  }

  function openPanel(uuid = '') {
    if (destroyed) return;
    mountHost();
    if (backdrop.hidden) previousFocus = document.activeElement;
    if (!panel) {
      panelContainer.innerHTML = panelMarkup;
      panel = createPanel(panelContainer, scheduler, { initialUuid: uuid, onClose: closePanel, beforeStart: syncCurrentPage });
    } else {
      panel.selectInstance(uuid);
    }
    backdrop.hidden = false;
    panelContainer.querySelector('#close-panel, button, input, select')?.focus();
    void synchronize(true);
  }

  launcher.addEventListener('click', () => openPanel());
  backdrop.addEventListener('click', (event) => {
    if (event.target === backdrop) closePanel();
  });

  function onKeydown(event) {
    if (backdrop.hidden) return;
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      closePanel();
    } else if (event.key === 'Tab') {
      const focusable = [...panelContainer.querySelectorAll('button, input, select, textarea, a[href], summary, [tabindex]')]
        .filter((element) => !element.disabled && element.tabIndex >= 0 && element.getClientRects().length);
      const first = focusable[0];
      const last = focusable.at(-1);
      const focused = shadow.activeElement;
      if (event.shiftKey && (focused === first || !panelContainer.contains(focused))) {
        event.preventDefault();
        last?.focus();
      } else if (!event.shiftKey && (focused === last || !panelContainer.contains(focused))) {
        event.preventDefault();
        first?.focus();
      }
    }
  }

  function getCredentials() {
    let token = '';
    let appVersion = '';
    let isSubUser = false;
    try { token = localStorage.getItem('token') || ''; } catch { /* Restricted storage. */ }
    try {
      const version = JSON.parse(localStorage.getItem('app_version') || '{}');
      if (typeof version?.version === 'string') appVersion = version.version;
    } catch { /* Ignore malformed version metadata. */ }
    try {
      const user = JSON.parse(localStorage.getItem('user') || '{}');
      isSubUser = Boolean(user?.sub_name);
    } catch { /* Ignore malformed account metadata. */ }
    return { token, appVersion, isSubUser };
  }

  function readInstances() {
    const instances = new Map();
    for (const row of document.querySelectorAll('.instance-table tr.el-table__row')) {
      const firstCell = row.querySelector('td:first-child');
      if (!firstCell) continue;
      const uuidElement = [...firstCell.querySelectorAll('div')]
        .find((element) => instanceType(element.textContent.trim()));
      if (!uuidElement) continue;
      const uuid = uuidElement.textContent.trim();
      const name = (uuidElement.nextElementSibling?.querySelector('span:not(.iconfont)')?.textContent || '').trim();
      const instanceState = rowInstanceState(row);
      instances.set(uuid, { uuid, name: name || uuid, ...instanceState });

      const actions = row.querySelector('td:last-child .cell');
      if (!actions) continue;
      let controls = rowControls.get(row);
      if (!controls || !controls.wrapper.isConnected) {
        const wrapper = document.createElement('span');
        wrapper.dataset.autodlSchedulerControls = 'userscript';
        wrapper.style.cssText = 'display:inline-block;max-width:100%;vertical-align:middle;margin:5px 0 5px 8px;line-height:1.5';
        const button = document.createElement('button');
        button.type = 'button';
        button.dataset.autodlSchedulerButton = 'userscript';
        button.textContent = '抢机';
        button.style.cssText = 'display:inline-flex;align-items:center;justify-content:center;width:auto;min-height:27px;margin:0;padding:2px 10px;border:1px solid #b7ddd5;border-radius:6px;background:#edf8f4;color:#087f71;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif;font-size:12px;font-weight:500;line-height:20px;white-space:nowrap;vertical-align:middle;cursor:pointer';
        const progress = document.createElement('span');
        progress.dataset.autodlSchedulerProgress = 'userscript';
        progress.hidden = true;
        progress.style.cssText = 'display:none;align-items:center;gap:6px;flex-wrap:wrap;max-width:210px;margin-top:5px;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif;font-size:10px;line-height:1.6;text-align:left';
        const statusElement = document.createElement('span');
        statusElement.style.cssText = 'white-space:normal;overflow-wrap:anywhere';
        const stop = document.createElement('button');
        stop.type = 'button';
        stop.dataset.autodlSchedulerStop = 'userscript';
        stop.textContent = '停止';
        stop.hidden = true;
        stop.style.cssText = 'display:none;width:auto;min-height:0;margin:0;padding:0 3px;border:0;background:transparent;color:#b7614d;font-size:10px;line-height:1.6;cursor:pointer;white-space:nowrap';
        const remove = document.createElement('button');
        remove.type = 'button';
        remove.dataset.autodlSchedulerDelete = 'userscript';
        remove.textContent = '删除记录';
        remove.hidden = true;
        remove.style.cssText = 'display:none;width:auto;min-height:0;margin:0;padding:0 3px;border:0;background:transparent;color:#7b9289;font-size:10px;line-height:1.6;cursor:pointer;white-space:nowrap';
        progress.append(statusElement, stop, remove);
        wrapper.append(button, progress);
        controls = { row, wrapper, button, progress, status: statusElement, stop, remove, uuid, name: name || uuid, busy: false };
        rowControls.set(row, controls);
        button.addEventListener('click', (event) => {
          event.preventDefault();
          event.stopPropagation();
          const job = taskSnapshot?.jobs?.find(item => item.uuid === controls.uuid);
          if (job?.enabled) openPanel(controls.uuid);
          else void rowCommand(controls, 'START_JOB');
        });
        stop.addEventListener('click', (event) => {
          event.preventDefault();
          event.stopPropagation();
          void rowCommand(controls, 'STOP_JOB');
        });
        remove.addEventListener('click', (event) => {
          event.preventDefault();
          event.stopPropagation();
          void rowCommand(controls, 'DELETE_JOB');
        });
        actions.append(wrapper);
      }
      controls.uuid = uuid;
      controls.name = name || uuid;
      controls.button.dataset.instanceUuid = uuid;
    }
    renderRows();
    return [...instances.values()];
  }

  async function synchronize(force = false) {
    if (destroyed) return;
    if (syncBusy) {
      syncAgain = true;
      forceAgain ||= force;
      return;
    }
    syncBusy = true;
    try {
      mountHost();
      launcher.hidden = !location.pathname.startsWith('/console');
      const message = { ...getCredentials(), instances: readInstances(), pageUrl: location.href };
      const snapshot = JSON.stringify(message);
      if (force || snapshot !== lastSnapshot) {
        await scheduler.syncPage(message);
        lastSnapshot = snapshot;
      }
      await refreshTasks();
    } catch { /* Never place credentials or raw scheduler errors in the page or console. */ }
    finally {
      syncBusy = false;
      if (syncAgain && !destroyed) {
        const nextForce = forceAgain;
        syncAgain = false;
        forceAgain = false;
        void synchronize(nextForce);
      }
    }
  }

  function queueSynchronization() {
    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => void synchronize(), 400);
  }
  const onPageShow = () => void synchronize(true);
  const onVisibilityChange = () => { if (!document.hidden) void synchronize(true); };
  const observer = new MutationObserver(records => {
    // Our per-row countdowns change text every second; only site DOM changes
    // should schedule a full table scan and credential synchronization.
    const siteChanged = records.some(record => {
      const element = record.target.nodeType === Node.ELEMENT_NODE ? record.target : record.target.parentElement;
      if (element?.closest?.('[data-autodl-scheduler-controls="userscript"]')) return false;
      if (record.type === 'childList' && [...record.addedNodes, ...record.removedNodes].length &&
          [...record.addedNodes, ...record.removedNodes].every(node => node.nodeType === Node.ELEMENT_NODE && node.matches?.('[data-autodl-scheduler-controls="userscript"]'))) return false;
      return true;
    });
    if (siteChanged) queueSynchronization();
  });
  mountHost();
  observer.observe(document.documentElement, { childList: true, subtree: true, characterData: true });
  window.addEventListener('storage', queueSynchronization);
  window.addEventListener('pageshow', onPageShow);
  document.addEventListener('visibilitychange', onVisibilityChange);
  document.addEventListener('keydown', onKeydown, true);
  heartbeatTimer = setInterval(() => void synchronize(true), 30_000);
  progressTimer = setInterval(() => { if (!document.hidden) void refreshTasks(); }, 3000);
  countdownTimer = setInterval(() => { if (!document.hidden) renderRows(); }, 1000);
  void synchronize(true);

  return function destroyPage() {
    if (destroyed) return;
    destroyed = true;
    observer.disconnect();
    clearTimeout(debounceTimer);
    clearInterval(heartbeatTimer);
    clearInterval(progressTimer);
    clearInterval(countdownTimer);
    clearTimeout(toastTimer);
    window.removeEventListener('storage', queueSynchronization);
    window.removeEventListener('pageshow', onPageShow);
    document.removeEventListener('visibilitychange', onVisibilityChange);
    document.removeEventListener('keydown', onKeydown, true);
    panel?.destroy?.();
    host.remove();
    for (const controls of rowControls.values()) controls.wrapper.remove();
    rowControls.clear();
    lastSnapshot = '';
  };
}


// Source: src/entry.js

function requestInstancePowerOn({ uuid, token, appVersion, signal }) {
  const type = instanceType(uuid);
  if (!type) throw new Error("请输入有效的普通或 Pro 实例 ID");
  const headers = { accept: "application/json", "content-type": "application/json;charset=UTF-8", authorization: token };
  if (appVersion) headers.appversion = appVersion;
  return fetch(`https://www.autodl.com/api/v1/instance/${type === "pro" ? "pro/" : ""}power_on`, {
    method: "POST", credentials: "include", cache: "no-store", redirect: "error", headers,
    body: JSON.stringify({ instance_uuid: uuid, payload: "" }), signal
  });
}

function readPageCredentials() {
  let token = "";
  let appVersion = "";
  let isSubUser = false;
  try { token = localStorage.getItem("token") || ""; } catch {}
  try { appVersion = JSON.parse(localStorage.getItem("app_version") || "{}").version || ""; } catch {}
  try { isSubUser = Boolean(JSON.parse(localStorage.getItem("user") || "{}")?.sub_name); } catch {}
  return { token, appVersion, isSubUser };
}

async function bootstrap(panelMarkup, panelCss) {
  const STORAGE_KEY = "autodl-scheduler:state:v1";
  const currentConsoleUrl = () => `https://www.autodl.com/console/instance/${location.pathname.startsWith("/console/instance/pro/") ? "pro/" : ""}list`;
  const storage = {
    get: async () => GM_getValue(STORAGE_KEY, null),
    set: async value => { GM_setValue(STORAGE_KEY, value); }
  };
  let installed = false;
  let stopped = false;
  let page = null;
  let scheduler = null;
  let releaseLock;
  function install(isLeader, reason) {
    if (installed || stopped) return;
    installed = true;
    scheduler = createScheduler({
      storage, getCredentials: readPageCredentials, canRun: () => isLeader && !stopped,
      blockedReason: reason,
      openConsole: () => GM_openInTab(currentConsoleUrl(), { active: true, insert: true }),
      requestPowerOn: requestInstancePowerOn,
      notify: (title, text, uuid) => GM_notification({ title, text, timeout: 15000, onclick: () => GM_openInTab(instanceConsoleUrl(uuid), { active: true }) }),
      sendPush: (token, message) => new Promise((resolve, reject) => {
        GM_xmlhttpRequest({
          method: "GET",
          url: `https://wxpusher.zjiecode.com/api/send/message/${encodeURIComponent(token)}/${encodeURIComponent(message)}`,
          anonymous: true, timeout: 10000,
          onload: response => {
            try {
              const body = JSON.parse(response.responseText);
              if (response.status >= 200 && response.status < 300 && Number(body.code) === 1000) resolve();
              else reject(new Error("推送服务未确认发送"));
            } catch { reject(new Error("推送响应无效")); }
          },
          onerror: () => reject(new Error("推送失败")),
          ontimeout: () => reject(new Error("推送超时")),
          onabort: () => reject(new Error("推送取消"))
        });
      })
    });
    page = installPage(scheduler, panelMarkup, panelCss);
  }
  function stop() {
    if (stopped) return;
    stopped = true;
    if (typeof page === "function") page();
    scheduler?.destroy();
    releaseLock?.();
  }
  window.addEventListener("pagehide", stop, { once: true });
  // Back/forward cache restores JS state without rerunning the userscript.
  window.addEventListener("pageshow", event => { if (event.persisted && stopped) location.reload(); });
  if (!navigator.locks?.request) {
    install(false, "浏览器未提供标签页互斥锁，为避免重复开机已停用任务，请更新 Chrome 后重试");
    return;
  }
  try {
    await navigator.locks.request("autodl-scheduler:leader:v1", { ifAvailable: true }, async lock => {
      if (!lock) { install(false); return; }
      const lifetime = new Promise(resolve => { releaseLock = resolve; });
      install(true);
      await lifetime;
    });
  } catch {
    install(false, "无法取得标签页互斥锁，请刷新页面后重试");
  }
}

void bootstrap("<main class=\"app\">\n  <header class=\"masthead\">\n    <div class=\"brand-icon\" aria-hidden=\"true\"><svg viewBox=\"0 0 24 24\"><rect x=\"4\" y=\"4\" width=\"16\" height=\"16\" rx=\"5\"/><path d=\"M8 8h8v8H8zM9 1v3m6-3v3M9 20v3m6-3v3M1 9h3m-3 6h3m16-6h3m-3 6h3\"/></svg></div>\n    <div><div class=\"eyebrow\">AUTODL ASSISTANT</div><h1>抢机任务</h1></div>\n    <button id=\"open-autodl\" class=\"button ghost compact\" type=\"button\">实例列表 ↗</button>\n    <button id=\"close-panel\" class=\"text-button panel-close\" type=\"button\" aria-label=\"关闭抢机面板\">×</button>\n  </header>\n\n  <section class=\"connection\" aria-label=\"登录状态\">\n    <span id=\"auth-dot\" class=\"dot\"></span>\n    <div class=\"connection-copy\"><strong id=\"auth-status\">正在连接…</strong><span id=\"auth-detail\">自动读取当前页面登录状态</span></div>\n    <span id=\"active-count\" class=\"pill\">0 个进行中</span>\n  </section>\n  <div id=\"feedback\" class=\"feedback\" role=\"status\" aria-live=\"polite\" hidden></div>\n\n  <section class=\"card jobs-section\">\n    <div class=\"section-heading\"><h2>抢机进度 <span id=\"jobs-count\" class=\"count\">0</span></h2><button id=\"refresh\" class=\"text-button\" type=\"button\">刷新</button></div>\n    <div id=\"jobs\" class=\"jobs\"><div class=\"empty-state\">还没有抢机任务<br><span>在实例旁点一下“抢机”，这里就会显示进度</span></div></div>\n  </section>\n\n  <section class=\"card instances-section\">\n    <div class=\"section-heading\"><h2>添加实例</h2><span class=\"muted small\">点一下，自动等待库存</span></div>\n    <div id=\"instances\" class=\"instances\"><p class=\"muted small\">正在读取页面中的实例…</p></div>\n  </section>\n\n  <details id=\"advanced-settings\" class=\"card settings\">\n    <summary>高级设置<span class=\"summary-hint\">通常无需修改</span></summary>\n    <div class=\"settings-body\">\n      <h3>新任务设置</h3>\n      <p class=\"muted small\">默认立即开始、持续等待库存。设置只影响之后添加的任务。</p>\n      <form id=\"preferences-form\">\n        <label for=\"start-at\">开始时间 <span class=\"label-hint\">留空立即开始 · 本地时间</span></label>\n        <input id=\"start-at\" type=\"datetime-local\" step=\"1\">\n        <div class=\"form-grid\">\n          <div><label for=\"interval\">重试间隔 <span class=\"label-hint\">秒</span></label><input id=\"interval\" type=\"number\" min=\"30\" max=\"86400\" step=\"1\" value=\"60\" required></div>\n          <div><label for=\"max-attempts\">最多尝试 <span class=\"label-hint\">0 = 不限</span></label><input id=\"max-attempts\" type=\"number\" min=\"0\" max=\"100000\" step=\"1\" value=\"0\" required></div>\n        </div>\n        <div class=\"settings-actions\"><button id=\"save-preferences\" class=\"button secondary\" type=\"submit\">保存设置</button></div>\n      </form>\n      <div class=\"divider\"></div>\n      <h3>微信通知</h3>\n      <p class=\"muted small\">可选。开机请求受理后通过 WxPusher 通知，密钥仅在当前页面有效。</p>\n      <label for=\"push-token\">WxPusher SPT <span id=\"push-status\" class=\"label-hint\">未配置</span></label>\n      <input id=\"push-token\" type=\"password\" placeholder=\"SPT_…\" autocomplete=\"off\" spellcheck=\"false\">\n      <div class=\"settings-actions\"><button id=\"save-push\" class=\"button secondary\" type=\"button\">保存通知</button><button id=\"clear-push\" class=\"text-button\" type=\"button\">清除</button></div>\n      <div class=\"divider\"></div>\n      <h3>手动添加实例</h3>\n      <p class=\"muted small\">页面未识别到实例时使用。</p>\n      <form id=\"manual-form\" class=\"manual-form\">\n        <label class=\"sr-only\" for=\"instance-uuid\">实例 ID</label>\n        <input id=\"instance-uuid\" type=\"text\" placeholder=\"普通或 Pro 实例 ID\" autocomplete=\"off\" spellcheck=\"false\" maxlength=\"80\">\n        <button id=\"manual-start\" class=\"button secondary\" type=\"submit\">抢机</button>\n      </form>\n    </div>\n  </details>\n\n  <details class=\"card settings logs-section\">\n    <summary>运行记录<span class=\"summary-hint\">查看详情</span></summary>\n    <div class=\"settings-body\"><div class=\"log-toolbar\"><button id=\"clear-logs\" class=\"text-button\" type=\"button\">清空记录</button></div><div id=\"logs\" class=\"logs\"><p class=\"muted small\">暂无运行记录</p></div></div>\n  </details>\n  <footer>保持此标签页打开。电脑休眠或后台节流可能延迟重试。<br>“已受理”代表开机请求被接受，运行状态以控制台为准。</footer>\n</main>\n", ".panel-container {\n  color-scheme: light;\n  --ink: #18332f;\n  --muted: #798c87;\n  --line: #e4ede9;\n  --accent: #087f71;\n  --red: #be5248;\n  font: 13px Inter,-apple-system,BlinkMacSystemFont,\"Segoe UI\",\"PingFang SC\",\"Microsoft YaHei\",sans-serif;\n  margin: 0;\n  width: 100%;\n  min-width: 300px;\n  background: #f5f8f6;\n  color: var(--ink);\n}\n* {\n  box-sizing: border-box;\n}\nbutton,input {\n  font: inherit;\n}\nbutton {\n  cursor: pointer;\n}\nbutton:disabled {\n  cursor: default;\n  opacity: .5;\n}\ninput {\n  display: block;\n  width: 100%;\n  height: 38px;\n  padding: 0 11px;\n  color: var(--ink);\n  background: #fff;\n  border: 1px solid #dce6df;\n  border-radius: 8px;\n  outline: none;\n}\ninput:focus {\n  border-color: #44a99a;\n  box-shadow: 0 0 0 3px #087f7110;\n}\ninput::placeholder {\n  color: #a0ada7;\n}\ninput[type=datetime-local] {\n  padding-right: 9px;\n}\nlabel {\n  display: block;\n  font-size: 11px;\n  font-weight: 600;\n  margin: 13px 0 7px;\n}\nsvg {\n  display: block;\n  width: 24px;\n  height: 24px;\n  fill: none;\n  stroke: currentColor;\n  stroke-width: 1.7;\n  stroke-linecap: round;\n  stroke-linejoin: round;\n}\nh1,h2,h3,p {\n  margin: 0;\n}\nh1 {\n  font-size: 21px;\n  font-weight: 730;\n  letter-spacing: -.5px;\n  line-height: 1.3;\n}\nh2 {\n  font-size: 14px;\n  font-weight: 700;\n}\nh3 {\n  font-size: 12px;\n  margin-bottom: 7px;\n}\nbutton:focus-visible,summary:focus-visible {\n  outline: 2px solid #44a99a;\n  outline-offset: 3px;\n}\n.app {\n  max-width: 600px;\n  margin: auto;\n  padding: 20px 18px;\n}\n.masthead {\n  display: flex;\n  gap: 10px;\n  align-items: center;\n  margin-bottom: 18px;\n}\n.brand-icon {\n  display: grid;\n  place-items: center;\n  background: var(--accent);\n  color: white;\n  width: 40px;\n  height: 40px;\n  border-radius: 12px;\n  box-shadow: 0 4px 8px #087f7118;\n}\n.eyebrow {\n  font-size: 8px;\n  letter-spacing: 1.4px;\n  font-weight: 700;\n  color: var(--accent);\n  margin-bottom: 3px;\n}\n.masthead>.button {\n  margin-left: auto;\n}\n.button {\n  border: 0;\n  border-radius: 8px;\n  min-height: 33px;\n  padding: 8px 13px;\n  font-weight: 600;\n  display: inline-flex;\n  align-items: center;\n  justify-content: center;\n  gap: 7px;\n  transition: background .15s;\n}\n.button.primary {\n  background: var(--accent);\n  color: white;\n  box-shadow: 0 2px 5px #087f7115;\n}\n.button.primary:hover {\n  background: #066e61;\n}\n.button.secondary {\n  background: #e9f4ef;\n  color: #087565;\n}\n.button.ghost {\n  color: #698078;\n  background: transparent;\n}\n.button.ghost:hover {\n  background: #e8eeea;\n}\n.button.compact {\n  font-size: 10px;\n  padding: 7px 0 7px 8px;\n}\n.text-button {\n  background: none;\n  border: 0;\n  padding: 4px;\n  color: #7b9289;\n  font-size: 10px;\n  white-space: nowrap;\n}\n.text-button:hover {\n  color: var(--accent);\n}\n.panel-close {\n  font-size: 21px;\n  width: 22px;\n  line-height: 24px;\n  padding: 0;\n  flex: none;\n}\n.danger-text,.text-button.danger-text:hover {\n  color: var(--red);\n}\n.accent-text {\n  color: var(--accent);\n}\n.connection {\n  display: flex;\n  align-items: center;\n  gap: 9px;\n  padding: 11px 12px;\n  background: #edf3ef;\n  border: 1px solid #e0e9e2;\n  border-radius: 10px;\n  margin-bottom: 15px;\n}\n.dot {\n  width: 7px;\n  height: 7px;\n  border-radius: 50%;\n  background: #aab7af;\n  flex: none;\n}\n.dot.ready {\n  background: #14977e;\n  box-shadow: 0 0 0 4px #14977e12;\n}\n.connection-copy {\n  min-width: 0;\n  flex: 1;\n}\n.connection-copy strong {\n  display: block;\n  font-size: 11px;\n  font-weight: 650;\n}\n.connection-copy>span {\n  font-size: 10px;\n  color: var(--muted);\n  display: block;\n  margin-top: 4px;\n  line-height: 1.45;\n}\n.pill {\n  font-size: 10px;\n  font-weight: 600;\n  color: var(--accent);\n  padding: 5px 7px;\n  border-radius: 6px;\n  background: #fff;\n  white-space: nowrap;\n}\n.card {\n  background: white;\n  border: 1px solid var(--line);\n  border-radius: 12px;\n  margin-bottom: 12px;\n  padding: 16px;\n  box-shadow: 0 2px 3px #152d3802;\n}\n.section-heading {\n  display: flex;\n  align-items: center;\n  justify-content: space-between;\n  gap: 10px;\n  margin-bottom: 12px;\n}\n.muted {\n  color: var(--muted);\n}\n.small {\n  font-size: 10px;\n  line-height: 1.7;\n}\n.count {\n  font-size: 10px;\n  color: #8b9b92;\n  background: #f0f4f1;\n  padding: 2px 5px;\n  border-radius: 4px;\n  margin-left: 4px;\n  vertical-align: middle;\n}\n.empty-state {\n  text-align: center;\n  padding: 20px 4px;\n  color: #738b7f;\n  font-size: 12px;\n  line-height: 1.9;\n}\n.empty-state span {\n  font-size: 10px;\n  color: #9aa99f;\n}\n.job {\n  border: 1px solid var(--line);\n  border-radius: 10px;\n  padding: 13px;\n  margin-top: 10px;\n  scroll-margin-top: 14px;\n  transition: border-color .2s;\n}\n.job:first-child {\n  margin-top: 0;\n}\n.job.is-active {\n  background: linear-gradient(135deg,#fcfffd,#f6faf7);\n  border-color: #d6e9dd;\n}\n.job.selected {\n  border-color: #81c3a5;\n  box-shadow: 0 0 0 2px #087f7108;\n}\n.job-header {\n  display: flex;\n  justify-content: space-between;\n  gap: 10px;\n  align-items: flex-start;\n}\n.job-heading {\n  min-width: 0;\n}\n.job-title {\n  font-size: 13px;\n  font-weight: 680;\n  overflow-wrap: anywhere;\n  line-height: 1.5;\n}\n.job-status {\n  font-size: 10px;\n  padding: 3px 6px;\n  border-radius: 5px;\n  white-space: nowrap;\n  background: #f0f4f1;\n  color: #7b8d81;\n}\n.job-status.active {\n  background: #e5f4ea;\n  color: #14805f;\n}\n.job-status.success {\n  background: #e6f6ec;\n  color: #22824f;\n}\n.job-status.error {\n  background: #fff0eb;\n  color: #bb6048;\n}\n.job-details {\n  display: flex;\n  align-items: center;\n  justify-content: space-between;\n  flex-wrap: wrap;\n  gap: 7px;\n  font-size: 10px;\n  color: #7f9588;\n  margin-top: 12px;\n}\n.attempts {\n  font-weight: 600;\n  color: #4e7060;\n}\n.countdown {\n  font-variant-numeric: tabular-nums;\n  color: var(--accent);\n}\n.activity-track {\n  height: 3px;\n  background: #e3eee5;\n  overflow: hidden;\n  border-radius: 3px;\n  margin: 11px 0 0;\n  position: relative;\n}\n.activity-track:after {\n  content: \"\";\n  position: absolute;\n  inset: 0 auto 0 0;\n  width: 28%;\n  border-radius: 3px;\n  background: #68b68c;\n  animation: waiting 2.5s ease-in-out infinite;\n}\n.job-message {\n  font-size: 10px;\n  line-height: 1.65;\n  color: #7f9286;\n  margin-top: 9px;\n  overflow-wrap: anywhere;\n  white-space: pre-wrap;\n}\n.job-actions {\n  display: flex;\n  align-items: center;\n  justify-content: flex-end;\n  gap: 10px;\n  margin-top: 9px;\n}\n.job-uuid {\n  font-size: 9px;\n  color: #9daaa2;\n  font-family: ui-monospace,SFMono-Regular,Menlo,monospace;\n  overflow-wrap: anywhere;\n  margin-right: auto;\n  min-width: 0;\n}\n.instance-item {\n  display: flex;\n  align-items: center;\n  gap: 12px;\n  padding: 11px 0;\n  border-bottom: 1px solid #edf2ed;\n}\n.instance-item:last-child {\n  border-bottom: 0;\n  padding-bottom: 1px;\n}\n.instance-item:first-child {\n  padding-top: 1px;\n}\n.instance-copy {\n  min-width: 0;\n  flex: 1;\n}\n.instance-title {\n  display: block;\n  font-size: 12px;\n  font-weight: 600;\n  line-height: 1.6;\n  overflow-wrap: anywhere;\n}\n.instance-meta {\n  display: block;\n  font-size: 10px;\n  color: #93a397;\n  line-height: 1.6;\n}\n.quick-start {\n  min-width: 56px;\n  font-size: 11px;\n  padding: 7px 13px;\n  flex: none;\n}\n.settings {\n  padding: 0;\n}\n.settings>summary {\n  cursor: pointer;\n  font-size: 12px;\n  font-weight: 650;\n  padding: 15px 16px;\n  list-style: none;\n  display: flex;\n  align-items: center;\n  gap: 8px;\n}\n.settings>summary::-webkit-details-marker {\n  display: none;\n}\n.settings>summary:before {\n  content: '›';\n  font-size: 16px;\n  line-height: 1;\n  color: #8fa395;\n  transition: transform .15s;\n}\n.settings[open]>summary:before {\n  transform: rotate(90deg);\n}\n.summary-hint {\n  font-size: 10px;\n  color: #9aa99f;\n  font-weight: 400;\n  margin-left: auto;\n}\n.settings-body {\n  padding: 0 16px 16px;\n}\n.settings-actions {\n  display: flex;\n  align-items: center;\n  gap: 11px;\n  margin-top: 10px;\n}\n.settings-actions .button {\n  font-size: 11px;\n  min-height: 31px;\n  padding: 6px 11px;\n}\n.divider {\n  height: 1px;\n  background: var(--line);\n  margin: 18px 0;\n}\n.label-hint {\n  color: #92a095;\n  font-size: 10px;\n  font-weight: 400;\n  margin-left: 4px;\n}\n.form-grid {\n  display: grid;\n  grid-template-columns: 1fr 1fr;\n  gap: 13px;\n}\n.manual-form {\n  display: flex;\n  align-items: center;\n  gap: 8px;\n  margin-top: 10px;\n}\n.manual-form input {\n  min-width: 0;\n  flex: 1;\n}\n.manual-form .button {\n  height: 38px;\n  font-size: 11px;\n}\n.sr-only {\n  position: absolute;\n  width: 1px;\n  height: 1px;\n  overflow: hidden;\n  clip: rect(0,0,0,0);\n  white-space: nowrap;\n}\n.log-toolbar {\n  display: flex;\n  justify-content: flex-end;\n  margin-bottom: 4px;\n}\n.logs {\n  max-height: 214px;\n  overflow-y: auto;\n  scrollbar-width: thin;\n}\n.log {\n  display: grid;\n  grid-template-columns: 44px 1fr;\n  gap: 9px;\n  padding: 7px 0;\n  border-bottom: 1px solid #f0f4f0;\n  line-height: 1.65;\n}\n.log:last-child {\n  border-bottom: 0;\n}\n.log-time {\n  font-size: 9px;\n  color: #9aa89d;\n  white-space: nowrap;\n  font-family: ui-monospace,monospace;\n  padding-top: 1px;\n}\n.log-message {\n  font-size: 10px;\n  overflow-wrap: anywhere;\n  white-space: pre-wrap;\n  color: #7a8e80;\n}\n.log.warn .log-message {\n  color: #af8039;\n}\n.log.error .log-message {\n  color: #b9534c;\n}\n.log.success .log-message {\n  color: #22865a;\n}\n.log-instance {\n  font-size: 9px;\n  color: #a1ada4;\n  display: block;\n  line-height: 1.5;\n}\n.feedback {\n  padding: 10px 12px;\n  border: 1px solid #cfe9dd;\n  border-radius: 8px;\n  background: #ecf8f0;\n  color: #29805d;\n  font-size: 11px;\n  line-height: 1.6;\n  margin-bottom: 13px;\n  overflow-wrap: anywhere;\n}\n.feedback.error {\n  border-color: #f2d8d2;\n  background: #fff2ef;\n  color: #ba5644;\n}\nfooter {\n  font-size: 9px;\n  text-align: center;\n  color: #9ca99e;\n  line-height: 1.9;\n  padding: 3px 0 4px;\n}\n[hidden] {\n  display: none!important;\n}\n@keyframes waiting {\n  0% {\n    transform: translateX(-110%);\n  }\n  50% {\n    transform: translateX(250%);\n  }\n  100% {\n    transform: translateX(390%);\n  }\n}\n@media(max-width:365px) {\n  .app {\n    padding: 15px 12px;\n  }\n  .card {\n    padding: 13px;\n  }\n  .settings {\n    padding: 0;\n  }\n  .section-heading .muted {\n    font-size: 9px;\n  }\n  .masthead .compact {\n    font-size: 9px;\n  }\n  .job-details {\n    font-size: 9px;\n  }\n  .job-uuid {\n    font-size: 8px;\n  }\n}\n@media(prefers-reduced-motion:reduce) {\n  *,*:after {\n    transition: none!important;\n    animation: none!important;\n  }\n}\n");
})();
