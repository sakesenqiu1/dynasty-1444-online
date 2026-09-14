// Uploads the game (web assets + server) to the remote host.
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from 'ssh2';
import { needEnv } from './env.mjs';
needEnv(["GS_HOST","GS_PASS"]);

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const HOST = process.env.GS_HOST;
const REMOTE = '/www/wwwroot/gs-game';

const c = new Client();
await new Promise((res, rej) => c.on('ready', res).on('error', rej)
  .connect({ host: HOST, port: 22, username: 'root', password: process.env.GS_PASS, readyTimeout: 30000 }));

const exec = (cmd) => new Promise((resolve, reject) => {
  c.exec(cmd, (err, stream) => {
    if (err) return reject(err);
    let out = '';
    stream.on('close', (code) => resolve({ code, out }))
      .on('data', d => out += d.toString());
    stream.stderr.on('data', d => out += d.toString());
  });
});

console.log((await exec(`mkdir -p ${REMOTE}/web ${REMOTE}/srv`)).out);

const sftp = await new Promise((res, rej) => c.sftp((e, s) => e ? rej(e) : res(s)));
const put = (local, remote) => new Promise((res, rej) => sftp.fastPut(local, remote, e => e ? rej(e) : res()));

/* web 资源 */
const webFiles = readdirSync(join(root, 'web')).filter(f => /\.(html|js|css)$/.test(f) && !f.includes('orig'));
for (const f of webFiles) {
  await put(join(root, 'web', f), `${REMOTE}/web/${f}`);
  console.log('  web/' + f);
}
/* 服务端 */
for (const f of ['server.js', 'package.json']) {
  await put(join(root, 'srv', f), `${REMOTE}/srv/${f}`);
  console.log('  srv/' + f);
}
/* 部署与运维脚本 */
for (const f of readdirSync(join(root, '_tools', 'sh'))) {
  if (!f.startsWith('deploy-')) continue;
  const body = readFileSync(join(root, '_tools', 'sh', f), 'utf8').replace(/\r\n/g, '\n');
  await new Promise((res, rej) => sftp.writeFile(`${REMOTE}/srv/${f}`, body, e => e ? rej(e) : res()));
  console.log('  srv/' + f);
}

sftp.end();
console.log('\n上传完成 ->', REMOTE);
c.end();
