/* Fortress Ghost: state diff and patch.
   Runs inside the sandbox (server side) and in the client libraries.
   State is plain JSON objects. Arrays are replaced whole, objects are diffed key by key.
   A patch is a list of ops: [path, value] sets a value, [path] deletes a key. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.Delta = factory();
})(this, function () {
  'use strict';

  var BAD = { '__proto__': 1, 'constructor': 1, 'prototype': 1 };
  var MAX_DEPTH = 12;
  var MAX_KEY = 64;
  var hasOwn = function (o, k) { return Object.prototype.hasOwnProperty.call(o, k); };

  function isObj(v) { return v !== null && typeof v === 'object' && !Array.isArray(v); }
  function validKey(k) { return typeof k === 'string' && k.length > 0 && k.length <= MAX_KEY && !BAD[k]; }
  function present(o, k) { return hasOwn(o, k) && o[k] !== undefined && typeof o[k] !== 'function'; }

  function equal(a, b) {
    if (a === b) return true;
    if (typeof a !== typeof b || a === null || b === null) return a !== a && b !== b;
    if (typeof a !== 'object') return false;
    if (Array.isArray(a) !== Array.isArray(b)) return false;
    var ka = Object.keys(a), kb = Object.keys(b), i;
    if (ka.length !== kb.length) return false;
    for (i = 0; i < ka.length; i++) {
      if (!hasOwn(b, ka[i]) || !equal(a[ka[i]], b[ka[i]])) return false;
    }
    return true;
  }

  function clone(v, depth) {
    var out, k, i;
    depth = depth || 0;
    if (v === null || typeof v !== 'object') return typeof v === 'function' ? undefined : v;
    if (depth > 24) return null;
    if (Array.isArray(v)) {
      out = new Array(v.length);
      for (i = 0; i < v.length; i++) out[i] = clone(v[i], depth + 1);
      return out;
    }
    out = {};
    for (k in v) {
      if (hasOwn(v, k) && validKey(k) && v[k] !== undefined && typeof v[k] !== 'function') out[k] = clone(v[k], depth + 1);
    }
    return out;
  }

  function diff(prev, next, path, ops) {
    var k, a, b;
    path = path || [];
    ops = ops || [];
    for (k in prev) {
      if (!hasOwn(prev, k) || !validKey(k)) continue;
      if (!present(next, k)) ops.push([path.concat(k)]);
    }
    for (k in next) {
      if (!hasOwn(next, k) || !validKey(k) || !present(next, k)) continue;
      b = next[k];
      if (!present(prev, k)) { ops.push([path.concat(k), clone(b)]); continue; }
      a = prev[k];
      if (isObj(a) && isObj(b) && path.length < MAX_DEPTH) diff(a, b, path.concat(k), ops);
      else if (!equal(a, b)) ops.push([path.concat(k), clone(b)]);
    }
    return ops;
  }

  /* Applies ops to state in place. Throws on anything malformed so a bad client can be dropped. */
  function patch(state, ops) {
    var i, j, op, path, node, key, last;
    if (!Array.isArray(ops)) throw new Error('ops must be an array');
    if (ops.length > 4000) throw new Error('too many ops');
    for (i = 0; i < ops.length; i++) {
      op = ops[i];
      if (!Array.isArray(op) || !Array.isArray(op[0])) throw new Error('bad op');
      path = op[0];
      if (path.length === 0 || path.length > MAX_DEPTH + 1) throw new Error('bad path length');
      for (j = 0; j < path.length; j++) if (!validKey(path[j])) throw new Error('bad key');
      node = state;
      for (j = 0; j < path.length - 1; j++) {
        key = path[j];
        if (!hasOwn(node, key) || !isObj(node[key])) {
          if (op.length === 1) { node = null; break; }
          node[key] = {};
        }
        node = node[key];
      }
      if (!node) continue;
      last = path[path.length - 1];
      if (op.length === 1) delete node[last];
      else node[last] = clone(op[1]);
    }
    return state;
  }

  return { diff: diff, patch: patch, clone: clone, equal: equal, isObj: isObj, validKey: validKey };
});
