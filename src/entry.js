import { createScheduler } from "./scheduler.js";
import { installPage } from "./page.js";

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
  const CONSOLE_URL = "https://www.autodl.com/console/instance/pro/list";
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
      openConsole: () => GM_openInTab(CONSOLE_URL, { active: true, insert: true }),
      requestPowerOn: ({ uuid, token, appVersion, signal }) => {
        const headers = { accept: "application/json", "content-type": "application/json;charset=UTF-8", authorization: token };
        if (appVersion) headers.appversion = appVersion;
        return fetch("https://www.autodl.com/api/v1/instance/pro/power_on", {
          method: "POST", credentials: "include", cache: "no-store", redirect: "error", headers,
          body: JSON.stringify({ instance_uuid: uuid, payload: "" }), signal
        });
      },
      notify: (title, text) => GM_notification({ title, text, timeout: 15000, onclick: () => GM_openInTab(CONSOLE_URL, { active: true }) }),
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
