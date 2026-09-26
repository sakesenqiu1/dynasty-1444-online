// 本地回归：顺序跑 _tools 下所有不依赖真实浏览器的测试，汇总通过/失败。
//   node _tools/run-local-tests.mjs
//
// 子进程的 stdout/stderr 直接写临时文件而不是走管道：某些受限的执行环境
// 不允许创建命名管道，用管道抓输出会整批假失败。
import { spawnSync } from 'node:child_process';
import { openSync, closeSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const tools = dirname(fileURLToPath(import.meta.url));
const root = join(tools, '..');

// 需要真实浏览器（headless Edge + CDP）的另跑，不在这里
const SKIP = new Set(['test-browser2.mjs', 'test-map-visual.mjs']);
// 需要额外环境变量的（缺少时它们会自己退出，但那是"跳过"不是"失败"）
const NEEDS_ENV = { 'test-maps-live.mjs': 'MAP_ADMIN_PASS' };
// 本来就是长时间压测的用例，给足时间
const SLOW = {
  'test-editor-unit.mjs': 180000, 'test-load.mjs': 180000,
  'test-jitter.mjs': 300000, 'test-memory.mjs': 300000, 'test-load-long.mjs': 300000,
};
const only = process.argv.slice(2);
const files = readdirSync(tools)
  .filter(f => /^test-.*\.mjs$/.test(f) && !SKIP.has(f))
  .filter(f => !only.length || only.some(o => f.includes(o)))
  .sort();

let totalPass = 0, totalFail = 0, skipped = 0;
const bad = [];
for (const f of files) {
  if (NEEDS_ENV[f] && !process.env[NEEDS_ENV[f]]) {
    console.log(`SKIP ${f.padEnd(26)}        需要 ${NEEDS_ENV[f]}`);
    skipped++;
    continue;
  }
  const logPath = join(tmpdir(), 'gs-test-' + process.pid + '.log');
  const fd = openSync(logPath, 'w');
  const t0 = Date.now();
  let r;
  try {
    r = spawnSync(process.execPath, [join(tools, f)], {
      cwd: root, stdio: ['ignore', fd, fd], timeout: SLOW[f] || 45000,
    });
  } finally { closeSync(fd); }
  const out = readFileSync(logPath, 'utf8');
  try { rmSync(logPath, { force: true }); } catch (e) {}

  const ms = Date.now() - t0;
  const pass = (out.match(/^\s*PASS\b/gm) || []).length;
  const fails = (out.match(/^\s*FAIL\b/gm) || []).length;
  const timedOut = !!(r.error && r.error.code === 'ETIMEDOUT');
  const ok = r.status === 0 && !timedOut;
  totalPass += pass; totalFail += fails;
  if (!ok) bad.push(f);
  const tail = out.trim().split('\n').filter(Boolean).slice(-1)[0] || '';
  console.log(`${ok ? 'OK  ' : 'BAD '} ${f.padEnd(26)} ${String(ms).padStart(6)}ms  PASS=${pass} FAIL=${fails}` +
    `${timedOut ? '  TIMEOUT' : ''}${ok ? '' : '  | ' + tail.slice(0, 150)}`);
}
console.log(`\n=== ${files.length - bad.length - skipped}/${files.length - skipped} 个测试文件通过，断言 PASS=${totalPass} FAIL=${totalFail}` +
  `${skipped ? '，跳过 ' + skipped + ' 个（缺环境变量）' : ''} ===`);
if (bad.length) { console.log('失败文件：' + bad.join(', ')); process.exit(1); }
