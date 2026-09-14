// Headless sanity test: build the world, run 10 simulated years, report state.
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);

globalThis.WORLD_DATA = require(join(root, 'web', 'world-data.js'));
console.log('WORLD_DATA geometries:', globalThis.WORLD_DATA.objects.countries.geometries.length);

const core = require(join(root, 'web', 'game-core.js'));

const t0 = Date.now();
core.resetWorld();
core.buildWorld();
console.log('world built in', Date.now() - t0, 'ms');

const s = core.getState();
console.log('provinces :', s.provinces.length - 1);
console.log('countries :', s.countries.length - 1);
const alive = s.countries.filter(c => c && c.alive).length;
console.log('alive     :', alive);
let landPix = 0, coast = 0, nbrs = 0;
for (let i = 1; i < s.provinces.length; i++) {
  const p = s.provinces[i];
  landPix += p.pix.length;
  coast += p.coastPix ? p.coastPix.length : 0;
  nbrs += p.nbrs.length;
}
console.log('province pixels:', landPix, ' coast pixels:', coast, ' neighbour links:', nbrs);
console.log('sample provinces:', s.provinces.slice(1, 6).map(p => `${p.name}(${p.pix.length}px,${p.nbrs.length}nb)`).join(' '));
console.log('sample countries:', s.countries.slice(1, 6).map(c => `${c.name}[${c.provList.length}]`).join(' '));

// strongest countries
const rank = s.countries.filter(c => c && c.alive).map(c => [c.name, core.totalDev(c), c.provList.length])
  .sort((a, b) => b[1] - a[1]).slice(0, 8);
console.log('top by dev:', rank.map(r => `${r[0]}:${r[1]}dev/${r[2]}prov`).join('  '));

// pick two human players and run the sim
const human1 = s.countries.find(c => c && c.alive && c.name === '法兰西王国');
const human2 = s.countries.find(c => c && c.alive && c.name === '大明');
const ids = [human1 ? human1.id : rank[0] && 1, human2 ? human2.id : 2];
core.setHumans(ids);
console.log('humans:', ids.join(','));

const logs = [];
core.UI.log = (text, cls, forCid) => logs.push(`[${forCid}] ${text}`);

const t1 = Date.now();
let days = 0;
for (let i = 0; i < 3650; i++) { core.tickDay(); days++; }
console.log(`simulated ${days} days in ${Date.now() - t1} ms`);

const s2 = core.getState();
console.log('date:', core.fmtDate(), 'dayCount:', s2.dayCount);
console.log('armies:', s2.armies.length, ' wars:', s2.wars.length, ' log entries:', s2.logEntries.length);
console.log('alive countries now:', s2.countries.filter(c => c && c.alive).length);
const st = core.getState();
console.log('gold of humans:', ids.map(i => `${st.countries[i] ? st.countries[i].name + '=' + Math.round(st.countries[i].gold) : i + '(dead)'}`).join(' '));
console.log('--- last 8 log lines ---');
for (const l of logs.slice(-8)) console.log(' ', l.slice(0, 110));

// save / load round trip
const snap = core.makeSaveData();
const json = JSON.stringify(snap);
console.log('snapshot bytes:', json.length);
core.applySaveData(JSON.parse(json));
const st2 = core.getState();
console.log('after reload -> dayCount', st2.dayCount, 'armies', st2.armies.length, 'humans', [...st2.humans].join(','));
console.log('OK');
