#!/usr/bin/env node
/* Publishes a game's server half to a registry folder that beefeater can pull from.
   node beefeater/publish.js <gameDir> <registryDir>
   Writes <registry>/<id>/<version>/{game.json,server.js} first, and manifest.json LAST,
   so an agent never sees a manifest that points at missing files. */
'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

function publish(gameDir, registryDir) {
  const gameJson = fs.readFileSync(path.join(gameDir, 'game.json'));
  const cfg = JSON.parse(gameJson.toString('utf8'));
  if (!cfg.id || !cfg.version) throw new Error('game.json needs "id" and "version"');
  const files = ['game.json', 'server.js'];
  const outDir = path.join(registryDir, cfg.id, String(cfg.version));
  fs.mkdirSync(outDir, { recursive: true });
  const entries = files.map((f) => {
    const buf = fs.readFileSync(path.join(gameDir, f));
    fs.writeFileSync(path.join(outDir, f), buf);
    return { path: f, sha256: crypto.createHash('sha256').update(buf).digest('hex'), size: buf.length };
  });
  const manifest = { id: cfg.id, version: String(cfg.version), files: entries, publishedAt: new Date().toISOString() };
  const tmp = path.join(registryDir, cfg.id, 'manifest.tmp');
  fs.writeFileSync(tmp, JSON.stringify(manifest, null, 2));
  fs.renameSync(tmp, path.join(registryDir, cfg.id, 'manifest.json'));
  return manifest;
}

if (require.main === module) {
  const [gameDir, registryDir] = process.argv.slice(2);
  if (!gameDir || !registryDir) { console.error('usage: node beefeater/publish.js <gameDir> <registryDir>'); process.exit(1); }
  const m = publish(path.resolve(gameDir), path.resolve(registryDir));
  console.log('published ' + m.id + ' ' + m.version);
}

module.exports = { publish };
