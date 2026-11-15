/* Beefeater tests: real registry (HTTP), real agent, real host processes. node tests/beefeater.js */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const WebSocket = require('ws');
const Share = require('../client/share');
const { Beefeater } = require('../beefeater/agent');
const { publish } = require('../beefeater/publish');

let failed = 0, passed = 0;
const check = (n, c) => { c ? passed++ : failed++; console.log((c ? 'PASS ' : 'FAIL ') + n); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms = 8000, step = 50) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) { if (await fn()) return true; await sleep(step); }
  return false;
}
function getJson(port, p) {
  return new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port, path: p, timeout: 2000 }, (res) => {
      let s = ''; res.on('data', (d) => (s += d)); res.on('end', () => { try { resolve(JSON.parse(s)); } catch (e) { reject(e); } });
    }).on('error', reject);
  });
}

(async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'beefeater-'));
  const registryDir = path.join(tmp, 'registry');
  const gameSrc = path.join(tmp, 'src');
  fs.mkdirSync(gameSrc, { recursive: true });
  const base = fs.readFileSync(path.join(__dirname, '..', 'example', 'arena', 'server.js'), 'utf8');
  const writeGame = (version) => {
    fs.writeFileSync(path.join(gameSrc, 'game.json'), JSON.stringify({ id: 'arena', name: 'Arena', version, maxPlayers: 4, tickRate: 30, netRate: 20 }));
    fs.writeFileSync(path.join(gameSrc, 'server.js'), '// version ' + version + '\n' + base);
  };

  // a registry that serves the folder, with switches for tampering
  const tamper = { file: null, manifest: null };
  const reg = http.createServer((req, res) => {
    const rel = decodeURIComponent(req.url.split('?')[0]);
    if (tamper.manifest && rel.endsWith('manifest.json')) { res.end(JSON.stringify(tamper.manifest)); return; }
    const file = path.join(registryDir, rel);
    if (!file.startsWith(registryDir) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) { res.writeHead(404); res.end('no'); return; }
    let data = fs.readFileSync(file);
    if (tamper.file && rel.endsWith(tamper.file)) data = Buffer.concat([data, Buffer.from('\n// tampered')]);
    res.end(data);
  });
  await new Promise((r) => reg.listen(0, '127.0.0.1', r));
  const registry = 'http://127.0.0.1:' + reg.address().port;

  writeGame('1.0.0');
  publish(gameSrc, registryDir);

  const basePort = 21000 + Math.floor(Math.random() * 5000);
  const agent = new Beefeater({ registry, dir: path.join(tmp, 'deployed'), games: ['arena'], pollMs: 400, healthMs: 300, drainMs: 4000, basePort, bindHost: '127.0.0.1', quiet: true });
  const running = [];
  agent.on('instance-running', (i) => running.push(i));
  await agent.start();

  check('first deploy installs version 1.0.0', agent.current('arena') === '1.0.0');
  check('first instance comes up', await until(() => running.length >= 1));
  const v1 = running[0];
  const h1 = await getJson(v1.port, '/health');
  check('instance serves version 1.0.0', h1.version === '1.0.0' && h1.accepting);

  // a player is connected on v1
  const a = Share.connect({ url: 'ws://127.0.0.1:' + v1.port, name: 'Ada', gameId: 'arena', WebSocket });
  await until(() => a.ready);
  check('player connects to v1', a.ready && a.info.version === '1.0.0');

  // new version published
  writeGame('1.1.0');
  publish(gameSrc, registryDir);
  check('agent notices and deploys 1.1.0', await until(() => agent.current('arena') === '1.1.0'));
  check('a new instance starts on 1.1.0', await until(() => running.some((i) => i.version === '1.1.0')));
  const v2 = running.find((i) => i.version === '1.1.0');
  check('old instance is draining, not killed (player still connected)', await until(() => v1.state === 'draining') && a.connected && (await getJson(v1.port, '/health')).draining === true);
  const b = Share.connect({ url: 'ws://127.0.0.1:' + v2.port, name: 'Bo', gameId: 'arena', WebSocket });
  check('new players land on the new version', await until(() => b.ready) && b.info.version === '1.1.0');
  a.close();
  check('old instance exits once its last player leaves', await until(() => !agent.instances.includes(v1)));

  // tampered file: checksum must fail, version must not change
  writeGame('1.2.0');
  publish(gameSrc, registryDir);
  tamper.file = '1.2.0/server.js';
  let failedUpdate = false;
  agent.once('update-failed', () => { failedUpdate = true; });
  check('a tampered download is rejected', await until(() => failedUpdate));
  check('and the running version does not change', agent.current('arena') === '1.1.0');
  tamper.file = null;

  // unsafe manifest path
  tamper.manifest = { id: 'arena', version: '9.9.9', files: [{ path: '../evil.js', sha256: 'a'.repeat(64), size: 1 }, { path: 'server.js', sha256: 'a'.repeat(64), size: 1 }, { path: 'game.json', sha256: 'a'.repeat(64), size: 1 }] };
  failedUpdate = false;
  agent.once('update-failed', () => { failedUpdate = true; });
  check('a manifest with a path outside the game folder is rejected', await until(() => failedUpdate));
  check('nothing was written outside the deploy folder', !fs.existsSync(path.join(tmp, 'deployed', 'games', 'evil.js')) && !fs.existsSync(path.join(tmp, 'deployed', 'evil.js')));
  tamper.manifest = null;

  // after tampering stops, the good 1.2.0 deploys
  check('the clean 1.2.0 then deploys normally', await until(() => agent.current('arena') === '1.2.0', 8000));
  const v3 = await until(() => running.some((i) => i.version === '1.2.0')) && running.find((i) => i.version === '1.2.0');
  check('and gets a running instance', !!v3);
  b.close();

  // crash recovery: kill -9 the live instance
  await until(() => agent.instances.filter((i) => i.state === 'running').length === 1 && agent.instances.every((i) => i.version === '1.2.0'));
  const live = agent.instances.find((i) => i.state === 'running');
  const before = running.length;
  live.child.kill('SIGKILL');
  check('a crashed host is restarted automatically', await until(() => running.length > before, 10000));

  const st = agent.status();
  check('status lists the game and its current version', st.games[0].id === 'arena' && st.games[0].current === '1.2.0');

  await agent.stop();
  check('stop() shuts every host down', agent.instances.length === 0 || agent.instances.every((i) => i.state === 'dead'));
  reg.close();
  fs.rmSync(tmp, { recursive: true, force: true });
  console.log('\n' + passed + ' passed, ' + failed + ' failed');
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.log('FAIL beefeater test crashed: ' + (e && e.stack || e)); process.exit(1); });
