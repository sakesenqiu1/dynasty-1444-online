// Run a local shell script on the remote host: node run.mjs <local.sh> [args...]
import { readFileSync } from 'node:fs';
import { basename } from 'node:path';
import { Client } from 'ssh2';
import { needEnv } from './env.mjs';
needEnv(["GS_HOST","GS_PASS"]);

const HOST = process.env.GS_HOST;
const PORT = Number(process.env.GS_PORT || 22);
const USER = process.env.GS_USER || 'root';
const PASS = process.env.GS_PASS;

const local = process.argv[2];
const extra = process.argv.slice(3);
if (!local) { console.error('usage: node run.mjs <local.sh> [args...]'); process.exit(2); }
const body = readFileSync(local, 'utf8');
const remote = '/tmp/_dsh_' + basename(local).replace(/[^\w.-]/g, '_');
const remoteArgs = extra.map(a => `'${String(a).replace(/'/g, `'\\''`)}'`).join(' ');

const c = new Client();
await new Promise((res, rej) => c.on('ready', res).on('error', rej)
  .connect({ host: HOST, port: PORT, username: USER, password: PASS, readyTimeout: 30000, keepaliveInterval: 10000 }));

await new Promise((res, rej) => c.sftp((e, sftp) => e ? rej(e) : sftp.writeFile(remote, body, (x) => x ? rej(x) : res())));

const code = await new Promise((resolve, reject) => {
  c.exec(`bash ${remote} ${remoteArgs}`, (err, stream) => {
    if (err) return reject(err);
    stream.on('close', (cd) => resolve(cd))
      .on('data', (d) => process.stdout.write(d.toString()));
    stream.stderr.on('data', (d) => process.stderr.write(d.toString()));
  });
});
c.end();
process.exit(code ?? 0);
