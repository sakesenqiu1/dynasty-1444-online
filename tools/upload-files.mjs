// 只上传指定的几个文件（比 upload.mjs 的整目录上传安全，改动面最小）。
//   node _tools/upload-files.mjs web/client.js [web/net.js ...]
// 目标路径固定为 /www/wwwroot/gs-game/<同样的相对路径>。
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
const { Client } = require('ssh2');

const HOST = process.env.GS_HOST;
const REMOTE = '/www/wwwroot/gs-game';
const files = process.argv.slice(2);
if (!files.length) { console.error('用法: node _tools/upload-files.mjs web/client.js [...]'); process.exit(2); }

const c = new Client();
await new Promise((res, rej) => c.on('ready', res).on('error', rej)
  .connect({ host: HOST, port: 22, username: 'root', password: process.env.GS_PASS, readyTimeout: 30000 }));

const sftp = await new Promise((res, rej) => c.sftp((e, s) => e ? rej(e) : res(s)));
const put = (local, remote) => new Promise((res, rej) => sftp.fastPut(local, remote, e => e ? rej(e) : res()));
const md5 = (p) => new Promise((res, rej) => c.exec(`md5sum ${p}`, (e, st) => {
  if (e) return rej(e);
  let o = ''; st.on('close', () => res(o.trim().split(/\s+/)[0])).on('data', d => o += d);
}));

for (const f of files) {
  const local = join(root, f);
  const remote = `${REMOTE}/${f.replace(/\\/g, '/')}`;
  await put(local, remote);
  console.log(`  ↑ ${f}  md5=${await md5(remote)}`);
}
sftp.end();
console.log('上传完成');
c.end();
