#!/usr/bin/env python3
"""Build and optionally serve a fully offline AutoDL DOM/UI preview (stdlib only)."""
from __future__ import annotations

import argparse
from html import escape
from html.parser import HTMLParser
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlsplit

ROOT = Path(__file__).resolve().parent.parent
VOID = {"area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "param", "source", "track", "wbr"}
SAFE = {"div", "span", "table", "thead", "tbody", "tfoot", "tr", "th", "td", "colgroup", "col", "button", "br"}


class Node:
    def __init__(self, tag, attrs=()):
        self.tag, self.attrs, self.children = tag, dict(attrs), []


class FixtureParser(HTMLParser):
    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.root = Node("root")
        self.stack = [self.root]

    def handle_starttag(self, tag, attrs):
        node = Node(tag, attrs)
        self.stack[-1].children.append(node)
        if tag not in VOID:
            self.stack.append(node)

    def handle_startendtag(self, tag, attrs):
        self.handle_starttag(tag, attrs)
        if tag not in VOID:
            self.handle_endtag(tag)

    def handle_endtag(self, tag):
        for index in range(len(self.stack) - 1, 0, -1):
            if self.stack[index].tag == tag:
                del self.stack[index:]
                break

    def handle_data(self, text):
        self.stack[-1].children.append(text)


def first_instance_table(node):
    if "instance-table" in node.attrs.get("class", "").split():
        return node
    for child in node.children:
        if isinstance(child, Node):
            found = first_instance_table(child)
            if found:
                return found
    return None


def serialize(node):
    if isinstance(node, str):
        return escape(node)
    # Only inert display elements and a few structural attributes survive.
    if node.tag not in SAFE:
        return ""
    attrs = []
    for key in ("class", "rowspan", "colspan"):
        value = node.attrs.get(key)
        if value:
            attrs.append(f'{key}="{escape(value, quote=True)}"')
    if node.tag == "button":
        attrs.extend(['type="button"', 'disabled', 'title="示例原生按钮，离线演示中不可用"'])
    opening = "<" + node.tag + (" " + " ".join(attrs) if attrs else "") + ">"
    if node.tag in VOID:
        return opening
    return opening + "".join(map(serialize, node.children)) + "</" + node.tag + ">"


STYLE = """
*{box-sizing:border-box}body{margin:0;background:#f2f5f7;color:#233642;font:14px -apple-system,BlinkMacSystemFont,'Segoe UI','PingFang SC',sans-serif}.demo-banner{padding:16px 24px;background:#173a35;color:#fff;font-weight:650}.demo-banner small{display:block;color:#bdd9d0;font-weight:400;margin-top:6px;font-size:12px}.demo-main{max-width:1420px;margin:28px auto;padding:0 24px}.demo-title{display:flex;align-items:center;justify-content:space-between;gap:16px;margin-bottom:18px}h1{font-size:24px;margin:0 0 8px}p{margin:0;color:#7a8b94;font-size:12px;line-height:1.7}.demo-controls{display:flex;gap:10px;flex-wrap:wrap}.demo-controls button{border:1px solid #cbded7;border-radius:8px;background:#fff;color:#087f71;font:inherit;font-size:12px;padding:9px 12px;cursor:pointer}.demo-controls button:disabled{opacity:.6}.demo-card{padding:18px;border:1px solid #e1e8e9;border-radius:12px;background:#fff;margin:16px 0;overflow:auto}.demo-card h2{font-size:14px;margin:0 0 12px}.el-table{width:100%;min-width:1080px;font-size:12px;border-collapse:collapse}.el-table table{width:100%;table-layout:auto;border-collapse:collapse}.el-table th{padding:12px 8px;color:#77868e;font-weight:500;background:#f7f9fa;text-align:left;white-space:nowrap}.el-table td{padding:15px 8px;border-bottom:1px solid #edf0f2;vertical-align:top;line-height:1.8}.el-table .hidden-columns{display:none}.el-table button{font-size:11px;border:0;background:none;color:#7d929c;padding:2px 4px}.el-table button:disabled{opacity:.7}.region-name{color:#6e828c;font-size:11px}.status{white-space:nowrap;color:#8898a1}.el-scrollbar__bar,.el-table__empty-block,.el-loading-mask{display:none}.checks{margin:0;padding-left:22px;font-size:12px;line-height:2}.checks .pass{color:#087f71}.checks .fail{color:#bb4949}.demo-note{margin-top:15px;color:#84949a;font-size:12px}.demo-card code{font-size:11px;background:#f3f7f6;padding:2px 5px;border-radius:4px}@media(max-width:650px){.demo-title{display:block}.demo-controls{margin-top:14px}.demo-main{padding:0 12px}.demo-banner{padding:14px}}
"""

SCRIPT = r"""
import { installPage } from '/src/page.js';
import { normalizeConfig, instanceCanStart } from '/src/core.js';

// Every API below is a local simulation. Real scheduler/entry modules are never imported.
const nativeFetch = window.fetch.bind(window);
window.fetch = async (input, init = {}) => {
  const url = new URL(typeof input === 'string' ? input : input.url, location.href);
  if (url.origin !== location.origin || !['/src/panel.html', '/src/panel.css'].includes(url.pathname) || (init.method && init.method !== 'GET')) {
    throw new Error('离线演示已阻止非预览资源请求');
  }
  return nativeFetch(input, init);
};
window.XMLHttpRequest = class { constructor() { throw new Error('离线演示禁止 XMLHttpRequest'); } };
history.replaceState(null, '', '/console/instance/list?offline-preview=1');
const [panelMarkup, panelCss] = await Promise.all([
  fetch('/src/panel.html?v=1.2.2', { cache: 'no-store' }).then(response => response.text()),
  fetch('/src/panel.css?v=1.2.2', { cache: 'no-store' }).then(response => response.text()),
]);
const expected = [
  { uuid: 'pro-demo0001', name: 'Demo GPU A', status: '已关机', canPowerOn: null },
  { uuid: 'demo000001-00000001', name: 'Demo GPU B', status: '已关机', canPowerOn: null },
];
let syncCount = 0;
let lastPageSync = null;
let startCount = 0;
const state = {
  auth: { available: true, expiresAt: Date.now() + 86400000, appVersion: '离线模拟' },
  readOnly: false,
  instances: structuredClone(expected),
  jobs: [],
  preferences: { intervalSeconds: 60, maxAttempts: 0, startAt: null },
  logs: [{ at: Date.now(), level: 'info', message: '离线演示已就绪，所有任务与通知均为模拟，不发送网络请求。' }],
  pushConfigured: false,
};
function log(message, level = 'info', uuid) {
  state.logs.push({ at: Date.now(), level, uuid, message: `【离线模拟】${message}` });
}
function advance() {
  for (const job of state.jobs) {
    if (!job.enabled || Date.now() < job.nextRunAt) continue;
    job.attempts += 1;
    job.updatedAt = Date.now();
    if (job.attempts >= 3) {
      Object.assign(job, { enabled: false, status: 'success', nextRunAt: null, lastMessage: '【离线模拟】开机请求已受理；没有调用真实接口' });
      log('模拟开机已受理', 'success', job.uuid);
    } else {
      Object.assign(job, { status: 'retrying', nextRunAt: Date.now() + job.intervalSeconds * 1000, lastMessage: '【离线模拟】暂无库存，等待下一次模拟检查' });
      log('模拟库存不足，等待重试', 'warn', job.uuid);
    }
  }
}
const scheduler = {
  async syncPage(input) {
    syncCount += 1;
    // The preview never retains token or account metadata from any source.
    lastPageSync = { instances: structuredClone(input.instances), pageUrl: input.pageUrl };
    if (input.instances.length) state.instances = structuredClone(input.instances);
  },
  async command(type, payload = {}) {
    advance();
    if (state.readOnly && !['GET_STATE', 'OPEN_AUTODL'].includes(type)) return { ok: false, error: '另一个标签页正在管理任务' };
    if (type === 'START_JOB') {
      startCount += 1;
      let config;
      const defaults = { ...state.preferences };
      if (defaults.startAt && defaults.startAt <= Date.now()) defaults.startAt = null;
      try { config = normalizeConfig({ ...defaults, ...payload.config }); }
      catch (error) { return { ok: false, error: error.message }; }
      if (!instanceCanStart(state.instances.find(item => item.uuid === config.uuid))) return { ok: false, error: '实例当前已开机或正在启动' };
      if (state.jobs.some(job => job.uuid === config.uuid && job.enabled)) return { ok: false, error: '该实例已有离线模拟任务，请先停止' };
      state.jobs = state.jobs.filter(job => job.uuid !== config.uuid);
      const scheduled = config.startAt > Date.now() + 20;
      state.jobs.push({ ...config, enabled: true, status: scheduled ? 'scheduled' : 'retrying',
        attempts: scheduled ? 0 : 1, nextRunAt: scheduled ? config.startAt : Date.now() + config.intervalSeconds * 1000,
        updatedAt: Date.now(), lastMessage: '【离线模拟】任务已创建，不发送真实开机请求' });
      log('创建模拟任务', 'info', config.uuid);
    } else if (type === 'SET_PREFERENCES') {
      let config;
      try { config = normalizeConfig({ uuid: 'pro-preview0000', ...payload.config }); }
      catch (error) { return { ok: false, error: error.message }; }
      state.preferences = { intervalSeconds: config.intervalSeconds, maxAttempts: config.maxAttempts, startAt: payload.config.startAt == null ? null : config.startAt };
      log('已保存后续任务的模拟设置');
    } else if (type === 'STOP_JOB') {
      const job = state.jobs.find(item => item.uuid === payload.uuid);
      if (job) Object.assign(job, { enabled: false, status: 'stopped', nextRunAt: null, updatedAt: Date.now(), lastMessage: '【离线模拟】任务已停止' });
      log('停止模拟任务', 'info', payload.uuid);
    } else if (type === 'DELETE_JOB') {
      if (state.jobs.some(job => job.uuid === payload.uuid && job.enabled)) return { ok: false, error: '请先停止任务再删除' };
      state.jobs = state.jobs.filter(job => job.uuid !== payload.uuid);
    } else if (type === 'CLEAR_LOGS') {
      state.logs = [];
    } else if (type === 'SET_PUSH') {
      state.pushConfigured = Boolean(payload.token);
      log('仅模拟更改通知配置，不保存密钥、不发送通知');
    } else if (type === 'OPEN_AUTODL') {
      log('离线演示不会打开真实控制台');
    } else if (type !== 'GET_STATE') {
      return { ok: false, error: '演示未实现此操作' };
    }
    return { ok: true, snapshot: structuredClone(state) };
  },
};
let destroyPage = installPage(scheduler, panelMarkup, panelCss);
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const rowButtons = () => [...document.querySelectorAll('[data-autodl-scheduler-button="userscript"]')];
const rowDeletes = () => [...document.querySelectorAll('[data-autodl-scheduler-delete="userscript"]')];
const shadowRoot = () => document.getElementById('autodl-scheduler-host')?.shadowRoot;
document.getElementById('open-demo').addEventListener('click', () => shadowRoot()?.querySelector('.adls-launcher')?.click());

async function runChecks() {
  const output = document.getElementById('assertions');
  output.replaceChildren();
  const results = [];
  function check(label, passed, detail = '') {
    const result = { label, passed: Boolean(passed), detail };
    results.push(result);
    const item = document.createElement('li');
    item.className = passed ? 'pass' : 'fail';
    item.textContent = `${passed ? '✓' : '✗'} ${label}${detail ? ` — ${detail}` : ''}`;
    output.append(item);
  }
  const button = document.getElementById('run-checks');
  button.disabled = true;
  try {
    destroyPage();
    state.jobs = [];
    state.readOnly = false;
    for (const row of document.querySelectorAll('#fixture .el-table__row')) row.querySelector('.status').textContent = '已关机';
    state.preferences = { intervalSeconds: 60, maxAttempts: 0, startAt: null };
    startCount = 0;
    destroyPage = installPage(scheduler, panelMarkup, panelCss);
    await pause(80);
    check('合成示例识别出普通与 Pro 实例及对应名称', JSON.stringify(lastPageSync?.instances) === JSON.stringify(expected));
    check('两个实例行各注入一个按钮', rowButtons().length === 2);
    check('无任务时直接显示抢机入口且没有自动开机', rowButtons().every(item => item.textContent === '抢机') && state.jobs.length === 0 && startCount === 0);
    check('fixture 不含外链、事件属性或原站脚本', !document.querySelector('#fixture script, #fixture [src], #fixture [href]') &&
      [...document.querySelectorAll('#fixture *')].every(element => [...element.attributes].every(attr => !attr.name.startsWith('on'))));
    const before = syncCount;
    const marker = document.createElement('span');
    document.getElementById('fixture').append(marker);
    marker.remove();
    await pause(550);
    check('DOM 重扫不会重复注入行按钮', rowButtons().length === 2);
    check('未变化的页面同步已去重', syncCount === before);
    rowButtons()[0].click();
    await pause(80);
    let root = shadowRoot();
    check('一点抢机直接创建任务，无需填表或打开面板', state.jobs.some(job => job.uuid === expected[0].uuid && job.enabled) && startCount === 1 && root.querySelector('.adls-backdrop').hidden);
    const firstJob = state.jobs.find(job => job.uuid === expected[0].uuid);
    check('默认立即开始、每60秒重试且不限次数', firstJob && firstJob.intervalSeconds === 60 && firstJob.maxAttempts === 0 && firstJob.attempts === 1);
    const firstControls = rowButtons()[0].closest('[data-autodl-scheduler-controls="userscript"]');
    const progress = firstControls?.querySelector('[data-autodl-scheduler-progress="userscript"]');
    const stopButton = firstControls?.querySelector('[data-autodl-scheduler-stop="userscript"]');
    check('原网页直接显示尝试进度和停止入口', progress && !progress.hidden && progress.textContent.includes('1') && stopButton && !stopButton.hidden);
    rowButtons()[0].click();
    await pause(80);
    check('再次点击运行任务仅查看进度，不重复创建', !root.querySelector('.adls-backdrop').hidden && startCount === 1 && root.querySelector('#jobs').textContent.includes(expected[0].name));
    const advanced = root.querySelector('#advanced-settings');
    // Chromium may retain descendant layout boxes inside a closed <details>.
    // Its native open state determines whether those controls are exposed.
    check('高级设置默认收起，间隔和开始时间不直接显示', advanced && !advanced.open && advanced.contains(root.querySelector('#interval')) && advanced.contains(root.querySelector('#start-at')));
    check('主界面没有必填任务表单或实例ID输入', !root.querySelector('#job-form') && advanced && !advanced.open && advanced.contains(root.querySelector('#instance-uuid')));
    const box = root.querySelector('.adls-dialog').getBoundingClientRect();
    check('面板宽高在视口内，最大 450×740', box.width <= 451 && box.height <= 741 && box.left >= 0 && box.right <= innerWidth + 1 && box.bottom <= innerHeight + 1);
    advanced.open = true;
    for (const intervalSeconds of [0, 0.1, 1]) {
      root.querySelector('#interval').value = String(intervalSeconds);
      const form = root.querySelector('#preferences-form');
      const valid = form.checkValidity();
      form.requestSubmit(root.querySelector('#save-preferences'));
      await pause(80);
      check(`原生表单允许保存 ${intervalSeconds} 秒间隔`, valid && state.preferences.intervalSeconds === intervalSeconds);
    }
    root.querySelector('#interval').value = '90';
    root.querySelector('#max-attempts').value = '4';
    root.querySelector('#start-at').value = '';
    root.querySelector('#preferences-form').dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    await pause(80);
    check('保存高级设置不会创建任务或更改原任务', state.preferences.intervalSeconds === 90 && state.preferences.maxAttempts === 4 && state.jobs.length === 1 && firstJob.intervalSeconds === 60 && startCount === 1);
    advanced.open = false;
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    check('ESC 关闭面板', root.querySelector('.adls-backdrop').hidden);
    rowButtons()[1].click();
    await pause(80);
    check('第二个实例一键使用保存的高级设置', state.jobs.some(job => job.uuid === expected[1].uuid && job.enabled && job.intervalSeconds === 90 && job.maxAttempts === 4) && startCount === 2 && root.querySelector('.adls-backdrop').hidden);
    stopButton.click();
    await pause(80);
    check('原网页可直接停止任务并保留另一任务', state.jobs.some(job => job.uuid === expected[0].uuid && !job.enabled && job.status === 'stopped') && state.jobs.some(job => job.uuid === expected[1].uuid && job.enabled));
    const firstRow = rowButtons()[0].closest('.el-table__row');
    const nativeStatus = firstRow.querySelector('.status');
    const refreshUi = async () => { window.dispatchEvent(new Event('pageshow')); await pause(120); };
    const endedJob = status => ({ uuid: expected[0].uuid, name: expected[0].name, enabled: false, status, intervalSeconds: 60, maxAttempts: 0, attempts: 3, nextRunAt: null, updatedAt: Date.now(), lastMessage: '【离线模拟】历史任务记录' });
    const setEndedJob = async status => { state.jobs = state.jobs.filter(job => job.uuid !== expected[0].uuid); state.jobs.push(endedJob(status)); await refreshUi(); };
    await setEndedJob('success');
    check('历史成功记录不锁定当前已关机的实例', rowButtons()[0].textContent.includes('抢机') && !rowButtons()[0].disabled);
    const beforeRestart = startCount;
    rowButtons()[0].click();
    await pause(100);
    check('成功开机后关机可原地重新抢机，无需先删除记录', startCount === beforeRestart + 1 && state.jobs.find(job => job.uuid === expected[0].uuid)?.enabled && state.jobs.find(job => job.uuid === expected[0].uuid)?.attempts === 1);
    firstControls.querySelector('[data-autodl-scheduler-stop="userscript"]').click();
    await pause(80);
    await setEndedJob('success');
    root.querySelector('.adls-launcher').click();
    await pause(80);
    const successCard = [...root.querySelectorAll('[data-task-uuid]')].find(item => item.dataset.taskUuid === expected[0].uuid);
    const restartAction = [...(successCard?.querySelectorAll('button') || [])].find(item => item.textContent === '重新抢机');
    check('成功任务面板同时提供重新抢机与删除入口', restartAction && [...successCard.querySelectorAll('button')].some(item => item.textContent.includes('删除')));
    restartAction?.click();
    await pause(80);
    check('任务面板也能直接重新启动已关机的历史成功实例', state.jobs.find(job => job.uuid === expected[0].uuid)?.enabled && startCount === beforeRestart + 2);
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    firstControls.querySelector('[data-autodl-scheduler-stop="userscript"]').click();
    await pause(80);
    for (const status of ['success', 'stopped', 'error', 'exhausted']) {
      await setEndedJob(status);
      const beforeDelete = startCount;
      const deleteAction = firstControls.querySelector('[data-autodl-scheduler-delete="userscript"]');
      const visible = deleteAction && !deleteAction.hidden && !deleteAction.disabled;
      deleteAction?.click();
      await pause(80);
      check(`原网页可以删除 ${status} 结束记录而不操作机器`, visible && !state.jobs.some(job => job.uuid === expected[0].uuid) && firstControls.querySelector('[data-autodl-scheduler-progress="userscript"]').hidden && startCount === beforeDelete && nativeStatus.textContent === '已关机');
    }
    const secondControls = rowButtons()[1].closest('[data-autodl-scheduler-controls="userscript"]');
    check('活跃任务不显示删除入口，必须先停止', !secondControls.querySelector('[data-autodl-scheduler-delete="userscript"]') || secondControls.querySelector('[data-autodl-scheduler-delete="userscript"]').hidden);
    await setEndedJob('success');
    state.readOnly = true;
    await refreshUi();
    const readonlyDelete = firstControls.querySelector('[data-autodl-scheduler-delete="userscript"]');
    readonlyDelete?.click();
    await pause(40);
    check('只读副标签不能删除结束记录', readonlyDelete?.disabled && state.jobs.some(job => job.uuid === expected[0].uuid));
    state.readOnly = false;
    await refreshUi();
    const beforePowerCheck = startCount;
    for (const status of ['已开机', '运行中', '开机中']) {
      nativeStatus.textContent = status;
      await pause(600);
      rowButtons()[0].click();
      await pause(40);
      check(`实例当前${status}时不再发起抢机`, rowButtons()[0].disabled && startCount === beforePowerCheck && !state.jobs.find(job => job.uuid === expected[0].uuid)?.enabled);
    }
    nativeStatus.textContent = '已关机';
    await pause(600);
    check('页面状态再次关机后立即恢复重新抢机入口', !rowButtons()[0].disabled && rowButtons()[0].textContent.includes('抢机'));
    firstControls.querySelector('[data-autodl-scheduler-delete="userscript"]').click();
    await pause(80);
    const host = document.getElementById('autodl-scheduler-host');
    host.remove();
    await pause(550);
    check('SPA 移除浮层后自动恢复且按钮不重复', host.isConnected && rowButtons().length === 2);
    destroyPage();
    check('销毁清理浮层及行按钮', !document.getElementById('autodl-scheduler-host') && rowButtons().length === 0);
    destroyPage = installPage(scheduler, panelMarkup, panelCss);
    await pause(80);
    rowButtons()[1]?.click();
    await pause(80);
    check('销毁后可重新安装并打开面板', rowButtons().length === 2 && !shadowRoot().querySelector('.adls-backdrop').hidden);
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    const standardControls = rowButtons()[1].closest('[data-autodl-scheduler-controls="userscript"]');
    standardControls.querySelector('[data-autodl-scheduler-stop="userscript"]').click();
    await pause(80);
    const standardStatus = rowButtons()[1].closest('.el-table__row').querySelector('.status');
    const beforeStandardCheck = startCount;
    standardStatus.textContent = '开机中';
    await pause(600);
    rowButtons()[1].click();
    check('普通实例开机中禁止重复抢机', rowButtons()[1].disabled && startCount === beforeStandardCheck);
    standardStatus.textContent = '已关机';
    await pause(600);
    rowButtons()[1].click();
    await pause(80);
    check('普通实例关机后可重新抢机并保留实例名称', startCount === beforeStandardCheck + 1 && state.jobs.some(job => job.uuid === expected[1].uuid && job.name === expected[1].name && job.enabled));
    const panelRoot = shadowRoot();
    panelRoot.querySelector('.adls-launcher').click();
    await pause(80);
    panelRoot.querySelector('#advanced-settings').open = true;
    panelRoot.querySelector('#instance-uuid').value = 'demo000002-00000002';
    panelRoot.querySelector('#manual-start').closest('form').dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    await pause(80);
    check('高级设置支持手动添加普通实例 ID', state.jobs.some(job => job.uuid === 'demo000002-00000002' && job.enabled));
    state.jobs = state.jobs.filter(job => job.uuid !== 'demo000002-00000002');
    panelRoot.querySelector('#advanced-settings').open = false;
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    // Leave a completed historical request on an off instance for the release screenshot.
    await setEndedJob('success');
  } catch (error) {
    check('验证流程完成', false, error.message);
  } finally {
    window.__offlineUiChecks = results;
    document.body.dataset.previewChecks = results.every(result => result.passed) ? 'passed' : 'failed';
    document.getElementById('check-summary').textContent = `${results.filter(result => result.passed).length}/${results.length} 项通过；全部操作均为本地模拟。`;
    button.disabled = false;
  }
}
document.getElementById('run-checks').addEventListener('click', () => void runChecks());
void runChecks();
"""


def build_preview():
    fixture = ROOT / "tests" / "fixtures" / "autodl-instances.html"
    if not fixture.is_file():
        raise SystemExit(f"未找到合成测试数据：{fixture}")
    parser = FixtureParser()
    parser.feed(fixture.read_text(encoding="utf-8"))
    table = first_instance_table(parser.root)
    if not table:
        raise SystemExit("合成测试数据中未找到 .instance-table")
    safe_table = serialize(table)
    output = ROOT / "preview"
    output.mkdir(exist_ok=True)
    document = f'''<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; connect-src 'self'; img-src 'none'; frame-src 'none'; object-src 'none'; base-uri 'none'">
<title>AutoDL Helper · 离线演示</title><style>{STYLE}</style></head>
<body><header class="demo-banner">AutoDL Helper · 离线演示<small>实例信息全部为虚构示例。任务、库存与通知均为本地模拟，不发送开机请求。</small></header>
<main class="demo-main"><div class="demo-title"><div><h1>AutoDL · 普通与 Pro 实例列表</h1><p>点击实例行的“抢机”即可开始；所有操作仅在本地模拟。</p></div><div class="demo-controls"><button id="open-demo" type="button">打开演示面板</button><button id="run-checks" type="button">重新运行 DOM 检查</button></div></div>
<section class="demo-card" id="fixture">{safe_table}</section>
<details class="demo-card"><summary>离线 DOM / UI 检查 · <span id="check-summary">正在检查…</span></summary><ol id="assertions" class="checks"></ol></details>
<p class="demo-note">预览读取 <code>/src/panel.js</code>、<code>/src/panel.css</code>、<code>/src/page.js</code>，不会导入真实调度器。</p></main>
<script type="module">{SCRIPT}</script></body></html>'''
    destination = output / "index.html"
    destination.write_text(document, encoding="utf-8")
    print(f"Offline preview generated: {destination}", flush=True)
    return destination


class PreviewHandler(SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(ROOT), **kwargs)

    def do_GET(self):
        path = urlsplit(self.path).path
        if path in ("/", "/console/instance/list", "/console/instance/pro/list"):
            self.path = "/preview/index.html"
        elif path not in {"/preview/index.html", "/src/core.js", "/src/page.js", "/src/panel.js", "/src/panel.html", "/src/panel.css"}:
            self.send_error(404, "Not a preview resource")
            return
        super().do_GET()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--serve", action="store_true", help="Serve the project root on localhost after generation")
    parser.add_argument("--port", type=int, default=8765)
    args = parser.parse_args()
    build_preview()
    if args.serve:
        server = ThreadingHTTPServer(("127.0.0.1", args.port), PreviewHandler)
        print(f"Offline preview: http://127.0.0.1:{args.port}/preview/index.html", flush=True)
        try:
            server.serve_forever()
        except KeyboardInterrupt:
            pass
        finally:
            server.server_close()


if __name__ == "__main__":
    main()
