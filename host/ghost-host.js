/* Fortress Ghost host.
   One host = one game session. It owns the network side (WebSockets, limits, health) and keeps the
   creator's server half inside a sandbox worker. It decides who may join, keeps the session alive
   and reports status. */
'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const { EventEmitter } = require('events');
const { Worker } = require('worker_threads');
const { WebSocketServer } = require('ws');

const PROTO = 1;

function loadGame(dir) {
  const config = JSON.parse(fs.readFileSync(path.join(dir, 'game.json'), 'utf8'));
  const serverCode = fs.readFileSync(path.join(dir, 'server.js'), 'utf8');
  return { config, serverCode };
}

class GhostHost extends EventEmitter {
  /* opts: { gameDir | (config, serverCode), port, host, heartbeatTimeoutMs, idleShutdownMs,
             maxMessageBytes, callbackTimeoutMs, memoryLimitMb, quiet } */
  constructor(opts) {
    super();
    this.opts = Object.assign({
      port: 7777, host: '0.0.0.0', heartbeatTimeoutMs: 10000, idleShutdownMs: 0,
      maxMessageBytes: 65536, callbackTimeoutMs: 100, memoryLimitMb: 128, quiet: false
    }, opts);
    const game = opts.gameDir ? loadGame(opts.gameDir) : { config: opts.config, serverCode: opts.serverCode };
    this.config = Object.assign({ id: 'game', name: 'Game', version: '0.0.0', maxPlayers: 8, tickRate: 30, netRate: 20 }, game.config);
    this.serverCode = game.serverCode;

    this.clients = new Map();
    this.nextId = 1;
    this.accepting = true;
    this.draining = false;
    this.stopped = false;
    this.startedAt = Date.now();
    this.lastHeartbeat = Date.now();
    this.emptySince = Date.now();
    this.port = null;
  }

  log(level, text) {
    this.emit('log', level, text);
    if (!this.opts.quiet) console.log('[' + this.config.id + '] ' + (level === 'log' ? '' : level + ': ') + text);
  }

  health() {
    return {
      ok: !this.stopped,
      id: this.config.id, name: this.config.name, version: this.config.version,
      port: this.port, players: this.clients.size, maxPlayers: this.config.maxPlayers,
      accepting: this.isAccepting(), draining: this.draining,
      uptimeMs: Date.now() - this.startedAt,
      lastHeartbeatAgoMs: Date.now() - this.lastHeartbeat
    };
  }

  /* Lets the person running the host open or close the lobby (the server half can do the same). */
  setAccepting(value) {
    this.accepting = !!value;
    this.emit('change');
  }

  playerList() {
    const out = [];
    this.clients.forEach((c) => out.push({ id: c.id, name: c.name }));
    return out;
  }

  isAccepting() { return this.accepting && !this.draining && !this.stopped && this.clients.size < this.config.maxPlayers; }

  start() {
    return new Promise((resolve, reject) => {
      this.http = http.createServer((req, res) => {
        if (req.url === '/health') {
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify(this.health()));
        } else {
          res.writeHead(200, { 'content-type': 'text/plain' });
          res.end('Fortress Ghost host: ' + this.config.name + '\n');
        }
      });
      this.wss = new WebSocketServer({ server: this.http, maxPayload: this.opts.maxMessageBytes });
      this.wss.on('connection', (ws) => this.onConnection(ws));
      this.wss.on('error', () => { /* listen errors are reported through start() */ });

      this.worker = new Worker(path.join(__dirname, 'sandbox-worker.js'), {
        workerData: { serverCode: this.serverCode, config: Object.assign({}, this.config, { callbackTimeoutMs: this.opts.callbackTimeoutMs }) },
        resourceLimits: { maxOldGenerationSizeMb: this.opts.memoryLimitMb, maxYoungGenerationSizeMb: 16, stackSizeMb: 4 }
      });

      let settled = false;
      const fail = (err) => { if (!settled) { settled = true; reject(err); } };
      this._failStart = fail;

      this.worker.on('message', (m) => {
        if (m.t === 'ready' && !settled) {
          this.http.once('error', fail);
          this.http.listen(this.opts.port, this.opts.host, () => {
            this.port = this.http.address().port;
            settled = true;
            this.lastHeartbeat = Date.now();
            this.watchdog = setInterval(() => this.checkWatchdog(), 1000);
            this.emit('listening', this.port);
            resolve(this.port);
          });
          return;
        }
        this.onWorker(m);
      });
      this.worker.on('error', (e) => { fail(e); this.crash('server crashed: ' + e.message); });
      this.worker.on('exit', (code) => { if (!this.stopped) { fail(new Error('worker exited')); this.crash('server stopped unexpectedly (code ' + code + ')'); } });
    });
  }

  /* ---------------- worker -> host ---------------- */
  onWorker(m) {
    switch (m.t) {
      case 'heartbeat': this.lastHeartbeat = Date.now(); break;
      case 'accepting': this.accepting = !!m.value; this.log('log', 'accepting players: ' + this.accepting); this.emit('change'); break;
      case 'log': this.log(m.level, m.text); break;
      case 'broadcast':
        this.clients.forEach((c) => { if (c.synced) this.sendRaw(c, m.msg); });
        break;
      case 'send': {
        const c = this.clients.get(m.to);
        if (!c) break;
        this.sendRaw(c, m.msg);
        if (m.full) c.synced = true;
        break;
      }
      case 'kick': {
        const c = this.clients.get(m.id);
        if (c) this.closeClient(c, m.reason || 'kicked');
        break;
      }
      case 'fatal': this.crash(m.text); break;
    }
  }

  checkWatchdog() {
    if (Date.now() - this.lastHeartbeat > this.opts.heartbeatTimeoutMs) {
      this.log('error', 'no heartbeat from the server half, stopping it');
      this.crash('server unresponsive');
      return;
    }
    const now = Date.now();
    this.clients.forEach((c) => { if (now - c.lastSeen > 15000) this.closeClient(c, 'timeout'); });
    if (this.opts.idleShutdownMs && this.clients.size === 0 && now - this.emptySince > this.opts.idleShutdownMs) this.stop('idle');
  }

  /* ---------------- clients ---------------- */
  sendRaw(c, text) {
    if (c.ws.readyState === 1) c.ws.send(text);
  }

  onConnection(ws) {
    const c = { id: 0, ws, joined: false, synced: false, lastSeen: Date.now(), bucket: 60, bucketAt: Date.now() };
    const helloTimer = setTimeout(() => { if (!c.joined) ws.close(4000, 'hello timeout'); }, 5000);

    ws.on('message', (data, isBinary) => {
      if (isBinary) return ws.close(4001, 'text only');
      c.lastSeen = Date.now();
      // token bucket: about 60 messages per second per client
      const now = Date.now();
      c.bucket = Math.min(120, c.bucket + ((now - c.bucketAt) / 1000) * 60);
      c.bucketAt = now;
      if (--c.bucket < 0) return this.closeClient(c, 'rate_limited');
      let m;
      try { m = JSON.parse(data.toString()); } catch (e) { return this.closeClient(c, 'bad_json'); }
      if (!m || typeof m.t !== 'string') return this.closeClient(c, 'bad_message');
      if (!c.joined) return m.t === 'hello' ? this.onHello(c, m) : this.closeClient(c, 'hello_first');
      this.onClientMessage(c, m);
    });
    ws.on('close', () => {
      clearTimeout(helloTimer);
      if (c.joined && this.clients.get(c.id) === c) {
        this.clients.delete(c.id);
        this.worker.postMessage({ t: 'disconnect', id: c.id });
        if (this.clients.size === 0) this.emptySince = Date.now();
        this.emit('leave', c.id);
        this.emit('change');
        if (this.draining && this.clients.size === 0) this.stop('drained');
      }
    });
    ws.on('error', () => {});
  }

  reject(c, reason) {
    this.sendRaw(c, JSON.stringify({ t: 'reject', reason }));
    c.ws.close(4003, reason);
  }

  onHello(c, m) {
    if (m.proto !== PROTO) return this.reject(c, 'proto_mismatch');
    if (m.gameId && m.gameId !== this.config.id) return this.reject(c, 'wrong_game');
    if (this.draining) return this.reject(c, 'draining');
    if (!this.accepting) return this.reject(c, 'not_accepting');
    if (this.clients.size >= this.config.maxPlayers) return this.reject(c, 'full');
    const name = String(m.name == null ? 'Player' : m.name).replace(/[\u0000-\u001f]/g, '').slice(0, 24) || 'Player';
    c.id = this.nextId++;
    c.name = name;
    c.joined = true;
    this.clients.set(c.id, c);
    this.sendRaw(c, JSON.stringify({
      t: 'welcome', id: c.id, gameId: this.config.id, version: this.config.version,
      maxPlayers: this.config.maxPlayers, netRate: this.config.netRate, proto: PROTO
    }));
    this.worker.postMessage({ t: 'connect', id: c.id, info: { name } });
    this.emit('join', c.id, name);
    this.emit('change');
  }

  onClientMessage(c, m) {
    switch (m.t) {
      case 'home':
        if (Array.isArray(m.ops)) this.worker.postMessage({ t: 'home', id: c.id, ops: m.ops });
        break;
      case 'msg':
        if (typeof m.name === 'string' && m.name.length > 0 && m.name.length <= 32) {
          this.worker.postMessage({ t: 'receive', id: c.id, name: m.name, data: m.data });
        }
        break;
      case 'ping':
        this.sendRaw(c, JSON.stringify({ t: 'pong', ts: m.ts }));
        break;
      case 'resync':
        c.synced = false;
        this.worker.postMessage({ t: 'resync', id: c.id });
        break;
      default:
        break;
    }
  }

  closeClient(c, reason) {
    try { this.sendRaw(c, JSON.stringify({ t: 'closed', reason })); } catch (e) { /* ignore */ }
    try { c.ws.close(4004, String(reason).slice(0, 100)); } catch (e) { /* ignore */ }
  }

  /* ---------------- lifecycle ---------------- */
  drain() {
    if (this.draining || this.stopped) return;
    this.draining = true;
    this.log('log', 'draining: no new players, stopping when empty');
    this.emit('draining');
    if (this.clients.size === 0) this.stop('drained');
  }

  crash(reason) {
    if (this.stopped) return;
    this.log('error', reason);
    this.emit('crash', reason);
    this.stop('crashed: ' + reason);
  }

  stop(reason) {
    if (this.stopped) return Promise.resolve();
    this.stopped = true;
    if (this._failStart) this._failStart(new Error('stopped before it was ready: ' + (reason || 'stopped')));
    clearInterval(this.watchdog);
    this.clients.forEach((c) => this.closeClient(c, 'server_stopping'));
    try { this.worker.postMessage({ t: 'stop' }); } catch (e) { /* ignore */ }
    setTimeout(() => { try { this.worker.terminate(); } catch (e) { /* ignore */ } }, 200).unref();
    return new Promise((resolve) => {
      try { this.wss.close(); } catch (e) { /* ignore */ }
      const done = () => { this.emit('stopped', reason || 'stopped'); resolve(); };
      try { this.http.close(done); this.http.closeAllConnections && this.http.closeAllConnections(); } catch (e) { done(); }
    });
  }
}

module.exports = { GhostHost, loadGame, PROTO };
