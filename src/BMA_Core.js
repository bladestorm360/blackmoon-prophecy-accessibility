//=============================================================================
// BMA_Core.js — Blackmoon Prophecy Accessibility: core layer
//
// Provides the global BMA namespace: configuration, in-process TTS (Tolk addon with
// Web Speech fallback), the speech facade, the Web Audio cue engine, input dispatch,
// small text/geometry utilities, and settings persistence.
//
// Loaded last (appended to plugins.js) so it wraps the final versions of every method.
// Everything is defensive: no TTS, no addon, or no audio must ever crash the game.
//=============================================================================

var BMA = BMA || {};

(function () {
'use strict';

// Node bits (node integration is on in this NW.js build).
var nodeRequire = (typeof require === 'function') ? require : null;
var fs = null, pathMod = null;
try { fs = nodeRequire('fs'); pathMod = nodeRequire('path'); } catch (e) { /* non-node */ }

//-----------------------------------------------------------------------------
// Config — all tunables in one place for single-line test edits.
//-----------------------------------------------------------------------------
BMA.Config = {
  // Speech
  speechEnabled: true,
  verbosity: 'normal',            // 'terse' | 'normal' | 'verbose'

  // Toggles (FF1 parity; each independent, persisted)
  footsteps: true,
  wallTones: true,
  beacon: false,
  pathFilter: false,              // hide unreachable destinations while cycling
  autodetail: false,              // read item/spell detail on cycle vs. on request
  wallTonesContinuous: false,     // false = play on turn/step; true = sustain while blocked
  announceMapEntry: true,         // speak "Entering <map>" on a map change
  menuIndex: true,                // append "3 of 12" to menu selections
  airshipLanding: true,           // in the airship, say when the ground below becomes landable
  // Both default ON. A log written with them off holds the boot sequence and nothing else — about
  // ten lines, ending at "boot: mod initialized" — so a player who hits something and sends their
  // log has sent no evidence at all, and the only way to get any is to ask them to go back, turn
  // these on and do it again. That round trip has cost more than the logging ever will: the
  // transcript is a few hundred KB a session, and the perf counters only wrap calls the mod was
  // already making. Off is the wrong default for a diagnostic.
  perfLog: true,                  // periodically log where the mod spends main-thread time
  speechLog: true,                // write every utterance to bma_log.txt for diagnosis

  // Which navigation keyset responds. The two sets are mutually exclusive so nothing is
  // double-bound; see BMA.Config.keys below.
  //   'classic'  — j prev, l next, k announce, p directions
  //   'bracket'  — [ prev, ] next, p announce, \ directions
  //   'lefthand' — a prev, d next, s announce, f directions
  navKeyset: 'lefthand',           // default on a fresh install; existing saves keep their choice

  // Per-sound gains (0..2), mirrors FF1 mod menu; each rides SE volume.
  // Wall tones sit under the game's own music and effects, so they run hot by default.
  vol: { footstep: 1.0, wallTone: 2.0, wallBump: 1.0, beacon: 1.0 },

  // Navigation
  scanRadius: 256,                // covers the largest map (256x255)
  beaconIntervalFar: 900,         // ms between beacon pings when far (slowest)
  beaconIntervalNear: 180,        // ms between pings when close (fastest)
  beaconFastTiles: 2,             // at/inside this many steps the beeps hit max rate
  beaconFarTiles: 30,             // at/beyond this many steps the beeps are slowest

  // Muted categories (speech). e.g. {'nav': true}
  mutedCategories: {},

  // Keybindings: action -> {key, shift, ctrl, alt}. key is a lowercase KeyboardEvent.key
  // or a code label. Rebindable and persisted.
  keys: {
    prevDest:      { key: 'j' },
    nextDest:      { key: 'l' },
    prevCategory:  { key: 'j', shift: true },
    nextCategory:  { key: 'l', shift: true },
    // 'directions' is the p key in both sets; its handler branches on navKeyset so that
    // p gives directions in classic mode and re-announces the selection in bracket mode.
    directions:    { key: 'p' },
    prevDestAlt:   { key: '[' },
    nextDestAlt:   { key: ']' },
    prevCategoryAlt:{ key: '[', shift: true },
    nextCategoryAlt:{ key: ']', shift: true },
    directionsAlt: { key: '\\' },
    togglePathFilter:{ key: 'p', shift: true },
    togglePathFilterAlt:{ key: '\\', shift: true },
    // Custom labeller: the freed layer-filter slot. p-family in classic, \-family in bracket.
    customLabel:   { key: 'p', ctrl: true },
    customLabelAlt:{ key: '\\', ctrl: true },
    // Left-handed keyset (a/s/d/f): a/d cycle destinations, s announces, f gives directions;
    // shift/ctrl on f toggle the path filter and the labeller. shift+s resets the category.
    prevDestLh:     { key: 'a' },
    nextDestLh:     { key: 'd' },
    prevCategoryLh: { key: 'a', shift: true },
    nextCategoryLh: { key: 'd', shift: true },
    reannounceLh:   { key: 's' },
    directionsLh:   { key: 'f' },
    togglePathFilterLh:{ key: 'f', shift: true },
    customLabelLh:  { key: 'f', ctrl: true },
    resetCategoryLh:{ key: 's', shift: true },
    reannounce:    { key: 'k' },
    rescan:        { key: '`' },
    resetCategory: { key: 'k', shift: true },     // classic keyset only
    resetCategoryAlt:{ key: 'p', shift: true },   // bracket keyset only (shift on its announce key)
    toggleFootsteps:{ key: '\'' },
    toggleWallTones:{ key: ';' },
    toggleBeacon:  { key: 'f6' },
    announceMap:   { key: 'm' },
    toggleAutodetail:{ key: 'f7' },
    modMenu:       { key: 'f8' },
    readDetail:    { key: 'i' },
    usableBy:      { key: 'u' },
    reviewBuffer:  { key: 'v', shift: true },
    repeat:        { key: 'r' },     // re-read the on-screen text panel (dialogue/message/pop-up)
    announceGil:   { key: 'g' },     // total party gil; field + shop only
    readVitals:    { key: 'h' },     // active party member's vitals; battle only
    silence:       { key: 'control' },
    // waypoints
    prevWaypoint:  { key: ',' },
    nextWaypoint:  { key: '.' },
    prevWaypointCat:{ key: ',', shift: true },
    nextWaypointCat:{ key: '.', shift: true },
    pathfindWaypoint:{ key: '/' },
    addWaypoint:   { key: '/', shift: true },
  },
};

//-----------------------------------------------------------------------------
// Utilities
//-----------------------------------------------------------------------------
BMA.Util = {
  // Strip MV/YEP presentation escape codes, expanding \v[n]/\n[n] first via the engine.
  cleanText: function (text) {
    if (text == null) return '';
    text = String(text);
    // Self-contained escape-code handling. allText() delivers codes as LITERAL
    // backslashes (\C[3]); post-draw text may use the \x1b control char. Handle both,
    // so this never depends on the engine's convertEscapeCharacters (which throws under
    // YEP when called outside a live window). [\x1b\\] matches either form.
    var esc = '[\\x1b\\\\]';
    function rx(body, flags) { return new RegExp(esc + body, flags || 'g'); }

    // Expand value/name codes first so their content is spoken.
    text = text.replace(rx('V\\[(\\d+)\\]', 'gi'), function (_, n) {
      try { return String($gameVariables.value(Number(n))); } catch (e) { return ''; } });
    text = text.replace(rx('N\\[(\\d+)\\]', 'gi'), function (_, n) {
      try { var a = $gameActors.actor(Number(n)); return a ? a.name() : ''; } catch (e) { return ''; } });
    text = text.replace(rx('P\\[(\\d+)\\]', 'gi'), function (_, n) {
      try { var a = $gameParty.members()[Number(n) - 1]; return a ? a.name() : ''; } catch (e) { return ''; } });
    // \G is the currency unit ("18 \G found!" -> "18 Gil found!"). The engine converts it to
    // TextManager.currencyUnit, so speech must too — stripping it dropped "Gil" from reward text.
    text = text.replace(rx('G', 'gi'), function () {
      try { return String(TextManager.currencyUnit); } catch (e) { return ''; } });

    // Strip presentation codes with a bracketed argument: \C[n] \I[n] \FS[n] \OC[n] ...
    text = text.replace(rx('[A-Za-z]+\\[\\d+\\]', 'gi'), '');
    // Strip single-char control codes: \{ \} \$ \. \| \^ \! \< \> \\ (and \x1b forms). (\G is
    // converted above, not stripped.)
    text = text.replace(rx('[\\{\\}\\$\\.\\|\\^!<>\\\\]'), '');
    // Strip YEP inline tags like <WordWrap>, <br>, <center>, </...>.
    text = text.replace(/<\/?[A-Za-z][^>]*>/g, '');
    // Any leftover control char.
    text = text.replace(/\x1b/g, '');
    text = text.replace(/[\r\n]+/g, ' ').replace(/\s+/g, ' ').trim();
    // Decorative framing dashes — this game labels an empty party slot "- Empty -", which a
    // reader would otherwise announce with the dashes.
    text = text.replace(/^[\s\-–—=~*]+/, '').replace(/[\s\-–—=~*]+$/, '');
    return text;
  },

  // 8-way compass name from dx,dy in tiles (screen coords: +y is down/south).
  compass: function (dx, dy) {
    if (dx === 0 && dy === 0) return 'here';
    var ang = Math.atan2(dx, -dy) * 180 / Math.PI;   // 0 = north, cw
    if (ang < 0) ang += 360;
    var names = ['north','northeast','east','southeast','south','southwest','west','northwest'];
    return names[Math.round(ang / 45) % 8];
  },

  // Chebyshev distance — straight-line "as the crow flies", NOT walking distance. Movement is
  // 4-directional, so a target 5 east and 5 south is 5 by this measure and a 10-step walk. Fine
  // for bearings, sort order and the beacon; anything announcing a step count should prefer the
  // real path length from BMA.Nav.pathTiles.
  tileDist: function (dx, dy) { return Math.max(Math.abs(dx), Math.abs(dy)); },

  pluralSteps: function (n) { return n === 1 ? '1 step' : n + ' steps'; },

  // Stitch captured window fragments back into a line WITHOUT inventing punctuation.
  // MV draws a status row as separate drawText calls — 'Vahn','Lv','1','HP','150','/','150' —
  // so joining on '. ' produced "Vahn. Lv. 1. HP. 150. /. 150". Join on a single space, but
  // glue punctuation-only fragments to their neighbours so "150/150" survives intact.
  joinParts: function (parts) {
    var out = '', prevGlue = false;
    for (var i = 0; i < (parts || []).length; i++) {
      var p = parts[i];
      if (p == null) continue;
      p = String(p).replace(/\s+/g, ' ').trim();
      if (!p) continue;
      // Drop the trailing dot on short abbreviation labels ("Lv." -> "Lv"), leaving real
      // sentences alone.
      if (/^[A-Za-z]{1,4}\.$/.test(p)) p = p.slice(0, -1);
      // A fragment that is nothing but punctuation binds to both neighbours, so the
      // separately-drawn '150','/','150' becomes "150/150". A label that merely ends in
      // punctuation ("Weapon:") does not — that still wants "Weapon: Spear".
      var glue = /^[\/:%\-–]+$/.test(p);
      if (!out || glue || prevGlue) out += p;
      else out += ' ' + p;
      prevGlue = glue;
    }
    return out.replace(/\s+/g, ' ').trim();
  },

  // "150 Gil" — the game's own currency term, never a hardcoded word. describeItem used to say
  // "gold" while the g key said TextManager.currencyUnit ("Gil" here), so the same number was
  // read two different ways depending on which key you pressed. Both come through here now.
  currency: function (n) {
    var unit = '';
    try { unit = String(TextManager.currencyUnit || ''); } catch (e) {}
    return unit ? (n + ' ' + unit) : String(n);
  },
};

//-----------------------------------------------------------------------------
// Diagnostic logging — synchronous file writes so even a hard native crash
// leaves the last line on disk. Writes to <modDir>/bma_log.txt.
//-----------------------------------------------------------------------------
BMA.Log = {
  path: null,
  _n: 0,

  _resolveDir: function () {
    try {
      if (pathMod && process && process.mainModule) {
        return pathMod.join(pathMod.dirname(process.mainModule.filename), 'mod');
      }
    } catch (e) {}
    try { if (process && process.cwd) return process.cwd(); } catch (e) {}
    return null;
  },

  // How many past sessions survive in logs/. Twenty is enough to cover a week of play
  // without the folder becoming its own navigation problem.
  KEEP: 20,

  // Stamp a filename from a Date, local time, sortable: bma_log_20260728-144912.txt.
  _stamp: function (d) {
    function p(n) { return (n < 10 ? '0' : '') + n; }
    return String(d.getFullYear()) + p(d.getMonth() + 1) + p(d.getDate()) + '-' +
           p(d.getHours()) + p(d.getMinutes()) + p(d.getSeconds());
  },

  // Move the previous session's log aside and drop the oldest once there are more than KEEP.
  //
  // The log used to be truncated on every boot, which meant a crash — or any restart before
  // the log was read — destroyed the very session worth looking at. Twice during the Conall
  // Curach diagnosis the evidence went that way.
  //
  // The archive is stamped from the OLD FILE'S mtime, not from now: that names the session the
  // file actually holds rather than the moment it was rotated out.
  _rotate: function (dir, live) {
    var logs = pathMod.join(dir, 'logs');
    if (!fs.existsSync(live)) return;                      // nothing to keep yet
    if (!fs.existsSync(logs)) fs.mkdirSync(logs, { recursive: true });

    try {
      if (fs.statSync(live).size > 0) {
        var when = this._stamp(new Date(fs.statSync(live).mtimeMs));
        var dest = pathMod.join(logs, 'bma_log_' + when + '.txt');
        // Two sessions inside one second, or a rotation that already happened: don't clobber.
        for (var n = 2; fs.existsSync(dest) && n < 100; n++) {
          dest = pathMod.join(logs, 'bma_log_' + when + '-' + n + '.txt');
        }
        fs.renameSync(live, dest);
      }
    } catch (e) { /* an unreadable or locked previous log must not stop this one starting */ }

    // The stamp sorts lexicographically, so plain name order is chronological order.
    try {
      var kept = fs.readdirSync(logs).filter(function (f) {
        return /^bma_log_\d{8}-\d{6}(-\d+)?\.txt$/.test(f);
      }).sort();
      for (var i = 0; i < kept.length - this.KEEP; i++) {
        try { fs.unlinkSync(pathMod.join(logs, kept[i])); } catch (e2) {}
      }
    } catch (e3) {}

    // Named so that finding twenty unfamiliar files in a screen reader explains itself.
    try {
      var readme = pathMod.join(logs, 'README.txt');
      if (!fs.existsSync(readme)) {
        fs.writeFileSync(readme,
          'Blackmoon Accessibility - past session logs.\r\n\r\n' +
          'The log for the session running now is one folder up, in bma_log.txt.\r\n' +
          'When the game starts, that file is moved in here and named for when it was\r\n' +
          'written: bma_log_YYYYMMDD-HHMMSS.txt. The ' + this.KEEP + ' most recent are kept\r\n' +
          'and older ones are deleted automatically.\r\n\r\n' +
          'Nothing in here is needed to play. It is safe to delete any of it.\r\n');
      }
    } catch (e4) {}
  },

  init: function () {
    if (!fs || !pathMod) return;
    try {
      var dir = this._resolveDir();
      if (!dir) return;
      try { if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true }); } catch (e) {}
      this.path = pathMod.join(dir, 'bma_log.txt');
      // Archive the previous session before starting a fresh file. Rotation is best-effort:
      // a read-only or full disk still has to leave the mod bootable.
      try { this._rotate(dir, this.path); } catch (e) {}
      fs.writeFileSync(this.path, '');
      this.write('=== BMA log start ===');
      this.write('mod dir: ' + dir);
    } catch (e) { this.path = null; }
  },

  write: function (msg) {
    // Console always; file if available. Synchronous flush.
    try { console.log('[BMA] ' + msg); } catch (e) {}
    if (!this.path || !fs) return;
    try {
      this._n++;
      var t = '';
      try { t = new Date().toISOString().substr(11, 12); } catch (e) { t = String(this._n); }
      fs.appendFileSync(this.path, t + '  ' + msg + '\n');
    } catch (e) {}
  },

  // Speech transcript, opt-in via BMA.Config.speechLog. Deferred because write() ends in
  // fs.appendFileSync and a synchronous write per utterance has no business inside a frame.
  say: function (msg) {
    if (!BMA.Config.speechLog) return;
    var self = this;
    BMA.defer(function () { self.write('say: ' + msg); });
  },

  installErrorHandlers: function () {
    var self = this;
    try {
      if (typeof window !== 'undefined' && window.addEventListener) {
        window.addEventListener('error', function (ev) {
          var m = ev && ev.error ? (ev.error.message + '\n' + (ev.error.stack || '')) :
                  (ev && ev.message) || 'unknown';
          self.write('WINDOW ERROR: ' + m);
        });
      }
      if (typeof process !== 'undefined' && process.on) {
        process.on('uncaughtException', function (err) {
          self.write('UNCAUGHT: ' + (err && (err.stack || err.message) || err));
        });
      }
    } catch (e) {}
  },
};

//-----------------------------------------------------------------------------
// Deferral — run work AFTER the engine's update call returns instead of inside it.
// The audio cues are cheap, but nothing the mod does belongs on the frame's critical
// path; batching into one timer keeps the number of timers at one per drain.
//-----------------------------------------------------------------------------
BMA._deferred = [];
BMA._deferScheduled = false;
BMA.defer = function (fn) {
  BMA._deferred.push(fn);
  if (BMA._deferScheduled) return;
  BMA._deferScheduled = true;
  setTimeout(function () {
    BMA._deferScheduled = false;
    var q = BMA._deferred;
    BMA._deferred = [];
    for (var i = 0; i < q.length; i++) {
      try { q[i](); } catch (e) { BMA.Log.write('deferred task threw: ' + (e && e.message)); }
    }
  }, 0);
};

//-----------------------------------------------------------------------------
// Virtual navigation buffer — a port of ff1-screen-reader's Core/NavigationBuffer.cs.
//
// An ordered list of entries, each a function returning its announce string, so values are
// read LIVE at navigation time rather than snapshotted when the buffer was built. Optional
// group boundaries let a caller jump between sections. Holds data only: it returns strings
// and never speaks.
//-----------------------------------------------------------------------------
BMA.Buffer = function (entries, groupStarts, groupNames) {
  this.entries = entries || [];
  this.groupStarts = groupStarts || null;      // ascending entry indices where a group begins
  this.groupNames = groupNames || null;        // parallel to groupStarts; optional
  this.index = 0;
};

BMA.Buffer.prototype = {
  count: function () { return this.entries.length; },
  isEmpty: function () { return this.entries.length === 0; },

  current: function () {
    if (this.isEmpty()) return null;
    if (this.index < 0 || this.index >= this.entries.length) this.index = 0;
    try { return this.entries[this.index](); } catch (e) { return null; }
  },

  next: function () {
    if (this.isEmpty()) return null;
    this.index = (this.index + 1) % this.entries.length;
    return this.current();
  },

  prev: function () {
    if (this.isEmpty()) return null;
    this.index = (this.index - 1 + this.entries.length) % this.entries.length;
    return this.current();
  },

  top: function () { if (this.isEmpty()) return null; this.index = 0; return this.current(); },
  bottom: function () {
    if (this.isEmpty()) return null;
    this.index = this.entries.length - 1;
    return this.current();
  },

  // Which group the cursor sits in, and where it starts/ends.
  _groupOf: function (i) {
    var gs = this.groupStarts;
    if (!gs || !gs.length) return { gi: -1, start: 0, end: this.entries.length };
    var gi = 0;
    for (var k = 0; k < gs.length; k++) { if (gs[k] <= i) gi = k; else break; }
    return { gi: gi, start: gs[gi], end: (gi + 1 < gs.length) ? gs[gi + 1] : this.entries.length };
  },

  // Position WITHIN the current group, so a stat reads "1 of 6" rather than "15 of 31".
  groupPosition: function () {
    if (this.isEmpty()) return { index: 0, count: 0 };
    var g = this._groupOf(this.index);
    return { index: this.index - g.start, count: g.end - g.start };
  },

  groupName: function () {
    if (!this.groupNames) return '';
    var g = this._groupOf(this.index);
    return (g.gi >= 0 && g.gi < this.groupNames.length) ? (this.groupNames[g.gi] || '') : '';
  },

  // Jump to the first entry of the adjacent group, wrapping. The group name is prefixed here
  // and only here, so plain up/down stays terse.
  nextGroup: function () {
    if (this.isEmpty()) return null;
    var gs = this.groupStarts;
    if (!gs || !gs.length) return this.current();
    var target = gs[0];
    for (var k = 0; k < gs.length; k++) { if (gs[k] > this.index) { target = gs[k]; break; } }
    this.index = target;
    return this._withGroupName();
  },

  prevGroup: function () {
    if (this.isEmpty()) return null;
    var gs = this.groupStarts;
    if (!gs || !gs.length) return this.current();
    var target = gs[gs.length - 1];
    for (var k = gs.length - 1; k >= 0; k--) { if (gs[k] < this.index) { target = gs[k]; break; } }
    this.index = target;
    return this._withGroupName();
  },

  _withGroupName: function () {
    var cur = this.current();
    var name = this.groupName();
    return name ? name + '. ' + cur : cur;
  },
};

//-----------------------------------------------------------------------------
// Perf counters — opt-in (BMA.Config.perfLog), so we can *prove* how much main-thread
// time the mod costs rather than argue about it. Buckets are summarised to bma_log.txt.
//-----------------------------------------------------------------------------
BMA.Perf = {
  buckets: {},                    // name -> {n, ms, max}
  _lastFlush: 0,
  flushEvery: 5000,               // ms

  now: function () {
    try { return performance.now(); } catch (e) { return new Date().getTime(); }
  },

  time: function (name, fn) {
    if (!BMA.Config.perfLog) return fn();
    var t0 = this.now();
    try { return fn(); }
    finally {
      var dt = this.now() - t0;
      var b = this.buckets[name] || (this.buckets[name] = { n: 0, ms: 0, max: 0 });
      b.n++; b.ms += dt;
      if (dt > b.max) b.max = dt;
      this._maybeFlush();
    }
  },

  count: function (name) {
    if (!BMA.Config.perfLog) return;
    var b = this.buckets[name] || (this.buckets[name] = { n: 0, ms: 0, max: 0 });
    b.n++;
    this._maybeFlush();
  },

  _maybeFlush: function () {
    var t = this.now();
    if (!this._lastFlush) { this._lastFlush = t; return; }
    if (t - this._lastFlush < this.flushEvery) return;
    this._lastFlush = t;
    var parts = [];
    for (var k in this.buckets) {
      var b = this.buckets[k];
      parts.push(k + ' n=' + b.n + ' total=' + b.ms.toFixed(1) + 'ms max=' + b.max.toFixed(2) + 'ms');
    }
    if (parts.length) BMA.Log.write('perf: ' + parts.join(' | '));
    this.buckets = {};
  },
};

//-----------------------------------------------------------------------------
// TTS backend: in-process Tolk addon, then Web Speech, then silent.
//-----------------------------------------------------------------------------
BMA.TTS = {
  _addon: null,
  _mode: 'none',                  // 'tolk' | 'webspeech' | 'none'
  _reader: null,
  modDir: null,

  resolveModDir: function () {
    try {
      if (pathMod && process && process.mainModule) {
        return pathMod.join(pathMod.dirname(process.mainModule.filename), 'mod');
      }
    } catch (e) {}
    return null;
  },

  init: function () {
    this.modDir = this.resolveModDir();
    BMA.Log.write('TTS.init, modDir=' + this.modDir);

    if (this._tryAddon()) return;

    // Fallback: Web Speech.
    if (typeof window !== 'undefined' && window.speechSynthesis) {
      this._mode = 'webspeech';
      BMA.Log.write('TTS mode = webspeech (fallback)');
      return;
    }
    this._mode = 'none';
    BMA.Log.write('TTS mode = none (no backend)');
  },

  // Attempt the in-process Tolk addon, guarded by a canary + safe-mode sentinel so a
  // native crash can never permanently brick the game. Returns true on success.
  _tryAddon: function () {
    if (!nodeRequire || !this.modDir || !fs || !pathMod) {
      BMA.Log.write('addon skipped: no node/fs/modDir');
      return false;
    }
    var addonPath = pathMod.join(this.modDir, 'bma_tts.node');
    var canary = pathMod.join(this.modDir, 'bma_addon.loading');
    var safeFile = pathMod.join(this.modDir, 'bma_safe.txt');

    try {
      if (fs.existsSync(safeFile)) {
        BMA.Log.write('addon skipped: safe mode (bma_safe.txt present)');
        return false;
      }
      // If the canary from a previous run is still here, that run died loading the
      // addon. Skip it this time so the game boots; leave a marker for the user.
      if (fs.existsSync(canary)) {
        BMA.Log.write('addon skipped: previous launch crashed loading addon (canary present). Using Web Speech. Delete ' + canary + ' to retry.');
        return false;
      }
      if (!fs.existsSync(addonPath)) {
        BMA.Log.write('addon skipped: bma_tts.node not found');
        return false;
      }
    } catch (e) {
      BMA.Log.write('addon precheck error: ' + e.message);
      return false;
    }

    // Drop the canary and flush BEFORE the risky require. If require() segfaults the
    // process, this file remains and the next boot auto-recovers.
    try { fs.writeFileSync(canary, String(Date.now ? Date.now() : 'x')); } catch (e) {}

    try {
      BMA.Log.write('requiring addon: ' + addonPath);
      this._addon = nodeRequire(addonPath);
      BMA.Log.write('addon required OK; calling load()');
      var ok = this._addon.load(this.modDir);
      BMA.Log.write('addon.load() returned ' + ok);
      if (ok) {
        this._mode = 'tolk';
        try { this._reader = this._addon.detect(); } catch (e) {}
        BMA.Log.write('TTS mode = tolk; reader = ' + (this._reader || 'SAPI/none'));
        try { fs.unlinkSync(canary); } catch (e) {}   // survived — clear canary
        return true;
      }
      // Loaded but Tolk unavailable (no DLL / no reader): not a crash, clear canary.
      try { fs.unlinkSync(canary); } catch (e) {}
      BMA.Log.write('addon loaded but Tolk unavailable; falling back');
      return false;
    } catch (e) {
      // A catchable JS error (not a segfault) — clear the canary so we retry next time.
      try { fs.unlinkSync(canary); } catch (e2) {}
      BMA.Log.write('addon load threw: ' + (e && e.message));
      return false;
    }
  },

  speak: function (text, interrupt) {
    if (!text) return;
    var self = this;
    try {
      if (this._mode === 'tolk') {
        // The addon queues onto its own thread, so this should measure as ~0.
        BMA.Perf.time('speak', function () { self._addon.speak(String(text), !!interrupt); });
      } else if (this._mode === 'webspeech') {
        if (interrupt) window.speechSynthesis.cancel();
        var u = new SpeechSynthesisUtterance(String(text));
        window.speechSynthesis.speak(u);
      }
    } catch (e) { /* never throw into the game loop */ }
  },

  silence: function () {
    try {
      if (this._mode === 'tolk') this._addon.silence();
      else if (this._mode === 'webspeech') window.speechSynthesis.cancel();
    } catch (e) {}
  },
};

//-----------------------------------------------------------------------------
// Speech facade — priorities, per-category mute. No deduplication (FFPR model):
// every utterance is spoken as issued; interrupt naturally replaces on rapid moves.
//-----------------------------------------------------------------------------
BMA.Speech = {
  // opts: {interrupt, priority: 'critical'|'normal'|'ambient', category}
  speak: function (text, opts) {
    if (!BMA.Config.speechEnabled) return;
    opts = opts || {};
    if (opts.category && BMA.Config.mutedCategories[opts.category]) return;
    text = BMA.Util.cleanText(text);
    if (!text) return;
    // Logged here, after cleaning and the mute check, so the transcript is exactly what the
    // reader was handed.
    BMA.Log.say(text);
    var interrupt = opts.interrupt !== undefined ? opts.interrupt
                    : (opts.priority === 'critical' || opts.priority === undefined);
    // A caller that just said something has asked for this to follow it rather than replace it.
    if (this._appendNext) { interrupt = false; this._appendNext = false; }
    BMA.TTS.speak(text, interrupt);
  },

  // "Whatever is spoken next belongs after what I just said." Used where the mod announces a
  // heading — the actor whose page you moved to — and the engine is about to announce the
  // newly focused control, which would otherwise cut the heading off mid-word. One-shot, so a
  // follow-up that never arrives cannot leave speech permanently non-interrupting.
  queueNext: function () { this._appendNext = true; },

  _appendNext: false,
};

//-----------------------------------------------------------------------------
// Audio cue engine — plays the generated WAVs via Web Audio, reusing MV's context.
// Wall tones loop gaplessly (AudioBufferSourceNode.loop); beacon repeats with
// pan/pitch/gain by direction/distance.
//-----------------------------------------------------------------------------
BMA.Audio = {
  ctx: null,
  buffers: {},                    // name -> AudioBuffer
  _wallNodes: {},                 // dir -> {src, gain}
  _beaconTimer: null,
  _ready: false,

  files: ['wall_n','wall_s','wall_e','wall_w','wall_bump','footstep','beacon'],

  context: function () {
    if (this.ctx) return this.ctx;
    try {
      if (window.WebAudio && WebAudio._context) this.ctx = WebAudio._context;
      else if (window.AudioContext) this.ctx = new AudioContext();
    } catch (e) {}
    return this.ctx;
  },

  init: function () {
    var ctx = this.context();
    if (!ctx || !fs || !BMA.TTS.modDir) return;
    var self = this;
    this.files.forEach(function (name) {
      try {
        var p = pathMod.join(BMA.TTS.modDir, 'audio', name + '.wav');
        if (!fs.existsSync(p)) return;
        var buf = fs.readFileSync(p);
        var ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
        ctx.decodeAudioData(ab, function (decoded) { self.buffers[name] = decoded; },
                            function () {});
      } catch (e) {}
    });
    this._ready = true;
  },

  _seVol: function () {
    try { return (AudioManager._seVolume != null ? AudioManager._seVolume : 100) / 100; }
    catch (e) { return 1; }
  },

  // One-shot with optional pan (-1..1) and gain scale.
  play: function (name, catVol, pan, rate) {
    var ctx = this.context();
    var buf = this.buffers[name];
    if (!ctx || !buf) return;
    try {
      var src = ctx.createBufferSource();
      src.buffer = buf;
      if (rate) src.playbackRate.value = rate;
      var gain = ctx.createGain();
      gain.gain.value = (catVol != null ? catVol : 1) * this._seVol();
      var last = gain;
      if (pan != null && ctx.createStereoPanner) {
        var panner = ctx.createStereoPanner();
        panner.pan.value = Math.max(-1, Math.min(1, pan));
        src.connect(gain); gain.connect(panner); last = panner;
      } else {
        src.connect(gain);
      }
      last.connect(ctx.destination);
      // Tear the chain down when the buffer finishes. Without this every cue leaves its gain (and
      // panner) wired to ctx.destination until GC gets round to it, so the render graph grows for
      // as long as the player keeps walking.
      src.onended = function () {
        try { src.disconnect(); gain.disconnect(); if (panner) panner.disconnect(); } catch (e2) {}
      };
      src.start(0);
    } catch (e) {}
  },

  // Wall tones: start/refresh looping tone(s) for the given blocked directions set.
  setWallDirections: function (dirs) {
    var ctx = this.context();
    if (!ctx) return;
    var want = {}; (dirs || []).forEach(function (d) { want[d] = true; });
    var self = this;
    ['n','s','e','w'].forEach(function (d) {
      var active = !!self._wallNodes[d];
      if (want[d] && !active) self._startWall(d);
      else if (!want[d] && active) self._stopWall(d);
    });
  },
  _startWall: function (d) {
    var ctx = this.context();
    var buf = this.buffers['wall_' + d];
    if (!ctx || !buf) return;
    try {
      var src = ctx.createBufferSource();
      src.buffer = buf; src.loop = true;
      var gain = ctx.createGain();
      gain.gain.value = BMA.Config.vol.wallTone * this._seVol();
      src.connect(gain); gain.connect(ctx.destination);
      src.start(0);
      this._wallNodes[d] = { src: src, gain: gain };
    } catch (e) {}
  },
  _stopWall: function (d) {
    var n = this._wallNodes[d];
    if (!n) return;
    try { n.src.stop(); } catch (e) {}
    try { n.src.disconnect(); n.gain.disconnect(); } catch (e) {}
    delete this._wallNodes[d];
  },

  // A looping tone's gain is set once when it starts, so a volume change from the F8 menu (or the
  // game's own SE slider) never reached a tone that was already sounding. Push the current value
  // into whatever is running.
  refreshWallGain: function () {
    var self = this;
    ['n','s','e','w'].forEach(function (d) {
      var n = self._wallNodes[d];
      if (n && n.gain) {
        try { n.gain.gain.value = BMA.Config.vol.wallTone * self._seVol(); } catch (e) {}
      }
    });
  },
  stopAllWalls: function () { var self = this; ['n','s','e','w'].forEach(function (d) { self._stopWall(d); }); },

  // Beacon: repeats a ping panned toward the target with pitch/gain by distance.
  startBeacon: function (getState) {
    this.stopBeacon();
    var self = this;
    function tick() {
      var st = getState();      // {pan:-1..1, dist tiles, south:bool} or null
      if (!st) { self.stopBeacon(); return; }
      var fast = BMA.Config.beaconFastTiles, far = BMA.Config.beaconFarTiles;
      // Approach intensity: 1 at/inside fast tiles, 0 at/beyond far tiles. Drives beep rate,
      // pitch and gain together so the cue tightens smoothly as the objective nears.
      var f = Math.max(0, Math.min(1, (far - st.dist) / (far - fast)));
      var gain = BMA.Config.vol.beacon * (0.35 + 0.65 * f);
      var rate = st.south ? 0.7 : 1.0;                 // 280 vs 400 Hz base
      rate *= (0.9 + 0.5 * f);                          // rises as you close
      self.play('beacon', gain, st.pan, rate);
      // Linear beep gap: near (fastest) inside fast tiles, far (slowest) beyond far tiles.
      var t = BMA.Config.beaconIntervalNear + (1 - f) *
              (BMA.Config.beaconIntervalFar - BMA.Config.beaconIntervalNear);
      self._beaconTimer = setTimeout(tick, Math.max(120, t));
    }
    tick();
  },
  stopBeacon: function () {
    if (this._beaconTimer) { clearTimeout(this._beaconTimer); this._beaconTimer = null; }
  },
};

//-----------------------------------------------------------------------------
// Input dispatch — global keydown, modifier-aware, context-gated.
// Other modules register action handlers; core routes keys to them.
//-----------------------------------------------------------------------------
BMA.Input = {
  _handlers: {},                  // action -> fn
  _menuActions: { readDetail:1, usableBy:1, reviewBuffer:1, toggleAutodetail:1, modMenu:1, silence:1 },
  _anywhere: { silence:1, modMenu:1 },
  // Fires only while a message/dialogue/text panel is on screen; silent (and not consumed)
  // otherwise. 'repeat' (r) re-reads that panel — the only text the mod repeats on demand.
  _textActions: { repeat:1 },
  // Fires only in the field or a shop; silent (and not consumed) in other menus/battle.
  _fieldShopActions: { announceGil:1 },
  // Fires only in the battle scene.
  _battleActions: { readVitals:1 },

  // Actions that only respond while their keyset is selected. 'directions' (p) lives in
  // both sets and switches meaning instead, so it is deliberately absent here. Each keyset
  // owns its own category, path-filter and labeller keys (p-family vs \-family).
  _classicOnly: { prevDest:1, nextDest:1, reannounce:1, prevCategory:1, nextCategory:1,
                  togglePathFilter:1, customLabel:1, resetCategory:1 },
  _bracketOnly: { prevDestAlt:1, nextDestAlt:1, directionsAlt:1, prevCategoryAlt:1,
                  nextCategoryAlt:1, togglePathFilterAlt:1, customLabelAlt:1, resetCategoryAlt:1 },
  _lefthandOnly:{ prevDestLh:1, nextDestLh:1, reannounceLh:1, prevCategoryLh:1, nextCategoryLh:1,
                  directionsLh:1, togglePathFilterLh:1, customLabelLh:1, resetCategoryLh:1 },

  register: function (action, fn) { this._handlers[action] = fn; },

  isActive: function (action) {
    var ks = BMA.Config.navKeyset;
    if (this._classicOnly[action]) return ks === 'classic';
    if (this._bracketOnly[action]) return ks === 'bracket';
    if (this._lefthandOnly[action]) return ks === 'lefthand';
    // The shared 'p' directions/announce key belongs to classic and bracket only.
    if (action === 'directions') return ks !== 'lefthand';
    return true;
  },

  _context: function () {
    try {
      var s = SceneManager._scene;
      if (!s) return 'none';
      if (s instanceof Scene_Map) {
        if ($gameMessage && $gameMessage.isBusy()) return 'message';
        return 'field';
      }
      if (window.Scene_Battle && s instanceof Scene_Battle) return 'battle';
      if (window.Scene_MenuBase && s instanceof Scene_MenuBase) return 'menu';
      return 'other';
    } catch (e) { return 'none'; }
  },

  _match: function (bind, e, key) {
    if (!bind) return false;
    if (bind.key !== key) return false;
    if (!!bind.shift !== e.shiftKey) return false;
    if (!!bind.ctrl !== e.ctrlKey) return false;
    if (!!bind.alt !== e.altKey) return false;
    return true;
  },

  onKeyDown: function (e) {
    // Modal overlays (review buffer, mod menu) intercept keys before normal dispatch.
    if (BMA.ModMenu && BMA.ModMenu.active) {
      if (BMA.ModMenu.handleKey(e)) { e.preventDefault(); e.stopPropagation(); return; }
    }
    if (BMA.Review && BMA.Review.active) {
      if (BMA.Review.handleKey(e)) { e.preventDefault(); e.stopPropagation(); return; }
    }
    // The status buffer only claims the arrow keys; Q/W, Escape and the rest fall through so
    // the scene underneath keeps working.
    if (BMA.Status && BMA.Status.active) {
      if (BMA.Status.handleKey(e)) { e.preventDefault(); e.stopPropagation(); return; }
    }
    var key = this._normalize(e);
    if (!key) return;
    var ctx = this._context();
    var keys = BMA.Config.keys;
    for (var action in keys) {
      if (!this._handlers[action]) continue;
      if (!this._match(keys[action], e, key)) continue;
      if (!this.isActive(action)) continue;          // wrong keyset selected
      // context gating
      var fieldOnly = !this._menuActions[action] && !this._anywhere[action] &&
                      !this._textActions[action] && !this._fieldShopActions[action] &&
                      !this._battleActions[action];
      if (fieldOnly && ctx !== 'field') continue;
      if (this._textActions[action] && !(window.$gameMessage && $gameMessage.isBusy())) continue;
      if (this._fieldShopActions[action] && ctx !== 'field' &&
          !(window.Scene_Shop && SceneManager._scene instanceof Scene_Shop)) continue;
      if (this._battleActions[action] && ctx !== 'battle') continue;
      if (this._menuActions[action] && !this._anywhere[action] && ctx === 'message') continue;
      try { this._handlers[action](); } catch (err) { console.log('[BMA] action ' + action + ' error: ' + err.message); }
      e.preventDefault();
      e.stopPropagation();
      return;
    }
  },

  _normalize: function (e) {
    // Function keys and specials by e.key; letters/punct lowercased.
    var k = e.key;
    if (!k) return null;
    if (k.length === 1) return k.toLowerCase();
    var map = { 'Control':'control','Shift':'shift','Alt':'alt',
                'F6':'f6','F7':'f7','F8':'f8','Dead':null };
    if (map[k] !== undefined) return map[k];
    if (/^F\d+$/.test(k)) return k.toLowerCase();
    return null;
  },

  install: function () {
    var self = this;
    document.addEventListener('keydown', function (e) { self.onKeyDown(e); }, true);
  },
};

//-----------------------------------------------------------------------------
// Persistence — piggyback ConfigManager so settings live in config.rpgsave.
//-----------------------------------------------------------------------------
BMA.Persist = {
  // Bump when a default changes that must win over an already-saved value, and add the
  // matching case to _migrate. Without this, a config.rpgsave written by an earlier build
  // silently pins the old default forever.
  VERSION: 3,

  _migrate: function (from) {
    if (from < 2) BMA.Config.vol.wallTone = 2.0;   // v2: wall tones were too quiet at 1.0
    // v3: the two diagnostics now default on. This has to override the saved value or the
    // installs that most need it — the ones that have been played, and so have a config already —
    // are exactly the ones that would keep the old default and go on logging nothing.
    if (from < 3) { BMA.Config.speechLog = true; BMA.Config.perfLog = true; }
  },

  install: function () {
    if (!window.ConfigManager) return;
    var _make = ConfigManager.makeData;
    ConfigManager.makeData = function () {
      var c = _make.call(this);
      c.bma = {
        cfgVersion: BMA.Persist.VERSION,
        speechEnabled: BMA.Config.speechEnabled,
        verbosity: BMA.Config.verbosity,
        footsteps: BMA.Config.footsteps,
        wallTones: BMA.Config.wallTones,
        beacon: BMA.Config.beacon,
        pathFilter: BMA.Config.pathFilter,
        autodetail: BMA.Config.autodetail,
        wallTonesContinuous: BMA.Config.wallTonesContinuous,
        announceMapEntry: BMA.Config.announceMapEntry,
        menuIndex: BMA.Config.menuIndex,
        airshipLanding: BMA.Config.airshipLanding,
        perfLog: BMA.Config.perfLog,
        speechLog: BMA.Config.speechLog,
        navKeyset: BMA.Config.navKeyset,
        vol: BMA.Config.vol,
        mutedCategories: BMA.Config.mutedCategories,
        keys: BMA.Config.keys,
      };
      return c;
    };
    var _apply = ConfigManager.applyData;
    ConfigManager.applyData = function (c) {
      _apply.call(this, c);
      if (c && c.bma) {
        var b = c.bma;
        for (var k in b) {
          if (!BMA.Config.hasOwnProperty(k)) continue;
          // Merge keybindings instead of replacing them: a config saved by an older build
          // has no entry for bindings added since, and a wholesale assign would delete them.
          if (k === 'keys' && b.keys && typeof b.keys === 'object') {
            for (var action in b.keys) {
              if (BMA.Config.keys.hasOwnProperty(action)) BMA.Config.keys[action] = b.keys[action];
            }
            continue;
          }
          BMA.Config[k] = b[k];
        }
        BMA.Persist._migrate(b.cfgVersion || 1);
      }
    };
  },
};

//-----------------------------------------------------------------------------
// Boot
//-----------------------------------------------------------------------------
BMA.boot = function () {
  try { BMA.Log.init(); } catch (e) {}
  try { BMA.Log.installErrorHandlers(); } catch (e) {}
  BMA.Log.write('boot: engine ready, initializing mod');
  BMA.Log.write('modules present: core=' + !!BMA.Config + ' text=' + !!BMA.Text +
                ' menus=' + !!BMA.Menus + ' nav=' + !!BMA.Nav + ' waypoints=' + !!BMA.Waypoints);
  try { BMA.TTS.init(); } catch (e) { BMA.Log.write('TTS.init threw: ' + (e && e.message)); }
  try { BMA.Persist.install(); } catch (e) { BMA.Log.write('Persist.install threw: ' + (e && e.message)); }
  try { BMA.Input.install(); } catch (e) { BMA.Log.write('Input.install threw: ' + (e && e.message)); }

  // Register the always-available actions here; menus/nav register the rest.
  // 'repeat' (re-read the on-screen text panel) is registered in BMA_Text.js.
  BMA.Input.register('silence', function () { BMA.TTS.silence(); });
  BMA.Input.register('announceGil', function () {
    try { BMA.Speech.speak(BMA.Util.currency($gameParty.gold()), { priority: 'critical' }); }
    catch (e) {}
  });
  BMA.Input.register('toggleAutodetail', function () {
    BMA.Config.autodetail = !BMA.Config.autodetail;
    BMA.Speech.speak('Autodetail ' + (BMA.Config.autodetail ? 'on' : 'off'), { priority: 'critical' });
  });
  BMA.Input.register('modMenu', function () { if (BMA.ModMenu) BMA.ModMenu.open(); });

  // Audio can only decode once an AudioContext exists; try now and again on first scene.
  try { BMA.Audio.init(); } catch (e) { BMA.Log.write('Audio.init threw: ' + (e && e.message)); }
  BMA.Log.write('boot: mod initialized (TTS=' + BMA.TTS._mode + ')');
};

// Hook Scene_Boot.start so the engine is ready (managers/context) before we init.
if (window.Scene_Boot) {
  var _start = Scene_Boot.prototype.start;
  Scene_Boot.prototype.start = function () {
    _start.call(this);
    if (!BMA._booted) { BMA._booted = true; BMA.boot(); }
    // Audio context becomes available after first user gesture / boot; retry decode.
    if (!Object.keys(BMA.Audio.buffers).length) { try { BMA.Audio.init(); } catch (e) {} }
  };
}

})();
