/* Beefeater (fortress-server-agent).
   Runs on every Ghost machine. It keeps the deployed game servers up to date:
     1. polls the registry for each game's manifest
     2. downloads the new version into a staging folder and checks every file's sha256 and size
     3. swaps it in atomically, then rolls out: starts a host on the new version, tells the old one to
        drain (no new players, exits when empty, or is stopped after drainMs)
     4. supervises hosts: restarts crashed ones with backoff, kills ones whose /health stops answering
   Registry layout:  <registry>/<gameId>/manifest.json   and   <registry>/<gameId>/<version>/<file> */
'use strict';

const fs = require('fs');
const path = require('path');
const http = require('http');
const crypto = require('crypto');
const { fork } = require('child_process');
const { EventEmitter } = require('events');

const MAX_FILE = 2 * 1024 * 1024;
const ALLOWED_EXT = ['.js', '.json'];
const SAFE_VERSION = /^[0-9A-Za-z][0-9A-Za-z._-]{0,39}$/;
const SAFE_ID = /^[a-z0-9][a-z0-9_-]{0,39}$/;

function safeRelPath(p) {
  if (typeof p !== 'string' || !p || p.length > 120) return false;
  if (p.startsWith('/') || p.includes('\\') || p.includes(':')) return false;
  const parts = p.split('/');
  if (parts.some((x) => !x || x === '.' || x === '..')) return false;
  if (!/^[A-Za-z0-9._\-\/]+$/.test(p)) return false;
  return ALLOWED_EXT.includes(path.extname(p));
}

function validateManifest(m, id) {
  if (!m || typeof m !== 'object') throw new Error('manifest is not an object');
  if (m.id !== id) throw new Error('manifest id does not match');
  if (typeof m.version !== 'string' || !SAFE_VERSION.test(m.version)) throw new Error('bad version');
  if (!Array.isArray(m.files) || m.files.length < 1 || m.files.length > 50) throw new Error('bad file list');
  const names = [];
  m.files.forEach((f) => {
    if (!f || !safeRelPath(f.path)) throw new Error('unsafe file path: ' + (f && f.path));
    if (!/^[0-9a-f]{64}$/.test(f.sha256 || '')) throw new Error('bad sha256 for ' + f.path);
    if (!Number.isInteger(f.size) || f.size < 0 || f.size > MAX_FILE) throw new Error('bad size for ' + f.path);
    names.push(f.path);
  });
  if (!names.includes('server.js') || !names.includes('game.json')) throw new Error('manifest must include server.js and game.json');
  return m;
}

class Beefeater extends EventEmitter {
  /* opts: { registry, dir, games: [ids], pollMs, healthMs, drainMs, basePort, portSpan, bindHost, instancesPerGame,
             hostCli, nodeBin, statusPort, quiet } */
  constructor(opts) {
    super();
    this.opts = Object.assign({
      pollMs: 30000, healthMs: 5000, drainMs: 60000, basePort: 7800, portSpan: 100, bindHost: '0.0.0.0',
      instancesPerGame: 1, hostCli: path.join(__dirname, '..', 'host', 'cli.js'), nodeBin: process.execPath,
      statusPort: 0, quiet: false
    }, opts);
    this.registry = String(this.opts.registry).replace(/\/+$/, '');
    this.dir = path.resolve(this.opts.dir);
    this.games = this.opts.games.slice();
    this.instances = [];
    this.portCounter = 0;
    this.stopping = false;
    this.timers = [];
  }

  log(text) {
    this.emit('log', text);
    if (!this.opts.quiet) console.log('[beefeater] ' + text);
  }

  /* ---------------- files ---------------- */
  gameRoot(id) { return path.join(this.dir, 'games', id); }
  current(id) {
    try { return fs.readFileSync(path.join(this.gameRoot(id), 'current'), 'utf8').trim() || null; } catch (e) { return null; }
  }
  versionDir(id, version) { return path.join(this.gameRoot(id), version); }

  async fetchRaw(url) {
    const res = await fetch(url, { signal: AbortSignal.timeout(10000) });
    if (!res.ok) throw new Error('HTTP ' + res.status + ' for ' + url);
    return Buffer.from(await res.arrayBuffer());
  }

  /* Returns true if a new version was installed. Throws if the registry is unreachable or the bundle is bad. */
  async syncGame(id) {
    if (!SAFE_ID.test(id)) throw new Error('bad game id: ' + id);
    const manifest = validateManifest(JSON.parse((await this.fetchRaw(this.registry + '/' + id + '/manifest.json')).toString('utf8')), id);
    if (manifest.version === this.current(id) && fs.existsSync(this.versionDir(id, manifest.version))) return false;

    const finalDir = this.versionDir(id, manifest.version);
    if (!fs.existsSync(finalDir)) {
      const staging = finalDir + '.staging-' + process.pid + '-' + Date.now();
      fs.mkdirSync(staging, { recursive: true });
      try {
        for (const f of manifest.files) {
          const buf = await this.fetchRaw(this.registry + '/' + id + '/' + manifest.version + '/' + f.path);
          if (buf.length !== f.size) throw new Error('size mismatch for ' + f.path);
          const sum = crypto.createHash('sha256').update(buf).digest('hex');
          if (sum !== f.sha256) throw new Error('checksum mismatch for ' + f.path);
          const out = path.join(staging, f.path);
          fs.mkdirSync(path.dirname(out), { recursive: true });
          fs.writeFileSync(out, buf);
        }
        // the game.json inside the bundle must agree with the manifest
        const gj = JSON.parse(fs.readFileSync(path.join(staging, 'game.json'), 'utf8'));
        if (gj.id !== id || String(gj.version) !== manifest.version) throw new Error('game.json does not match the manifest');
        fs.renameSync(staging, finalDir);
      } catch (e) {
        fs.rmSync(staging, { recursive: true, force: true });
        throw e;
      }
    }
    const tmp = path.join(this.gameRoot(id), 'current.tmp');
    fs.writeFileSync(tmp, manifest.version);
    fs.renameSync(tmp, path.join(this.gameRoot(id), 'current'));
    this.prune(id);
    this.log('deployed ' + id + ' ' + manifest.version);
    this.emit('deployed', id, manifest.version);
    return true;
  }

  prune(id) {
    try {
      const keep = new Set([this.current(id)]);
      this.instances.forEach((i) => { if (i.gameId === id) keep.add(i.version); });
      const dirs = fs.readdirSync(this.gameRoot(id), { withFileTypes: true })
        .filter((d) => d.isDirectory() && !d.name.includes('.staging-'))
        .map((d) => ({ name: d.name, t: fs.statSync(path.join(this.gameRoot(id), d.name)).mtimeMs }))
        .sort((a, b) => b.t - a.t);
      dirs.slice(3).forEach((d) => { if (!keep.has(d.name)) fs.rmSync(path.join(this.gameRoot(id), d.name), { recursive: true, force: true }); });
    } catch (e) { /* pruning is best effort */ }
  }

  /* ---------------- hosts ---------------- */
  nextPort() {
    const p = this.opts.basePort + (this.portCounter++ % this.opts.portSpan);
    return p;
  }

  live(gameId) {
    return this.instances.filter((i) => i.gameId === gameId && i.state !== 'dead');
  }

  spawnInstance(gameId, delayMs, replaces) {
    const version = this.current(gameId);
    if (!version) return null;
    const inst = { gameId, version, port: this.nextPort(), child: null, state: 'starting', startedAt: Date.now(), healthFails: 0, backoff: delayMs || 0, replaces: replaces || null, health: null };
    this.instances.push(inst);
    const launch = () => {
      if (this.stopping || inst.state === 'dead') return;
      const child = fork(this.opts.hostCli, ['--game', this.versionDir(gameId, version), '--port', String(inst.port), '--host', this.opts.bindHost],
        { stdio: ['ignore', 'pipe', 'pipe', 'ipc'], execPath: this.opts.nodeBin });
      inst.child = child;
      inst.startedAt = Date.now();
      let buf = '';
      child.stdout.on('data', (d) => {
        buf += d.toString();
        let i;
        while ((i = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, i).trim();
          buf = buf.slice(i + 1);
          try {
            const m = JSON.parse(line);
            if (m.ghost === 'ready') this.onRunning(inst);
            continue;
          } catch (e) { /* not a status line */ }
          if (line && !this.opts.quiet) console.log('[' + gameId + ':' + inst.port + '] ' + line);
        }
      });
      child.stderr.on('data', (d) => { if (!this.opts.quiet) process.stderr.write('[' + gameId + ':' + inst.port + '] ' + d); });
      child.on('exit', (code, signal) => this.onExit(inst, code, signal));
      child.on('error', (e) => this.log('could not start ' + gameId + ': ' + e.message));
    };
    if (delayMs) setTimeout(launch, delayMs).unref(); else launch();
    return inst;
  }

  onRunning(inst) {
    inst.state = inst.state === 'draining' ? 'draining' : 'running';
    this.log(inst.gameId + ' ' + inst.version + ' running on port ' + inst.port);
    this.emit('instance-running', inst);
    // a replacement is up: now the old one can drain
    if (inst.replaces) { this.drain(inst.replaces); inst.replaces = null; }
  }

  drain(inst) {
    if (inst.state === 'dead' || inst.state === 'draining') return;
    inst.state = 'draining';
    this.log('draining ' + inst.gameId + ' ' + inst.version + ' on port ' + inst.port);
    this.emit('instance-draining', inst);
    try { inst.child.send({ t: 'drain' }); } catch (e) { /* already gone */ }
    inst.drainTimer = setTimeout(() => {
      if (inst.state !== 'dead') { this.log('drain time is up, stopping port ' + inst.port); try { inst.child.kill('SIGKILL'); } catch (e) { /* gone */ } }
    }, this.opts.drainMs);
    inst.drainTimer.unref();
  }

  onExit(inst, code, signal) {
    const wasDraining = inst.state === 'draining';
    clearTimeout(inst.drainTimer);
    const ranFor = Date.now() - inst.startedAt;
    this.log(inst.gameId + ' ' + inst.version + ' on port ' + inst.port + ' exited (' + (signal || code) + ')');
    if (this.stopping || wasDraining || inst.state === 'dead') {
      inst.state = 'dead';
      this.instances = this.instances.filter((i) => i !== inst);
      this.emit('instance-exit', inst, { drained: wasDraining });
      return;
    }
    // unexpected exit: same slot, same game, fresh port, with backoff
    inst.state = 'dead';
    this.instances = this.instances.filter((i) => i !== inst);
    this.emit('instance-exit', inst, { drained: false, crashed: true });
    const next = ranFor > 30000 ? 0 : Math.min(30000, Math.max(1000, (inst.backoff || 500) * 2));
    this.log('restarting ' + inst.gameId + ' in ' + next + 'ms');
    this.spawnInstance(inst.gameId, next).backoff = next;
  }

  /* ---------------- loops ---------------- */
  async syncAll() {
    for (const id of this.games) {
      try {
        const updated = await this.syncGame(id);
        if (updated) this.rollout(id);
      } catch (e) {
        this.log('could not update ' + id + ': ' + e.message);
        this.emit('update-failed', id, e);
      }
    }
  }

  rollout(id) {
    const cur = this.current(id);
    const old = this.live(id).filter((i) => i.version !== cur);
    old.forEach((o) => {
      const fresh = this.spawnInstance(id, 0, o);
      // safety: if the replacement never comes up, drain the old one anyway after a while
      setTimeout(() => { if (fresh && fresh.replaces) { fresh.replaces = null; this.drain(o); } }, 15000).unref();
    });
  }

  fillSlots() {
    for (const id of this.games) {
      if (!this.current(id)) continue;
      const n = this.live(id).filter((i) => i.state !== 'draining').length;
      for (let k = n; k < this.opts.instancesPerGame; k++) this.spawnInstance(id, 0);
    }
  }

  checkHealth() {
    this.instances.forEach((inst) => {
      if (inst.state !== 'running' && inst.state !== 'draining') return;
      const req = http.get({ host: '127.0.0.1', port: inst.port, path: '/health', timeout: 2000 }, (res) => {
        let s = '';
        res.on('data', (d) => (s += d));
        res.on('end', () => { try { inst.health = JSON.parse(s); inst.healthFails = 0; } catch (e) { inst.healthFails++; } });
      });
      const bad = () => {
        inst.healthFails++;
        if (inst.healthFails >= 3 && inst.state !== 'dead') {
          this.log('port ' + inst.port + ' stopped answering, killing it');
          try { inst.child.kill('SIGKILL'); } catch (e) { /* gone */ }
        }
      };
      req.on('timeout', () => { req.destroy(); });
      req.on('error', bad);
    });
  }

  status() {
    return {
      games: this.games.map((id) => ({ id, current: this.current(id) })),
      instances: this.instances.map((i) => ({ gameId: i.gameId, version: i.version, port: i.port, state: i.state, players: i.health ? i.health.players : null, accepting: i.health ? i.health.accepting : null }))
    };
  }

  async start() {
    fs.mkdirSync(path.join(this.dir, 'games'), { recursive: true });
    await this.syncAll();
    this.fillSlots();
    this.timers.push(setInterval(() => { this.syncAll().then(() => this.fillSlots()); }, this.opts.pollMs));
    this.timers.push(setInterval(() => this.checkHealth(), this.opts.healthMs));
    if (this.opts.statusPort) {
      this.statusServer = http.createServer((req, res) => {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify(this.status()));
      }).listen(this.opts.statusPort, '127.0.0.1');
    }
  }

  async stop() {
    this.stopping = true;
    this.timers.forEach(clearInterval);
    if (this.statusServer) this.statusServer.close();
    const waits = this.instances.map((i) => new Promise((resolve) => {
      if (!i.child || i.state === 'dead') return resolve();
      i.child.once('exit', resolve);
      try { i.child.kill('SIGTERM'); } catch (e) { resolve(); }
      setTimeout(() => { try { i.child.kill('SIGKILL'); } catch (e) { /* gone */ } }, 2000).unref();
    }));
    await Promise.all(waits);
  }
}

module.exports = { Beefeater, validateManifest, safeRelPath };
