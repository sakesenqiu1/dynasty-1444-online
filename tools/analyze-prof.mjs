// 解析 --cpu-prof 生成的 .cpuprofile，按"自身耗时"排序
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const dir = process.argv[2] || join(root, '_tools', 'prof');
const files = readdirSync(dir).filter(f => f.endsWith('.cpuprofile'));
if (!files.length) { console.error('没有找到 .cpuprofile，目录:', dir); process.exit(1); }
const newest = files.map(f => ({ f, t: statSync(join(dir, f)).mtimeMs })).sort((a, b) => b.t - a.t)[0].f;
const prof = JSON.parse(readFileSync(join(dir, newest), 'utf8'));
console.log('分析:', newest);

const byId = new Map(prof.nodes.map(n => [n.id, n]));
const self = new Map();
let total = 0;
const dt = prof.timeDeltas || [];
const samples = prof.samples || [];
for (let i = 0; i < samples.length; i++) {
  const n = byId.get(samples[i]);
  const d = dt[i] || 0;
  total += d;
  if (!n) continue;
  const cf = n.callFrame || {};
  const key = (cf.functionName || '(anonymous)') + '  @' + (cf.url || '').split(/[\\/]/).pop() + ':' + (cf.lineNumber + 1);
  self.set(key, (self.get(key) || 0) + d);
}
const rows = [...self.entries()].sort((a, b) => b[1] - a[1]);
console.log(`总采样 ${(total / 1000).toFixed(0)} ms\n`);
console.log('  自身耗时占比   累计    函数');
let acc = 0;
for (const [k, v] of rows.slice(0, 28)) {
  acc += v;
  console.log(`  ${((v / total) * 100).toFixed(1).padStart(8)}%  ${((acc / total) * 100).toFixed(1).padStart(6)}%   ${k}`);
}
