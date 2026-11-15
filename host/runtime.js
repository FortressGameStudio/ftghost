/* Fortress Ghost: the server runtime.
   This function is turned into text and evaluated INSIDE the sandbox context, so it must not
   reference anything outside itself. It only talks to the host through hostCall(name, jsonString).

   What a creator's server.js sees as globals:
     share     state replicated to every client (read it on the client as client.share)
     homes     homes[clientId] is state written by that client (client.home), read-only to trust
     server    assign server.load / connect / disconnect / update / receive; call server.send, sendAll, kick
     sync      sync.spawn(type, props), sync.destroy(id), sync.get(id), sync.all(), sync.destroyOwnedBy(id)
     console   log / warn / error (forwarded to the host log)
     ghostHeartbeat(), ghostSetIsAcceptingPlayers(bool)
*/
module.exports = function runtime(hostCall, Delta) {
  'use strict';

  var g = globalThis;
  var MAX_MSG = 16384;
  var MAX_ENTITIES = 2000;

  var share = {};
  var homes = {};
  var server = {};
  var lastSent = {};
  var seq = 0;
  var entityCounter = 0;

  function call(name, payload) {
    var json = payload === undefined ? '' : JSON.stringify(payload);
    if (json && json.length > MAX_MSG) throw new Error('payload too large (' + name + ')');
    hostCall(name, json);
  }

  function text(args) {
    var out = [], i, v;
    for (i = 0; i < args.length; i++) {
      v = args[i];
      if (typeof v === 'string') out.push(v);
      else { try { out.push(JSON.stringify(v)); } catch (e) { out.push(String(v)); } }
    }
    return out.join(' ').slice(0, 500);
  }

  var consoleObj = {
    log: function () { call('log', { level: 'log', text: text(arguments) }); },
    warn: function () { call('log', { level: 'warn', text: text(arguments) }); },
    error: function () { call('log', { level: 'error', text: text(arguments) }); }
  };

  function safe(label, fn) {
    try { return fn(); } catch (e) {
      try { call('log', { level: 'error', text: label + ': ' + String(e && e.message ? e.message : e).slice(0, 300) }); } catch (e2) { /* ignore */ }
    }
  }

  function checkName(name) {
    if (typeof name !== 'string' || name.length === 0 || name.length > 32) throw new Error('message name must be a string up to 32 characters');
  }

  server.send = function (clientId, name, data) {
    checkName(name);
    call('send', { to: Number(clientId), name: name, data: data });
  };
  server.sendAll = function (name, data) {
    checkName(name);
    call('broadcastMsg', { name: name, data: data });
  };
  server.kick = function (clientId, reason) {
    call('kick', { id: Number(clientId), reason: String(reason || 'kicked').slice(0, 60) });
  };

  /* ---- entity replication (server side of sync) ---- */
  share.entities = {};
  var sync = {
    spawn: function (type, props) {
      if (typeof type !== 'string' || !type) throw new Error('sync.spawn needs a type');
      if (Object.keys(share.entities).length >= MAX_ENTITIES) throw new Error('too many entities');
      var id = 'e' + (++entityCounter);
      var e = { id: id, type: type };
      var k;
      if (props) for (k in props) { if (k !== 'id' && k !== 'type') e[k] = props[k]; }
      share.entities[id] = e;
      return e;
    },
    destroy: function (id) { delete share.entities[id]; },
    get: function (id) { return share.entities[id] || null; },
    all: function () {
      var out = [], k;
      for (k in share.entities) out.push(share.entities[k]);
      return out;
    },
    destroyOwnedBy: function (clientId) {
      var k;
      for (k in share.entities) if (share.entities[k].ownerId === clientId) delete share.entities[k];
    }
  };

  function def(name, value) {
    Object.defineProperty(g, name, { value: value, writable: false, configurable: false, enumerable: true });
  }
  def('share', share);
  def('homes', homes);
  def('server', server);
  def('sync', sync);
  def('console', consoleObj);
  def('ghostHeartbeat', function () { call('heartbeat'); });
  def('ghostSetIsAcceptingPlayers', function (accepting) { call('accepting', !!accepting); });

  /* ---- called by the host through vm scripts (so every call has a time limit) ---- */
  function flush() {
    var ops = Delta.diff(lastSent, share, [], []);
    if (!ops.length) return '';
    Delta.patch(lastSent, ops);
    seq += 1;
    return JSON.stringify({ t: 'patch', seq: seq, ops: ops });
  }

  function full() {
    return JSON.stringify({ t: 'full', seq: seq, state: lastSent });
  }

  var rt = {
    start: function () {
      safe('server.load', function () { if (typeof server.load === 'function') server.load(); });
      return flush();
    },
    update: function (dt) {
      safe('server.update', function () { if (typeof server.update === 'function') server.update(Number(dt) || 0); });
      return '';
    },
    flush: flush,
    connect: function (id, info) {
      var pre = flush();
      homes[id] = {};
      safe('server.connect', function () { if (typeof server.connect === 'function') server.connect(id, info || {}); });
      var post = flush();
      return JSON.stringify({ pre: pre, post: post, full: full() });
    },
    resync: function () {
      var pre = flush();
      return JSON.stringify({ pre: pre, post: '', full: full() });
    },
    disconnect: function (id) {
      safe('server.disconnect', function () { if (typeof server.disconnect === 'function') server.disconnect(id); });
      delete homes[id];
      return '';
    },
    receive: function (id, name, data) {
      safe('server.receive', function () { if (typeof server.receive === 'function') server.receive(id, name, data); });
      return '';
    },
    home: function (id, ops) {
      safe('home patch', function () { if (homes[id]) Delta.patch(homes[id], ops); });
      return '';
    }
  };

  Object.defineProperty(g, '__rt', { value: rt, writable: false, configurable: false, enumerable: false });
  return true;
};
