import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const entries = execFileSync('git', ['ls-files', '-z', '--stage'], { cwd: root, encoding: 'utf8' }).split('\0').filter(Boolean);
const files = entries.map(entry => entry.slice(entry.indexOf('\t') + 1));
const symlinks = new Set(entries.filter(entry => entry.startsWith('120000 ')).map(entry => entry.slice(entry.indexOf('\t') + 1)));
if (!files.length) throw new Error('No tracked files to inspect. Stage the intended public files first.');
const failures = [];
const privatePath = /(?:^|\/)(?:html|preview|\.idea|\.vscode|node_modules|__pycache__)(?:\/|$)|(?:^|\/)(?:\.DS_Store|\.env(?:\..+)?|[^/]+\.(?:pem|key|pyc))$/;
const secretPatterns = [
  ['embedded JWT', /eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/],
  ['WxPusher key', /SPT_[A-Za-z0-9_-]{12,}/],
  ['GitHub token', /(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{40,})/],
  ['private key', /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/],
  ['real-format instance ID', /\bpro-[0-9a-f]{12}\b/],
  ['machine-specific absolute path', /\/(?:Users|home)\/[A-Za-z0-9_.-]+\//]
];
for (const file of files) {
  if (privatePath.test(file)) failures.push(`${file}: private/local file`);
  if (symlinks.has(file)) { failures.push(`${file}: unexpected symbolic link`); continue; }
  if (/\.(?:png|jpe?g|gif|webp|ico)$/i.test(file)) continue;
  // Inspect the index: these are the exact bytes prepared for publication.
  const content = execFileSync('git', ['show', `:${file}`], { cwd: root, encoding: 'utf8', maxBuffer: 5 * 1024 * 1024 });
  for (const [label, pattern] of secretPatterns) if (pattern.test(content)) failures.push(`${file}: ${label}`);
}
if (failures.length) {
  process.stderr.write(`Public-file check failed (matching values are never printed):\n${failures.map(value => `- ${value}`).join('\n')}\n`);
  process.exitCode = 1;
} else process.stdout.write(`Public-file check passed for ${files.length} tracked files.\n`);
