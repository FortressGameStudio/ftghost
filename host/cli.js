#!/usr/bin/env node
/* Starts one Ghost host for a game folder.
   node host/cli.js --game example/arena --port 7777 [--host 0.0.0.0] [--idle-shutdown 300] [--heartbeat-timeout 10]
   Prints one JSON line when ready. If started by beefeater (has an IPC channel) it also listens for { t: 'drain' }. */
'use strict';

const path = require('path');
const { GhostHost } = require('./ghost-host');

function arg(name, def) {
  const i = process.argv.indexOf('--' + name);
  return i >= 0 && process.argv[i + 1] != null ? process.argv[i + 1] : def;
}

const gameDir = path.resolve(arg('game', '.'));
const host = new GhostHost({
  gameDir,
  port: Number(arg('port', 7777)),
  host: arg('host', '0.0.0.0'),
  idleShutdownMs: Number(arg('idle-shutdown', 0)) * 1000,
  heartbeatTimeoutMs: Number(arg('heartbeat-timeout', 10)) * 1000
});

host.on('listening', (port) => {
  console.log(JSON.stringify({ ghost: 'ready', port, gameId: host.config.id, version: host.config.version }));
});
host.on('crash', () => { process.exitCode = 2; });
host.on('stopped', () => setTimeout(() => process.exit(process.exitCode || 0), 100));

host.start().catch((err) => {
  console.error('could not start: ' + err.message);
  process.exit(3);
});

process.on('message', (m) => { if (m && m.t === 'drain') host.drain(); });
['SIGINT', 'SIGTERM'].forEach((s) => process.on(s, () => host.stop('signal')));
