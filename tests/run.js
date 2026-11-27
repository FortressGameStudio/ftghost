/* Fortress Ghost tests. Run with: node tests/run.js
   Starts real hosts on random ports and talks to them with real WebSocket clients. */
'use strict';

const path = require('path');
const http = require('http');
const WebSocket = require('ws');
const Delta = require('../shared/delta');
const Share = require('../client/share');
const Sync = require('../client/sync');
const { GhostHost } = require('../host/ghost-host');

let failed = 0;
let passed = 0;
function check(name, cond) {
  if (cond) { passed++; console.log('PASS ' + name); } else { failed++; console.log('FAIL ' + name); }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms = 3000, step = 20) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) { if (await fn()) return true; await sleep(step); }
  return false;
}
function getJson(port, p) {
  return new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port, path: p }, (res) => {
      let s = '';
      res.on('data', (d) => (s += d));
      res.on('end', () => { try { resolve(JSON.parse(s)); } catch (e) { reject(e); } });
    }).on('error', reject);
  });
}
function connect(port, name, extra) {
  const c = Share.connect(Object.assign({ url: 'ws://127.0.0.1:' + port, name, gameId: 'arena', WebSocket }, extra || {}));
  c.rejected = null; c.chat = [];
  c.on('reject', (r) => { c.rejected = r; });
  c.on('message', (n, d) => { if (n === 'chat') c.chat.push(d); });
  return c;
}
function hostFor(code, config, opts) {
  return new GhostHost(Object.assign({
    config: Object.assign({ id: 'arena', name: 'Test', version: '1.0.0', maxPlayers: 4, tickRate: 30, netRate: 30 }, config),
    serverCode: code, port: 0, host: '127.0.0.1', quiet: true
  }, opts));
}

async function testDelta() {
  const a = { x: 1, p: { a: 1, b: { c: 2 } }, arr: [1, 2], gone: 1 };
  const b = { x: 2, p: { a: 1, b: { c: 3, d: 4 } }, arr: [1, 2, 3], n: null };
  const s = Delta.clone(a);
  Delta.patch(s, Delta.diff(a, b));
  check('delta: diff then patch reproduces the new state', Delta.equal(s, b));
  check('delta: unchanged state gives no ops', Delta.diff(b, Delta.clone(b)).length === 0);
  let threw = false;
  try { Delta.patch({}, [[['__proto__', 'polluted'], 1]]); } catch (e) { threw = true; }
  check('delta: __proto__ path is rejected', threw && ({}).polluted === undefined);
  threw = false;
  try { Delta.patch({}, [[['constructor', 'prototype', 'x'], 1]]); } catch (e) { threw = true; }
  check('delta: constructor path is rejected', threw);
  const t = {};
  Delta.patch(t, [[['a'], JSON.parse('{"__proto__":{"evil":1},"ok":2}')]]);
  check('delta: __proto__ inside a value is stripped', t.a.ok === 2 && ({}).evil === undefined && Object.keys(t.a).length === 1);
}

async function testArena() {
  const host = hostFor(require('fs').readFileSync(path.join(__dirname, '..', 'example', 'arena', 'server.js'), 'utf8'));
  await host.start();
  const port = host.port;
  const h0 = await getJson(port, '/health');
  check('host: health endpoint works', h0.ok && h0.id === 'arena' && h0.players === 0 && h0.accepting);

  const a = connect(port, 'Ada');
  const sa = Sync.attach(a, { delay: 50 });
  check('client A connects and gets state', await until(() => a.ready));
  const b = connect(port, 'Bo');
  const sb = Sync.attach(b, { delay: 50 });
  check('client B connects', await until(() => b.ready));
  check('clients get different ids', a.id && b.id && a.id !== b.id);
  check('both see two player entities', await until(() => Object.keys(sa.entities).length === 2 && Object.keys(sb.entities).length === 2));
  check('players count is replicated', await until(() => a.share.round && a.share.round.players === 2));

  const mineA = sa.mine();
  const x0 = mineA.x;
  a.home.input = { x: 1, y: 0 };
  check('input from A moves its entity on the server (seen by B)', await until(() => {
    const e = Object.values(sb.entities).find((v) => v.ownerId === a.id);
    return e && e.x > x0 + 20;
  }, 3000));
  a.home.input = { x: 0, y: 0 };

  // clamping: absurd input is clamped by the server
  const yBefore = sa.mine().y;
  a.home.input = { x: 0, y: 9999 };
  await sleep(300);
  a.home.input = { x: 0, y: 0 };
  const e1 = sa.mine();
  check('server clamps untrusted input (no teleporting)', e1.y - yBefore < 100);

  // messages
  a.send('chat', 'hello world');
  check('server.sendAll reaches every client', await until(() => b.chat.length === 1 && a.chat.length === 1 && b.chat[0].text === 'hello world'));

  // ping/rtt
  check('rtt is measured', await until(() => a.rtt >= 0 && a.rtt < 1000, 2500) && typeof a.rtt === 'number');

  // lock the lobby via ghostSetIsAcceptingPlayers
  a.send('lock', true);
  check('server half can stop accepting players', await until(async () => (await getJson(port, '/health')).accepting === false));
  const c = connect(port, 'Cy');
  check('new players are rejected while not accepting', await until(() => c.rejected === 'not_accepting'));
  a.send('lock', false);
  check('server half can accept players again', await until(async () => (await getJson(port, '/health')).accepting === true));

  // fill up
  const d = connect(port, 'Di'); await until(() => d.ready);
  const e = connect(port, 'Ed'); await until(() => e.ready);
  const f = connect(port, 'Fi');
  check('host rejects when full', await until(() => f.rejected === 'full'));
  check('full host reports accepting=false', (await getJson(port, '/health')).accepting === false);

  // disconnect cleans up the entity
  e.close(); d.close();
  check('leaving removes the entity for everyone', await until(() => Object.keys(sa.entities).length === 2));
  check('heartbeat is flowing', (await getJson(port, '/health')).lastHeartbeatAgoMs < 1000);

  // wrong game
  const w = connect(port, 'Wy', { gameId: 'other' });
  check('wrong game id is rejected', await until(() => w.rejected === 'wrong_game'));

  // resync returns a full snapshot
  let gotFull = false;
  const raw = new WebSocket('ws://127.0.0.1:' + port);
  raw.on('open', () => raw.send(JSON.stringify({ t: 'hello', proto: 1, name: 'Raw', gameId: 'arena' })));
  raw.on('message', (d2) => {
    const m = JSON.parse(d2.toString());
    if (m.t === 'full' && !raw.asked) { raw.asked = true; raw.send(JSON.stringify({ t: 'resync' })); }
    else if (m.t === 'full' && raw.asked) gotFull = true;
  });
  check('resync request returns a fresh full snapshot', await until(() => gotFull));
  raw.close();

  [a, b, c, f, w].forEach((x) => x.close());
  await host.stop('test done');
}

async function testAbuse() {
  const host = hostFor(require('fs').readFileSync(path.join(__dirname, '..', 'example', 'arena', 'server.js'), 'utf8'), { maxPlayers: 8 }, { maxMessageBytes: 2048 });
  await host.start();
  const port = host.port;

  // garbage and oversized messages
  const bad = new WebSocket('ws://127.0.0.1:' + port);
  let badClosed = false;
  bad.on('open', () => bad.send('this is not json'));
  bad.on('close', () => { badClosed = true; });
  check('invalid JSON drops the client', await until(() => badClosed));

  const big = new WebSocket('ws://127.0.0.1:' + port);
  let bigClosed = false;
  big.on('open', () => big.send(JSON.stringify({ t: 'hello', proto: 1, name: 'x'.repeat(5000) })));
  big.on('close', () => { bigClosed = true; });
  check('oversized message drops the client', await until(() => bigClosed));

  const nohello = new WebSocket('ws://127.0.0.1:' + port);
  let nohelloClosed = false;
  nohello.on('open', () => nohello.send(JSON.stringify({ t: 'home', ops: [] })));
  nohello.on('close', () => { nohelloClosed = true; });
  check('talking before hello drops the client', await until(() => nohelloClosed));

  // flood
  const flood = new WebSocket('ws://127.0.0.1:' + port);
  let floodClosed = false;
  flood.on('open', () => {
    flood.send(JSON.stringify({ t: 'hello', proto: 1, name: 'F', gameId: 'arena' }));
    for (let i = 0; i < 400; i++) flood.send(JSON.stringify({ t: 'ping', ts: i }));
  });
  flood.on('close', () => { floodClosed = true; });
  check('message flood is rate limited', await until(() => floodClosed));

  // prototype pollution via home ops must not affect anything
  const a = connect(port, 'Pol');
  await until(() => a.ready);
  const rawWs = new WebSocket('ws://127.0.0.1:' + port);
  let rawClosed = false;
  rawWs.on('open', () => {
    rawWs.send(JSON.stringify({ t: 'hello', proto: 1, name: 'Evil', gameId: 'arena' }));
    rawWs.send(JSON.stringify({ t: 'home', ops: [[['__proto__', 'polluted'], 1]] }));
    rawWs.send(JSON.stringify({ t: 'home', ops: [[['input', 'x'], 1]] }));
  });
  rawWs.on('close', () => { rawClosed = true; });
  await sleep(300);
  check('prototype-pollution attempt via home ops is harmless', ({}).polluted === undefined && !rawClosed);
  rawWs.close();
  a.close();
  await host.stop('test done');
}

const EVIL = {
  escape: `
    var out = [];
    function tryIt(label, fn) { try { out.push(label + ':' + fn()); } catch (e) { out.push(label + ':blocked'); } }
    tryIt('ctor', function () { return share.constructor.constructor('return typeof process')(); });
    tryIt('ctor2', function () { return console.log.constructor('return typeof process')(); });
    tryIt('ctor3', function () { return server.send.constructor('return typeof process')(); });
    tryIt('ghost', function () { return ghostHeartbeat.constructor('return typeof process')(); });
    tryIt('eval', function () { return eval('typeof process'); });
    tryIt('fn', function () { return new Function('return typeof process')(); });
    tryIt('process', function () { return typeof process; });
    tryIt('require', function () { return typeof require; });
    tryIt('global', function () { return typeof globalThis.process; });
    tryIt('rt', function () { return typeof __rt.hostCall; });
    server.load = function () { console.log('RESULT ' + out.join(' | ')); };
  `,
  loop: `server.update = function () { while (true) {} };`,
  crash: `server.load = function () { throw new Error('boom'); }; server.update = function () { var x = null; x.y = 1; };`,
  memory: `var hog = []; server.update = function () { for (var i = 0; i < 200000; i++) hog.push('x'.repeat(1000) + i); };`,
  syntaxerr: `this is not javascript`
};

async function testSandbox() {
  // escape attempts
  {
    const logs = [];
    const host = hostFor(EVIL.escape);
    host.on('log', (lvl, t) => logs.push(t));
    await host.start();
    await until(() => logs.some((l) => l.indexOf('RESULT') === 0));
    const line = logs.find((l) => l.indexOf('RESULT') === 0) || '';
    check('sandbox: Function constructor escapes are blocked', /ctor:blocked/.test(line) && /ctor2:blocked/.test(line) && /ctor3:blocked/.test(line) && /ghost:blocked/.test(line));
    check('sandbox: eval and new Function are blocked', /eval:blocked/.test(line) && /fn:blocked/.test(line));
    check('sandbox: no process, require or bridge visible', /process:undefined/.test(line) && /require:undefined/.test(line) && /global:undefined/.test(line) && !/rt:function/.test(line));
    await host.stop('done');
  }
  // infinite loop in update
  {
    const host = hostFor(EVIL.loop);
    let crashed = null;
    host.on('crash', (r) => { crashed = r; });
    await host.start();
    check('sandbox: an infinite loop is cut off and the session ends', await until(() => crashed !== null, 6000));
    await host.stop('done');
  }
  // throwing code never takes the host down
  {
    const logs = [];
    const host = hostFor(EVIL.crash);
    host.on('log', (lvl, t) => logs.push(lvl + ' ' + t));
    await host.start();
    await sleep(400);
    check('sandbox: thrown errors are logged, host stays up', logs.some((l) => /boom/.test(l)) && (await getJson(host.port, '/health')).ok);
    await host.stop('done');
  }
  // memory hog
  {
    const host = hostFor(EVIL.memory, {}, { memoryLimitMb: 48, callbackTimeoutMs: 1000 });
    let crashed = null;
    host.on('crash', (r) => { crashed = r; });
    await host.start().catch(() => {});
    check('sandbox: a memory hog is stopped by the memory limit', await until(() => crashed !== null, 15000));
    await host.stop('done');
  }
  // server.js that does not even parse
  {
    const host = hostFor(EVIL.syntaxerr);
    let err = null;
    host.on('crash', (r) => { err = r; });
    await host.start().catch((e) => { err = e.message; });
    check('sandbox: a server.js that fails to load ends the session cleanly', err !== null);
    await host.stop('done');
  }
  // watchdog: server half that stops heartbeating (we simulate with a tiny timeout and a long busy script)
  {
    const host = hostFor(`server.update = function(){ var t = Date.now(); while (Date.now() - t < 90) {} };`, {}, { heartbeatTimeoutMs: 1500, callbackTimeoutMs: 1000 });
    let crashed = null;
    host.on('crash', (r) => { crashed = r; });
    await host.start();
    await sleep(500);
    check('host: a busy but alive server keeps its heartbeat', crashed === null);
    await host.stop('done');
  }
}

async function testHostControls() {
  const host = hostFor('server.update = function(){};');
  await host.start();
  const a = connect(host.port, 'Ada');
  await until(() => a.ready);
  check('host.playerList lists who is connected', host.playerList().length === 1 && host.playerList()[0].name === 'Ada');
  let changes = 0;
  host.on('change', () => changes++);
  host.setAccepting(false);
  const b = connect(host.port, 'Bo');
  check('host.setAccepting(false) turns new players away', await until(() => b.rejected === 'not_accepting') && changes >= 1);
  host.setAccepting(true);
  const c = connect(host.port, 'Cy');
  check('host.setAccepting(true) lets players in again', await until(() => c.ready));
  [a, b, c].forEach((x) => x.close());
  await host.stop('done');
}

async function testBusyPort() {
  const h1 = hostFor('server.update = function(){};');
  await h1.start();
  const h2 = hostFor('server.update = function(){};', {}, { port: h1.port });
  let err = null;
  await h2.start().catch((e) => { err = e; });
  check('a busy port makes start() fail cleanly instead of crashing', err && err.code === 'EADDRINUSE');
  await h2.stop('done');
  await h1.stop('done');
}

async function testWatchdog() {
  const host = hostFor('server.update = function(){};');
  let reason = null;
  host.on('crash', (r) => { reason = r; });
  await host.start();
  host.lastHeartbeat = Date.now() - 60000; // pretend the server half went silent
  host.checkWatchdog();
  check('watchdog: a silent server half is shut down', reason === 'server unresponsive' && (await until(() => host.stopped)));
}

async function testDrain() {
  const host = hostFor('server.update = function(){};');
  await host.start();
  const a = connect(host.port, 'A');
  await until(() => a.ready);
  host.drain();
  const b = connect(host.port, 'B');
  check('drain: new players are turned away', await until(() => b.rejected === 'draining'));
  check('drain: reported in health', (await getJson(host.port, '/health')).draining === true);
  let stopped = false;
  host.on('stopped', () => { stopped = true; });
  a.close();
  check('drain: host stops once the last player leaves', await until(() => stopped));
}

(async () => {
  try {
    await testDelta();
    await testArena();
    await testAbuse();
    await testSandbox();
    await testHostControls();
    await testBusyPort();
    await testWatchdog();
    await testDrain();
  } catch (e) {
    failed++;
    console.log('FAIL test run crashed: ' + (e && e.stack || e));
  }
  console.log('\n' + passed + ' passed, ' + failed + ' failed');
  process.exit(failed ? 1 : 0);
})();
