// 供 --cpu-prof 采样的纯模拟脚本
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
globalThis.WORLD_DATA = require(join(root, 'web', 'world-data.js'));
const core = require(join(root, 'web', 'game-core.js'));

core.resetWorld();
core.buildWorld();
core.setHumans([140, 44]);
// 关注月度结算：多跑几年，让采样集中在 aiMonthly 上
for (let d = 0; d < 18250; d++) core.tickDay();   // 50 年
console.log('sim done');
