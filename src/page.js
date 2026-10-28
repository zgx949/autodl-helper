import { createPanel } from "./panel.js";

export function installPage(scheduler, panelMarkup, panelCss) {
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

  function renderRows() {
    const jobs = new Map((taskSnapshot?.jobs || []).map(job => [job.uuid, job]));
    const readOnly = Boolean(taskSnapshot?.readOnly);
    for (const [row, controls] of rowControls) {
      if (!row.isConnected || !controls.wrapper.isConnected) { rowControls.delete(row); continue; }
      const job = jobs.get(controls.uuid);
      const active = Boolean(job?.enabled);
      const showResult = job?.status === 'success';
      setText(controls.button, active ? '查看进度' : showResult ? '查看结果' : job ? '重新抢机' : '抢机');
      controls.button.disabled = controls.busy || (!active && !showResult && readOnly);
      controls.button.style.opacity = controls.button.disabled ? '.55' : '1';
      controls.button.style.cursor = controls.button.disabled ? 'default' : 'pointer';
      controls.button.title = readOnly && !active && !showResult ? taskSnapshot.blockedReason || '请在管理任务的标签页操作' : '';
      controls.button.setAttribute('aria-label', `${active ? '查看' : showResult ? '查看' : '为'} ${controls.name} ${active ? '的抢机进度' : showResult ? '的抢机结果' : '抢机'}`);
      controls.progress.hidden = !job;
      controls.progress.style.display = job ? 'flex' : 'none';
      controls.stop.hidden = !active;
      controls.stop.style.display = active ? 'inline-block' : 'none';
      controls.stop.disabled = controls.busy || readOnly;
      controls.stop.style.opacity = controls.stop.disabled ? '.55' : '1';
      controls.stop.title = readOnly ? taskSnapshot.blockedReason || '请在管理任务的标签页操作' : '停止后续抢机尝试';
      if (job) {
        const stateText = { scheduled: '等待开始', running: '正在抢机', retrying: '等待重试', success: '开机已受理', stopped: '已停止', error: '需检查', exhausted: '次数已用完' }[job.status] || '等待中';
        const detail = `${stateText} · 已尝试 ${job.attempts || 0} 次${active && job.nextRunAt ? ` · ${countdown(job.nextRunAt)}` : ''}`;
        setText(controls.status, detail);
        controls.status.title = job.lastMessage || '';
        controls.status.style.color = ['error', 'exhausted'].includes(job.status) ? '#b65c42' : showResult ? '#16815f' : '#69817b';
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
      const response = await scheduler.command(type, type === 'START_JOB' ? { config: { uuid: controls.uuid, name: controls.name } } : { uuid: controls.uuid });
      if (!response?.ok) throw new Error(response?.error || '操作未完成，请稍后重试');
      applySnapshot(response.snapshot);
      showToast(type === 'START_JOB' ? (response.snapshot?.jobs?.find(job => job.uuid === controls.uuid)?.status === 'scheduled' ? '已添加抢机任务，将在预约时间开始' : '已开始抢机，暂无库存时会自动重试') : '已停止后续抢机尝试');
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
      panel = createPanel(panelContainer, scheduler, { initialUuid: uuid, onClose: closePanel });
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
        .find((element) => /^pro-[a-z0-9]+$/i.test(element.textContent.trim()));
      if (!uuidElement) continue;
      const uuid = uuidElement.textContent.trim();
      const name = (uuidElement.nextElementSibling?.querySelector('span:not(.iconfont)')?.textContent || '').trim();
      const status = (row.querySelector('.status')?.textContent || '').trim();
      instances.set(uuid, { uuid, name: name || uuid, status });

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
        progress.append(statusElement, stop);
        wrapper.append(button, progress);
        controls = { wrapper, button, progress, status: statusElement, stop, uuid, name: name || uuid, busy: false };
        rowControls.set(row, controls);
        button.addEventListener('click', (event) => {
          event.preventDefault();
          event.stopPropagation();
          const job = taskSnapshot?.jobs?.find(item => item.uuid === controls.uuid);
          if (job?.enabled || job?.status === 'success') openPanel(controls.uuid);
          else void rowCommand(controls, 'START_JOB');
        });
        stop.addEventListener('click', (event) => {
          event.preventDefault();
          event.stopPropagation();
          void rowCommand(controls, 'STOP_JOB');
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
