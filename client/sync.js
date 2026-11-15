/* Fortress Ghost client library: sync.
   Entity replication on top of share. The server spawns entities with sync.spawn(type, props);
   here they show up in sync.entities, with smooth positions for drawing.

     var client = Share.connect({ ... });
     var sync = Sync.attach(client, { delay: 100, interp: ['x', 'y'] });
     sync.on('spawn', function (e) { ... });
     sync.on('destroy', function (e) { ... });
     // every frame:
     sync.step();                       // updates e.rx, e.ry (smoothed copies of x, y)
     for (var id in sync.entities) draw(sync.entities[id]);
   Each entity: { id, type, ownerId, ...your props, rx, ry }
*/
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.Sync = factory();
})(this, function () {
  'use strict';

  function attach(client, opts) {
    opts = opts || {};
    var delay = opts.delay != null ? opts.delay : 100;
    var props = opts.interp || ['x', 'y'];
    var clock = opts.now || function () { return Date.now(); };
    var handlers = {};
    var hist = {};
    var sync = { entities: {}, on: function (n, f) { (handlers[n] = handlers[n] || []).push(f); return sync; }, step: step, mine: mine };

    function emit(name, e) {
      var list = handlers[name] || [], i;
      for (i = 0; i < list.length; i++) {
        try { list[i](e); } catch (err) { if (typeof console !== 'undefined') console.error(err); }
      }
    }

    function mine() {
      var id, e;
      for (id in sync.entities) {
        e = sync.entities[id];
        if (e.ownerId === client.id) return e;
      }
      return null;
    }

    client.on('update', function () {
      var src = client.share.entities || {};
      var now = clock(), id, k, e, view, h, sample;
      for (id in src) {
        e = src[id];
        view = sync.entities[id];
        if (!view) {
          view = sync.entities[id] = {};
          hist[id] = [];
          for (k in e) view[k] = e[k];
          for (k = 0; k < props.length; k++) view['r' + props[k]] = e[props[k]];
          emit('spawn', view);
        } else {
          for (k in e) view[k] = e[k];
        }
        h = hist[id];
        sample = { t: now };
        for (k = 0; k < props.length; k++) sample[props[k]] = e[props[k]];
        h.push(sample);
        if (h.length > 12) h.shift();
      }
      for (id in sync.entities) {
        if (!src[id]) {
          e = sync.entities[id];
          delete sync.entities[id];
          delete hist[id];
          emit('destroy', e);
        }
      }
    });

    function step() {
      var target = clock() - delay, id, h, i, a, b, f, k, key, view;
      for (id in sync.entities) {
        view = sync.entities[id];
        h = hist[id];
        if (!h || !h.length) continue;
        if (h.length === 1 || target <= h[0].t) { a = h[0]; b = h[0]; f = 0; }
        else if (target >= h[h.length - 1].t) { a = h[h.length - 1]; b = a; f = 0; }
        else {
          for (i = 1; i < h.length && h[i].t < target; i++) { /* find the segment */ }
          a = h[i - 1]; b = h[i];
          f = (target - a.t) / Math.max(1, b.t - a.t);
        }
        for (k = 0; k < props.length; k++) {
          key = props[k];
          if (typeof a[key] === 'number' && typeof b[key] === 'number') view['r' + key] = a[key] + (b[key] - a[key]) * f;
          else view['r' + key] = b[key];
        }
      }
    }

    return sync;
  }

  return { attach: attach };
});
