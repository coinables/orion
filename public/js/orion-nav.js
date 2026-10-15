/*
 * Orion navigation history: the trail of vertices you have focused, with back / forward.
 * Pure data (no DOM). The page mirrors it into location.hash so the browser's own Back / Forward buttons,
 * Alt+Arrow keys and shared links work, and so it also works when the page is opened from disk (file://), where
 * changing the query string with pushState is not allowed.
 *
 *   #f<index>/<vertex id>      e.g.  #f2/tx:0f58c9a7...
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.OrionNav = factory();
}(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var ID_RE = /^(tx|addr|cb|data|ns):[A-Za-z0-9:_-]{1,200}$/;

  function Nav() { this.entries = []; this.index = -1; }

  Nav.prototype.current = function () { return this.index >= 0 ? this.entries[this.index] : null; };
  Nav.prototype.canBack = function () { return this.index > 0; };
  Nav.prototype.canForward = function () { return this.index < this.entries.length - 1; };
  Nav.prototype.reset = function () { this.entries = []; this.index = -1; };

  /** Go somewhere new. Forward history is dropped (as in a browser). Visiting the current place again is a no-op. */
  Nav.prototype.visit = function (id) {
    if (this.current() === id) return false;
    this.entries.length = this.index + 1;
    this.entries.push(id);
    this.index = this.entries.length - 1;
    return true;
  };

  /** Move to an existing entry (history traversal). Returns the id, or null when out of range. */
  Nav.prototype.goto = function (index) {
    if (!(index >= 0 && index < this.entries.length)) return null;
    this.index = index;
    return this.entries[index];
  };

  Nav.toHash = function (index, id) { return '#f' + index + '/' + id; };

  /** '#f3/tx:abc' -> {index:3, id:'tx:abc'}; anything else, including ids with odd characters, -> null. */
  Nav.parseHash = function (hash) {
    var m = /^#f(\d{1,6})\/(.+)$/.exec(String(hash || ''));
    if (!m || !ID_RE.test(m[2])) return null;
    return { index: parseInt(m[1], 10), id: m[2] };
  };

  Nav.isId = function (s) { return ID_RE.test(String(s || '')); };

  return Nav;
}));
