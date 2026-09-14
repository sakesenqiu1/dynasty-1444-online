// Static check: find identifiers CALLED in game-core.js that are neither defined
// in game-core.js nor JavaScript/Node built-ins. Those must come from the client
// section (a bug once core is loaded standalone on the server).
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const coreSrc = readFileSync(join(root, 'web', 'game-core.js'), 'utf8');
const clientSrc = readFileSync(join(root, 'web', 'client.js'), 'utf8');

const strip = (s) => s
  .replace(/\/\*[\s\S]*?\*\//g, ' ')
  .replace(/(^|[^:])\/\/[^\n]*/g, '$1 ')
  .replace(/`(?:[^`\\]|\\.)*`/g, '``')
  .replace(/'(?:[^'\\\n]|\\.)*'/g, "''")
  .replace(/"(?:[^"\\\n]|\\.)*"/g, '""');

const declRe = /(?:^|\n)\s*(?:async\s+)?function\s+([A-Za-z_$][\w$]*)|(?:^|\n)\s*(?:var|let|const)\s+([A-Za-z_$][\w$]*)/g;
function declared(src) {
  const out = new Set();
  const s = strip(src);
  let m;
  while ((m = declRe.exec(s))) out.add(m[1] || m[2]);
  // destructuring / multi declarators: const a=1, b=2;
  for (const mm of s.matchAll(/(?:^|\n)\s*(?:var|let|const)\s+([^;\n]+)/g)) {
    for (const part of mm[1].split(',')) {
      const id = part.trim().match(/^([A-Za-z_$][\w$]*)\s*=/);
      if (id) out.add(id[1]);
    }
  }
  return out;
}

const BUILTINS = new Set([
  'if','for','while','switch','catch','return','typeof','function','new','delete','void','in','of','do','else','try','case',
  'Math','JSON','Object','Array','Map','Set','Number','String','Boolean','Date','RegExp','Error','Promise','Symbol','Int32Array',
  'Uint8Array','Uint8ClampedArray','Float64Array','Int16Array','Uint16Array','Infinity','NaN','isNaN','parseInt','parseFloat',
  'setTimeout','clearTimeout','setInterval','clearInterval','requestAnimationFrame','console','performance','structuredClone',
  'require','module','exports','globalThis','window','document','localStorage','fetch','WebSocket','queueMicrotask',
  // cross-script: provided by client.js in the browser, must exist in core for the server
  'super','this','arguments',
]);

const coreDecl = declared(coreSrc);
const clientDecl = declared(clientSrc);
const coreCode = strip(coreSrc);

const called = new Set();
for (const m of coreCode.matchAll(/(?:^|[^\w$.])([A-Za-z_$][\w$]*)\s*\(/g)) called.add(m[1]);

const missing = [...called].filter(n => !coreDecl.has(n) && !BUILTINS.has(n)).sort();
const missingInClient = missing.filter(n => clientDecl.has(n));
const unknown = missing.filter(n => !clientDecl.has(n));

console.log('core declares', coreDecl.size, 'names; calls', called.size, 'distinct names');
console.log('\n== CALLED IN CORE BUT DEFINED IN CLIENT (must move to core) ==');
console.log(missingInClient.length ? missingInClient.join(', ') : '(none)');
console.log('\n== CALLED IN CORE, DEFINED NOWHERE (typos / real gaps) ==');
console.log(unknown.length ? unknown.join(', ') : '(none)');

// reverse direction: client variables that core expects to exist
const coreVars = [...coreDecl];
console.log('\n== CORE GLOBALS THE CLIENT MAY REASSIGN ==');
console.log(coreVars.filter(v => /^(armies|wars|truces|provinces|countries|humans|logEntries|pendingOffers|nextArmy|dayCount|cal|player|battleProvs|labelsDirty|paused|speed|started|mapMode|selectedProv|selectedArmy|uiTab|uiSearch|diploFocus|land|provOf)$/.test(v)).join(', '));
