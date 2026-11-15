/* Fortress Ghost client library: share.
   Connects a game's client half to a Ghost host.

     var client = Share.connect({ url: 'ws://localhost:7777', name: 'Ada', gameId: 'arena' });
     client.on('connect', function (id) { ... });         // first full state received
     client.on('update', function () { ... });            // after every state change
     client.on('message', function (name, data) { ... }); // server.send / server.sendAll
     client.on('reject', function (reason) { ... });      // full, not_accepting, wrong_game, draining ...
     client.on('disconnect', function (reason) { ... });
     client.share   read-only state replicated from the server (do not write to it)
     client.home    your own state; whatever you put here is sent to the server (homes[id] there)
     client.send(name, data)   custom message, arrives in server.receive(id, name, data)
*/
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('../shared/delta'));
  else root.Share = factory(root.Delta);
})(this, function (Delta) {
  'use strict';

  var PROTO = 1;

  function connect(opts) {
    opts = opts || {};
    var WS = opts.WebSocket || (typeof WebSocket !== 'undefined' ? WebSocket : null);
    if (!WS) throw new Error('Share.connect needs a WebSocket (pass opts.WebSocket in Node)');

    var handlers = {};
    var client = {
      id: null, connected: false, ready: false, rtt: 0,
      share: {}, home: {},
      on: function (name, fn) { (handlers[name] = handlers[name] || []).push(fn); return client; },
      send: function (name, data) { if (client.ready) raw({ t: 'msg', name: name, data: data }); },
      close: function () { try { ws.close(); } catch (e) { /* ignore */ } }
    };

    var ws = new WS(opts.url);
    var lastHome = {};
    var lastSeq = null;
    var netRate = 20;
    var homeTimer = null;
    var pingTimer = null;
    var closedReason = null;

    function emit(name, a, b) {
      var list = handlers[name] || [], i;
      for (i = 0; i < list.length; i++) {
        try { list[i](a, b); } catch (e) { if (typeof console !== 'undefined') console.error(e); }
      }
    }

    function raw(obj) {
      if (ws.readyState === 1) ws.send(JSON.stringify(obj));
    }

    function replace(dst, src) {
      var k;
      for (k in dst) delete dst[k];
      for (k in src) dst[k] = src[k];
    }

    function flushHome() {
      var ops = Delta.diff(lastHome, client.home, [], []);
      if (!ops.length) return;
      Delta.patch(lastHome, ops);
      raw({ t: 'home', ops: ops });
    }

    ws.onopen = function () {
      client.connected = true;
      raw({ t: 'hello', proto: PROTO, name: opts.name || 'Player', gameId: opts.gameId || null, version: opts.version || null });
    };

    ws.onmessage = function (ev) {
      var m;
      try { m = JSON.parse(typeof ev.data === 'string' ? ev.data : String(ev.data)); } catch (e) { return; }
      switch (m.t) {
        case 'welcome':
          client.id = m.id;
          client.info = { gameId: m.gameId, version: m.version, maxPlayers: m.maxPlayers };
          netRate = m.netRate || 20;
          homeTimer = setInterval(flushHome, 1000 / netRate);
          pingTimer = setInterval(function () { raw({ t: 'ping', ts: Date.now() }); }, 2000);
          raw({ t: 'ping', ts: Date.now() });
          break;
        case 'full':
          replace(client.share, m.state || {});
          lastSeq = m.seq;
          if (!client.ready) { client.ready = true; emit('connect', client.id); }
          emit('update');
          break;
        case 'patch':
          if (lastSeq !== null && m.seq !== lastSeq + 1) { lastSeq = null; raw({ t: 'resync' }); break; }
          try { Delta.patch(client.share, m.ops); } catch (e) { lastSeq = null; raw({ t: 'resync' }); break; }
          lastSeq = m.seq;
          emit('update');
          break;
        case 'msg': emit('message', m.name, m.data); break;
        case 'pong': client.rtt = Date.now() - m.ts; break;
        case 'reject': closedReason = m.reason; emit('reject', m.reason); break;
        case 'closed': closedReason = m.reason; break;
      }
    };

    ws.onclose = function (ev) {
      clearInterval(homeTimer);
      clearInterval(pingTimer);
      var was = client.connected;
      client.connected = false;
      client.ready = false;
      if (was) emit('disconnect', closedReason || (ev && ev.reason) || 'closed');
    };
    ws.onerror = function () { emit('error', 'connection error'); };

    return client;
  }

  return { connect: connect, PROTO: PROTO };
});
