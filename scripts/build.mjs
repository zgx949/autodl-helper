import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
const root = new URL('../', import.meta.url);
const read = path => readFile(new URL(path, root), 'utf8');
const { version } = JSON.parse(await read('package.json'));
const header = `// ==UserScript==
// @name         AutoDL Helper · 一键抢机
// @namespace    autodl-scheduler.local
// @version      ${version}
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
`;
const sourceFiles = ['src/core.js', 'src/scheduler.js', 'src/panel.js', 'src/page.js', 'src/entry.js'];
const parts = await Promise.all(sourceFiles.map(async path => {
  const source = (await read(path)).replace(/^import\s+[^\n]+\n/gm, '').replace(/^export\s+(?=(?:async\s+)?function|const|let|class)/gm, '');
  return `\n// Source: ${path}\n${source}`;
}));
const [markup, css] = await Promise.all([read('src/panel.html'), read('src/panel.css')]);
const output = `${header}\n(() => {\n'use strict';\n${parts.join('\n')}\nvoid bootstrap(${JSON.stringify(markup)}, ${JSON.stringify(css)});\n})();\n`;
const target = new URL('autodl-scheduler.user.js', root);
if (process.argv.includes('--check')) {
  const existing = await readFile(target, 'utf8').catch(() => '');
  if (existing !== output) {
    process.stderr.write('The installable userscript is out of date. Run npm run build.\n');
    process.exitCode = 1;
  } else process.stdout.write('Installable userscript matches the source and package version.\n');
} else {
  await writeFile(target, output);
  process.stdout.write(`Built ${fileURLToPath(target)} (${Buffer.byteLength(output)} bytes)\n`);
}
