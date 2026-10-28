import { readFile, readdir } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { Script } from 'node:vm';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
const root = new URL('../', import.meta.url);
const read = file => readFile(new URL(file, root), 'utf8');
const bundled = await read('autodl-scheduler.user.js');
new Script(bundled, { filename: 'autodl-scheduler.user.js' });
assert.ok(bundled.startsWith('// ==UserScript=='));
for (const grant of ['GM_getValue', 'GM_setValue', 'GM_xmlhttpRequest', 'GM_notification', 'GM_openInTab']) {
  assert.match(bundled, new RegExp(`// @grant\\s+${grant}\\b`));
}
assert.ok(!/\bchrome\.(?:runtime|storage|alarms|permissions)/.test(bundled));
assert.ok(!/\b(?:eval|Function)\s*\(/.test(bundled));
assert.ok(!/eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/.test(bundled), 'No embedded JWT');
assert.ok(!/SPT_[A-Za-z0-9_-]{8,}/.test(bundled), 'No embedded push secret');
const html = await read('src/panel.html');
const ui = await read('src/panel.js');
const ids = [...html.matchAll(/\bid="([^"]+)"/g)].map(match => match[1]);
assert.equal(new Set(ids).size, ids.length, 'Panel IDs must be unique');
for (const match of ui.matchAll(/\$\('([^']+)'\)/g)) assert.ok(ids.includes(match[1]), `Missing UI element: ${match[1]}`);
for (const file of (await readdir(new URL('src/', root))).filter(file => file.endsWith('.js'))) {
  const result = spawnSync(process.execPath, ['--check', fileURLToPath(new URL(`src/${file}`, root))], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
}
process.stdout.write('Userscript metadata, syntax, UI bindings and credential checks passed.\n');
