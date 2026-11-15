#!/usr/bin/env node
/* beefeater: node beefeater/cli.js --registry http://registry:8080 --dir ./deployed --games arena,other
   Options: --poll <sec> (30)  --drain <sec> (60)  --base-port <n> (7800)  --status-port <n>  --instances <n> (1) */
'use strict';

const { Beefeater } = require('./agent');

function arg(name, def) {
  const i = process.argv.indexOf('--' + name);
  return i >= 0 && process.argv[i + 1] != null ? process.argv[i + 1] : def;
}

const registry = arg('registry');
const games = String(arg('games', '')).split(',').map((s) => s.trim()).filter(Boolean);
if (!registry || !games.length) {
  console.error('usage: node beefeater/cli.js --registry <url> --dir <folder> --games <id,id>');
  process.exit(1);
}

const agent = new Beefeater({
  registry,
  dir: arg('dir', './deployed'),
  games,
  pollMs: Number(arg('poll', 30)) * 1000,
  drainMs: Number(arg('drain', 60)) * 1000,
  basePort: Number(arg('base-port', 7800)),
  statusPort: Number(arg('status-port', 0)),
  instancesPerGame: Number(arg('instances', 1))
});

agent.start().catch((e) => { console.error('beefeater failed to start: ' + e.message); process.exit(1); });
let closing = false;
['SIGINT', 'SIGTERM'].forEach((s) => process.on(s, async () => {
  if (closing) return;
  closing = true;
  await agent.stop();
  process.exit(0);
}));
