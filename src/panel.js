import { instanceCanStart } from "./core.js";

export function createPanel(container, scheduler, { initialUuid = '', onClose = () => {}, beforeStart = async () => {} } = {}) {
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
      if (!/^pro-[a-z0-9]+$/i.test(uuid)) throw new Error('请输入有效的 Pro 实例 ID');
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
