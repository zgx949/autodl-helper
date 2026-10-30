import { createScheduler } from "./scheduler.js";
import { installPage } from "./page.js";
import { instanceType, instanceConsoleUrl } from "./core.js";
import { createTabCoordinator } from "./tabs.js";

export function requestInstancePowerOn({ uuid, token, appVersion, signal }) {
  const type = instanceType(uuid);
  if (!type) throw new Error("请输入有效的普通或 Pro 实例 ID");
  const headers = { accept: "application/json", "content-type": "application/json;charset=UTF-8", authorization: token };
  if (appVersion) headers.appversion = appVersion;
  return fetch(`https://www.autodl.com/api/v1/instance/${type === "pro" ? "pro/" : ""}power_on`, {
    method: "POST", credentials: "include", cache: "no-store", redirect: "error", headers,
    body: JSON.stringify({ instance_uuid: uuid, payload: "" }), signal
  });
}

export function readPageCredentials() {
  let token = "";
  let appVersion = "";
  let isSubUser = false;
  try { token = localStorage.getItem("token") || ""; } catch {}
  try { appVersion = JSON.parse(localStorage.getItem("app_version") || "{}").version || ""; } catch {}
  try { isSubUser = Boolean(JSON.parse(localStorage.getItem("user") || "{}")?.sub_name); } catch {}
  return { token, appVersion, isSubUser };
}

export async function bootstrap(panelMarkup, panelCss) {
  const STORAGE_KEY = "autodl-scheduler:state:v1";
  const currentConsoleUrl = () => `https://www.autodl.com/console/instance/${location.pathname.startsWith("/console/instance/pro/") ? "pro/" : ""}list`;
  const storage = {
    get: async () => GM_getValue(STORAGE_KEY, null),
    set: async value => { GM_setValue(STORAGE_KEY, value); }
  };
  let stopped = false;
  let page = null;
  let scheduler = null;
  function makeScheduler(isLeader, reason) {
    return createScheduler({
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
  }
  function stop() {
    if (stopped) return;
    stopped = true;
    if (typeof page === "function") page();
    scheduler?.destroy();
  }
  window.addEventListener("pagehide", stop, { once: true });
  // Back/forward cache restores JS state without rerunning the userscript.
  window.addEventListener("pageshow", event => { if (event.persisted && stopped) location.reload(); });
  scheduler = createTabCoordinator({ makeScheduler, getCredentials: readPageCredentials,
    openConsole: () => GM_openInTab(currentConsoleUrl(), { active: true, insert: true }) });
  page = installPage(scheduler, panelMarkup, panelCss);
}
