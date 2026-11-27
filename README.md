# Ghost

**Ghost server for Fortress Games.**

Ghost is the online side of Fortress. A multiplayer game ships two halves:

- a **client half** that runs on the player's machine (`client.js`)
- a **server half** that runs on a Ghost machine, inside a sandbox, because it is arbitrary creator code (`server.js`)

The server half owns the game state. Ghost connects the players, keeps the session alive, and a small agent called **beefeater** (`fortress-server-agent`) keeps the deployed servers up to date.

> This first version is written in **JavaScript** and uses **WebSockets**. Creator code (the server half) is JavaScript too. The transport is isolated in one place (`host/ghost-host.js` and `client/share.js`), so ENet/UDP can be swapped in later.

## Try it

You need **Node.js 18 or newer**.

```
npm install
npm run host      # starts the Arena example on port 7777
npm test          # host, sandbox attack and beefeater tests
```

Then open `example/arena/index.html` in a browser, twice, in two windows. Move with arrows or WASD, press `C` to chat, `L` to lock or unlock the lobby.

`npm run host` is the same as `node host/cli.js --game example/arena --port 7777`. Point `--game` at any folder that has a `game.json` and a `server.js`.

## The pieces

```
ghost/
  shared/delta.js        state diff and patch (used on both sides)
  host/ghost-host.js     one host = one game session: sockets, limits, health, lifecycle
  host/sandbox-worker.js worker thread that runs the creator's server.js in a locked vm context
  host/runtime.js        the server runtime INSIDE the sandbox: share, homes, server, sync, ghost* calls
  host/cli.js            starts a host for a game folder
  client/share.js        client library: connect, replicated state, home state, messages
  client/sync.js         client library: entity replication with smoothing
  beefeater/agent.js     the deploy agent (fortress-server-agent)
  beefeater/publish.js   publishes a game's server half to a registry
  beefeater/cli.js       runs the agent
  example/arena/         a small working game: game.json, server.js, client.js, index.html
  tests/                 run.js (host + sandbox) and beefeater.js (deploy agent)
```

## Writing a multiplayer game

A game folder has `game.json` (`id`, `name`, `version`, `maxPlayers`, `tickRate`, `netRate`) and `server.js`.

### Server half (`server.js`, runs in the sandbox)

Globals you get:

| Global | What it is |
| --- | --- |
| `share` | State replicated to every client. Change it freely; Ghost sends only the differences. |
| `homes` | `homes[clientId]` is state that client wrote into its `client.home`. Treat it as untrusted input. |
| `server` | Assign `server.load`, `connect(id, info)`, `disconnect(id)`, `update(dt)`, `receive(id, name, data)`. Call `server.send(id, name, data)`, `server.sendAll(name, data)`, `server.kick(id, reason)`. |
| `sync` | `sync.spawn(type, props)`, `sync.destroy(id)`, `sync.get(id)`, `sync.all()`, `sync.destroyOwnedBy(clientId)`. Entities live in `share.entities`. |
| `ghostHeartbeat()` | Tells Ghost the session is alive. The runtime also does this on every tick on its own. |
| `ghostSetIsAcceptingPlayers(bool)` | Open or close the lobby. While closed, new players are turned away and the host reports `accepting: false`. |
| `console` | `log`, `warn`, `error` go to the host log. |

There are no timers, no `require`, no `eval`, no network and no file access. Use `server.update(dt)` for time.

### Client half

```js
var client = Share.connect({ url: 'ws://host:7777', name: 'Ada', gameId: 'arena' });
var sync = Sync.attach(client, { delay: 100, interp: ['x', 'y'] });

client.on('connect', function (id) { });             // first full state arrived
client.on('update', function () { });                // after every change
client.on('message', function (name, data) { });     // from server.send / sendAll
client.on('reject', function (reason) { });          // full, not_accepting, wrong_game, draining
client.on('disconnect', function (reason) { });

client.home.input = { x: 1, y: 0 };                  // goes to homes[yourId].input on the server
client.send('chat', 'hello');                        // arrives in server.receive(id, 'chat', 'hello')

// every frame
sync.step();
for (var id in sync.entities) { var e = sync.entities[id]; draw(e.rx, e.ry); }
```

`client.share` is read-only. In a browser, load `shared/delta.js`, `client/share.js`, `client/sync.js` in that order. If the page that loads the client has a Content-Security-Policy, it must allow `connect-src ws:` (or `wss:`) for the socket to open.

## How a session works

1. The client opens a WebSocket and says `hello` (protocol version, name, game id).
2. The host checks: right game, not draining, accepting, not full. Otherwise it answers `reject` with the reason.
3. The host sends `welcome`, tells the sandbox `server.connect`, and the client gets a `full` snapshot.
4. From then on the server sends small `patch` messages at `netRate`. Every patch has a sequence number; if a client notices a gap it asks for a fresh snapshot (`resync`).
5. The client sends its `home` changes at `netRate`, plus custom messages.
6. The host keeps a **heartbeat watchdog**: if the sandbox stops heartbeating for 10 seconds, the session is shut down. `GET /health` reports players, accepting, draining and heartbeat age, so beefeater (or a lobby service) can route players. When you embed a host in your own program, `host.setAccepting(bool)` opens or closes the lobby from the outside, `host.playerList()` lists who is connected, and the host emits `change` whenever that changes.

## Beefeater (fortress-server-agent)

```
node beefeater/publish.js example/arena ./registry         # publish a game version
node beefeater/cli.js --registry http://registry:8080 --dir ./deployed --games arena
```

What it does, on every Ghost machine:

- Polls `<registry>/<game>/manifest.json`. A new version is downloaded into a staging folder, every file is checked against its sha256 and size, `game.json` must match the manifest, and only then is it swapped in. File paths must be plain relative `.js` / `.json` files (no `..`, no absolute paths).
- **Rolls out without kicking anyone:** it starts a host on the new version, then tells the old host to *drain* (no new players, exits when the last player leaves, or after `--drain` seconds).
- **Supervises:** a host that crashes is restarted with backoff; a host whose `/health` stops answering three times in a row is killed and restarted.
- Publishing an older version number rolls back the same way.

## Security: what this does and does not give you

Done in this version:

- Creator code runs in a **worker thread** (own memory limit, killable) in a **separate vm context** with `eval` and `new Function` disabled. No object from the host side is ever handed into the context; the only bridge is one function that takes and returns strings. Constructor-chain escapes (`share.constructor.constructor(...)`) are tested and blocked.
- Every call into creator code has a **time limit** (100 ms). Repeated timeouts end the session. The host also kills a silent sandbox (heartbeat watchdog) and a runaway memory hog (worker memory limit). All of this is covered by tests.
- Clients are untrusted: message size limit, per-client rate limit, text frames only, hello required first, and patches reject `__proto__` / `constructor` / `prototype` keys so nobody can pollute prototypes.

Not done, and you should not skip it before running other people's code on shared machines:

- **Node's `vm` is not a hardened security boundary** (Node's own docs say so). Run each host in a container or as a locked-down OS user with **no network egress** and no access to anything but its game folder. This is an infrastructure step, not a code step.
- Beefeater trusts its registry URL. Serve the registry over HTTPS and sign manifests before opening it to third-party creators.

## What is not built yet

- Matchmaking / a lobby service (what players ask to find a host with `accepting: true`).
- A way to run a game's simulation headless inside the sandbox without writing the server half by hand. Today, server halves are hand-written like `example/arena/server.js`.
- Clients for other platforms (only the browser/Node client exists).
- UDP/ENet transport (WebSocket is TCP, so one lost packet briefly stalls the stream).

## License

MIT, see `LICENSE`.
