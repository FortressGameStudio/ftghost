/* Fortress Ghost: sandbox worker.
   Runs in a worker thread (so it has its own memory limit and can be killed).
   Creator code (server.js) is evaluated in a separate vm context with:
     - eval / new Function disabled inside the context
     - no outer-realm objects handed in: the only bridge is one function that takes strings
     - a time limit on every call into the creator's code
   NOTE: Node's vm is not a hardened security boundary on its own. This is the first layer.
   On shared machines also run the host in a container or as an unprivileged user without
   network egress. See ghost/README.md. */
'use strict';

const { parentPort, workerData } = require('worker_threads');
const vm = require('vm');
const fs = require('fs');
const path = require('path');
const runtime = require('./runtime');

const { serverCode, config } = workerData;
const CALL_TIMEOUT = config.callbackTimeoutMs || 100;
const LOAD_TIMEOUT = config.loadTimeoutMs || 2000;
const MAX_STRIKES = 5;

const post = (m) => parentPort.postMessage(m);
const fatal = (text) => { post({ t: 'fatal', text: String(text).slice(0, 400) }); };

const ctx = vm.createContext(Object.create(null), {
  name: 'ghost-sandbox',
  codeGeneration: { strings: false, wasm: false }
});

/* The only way out of the sandbox. Takes a name and a JSON string, returns nothing. */
function hostCall(name, json) {
  let p;
  try { p = json ? JSON.parse(json) : undefined; } catch (e) { return; }
  switch (name) {
    case 'log': post({ t: 'log', level: p.level, text: String(p.text).slice(0, 500) }); break;
    case 'heartbeat': post({ t: 'heartbeat' }); break;
    case 'accepting': post({ t: 'accepting', value: !!p }); break;
    case 'send': post({ t: 'send', to: p.to, msg: JSON.stringify({ t: 'msg', name: p.name, data: p.data }) }); break;
    case 'broadcastMsg': post({ t: 'broadcast', msg: JSON.stringify({ t: 'msg', name: p.name, data: p.data }) }); break;
    case 'kick': post({ t: 'kick', id: p.id, reason: p.reason }); break;
  }
}

/* Build the runtime INSIDE the context, with the diff module also living inside it. */
const deltaSrc = fs.readFileSync(path.join(__dirname, '..', 'shared', 'delta.js'), 'utf8');
const DeltaInside = vm.runInContext('(function(){var module={exports:{}};' + deltaSrc + '\n;return module.exports;})()', ctx);
const init = vm.runInContext('(' + runtime.toString() + ')', ctx);
init(hostCall, DeltaInside);

/* One precompiled script per method; each runs with a time limit. */
const scripts = {};
['start', 'update', 'flush', 'connect', 'resync', 'disconnect', 'receive', 'home'].forEach((m) => {
  scripts[m] = new vm.Script('__rt.' + m + '.apply(null, JSON.parse(__args))', { filename: 'ghost-runtime:' + m });
});

const strikes = {};
function run(method, args) {
  ctx.__args = JSON.stringify(args || []);
  try {
    const out = scripts[method].runInContext(ctx, { timeout: CALL_TIMEOUT });
    strikes[method] = 0;
    return typeof out === 'string' ? out : '';
  } catch (e) {
    strikes[method] = (strikes[method] || 0) + 1;
    post({ t: 'log', level: 'error', text: 'server ' + method + ' stopped: ' + String(e && e.message).slice(0, 200) });
    if (strikes[method] >= MAX_STRIKES) fatal('server code kept failing (' + method + '): ' + String(e && e.message));
    return '';
  }
}

try {
  new vm.Script(String(serverCode), { filename: 'server.js' }).runInContext(ctx, { timeout: LOAD_TIMEOUT });
} catch (e) {
  fatal('server.js failed to load: ' + (e && e.message));
  return;
}

const first = run('start');
const tickMs = 1000 / (config.tickRate || 30);
const netMs = 1000 / (config.netRate || 20);
let last = Date.now();
let netAcc = 0;

post({ t: 'ready' });

const timer = setInterval(() => {
  const now = Date.now();
  const dt = Math.min(0.25, (now - last) / 1000);
  last = now;
  run('update', [dt]);
  netAcc += dt * 1000;
  if (netAcc >= netMs) {
    netAcc = 0;
    const patch = run('flush');
    if (patch) post({ t: 'broadcast', msg: patch });
  }
  post({ t: 'heartbeat' });
}, tickMs);

function deliver(res, to) {
  let r;
  try { r = JSON.parse(res); } catch (e) { return; }
  if (r.pre) post({ t: 'broadcast', msg: r.pre });
  if (r.post) post({ t: 'broadcast', msg: r.post });
  if (r.full) post({ t: 'send', to, msg: r.full, full: true });
}

parentPort.on('message', (m) => {
  switch (m.t) {
    case 'connect': deliver(run('connect', [m.id, m.info]), m.id); break;
    case 'resync': deliver(run('resync'), m.id); break;
    case 'disconnect': run('disconnect', [m.id]); break;
    case 'receive': run('receive', [m.id, m.name, m.data]); break;
    case 'home': run('home', [m.id, m.ops]); break;
    case 'stop': clearInterval(timer); process.exit(0); break;
  }
});

if (first) post({ t: 'broadcast', msg: first });
