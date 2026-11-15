// Arena: the server half. This runs on the Ghost host, inside the sandbox.
// Globals: share, homes, server, sync, console, ghostHeartbeat, ghostSetIsAcceptingPlayers.
var SPEED = 160;
var SIZE = 24;
var W = 640;
var H = 400;

function clamp(v, a, b) { return Math.max(a, Math.min(b, v)); }
function round1(v) { return Math.round(v * 10) / 10; }

share.round = { players: 0, locked: false };

server.load = function () {
  console.log('arena loaded');
};

server.connect = function (id, info) {
  sync.spawn('player', {
    ownerId: id,
    name: String(info.name || 'Player').slice(0, 16),
    x: round1(60 + Math.random() * (W - 120)),
    y: round1(60 + Math.random() * (H - 120)),
    hue: Math.floor(Math.random() * 360)
  });
  share.round.players = Object.keys(homes).length;
  console.log('player ' + id + ' joined as ' + info.name);
};

server.disconnect = function (id) {
  sync.destroyOwnedBy(id);
  share.round.players = Object.keys(homes).length;
  console.log('player ' + id + ' left');
};

server.update = function (dt) {
  var all = sync.all();
  for (var i = 0; i < all.length; i++) {
    var e = all[i];
    if (e.type !== 'player') continue;
    var home = homes[e.ownerId];
    var input = home && home.input;
    // never trust the client: clamp whatever it sent
    var ix = clamp(Number(input && input.x) || 0, -1, 1);
    var iy = clamp(Number(input && input.y) || 0, -1, 1);
    e.x = round1(clamp(e.x + ix * SPEED * dt, 0, W - SIZE));
    e.y = round1(clamp(e.y + iy * SPEED * dt, 0, H - SIZE));
  }
};

server.receive = function (id, name, data) {
  if (name === 'chat') {
    server.sendAll('chat', { from: id, text: String(data).slice(0, 80) });
  } else if (name === 'lock') {
    // demo: any player may close or open the lobby
    share.round.locked = !!data;
    ghostSetIsAcceptingPlayers(!data);
  }
};
