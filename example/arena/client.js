// Arena: the client half. Runs in the player's window (or any browser).
(function () {
  var params = new URLSearchParams(location.search);
  var url = params.get('url') || 'ws://localhost:7777';
  var name = params.get('name') || 'Player' + Math.floor(Math.random() * 90 + 10);

  var canvas = document.getElementById('c');
  var ctx = canvas.getContext('2d');
  var W = canvas.width, H = canvas.height;

  var client = Share.connect({ url: url, name: name, gameId: 'arena' });
  var sync = Sync.attach(client, { delay: 100, interp: ['x', 'y'] });
  var status = 'connecting...';
  var chat = [];

  client.on('connect', function (id) { status = ''; });
  client.on('reject', function (r) { status = 'rejected: ' + r; });
  client.on('disconnect', function (r) { if (!status) status = 'disconnected: ' + r; });
  client.on('message', function (n, d) {
    if (n === 'chat') { chat.push('#' + d.from + ': ' + d.text); if (chat.length > 5) chat.shift(); }
  });

  var keys = {};
  window.addEventListener('keydown', function (e) {
    keys[e.code] = true;
    if (e.code === 'KeyC') client.send('chat', 'hi from ' + name);
    if (e.code === 'KeyL') client.send('lock', !(client.share.round && client.share.round.locked));
  });
  window.addEventListener('keyup', function (e) { keys[e.code] = false; });

  function input() {
    var x = (keys.ArrowRight || keys.KeyD ? 1 : 0) - (keys.ArrowLeft || keys.KeyA ? 1 : 0);
    var y = (keys.ArrowDown || keys.KeyS ? 1 : 0) - (keys.ArrowUp || keys.KeyW ? 1 : 0);
    client.home.input = { x: x, y: y };
  }

  function draw() {
    input();
    sync.step();
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, W, H);
    ctx.strokeStyle = '#fff';
    ctx.lineWidth = 2;
    ctx.strokeRect(1, 1, W - 2, H - 2);

    var me = sync.mine();
    for (var id in sync.entities) {
      var e = sync.entities[id];
      if (e.type !== 'player') continue;
      ctx.fillStyle = e === me ? '#fff' : '#9a9a9a';
      ctx.fillRect(Math.round(e.rx), Math.round(e.ry), 24, 24);
      ctx.fillStyle = '#000';
      ctx.fillRect(Math.round(e.rx) + 6, Math.round(e.ry) + 7, 4, 6);
      ctx.fillRect(Math.round(e.rx) + 14, Math.round(e.ry) + 7, 4, 6);
      ctx.fillStyle = '#fff';
      ctx.font = '11px Consolas, monospace';
      ctx.textAlign = 'center';
      ctx.fillText(e.name, Math.round(e.rx) + 12, Math.round(e.ry) - 6);
    }

    ctx.textAlign = 'left';
    ctx.font = '12px Consolas, monospace';
    ctx.fillStyle = '#fff';
    var round = client.share.round || {};
    ctx.fillText('PLAYERS ' + (round.players || 0) + '   PING ' + client.rtt + 'ms' + (round.locked ? '   LOBBY LOCKED' : ''), 12, 20);
    ctx.fillStyle = '#8a8a8a';
    ctx.fillText('arrows/WASD move   C chat   L lock lobby', 12, H - 12);
    for (var i = 0; i < chat.length; i++) ctx.fillText(chat[i], 12, 44 + i * 14);
    if (status) { ctx.fillStyle = '#fff'; ctx.textAlign = 'center'; ctx.font = '18px Consolas, monospace'; ctx.fillText(status, W / 2, H / 2); }
    requestAnimationFrame(draw);
  }
  draw();
})();
