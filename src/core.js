export const MIN_INTERVAL_SECONDS = 30;
export const MAX_INTERVAL_SECONDS = 86400;
export const ACTIVE_STATUSES = new Set(["scheduled", "running", "retrying"]);

// A task result describes a past request, not the instance's current power state.
// Only current page evidence can make an otherwise idle instance unavailable.
export function instanceCanStart(instance) {
  const status = String(instance?.status || "").replace(/\s+/g, "").toLowerCase();
  if (/(?:已开机|运行中|正在运行|已运行|开机中|正在开机|启动中|正在启动|关机中|正在关机|重启中|正在重启|创建中|释放中|已释放|删除中|已删除|已销毁)/.test(status)) return false;
  if (/^(?:running|starting|restarting|stopping|provisioning|deleting|deleted|released)$/.test(status)) return false;
  if (typeof instance?.canPowerOn === "boolean") return instance.canPowerOn;
  // Missing page information must not turn old success records into a permanent lock.
  return true;
}

export function normalizeConfig(input, now = Date.now()) {
  if (!input || typeof input !== "object") throw new Error("任务配置无效");
  const uuid = String(input.uuid || "").trim();
  if (!/^pro-[a-z0-9]{4,64}$/.test(uuid)) throw new Error("请输入有效的实例 ID，例如 pro-xxxxxxxxxxxx");
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

export function parseAuthToken(value) {
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

export function sanitizeMessage(value, secrets = []) {
  let message = String(value ?? "").replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, "");
  for (const secret of secrets) if (secret) message = message.split(secret).join("[已隐藏]");
  return message.replace(/(?:Bearer\s+)?eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g, "[鉴权已隐藏]")
    .replace(/SPT_[A-Za-z0-9_-]+/g, "[推送密钥已隐藏]").slice(0, 400);
}

export function classifyResponse(httpStatus, body) {
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
  if (code === "InternalError" && /当前算力规格暂无库存/.test(message)) return { kind: "stock", message };
  return { kind: "error", message: message || `接口返回未识别的结果（${code || "无状态码"}），已停止任务` };
}

export function retryDelaySeconds(intervalSeconds, consecutiveFailures = 0, retryAfterSeconds = 0) {
  const base = Math.max(MIN_INTERVAL_SECONDS, Number(intervalSeconds) || 60);
  const exponential = Math.min(900, base * 2 ** Math.min(5, Math.max(0, consecutiveFailures)));
  return Math.max(base, exponential, Math.min(86400, Math.max(0, Number(retryAfterSeconds) || 0)));
}

export function parseRetryAfter(value, now = Date.now()) {
  if (!value) return 0;
  const seconds = Number(value);
  if (Number.isFinite(seconds)) return Math.max(0, seconds);
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? Math.max(0, Math.ceil((timestamp - now) / 1000)) : 0;
}
