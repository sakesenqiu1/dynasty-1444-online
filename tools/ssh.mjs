// Minimal SSH/SFTP helper built on ssh2.
// Usage:
//   node ssh.mjs exec "<command>"          -> run remote command
//   node ssh.mjs sudo "<command>"          -> run via sudo -S (password fed on pty)
//   node ssh.mjs put <local> <remote>      -> upload file
//   node ssh.mjs get <remote> <local>      -> download file
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { Client } from 'ssh2';
import { needEnv } from './env.mjs';
needEnv(["GS_HOST","GS_PASS"]);

const HOST = process.env.GS_HOST;
const PORT = Number(process.env.GS_PORT || 22);
const USER = process.env.GS_USER || 'root';
const PASS = process.env.GS_PASS;

const [mode, a1, a2] = process.argv.slice(2);

function conn() {
  return new Promise((res, rej) => {
    const c = new Client();
    c.on('ready', () => res(c))
      .on('error', rej)
      .connect({
        host: HOST, port: PORT, username: USER, password: PASS,
        readyTimeout: 30000, keepaliveInterval: 10000,
        algorithms: {
          serverHostKey: ['ssh-ed25519', 'ssh-rsa', 'ecdsa-sha2-nistp256', 'rsa-sha2-512', 'rsa-sha2-256'],
        },
      });
  });
}

function exec(c, cmd, { ptySudo = false } = {}) {
  return new Promise((resolve, reject) => {
    c.exec(cmd, { pty: ptySudo }, (err, stream) => {
      if (err) return reject(err);
      let out = '', errOut = '';
      stream.on('close', (code) => resolve({ code, out, errOut }))
        .on('data', (d) => { out += d.toString(); });
      stream.stderr.on('data', (d) => { errOut += d.toString(); });
      if (ptySudo) stream.write(PASS + '\n');
    });
  });
}

try {
  const c = await conn();
  if (mode === 'exec') {
    const r = await exec(c, a1);
    process.stdout.write(r.out);
    if (r.errOut) process.stderr.write(r.errOut);
    c.end();
    process.exit(r.code ?? 0);
  } else if (mode === 'sudo') {
    const r = await exec(c, `sudo -S -p '' bash -lc ${JSON.stringify(a1)}`, { ptySudo: true });
    process.stdout.write(r.out);
    if (r.errOut) process.stderr.write(r.errOut);
    c.end();
    process.exit(r.code ?? 0);
  } else if (mode === 'put' || mode === 'get') {
    await new Promise((resolve, reject) => {
      c.sftp((err, sftp) => {
        if (err) return reject(err);
        if (mode === 'put') sftp.fastPut(a1, a2, (e) => e ? reject(e) : resolve());
        else { mkdirSync(dirname(a2), { recursive: true }); sftp.fastGet(a1, a2, (e) => e ? reject(e) : resolve()); }
      });
    });
    console.log(`${mode} ok: ${a1} -> ${a2}`);
    c.end();
    process.exit(0);
  } else {
    console.error('unknown mode', mode);
    c.end();
    process.exit(2);
  }
} catch (e) {
  console.error('SSH ERROR:', e.message);
  process.exit(1);
}
