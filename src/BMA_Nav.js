//=============================================================================
// BMA_Nav.js — field navigation, patterned on ff1-screen-reader.
//
// No auto-walk: the mod never moves the player. It classifies entities at runtime,
// cycles them, speaks turn-by-turn directions from a BFS flood-fill, and drives the
// footstep / wall-tone / beacon audio cues while the player walks manually.
//=============================================================================

(function () {
'use strict';
if (typeof BMA === 'undefined') return;

// MV command codes we key on. 401 is the continuation line of a 101 Show Text block.
// SHOP_MORE (605) is the continuation line carrying every good after the first; a shop's stock
// is the 302 plus the run of 605s behind it.
var C = { TEXT:101, TEXT_CONT:401, CHOICE:102, NUM_INPUT:103, COMMON:117, SWITCH:121,
          VARIABLE:122, SELF_SW:123, GOLD:125, ITEM:126, WEAPON:127, ARMOR:128,
          MOVE_ROUTE:205, TRANSFER:201, BATTLE:301, SHOP:302,
          HP:311, MP:312, STATE:313, RECOVER:314, SAVE:352, SHOP_MORE:605 };

// Play SE, as it appears *inside* a move route's own command list (Game_Character.ROUTE_PLAY_SE).
// Not to be confused with the map-level 250.
var ROUTE_PLAY_SE = 44;

// Direction helpers (MV: 2 down, 4 left, 6 right, 8 up).
var DIRS = [ {d:8, dx:0, dy:-1, k:'n', name:'north'},
             {d:2, dx:0, dy: 1, k:'s', name:'south'},
             {d:6, dx:1, dy: 0, k:'e', name:'east'},
             {d:4, dx:-1,dy: 0, k:'w', name:'west'} ];
var WALK_DIRECTIONS = {
  forcedLeft: DIRS.filter(function (d) { return d.d !== 6; }),
  downIsUp: DIRS.filter(function (d) { return d.d !== 2; })
};

// Tiles you could stand on to interact with something at the centre. Movement is 4-directional
// (DIRS), but standing is not: a chest in a corner may only be approachable from the diagonal.
var APPROACH = DIRS.concat([ {dx:-1,dy:-1}, {dx:1,dy:-1}, {dx:-1,dy:1}, {dx:1,dy:1} ]);

// Move-route step codes (Game_Character.ROUTE_*), for reading where a route carries the player.
//   1-8  fixed steps, in the same order as the editor's direction buttons
//   14   jump, whose parameters are a RELATIVE [x, y] offset — deterministic, not random
//   37/38 through on/off, which is how a route crosses terrain the player cannot walk
var ROUTE_STEP = { 1:[0,1], 2:[-1,0], 3:[1,0], 4:[0,-1],
                   5:[-1,1], 6:[1,1], 7:[-1,-1], 8:[1,-1] };
var ROUTE_JUMP = 14;
// Random / toward player / away from player / forward / backward. Where these land depends on
// run-time state, so a route containing one has no landing tile that can be worked out here.
var ROUTE_UNKNOWABLE = { 9:'random', 10:'toward the player', 11:'away from the player',
                         12:'forward', 13:'backward' };
// Conditional Branch subtypes: [6, -1, d] is "the player is facing d", which is how a
// stepping-stone event picks which way to throw you.
var BRANCH_CHARACTER = 6, BRANCH_PLAYER = -1;
// The two Cleft of Wind maps route doorways according to the approach marker crossed.
var CLEFT_ROUTE_SWITCH = { 549: 998, 550: 999 };
// A word with a number stuck straight onto it, no space: "Chest1", "Shell18". That is the editor's
// shorthand for "the Nth of these", typed so a mapper can tell their own events apart, and it is
// not a name anybody chose for a player to hear — the game's own dialogue never says either word.
// A real name keeps its space ("Pirate 1", "Dragoon 3"), which is why the space is the whole test.
// See _makeRecord: this is the only shape of name the mod will discard.
var EDITOR_SHORTHAND = /^[A-Za-z]+\d+$/;
var DIR_DELTA = { 2:[0,1], 4:[-1,0], 6:[1,0], 8:[0,-1] };
// Command codes that carry no behaviour, for a reader walking a page a line at a time: the list
// terminator, the two comment forms, the brace that closes a conditional, and the 505s MV writes
// after a 205 purely so the editor can print the route it already stated in the 205's parameters.
var NOT_BEHAVIOUR = { 0:1, 108:1, 408:1, 412:1, 505:1 };

// 'crossing' is deliberately NOT in this list. A crossing is a mover: you stand beside it, face
// it and act, and it carries you over ground you cannot walk — a stepping stone, or one of Conall
// Curach's moogles, who asks first and then ferries you. The pathfinder has to know about them —
// routes are built through them and name them — but they are waypoints on the way to somewhere,
// not places you set out for, and listing sixteen stepping stones as destinations would bury the
// things a player actually wants. They are still classified and numbered so directions can say
// "use Crossing 12 to cross"; filtered() keeps them out of the cycle.
//
// "Exits" used to be one list of 4,159 things answering two different questions. It is two now:
//
//   exit   leaves this map          3,409
//   door   a doorway on this map      750   — 690 that carry you across it, 60 still shut
//
// Asking "where are the ways out of here" and being read 750 interior doorways first is what a
// single list costs.
//
// There is no 'portal' category. There was, and it held two things that are not the same: the
// interior doorways above, which are doors, and Conall Curach's talking moogles, which are
// movers — you ask them to carry you and they do. Those are crossings: the pathfinder routes
// through them and names them. If somewhere in this game turns out to have a real portal — an
// outdoor thing that is a passage in its own right — it earns a category back then, on evidence.
//
// 'crossing' IS a category, but never appears in "all". Crossings are not places anyone sets out
// for, so listing them beside the chests would bury them — but on a map that is nothing but
// crossings they are the only way to get anywhere, and Archareon Prison proved it: thirteen gap
// jumps hold the whole map together, and with them unlistable it offered a save point, four pads
// and no route to any of it. Same treatment as traps, and for the same reason.
var CATEGORIES = ['all','exit','door','shop','npc','treasure','savepoint',
                  'interactable','event','enemy','crossing','trap','vehicle'];
var CAT_LABEL = { all:'all', exit:'exits', door:'doors', crossing:'crossings',
                  shop:'shops', npc:'NPCs', treasure:'treasure', savepoint:'save points',
                  interactable:'objects', event:'events', enemy:'enemies', trap:'traps',
                  vehicle:'vehicles' };
// Spoken for a single entity that produced no name of its own; combined with a per-map
// sequence number so two nameless NPCs are still tellable apart while cycling.
var CAT_SINGULAR = { exit:'Exit', door:'Door', crossing:'Crossing', shop:'Shop',
                     npc:'NPC', treasure:'Chest', savepoint:'Save point', interactable:'Object',
                     event:'Event', enemy:'Enemy', trap:'Trap', vehicle:'Vehicle' };

// Editor map names that describe a container rather than a place. When a destination
// resolves to one of these we prefix it with the nearest meaningful ancestor, turning
// "Inn" into "Branch Castle Inn" and "Interiors" into "Valla Interiors".
//
// `\w+ interiors` is the same placeholder with the editor's word for what it holds typed in
// front of it. The Citadel is the only town in the game whose interiors map is not called plain
// "Interiors" — its is "Town Interiors" — and that one word was the whole of why its ten building
// doors all read "To Town Interiors, door 1" through "door 10". They are four shops, an inn and
// five houses, and the peek describes every one of them correctly the moment it is allowed to
// run. Nothing else in the game matches: it is one map, and it was checked against all of them.
//
// PLURAL on purpose. "Castle Interior" and "Ferry Interior" are singular and are places — one
// building's inside, not a box holding a town's rooms — and sweeping them in here is a
// regression, not a gain: the four doors from the Emperor's Room back into the Citadel's castle
// would stop saying "To Castle Interior" and start saying "Empty room".
var GENERIC_MAP_NAME = /^(map ?\d+|interiors?|\w+ interiors|shops?|houses?|inn|inns|pub|basement|inner|entry|entrance|exits?|exit map|cutscenes?)$/i;

//-----------------------------------------------------------------------------
// Map names — what an exit actually leads to.
//
// $dataMapInfos (MapInfos.json) is loaded by the engine and gives every map's editor
// name, but the nicer in-game displayName lives only in Map###.json, which the engine
// loads one map at a time. Node integration is on, so read the destination file's header
// directly: displayName sits in the first few hundred bytes, well before the tile data.
//-----------------------------------------------------------------------------
BMA.MapNames = {
  _cache: {},
  _fs: null, _path: null, _dir: null,

  // Retries while _dir is still empty: if this ran before BMA.TTS.modDir was resolved, caching
  // the failure would leave every map name and door label permanently blank.
  _init: function () {
    if (this._dir) return;
    try {
      this._fs = require('fs');
      this._path = require('path');
      this._dir = BMA.TTS.modDir ? this._path.join(BMA.TTS.modDir, '..', 'data') : '';
    } catch (e) { this._dir = ''; }
  },

  // displayName straight out of the map file's header, or '' if unavailable.
  _displayName: function (mapId) {
    this._init();
    if (!this._dir || !this._fs) return '';
    try {
      var num = String(mapId);
      while (num.length < 3) num = '0' + num;
      var file = this._path.join(this._dir, 'Map' + num + '.json');
      var fd = this._fs.openSync(file, 'r');
      var buf = Buffer.alloc(4096);
      var n = this._fs.readSync(fd, buf, 0, 4096, 0);
      this._fs.closeSync(fd);
      var head = buf.toString('utf8', 0, n);
      var m = head.match(/"displayName"\s*:\s*"((?:\\.|[^"\\])*)"/);
      if (!m) return '';
      return m[1].replace(/\\"/g, '"').replace(/\\\\/g, '\\').trim();
    } catch (e) { return ''; }
  },

  _infoName: function (mapId) {
    try {
      var info = $dataMapInfos && $dataMapInfos[mapId];
      return info && info.name ? String(info.name).trim() : '';
    } catch (e) { return ''; }
  },

  get: function (mapId) {
    if (!mapId) return '';
    if (this._cache[mapId] !== undefined) return this._cache[mapId];
    var name = '';
    try {
      name = this._displayName(mapId);
      if (!name) {
        name = this._infoName(mapId);
        if (!name || GENERIC_MAP_NAME.test(name)) {
          var ancestor = this._ancestorName(mapId);
          // The editor's own word for what the container holds is redundant once the ancestor is
          // in front of it: "Town Interiors" under "The Citadel" would read "The Citadel Town
          // Interiors". Drop it and the result matches every other town's — "The Citadel
          // Interiors", beside "Daguero Interiors".
          var bare = name.replace(/^\w+\s+(interiors)$/i, '$1');
          if (ancestor) name = bare && !/^map ?\d+$/i.test(bare) ? ancestor + ' ' + bare : ancestor;
        }
      }
    } catch (e) {}
    if (!name) name = 'Map ' + mapId;
    this._cache[mapId] = name;
    return name;
  },

  // Nearest ancestor in the editor tree whose name actually describes a place.
  _ancestorName: function (mapId) {
    try {
      var info = $dataMapInfos && $dataMapInfos[mapId];
      var id = info ? info.parentId : 0;
      for (var hops = 0; id && hops < 6; hops++) {
        var n = this._displayName(id) || this._infoName(id);
        if (n && !GENERIC_MAP_NAME.test(n)) return n;
        var pi = $dataMapInfos[id];
        id = pi ? pi.parentId : 0;
      }
    } catch (e) {}
    return '';
  },

  // The map the player is standing on — $dataMap is already in memory here.
  current: function () {
    try {
      var d = $gameMap.displayName();
      if (d && d.trim()) return d.trim();
      return this.get($gameMap.mapId());
    } catch (e) { return ''; }
  },
};

//-----------------------------------------------------------------------------
// Door peek — what is on the other side of a doorway.
//
// Every door in this game announced as "To Valla Interiors", seven times over, with no way to
// tell the weapon shop from the inn from an empty house. Worse, the interiors are one map cut
// into unconnected rooms, so the destinations you can see from inside one room are mostly ones
// you cannot walk to — which read as a pathfinding fault when it was really a labelling one.
//
// So: read the destination map off disk (the MapNames trick, but the whole file), flood the room
// the door actually lands you in, and describe what is standing in it. Measured over the real
// data: 4611 doors, 2279 land in a room small enough to describe — 698 empty, 271 a named
// person's house, 494 several people, 458 chests/save only, 340 a shop, 58 an inn.
//
// Cost is trivial and paid once per destination: Tilesets.json is a 10 ms parse, a map file 1-9
// ms, and all seven Valla room floods together are under a millisecond. Labels are cached for
// the session, so a town is free after the first visit.
//-----------------------------------------------------------------------------
BMA.DoorPeek = {
  MAX_ROOM: 400,          // above this it is a region, not a room worth describing
  _tilesets: null,
  _maps: {},              // mapId -> parsed map, capped
  _mapOrder: [],
  _labels: {},            // 'destMap,x,y' -> label, permanent for the session

  _json: function (file) {
    BMA.MapNames._init();                       // shares the fs/path/data-dir resolution
    var mn = BMA.MapNames;
    if (!mn._dir || !mn._fs) return null;
    try { return JSON.parse(mn._fs.readFileSync(mn._path.join(mn._dir, file), 'utf8')); }
    catch (e) { return null; }
  },

  // Does the game put a name on screen when you arrive? That is its own statement that the
  // destination is a place rather than a room, and it beats anything we could infer by looking
  // inside. Reuses MapNames' 4 KB header read rather than parsing the whole file.
  // Does the destination have a name worth speaking? "Quarters", "Hall", "Darius Training" and
  // "Throne Approach" all say more than anything we could work out by looking inside, so those
  // doors keep their names and only get numbered. Only a destination whose own name is a
  // placeholder — "Interiors", "Shops", "Houses" — is worth describing by its contents, and that
  // is exactly the Valla case where seven doors all read "To Valla Interiors".
  isVagueDestination: function (mapId) {
    try {
      if (this.isNamedPlace(mapId)) return false;              // the game names it on screen
      var n = (($dataMapInfos[mapId] || {}).name || '').trim();
      return !n || GENERIC_MAP_NAME.test(n);
    } catch (e) { return false; }
  },

  _named: {},
  isNamedPlace: function (mapId) {
    if (this._named[mapId] === undefined) {
      var n = '';
      try { n = BMA.MapNames._displayName(mapId); } catch (e) {}
      this._named[mapId] = !!(n && n.trim());
    }
    return this._named[mapId];
  },

  // Is this somewhere people live? Only a settlement's doors are worth describing as houses;
  // a shrine's side rooms just need telling apart, and calling them "Mozme's house" is nonsense.
  //
  // Judged on the map's OWN name first and only then its ancestors, because the editor tree puts
  // unrelated areas alongside each other — map 32 is a castle whose chain reads
  // "Branch Castle / Dungeon Flashback / Library / ...", and testing the whole chain at once let
  // a sibling folder's name veto a genuine castle.
  SETTLEMENT: /\b(town|city|village|capital|capitol|hamlet|castle|palace|keep|citadel|port|harbou?r|dock|inn|manor|estate)\b|burg\b|ville\b/i,
  DUNGEON: /\b(shrine|cave|cavern|ruins?|tower|temple|mine|mines|crypt|catacombs?|dungeon|lair|forest|woods|cliffs?|mountains?|pass|sewers?|tombs?|grotto|den|roost|volcano|basin|swamp|marsh|desert|island|falls|springs?|labyrinth|maze|trial|abyss|void|moon|stream)\b/i,

  _settle: {},
  isSettlement: function (mapId, destMapId) {
    var key = mapId + '>' + destMapId;
    if (this._settle[key] !== undefined) return this._settle[key];
    var out = false;
    try {
      var cur = mapId, guard = 0, decided = false;
      while (cur && $dataMapInfos[cur] && guard++ < 12) {
        var n = $dataMapInfos[cur].name || '';
        // Dungeon first: "Citadel Chocobo Forest" is a forest, not a citadel.
        if (this.DUNGEON.test(n)) { out = false; decided = true; break; }
        if (this.SETTLEMENT.test(n)) { out = true; decided = true; break; }
        cur = $dataMapInfos[cur].parentId;
      }
      // A proper noun that says neither — Valla, Meksicburg. If there is trade on either side of
      // the door, people live here. Both sides matter: Branch Castle's shops stand out on the
      // castle map itself rather than behind a door, and a town can be laid out either way.
      if (!decided) out = this._hasCommerce(mapId) || this._hasCommerce(destMapId);
    } catch (e) {}
    this._settle[key] = out;
    return out;
  },

  _commerce: {},
  _hasCommerce: function (mapId) {
    if (this._commerce[mapId] !== undefined) return this._commerce[mapId];
    var found = false;
    try {
      var m = this._map(mapId), evs = (m && m.events) || [];
      for (var i = 0; i < evs.length && !found; i++) {
        var ev = evs[i]; if (!ev) continue;
        var pages = ev.pages || [];
        for (var p = 0; p < pages.length; p++) {
          var codes = {}, list = pages[p].list || [];
          for (var c = 0; c < list.length; c++) codes[list[c].code] = true;
          if (codes[C.SHOP] || (codes[C.RECOVER] && codes[C.GOLD])) { found = true; break; }
        }
      }
    } catch (e) {}
    this._commerce[mapId] = found;
    return found;
  },

  _flags: function (tilesetId) {
    if (!this._tilesets) this._tilesets = this._json('Tilesets.json') || [];
    var ts = this._tilesets[tilesetId];
    return ts && ts.flags ? ts.flags : null;
  },

  _map: function (mapId) {
    if (this._maps[mapId] !== undefined) return this._maps[mapId];
    var num = String(mapId);
    while (num.length < 3) num = '0' + num;
    var m = this._json('Map' + num + '.json');
    // Keep only a couple parsed: the Overworld alone is 1.2 MB and a town's doors nearly all
    // point at the same interiors map anyway.
    this._maps[mapId] = m;
    this._mapOrder.push(mapId);
    while (this._mapOrder.length > 3) delete this._maps[this._mapOrder.shift()];
    return m;
  },

  // MV passability, read straight off the tile flags. A missing flags[] entry reads as 0 —
  // exactly what the engine does, and real walkable tiles in this game depend on it.
  _passer: function (m, flags) {
    var W = m.width, H = m.height, d = m.data;
    function tile(x, y, bit) {
      for (var z = 3; z >= 0; z--) {
        var f = flags[d[(z * H + y) * W + x]] | 0;
        if ((f & 0x10) !== 0) continue;
        return (f & bit) === 0;
      }
      return false;
    }
    return {
      W: W, H: H,
      counter: function (x, y) {
        if (x < 0 || y < 0 || x >= W || y >= H) return false;
        for (var z = 3; z >= 0; z--) {
          var f = flags[d[(z * H + y) * W + x]] | 0;
          if ((f & 0x10) !== 0) continue;
          return (f & 0x80) !== 0;
        }
        return false;
      },
      // Both tiles must agree, as Game_CharacterBase.isMapPassable requires.
      pass: function (x, y, dir) {
        var dx = dir === 6 ? 1 : dir === 4 ? -1 : 0, dy = dir === 2 ? 1 : dir === 8 ? -1 : 0;
        var x2 = x + dx, y2 = y + dy;
        if (x2 < 0 || y2 < 0 || x2 >= W || y2 >= H) return false;
        var BITS = { 2: 0x01, 4: 0x02, 6: 0x04, 8: 0x08 }, REV = { 2: 8, 8: 2, 4: 6, 6: 4 };
        return tile(x, y, BITS[dir]) && tile(x2, y2, BITS[REV[dir]]);
      },
    };
  },

  // Hitting MAX_ROOM does not mean the peek failed. It means the door does not open into a room
  // at all — it opens into a large connected space, and there is nothing a "what is in this room"
  // answer could usefully say about it.
  //
  // Measured, because the numbers look wrong until you check them: Darnecles' interior is ONE
  // 1,948-tile component, 89% of its map, and four of its seven doors land in it — the same
  // component from all four. Lenadia's main body is 5,166 tiles, 93% of its map. A town's houses
  // are sealed boxes reached only from the town map, which is why Valla resolves and these do not.
  // Raising the cap would not turn them into rooms; it would just describe most of a castle at
  // every door. Those landings are named in ROOMS instead.
  _room: function (g, sx, sy) {
    if (sx < 0 || sy < 0 || sx >= g.W || sy >= g.H) return null;
    var seen = {}, q = [[sx, sy]], n = 1;
    seen[sy * g.W + sx] = true;
    for (var i = 0; i < q.length; i++) {
      if (n > this.MAX_ROOM) return null;
      var cx = q[i][0], cy = q[i][1];
      for (var k = 0; k < DIRS.length; k++) {
        var d = DIRS[k], nx = cx + d.dx, ny = cy + d.dy;
        if (nx < 0 || ny < 0 || nx >= g.W || ny >= g.H) continue;
        var ni = ny * g.W + nx;
        if (seen[ni]) continue;
        if (!g.pass(cx, cy, d.d)) continue;
        seen[ni] = true; n++; q.push([nx, ny]);
      }
    }
    return seen;
  },

  // What is standing in that room. The approach test mirrors _goalIndex, counter arm included —
  // without it every shopkeeper and innkeeper behind a service counter is invisible, which is
  // why a first pass over this data found zero inns in a game that has 58.
  _contents: function (m, g, room) {
    var r = { shop: {}, shops: 0, inn: 0, save: 0, chest: 0, named: [], people: 0, service: '' };
    var evs = m.events || [];
    for (var i = 0; i < evs.length; i++) {
      var ev = evs[i];
      if (!ev) continue;
      if (!this._near(g, room, ev.x, ev.y)) continue;
      var pages = ev.pages || [];
      for (var p = 0; p < pages.length; p++) {
        var page = pages[p], list = page.list || [], codes = {};
        for (var c = 0; c < list.length; c++) codes[list[c].code] = true;
        if (codes[C.SHOP]) {
          // Same reader the current map uses, so a relic shop reads as one through a doorway too.
          var sk = BMA.Nav.shopKindOf(list);
          if (sk) r.shop[sk] = true;
          r.shops++; break;
        }
        if (codes[C.RECOVER] && codes[C.GOLD]) { r.inn++; break; }
        if (codes[C.SAVE]) { r.save++; break; }
        // Somebody performing a service is not somebody who lives here. Asked before the
        // resident test below, and before treasure, because the service is the more useful and
        // the more certain of the two — it is read off the script, whereas "whose house" is only
        // ever inferred from a speaker tag.
        var svc = BMA.Nav.serviceOf(page);
        if (svc) { if (!r.service) r.service = svc; break; }
        if (codes[C.ITEM] || codes[C.WEAPON] || codes[C.ARMOR] || codes[C.GOLD]) { r.chest++; break; }
        if (page.image && page.image.characterName && (codes[C.TEXT] || codes[C.CHOICE])) {
          r.people++;
          var nm = null;
          try { nm = BMA.Nav.speakerOf(page); } catch (e) {}
          if (!nm) {
            var en = (ev.name || '').trim();
            if (en && !/^EV\d+$/i.test(en) && !/^event$/i.test(en)) nm = en;
          }
          if (nm && this._isRank(nm)) nm = null;      // "Dragoon's house" is not a person's house
          if (nm && r.named.indexOf(nm) < 0) r.named.push(nm);
          break;
        }
      }
    }
    return r;
  },

  _near: function (g, room, x, y) {
    for (var dy = -1; dy <= 1; dy++) {
      for (var dx = -1; dx <= 1; dx++) {
        var nx = x + dx, ny = y + dy;
        if (nx < 0 || ny < 0 || nx >= g.W || ny >= g.H) continue;
        if (room[ny * g.W + nx]) return true;
      }
    }
    for (var k = 0; k < DIRS.length; k++) {
      var d = DIRS[k];
      if (!g.counter(x + d.dx, y + d.dy)) continue;
      var ax = x + 2 * d.dx, ay = y + 2 * d.dy;
      if (ax < 0 || ay < 0 || ax >= g.W || ay >= g.H) continue;
      if (room[ay * g.W + ax]) return true;
    }
    return false;
  },

  // A rank or a role is not a name. The speaker tag on generic dialogue is whatever the writer
  // typed above the line — "Dragoon", "Soldier", "Villager" — and naming a house after one reads
  // as though you knew who lived there. Class names come from the database so the list stays
  // right if the game changes; the rest are the ordinary crowd words.
  GENERIC_NAME: /^(soldier|guard|guardsman|villager|man|woman|boy|girl|old man|old woman|child|kid|knight|sailor|merchant|shopkeeper|clerk|maid|servant|priest|nun|elder|king|queen|prince|princess|lady|lord|sir|doctor|nurse|scholar|blacksmith|smith|innkeeper|barkeep|bartender|traveller?|adventurer|mercenary|captain|general|commander|lieutenant|sergeant|worker|miner|farmer|fisherman|hunter|dancer|bard|mage|wizard|witch|healer|cleric|archer|warrior|fighter|citizen|townsfolk|townsperson|person|people|stranger|figure|voice)$/i,

  _ranks: null,
  _isRank: function (name) {
    var k = String(name).trim().toLowerCase();
    if (!k) return true;
    if (this.GENERIC_NAME.test(k)) return true;
    if (!this._ranks) {
      this._ranks = {};
      try {
        var cl = window.$dataClasses || [];
        for (var i = 0; i < cl.length; i++) {
          if (cl[i] && cl[i].name) this._ranks[String(cl[i].name).trim().toLowerCase()] = true;
        }
      } catch (e) {}
    }
    return !!this._ranks[k];
  },

  _phrase: function (r, castle) {
    var kinds = Object.keys(r.shop);
    if (r.shops) return kinds.length === 1 ? kinds[0] : 'Shop';
    if (r.inn) return 'Inn';

    var extra = [];
    if (r.save) extra.push('save point');
    if (r.chest) extra.push(r.chest + (r.chest === 1 ? ' chest' : ' chests'));

    // One recognisable resident names the house; several, or none, and it is just a house with
    // a headcount — picking one of five arbitrarily would tell you who you are about to meet.
    //
    // What the room is *for* comes first, though. The Hunter who runs the Marks board was reading
    // as "Hunter's house", which is neither a house nor his; the moogle who ferries you somewhere
    // was "Momatose's house". A service is read off the script, whereas "whose house" is only ever
    // inferred from a speaker tag — so where the two disagree, the script wins.
    var head;
    if (r.service) head = r.service;
    else if (castle) {
      // Inside a castle nobody standing in a room is a resident of it, so the ownership claim
      // goes — but the counted facts stay, because they are counted rather than guessed. "Room,
      // 2 chests" instead of "Cid's house, 2 chests"; "Room, 6 chests" for the treasure chambers
      // of Faluhd, which is a ruin full of monsters and has no householders at all.
      if (r.people) head = 'Room, ' + r.people + (r.people === 1 ? ' person' : ' people');
      else if (extra.length) head = 'Room';
      else return 'Empty room';
    }
    else if (r.named.length === 1) head = r.named[0] + "'s house";
    else if (r.people) head = 'House, ' + r.people + (r.people === 1 ? ' person' : ' people');
    else if (extra.length) head = 'House';
    else return 'Empty house';

    return extra.length ? head + ', ' + extra.join(', ') : head;
  },

  // Does the destination's name tell these doors apart from each other?
  //
  // A placeholder ("Interiors") never did, which is the original rule. Neither does a name that
  // simply repeats the map the player is standing on: eleven doors in Tomra Castle all announcing
  // "To Tomra Castle" is the dungeon treatment applied to a castle, and it hides three shops, an
  // inn and the throne approach behind bare numbers.
  //
  // Branch Castle is untouched by the second half, and that is the point of writing it this way.
  // Its doors lead to Library, Quarters, Hall, Darius Training — names that say far more than
  // anything looking inside could — and none of them repeats "Branch Castle".
  namesNothing: function (srcMapId, destMapId) {
    try {
      if (this.isVagueDestination(destMapId)) return true;
      var a = BMA.MapNames.get(srcMapId) || (($dataMapInfos[srcMapId] || {}).name || '');
      var b = BMA.MapNames.get(destMapId) || (($dataMapInfos[destMapId] || {}).name || '');
      return !!a && a.toLowerCase() === b.toLowerCase();
    } catch (e) {}
    return false;
  },

  // A castle is a settlement — people live there, it has shops and an inn — but its rooms are not
  // houses and the people standing in them are not residents. Narrower than SETTLEMENT on purpose:
  // "citadel" and "port" name towns here, and their interiors really are somebody's home.
  CASTLE: /\b(castle|palace|keep|throne)\b/i,

  _castle: {},
  isCastle: function (mapId) {
    if (this._castle[mapId] !== undefined) return this._castle[mapId];
    var out = false;
    try {
      var cur = mapId, guard = 0;
      while (cur && $dataMapInfos[cur] && guard++ < 12) {
        if (this.CASTLE.test($dataMapInfos[cur].name || '')) { out = true; break; }
        cur = $dataMapInfos[cur].parentId;
      }
    } catch (e) {}
    this._castle[mapId] = out;
    return out;
  },

  // Anything the contents test can only ever have guessed at: whose house it is, or how many
  // people are in it. Shops, inns, save points and chests are counted off the commands and stay.
  _RESIDENCE: /^(.*'s house|House(,|$)|Empty house)/,

  // '' when there is nothing useful to say (unreadable map, or a destination too big to be a
  // room), so the caller keeps its own "To <place>" wording.
  label: function (destMapId, x, y) {
    var key = destMapId + ',' + x + ',' + y;
    if (this._labels[key] !== undefined) return this._labels[key];

    // Hand-authored first. A castle's rooms cannot be worked out by looking at who is standing in
    // them — see ROOMS — so where a name has been researched it is simply the answer.
    var hand = (BMA.Nav.ROOMS[destMapId] || {})[x + ',' + y];
    if (hand) { this._labels[key] = hand; return hand; }

    var out = '';
    try {
      var m = this._map(destMapId);
      if (m && m.data && m.width) {
        var flags = this._flags(m.tilesetId);
        if (flags) {
          var g = this._passer(m, flags);
          var room = this._room(g, x, y);
          if (room) out = this._phrase(this._contents(m, g, room), this.isCastle(destMapId));
        }
      }
    } catch (e) { BMA.Log.write('door peek threw for map ' + destMapId + ': ' + (e && e.message)); }

    this._labels[key] = out;
    return out;
  },
};

BMA.Nav = {
  // Rooms named by hand, keyed by the map the door lands on and the tile it lands you at.
  //
  // Everything else in this file works a name out from the data. This cannot be, and the attempt
  // is actively harmful: a castle's rooms are read by the same contents test that reads a town's,
  // and it reports a general standing in the guard hall outside the throne room as "Rickard's
  // house". That is not his house and not a house — and a wrong name is worse than "door 3",
  // which at least tells the player honestly that they do not know yet.
  //
  // So: shops, inns and save points stay automatic (those are read off commands and are right),
  // and the rooms that only a person can identify are written down. Researched from the map data
  // — who stands there, what they say, what the room connects to — not guessed from a sprite.
  //
  // Never a person's name. If the king is Donk, the room is the throne room, not Donk's.
  //
  // Branch Castle is deliberately absent: the game already gives its rooms real map names
  // (Library, Quarters, Hall, Weapons, Potion Storehouse), so there is nothing here to add and
  // anything written would override something better.
  ROOMS: {
    // --- Tomra Castle (258 outer, 281 the interior strip) ---
    // Entry from the Underworld lands at 26,53 on map 258; straight north up x=26 is the way to
    // the throne room, which is its own map (282) behind the last of these doors.
    281: {
      '10,15': 'Entrance hall',           // two greeters: "Lali-ho! Welcome to Tomra Castle!"
      '10,9':  'Entrance hall, upper',
      '126,14': 'Training hall, save point',   // "I'm trying to train-ho!", "You're gonna get hurt-ho!"
      '126,3':  'Training hall, upper',
      '192,14': 'Marks board',            // the Hunter: "Are you here to hunt a mark?"
      '192,3':  'Marks board, upper',
      '221,15': 'Throne approach',        // "Proceed through the next set of doors to enter the
                                          //  throne room-ho!", and the door to map 282 is here
    },

    // --- Lenadia Castle (166; every room is behind a doorway onto its own map) ---
    166: {
      '46,23':  'Records room, save point',  // Conrad: "I need to alphabetize this section of our
                                             //  records" — an archive, not his house
      '72,23':  'Infirmary',                 // two full-heal events; Albus teaches General
                                             //  Leonardo black magic as his guest
      '212,19': 'Throne approach',           // the only way on is the door to map 167 Throne Room
      // Five doorways onto one sealed 154-tile hall — the one holding the way out to Lenadia
      // City, so it is the entrance. They lead to the same place, so they say the same thing and
      // the player takes whichever is nearest.
      '23,18': 'Entrance hall', '5,18': 'Entrance hall', '19,14': 'Entrance hall',
      '9,14':  'Entrance hall', '14,8': 'Entrance hall',
      // These two open into the castle's main body: one connected 5,166-tile space, 93% of the
      // map. Not a room the peek can describe — see MAX_ROOM.
      '95,7': 'Main hall', '136,12': 'Main hall',
    },

    // --- Darnecles Castle (440 outer, 467 the interior) ---
    // The king's own room is map 468, which the game already names "Throne Room", so the exit
    // into it needs nothing from here.
    467: {
      '134,14': 'Throne approach',        // a sealed 65-tile room joining the castle to map 468
      // Four of the seven doors open into one connected 1,948-tile space — 89% of the map, and
      // provably the same component from all four. They are four ways into the castle's main
      // body, not four rooms, so they say so rather than being numbered.
      '60,14': 'Main hall', '74,4': 'Main hall', '96,8': 'Main hall', '108,14': 'Main hall',
    },

    // --- The Citadel's Castle Interior (364) ---
    // "This castle, not the town outside, is the actual Citadel."
    364: {
      '19,37': 'Main hall', '28,32': 'Main hall', '44,32': 'Main hall',
      '53,37': 'Main hall', '36,15': 'Main hall',
      '79,51':  'Scholars\' room',        // Bjorn, Cooper and Arvid arguing about Bahamut and
                                          //  Lord Zeul's magic research
      '148,52': 'Kitchen',                // Nora: "I've got some hungry bellies to feed!";
                                          //  "Nora's cooking is the best!"
      '231,45': 'Generals\' hall', '231,52': 'Generals\' hall',   // Braak and the other generals
    },

    // --- Faluhd Castle (118) ---
    // A ruin held by monsters rather than a court — "We've been trying to take Faluhd Castle from
    // the monsters". Its rooms are treasure chambers and the peek describes those perfectly well;
    // only the camp the soldiers hold needs a word, and three doorways open onto it.
    118: {
      '46,75': 'Soldiers\' camp', '73,84': 'Soldiers\' camp', '60,88': 'Soldiers\' camp',
    },

    // --- Pubs behind a shared "Interiors" door ---
    //
    // A pub is the one service in this game the commands cannot prove. It sells nothing through a
    // Shop Processing command and heals nobody, so the contents test runs out of evidence and
    // falls to its last resort: naming the room after whoever happens to be standing in it.
    // Bavira's read "Gretchen's house", and Gretchen is a customer complaining about the soldiers
    // drinking around her.
    //
    // Only these five need it. The six maps the editor actually calls "Pub" are reached by a
    // single door each, so the peek never runs on them and they already read "To Lantz Pub".
    // These are rooms inside a town's shared interiors map, where it does.
    //
    // Every one is read off the room: a Bartender, a pianist taking requests for 1 gil, and
    // drinkers. The chest counts are the true ones, and every automatic count was high — the
    // pianist's 1 gil is a Change Gold command and reads as treasure in all five, and Lindblum
    // adds a soldier who sells you an axe out of his own pocket.
    37:  { '135,14': 'Pub, 3 chests' },   // Meksicburg. Gordon: "our tavern doesn't get too many
                                          //  pirates"; Joan: "The ale's not too bad here"
    223: { '17,13':  'Pub, 1 chest' },    // Altair. Yosaku: "The rebellion is over! Drinks are on
                                          //  me!"; the Bartender talks Temple of Visions
    306: { '139,14': 'Pub, 1 chest' },    // Leyton. A Bartender with no line of his own, and
                                          //  Marigold at the piano — Arthur: "the best pianist"
    329: { '73,13':  'Pub, 3 chests' },   // Bavira. Bartender: "the pub will always remain open";
                                          //  Gretchen: "The pub is always so quiet now"
    // Inside a castle, so this one came out "Room, 5 people, 4 chests" rather than as somebody's
    // house — honest, and still not a room anyone could set out for. The Bartender says what it
    // is: "Regent Gran commissioned turning this old armory into a pub."
    206: { '88,16': 'Pub, 2 chests' },

    // --- Silvera's hunters (128) ---
    //
    // A Marks board the service test cannot see. Silvera spends the first half of the game
    // transformed, so page 0 of every event in this room is "The transformed villager tries to
    // communicate" — and the contents test stops at the first page of an event that matches
    // anything at all, which for the Hunter is that one. It counted him as a bystander and never
    // reached the page carrying his Galv.QUEST call, so the room took the name of Walton, who is
    // standing next to him. Every other Marks board in the game resolves by itself.
    128: { '146,14': 'Marks board' },
  },

  entities: [],
  scannedMap: -1,
  category: 'all',
  index: 0,
  _sel: null,          // pinned selection identity {ref,cat,x,y,name}; ref (the engine object) wins
  _seen: {},           // eventId -> {page, rec|null} — persistent per-event cache for the delta scan
  _lastCleftMode: null,
  _vehicleRecs: [],    // vehicle records, kept apart from _seen (vehicles have no event id)
  _groups: {},         // mapId -> {base -> sortedEventIds[]}; deterministic named-entity numbering
  _nameless: {},       // mapId -> {next:{cat}, byId:{eventId}}; per-category nameless numbering
  _custom: {},         // mapId -> {eventId -> "user label"}; persisted, overrides numbering
  _labelFs: null, _labelPath: null, _labelFile: null, _labelDirty: false,

  //---------------------------------------------------------------------------
  // Scanning & classification
  //---------------------------------------------------------------------------
  // A live delta scanner, ported from ff1-screen-reader: instead of one snapshot at map
  // load, the entity set is kept in sync as pages flip and NPCs spawn/move. scan() is the
  // full rebuild (map change / manual rescan); deltaScan() is the cheap incremental pass run
  // on every navigation. An MV event object persists across page changes, so the per-entity
  // dirty check is its active page index (ev._pageIndex) — the analogue of the reference's
  // "only convert new object refs".
  ensureScanned: function () {
    if (!$gameMap) return;
    if ($gameMap.mapId() !== this.scannedMap) this.scan();   // full rebuild on map change
    else this.deltaScan();                                    // incremental otherwise
  },

  scan: function () {
    this._seen = {};
    this._pushAt = {};                     // block positions belong to the map being left
    try {
      this._lastCleftMode = this._cleftMode($gameMap.mapId());
      this._groupsFor($gameMap.mapId());   // build/memoize deterministic name groups first
      var events = $gameMap.events();
      for (var i = 0; i < events.length; i++) {
        var ev = events[i];
        if (!ev) continue;
        var id = ev.eventId();
        var pi = ev._erased ? -1 : ev._pageIndex;
        this._seen[id] = { page: pi, rec: (pi < 0 ? null : this._makeRecord(ev)) };
      }
      this._syncVehicles();
      this._rebuildTransferTiles();
      this.entities = this._collectEntities();
      this._disambiguateDoors();
      this._numberDuplicates('door', 'door');
      this._numberDuplicates('event', null);
      // Only on success. Marking the map scanned after a throw sent every later call down the
      // deltaScan branch, so a scan that blew up was indistinguishable from a map with nothing
      // on it — silently, since this catch used to log nothing at all.
      this.scannedMap = $gameMap.mapId();
    } catch (e) {
      this.entities = [];
      BMA.Log.write('scan threw on map ' + (($gameMap && $gameMap.mapId()) || '?') + ': ' +
                    (e && (e.stack || e.message)));
    }
    this._clearFloods();
    this.index = 0;
  },

  // Incremental diff against the live event list. Cheap: a known event whose page has not
  // changed is skipped with a single integer compare; classify() re-runs only on a genuine
  // page flip (the throne-room reveal) or a fresh spawn.
  deltaScan: function () {
    var changed = false;
    try {
      // An approach marker changes door destinations without changing their active pages.
      if (this._lastCleftMode !== this._cleftMode($gameMap.mapId())) {
        this.scan();
        return;
      }
      var events = $gameMap.events();
      var live = {};
      for (var i = 0; i < events.length; i++) {
        var ev = events[i];
        if (!ev) continue;
        var id = ev.eventId();
        live[id] = true;
        var pi = ev._erased ? -1 : ev._pageIndex;
        var seen = this._seen[id];
        if (!seen || seen.page !== pi) {
          this._seen[id] = { page: pi, rec: (pi < 0 ? null : this._makeRecord(ev)) };
          changed = true;
        }
      }
      for (var sid in this._seen) {          // events that left the map
        if (!live[sid]) { delete this._seen[sid]; changed = true; }
      }
      if (this._pushMoved()) changed = true;
      if (this._syncVehicles()) changed = true;
      if (changed) {
        this._rebuildTransferTiles();
        this.entities = this._collectEntities();
        this._clearFloods();                 // membership changed -> pathfinding cache is stale
      }
    } catch (e) {}
  },

  // Has a push block been shoved since the last pass? eventId -> "x,y", seeded on first sight so
  // arriving on the map is never mistaken for a move.
  //
  // A block that slides changes what the map looks like without changing any page, so the integer
  // page compare above cannot see it — and the strict flood is cached on the PLAYER's tile, which
  // is exactly what does not change when they stand still and press the action button. Without
  // this, pushing a block open and asking again returned the flood from before the push: "Block 1
  // is in the way", about a corridor the player had just cleared, until they happened to take a
  // step. That is the whole of "the pathing isn't taking them into account" — the route was right
  // about a map that no longer existed.
  //
  // Push blocks only. Every other mover on a map is an NPC wandering, and re-flooding on each of
  // those would spend a BFS per wander step — on an Overworld that is ~230k tile visits — to
  // answer a question the relaxed flood already answers better ("X is standing in it"). A block
  // is different in kind: the player moved it deliberately, and expects the answer to have
  // changed because of what they just did.
  _pushAt: null,
  _pushMoved: function () {
    var at = this._pushAt || (this._pushAt = {}), moved = false;
    for (var id in this._seen) {
      var rec = this._seen[id] && this._seen[id].rec;
      if (!rec || !rec.push || !rec.ev) continue;
      var key = rec.ev.x + ',' + rec.ev.y, was = at[id];
      at[id] = key;
      if (was !== undefined && was !== key) moved = true;
    }
    return moved;
  },

  _collectEntities: function () {
    var out = [];
    for (var id in this._seen) { var rec = this._seen[id].rec; if (rec) out.push(rec); }
    return out.concat(this._vehicleRecs || []);
  },

  _makeRecord: function (ev) {
    var info = this.classify(ev);
    if (!info) return null;
    // 'Closed door' is the one kind inferred from shape rather than read out of the command that
    // defines it — it means "an inert blocker that transfers on some later page". When the thing
    // has said what it is, that wins. Naddaha Pyramid's three transfer-bearing sarcophagi were
    // announced as doors, which sends a player hunting for a door in a room whose only feature is
    // a stone coffin. Exactly three events in the game meet this; the other 57 closed doors say
    // nothing about themselves and keep the inferred name.
    var kind = info.kind;
    if (kind === 'Closed door' && this._selfDescribedName(ev.event())) kind = null;
    // overrideName is the one case where a name is discarded: classify has proved what the thing
    // is, and the name it would otherwise carry says something else. Only push blocks set it, and
    // only one shape of name goes — EDITOR_SHORTHAND, the "Nth of these" label a mapper types for
    // their own benefit. A word the data really does hold for the object survives: Mythril Mine's
    // 46 mine carts are named off the sound they make (see _routeSoundName, which exists for
    // them), and "Minecart 12" tells a player everything "Block 12" does and what it looks like
    // besides. A hand-typed label and the shipped LABELS table are read ahead of both and win.
    var base = kind ? null : this.entityName(ev, { kind: kind });
    if (info.overrideName && EDITOR_SHORTHAND.test(base || '')) base = '';
    var name = kind ? this._labelFor(ev, info.category, kind, null, info.singular)
                    : this._labelFor(ev, info.category, null, base, info.singular);
    // Say it in the name itself. A crossing whose landing spot cannot be worked out ahead of
    // time is still worth listing — it is often the way on — but the player has to hear that
    // it is a gamble before they use it, not after they have been dropped somewhere strange.
    if (info.warp === 'hazard') name += ', unpredictable';
    // Same reasoning for a trap: the cost belongs in the name, so it is heard while cycling
    // past it and in every route warning, not only if the player thinks to ask.
    if (info.trap) name += ', ' + this._trapEffect(info.trap);
    return { ev: ev, x: ev.x, y: ev.y, category: info.category, kind: info.kind,
             warp: info.warp || null, trap: info.trap || null, push: info.push || null,
             resets: info.resets || null, name: name };
  },

  // Shipped names for the few things nothing in the data can name correctly.
  //
  // The bar is deliberately high, because everything else here is read off the game rather than
  // written down: an entry earns its place only when the event says nothing about itself AND the
  // rules that would otherwise catch it would be WRONG, not merely silent. Six qualify, and all
  // six are the shared prop sprite in PROP_SPRITES, which would call them all "Glyph":
  //
  //   Life Shrine's clock. The centre of the ring, and what the twelve numerals mean when they
  //   say "Return to the center" — so it is named to match the instruction the player is given.
  //   Its own text is the riddle, which names nothing, and it has neither the Input Number the
  //   console rule wants nor the Show Choices the question rule wants.
  //
  //   The five Aether Crystal Shards, one per map. "The Aether Crystal Shard begins to glow" is
  //   narration rather than a prompt, so no rule reads it, and "Glyph" would be a plain lie.
  //
  // Keyed on event id, which is stable in the map data. Ranked below the player's own labels and
  // above everything automatic — a hand-typed name still wins.
  //
  // The casino's four desks are the second thing to qualify, and on the same terms. _counterKind
  // proves from the script that they ARE counters — that is what puts them in the shops list —
  // but nothing in the script says which game each one runs, so all four would answer to
  // "Casino counter". Four identical names for four different services is not silence, it is
  // wrong: it tells a player there is one desk here repeated, when one sells the tokens every
  // other game needs, one sells slot coins, one takes race bets and one runs the lotto. Their
  // speaker tags — Charles, Calla, Lester, Attendant — name the person and not the service, and
  // in a shops list that is no better. So the service is written down, from what each one says.
  LABELS: {
    293: { 11: 'Clock center' },                                    // Life Shrine
    537: { 4: 'Aether Crystal Shard' },                             // Mount Houzell
    543: { 1: 'Aether Crystal Shard' },                             // Entry
    549: { 4: 'Aether Crystal Shard' },                             // Cleft of Wind
    565: { 4: 'Aether Crystal Shard' },                             // Entry
    566: { 1: 'Aether Crystal Shard' },                             // Entry
    // Rotunda of Revelry — Jack's casino. Its slot machines and Blackjack tables name themselves
    // off their plugin commands and are not listed here.
    358: {
      35: 'Token counter',          // Calla: "They are required to play all games in the casino"
      21: 'Slot coin counter',      // Charles: "Do you wish to purchase slot coins?"
      29: 'Chocobo race betting',   // Lester: "Do you want to bet on a chocobo race?"
      92: 'Lotto counter',          // the Attendant: "Pick a number from 1 to 20 and see if you win"
    },
  },

  // Final display name for an entity. Custom label first, then the shipped table, then a
  // self-describing kind (exit/shop/save point), then a deterministic number for a duplicated
  // real name, then a per-category nameless fallback.
  // `singular` overrides the per-category word for things that share a category but are not the
  // same kind of thing — a pad you step on is not an "Object". It also keys the numbering, so
  // pads and objects on one map count 1,2,3 separately instead of interleaving into
  // "Pad 1, Object 2, Pad 3".
  _labelFor: function (ev, category, kind, base, singular) {
    var mapId = $gameMap.mapId(), id = ev.eventId();
    var cm = this._custom[mapId];
    if (cm && typeof cm[id] === 'string' && cm[id]) return cm[id];   // hand-typed label wins
    var shipped = this.LABELS[mapId];
    if (shipped && shipped[id]) return shipped[id];
    if (kind) return kind;
    if (base) {
      var n = this._namedNumber(mapId, ev, base);
      return n ? base + ' ' + n : base;                             // "Soldier 3", or "Soldier"
    }
    var word = singular || CAT_SINGULAR[category] || 'object';
    return word + ' ' + this._namelessNumber(mapId, id, singular || category);
  },

  // number(ev) = event-id rank within the map's same-name group. Because the group is built
  // from static map data (every event whose canonical name matches, active or not), the
  // number is identical on every player's machine and never shifts as pages activate — so
  // "talk to Soldier 3" transfers between players. Unique names get no number.
  _namedNumber: function (mapId, ev, base) {
    var ids = this._groupsFor(mapId)[base];
    if (!ids || ids.length < 2) return 0;
    var idx = ids.indexOf(ev.eventId());
    return idx < 0 ? 0 : idx + 1;
  },

  // Which tile is a chest is a property of the TILESET, not of one map, and some maps cannot
  // answer it about themselves: Weapons Tower's only two chests are both mimics, so there is no
  // real one there to compare against, and Jachol Cave and Tower 2 are the same. Derived from
  // every map in the game — a (tileset, tile) pair counts when at least two real treasure events
  // are drawn with it — and re-derived and asserted by tests/nav_traps.js, so a content patch
  // that changes the art fails a test rather than quietly un-hiding five mimics.
  CHEST_TILES: {
    2:[59], 3:[315], 4:[8,315], 5:[315], 7:[20,315], 8:[78,315], 9:[264], 11:[26,315],
    12:[8,45,46,315], 14:[8,315], 15:[12], 18:[315], 19:[315], 20:[315], 21:[315],
    22:[48,315], 23:[315,581], 26:[16,315], 30:[69], 32:[8,46], 35:[8], 36:[8], 37:[315],
    38:[315], 40:[315], 42:[315], 44:[315], 45:[59], 46:[315], 48:[315], 51:[315], 56:[1],
    57:[48], 58:[315], 64:[315], 67:[12], 68:[315], 69:[59], 71:[315], 74:[315,775],
    76:[315], 77:[315], 78:[8], 80:[315], 82:[315,581], 84:[69], 85:[23], 86:[315],
  },

  // The tile graphics this map draws its real treasure with, so an ambush wearing one can be
  // recognised as the chest it appears to be. Static map data, so memoised per map alongside
  // the name groups.
  _chestTiles: {},
  _chestTilesFor: function (mapId) {
    if (this._chestTiles[mapId]) return this._chestTiles[mapId];
    var tiles = {};
    try {
      var events = $gameMap.events();
      for (var i = 0; i < events.length; i++) {
        var data = events[i] && events[i].event && events[i].event();
        var pages = (data && data.pages) || [];
        for (var p = 0; p < pages.length; p++) {
          var page = pages[p], img = page.image || {};
          if (page.trigger !== 0 || img.characterName || !(img.tileId > 0)) continue;
          var reward = false, battle = false, list = page.list || [];
          for (var j = 0; j < list.length; j++) {
            var c = list[j].code;
            if (c === C.GOLD || c === C.ITEM || c === C.WEAPON || c === C.ARMOR) reward = true;
            if (c === C.BATTLE) battle = true;
          }
          if (reward && !battle) tiles[img.tileId] = true;
        }
      }
    } catch (e) {}
    return (this._chestTiles[mapId] = tiles);
  },

  // Is this ambush wearing a chest? The map is asked first, because evidence read live can never
  // go stale; the tileset table answers for the maps that have no real chest of their own to
  // compare against.
  _looksLikeTreasure: function (page) {
    try {
      var img = page.image || {};
      if (img.characterName || !(img.tileId > 0)) return false;
      if (this._chestTilesFor($gameMap.mapId())[img.tileId]) return true;
      var known = this.CHEST_TILES[$gameMap.tilesetId()];
      return !!known && known.indexOf(img.tileId) >= 0;
    } catch (e) { return false; }
  },

  _groupsFor: function (mapId) {
    if (this._groups[mapId]) return this._groups[mapId];
    var groups = {};
    try {
      var events = $gameMap.events();
      for (var i = 0; i < events.length; i++) {
        var ev = events[i];
        if (!ev) continue;
        var base = this._canonBase(ev);
        if (!base) continue;
        (groups[base] || (groups[base] = [])).push(ev.eventId());
      }
      for (var b in groups) groups[b].sort(function (a, c) { return a - c; });
    } catch (e) {}
    this._groups[mapId] = groups;
    return groups;
  },

  // The verbs this game uses when it asks you to act on a piece of scenery, and the noun each
  // one governs. That noun is the only description of the object a player will ever be given:
  // the editor left all 18 of Naddaha Pyramid's sarcophagi named EV024, EV026, EV028 and so on,
  // with no speaker and no sprite, so "Break this sarcophagus?" is the only place the word
  // "sarcophagus" exists. Without this they cycle as "Object 3", "Enemy 5" and "Portal 2" —
  // eighteen identical stone boxes scattered across three lists under three different nouns.
  //
  // Anchored on a following ?/./!/, so it takes the noun phrase and stops, rather than running
  // on through the rest of the sentence.
  //
  // "ignite" and "fit into" are here for the socket puzzles, which _paysOut has just stopped
  // calling chests and which would otherwise arrive with no word of their own at all. Between
  // them they cover both halves of how this game words one: "Ignite these brazier?" is South Map's
  // eight, and "A Cyclone Core could fit into this impression." is Floating Ruins' five — the
  // second of which never asks a question the noun sits inside, so the full stop is what ends it.
  // "these" and "those" come in with them, for the same sentence.
  _PROMPT_NOUN: /\b(?:break|open|search|pull|push|activate|touch|read|examine|inspect|silence|light|move|climb|ignite|fit into)\s+(?:this|that|these|those|the|an|a)\s+([A-Za-z][A-Za-z '\-]{2,28}?)\s*[?.!,]/i,

  // The other way a thing says what it is: as the subject of a sentence about itself, rather than
  // as the object of a verb aimed at the player. Anchored at the start of the text so it takes the
  // thing being described and not a noun from the middle of a speech. See _selfDescribedName,
  // where the two-word minimum that keeps this honest lives.
  _SUBJECT_NOUN: /^(?:The|A|An)\s+([a-z][a-z '\-]{2,28}?)\s+(?:is|are|has|have|stands|sits|lies|appears|looks|seems|glows|shimmers|rests)\b/,

  // A switch flip and the dressing that goes with it — a sound, a flash, a wait, a self-switch
  // to spend itself on, a move route on its own graphic. An event whose entire page is this and
  // nothing else is the thing that opens something somewhere else.
  _LEVER_CODES: { 121:1, 122:1, 123:1, 205:1, 212:1, 213:1, 224:1, 225:1, 230:1, 241:1, 242:1,
                  249:1, 250:1, 505:1 },

  // The same bookkeeping, plus the conditional wrapper a delegating event tends to sit inside.
  _DELEGATE_CODES: { 111:1, 411:1, 412:1, 121:1, 122:1, 123:1, 205:1, 212:1, 213:1, 224:1,
                     225:1, 230:1, 241:1, 242:1, 249:1, 250:1, 505:1 },

  // An event whose page is only bookkeeping around a single Common Event call has no behaviour
  // of its own — it *is* that common event, and has to be read as one.
  //
  // This is where 140 of this game's chests were hiding. Their pages set a variable, flip a
  // switch and call "Infinitarium Chests" or "Miasma Stream Chest 1"; the gold and the items are
  // all inside the common event, so nothing on the page itself looks like treasure and every one
  // of them cycled as "Object N", in the objects list rather than with the chests.
  //
  // Deliberately narrow: exactly one call, and nothing else that does anything. An event that
  // talks *and* calls a common event is doing something of its own and is left alone.
  _delegatedTo: function (list) {
    try {
      var found = null;
      for (var i = 0; i < list.length; i++) {
        var code = list[i].code;
        if (code === 0 || code === 108 || code === 408) continue;
        if (code === C.COMMON) {
          if (found !== null) return null;         // two calls is not a plain delegation
          found = list[i].parameters[0];
          continue;
        }
        if (!this._DELEGATE_CODES[code]) return null;
      }
      if (found === null) return null;
      var all = window.$dataCommonEvents;
      var ce = all && all[found];
      return (ce && ce.list) ? ce : null;
    } catch (e) {}
    return null;
  },

  // The common nouns an editor puts in a common event's name, and their singulars. The trailing
  // index ("Miasma Stream Chest 1") is the editor keeping several copies apart, not part of what
  // the thing is called.
  _CE_NOUNS: { chest:'chest', chests:'chest', door:'door', doors:'door', gate:'gate',
               gates:'gate', lever:'lever', levers:'lever', switch:'switch', switches:'switch' },

  // "Infinitarium Chests" -> "Infinitarium chest", "Miasma Stream Chest 1" -> "Miasma Stream
  // chest". The common noun goes lowercase so the place name in front of it keeps its capital.
  _commonEventNoun: function (name) {
    var m = String(name || '').trim().match(/^(.*?)\s*([A-Za-z]+)\s*\d*$/);
    if (!m) return '';
    var noun = this._CE_NOUNS[m[2].toLowerCase()];
    if (!noun) return '';
    var pre = m[1].trim();
    return pre ? pre + ' ' + noun : noun.charAt(0).toUpperCase() + noun.slice(1);
  },

  // What to call a scripted scene without giving it away.
  //
  // The first speaker names one everywhere else in the mod, and here that is the worst possible
  // answer: 20 of the 35 are a boss opening their mouth, so the tile came out "Yiazmat 2",
  // "Ultros 2", "Gilgamesh 2", "Archareon 1", "??????". The tile is invisible. A sighted player
  // walks the corridor and sees nothing, so a name that says what is about to jump out is a
  // warning nobody else gets — the same rule that keeps mimics filed as chests.
  //
  // What is safe is who is doing the talking, at the coarsest grain that is still worth hearing:
  //
  //   Party conversation  only the party speaks. Four of them, Aether Mine's among them.
  //   Conversation        somebody who is not in the party has a line. Twenty-eight, and which
  //                       of them is a boss and which is a rebel guard stays where the game
  //                       put it.
  //   Scene               nobody is tagged at all — narration, three of them.
  //
  // Deliberately not finer. "The party meets a stranger" versus "a stranger speaks alone" is a
  // real distinction in the data and a tell in the game: the second is nearly always an ambush.
  _sceneKind: function (page) {
    try {
      var list = (page && page.list) || [], seen = {}, any = false, outsider = false;
      for (var i = 0; i < list.length; i++) {
        if (list[i].code !== C.TEXT_CONT && list[i].code !== 405) continue;
        var raw = String(list[i].parameters[0]), who = '', m, r;
        for (r = 0; r < this._SPEAKER_RAW.length && !who; r++) {
          m = raw.match(this._SPEAKER_RAW[r]);
          if (m) who = m[1].trim();
        }
        if (!who) {
          m = BMA.Util.cleanText(raw).match(this._SPEAKER_CLEAN);
          if (m) who = m[1].trim();
        }
        if (!who || seen[who]) continue;
        seen[who] = true;
        any = true;
        if (!this._isPartyActor(who)) outsider = true;
      }
      if (!any) return 'Scene';
      return outsider ? 'Conversation' : 'Party conversation';
    } catch (e) { return 'Scene'; }
  },

  // No words of its own, but a sound. Mythril Mine's 46 mine carts are a move route that plays
  // "Minecart" and does nothing else — the SE name is the only place the word exists in the data.
  _routeSoundName: function (pages) {
    try {
      // A sound names the thing you can see making it. Where nothing is drawn on any page there
      // is no thing, and the sound is just the scene's own noise: Inner's Quetzalcoatl cutscene
      // would be called "Monster3" and Map 3's ambush "Jump", both of them SE filenames.
      var drawn = false, q;
      for (q = 0; q < pages.length; q++) {
        var qi = pages[q].image || {};
        if (qi.characterName || qi.tileId > 0) { drawn = true; break; }
      }
      if (!drawn) return '';
      for (var p = 0; p < pages.length; p++) {
        var list = pages[p].list || [];
        for (var i = 0; i < list.length; i++) {
          if (list[i].code !== C.MOVE_ROUTE) continue;
          var route = list[i].parameters[1];
          var steps = (route && route.list) || [];
          for (var s = 0; s < steps.length; s++) {
            if (steps[s].code !== ROUTE_PLAY_SE) continue;
            var se = steps[s].parameters && steps[s].parameters[0];
            var nm = se && se.name;
            if (!nm) continue;
            nm = String(nm).replace(/[_\-]+/g, ' ').trim();
            // Sounds that describe the act rather than the thing name nothing useful.
            if (/^(open|close|door|switch|chest|move|push|jump|fall|se\d*|system|cursor|ok|cancel|buzzer)$/i.test(nm))
              continue;
            // Nor does an index into the sound folder. A digit means a numbered variant of a
            // bank — "ff6fall", "Moogle2", "Monster3" — which is a filename, not a word for the
            // thing. This rule produced five distinct names across the game: "Minecart" (46 of
            // them, and the reason it exists) and "Chocobo" survive; "ff6fall" and "Moogle2" go
            // here, and "Jump" to the act list above.
            if (/\d/.test(nm)) continue;
            return nm.charAt(0).toUpperCase() + nm.slice(1);
          }
        }
      }
    } catch (e) {}
    return '';
  },

  // A keypad names itself by what it asks for. The Fey Spire's three security consoles are the
  // only Input Number prompts in this game, and they carry no noun a verb governs — the text is
  // "Input 2F Security Clearance Code", so _PROMPT_NOUN finds nothing to take.
  _numberPromptName: function (pages, text) {
    try {
      for (var p = 0; p < pages.length; p++) {
        var list = pages[p].list || [];
        for (var i = 0; i < list.length; i++) {
          if (list[i].code === C.NUM_INPUT)
            return /\bsecurity\b/i.test(text || '') ? 'Security console' : 'Console';
        }
      }
    } catch (e) {}
    return '';
  },

  // Text, a sound to go with it, and nothing else: a thing you read. The Fey Spire's three posted
  // clearance codes are the case that matters — they carry the numbers the security consoles ask
  // for, so they are the most useful objects on the floor, and they were cycling as "Object N".
  //
  // Two guards keep this off people. It requires no character sprite on any page, so it only ever
  // fires on tile-drawn scenery; and it requires the event to do nothing at all besides talk — no
  // transfer, battle, reward, shop, choice, switch or variable — so an NPC without a speaker tag
  // is not renamed after their opening line.
  //
  // The name is the first few words. This game writes "2F\.\.\.\. Security\.\.\.\. Clearance"
  // where each `\.` is a wait code and the period after it is drawn, so the ellipses survive
  // cleanText correctly and have to be collapsed here rather than stripped there.
  _SIGN_OK: { 101:1, 401:1, 405:1, 230:1, 250:1, 241:1, 242:1, 249:1, 212:1, 213:1 },
  _signName: function (pages) {
    try {
      var text = [];
      for (var p = 0; p < pages.length; p++) {
        if (pages[p].image && pages[p].image.characterName) return '';   // it is a person
        var list = pages[p].list || [];
        for (var i = 0; i < list.length; i++) {
          var code = list[i].code;
          if (code === 0 || code === 108 || code === 408) continue;
          if (code === 401 || code === 405) { text.push(String(list[i].parameters[0])); continue; }
          if (!this._SIGN_OK[code]) return '';                            // it does something
        }
      }
      var t = BMA.Util.cleanText(text.join(' '));
      if (!t) return '';
      t = t.replace(/\.{2,}/g, ' ').replace(/\s+/g, ' ').trim();          // drawn ellipses

      // A sign identifies itself; it does not read itself out. Putting "324" in the label hands
      // the player the answer straight out of the cycling list, when a sighted player has to walk
      // up to the plaque and read it — the same rule that keeps a sarcophagus from announcing the
      // fight inside it. The floor is dropped with the number for the same reason: which code
      // this is, is part of the puzzle.
      if (/\bsecurity\b[\s\S]*\bcode\b/i.test(t)) return 'Security Code';
      // Nothing else in this game reaches here with a value in it, but strip bare numbers anyway
      // so a future sign cannot leak one by accident.
      t = t.replace(/\b\d+\b/g, ' ').replace(/\s+/g, ' ').trim();
      if (!t) return '';

      var words = t.split(' ').slice(0, 5), out = '';
      for (var w = 0; w < words.length; w++) {
        var next = out ? out + ' ' + words[w] : words[w];
        if (next.length > 34) break;
        out = next;
      }
      out = out.replace(/[.,;:!?]+$/, '').trim();
      if (out.length < 3) return '';
      return out.charAt(0).toUpperCase() + out.slice(1);
    } catch (e) {}
    return '';
  },

  // A question the player is asked, taken whole. "Return to the surface?" is not a noun phrase
  // any verb governs, so _PROMPT_NOUN cannot reach it — but it is still the only description of
  // the thing there is, and it says exactly what using it does. Requires the choice that follows,
  // so a line of ordinary dialogue that happens to end in a question mark is not mistaken for a
  // label, and is length-capped so a speech does not become a name.
  _questionName: function (pages) {
    try {
      for (var p = 0; p < pages.length; p++) {
        var list = pages[p].list || [], text = null;
        for (var i = 0; i < list.length; i++) {
          var code = list[i].code;
          if (code === C.TEXT_CONT || code === 405) {
            var line = BMA.Util.cleanText(String(list[i].parameters[0]));
            if (line) text = (text ? text + ' ' : '') + line;
            continue;
          }
          if (code === C.TEXT || code === 0 || code === 108 || code === 408) continue;
          if (code === C.CHOICE && text) {
            var q = text.trim();
            if (/\?$/.test(q) && q.length <= 44 && q.split(/\s+/).length <= 7) {
              q = q.replace(/\s*\?+$/, '').trim();
              if (q) return q.charAt(0).toUpperCase() + q.slice(1);
            }
          }
          text = null;                       // anything else ends the run this text belonged to
        }
      }
    } catch (e) {}
    return '';
  },

  // What the event calls itself when the editor left it anonymous. Page-independent on purpose:
  // a sarcophagus that has already been broken is still a sarcophagus, and its spent page says
  // nothing at all.
  _selfDescribedName: function (data) {
    try {
      var pages = (data && data.pages) || [], p, i, m;
      for (p = 0; p < pages.length; p++) {
        var list = pages[p].list || [], text = [];
        for (i = 0; i < list.length; i++) {
          if (list[i].code === C.TEXT_CONT || list[i].code === 405) text.push(String(list[i].parameters[0]));
        }
        if (!text.length) continue;
        m = BMA.Util.cleanText(text.join(' ')).match(this._PROMPT_NOUN);
        if (m) {
          var noun = m[1].trim().replace(/\s+/g, ' ');
          return noun.charAt(0).toUpperCase() + noun.slice(1);
        }
      }
      // Nothing a verb governs, but it may still name itself as the subject of its own sentence.
      // "The knight statue is facing the Symbol of Life." is Osteinchyl's rotation puzzle telling
      // the player, in the only place the word exists, what the thing in front of them is; without
      // this all three statues cycle as "Object 1".."Object 3" next to the three switches that
      // turn them, which reads as six things of two kinds with nothing to connect them.
      //
      // Two words minimum, and that is not a nicety. Thirteen events in the game match this shape
      // and the one-word half of them are all things classify has already worked out from what
      // they do — "The door is locked!", "An auction is about to start!" — where the noun adds
      // nothing and takes something away: Osteinchyl's own three sealed doors say "The door is
      // sealed through magical means", and _makeRecord drops the 'Closed door' kind for any door
      // that describes itself, so a bare "Door 1" would cost the player the word "closed" on the
      // three doors this very puzzle opens. The multi-word half is the identity and nothing else
      // carries it: the three statues, and the Rotunda's lotto seats.
      for (p = 0; p < pages.length; p++) {
        var plist = pages[p].list || [], ptext = [];
        for (i = 0; i < plist.length; i++) {
          if (plist[i].code === C.TEXT_CONT || plist[i].code === 405) ptext.push(String(plist[i].parameters[0]));
        }
        if (!ptext.length) continue;
        m = BMA.Util.cleanText(ptext.join(' ')).match(this._SUBJECT_NOUN);
        if (m && m[1].trim().split(/\s+/).length >= 2) {
          var subj = m[1].trim().replace(/\s+/g, ' ');
          return subj.charAt(0).toUpperCase() + subj.slice(1);
        }
      }

      // The next four each answer "what is this?" from a different part of the event, in
      // descending order of how directly they say it.
      var all = [];
      for (p = 0; p < pages.length; p++) {
        var pl = pages[p].list || [];
        for (i = 0; i < pl.length; i++) {
          if (pl[i].code === C.TEXT_CONT || pl[i].code === 405) all.push(String(pl[i].parameters[0]));
        }
      }
      var joined = BMA.Util.cleanText(all.join(' '));

      // Delegating to a common event the editor already named for what it is.
      for (p = 0; p < pages.length; p++) {
        var ce = this._delegatedTo(pages[p].list || []);
        if (!ce) continue;
        var cn = this._commonEventNoun(ce.name);
        if (cn) return cn;
      }

      var np = this._numberPromptName(pages, joined);
      if (np) return np;

      var qn = this._questionName(pages);
      if (qn) return qn;

      // No words of its own. If all it does is throw a switch, that is what it is — but only
      // when you have to reach out and do it. A page that fires by being STOOD on is a pressure
      // pad, and classify() already names those 'Pad'; "Lever 3" sends a player hunting for a
      // handle on a wall when the thing is under their feet. It is not a nicety: Esto Yensa's ten
      // spike switches and Archareon Prison's four pads ARE the objective of their maps, and they
      // came out as ten Levers beside two Pads — the two that happen to carry a conditional, so
      // this rule missed them — which reads as twelve things of two different kinds.
      for (p = 0; p < pages.length; p++) {
        if (pages[p].trigger === 1 || pages[p].trigger === 2) continue;
        var cmds = pages[p].list || [], flips = false, only = true;
        for (i = 0; i < cmds.length; i++) {
          var code = cmds[i].code;
          if (code === 0 || code === 108 || code === 408) continue;
          if (code === C.SWITCH || code === C.SELF_SW) flips = true;
          if (!this._LEVER_CODES[code]) { only = false; break; }
        }
        if (flips && only) return 'Lever';
      }

      // Last resort: a sound it makes. Weakest evidence, so it goes behind everything that
      // actually says something.
      var rs = this._routeSoundName(pages);
      if (rs) return rs;

      var sg = this._signName(pages);
      if (sg) return sg;

      // Nothing it says or does identifies it, but its picture might. Last of all, so anything
      // that names itself still wins — the Rift Shrine teleporter keeps "Teleport to the Rift
      // Shrine" from its own prompt, and the Aether Crystal Shards are named outright in LABELS.
      for (p = 0; p < pages.length; p++) {
        var ps = this._propSprite(pages[p]);
        if (ps) return ps;
      }
    } catch (e) {}
    return '';
  },

  // Sprites that are not people.
  //
  // MV has one notion of "drawn with a character sheet", and the mod reads it as "a person is
  // standing here" — which is right for all but a handful of sheets, and this game reuses one of
  // its townsfolk sheets for a prop. BPR_008 is Hunter, Nurse, Pirate, Taol, Dion, Hans and a
  // second Pirate, and frame 4 is a glowing rune: it is Gulgur Volcano's five sealing glyphs
  // ("Glyph begone!"), the guardians that fight when you touch them in Faluhd Castle and the Boss
  // Rooms, Esto Yensa's pair, the Aether Crystal Shards, and the centre of Life Shrine's clock.
  //
  // Keyed on the art, the way _looksLikeTreasure reads a chest off the tileset rather than off a
  // list of names. Two things follow from an entry: the thing stops being filed as a person, so
  // it lands in objects rather than among the NPCs — and, for the twelve that start a fight, in
  // objects rather than among the enemies, which is the sarcophagus rule. Nothing on the map
  // tells a sighted player which glyphs are guardians, and no map in this game holds both kinds,
  // so listing the armed ones separately would hand out a warning nobody else gets.
  PROP_SPRITES: { 'BPR_008#4': 'Glyph' },

  _propSprite: function (page) {
    try {
      var img = (page && page.image) || {};
      if (!img.characterName) return '';
      return this.PROP_SPRITES[img.characterName + '#' + img.characterIndex] || '';
    } catch (e) { return ''; }
  },

  // A page-independent canonical name from the event's data, so a switch-gated duplicate is
  // grouped the same before and after its page activates, and identically on every machine.
  // Mirrors entityName's precedence (speaker tag, then a meaningful editor name) but scans
  // all pages instead of only the active one.
  _canonBase: function (ev) {
    try {
      var data = ev.event();
      if (!data) return '';
      var pages = data.pages || [];
      for (var p = 0; p < pages.length; p++) {
        var sp = null;
        try { sp = this.speakerOf(pages[p]); } catch (e) {}
        if (sp) { if (this._isPartyActor(sp)) break; return sp; }
      }
      var nm = data.name;
      if (nm && nm.trim() && !/^EV\d+$/i.test(nm.trim()) && !/^event$/i.test(nm.trim())) return nm.trim();
      // Last, so anything the dev did name keeps its own name. Grouping on the self-described
      // name is what numbers the sarcophagi 1..18 in event order, the same on every machine.
      return this._selfDescribedName(data);
    } catch (e) {}
    return '';
  },

  // Nameless fallback ("NPC 3"): per-category counter in event-id order, cached by event id
  // for the session so a given event keeps its number across re-entry. Best-effort across
  // machines (a fallback set can differ); the custom labeller pins anything that matters.
  _namelessNumber: function (mapId, id, category) {
    var store = this._nameless[mapId] || (this._nameless[mapId] = { next: {}, byId: {} });
    if (store.byId[id] != null) return store.byId[id];
    var n = (store.next[category] || 0) + 1;
    store.next[category] = n;
    return (store.byId[id] = n);
  },

  _syncVehicles: function () {
    var recs = [];
    try {
      if ($gameMap.vehicles) {
        ['boat','ship','airship'].forEach(function (v) {
          var veh = $gameMap.vehicle(v);
          if (veh && veh._mapId === $gameMap.mapId() && (veh.pos || veh._x != null)) {
            recs.push({ veh: veh, x: veh.x, y: veh.y, category: 'vehicle',
                        name: v.charAt(0).toUpperCase() + v.slice(1) });
          }
        });
      }
    } catch (e) {}
    var changed = recs.length !== (this._vehicleRecs ? this._vehicleRecs.length : 0);
    this._vehicleRecs = recs;
    return changed;
  },

  // "x,y" -> true for tiles with a transfer on the ACTIVE page, so wall tones skip doorways.
  _rebuildTransferTiles: function () {
    this._transferTiles = {};
    try {
      var events = $gameMap.events();
      for (var i = 0; i < events.length; i++) {
        var ev = events[i];
        if (!ev || ev._erased) continue;
        if (this._hasTransfer(ev)) this._transferTiles[ev.x + ',' + ev.y] = true;
      }
    } catch (e) {}
  },

  // Refresh each record's coordinates from its live engine object, so a moving NPC re-sorts
  // and re-announces at its current tile with no rescan. Called at the top of filtered().
  _syncPositions: function () {
    var list = this.entities;
    for (var i = 0; i < list.length; i++) {
      var e = list[i];
      if (e.ev) { e.x = e.ev.x; e.y = e.ev.y; }
      else if (e.veh) { e.x = e.veh.x; e.y = e.veh.y; }
    }
  },

  // Does ANY page of this event open the save screen? See classify() for why this cannot
  // be judged from the active page.
  _hasSaveCommand: function (ev) {
    try {
      var pages = ev.event() && ev.event().pages;
      if (!pages) return false;
      for (var p = 0; p < pages.length; p++) {
        var list = pages[p].list || [];
        for (var i = 0; i < list.length; i++) if (list[i].code === C.SAVE) return true;
      }
    } catch (e) {}
    return false;
  },

  // Does the ACTIVE page transfer the player? Used for the wall-tone doorway cache.
  _hasTransfer: function (ev) {
    try {
      var page = ev.page();
      if (!page) return false;
      var list = page.list || [];
      for (var i = 0; i < list.length; i++) if (list[i].code === C.TRANSFER) return true;
    } catch (e) {}
    return false;
  },

  // Does ANY page transfer? Identifies a shut door whose open state lives on a later page.
  // Does the shut thing open onto a DIFFERENT map? Read across every page, because the whole point
  // of a closed door is that the Transfer lives on a page some switch elsewhere turns on.
  //
  // Only a destination the data actually states counts. A variable-designated Transfer cannot be
  // resolved without running the event, and guessing "probably off-map" would move a doorway into
  // the exits list on no evidence — so those stay doors, which is what they were before.
  // Any page leaving the map settles it: a way out is the more important fact about a thing that
  // does both.
  _closedDoorLeavesMap: function (ev) {
    try {
      var pages = (ev.event() && ev.event().pages) || [];
      var here = $gameMap.mapId();
      for (var p = 0; p < pages.length; p++) {
        var list = pages[p].list || [];
        for (var i = 0; i < list.length; i++) {
          if (list[i].code !== C.TRANSFER) continue;
          var q = list[i].parameters || [];
          if (q[0] !== 0) continue;                 // destination held in variables: unknowable
          if (q[1] !== here) return true;
        }
      }
    } catch (e) {}
    return false;
  },

  _hasTransferOnAnyPage: function (ev) {
    try {
      var pages = ev.event() && ev.event().pages;
      if (!pages) return false;
      for (var p = 0; p < pages.length; p++) {
        var list = pages[p].list || [];
        for (var i = 0; i < list.length; i++) if (list[i].code === C.TRANSFER) return true;
      }
    } catch (e) {}
    return false;
  },

  // Something lying on the ground, rather than somebody standing on it.
  //
  // 298 events in this game hand over goods off a character sprite and then erase themselves.
  // 256 of them are one frame of BPR_V — which is also the save crystal, so the art proves
  // nothing — and they are the game's dropped items: "An item was dropped here!" then
  // "Obtained Mega Potion!". "A sprite that talks and pays out is an NPC who gives you a gift"
  // took every one, so each Overworld read out around fifty "NPC 1..57" that are not people and
  // are not where anybody is, while the loot they are was in no list a player looks for loot in.
  //
  // What separates them from a gift-giver is not the picture, it is that the thing is CONSUMED.
  // Somebody who hands you something is still standing there afterwards; these switch to a page
  // with no graphic and no commands at all, gated on the very switch the payout turned on, and
  // cease to exist. Three more clauses keep the people out, and each is a real population:
  //
  //   nobody speaks   Brindle charges 10,000 gil for his services and the Lindblum soldier hands
  //                   over 1,000 for helping; both walk off afterwards, and both have a speaker
  //                   tag. All 298 of these are narration, which names nobody.
  //   no battle       the eight optional dragons drop an item as they die and are drawn on a
  //                   monster sheet. They are enemies, whatever else they do.
  //   not autorun     Bosche's recruitment scene ends with him forcing his way into the party.
  //                   It plays itself; it is not a thing anybody walks up to.
  _isDroppedItem: function (ev, page) {
    try {
      if (page.trigger === 3 || page.trigger === 4) return false;
      var list = page.list || [], i, c, q;
      for (i = 0; i < list.length; i++) if (list[i].code === C.BATTLE) return false;
      var pages = (ev.event() && ev.event().pages) || [];
      for (i = 0; i < pages.length; i++) if (this.speakerOf(pages[i])) return false;

      // The switches this page spends. A pickup pays out and marks itself taken in one go.
      var sw = {}, self = {}, s;
      for (i = 0; i < list.length; i++) {
        c = list[i]; q = c.parameters || [];
        if (c.code === C.SWITCH && q[2] === 0) { for (s = q[0]; s <= q[1]; s++) sw[s] = true; }
        else if (c.code === C.SELF_SW && q[1] === 0) self[q[0]] = true;
      }
      for (var p = 0; p < pages.length; p++) {
        var pg = pages[p];
        if (pg === page) continue;
        var img = pg.image || {};
        if (img.characterName !== '' || img.tileId > 0) continue;     // still drawn: still there
        var meaningful = 0, pl = pg.list || [];
        for (i = 0; i < pl.length; i++) {
          var code = pl[i].code;
          if (code !== 0 && code !== 108 && code !== 408) meaningful++;
        }
        if (meaningful) continue;
        var cond = pg.conditions || {};
        if ((cond.switch1Valid && sw[cond.switch1Id]) ||
            (cond.switch2Valid && sw[cond.switch2Id]) ||
            (cond.selfSwitchValid && self[cond.selfSwitchCh])) return true;
      }
    } catch (e) {}
    return false;
  },

  // Does this page add or remove party members? Change Party Member, or the script form —
  // Esto Yensa's own party switcher uses $gameParty.addActor for the slots it holds in variables.
  _PARTY_SCRIPT: /\$gameParty\s*\.\s*(add|remove)Actor\b/,
  _changesParty: function (list) {
    try {
      for (var i = 0; i < list.length; i++) {
        var c = list[i];
        if (c.code === 129) return true;
        if ((c.code === 355 || c.code === 655) &&
            this._PARTY_SCRIPT.test(String((c.parameters || [])[0] || ''))) return true;
      }
    } catch (e) {}
    return false;
  },

  // Does this page HAND SOMETHING OVER, as opposed to merely naming an item? Change Gold and the
  // three Change Items commands each carry the direction they run in — 0 increase, 1 decrease —
  // and until this existed the direction was never read, so a command that took a thing away
  // counted as treasure exactly as loudly as one that gave it.
  //
  // 19 events in the game only take, and between them they are four separate puzzles that all
  // answered to the word "Chest":
  //
  //   South Map (130)          8 braziers, one Oil Cannister each, opening a door at eight.
  //   Floating Ruins (552)     5 impressions, one Cyclone Core each, opening a door at five.
  //   Temple of Visions (229)  2 sockets for the Crystal Half-Moon.
  //   Thunder Mountain (97), Crystal Room (410), Secluded House (417),
  //   Illusionary Castle (615) one apiece.
  //
  // Both halves of that are wrong and the second is worse. A player hunting the treasure list is
  // sent to a socket that wants an item off them; and the thing the map is actually built around
  // — the eight braziers ARE South Map — is never named as anything a player would go and use.
  // The scan already counts nothing for them, since a socket pays out nothing to count.
  //
  // Read through the delegated common event with klist, like every other test that needs a
  // command's parameters: the chests that keep their contents in one would otherwise stop
  // looking like chests the moment this got stricter than a bare code check.
  _paysOut: function (list) {
    try {
      for (var i = 0; i < list.length; i++) {
        var c = list[i], p = c.parameters || [];
        // Change Gold is [operation, operandType, value]; the item trio is [id, operation, ...].
        if (c.code === C.GOLD) { if (p[0] === 0) return true; continue; }
        if (c.code === C.ITEM || c.code === C.WEAPON || c.code === C.ARMOR) {
          if (p[1] === 0) return true;
        }
      }
    } catch (e) {}
    return false;
  },

  // Does this page touch the inventory at all, in either direction? The weaker question _paysOut
  // asks, for the one caller that wants it: a scripted scene is marked out by the story moving
  // goods around, and which way they move says nothing about whether a scene is playing.
  _movesGoods: function (list) {
    try {
      for (var i = 0; i < list.length; i++) {
        var c = list[i].code;
        if (c === C.GOLD || c === C.ITEM || c === C.WEAPON || c === C.ARMOR) return true;
      }
    } catch (e) {}
    return false;
  },

  // Does this event's active page carry a Transfer to a DIFFERENT map? The distinction the door
  // test above draws in longhand, in one place, because three tests now need it: a transfer that
  // lands back on this map is a doorway or a cutscene nudge, and only one that leaves is a way on.
  _leavesMap: function (ev) {
    try {
      var away = this._transferOf(ev);
      return !!(away && away.mapId && away.mapId !== $gameMap.mapId());
    } catch (e) { return false; }
  },

  // A thing that hurts you for walking onto it, or null.
  //
  // 186 of these exist across three maps and the mod could see none of them: they carry no
  // dialogue, no reward and no transfer, so classify() fell through to its last test — which
  // requires the action button — and returned null for every one. Naddaha Pyramid's 54 spike
  // tiles take 400-500 off the whole party, Aether Mine's 92 drain MP and have no graphic at
  // all, and a route was being spoken straight across them without a word.
  //
  // Judged on the ACTIVE page, like everything else here, which is what makes a disarmed trap
  // disappear by itself: the pyramid's banks each swap to a blank page when their switch goes
  // on, and a blank page has no damage command to find.
  //
  // Deliberately strict. Anything that also talks, pays out, fights or moves you has an
  // identity of its own and is somebody else's to classify; only a bare damage tile lands here.
  _DISQUALIFY_TRAP: [C.TEXT, C.CHOICE, C.SHOP, C.SAVE, C.RECOVER, C.GOLD, C.ITEM, C.WEAPON,
                     C.ARMOR, C.BATTLE, C.TRANSFER],
  _trapOf: function (page) {
    try {
      if (!page) return null;
      if (page.trigger !== 1 && page.trigger !== 2) return null;   // must fire by being walked into
      var list = page.list || [], i, c, p;
      for (i = 0; i < list.length; i++) {
        if (this._DISQUALIFY_TRAP.indexOf(list[i].code) >= 0) return null;
      }
      // Control Variables "set to random min..max" is how every one of these rolls its damage,
      // so the range is readable ahead of time rather than only after it has been taken.
      var ranges = {}, hit = null, state = null;
      for (i = 0; i < list.length; i++) {
        c = list[i]; p = c.parameters || [];
        if (c.code === C.VARIABLE && p[2] === 0 && p[3] === 2) {
          for (var v = p[0]; v <= p[1]; v++) ranges[v] = [Number(p[4]) || 0, Number(p[5]) || 0];
          continue;
        }
        // A trap does not have to take HP to be worth walking round. Thunder Mountain's Inner is
        // floored with 138 visible tiles that inflict Poison, Blind or Silence on the whole party
        // — 50, 48 and 40 of them — and because they change a state rather than a number, not one
        // was a trap, or anything else: they fell out of classify entirely and routes were spoken
        // straight across them without a word. Add only (parameters[2] === 0); the same command
        // with Remove is a cure tile, which is the opposite thing.
        if (c.code === C.STATE) {
          if (p[2] !== 0) continue;
          state = this._stateName(p[3]) || state;
          continue;
        }
        if (c.code !== C.HP && c.code !== C.MP) continue;
        if (p[2] !== 1) continue;                        // 0 increases it: that is a healing tile
        var lo, hi;
        if (p[3] === 0) { lo = hi = Number(p[4]) || 0; } // a flat amount
        else { var r = ranges[p[4]]; if (!r) continue; lo = r[0]; hi = r[1]; }
        if (!lo && !hi) continue;
        hit = { mp: c.code === C.MP, min: Math.min(lo, hi), max: Math.max(lo, hi) };
      }
      // A tile that does both is named by the damage: it is the larger cost, and the name has
      // room for one clause.
      if (hit) return hit;
      return state ? { state: state } : null;
    } catch (e) { return null; }
  },

  _stateName: function (id) {
    try {
      var s = $dataStates && $dataStates[id];
      return (s && s.name) ? BMA.Util.cleanText(s.name) : '';
    } catch (e) { return ''; }
  },

  // "400 to 500 damage" / "100 damage" / "drains 2 to 5 MP" / "inflicts Poison". Spoken as part
  // of the trap's name, because what it costs is the whole of what a player needs to decide
  // about it.
  _trapEffect: function (t) {
    if (t.state) return 'inflicts ' + t.state;
    var amount = t.min === t.max ? String(t.min) : (t.min + ' to ' + t.max);
    return t.mp ? ('drains ' + amount + ' MP') : (amount + ' damage');
  },

  // Returns {category, kind} or null. Order matters: an innkeeper is
  // text -> choice -> change gold -> recover all -> transfer, so testing rewards first
  // (as this used to) files every inn in the game under "treasure".
  // A service somebody performs, read off the script rather than off what they say. Somebody who
  // runs one of these is not a resident, and the room they stand in is named for the service.
  //
  // Kept to what the commands prove. "Transport" is a choice followed by a transfer — an offer to
  // take you somewhere, which is what every moogle escort and ferryman in this game is; a plain
  // transfer with no choice is a doorway, and a choice with no transfer is ordinary conversation.
  // Nothing here guesses from dialogue: a tavern is still a tavern by hand, because "the ale's not
  // too bad here" is a remark, not a service.
  serviceOf: function (page) {
    try {
      var list = (page && page.list) || [];
      var choice = false, transfer = false;
      for (var i = 0; i < list.length; i++) {
        var c = list[i], code = c.code;
        if (code === 355 || code === 655) {
          // Galv_QuestLog is configured as this game's Marks screen and is pushed from an event,
          // never from a menu — so the event that pushes it *is* the marks board.
          if (/Galv\.QUEST/.test(String(c.parameters[0] || ''))) return 'Marks board';
          continue;
        }
        if (code === C.CHOICE) choice = true;
        else if (code === C.TRANSFER) transfer = true;
      }
      if (choice && transfer) return 'Transport';
    } catch (e) {}
    return '';
  },

  // A block you shove: a page that is nothing but "if the player is facing D, move me one step
  // D", repeated once per side it can be pushed from. The step MATCHING the facing is what makes
  // it a push — the player standing south of it and facing north sends it north — and it is what
  // separates this from a lever that happens to run a move route on its own graphic.
  //
  // Sixty-nine of them, on four maps, and they are one mechanism wearing three skins:
  //
  //   Torian Grotto (436)   five stone blocks in one-tile corridors, gating the Tent at (87,13),
  //                         the Guard Shard at (82,13) and the 1000 Gil at (90,21).
  //   Eagle's Cradle (475)  eighteen giant shells, in four rooms that share nothing but the trick
  //                         — six around (35..47,55..59), four around (65..72,57..60), three at
  //                         (64..67,66..67) and five around (143..153,36..39) — standing in the
  //                         way of six of that dungeon's thirteen chests.
  //   Mythril Mine          forty-six mine carts, four on the entrance map (487) and forty-two
  //                         below (488), drawn on a character sheet rather than as tiles, and
  //                         with no reset anywhere on either map.
  //
  // Sixty-four of the sixty-nine sound as they move: the route is Play SE and the step, in one
  // order or the other. That one extra route command is the whole reason this rule used to find
  // five blocks in the game instead of sixty-nine — it made the route two steps long, and a
  // two-step route is how a cutscene walks something about, not how a block takes one shove. A
  // sound is not a movement, so it is skipped rather than counted. Scanned across all 645 maps:
  // these sixty-nine pages and nothing else, so the rule still costs nothing where it does not
  // apply. The carts had already forced half of this recognition — _routeSoundName exists to name
  // them off that same SE — which is how obvious it was that they were something and how far
  // short of "and here is what to do with it" that got.
  //
  // Only the editor's shorthand for their names is overruled, and only where there is one:
  //
  //   Chest1..Chest5    is WRONG. Torian Grotto also holds eight real chests, which number
  //                     themselves "Chest 1".."Chest 8", so the word meant two different things
  //                     on one map — one that opens, one that slides — and a blind player was
  //                     sent to press the action button at five chests that gave them nothing.
  //   Shell1..Shell18   is merely useless. Nothing anywhere in the game's dialogue says "shell"
  //                     — checked across every map file — so the word connects to nothing the
  //                     player has been told and carries no hint that the object moves.
  //   Minecart          SURVIVES, because it is not the editor's shorthand at all: it is read
  //                     out of the data, it is what the thing is, and losing it to a generic
  //                     word would be a step backwards. See EDITOR_SHORTHAND and _makeRecord.
  //
  // Two directions minimum. One would still be true of a block that only nudges one way, but
  // nothing in this game is one, and "Block" promises something you can work with.
  _pushDirs: function (page) {
    try {
      var list = (page && page.list) || [];
      var dirs = [], i = 0;
      while (i < list.length) {
        var c = list[i];
        if (!c || NOT_BEHAVIOUR[c.code]) { i++; continue; }
        if (c.code !== 111) return null;                     // anything else: not a plain block
        var p = c.parameters;
        if (!p || p[0] !== BRANCH_CHARACTER || p[1] !== BRANCH_PLAYER) return null;
        var want = DIR_DELTA[p[2]];
        if (!want) return null;
        // The branch body: one move route on THIS event (0), one step, that same direction. MV
        // mirrors every route step as a 505 straight after its 205, so the body ends at the
        // first one of those — the outer loop skips them along with the 412 that closes it.
        //
        // Play SE is dropped before the step is counted, wherever in the route it sits — the
        // shells sound before they slide, the mine carts after they roll, Torian Grotto's blocks
        // not at all. It is the noise the thing makes, and which noise a mapper chose (or did not)
        // says nothing about whether the event is a block.
        var moved = false;
        for (i++; i < list.length && !NOT_BEHAVIOUR[list[i].code]; i++) {
          var b = list[i];
          if (b.code !== C.MOVE_ROUTE) return null;
          var bp = b.parameters;
          if (!bp || bp[0] !== 0) return null;               // moves itself, not the player
          var steps = ((bp[1] && bp[1].list) || []).filter(function (s) {
            return s.code !== 0 && s.code !== ROUTE_PLAY_SE;
          });
          if (steps.length !== 1) return null;
          var got = ROUTE_STEP[steps[0].code];
          if (!got || got[0] !== want[0] || got[1] !== want[1]) return null;
          moved = true;
        }
        if (!moved) return null;
        dirs.push(p[2]);
      }
      return dirs.length >= 2 ? dirs : null;
    } catch (e) { return null; }
  },

  // Which events on this map are blocks. Read off the static map data, because classify() runs
  // DURING the scan and so cannot ask what the scan found — and because the answer is a property
  // of the map file, which does not change while the player is standing on it. Memoised per map
  // alongside the name groups and the chest tiles, for the same reason.
  _blockIds: {},
  _blockIdsFor: function (mapId) {
    if (this._blockIds[mapId]) return this._blockIds[mapId];
    var ids = {};
    try {
      var evs = $gameMap.events();
      for (var i = 0; i < evs.length; i++) {
        var data = evs[i] && evs[i].event && evs[i].event();
        var pages = (data && data.pages) || [];
        for (var p = 0; p < pages.length; p++) {
          if (pages[p].trigger === 0 && this._pushDirs(pages[p])) {
            ids[evs[i].eventId()] = true;
            break;
          }
        }
      }
    } catch (e) {}
    return (this._blockIds[mapId] = ids);
  },

  // The blocks a page puts back, or null if it puts none back. Set Event Location aimed at an
  // event this map's data proves is a block — the id list matters as much as the fact, because a
  // dungeon can have more than one block room and each room's reset only reaches its own. See
  // _resetHint.
  _blockResetIds: function (page, mapId) {
    var blocks = this._blockIdsFor(mapId), ids = [], list = (page && page.list) || [];
    for (var i = 0; i < list.length; i++) {
      if (list[i].code !== 203) continue;                    // Set Event Location
      var id = list[i].parameters && list[i].parameters[0];  // 0 is "this event", -1 the player
      if (id > 0 && blocks[id]) ids.push(id);
    }
    return ids.length ? ids : null;
  },

  // A lever: an action-button event whose whole behaviour is throwing a switch. Play SE is the
  // click, Wait is the pause before the thing it moves moves, and Control Self Switch is how a
  // two-page lever remembers which way it is currently thrown — none of them do anything to the
  // party, so a page built only from those four is a handle and nothing else.
  //
  // Seventeen events in the game are one, across six maps: Etherdepths' three, Elemental Abyss'
  // four, Naddaha Pyramid's five, Adder's Room, three in Ancient Castle's main map and one on the
  // Tower of Babil's 6F. Every one of them is a tile graphic with no name, so all seventeen came
  // out of _labelFor as "Object N" — which says a thing is there and nothing about it being the
  // one thing on the map you are meant to pull.
  //
  // Deliberately narrow. Widening it by one command (a Show Text, a Transfer, a move route) takes
  // in NPCs who flip a story flag while they talk and stepping stones that throw a switch on their
  // way past, and "Lever" is a promise about what happens when you press the button.
  LEVER_CMDS: { 121:1, 250:1, 123:1, 230:1 },   // Control Switches, Play SE, Self Switch, Wait

  _leverSwitches: function (page) {
    try {
      var list = (page && page.list) || [];
      var ids = [];
      for (var i = 0; i < list.length; i++) {
        var c = list[i];
        if (!c || c.code === 0 || c.code === 108 || c.code === 408) continue;
        if (!this.LEVER_CMDS[c.code]) return [];
        if (c.code !== C.SWITCH) continue;
        var p = c.parameters || [];
        for (var s = p[0]; s <= p[1]; s++) ids.push(s);
      }
      return ids;
    } catch (e) { return []; }
  },

  classify: function (ev) {
    try {
      var page = ev.page();
      if (!page) return null;
      var list = page.list || [];
      var codes = {}, meaningful = 0;
      for (var i = 0; i < list.length; i++) {
        var code = list[i].code;
        codes[code] = true;
        // 0 is the list terminator, 108/408 are editor comments — neither is behaviour.
        if (code !== 0 && code !== 108 && code !== 408) meaningful++;
      }
      // An event that only calls a common event is that common event, so read its commands as
      // the page's own. Without this the 140 chests of the Infinitarium and the Miasma Stream —
      // whose gold and items live entirely inside the called event — reached none of the tests
      // below and fell out as anonymous objects. `klist` is what any test that needs a command's
      // *parameters* (shop stock, exit kind) has to read, since those are not on the page.
      var deleg = this._delegatedTo(list);
      var klist = list;
      if (deleg) {
        klist = deleg.list;
        for (var k = 0; k < klist.length; k++) codes[klist[k].code] = true;
      }

      // A prop drawn on a character sheet is still drawn — it just is not a person. hasGraphic
      // has to stay true or the scenery test below throws it away entirely; only hasSprite,
      // which every "somebody is standing here" test reads, is withheld. See PROP_SPRITES.
      var drawn = !!(page.image && page.image.characterName !== '');
      var hasSprite = drawn && !this._propSprite(page);
      var hasGraphic = drawn || !!(page.image && page.image.tileId > 0);
      var trigger = page.trigger;
      var touch = (trigger === 1 || trigger === 2);
      var auto = (trigger === 3 || trigger === 4);
      if (touch && codes[C.TRANSFER] && this._infinitariumPassage(klist, $gameMap.mapId())) {
        return { category: 'exit', kind: 'Infinitarium passage' };
      }
      if (touch && !hasGraphic && codes[C.SWITCH]) {
        var markerMap = $gameMap.mapId();
        var markerMode = this._cleftMarker(page, markerMap);
        if (markerMode !== null) {
          var side = markerMap === 549 ? (markerMode ? 'Upper' : 'Lower') : (markerMode ? 'Left' : 'Right');
          return { category: 'interactable', kind: side + ' route marker' };
        }
      }

      // Save crystals are multi-page: page 0 activates them when you walk into it, and the
      // Open Save Screen command lives on a later page behind a switch. Not one of the 153
      // in this game has it on page 0, so judging by the active page alone hides every save
      // point until after you have already found and used it. Look at all pages instead,
      // and require a graphic so a crystal switched to its hidden/disabled page stays out.
      var isSavePoint = hasGraphic && this._hasSaveCommand(ev);

      // Sealed doors follow the same shape: page 0 is the shut door — a blocking tile with
      // no commands at all — and the Transfer only appears on a later page once a switch
      // opens it. 62 of them in this game were invisible to the mod, which left rooms whose
      // only way onward reported nothing in the exits list.
      var isClosedDoor = !codes[C.TRANSFER] && hasGraphic && this._hasTransferOnAnyPage(ev);

      // Scenery: animated tile events (beds, torches, banners) carry a graphic and an
      // action trigger but no commands at all. 6249 of them exist across this game; they
      // are decoration, not destinations.
      //
      // The exception is the sprite standing in for a party you are not currently steering,
      // which has no commands either and is the one thing on the map that says where the rest of
      // you are. See _partyMarkerName.
      if (!meaningful && !isSavePoint && !isClosedDoor) {
        var marker = this._partyMarkerName(ev, page);
        return marker ? { category: 'npc', kind: marker } : null;
      }

      // Invisible autorun/parallel events are the game's plumbing, never destinations.
      if (auto && !hasGraphic) return null;

      // --- hazards ---
      // Asked before everything else because a trap is defined by what it costs, not by what
      // it looks like, and Aether Mine's have no graphic to be recognised by.
      var trap = this._trapOf(page);
      if (trap) return { category: 'trap', kind: 'Trap', trap: trap };

      // --- services ---
      if (codes[C.SHOP]) return { category: 'shop', kind: this._shopKind(klist) };
      if (codes[C.RECOVER] && codes[C.GOLD]) return { category: 'shop', kind: 'Inn' };
      // A service with no goods table behind it — the arena's match desk, the casino's games.
      // Asked here so it is settled before the door, scene and portal tests, any of which would
      // otherwise take it. See _counterKind.
      var counter = this._counterKind(ev, page);
      if (counter) {
        return counter.numbered ? { category: 'shop', kind: null, singular: counter.name }
                                : { category: 'shop', kind: counter.name };
      }
      if (isSavePoint) return { category: 'savepoint', kind: 'Save point' };
      if (codes[C.RECOVER]) return { category: 'savepoint', kind: 'Rest point' };

      // --- doors ---
      // A real exit is an event whose whole job is the transfer. Anything that also talks,
      // fights, or hands over goods is an NPC or a chest that happens to move you.
      var rewards = this._paysOut(klist);
      // "Anything that also talks is an NPC who happens to move you" is a rule about people, and
      // it needs somebody to be standing there. On an invisible tile nobody is: it IS the
      // doorway, however much it narrates on the way through. 16 events in the game are one, and
      // every one is a real way off its map — among them **the only way out of Archareon
      // Prison** (a touch tile that asks "Return to Branch Castle?"), and the two tiles in Branch
      // Castle that are the way in. Both ends of that trip were invisible, so the prison
      // answered "Exits: none" while the player stood in it.
      //
      // It must LEAVE the map, and that clause is the whole rule. A talking touch tile that
      // transfers you within the same map is a cutscene repositioning the player mid-scene, not
      // a doorway: Rift Shrine's 39-line Ramuh scene shunts you four tiles north partway
      // through, Laka's house and King Doran's throne room do the same. Without this they became
      // "Door 1" in rooms that have no door, which is worse than the silence it replaced.
      var talkingDoorway = false;
      if (codes[C.TRANSFER] && !hasGraphic && touch && !rewards && !codes[C.BATTLE]) {
        var away = this._transferOf(ev);
        talkingDoorway = !!(away && away.mapId && away.mapId !== $gameMap.mapId());
        // The three campsite variants also ask before transferring. Their return destination
        // was saved by the camp-entry event, so the absence of a fixed map ID is not a cutscene.
        if (!away && codes[C.CHOICE]) {
          var campReturn = this._campReturnKind(klist, $gameMap.mapId());
          if (campReturn) return { category: 'exit', kind: campReturn };
        }
      }
      if ((codes[C.TRANSFER] && !codes[C.TEXT] && !codes[C.CHOICE] && !rewards &&
           !codes[C.BATTLE] && (touch || !hasSprite)) || talkingDoorway) {
        // A transfer landing back on this map is a doorway, not a way out. 690 of these were
        // filling the exits list — every interior doorway on every shared house map — so asking
        // where the ways out were meant hearing them all first.
        var dest = this._transferOf(ev);
        if (dest && dest.mapId === $gameMap.mapId()) return { category: 'door', kind: 'Door' };
        return { category: 'exit', kind: this._exitKind(klist) };
      }

      // --- scripted scenes ---
      // Nothing is drawn here, it starts talking when you walk onto it, and the scene ends in a
      // fight or a reward: a plot trigger, not a thing. 35 of them, and every one was filed as
      // whatever it happened to do on its last line — Aether Mine's (140,79) is the party working
      // out what Atomos is and it hands over an item at the end, so it was a chest; 31 more end
      // in a fight, so they were enemies standing in an empty corridor.
      //
      // Three lines the test does not cross, and each one is a population much larger than the
      // 35. A transfer is a doorway however much it talks, and is settled above. A trap is
      // answered before all of this — Aether Mine's 92 silent MP drains are invisible walk-on
      // tiles too. And it must end in a fight or a reward, which is what keeps this to the events
      // that were ALREADY being listed under the wrong heading: without it the rule also sweeps
      // up 129 that classify has always dropped, among them 23 MogNet GPS signposts on each
      // Overworld — invisible tiles that read out the nearest town's name as you pass, which the
      // dialogue layer already speaks and which nobody needs to be routed to.
      //
      // Less of a spoiler than what it replaces, not more. The tile is invisible, so a sighted
      // player gets no warning either; "Enemy 1" told a blind player a fight was coming, and
      // "Event 1" only says the story does something here.
      //
      // "A reward" is the inventory MOVING, in either direction, and not the payout the treasure
      // test below asks about. Handing a quest item over is as plainly the story doing something
      // as being given one: Doctor's House (41) is the scene where Cunnings takes the Sylkis
      // Mushroom off you and makes the vaccine, and Crystal Room (410) is the tile that spends the
      // Crystal Half-Moon and starts the Gylfi confrontation. Both were reached through `rewards`
      // back when that meant "the page mentions an item at all"; once _paysOut made it mean "you
      // are handed something", the first fell out of every list and the second landed under
      // enemies — which is precisely the spoiler this rule exists to prevent.
      //
      // The transfer clause narrows the same way and for the reason the doorway test above
      // already gives: a transfer landing back on THIS map is a cutscene repositioning the
      // player, not a way anywhere. Crystal Room's shunts the party four tiles north mid-scene.
      if (!hasGraphic && touch && (rewards || this._movesGoods(klist) || codes[C.BATTLE]) &&
          (codes[C.TEXT] || codes[C.CHOICE]) && !this._leavesMap(ev)) {
        return { category: 'event', kind: this._sceneKind(page) };
      }

      // --- everything else ---
      if (rewards) {
        // Something that pays out and then erases itself is loot lying on the ground, whatever
        // sheet it is drawn on. See _isDroppedItem — it is 298 events and two whole Overworlds.
        var pickup = hasSprite && this._isDroppedItem(ev, page);
        if (hasSprite && !pickup && (codes[C.TEXT] || codes[C.CHOICE])) {
          return { category: 'npc', kind: null };
        }
        // They belong in the treasure list, which is where a player looks for loot — but they are
        // not chests, and `singular` keys its own numbering so a map's chests still count 1,2,3
        // without the pickups interleaving into them.
        return pickup ? { category: 'treasure', kind: null, singular: 'Item' }
                      : { category: 'treasure', kind: null };
      }
      // Scenery that ambushes you is still scenery, and the enemies list must not give away that
      // it is about to. What decides this is whether the monster is VISIBLE before you act, not
      // what happens once you do: a sighted player sees a sarcophagus, a switch, a keypad or a
      // chest — "Monster-in-a-box!" is the game's own words for the last of those — and nothing
      // warns them either. Listing those 49 under enemies handed a blind player a warning the
      // game withholds from everybody else, which is a spoiler, not an accessibility gain.
      //
      // A tileset tile is never a visible monster. Every one of these is a single tile that
      // switches to tileId 0 once the fight is over — the object is destroyed, and there was
      // nothing else to see. The bosses among them (Ymir, Phunbaba, Yemaja, Dreamweaver) speak
      // from inside the page the action button runs, and Phunbaba's even has the move routes
      // and screen tints that bring the demon out, so none of that dialogue is on show
      // beforehand either.
      //
      // A monster that really is standing on the map is drawn with a character sprite, and
      // hasSprite keeps every one of those in the enemies list where it belongs.
      if (codes[C.BATTLE] && hasGraphic && !hasSprite && trigger === 0) {
        // A mimic is drawn as a chest, and "Monster-in-a-box!" is what the game shouts once it
        // is too late. So it goes in the treasure list as a chest, sharing the same numbering as
        // the real ones — anything else (its own category, or an "Object" among chests) would
        // hand a blind player the surprise by process of elimination, which is the whole thing
        // being avoided. Which tile counts as a chest is read off the map itself, so this needs
        // no list of monster names and follows the game's own art.
        if (this._looksLikeTreasure(page)) return { category: 'treasure', kind: null };
        return { category: 'interactable', kind: null };
      }
      // The same reasoning, taken one step further than the tileset tile: nothing is drawn here
      // AT ALL, and the fight is one branch of a question the thing asked. Whatever else that is,
      // it is not a monster standing in a corridor, and a player looking for the mechanism they
      // were told to work should not have to look under "enemies" to find it.
      //
      // Two events in the game, and they are two thirds of one puzzle. The Inner (407) is Odin's
      // three children — buttons reading "Baul", "Haljar" and "Vinro", to be pressed in the birth
      // order a plaque elsewhere on the map gives — and pressing them out of order starts a fight.
      // So Baul and Haljar carry a Battle Processing and came out as "Enemy 1" and "Enemy 3",
      // while Vinro, whose branch has no fight in it, matched nothing and was dropped: one puzzle,
      // three buttons, filed three different ways and one of them not filed at all.
      //
      // The Choice is what keeps this to those two. An invisible action-button event that fights
      // you without asking anything first is not asked about here and stays an enemy.
      var invisiblePrompt = !hasGraphic && trigger === 0 && codes[C.CHOICE];
      if (codes[C.BATTLE] && !invisiblePrompt) return { category: 'enemy', kind: null };

      // Somebody you walk up to and talk to who adds or removes party members is managing the
      // roster; the transfer at the end of their script is the game standing you back up, not a
      // way across the map. Esto Yensa's forecourt is the whole party lined up to be split in
      // two, and confirming a formation fades out and drops you back at the door — so all twelve
      // of the ones you can pick reached the portal test below and came out "Crossing 1..12",
      // which is hidden from "all" AND from the NPC list. Every list a player would look in for
      // the people they are being asked to choose between was empty.
      //
      // Action button only. The same test on an autorun takes the Arcane Library's departure
      // cutscene, which is a scene playing itself rather than a person standing anywhere; Laka's
      // recruitment tiles in her house are invisible, so hasSprite has already excluded those.
      if (hasSprite && !auto && (codes[C.TEXT] || codes[C.CHOICE]) && this._changesParty(klist)) {
        return { category: 'npc', kind: null };
      }

      // A transfer that lands back on THIS map is a portal even when the thing carrying you
      // talks first. Asked here, immediately above the npc test, because Conall Curach's two
      // moogles ask "shall I take you across?" before they do it — which reached
      // `hasSprite && TEXT` and filed them as people rather than as passages, leaving Portals
      // empty on the only map in the game that has any.
      //
      // Only ahead of `npc`, not ahead of treasure or enemy: a chest or a boss that also moves
      // you across the map is still first and foremost a chest or a boss, and promoting those
      // to portals took 9 enemies and a chest out of the lists where a player looks for them.
      if (this._warpRoleOf(ev) === 'portal') {
        return { category: 'crossing', kind: null, warp: 'portal' };
      }

      if (hasSprite && (codes[C.TEXT] || codes[C.CHOICE])) return { category: 'npc', kind: null };
      // Last, so an NPC or chest that happens to transfer on some page keeps its own
      // identity and only genuinely inert blockers become doors.
      // Neither a way out nor a way across, yet: it is shut, and the transfer only exists on a
      // page some switch elsewhere turns on. Its own category, so the exits list answers "where
      // can I leave from" and the doors list answers "what is shut".
      // Where it opens onto decides which list it belongs in — exactly as it does one branch up
      // for a doorway that is already open. isClosedDoor only ever asked whether SOME page carries
      // a Transfer, never where that Transfer goes, so a sealed way OFF the map answered "what is
      // shut" and never "where can I leave from", which is the list a player checks for the way on.
      // 41 events in this game are one, across 38 maps — among them both of Wind Shrine's and both
      // of Naddaha Pyramid's sealed doors, and Chocobo Stable's way back out to the Overworld.
      // The name stays "Closed door": it is still shut, and that is the thing worth hearing.
      if (isClosedDoor) {
        return { category: this._closedDoorLeavesMap(ev) ? 'exit' : 'door', kind: 'Closed door' };
      }

      // A way across the map, rather than a way out of it. Asked last on purpose — anything
      // with an identity of its own (a shop, a chest, an NPC who happens to move you) keeps it,
      // and only otherwise-anonymous movers land here. In Conall Curach that is exactly the
      // marsh stones, which the old code filed under "objects" if they had a graphic and
      // dropped entirely if they did not.
      //
      // kind stays null so these number themselves — "Crossing 1", "Crossing 2" — rather than
      // sixteen stones all answering to the same word.
      var warp = this._warpRoleOf(ev);
      if (warp) return { category: 'crossing', kind: null, warp: warp };

      // The tile that puts the blocks back. Asked ahead of the graphic test below and nowhere
      // higher: everything with an identity of its own has already been offered this event —
      // Torian Grotto's two resets carry a Transfer, so they are the doorways they look like and
      // are settled at the door test — and what is left is Eagle's Cradle's nine, which are bare
      // floor with nothing drawn on them at all.
      //
      // That is why the graphic test cannot have them: an invisible touch tile is exactly the
      // shape the mod refuses to list, because the game has thousands of them and none is a
      // destination. This one is. It is the only way out of a push puzzle a player has shoved
      // shut, and with no name of its own the recovery hint could only call it "Something" and
      // give a bearing — an instruction to walk fourteen steps north and hope. Nine events in the
      // game reach this; the rule requires a Set Event Location aimed at an event this map's own
      // data proves is a block, so it cannot widen past the maps that have blocks on them.
      if (touch || trigger === 0) {
        var resets = this._blockResetIds(page, $gameMap.mapId());
        if (resets) {
          return { category: 'interactable', kind: null, singular: 'Block reset',
                   overrideName: true, resets: resets };
        }
      }

      // Something drawn on the map that does something when you reach it. The action button was
      // the only way in until now, which quietly dropped every pad you activate by standing on
      // it — and one of this game's puzzles is built entirely out of those.
      //
      // Archareon Prison is four pressure pads, scattered to the far corners of a map whose only
      // connectivity is thirteen gap jumps, and stepping on all four drops the barrier holding
      // Lord Adder and his men. Each is a tile graphic with a touch trigger that throws a switch,
      // so classify fell off the end and returned null for all four: the objective of the map had
      // no entry in any list, and there was nothing to navigate to. Esto Yensa's twelve switches
      // are the same shape.
      //
      // Safe to widen only because the traps went first. Before Change State counted as a trap,
      // this test would also have swept up Thunder Mountain Inner's 138 poison/blind/silence
      // tiles and filed them under Objects — turning a hazard list into a list of places to walk.
      if (hasGraphic && (trigger === 0 || touch)) {
        // A block you push. Its own word and its own numbering, and — uniquely — a name that
        // overrules the editor's, because here the editor's is wrong rather than merely absent.
        // See _pushDirs: five events in the game, all of them called "ChestN" on a map with
        // eight real chests.
        var push = this._pushDirs(page);
        if (push) {
          return { category: 'interactable', kind: null, singular: 'Block',
                   push: push, overrideName: true };
        }
        // A handle you pull. Its own word for the same reason a pad has one: "Object 1" is a poor
        // thing to hear about the mechanism a dungeon is built around, and it gives the hint below
        // — "it opens from Lever 1" — something to name.
        //
        // Ahead of the pad test only because the two cannot both match: a lever is the action
        // button and a pad is walked onto.
        if (trigger === 0 && this._leverSwitches(page).length) {
          return { category: 'interactable', kind: null, singular: 'Lever' };
        }
        // Something drawn on the floor that throws a switch when you stand on it is a pad, and
        // "Object 3" is a poor thing to hear about the one you have to go and step on. "Pad" is
        // the game's own word for them — Lord Adder says the barrier comes down "by stepping on
        // some pads that power them" — and it fits Esto Yensa's dozen just as well.
        if (touch && (codes[C.SWITCH] || codes[C.SELF_SW])) {
          return { category: 'interactable', kind: null, singular: 'Pad' };
        }
        return { category: 'interactable', kind: null };
      }

      // The same thing with nothing drawn on the event, because the picture is in the map's own
      // tiles. This is not an edge case in this game — it is how nearly every object in it is
      // built: 871 events are an action-button page with no graphic that does something, and the
      // chests are 719 of them. The rewards test above has always caught those, which is why the
      // graphic requirement on the test above went unnoticed; what it dropped was the tail.
      //
      // 26 events, and they are the endgame's puzzles:
      //
      //   Genesis Obelisk (605)  7 Lunar Crystals, and 1 more each on Lunar Crystal (601) and
      //                          Lunarscape Abyss (614). Each is a wall carving that transfers
      //                          the party to another map — the way through the dungeon, and none
      //                          of the nine appeared in the exits list or in any other.
      //   Osteinchyl (405)       the three riddle plaques. That dungeon is three statues to be
      //                          rotated to face the right symbol, and these say which: "The
      //                          Knight of the West stands guard when the moon rises." Without
      //                          them the puzzle is four facings on each of three statues, tried
      //                          blind — 64 combinations with no way to tell a right one.
      //   The Inner (407)        the plaque giving Odin's children's birth order, and the Vinro
      //                          button. See invisiblePrompt above for the other two buttons.
      //   Valley of Forgotten
      //   Heroes (604)           8 memorial plaques.
      //   3 Mog consoles, 1 flashback tile.
      //
      // A transfer that leaves the map is answered as an exit even though it talks first, on the
      // same grounds as talkingDoorway far above: an invisible tile has nobody standing on it, so
      // it IS the way out however much it narrates on the way through. The difference is only
      // that this one waits for the action button, and the exits list is where a player looks for
      // the way on. It stays out of the door/exit test up there because that test refuses a page
      // carrying a Choice, and every one of these nine asks "Activate the Crystal?" first.
      if (trigger === 0) {
        if (this._leavesMap(ev)) return { category: 'exit', kind: this._exitKind(klist) };
        return { category: 'interactable', kind: null };
      }
      return null;
    } catch (e) { return null; }
  },

  // "Weapon shop" / "Item shop" / ... from the goods table (type 0 item, 1 weapon, 2 armor).
  // What a Shop Processing command actually sells. Returns null when the list has no shop.
  //
  // The goods live in the 302 command's OWN parameters — [type, dataId, priceType, price] — with
  // every additional line following as a 605 of the same shape. This used to read parameters[0]
  // as a goods *array*, so goods.length was undefined, the loop never ran, and every shop in the
  // game came back as the bare "Shop". That is what a player hears today.
  shopKindOf: function (list) {
    try {
      var types = {}, etypes = {}, nType = 0, nEtype = 0, started = false;
      for (var i = 0; i < list.length; i++) {
        var c = list[i];
        if (c.code === C.SHOP) started = true;
        else if (c.code !== C.SHOP_MORE || !started) continue;
        var p = c.parameters || [], t = p[0];
        if (t !== 0 && t !== 1 && t !== 2) continue;
        if (!types[t]) { types[t] = true; nType++; }
        if (t === 2) {
          var a = window.$dataArmors && $dataArmors[p[1]];
          var e = a && a.etypeId;
          if (e != null && !etypes[e]) { etypes[e] = true; nEtype++; }
        }
      }
      if (!started) return null;
      if (nType !== 1) {
        if (types[1] && types[2] && !types[0]) return 'Weapon and armor shop';
        return 'Shop';
      }
      if (types[0]) return 'Item shop';
      if (types[1]) return 'Weapon shop';
      // Armor only. This game adds equip slots past MV's standard Shield/Head/Body, so a shop
      // selling nothing but Relics is a relic shop rather than an armor shop — 41 of those, plus
      // a Juzu shop, were all being called "Armor shop".
      if (nEtype === 1) {
        for (var k in etypes) {
          var idx = Number(k);
          if (idx < 5) break;                       // 2-4 are the ordinary armour slots
          var nm = window.$dataSystem && $dataSystem.equipTypes && $dataSystem.equipTypes[idx];
          if (nm) return nm + ' shop';
        }
      }
      return 'Armor shop';
    } catch (e) { return 'Shop'; }
  },

  _shopKind: function (list) { return this.shopKindOf(list) || 'Shop'; },

  // A counter you queue at for a service that has no price list: the arena's match desk and the
  // casino's games. Both belong with the shops — you hand over money and get something back —
  // and neither has a Shop Processing command anywhere near it.
  //
  // The arena counter is why this exists at all. Dalton runs the Gygas Arena's matches, and the
  // last thing his script does is transfer you back to the tile in front of him once the fight is
  // over. That same-map transfer reached the portal test, which files an event as a crossing —
  // and crossings are kept out of "all" and out of the NPC list, so the one thing on the map you
  // have to use to do anything at all was in no list a player can reach. Answered here, up in the
  // services block, it never gets that far. The portal test itself is left alone rather than
  // narrowed: what else it catches is the moogle ferry network and the cutscene tiles that
  // reposition you mid-scene, and those really are movers.
  //
  // Read off the script wherever the script says it, and nothing here depends on an id. The
  // plugin commands name their own game. The arena hands off to a common event the editor called
  // "Arena Fight Decider", and it is the one that carries the Battle Processing. The casino's
  // desks sell tokens and take bets with nothing behind them but Change Variable, so what they
  // have in common is the "Wallet" choice — the casino's own idiom for "how many tokens do I
  // have", offered by all seven of its counters and by nothing else in the game. That proves it
  // IS a casino counter; which one it is only the dialogue says, so those are named in LABELS.
  _COUNTER_PLUGINS: [
    // Eight of these stand in two banks in the Rotunda, and one is as good as the next — but a
    // cycle that says "Slot machine" eight times cannot be walked, so they number themselves the
    // way the pressure pads do. The three Blackjack tables are few enough to tell apart by where
    // they are, and the dealer states his stakes as soon as you speak to him.
    [/^SlotMachine\b/, 'Slot machine', true],
    [/^Blackjack\b/, 'Blackjack table', false],
  ],
  _ARENA_EVENT: /\barena\b/i,

  // null, or {name, numbered}.
  _counterKind: function (ev, page) {
    try {
      var list = (page && page.list) || [], wallet = false, i, k;
      for (i = 0; i < list.length; i++) {
        var c = list[i], code = c.code, p = c.parameters || [];
        if (code === 356 || code === 655) {
          var s = String(p[0] || '');
          for (k = 0; k < this._COUNTER_PLUGINS.length; k++) {
            var g = this._COUNTER_PLUGINS[k];
            if (g[0].test(s)) return { name: g[1], numbered: g[2] };
          }
          continue;
        }
        if (code === C.CHOICE) {
          var choices = p[0] || [];
          for (k = 0; k < choices.length; k++) {
            if (/^wallet$/i.test(String(choices[k]).trim())) { wallet = true; break; }
          }
          continue;
        }
        if (code !== C.COMMON) continue;
        var all = window.$dataCommonEvents, ce = all && all[p[0]];
        if (!ce || !this._ARENA_EVENT.test(ce.name || '')) continue;
        var cl = ce.list || [];
        for (var j = 0; j < cl.length; j++) {
          if (cl[j].code === C.BATTLE) return { name: 'Arena counter', numbered: false };
        }
      }
      // A Wallet choice nobody has written a name for is still a casino counter, and saying so
      // keeps it in the shops list instead of losing it back into the crowd of onlookers.
      return wallet ? { name: 'Casino counter', numbered: false } : null;
    } catch (e) { return null; }
  },

  // Camp entry (common event 5) records the source in variables 4–6 before transferring.
  // Only the verified camp return pages read those variables without setting them first.
  // Other variable transfers can change their destination while running, such as Esto Yensa.
  _campReturnKind: function (list, here) {
    if (here !== 43 && here !== 265 && here !== 299) return '';
    for (var i = 0; i < list.length; i++) {
      var cmd = list[i], p = cmd.parameters || [];
      if (cmd.code !== C.TRANSFER || p[0] !== 1 || p[1] !== 4 || p[2] !== 5 || p[3] !== 6) continue;
      var dest = typeof $gameVariables !== 'undefined' && $gameVariables ? $gameVariables.value(4) : 0;
      // The map index is already in memory. Do not open a map file from the entry scan.
      var name = dest && dest !== here && BMA.MapNames._infoName(dest);
      return name ? 'To ' + name : 'Exit';
    }
    return '';
  },

  // "To <destination map>" — the thing an exit list is actually for.
  _exitKind: function (list) {
    try {
      for (var i = 0; i < list.length; i++) {
        if (list[i].code !== C.TRANSFER) continue;
        var p = list[i].parameters;
        if (p[0] === 1) return 'Exit';                       // destination held in variables
        // Same-map transfers never reach here any more — classify() files them as portals — so
        // everything left is a genuine way off this map.
        var dest = BMA.MapNames.get(p[1]);
        return dest ? 'To ' + dest : 'Exit';
      }
    } catch (e) {}
    return 'Exit';
  },

  // Where does this door go? Read back off the event's active page.
  _transferOf: function (ev) {
    try {
      var list = (ev.page() || {}).list || [];
      var mapId = $gameMap.mapId();
      var branch = CLEFT_ROUTE_SWITCH[mapId] && this._cleftTransfer(list, mapId, this._cleftMode(mapId));
      if (branch) return { mapId: mapId, x: branch.parameters[2], y: branch.parameters[3] };
      for (var i = 0; i < list.length; i++) {
        if (list[i].code !== C.TRANSFER) continue;
        var p = list[i].parameters;
        if (p[0] !== 0) return null;                        // destination held in variables
        return { mapId: p[1], x: p[2], y: p[3] };
      }
    } catch (e) {}
    return null;
  },

  _cleftMode: function (mapId) {
    var id = CLEFT_ROUTE_SWITCH[mapId];
    return id ? !!(typeof $gameSwitches !== 'undefined' && $gameSwitches && $gameSwitches.value(id)) : null;
  },

  // Only these two maps have the verified switch-only markers and two-way door scripts.
  _cleftMarker: function (page, mapId) {
    var id = CLEFT_ROUTE_SWITCH[mapId];
    var command = id && page.priorityType === 0 && page.list.length === 2 && page.list[0];
    var p = command && command.parameters;
    return command && command.code === C.SWITCH && p[0] === id && p[1] === id ? p[2] === 0 : null;
  },

  _cleftTransfer: function (list, mapId, mode) {
    var id = CLEFT_ROUTE_SWITCH[mapId];
    var head = list[0];
    if (!id || !head || head.code !== 111 || head.parameters[0] !== 0 || head.parameters[1] !== id) return null;
    var useThen = mode === (head.parameters[2] === 0);
    var then = null, otherwise = null, inElse = false;
    for (var i = 1; i < list.length; i++) {
      var c = list[i];
      if (c.code === 411 && c.indent === 0) inElse = true;
      else if (c.code === C.TRANSFER && c.indent === 1 && c.parameters[0] === 0 && c.parameters[1] === mapId) {
        if (inElse) otherwise = c; else then = c;
      } else if (c.code !== 0 && c.code !== 250 && c.code !== 412) return null;
    }
    return then && otherwise ? (useThen ? then : otherwise) : null;
  },

  // The 20 Infinitarium rooms choose a random room while the event is running. Their
  // same-map branch is one possible outcome, not a crossing the player can select.
  _infinitariumPassage: function (list, mapId) {
    if (mapId < 508 || mapId > 527) return false;
    var rolls = false, finishes = false;
    for (var i = 0; i < list.length; i++) {
      var c = list[i];
      var p = c.parameters;
      if (c.code === C.VARIABLE && p[0] === 9 && p[1] === 9 && p[2] === 0 &&
          p[3] === 2 && p[4] === 1 && p[5] === 20) rolls = true;
      if (c.code === C.TRANSFER && p[0] === 0 && p[1] === 528) finishes = true;
      if (rolls && finishes) return true;
    }
    return false;
  },

  // Doors are named after where they go. That is the right answer almost everywhere — "To Branch
  // Catacombs", "To Faluhd Castle" — and looking inside those instead produced "Mozme's house"
  // and "House, 3 people, 5 chests", which is worse than useless.
  //
  // It only breaks down when several doors on one map lead into the SAME unnamed map: Valla's
  // seven all read "To Valla Interiors", which cannot tell the inn from the weapon shop. That is
  // the case worth looking inside, and the only one. Anything still duplicated afterwards gets a
  // number, ordered outward from the tile the player arrived on — straight-line, so the ordering
  // holds for the whole visit rather than drifting as they walk.
  // A doorway that lands back on this map is category 'door', never 'exit', so it never reaches
  // the destination grouping below and could only ever be "Door 1..24". Faluhd Castle has 24 of
  // them, Castle Interior 15, Lenadia 10 — in those castles every room is behind one, and the
  // rooms were the entire content of the map.
  //
  // Its own pass, ahead of everything else, because _disambiguateDoors gives up early on a map
  // with fewer than two exits — and Faluhd Castle has exactly one, so all 24 of its doorways were
  // still being numbered after the room table was written.
  //
  // The room table answers first and the peek fills in the rest. Gated on settlement for the same
  // reason the exit grouping is: a shrine's side rooms want numbering, not a description of what
  // happens to be standing in them.
  _nameInnerDoorways: function () {
    try {
      var here = $gameMap.mapId();
      if (!BMA.DoorPeek.isSettlement(here, here)) return;
      var inner = this.entities.filter(function (e) { return e.category === 'door'; });
      for (var i = 0; i < inner.length; i++) {
        var d = this._transferOf(inner[i].ev);
        if (!d) continue;
        var named = (this.ROOMS[d.mapId] || {})[d.x + ',' + d.y] ||
                    BMA.DoorPeek.label(d.mapId, d.x, d.y);
        if (named) inner[i].name = named;
      }
    } catch (e) {}
  },

  // Number the passage, not the tile.
  //
  // A doorway that lands back on this map is two events, one at each end, and numbering them
  // separately orders them by straight-line distance from where the player came in — which
  // guarantees the two ends get unrelated numbers, because the far end of a passage is nowhere
  // near its near end. In Life Shrine that produced "Door 16" at (23,50) and "Door 22" at the
  // tile it lands you on, with nothing to say they were the same passage. Forty-eight of them,
  // all identical to look at, is the whole map: "the doors move him to different parts of the
  // map" is exactly what that feels like from the inside.
  //
  // So both ends of a two-way pair answer to one name. That name is also the instruction —
  // "take Door 5" works from either side, and the Door 5 the player lands beside is the way
  // back. A pad that does not come back is numbered on its own and says so: walking onto one is
  // not reversible, and that is worth knowing before rather than after.
  //
  // Only the bare ones get renamed. A doorway the room table or the peek has already named is a
  // better answer than any number, and pairing must not overwrite it — but those still take part
  // in the pairing, or a door whose way back happens to be named reads "one way" when it is not.
  // Throne Room's four pads are exactly that: each one's return is "Room, 1 person, 1 chest".
  _pairInnerDoorways: function () {
    try {
      var here = $gameMap.mapId();
      var doors = this.entities.filter(function (e) { return e.category === 'door'; });
      if (doors.length < 2) return;

      var dest = [], bare = [], i, j, anyBare = false;
      for (i = 0; i < doors.length; i++) {
        var d = this._transferOf(doors[i].ev);
        dest.push(d && d.mapId === here ? d : null);
        bare.push(doors[i].name === 'Door');
        if (bare[i]) anyBare = true;
      }
      if (!anyBare) return;

      // Reciprocal: the door at the other end lands back where I stand. Within a step, not on
      // the exact tile — a stairway lands the player one square clear of the return event so it
      // does not fire the instant they arrive, so the two are never quite each other's
      // destination. Life Shrine's (9,22) lands at (81,62) and the way back is at (81,63).
      //
      // Both directions have to hold, which is what keeps a chain apart from a pair: the shrine's
      // (67,52) -> (69,58) -> (82,58) -> (67,52) is three one-way pads, and each of them says so.
      var near = function (t, e) {
        return !!t && BMA.Util.tileDist(t.x - e.x, t.y - e.y) <= 1;
      };
      var partner = [];
      for (i = 0; i < doors.length; i++) partner.push(-1);
      for (i = 0; i < doors.length; i++) {
        if (partner[i] >= 0 || !dest[i]) continue;
        for (j = 0; j < doors.length; j++) {
          if (j === i || partner[j] >= 0 || !dest[j]) continue;
          if (!near(dest[i], doors[j]) || !near(dest[j], doors[i])) continue;
          partner[i] = j; partner[j] = i;
          break;
        }
      }

      var a = this._arrival && this._arrival.mapId === here
              ? this._arrival : { x: $gamePlayer.x, y: $gamePlayer.y };
      var order = doors.map(function (e, k) { return k; }).sort(function (p, q) {
        return BMA.Util.tileDist(doors[p].x - a.x, doors[p].y - a.y) -
               BMA.Util.tileDist(doors[q].x - a.x, doors[q].y - a.y);
      });

      // Numbered outward from the tile the player came in on, so the ordering holds for the whole
      // visit rather than drifting as they walk. A named end takes no number and gives none away:
      // only the bare ends count, and a pair of them shares one.
      var num = [], next = 0;
      for (var k = 0; k < order.length; k++) {
        i = order[k];
        if (num[i] !== undefined || !bare[i]) continue;
        num[i] = ++next;
        if (partner[i] >= 0 && bare[partner[i]]) num[partner[i]] = next;
      }
      for (i = 0; i < doors.length; i++) {
        if (!bare[i]) continue;
        doors[i].name = 'Door ' + num[i] + (partner[i] >= 0 ? '' : ', one way');
        doors[i].paired = true;                  // keep _numberDuplicates off it
      }
    } catch (e) {}
  },

  _disambiguateDoors: function () {
    try {
      this._nameInnerDoorways();
      this._pairInnerDoorways();

      var doors = this.entities.filter(function (e) { return e.category === 'exit'; });
      if (doors.length < 2) return;

      // Peek only into a shared, unnamed destination.
      var byDest = {}, i, d;
      for (i = 0; i < doors.length; i++) {
        d = this._transferOf(doors[i].ev);
        doors[i]._dest = d;
        if (d) (byDest[d.mapId] || (byDest[d.mapId] = [])).push(doors[i]);
      }
      for (var mid in byDest) {
        if (byDest[mid].length < 2) continue;
        if (!BMA.DoorPeek.namesNothing($gameMap.mapId(), Number(mid))) continue;
        // Houses belong to towns and castles. A shrine's side rooms only need numbering, and
        // describing them as somebody's house was the two rules crossing over.
        if (!BMA.DoorPeek.isSettlement($gameMap.mapId(), Number(mid))) continue;
        for (i = 0; i < byDest[mid].length; i++) {
          var e = byDest[mid][i];
          var peek = BMA.DoorPeek.label(e._dest.mapId, e._dest.x, e._dest.y);
          if (peek) e.name = peek;
        }
      }

      // A wide doorway is several events and one way through. Lindblum Castle's front gate is
      // seven tiles, its inn door three, and Branch Castle's way into Darius Training seven —
      // every tile of each carries its own Transfer, and all of them land the player on the SAME
      // destination tile. Numbering those "door 1..7" invents six choices that do not exist and
      // sends a player hunting for a door 5 that is nothing but the next tile of the same arch.
      //
      // So ordinals count destinations, not events: doors sharing a landing tile share a name and
      // a number, and a name used by only one doorway is not numbered at all. 1,485 of this
      // game's door entries are redundant tiles of a wider doorway.
      //
      // Branch Castle keeps "To Quarters, door 1/2" and "To Hall, door 1/2" — those really are
      // two doors each, landing in different places.
      var landing = function (q) {
        var dd = q._dest;
        if (dd) return dd.mapId + ',' + dd.x + ',' + dd.y;
        // No readable destination: fall back to something unique per door, so an unknown
        // landing is never mistaken for a shared one and collapsed into its neighbour.
        try { return 'e' + q.ev.eventId(); } catch (e) {}
        return 'p' + q.x + ',' + q.y;
      };
      var seen = {};
      for (i = 0; i < doors.length; i++) {
        var n = doors[i].name;
        (seen[n] || (seen[n] = {}))[landing(doors[i])] = true;
      }
      var ambiguous = doors.filter(function (q) {
        return Object.keys(seen[q.name]).length > 1 || /^(Exit|Door)$/.test(q.name);
      });
      if (!ambiguous.length) return;

      var a = this._arrival && this._arrival.mapId === $gameMap.mapId()
              ? this._arrival : { x: $gamePlayer.x, y: $gamePlayer.y };
      ambiguous.sort(function (p, q) {
        return BMA.Util.tileDist(p.x - a.x, p.y - a.y) - BMA.Util.tileDist(q.x - a.x, q.y - a.y);
      });
      var counters = {}, ordinal = {};
      for (var k = 0; k < ambiguous.length; k++) {
        var e = ambiguous[k], base = e.name;
        var lk = base + '|' + landing(e);
        var num = ordinal[lk];
        if (num === undefined) num = ordinal[lk] = (counters[base] = (counters[base] || 0) + 1);
        e.name = /^(Exit|Door)$/.test(base) ? 'Door ' + num : base + ', door ' + num;
      }
    } catch (e) {}
  },

  // The same problem for the two lists that have no destination map to look into: a map with
  // eleven interior doorways has eleven things all called "Portal", and a player cycling them
  // cannot tell which one they are standing at. Ordered outward from the tile they arrived on —
  // straight-line, so the numbering holds for the whole visit rather than drifting as they walk.
  _numberDuplicates: function (category, word) {
    try {
      // Anything _pairInnerDoorways has already numbered is left alone: the two ends of one
      // passage share a name on purpose, and the duplicate test below would split them again.
      var list = this.entities.filter(function (e) {
        return e.category === category && !e.paired;
      });
      if (list.length < 2) return;
      var BARE = /^(Exit|Door|Portal|Closed door)$/;
      var seen = {}, i;
      for (i = 0; i < list.length; i++) seen[list[i].name] = (seen[list[i].name] || 0) + 1;
      var ambiguous = list.filter(function (q) { return seen[q.name] > 1 || BARE.test(q.name); });
      if (!ambiguous.length) return;

      var a = this._arrival && this._arrival.mapId === $gameMap.mapId()
              ? this._arrival : { x: $gamePlayer.x, y: $gamePlayer.y };
      ambiguous.sort(function (p, q) {
        return BMA.Util.tileDist(p.x - a.x, p.y - a.y) - BMA.Util.tileDist(q.x - a.x, q.y - a.y);
      });
      var counters = {};
      for (var k = 0; k < ambiguous.length; k++) {
        var e = ambiguous[k], base = e.name;
        counters[base] = (counters[base] || 0) + 1;
        // No word: the name already is the noun, so it just takes a number. That is what a
        // scripted scene wants — "Conversation 1" and "Conversation 2" — and it also means a
        // lone one keeps the bare "Conversation", since only a duplicate is ambiguous.
        e.name = (BARE.test(base) || !word) ? base + ' ' + counters[base]
                                            : base + ', ' + word + ' ' + counters[base];
      }
    } catch (e) {}
  },

  // The speaker tag this game puts at the head of nearly every line of dialogue. Matched
  // against RAW command text: cleanText() strips \C[n] and <...>, which would erase both
  // forms before we could read them.
  _SPEAKER_RAW: [ /^\s*\\C\[\d+\]\s*([^\\\n:]{1,28}?)\s*:\s*\\C\[\d+\]/,
                  /\\n<\s*([^>]{1,30})\s*>/ ],
  _SPEAKER_CLEAN: /^\s*([A-Z][A-Za-z' .\-]{1,24}):\s/,

  speakerOf: function (page) {
    try {
      if (!page || page.trigger === 3 || page.trigger === 4) return null;
      var list = page.list || [], raw = null;
      for (var i = 0; i < list.length && raw === null; i++) {
        if (list[i].code !== C.TEXT) continue;
        var lines = [];
        for (var j = i + 1; j < list.length && list[j].code === C.TEXT_CONT; j++) {
          lines.push(list[j].parameters[0]);
        }
        if (lines.length) raw = lines.join(' ');
      }
      if (!raw) return null;
      for (var k = 0; k < this._SPEAKER_RAW.length; k++) {
        var m = raw.match(this._SPEAKER_RAW[k]);
        if (m) return m[1].trim();
      }
      var m2 = BMA.Util.cleanText(raw).match(this._SPEAKER_CLEAN);
      return m2 ? m2[1].trim() : null;
    } catch (e) { return null; }
  },

  _isPartyActor: function (name) {
    try {
      var lower = name.toLowerCase();
      for (var i = 1; i < $dataActors.length; i++) {
        var a = $dataActors[i];
        if (a && a.name && a.name.trim().toLowerCase() === lower) return true;
      }
    } catch (e) {}
    return false;
  },

  // Name to speak, or '' to let scan() assign a numbered fallback.
  //
  // The editor's event name is unreliable here — most are EV012, and the meaningful ones
  // are often stale state labels ("Hans Out of Party", "Lyne2"). The speaker tag on the
  // event's own dialogue is what the game shows the player, so it wins, except when a
  // party member speaks the first line: that means the event is a cutscene and the name
  // belongs to somebody else.
  entityName: function (ev, info) {
    var kind = info && info.kind;
    if (kind) return kind;          // exits/shops/save points describe themselves

    var en = '';
    try {
      var nm = ev.event() && ev.event().name;
      if (nm && nm.trim() && !/^EV\d+$/i.test(nm.trim()) && !/^event$/i.test(nm.trim())) en = nm.trim();
    } catch (e) {}

    var sp = null;
    try { sp = this.speakerOf(ev.page()); } catch (e) {}

    if (sp && en) {
      var a = sp.toLowerCase(), b = en.toLowerCase();
      if (a.indexOf(b) >= 0 || b.indexOf(a) >= 0) return sp;   // same character, one is a label
      if (this._isPartyActor(sp)) return en;                   // cutscene: not this NPC talking
      return sp;
    }
    // A party member's line does not name the thing it is spoken at — but only when that thing
    // is not a person. Two cases, and between them they are every one in the game:
    //
    //   a prop.  Gulgur Volcano's five sealing glyphs run "\n<Elina>Glyph begone!" when you
    //            dispel them, and all five came out called "Elina" — on a map where Elina is
    //            also in the party. See PROP_SPRITES.
    //   nothing. An event that draws no graphic at all is a tile that fires a scene when you
    //            walk over it, and nobody is standing on it. Aether Mine's (140,79) is the party
    //            working out what Atomos is; it hands over an item at the end, so it is filed as
    //            treasure, and it was called "Vahn". Seventeen of these, all invisible and all
    //            touch-triggered.
    //
    // Not simply "never name anything after a party member", which is wrong 22 times over: a
    // party member standing on a map before or after they join IS the person standing there, and
    // the wider rule renames Biggs and Wedge in the Quarters to "NPC 1" and "NPC 2", Brindle in
    // his own hovel to "NPC 1", and Ovelia in her hidden abode to "Portal one day". Every one of
    // those has a character sprite; not one of the seventeen has any graphic at all.
    if (sp && this._isPartyActor(sp)) {
      try {
        var pg = ev.page(), pimg = (pg && pg.image) || {};
        if (this._propSprite(pg) || (!pimg.characterName && !(pimg.tileId > 0))) sp = null;
      } catch (e3) {}
    }
    // Nobody speaks for it and the editor never named it. Let it describe itself before
    // falling back to a bare category number — see _selfDescribedName.
    if (!sp && !en) {
      try { return this._selfDescribedName(ev.event()); } catch (e2) { return ''; }
    }
    return sp || en || '';
  },

  //---------------------------------------------------------------------------
  // Filtering / selection
  //---------------------------------------------------------------------------
  filtered: function () {
    this.ensureScanned();
    this._syncPositions();          // moving NPCs/vehicles report their live tile
    var px = $gamePlayer.x, py = $gamePlayer.y;
    var list = this.entities.filter(function (e) {
      // Neither a crossing nor a trap is somewhere you set out for, so neither belongs in "all" —
      // Naddaha Pyramid's 51 traps would bury its 18 chests and its way on.
      //
      // Both stay cycleable inside their own category, and for the same reason: the point is to
      // find out where they are. That was already true of traps. It turned out to be true of
      // crossings too — Archareon Prison is a scatter of platforms joined only by thirteen gap
      // jumps, so travelling it means going from crossing to crossing, and with them unlistable
      // the whole map offered a save point and four pads and no way to reach anything.
      if ((e.category === 'crossing' || e.category === 'trap') &&
          BMA.Nav.category === 'all') return false;
      return BMA.Nav.category === 'all' || e.category === BMA.Nav.category;
    });
    // Nearest-first: the list scans outward from the player's current tile.
    var nav = this;
    list.sort(function (a, b) {
      return nav.spanDist(px, py, a.x, a.y) - nav.spanDist(px, py, b.x, b.y);
    });
    if (BMA.Config.pathFilter) {
      var self = this;
      list = list.filter(function (e) { return self.reachable(e); });
    }
    return list;
  },

  //---------------------------------------------------------------------------
  // Diagnostics
  //---------------------------------------------------------------------------
  // One block in bma_log.txt describing exactly what the pathfinder can see from where the player
  // is standing. Written because "everything is unreachable" and "there is genuinely nothing else
  // in this room" sound identical from outside, and narrowing that by inference cost several
  // rounds. The reached-tile count and bounding box settle it in one run: a flood covering a few
  // dozen tiles bounded to one room means the map really is partitioned, and a flood covering one
  // or two tiles means the BFS is collapsing.
  //
  // Reads the cached floods rather than recomputing — both are already keyed on the player's tile.
  _floodStats: function (relaxed) {
    var f = this.flood(relaxed), n = 0;
    var x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (var i = 0; i < f.dist.length; i++) {
      if (f.dist[i] === -1) continue;
      n++;
      var x = i % f.w, y = (i - x) / f.w;
      if (x < x0) x0 = x; if (x > x1) x1 = x;
      if (y < y0) y0 = y; if (y > y1) y1 = y;
    }
    return { n: n, failed: !!f.failed, w: f.w, h: f.h,
             box: n ? (x0 + ',' + y0 + '..' + x1 + ',' + y1) : 'empty' };
  },

  // Which class of approach tile, if any, the flood actually reached — the reason a goal resolved
  // or did not.
  _approachReport: function (e, relaxed) {
    var f = this.flood(relaxed), w = f.w, h = f.h;
    var on = (e.x >= 0 && e.y >= 0 && e.x < w && e.y < h && f.dist[e.y * w + e.x] !== -1);
    var nb = false, ctr = false, i, nx, ny;
    for (i = 0; i < APPROACH.length; i++) {
      nx = e.x + APPROACH[i].dx; ny = e.y + APPROACH[i].dy;
      if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
      if (f.dist[ny * w + nx] !== -1) { nb = true; break; }
    }
    try {
      if ($gameMap.isCounter) {
        for (i = 0; i < DIRS.length; i++) {
          var cx = e.x + DIRS[i].dx, cy = e.y + DIRS[i].dy;
          if (cx < 0 || cy < 0 || cx >= w || cy >= h) continue;
          if (!$gameMap.isCounter(cx, cy)) continue;
          nx = cx + DIRS[i].dx; ny = cy + DIRS[i].dy;
          if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
          if (f.dist[ny * w + nx] !== -1) { ctr = true; break; }
        }
      }
    } catch (err) {}
    return (on ? 'own' : '-') + '/' + (nb ? 'adj' : '-') + '/' + (ctr ? 'counter' : '-');
  },

  logDiagnostics: function () {
    try {
      var name = BMA.MapNames.current() || '?';
      var self = this;
      var reachableCount = this.entities.filter(function (e) { return self.reachable(e); }).length;
      var s = this._floodStats(false), r = this._floodStats(true);
      BMA.Log.write('--- nav diagnostics ---');
      BMA.Log.write('  map ' + $gameMap.mapId() + ' "' + name + '" ' + s.w + 'x' + s.h +
                    '  player ' + $gamePlayer.x + ',' + $gamePlayer.y +
                    '  pathFilter=' + (BMA.Config.pathFilter ? 'on' : 'off') +
                    '  category=' + this.category);
      BMA.Log.write('  entities ' + this.entities.length + ' total, ' + reachableCount +
                    ' reachable');
      BMA.Log.write('  flood strict : ' + s.n + ' tiles' + (s.failed ? ' FAILED' : '') +
                    '  box ' + s.box);
      BMA.Log.write('  flood relaxed: ' + r.n + ' tiles' + (r.failed ? ' FAILED' : '') +
                    '  box ' + r.box);
      // Counted out loud so an unmodelled crossing shows up as a number here rather than as a
      // player wondering why half a map is missing. "0 edges, 0 skipped" on a map that clearly
      // needs crossings means the route reader found nothing it understood.
      try {
        var wp = this.warps();
        var jumps = 0, ports = 0;
        for (var wi = 0; wi < wp.edges.length; wi++) {
          if (wp.edges[wi].kind === 'portal') ports++; else jumps++;
        }
        BMA.Log.write('  warp edges   : ' + jumps + ' jump, ' + ports + ' portal, ' +
                      wp.unknowable + ' route(s) skipped as unpredictable' +
                      (wp.hazards.length ? ' at ' + wp.hazards.slice(0, 6).map(function (z) {
                        return z.x + ',' + z.y; }).join(' ') : ''));
        // Where the pipeline stopped. "0 events with a player move route" means the route reader
        // never saw one; "N routes but 0 edges" means it saw them and rejected them; edges but no
        // crossings in the list means they were built and then lost downstream.
        var owners = 0;
        for (var ok in wp.byEvent) if (wp.byEvent.hasOwnProperty(ok)) owners++;
        var crossings = this.entities.filter(function (e) {
          return e.category === 'crossing'; }).length;
        BMA.Log.write('  warp sources : ' + wp.seen + ' events, ' + wp.paged +
                      ' with a live page, ' + wp.routed + ' branch(es) with a player move route, ' +
                      owners + ' event(s) own an edge, ' + crossings + ' crossing(s) in the list');
        for (var rj = 0; rj < wp.routes.length; rj++) {
          BMA.Log.write('     route ' + wp.routes[rj]);
        }
      } catch (ew) { BMA.Log.write('  warp edges   : unavailable (' + (ew && ew.message) + ')'); }
      // Same reasoning as the warp counts: "no traps on this map" and "the trap test matched
      // nothing it should have" are indistinguishable from outside without a number.
      try {
        var armed = this.entities.filter(function (q) { return q.category === 'trap'; });
        var sealed = Object.keys(this.gates().byTile);
        BMA.Log.write('  traps        : ' + armed.length + ' armed' +
                      (armed.length ? ' (' + armed[0].name + ')' : ''));
        BMA.Log.write('  gates        : ' + sealed.length + ' sealed');
      } catch (eg) { BMA.Log.write('  traps/gates  : unavailable (' + (eg && eg.message) + ')'); }
      var list = this.entities.slice(0, 60);          // a cap, so a 300-event map cannot flood the log
      for (var i = 0; i < list.length; i++) {
        var e = list[i];
        BMA.Log.write('   ' + (this.reachable(e) ? 'R ' : '. ') +
                      String(e.category).substr(0, 4) + ' ' + (e.x + ',' + e.y) +
                      ' d' + BMA.Util.tileDist(e.x - $gamePlayer.x, e.y - $gamePlayer.y) +
                      ' strict[' + this._approachReport(e, false) + ']' +
                      ' relaxed[' + this._approachReport(e, true) + ']  ' + e.name);
      }
      if (this.entities.length > list.length) {
        BMA.Log.write('   ... ' + (this.entities.length - list.length) + ' more');
      }
      BMA.Log.write('--- end nav diagnostics ---');
      // Returned rather than spoken: the caller (the mod menu) speaks it, and the headline numbers
      // are worth hearing without opening the log.
      return 'written. ' + s.n + ' tiles reachable, ' + reachableCount + ' of ' +
             this.entities.length + ' destinations';
    } catch (e) {
      BMA.Log.write('logDiagnostics threw: ' + (e && (e.stack || e.message)));
      return 'failed, see log';
    }
  },

  current: function () {
    var list = this.filtered();
    if (!list.length) return null;
    if (this.index >= list.length) this.index = 0;
    if (this.index < 0) this.index = list.length - 1;
    var found = this._indexOfSel(list);
    if (found >= 0) this.index = found;
    return list[this.index];
  },

  _pin: function (e) {
    this._sel = e ? { ref: e.ev || e.veh || null, cat: e.category, x: e.x, y: e.y, name: e.name } : null;
  },

  // Index of the pinned selection in a freshly-sorted list, or -1. Reference first, so focus
  // stays glued to the same entity as it moves and as the distance sort reorders the list;
  // then exact tile + category, then name + category, to recover a replaced object.
  _indexOfSel: function (list) {
    var s = this._sel, i;
    if (!s) return -1;
    if (s.ref) for (i = 0; i < list.length; i++)
      if (list[i].ev === s.ref || list[i].veh === s.ref) return i;
    for (i = 0; i < list.length; i++)
      if (list[i].category === s.cat && list[i].x === s.x && list[i].y === s.y) return i;
    if (s.name) for (i = 0; i < list.length; i++)
      if (list[i].category === s.cat && list[i].name === s.name) return i;
    return -1;
  },

  //---------------------------------------------------------------------------
  // Cycling
  //---------------------------------------------------------------------------
  cycle: function (dir) {
    var list = this.filtered();
    if (!list.length) {
      BMA.Speech.speak('No ' + (this.category === 'all' ? 'destinations' : CAT_LABEL[this.category]) +
                       (BMA.Config.pathFilter ? ' reachable' : ''), { priority: 'critical' });
      return;
    }
    // Re-anchor to the pinned selection before stepping, so a distance re-sort between
    // keypresses steps relative to the selected entity, not to whatever slid into its index.
    var base = this._indexOfSel(list);
    if (base >= 0) this.index = base;
    else if (this.index >= list.length || this.index < 0) this.index = 0;
    this.index = (this.index + dir + list.length) % list.length;
    this._pin(list[this.index]);
    this.announce(list[this.index]);
  },

  switchCategory: function (dir) {
    var i = CATEGORIES.indexOf(this.category);
    i = (i + dir + CATEGORIES.length) % CATEGORIES.length;
    this.category = CATEGORIES[i];
    this.index = 0; this._sel = null;
    var list = this.filtered();
    // One utterance, "category: selection". Speaking the count and the selection as two
    // critical lines meant the second interrupted the first and the count was never heard.
    var label = CAT_LABEL[this.category];
    label = label.charAt(0).toUpperCase() + label.slice(1);
    if (!list.length) {
      BMA.Speech.speak(label + ': none', { priority: 'critical' });
      return;
    }
    this._pin(list[0]);
    BMA.Speech.speak(label + ': ' + this.phrase(list[0]), { priority: 'critical' });
    if (BMA.Config.beacon) this._refreshBeacon();
  },

  resetCategory: function () { this.category = 'all'; this.index = 0; this._sel = null;
    BMA.Speech.speak('All destinations', { priority: 'critical' }); },

  //---------------------------------------------------------------------------
  // Custom labels — hand-typed names for anything the game leaves unclear. Persisted to
  // www/mod/entity_labels.json and prioritized over the automatic numbering.
  //---------------------------------------------------------------------------
  initLabels: function () {
    try {
      this._labelFs = require('fs'); this._labelPath = require('path');
      if (BMA.TTS.modDir) {
        this._labelFile = this._labelPath.join(BMA.TTS.modDir, 'entity_labels.json');
        if (this._labelFs.existsSync(this._labelFile))
          this._custom = JSON.parse(this._labelFs.readFileSync(this._labelFile, 'utf8')) || {};
      }
    } catch (e) { this._custom = {}; }
  },

  _saveLabels: function () {
    if (this._labelDirty) return;                 // debounce: one write per drain, not per key
    this._labelDirty = true;
    var self = this;
    BMA.defer(function () {
      self._labelDirty = false;
      try { if (self._labelFile) self._labelFs.writeFileSync(self._labelFile, JSON.stringify(self._custom, null, 1)); } catch (e) {}
    });
  },

  customLabel: function () {
    var e = this.current();
    if (!e || !e.ev) {
      BMA.Speech.speak(e ? 'Cannot label this' : 'No entity selected', { priority: 'critical' });
      return;
    }
    var mapId = $gameMap.mapId(), id = e.ev.eventId();
    var store = this._custom[mapId] || (this._custom[mapId] = {});
    var input = null;
    try { input = window.prompt('Custom label (blank to clear):', store[id] || e.name); } catch (err) {}
    if (input === null) { BMA.Speech.speak('Cancelled', { priority: 'critical' }); return; }
    input = String(input).trim();
    if (input === '') {
      delete store[id];
      this._saveLabels();
      var fresh = this._makeRecord(e.ev);         // revert to the deterministic auto-label
      e.name = fresh ? fresh.name : e.name;
      this._pin(e);
      BMA.Speech.speak('Label cleared', { priority: 'critical' });
      return;
    }
    store[id] = input;
    this._saveLabels();
    e.name = input;                               // e is the live record; the beacon/announce see it at once
    this._pin(e);
    BMA.Speech.speak('Labeled ' + input, { priority: 'critical' });
  },

  // "Inn, 5 steps north" — the entity phrase shared by cycling and category switching.
  //
  // The step count is the real walking distance when a route is known. tileDist is Chebyshev,
  // so a target 5 east and 5 south used to be announced as "5 steps southeast" when it is a
  // 10-step walk; the bearing stays straight-line because that is what the player steers by.
  // Falls back to the straight-line count when there is no route to measure.
  phrase: function (e) {
    var s = this.span($gamePlayer.x, $gamePlayer.y, e.x, e.y);
    var dx = s.dx, dy = s.dy;
    var n = null;
    try {
      var t = this.pathTiles(e.x, e.y) || this.pathTiles(e.x, e.y, true);
      if (t && t.length > 1) n = t.length - 1;
    } catch (err) {}
    if (n === null) n = BMA.Util.tileDist(dx, dy);
    return e.name + ', ' + BMA.Util.pluralSteps(n) + ' ' + BMA.Util.compass(dx, dy);
  },

  announce: function (e, brief) {
    if (!e) return;
    BMA.Speech.speak(this.phrase(e), { priority: 'critical' });
    if (BMA.Config.beacon) this._refreshBeacon();
  },

  reannounce: function () { var e = this.current(); if (e) this.announce(e); else BMA.Speech.speak('No destination', { priority: 'critical' }); },

  //---------------------------------------------------------------------------
  // Looping maps — where walking off one edge puts you on the other.
  //
  // 17 of this game's 645 maps set a looping scrollType, and for most of them it never mattered:
  // all four Overworlds, the Underworld, Floating Ruins and Archareon Prison are ringed by ocean
  // or open void, so no tile pair across the seam is mutually passable and a flood that stopped
  // at the edge lost nothing.
  //
  // The Moon is the one that pays for it. 45 of its rows and 30 of its columns join up, and
  // clipping at the edge floods 195 of its 3,347 walkable tiles — so on a map whose entire
  // surface is one connected piece, everything past the seam answered "beyond the area you can
  // reach". Five of the nine 50x40 "Map N" maps lose between 29 and 386 tiles the same way.
  //
  // The engine has been wrapping all along: canPass goes through roundXWithDirection, so it was
  // already answering about the tile on the far side and only the BFS's own bounds test threw
  // the step away.
  //
  // Two different jobs here, and they are kept apart deliberately:
  //   _loops    — read once per flood. The neighbour test is the innermost loop on a 250x230
  //               map, so it gets plain integer compares against hoisted booleans, not a call.
  //   spanX/Y   — shortest signed offset between two columns/rows, for everything that speaks a
  //               direction. Without it a raw subtraction points the player the long way round
  //               the world: on The Moon, 4 steps west is announced as 71 steps east.
  _loops: function () {
    try { return { h: !!$gameMap.isLoopHorizontal(), v: !!$gameMap.isLoopVertical() }; }
    catch (e) { return { h: false, v: false }; }
  },

  // A coordinate brought onto the map, or -1 when it fell off an edge that does not loop.
  // For offsets bigger than one tile (a jump edge, a transfer landing), so it takes the modulo
  // rather than assuming the opposite edge.
  _wrapX: function (x, w, loopH) {
    if (x >= 0 && x < w) return x;
    if (!loopH) return -1;
    return ((x % w) + w) % w;
  },
  _wrapY: function (y, h, loopV) {
    if (y >= 0 && y < h) return y;
    if (!loopV) return -1;
    return ((y % h) + h) % h;
  },

  spanX: function (dx) {
    var w;
    try { if (!$gameMap.isLoopHorizontal()) return dx; w = $gameMap.width(); }
    catch (e) { return dx; }
    if (dx > w / 2) return dx - w;
    if (dx < -w / 2) return dx + w;
    return dx;
  },
  spanY: function (dy) {
    var h;
    try { if (!$gameMap.isLoopVertical()) return dy; h = $gameMap.height(); }
    catch (e) { return dy; }
    if (dy > h / 2) return dy - h;
    if (dy < -h / 2) return dy + h;
    return dy;
  },

  // Shortest offset from one tile to another. Every bearing, beacon pan and distance sort goes
  // through this rather than subtracting coordinates.
  span: function (fromX, fromY, toX, toY) {
    return { dx: this.spanX(toX - fromX), dy: this.spanY(toY - fromY) };
  },

  // Straight-line distance between two tiles, wrap included.
  spanDist: function (fromX, fromY, toX, toY) {
    var s = this.span(fromX, fromY, toX, toY);
    return BMA.Util.tileDist(s.dx, s.dy);
  },

  //---------------------------------------------------------------------------
  // Pathfinding: BFS flood-fill from the player, full-path reconstruction.
  //---------------------------------------------------------------------------
  // Swap Game_Map's event lookups for O(1) index-backed versions while the BFS runs.
  //
  // canPass -> isCollidedWithEvents -> eventsXyNt -> events().filter() rebuilds and scans
  // the whole event array on EVERY call. Over a 250x230 map that is ~230k rebuilds of a
  // ~300-element array. Patching the lookup rather than reimplementing passability keeps
  // every plugin alias on canPass/isMapPassable (YEP_RegionRestrictions, YEP_X_VehicleRestrict)
  // in the path, so the paths produced are identical — just found far faster.
  //
  // ignoreEvents makes eventsXyNt report every tile as event-free, which is how the relaxed
  // flood below drops the collision term without reimplementing passability: canPass still runs,
  // still consults the tile flags and every plugin alias, and simply finds nobody standing there.
  // Vehicles are unaffected (isCollidedWithVehicles reads $gameMap.boat()/ship() directly), which
  // is right — a moored ship is not something that steps aside.
  _withEventIndex: function (w, fn, ignoreEvents) {
    var evs, index = {}, EMPTY = [];
    try {
      evs = $gameMap.events();
      for (var i = 0; i < evs.length; i++) {
        var e = evs[i], k = e._y * w + e._x;
        (index[k] || (index[k] = [])).push(e);
      }
    } catch (err) { return fn(); }

    var mapObj = $gameMap;
    var _events = mapObj.events, _xy = mapObj.eventsXy, _xyNt = mapObj.eventsXyNt;
    mapObj.events = function () { return evs; };
    mapObj.eventsXy = function (x, y) {
      var a = index[y * w + x];
      if (!a) return EMPTY;
      return a.filter(function (e) { return e.pos(x, y); });
    };
    mapObj.eventsXyNt = function (x, y) {
      if (ignoreEvents) return EMPTY;
      var a = index[y * w + x];
      if (!a) return EMPTY;
      return a.filter(function (e) { return e.posNt(x, y); });
    };
    try { return fn(); }
    finally { mapObj.events = _events; mapObj.eventsXy = _xy; mapObj.eventsXyNt = _xyNt; }
  },

  // Two floods from the player's tile, cached side by side:
  //
  //   strict  — where the player can walk right now. Blocking events are walls.
  //   relaxed — tile passability only; anything that could step aside is treated as passable.
  //
  // The relaxed pass exists because MV blocks any tile holding a normal-priority event
  // (rpg_objects.js isCollidedWithEvents), which makes chests, crystals, statues, NPCs, guards
  // AND door/gate events permanent walls to the BFS. canPass blocks *entering* such a tile but
  // never *leaving* it, so an event tile is a sink, not a bridge. On 80 of this game's 644 maps
  // that severs the walkable area outright — Rodenia's 522 walkable tiles collapse to a 201-tile
  // largest piece across 40 components — so a player standing in the wrong pocket floods only
  // that pocket and every single destination answers "no path found", while walking works fine
  // because they trigger the door or the NPC wanders off.
  //
  // Answering "there is a route, but X is standing in it" is both true and useful; answering
  // "no path found" is neither. The relaxed flood only runs when the strict one has already
  // failed, so the common case costs exactly what it did before.
  //   safe    — strict, with every live trap tile treated as a wall, so a route is only spoken
  //             across one when there is no other way round. On the 641 maps with no traps this
  //             is the strict flood itself, cached under the same key and computed once.
  _floods: { strict: null, relaxed: null, safe: null },

  // Same invalidation for all three: an event moving or a page flipping changes who is standing
  // where — and, on a trap map, which banks are still armed — which is exactly what the floods
  // and the wall memo each depend on.
  _clearFloods: function () {
    this._floods = { strict: null, relaxed: null, safe: null };
    this._wallKey = null;
    this._wallBlocked = null;
    this._warps = null;
    // Which events are gates — and which trap banks are still armed — depends on which page
    // each one is showing, so a switch thrown anywhere on the map retires both along with the
    // routes they invalidated.
    this._gates = null;
    this._trapCache = undefined;
    // Which events reset the blocks is read off active pages too, and a block that has just moved
    // is the commonest reason to be asking.
    this._blockResets = null;
  },

  //---------------------------------------------------------------------------
  // Warp edges — the ways across a map that are not walking.
  //
  // Some maps are not meant to be walked. Conall Curach is 45 terrain components over 1,349
  // walkable tiles: the player's landing area is 103 tiles and all 22 of its chests sit on
  // islands of their own. It is crossed by standing beside a marsh tile, facing it and pressing
  // the action button, which runs a move route on the PLAYER with Through on and jumps them
  // across. A walking BFS cannot see any of that, so every destination on the map answered
  // "no path found" while the area was perfectly playable.
  //
  // Two kinds of edge come out of the event data:
  //
  //   jump    — a Set Movement Route (205) targeting the player (-1). Its steps are fixed
  //             offsets, so the landing tile is exact arithmetic, not a guess.
  //   portal  — a Transfer Player (201) whose destination map is this map.
  //
  // Read from each event's ACTIVE page only, so a route behind an unmet switch contributes
  // nothing — which is right: Conall Curach's two shortcut moogles live behind "Conall Curach
  // Done" and genuinely do not exist on a first visit.
  _warps: null,

  // Sum one branch's worth of player move routes. Returns {dx, dy} or {unknowable: why}.
  //
  // Counts the route carried in the 205's own parameters and NOTHING else. MV mirrors every
  // route step as a 505 line straight after its 205 purely so the editor can display it;
  // counting those too doubles every distance, and the error is silent because the direction
  // still comes out right.
  _routeShift: function (cmds) {
    var dx = 0, dy = 0, unknowable = null, through = false, jumps = 0, steps = 0;
    for (var i = 0; i < cmds.length; i++) {
      var c = cmds[i];
      if (c.code !== 205 || !c.parameters || c.parameters[0] !== BRANCH_PLAYER) continue;
      var route = (c.parameters[1] && c.parameters[1].list) || [];
      for (var j = 0; j < route.length; j++) {
        var s = route[j];
        if (s.code === ROUTE_JUMP && s.parameters) {
          jumps++;
          dx += Number(s.parameters[0]) || 0;
          dy += Number(s.parameters[1]) || 0;
        } else if (ROUTE_STEP[s.code]) {
          steps++;
          dx += ROUTE_STEP[s.code][0];
          dy += ROUTE_STEP[s.code][1];
        } else if (ROUTE_UNKNOWABLE[s.code]) {
          unknowable = ROUTE_UNKNOWABLE[s.code];
        } else if (s.code === 37) {
          through = true;
        }
      }
    }
    // A route made only of jumps needs no Through to cross anything, and that is the engine's
    // doing rather than a reading of it: Game_CharacterBase.jump does `this._x += xPlus` and
    // checks nothing at all — no passability, no events, not even the map edge. Through governs
    // walking, and a jump is not walking. See the edge test in warps(), where this is the whole
    // difference between "a nudge inside ground you could already reach" and "a way across".
    return { dx: dx, dy: dy, unknowable: unknowable, through: through,
             jumpOnly: jumps > 0 && steps === 0 };
  },

  // Split a page's command list into branches, so a stepping stone that throws you a different
  // way per facing yields one edge per facing rather than one nonsense edge summing them all.
  // Only the "player is facing d" branch condition is understood; any other condition leaves
  // the branch unlabelled, which downstream treats as "reachable from any side".
  _branches: function (list) {
    var out = [], cur = { facing: null, cmds: [] }, stack = [];
    for (var i = 0; i < list.length; i++) {
      var c = list[i];
      if (c.code === 111) {
        out.push(cur);
        stack.push(cur.facing);
        var facing = null;
        if (c.parameters && c.parameters[0] === BRANCH_CHARACTER &&
            c.parameters[1] === BRANCH_PLAYER) facing = c.parameters[2];
        cur = { facing: facing, cmds: [] };
      } else if (c.code === 411) {                   // else: the facing test no longer holds
        out.push(cur);
        cur = { facing: null, cmds: [] };
      } else if (c.code === 412) {
        out.push(cur);
        cur = { facing: stack.length ? stack.pop() : null, cmds: [] };
      } else {
        cur.cmds.push(c);
      }
    }
    out.push(cur);
    return out;
  },

  // Every warp edge on this map, keyed on the map so a transfer rebuilds it.
  warps: function () {
    var mapId = $gameMap.mapId();
    if (this._warps && this._warps.key === mapId) return this._warps;

    var w = $gameMap.width(), h = $gameMap.height();
    var built = { key: mapId, edges: [], from: {}, hazards: [], unknowable: 0,
                  byEvent: {}, hazardEvents: {}, eventTile: {}, forced: {}, stops: null,
                  // Diagnosis for the one failure that cannot be seen from outside: a map whose
                  // crossings are missing looks identical whether this found no move routes at
                  // all, found them and rejected them, or found them and something downstream
                  // dropped the entities. Counted here so logDiagnostics can say which.
                  // Bounded, and `routes` only fills for events that actually carry a player
                  // move route, so a map with no crossings pays nothing.
                  seen: 0, paged: 0, routed: 0, routes: [] };
    var self = this;
    var loop = this._loops();
    var cleftMode = this._cleftMode(mapId);

    function stopAt(ev) {
      (built.stops || (built.stops = {}))[ev.y * w + ev.x] = true;
    }

    // "EV017" is the editor's placeholder, not a name. Speaking it tells the player to look for
    // something that has no appearance in the world they can match it to.
    function realName(n) { return (n && !/^ev\d+$/i.test(n)) ? n : ''; }

    // forced: the player does not choose to take this one. It fires the moment they stand on the
    // tile, so that tile is not ground they can walk across — see the flood.
    function addEdge(ox, oy, lx, ly, name, kind, evId, forced) {
      // On a looping map the tile you stand on to use a crossing, and the tile it throws you to,
      // can both be round the seam — the engine wraps them, so an edge running off the edge is a
      // real edge and not a malformed one. Off a non-looping edge it still is, and is dropped.
      ox = self._wrapX(ox, w, loop.h); oy = self._wrapY(oy, h, loop.v);
      lx = self._wrapX(lx, w, loop.h); ly = self._wrapY(ly, h, loop.v);
      if (ox < 0 || oy < 0 || lx < 0 || ly < 0) return;
      if (ox === lx && oy === ly) return;
      if (forced) built.forced[oy * w + ox] = true;
      var edge = { from: oy * w + ox, to: ly * w + lx, name: name, kind: kind,
                   x: lx, y: ly, evId: evId };
      built.edges.push(edge);
      (built.from[edge.from] || (built.from[edge.from] = [])).push(edge);
      // A portal claim outranks a jump claim for naming: it is the more specific thing.
      if (kind === 'portal' || !built.byEvent[evId]) built.byEvent[evId] = kind;
    }

    try {
      var evs = $gameMap.events();
      built.seen = evs.length;
      for (var i = 0; i < evs.length; i++) {
        var ev = evs[i];
        if (!ev || ev._erased) continue;
        var page = null;
        try { page = ev.page(); } catch (e) { page = null; }
        if (!page || page.trigger > 2) continue;       // an automatic event is never a player action
        built.paged++;
        var list = page.list || [];
        var label = realName((ev.event && ev.event() && ev.event().name) || '');
        var evId = 0;
        try { evId = ev.eventId(); } catch (e2) { evId = 0; }
        // Kept so a route can be spoken by the name the scan gave the thing that owns it —
        // "use Crossing 7 to cross" rather than a bare direction the player cannot act on.
        built.eventTile[evId] = [ev.x, ev.y];

        // Where the player must be standing for this event to fire.
        //   action button  — beside it, facing it
        //   touch          — on it
        var touch = (page.trigger === 1 || page.trigger === 2);
        if (touch && page.priorityType === 0 && this._infinitariumPassage(list, mapId)) {
          stopAt(ev);
          continue;
        }
        if (cleftMode !== null && touch) {
          var marker = this._cleftMarker(page, mapId);
          if (marker !== null && marker !== cleftMode) stopAt(ev);
        }

        var cleftTransfer = cleftMode !== null && this._cleftTransfer(list, mapId, cleftMode);
        var branches = cleftTransfer ? [{ cmds: [cleftTransfer] }] : this._branches(list);
        for (var b = 0; b < branches.length; b++) {
          var br = branches[b];
          if (!br.cmds.length) continue;
          var shift = this._routeShift(br.cmds);

          // Record what was made of this branch, before acting on it. Only branches that carry a
          // move route aimed at the player are interesting; everything else is ordinary event
          // script and there are thousands of those.
          var hasPlayerRoute = false;
          for (var pr = 0; pr < br.cmds.length; pr++) {
            var pc = br.cmds[pr];
            if (pc.code === C.MOVE_ROUTE && pc.parameters &&
                pc.parameters[0] === BRANCH_PLAYER) { hasPlayerRoute = true; break; }
          }
          if (hasPlayerRoute) {
            built.routed++;
            // Whether it became an edge is answered after the whole sweep, from byEvent — the
            // branch below has several early exits and a marker written here would miss them.
            if (built.routes.length < 14) {
              built.routes.push({ evId: evId, text: evId + '@' + ev.x + ',' + ev.y +
                ' trig' + page.trigger + ' face' + (br.facing || '-') +
                ' d' + shift.dx + ',' + shift.dy +
                (shift.through ? ' through' : ' NO-through') +
                (shift.unknowable ? ' unknowable:' + shift.unknowable : '') });
            }
          }

          if (shift.unknowable) {
            // No edge: where this lands cannot be known without running it. Remember the tile
            // regardless of Through, because the risk being warned about — step here and end up
            // somewhere nobody announced — does not depend on how the route crosses the ground.
            built.unknowable++;
            built.hazards.push({ x: ev.x, y: ev.y, name: label, why: shift.unknowable,
                                 evId: evId });
            // Only a route that can actually carry the player off walkable ground earns a place
            // in the crossings list, on the same reasoning — and with the same two ways of doing
            // it — as the edge test below.
            if (shift.through || shift.jumpOnly) built.hazardEvents[evId] = shift.unknowable;
            continue;
          }

          // Through is what makes a WALKED route a crossing rather than a nudge. Without it the
          // steps can only put the player where they could already have walked, so they add no
          // reach — and every cutscene that shoves the player a step would otherwise be filed as
          // a way across the map. On Conall Curach that is the difference between the 16 real
          // marsh stones and EV008, a story trigger the scan names after whoever speaks in it.
          //
          // A jump is not walked, so Through has nothing to say about it: the engine moves the
          // player by arithmetic and consults no passability at all (see _routeShift). Requiring
          // it anyway lost 25 events on six maps, every one of them a launcher the player is
          // thrown by rather than a step they are nudged along:
          //
          //   Everlasting Tangle (556)  8, each flinging the party 7 or 8 tiles through the
          //                             undergrowth in a fixed direction — and 6 of the map's
          //                             chests sit where only they reach.
          //   Temple of Visions (229)   6.   Maps (579) 4.   Thunder Mountain (97) 3.
          //   Inner Lake Map (496) 2.        Elemental Abyss (580) 2.
          //
          // All 25 are invisible touch tiles. Walking onto one is not a choice a player makes,
          // which is why the edge is added `forced` below: the tile is not ground to be crossed,
          // it is the launcher, and a route that meant to walk over it would be wrong about where
          // the player ends up.
          if ((shift.through || shift.jumpOnly) && (shift.dx || shift.dy)) {
            if (touch) {
              addEdge(ev.x, ev.y, ev.x + shift.dx, ev.y + shift.dy, label, 'jump', evId, true);
            } else if (br.facing && DIR_DELTA[br.facing]) {
              // Facing d means the player stands on the opposite side of the event.
              var d = DIR_DELTA[br.facing];
              var ox = ev.x - d[0], oy = ev.y - d[1];
              addEdge(ox, oy, ox + shift.dx, oy + shift.dy, label, 'jump', evId);
            } else {
              // No facing test: it fires from whichever side the player approached from.
              for (var k = 0; k < DIRS.length; k++) {
                var sx = ev.x + DIRS[k].dx, sy = ev.y + DIRS[k].dy;
                addEdge(sx, sy, sx + shift.dx, sy + shift.dy, label, 'jump', evId);
              }
            }
          }

          // Transfers that land on this same map are a way across it, not a way out of it.
          for (var c2 = 0; c2 < br.cmds.length; c2++) {
            var cmd = br.cmds[c2];
            if (cmd.code !== C.TRANSFER || !cmd.parameters) continue;
            if (cmd.parameters[0] !== 0) continue;     // variable-designated: not knowable here
            if (cmd.parameters[1] !== mapId) {
              // An unconditional touch exit can be a destination, but cannot be used as
              // a corridor. Normal-priority events use the separate collision trigger.
              if (touch && page.priorityType !== 1 && cmd.indent === 0) stopAt(ev);
              continue;
            }
            var tx = cmd.parameters[2], ty = cmd.parameters[3];
            if (touch) addEdge(ev.x, ev.y, tx, ty, label, 'portal', evId, true);
            else for (var k2 = 0; k2 < DIRS.length; k2++) {
              addEdge(ev.x + DIRS[k2].dx, ev.y + DIRS[k2].dy, tx, ty, label, 'portal', evId);
            }
          }
        }
      }
    } catch (e) {
      BMA.Log.write('warps threw: ' + (e && e.message));
    }

    for (var ri = 0; ri < built.routes.length; ri++) {
      var rr = built.routes[ri];
      built.routes[ri] = rr.text + ' => ' + (built.byEvent[rr.evId] || 'NO EDGE');
    }

    this._warps = built;
    return built;
  },

  //---------------------------------------------------------------------------
  // Gates — the blockers that are not permanent.
  //
  // 652 events across 127 maps are a wall on page 0 and open ground on a later page held behind
  // a switch: Naddaha Pyramid's sealed passages, Esto Yensa's 65, Adder's Room's 46. They carry
  // no commands, so classify() files them as nothing, and _nameAt falls through to the editor's
  // "EV029" and gives up — which is why a blocked route in the pyramid says "Something is in the
  // way". That is a dead end: the thing that opens it is somewhere else entirely, and sweeping a
  // 150x150 map for it is not something a player can do.
  //
  // The map's own wiring answers it. A gate names the switch that frees it, and the events that
  // turn that switch on are the things to go and act on — in the pyramid, the sarcophagi.
  //---------------------------------------------------------------------------
  _gates: null,

  _pageBlocks: function (page) {
    var img = (page && page.image) || {};
    var hasGfx = (img.characterName && img.characterName !== '') || img.tileId > 0;
    return hasGfx && page.priorityType === 1 && !page.through;
  },

  //---------------------------------------------------------------------------
  // Spans — the same trick upside down.
  //
  // A gate is an event that IS a wall until a switch removes it. A span is an event that is not
  // there at all until a switch puts it down, and what it puts down is floor: MV consults tile
  // events ahead of the map's own layers in checkPassage, so a passable tile laid on top of stone
  // makes the stone walkable. That is how this game builds every drawbridge it has.
  //
  // Nothing in the mod could see one. A span that is out is not an event — its page conditions are
  // unmet, so it has no active page, no priority and no graphic — it is a plain impassable map
  // tile. blockerOnPath and blockerToward both look for an event standing in the way and find
  // nothing, so a destination across a missing bridge answered "Beyond the area you can reach"
  // with no obstruction named and nothing to go and do about it.
  //
  // 27 tiles across 5 maps, and on two of them they are the dungeon:
  //
  //   Etherdepths (473)     4 tiles, 3 switches, worked by the three levers below. The pocket at
  //                         (50..52,35) is a vestibule walled all round but for (51,36) on its
  //                         south side and (51,34) on its north, so BOTH of Lever 1 and Lever 2
  //                         have to be thrown before anyone can climb out of the y37 corridor —
  //                         and they stand 31 tiles apart. Lever 3, at (23,16), is only reachable
  //                         through that vestibule, and the 2-wide gap it opens at (42..43,33) is
  //                         what finally opens the way to Chiron and the prisoners.
  //   Elemental Abyss (580) 12 tiles, 4 switches, 4 levers. The game names those switches
  //                         "Bridge 1".."Bridge 4" itself, which is where the word comes from.
  //   Naddaha Pyramid (92)  8, each laid by the sarcophagus that stands on it.
  //   Water Shrine Barrier (408), Lindblum Castle Inn (225): 3 more, cutscene scenery.
  //
  // Every one of them toggles. A player who pulls a lever a second time takes the bridge back out
  // with no way to tell, which is the failure that matters most here: the map silently returns to
  // the state they had just spent ten minutes leaving.
  //---------------------------------------------------------------------------

  // Does this tile, laid on its own, let the player stand on it? The engine's own rules from
  // checkPassage, asked about a single tile instead of a stack: [*] has no opinion, all four
  // passage bits clear is passable from every side, all four set is impassable from every side.
  // A one-way ledge answers null — it is not floor, and it is not a wall either.
  // `flags` is for the one caller that has to ask about a tileset the map is not wearing —
  // announceTilesetChange, working out what a swap did — and defaults to the live table so every
  // other caller reads the map as it stands.
  _tilePasses: function (tileId, flags) {
    try {
      var f = (flags || $gameMap.tilesetFlags())[tileId];
      if (f === undefined || (f & 0x10)) return null;
      if ((f & 0x0f) === 0) return true;
      if ((f & 0x0f) === 0x0f) return false;
      return null;
    } catch (e) { return null; }
  },

  // What the MAP alone says about a tile, with every tile event discounted. checkPassage cannot
  // answer this: it consults the tile events first, which is exactly the term being isolated here.
  _groundPasses: function (x, y) {
    try {
      // layeredTiles is z=3 down to z=0 and nothing else, but ask the engine for it where it
      // exists: a plugin that changes what a layer means changes it there.
      var tiles = $gameMap.layeredTiles ? $gameMap.layeredTiles(x, y)
                : [$gameMap.tileId(x, y, 3), $gameMap.tileId(x, y, 2),
                   $gameMap.tileId(x, y, 1), $gameMap.tileId(x, y, 0)];
      for (var i = 0; i < tiles.length; i++) {
        var v = this._tilePasses(tiles[i]);
        if (v !== null) return v;
      }
    } catch (e) {}
    return false;
  },

  // Is the bridge down right now? Read off the event's live tile id rather than its page index,
  // because a span event may carry other pages: what matters is whether the tile it is drawing
  // this instant is one you can walk on. No active page leaves _tileId at 0, which passes nothing.
  _spanIn: function (rec) {
    try { return this._tilePasses(rec.ev.tileId()) === true; } catch (e) { return false; }
  },

  // The span at this tile, and only while it is missing. Same record shape as a gate — an
  // opensWith and a list of openers — so _gateHint reads it without knowing the difference.
  spanAt: function (x, y) {
    try {
      var rec = this.gates().spans[x + ',' + y];
      return rec && !this._spanIn(rec) ? rec : null;
    } catch (e) { return null; }
  },

  // Which bridges are down, snapshotted either side of a page refresh. Null on a map with no
  // bridges on it — 640 of the 645 — so the hook that calls this twice a refresh does no work
  // anywhere the mechanism does not exist.
  spanState: function () {
    try {
      var spans = this.gates().spans, at = null, k;
      for (k in spans) (at || (at = {}))[k] = this._spanIn(spans[k]);
      return at ? { mapId: $gameMap.mapId(), at: at } : null;
    } catch (e) { return null; }
  },

  // Say what the lever did.
  //
  // This is the whole of the report. Pulling one of Etherdepths' three levers plays a short sound
  // and changes a single floor tile somewhere between 9 and 31 steps away, off screen; nothing
  // else happens, and nothing on screen or in the mod said which tile, in which direction, or
  // whether it had just been put down or taken back up. A sighted player watches the bridge slide
  // into place. There was no equivalent of that, so the three levers were three objects that
  // beeped.
  //
  // Both directions matter, and the closing one arguably more: every one of these levers toggles.
  // Pulling one twice puts the map back exactly as it was, and in Etherdepths that undoes the
  // vestibule at (50..52,35) — which needs Lever 1 AND Lever 2 thrown together, from 31 tiles
  // apart — with nothing but a second identical beep to show for it.
  announceSpanChange: function (before) {
    try {
      if (!before || !$gameMap || before.mapId !== $gameMap.mapId()) return;
      if (!(SceneManager._scene instanceof Scene_Map)) return;
      var after = this.spanState();
      if (!after) return;
      var spans = this.gates().spans, groups = {}, k, rec, d, g;
      for (k in after.at) {
        if (before.at[k] === undefined || before.at[k] === after.at[k]) continue;
        rec = spans[k];
        d = this.spanDist($gamePlayer.x, $gamePlayer.y, rec.ev.x, rec.ev.y);
        // One switch is one bridge however many tiles wide it is. Lever 3 lays two side by side
        // and Elemental Abyss' fourth lays five, and saying it five times is four answers too many.
        g = groups[rec.opensWith];
        if (!g || d < g.d) {
          groups[rec.opensWith] = { open: after.at[k], x: rec.ev.x, y: rec.ev.y, d: d };
        }
      }
      var out = [];
      for (k in groups) out.push(groups[k]);
      if (!out.length) return;
      out.sort(function (a, b) { return a.d - b.d; });          // nearest first: most likely theirs
      var say = [];
      for (var i = 0; i < out.length; i++) {
        say.push((out[i].open ? 'Bridge open, ' : 'Bridge closed, ') +
                 this._bearing(out[i].x, out[i].y));
      }
      BMA.Speech.speak(say.join('. '), { priority: 'critical' });
      // What can be walked on just changed, and the strict flood is cached on the player's tile —
      // which is exactly what does not change when they stand at a lever and press the button. Same
      // staleness the push blocks have, same fix. Without it, asking for a route straight after
      // pulling a lever answers about the map as it was before the pull.
      this._clearFloods();
    } catch (e) {}
  },

  // Say what a tileset swap did to the ground, and retire what it invalidated.
  //
  // A tileset carries the passability of every tile id in it, so swapping one re-answers "can I
  // stand here" for the whole map at once without a single event moving. Crescent Rivulet (217)
  // is the mechanism: 132 of its tiles change between wall and floor as the player crosses ten
  // invisible tiles along the river, which is how that dungeon raises and lowers its bridges.
  //
  // Counted rather than named, because the tileset's own name ("Cave 2 BRIDGE UP") is the
  // editor's word for the state and not for what changed, and on the Overworld the same mechanism
  // is used for three different bridges and a barrier. What the player needs is the same thing
  // announceSpanChange gives them for a lever: that the map moved, which way, and where the
  // nearest bit of it is.
  //
  // The clearFloods is the half that matters even when nothing is spoken. Passability is read
  // live, but the flood that answers "how do I get there" is computed once and held until
  // something is known to have moved — and a tileset swap moves nothing the scan watches.
  // _groundPasses over the whole map, against a nominated flag table rather than the live one.
  // The per-tile reading has to be _groundPasses' own, layer order and all, or the comparison is
  // between two different ideas of what "walkable" means and the difference it reports is partly
  // its own.
  _tilesetPassMap: function (flags) {
    var w = $gameMap.width(), h = $gameMap.height(), out = {}, x, y, z, v;
    for (y = 0; y < h; y++) for (x = 0; x < w; x++) {
      for (z = 3; z >= 0; z--) {
        v = this._tilePasses($gameMap.tileId(x, y, z), flags);
        if (v !== null) break;
      }
      if (v === true) out[y * w + x] = true;
    }
    return out;
  },

  // Frame the current map finished loading on. A tileset swap in the first moments of a map is
  // the map settling into the state the story left it in, not something the player just did — and
  // saying "a way has opened" as somebody walks through a door is both wrong and startling.
  //
  // Both Overworlds do exactly that, and they do it forever: EV161 is a parallel event whose whole
  // body is Loop / Change Tileset / Wait 999 / Repeat, so the correct tileset for the current
  // chapter is re-applied every sixteen seconds. The re-applications are already silent because
  // the id has not changed, but the FIRST one has — the map file is saved with tileset 1 and the
  // parallel immediately makes it 24, 25 or 52 — and that one lands the instant the player arrives.
  _mapLoadedFrame: -1,
  _SETTLE_FRAMES: 60,

  announceTilesetChange: function (wasId) {
    try {
      this._clearFloods();
      if (!(SceneManager._scene instanceof Scene_Map)) return;
      if (window.Graphics && Graphics.frameCount - this._mapLoadedFrame < this._SETTLE_FRAMES) return;
      var old = $dataTilesets && $dataTilesets[wasId] && $dataTilesets[wasId].flags;
      if (!old) return;
      var before = this._tilesetPassMap(old);
      var after = this._tilesetPassMap($gameMap.tilesetFlags());
      var w = $gameMap.width(), opened = 0, closed = 0, best = null, bestD = Infinity, k;
      var keys = {};
      for (k in before) keys[k] = 1;
      for (k in after) keys[k] = 1;
      for (k in keys) {
        var was = !!before[k], now = !!after[k];
        if (was === now) continue;
        if (now) opened++; else closed++;
        var i = Number(k), x = i % w, y = (i - x) / w;
        var d = this.spanDist($gamePlayer.x, $gamePlayer.y, x, y);
        if (d < bestD) { bestD = d; best = { x: x, y: y, open: now }; }
      }
      if (!best) return;
      // One sentence about the nearest change, and the count only when the swap did both — which
      // no tileset in this game does, but a content patch could.
      var say = (best.open ? 'A way has opened, ' : 'A way has closed, ') +
                this._bearing(best.x, best.y) + '.';
      if (opened && closed) say += ' ' + opened + ' opened, ' + closed + ' closed.';
      BMA.Speech.speak(say, { priority: 'critical' });
    } catch (e) { BMA.Log.write('announceTilesetChange threw: ' + (e && e.message)); }
  },

  gates: function () {
    var mapId = $gameMap.mapId();
    if (this._gates && this._gates.key === mapId) return this._gates;
    var built = { key: mapId, byTile: {}, spans: {} };
    try {
      var evs = $gameMap.events(), i, j, p, ev, pages, list, c;

      // Which events turn each switch on. Off (parameters[2] === 1) is not an opening.
      //
      // `thrown` records whether a PLAYER ever throws it — the setting page is an action button or
      // a touch rather than an autorun or a parallel. Only the spans below read it, and there it is
      // the whole difference between a mechanism and a special effect: Water Shrine Barrier lays
      // its floor tiles off "Animation1"/"Animation2", which a parallel event flips back and forth
      // every 15 frames forever, and Lindblum Castle Inn's is a cutscene blinking Vahn's eyes.
      // Both are passable tiles over impassable ground and neither is a bridge; announcing them
      // would talk over the game four times a second.
      var setters = {}, thrown = {};
      for (i = 0; i < evs.length; i++) {
        ev = evs[i];
        if (!ev) continue;
        pages = (ev.event() && ev.event().pages) || [];
        for (p = 0; p < pages.length; p++) {
          list = pages[p].list || [];
          var byHand = pages[p].trigger === 0 || pages[p].trigger === 1 || pages[p].trigger === 2;
          for (j = 0; j < list.length; j++) {
            c = list[j];
            if (c.code !== C.SWITCH || !c.parameters || c.parameters[2] !== 0) continue;
            for (var s = c.parameters[0]; s <= c.parameters[1]; s++) {
              (setters[s] || (setters[s] = [])).push(ev);
              if (byHand) thrown[s] = true;
            }
          }
        }
      }

      for (i = 0; i < evs.length; i++) {
        ev = evs[i];
        if (!ev || ev._erased) continue;
        var page = null;
        try { page = ev.page(); } catch (e) { page = null; }
        if (!page || !this._pageBlocks(page)) continue;        // not a wall as things stand
        // A wall you can interact with is a thing in its own right — a sarcophagus, a statue —
        // and classify() has already named it. Only inert blockers are gates.
        var meaningful = 0;
        list = page.list || [];
        for (j = 0; j < list.length; j++) {
          var code = list[j].code;
          if (code !== 0 && code !== 108 && code !== 408) meaningful++;
        }
        if (meaningful) continue;

        pages = (ev.event() && ev.event().pages) || [];
        var opensWith = 0;
        for (p = 0; p < pages.length; p++) {
          var cond = pages[p].conditions || {};
          if (!cond.switch1Valid) continue;
          if (this._pageBlocks(pages[p])) continue;            // still a wall on that page too
          opensWith = cond.switch1Id;
          break;
        }
        if (!opensWith) continue;                              // solid for good: not a gate

        var openers = [];
        var src = setters[opensWith] || [];
        for (j = 0; j < src.length; j++) {
          if (src[j] === ev) continue;                         // a gate that spends its own switch
          openers.push(src[j]);
        }
        built.byTile[ev.x + ',' + ev.y] = { ev: ev, opensWith: opensWith, openers: openers };
      }

      // Spans, off the same setters table. Static map data on purpose — which tiles CAN be
      // bridged never changes, and whether one is bridged right now is asked at spanAt().
      for (i = 0; i < evs.length; i++) {
        ev = evs[i];
        if (!ev || ev._erased) continue;
        if (this._groundPasses(ev.x, ev.y)) continue;      // walkable anyway: nothing to lay
        pages = (ev.event() && ev.event().pages) || [];
        for (p = 0; p < pages.length; p++) {
          var sp = pages[p], img = sp.image || {}, scond = sp.conditions || {};
          if (!scond.switch1Valid) continue;               // never absent: not a bridge
          if (!thrown[scond.switch1Id]) continue;          // the game animating itself — see above
          // Below characters, no sprite, a tile: MV's own definition of a tile event
          // (Game_Event.isTile), which is what puts its tile ahead of the map's in checkPassage.
          if (sp.priorityType !== 0 || img.characterName || !(img.tileId > 0)) continue;
          if (this._tilePasses(img.tileId) !== true) continue;
          var busy = 0;
          list = sp.list || [];
          for (j = 0; j < list.length; j++) {
            var sc = list[j].code;
            if (sc !== 0 && sc !== 108 && sc !== 408) busy++;
          }
          if (busy) continue;                              // it does something: it is not floor
          var lays = [];
          var from = setters[scond.switch1Id] || [];
          for (j = 0; j < from.length; j++) if (from[j] !== ev) lays.push(from[j]);
          built.spans[ev.x + ',' + ev.y] =
            { ev: ev, opensWith: scond.switch1Id, openers: lays, span: true };
          break;
        }
      }
    } catch (e) {
      BMA.Log.write('gates threw: ' + (e && e.message));
    }
    this._gates = built;
    return built;
  },

  gateAt: function (x, y) {
    try { return this.gates().byTile[x + ',' + y] || null; } catch (e) { return null; }
  },

  // "It opens from the Sarcophagus 4, 30 steps north." Nearest opener, because that is the one
  // worth walking to; silent when the switch is thrown from another map entirely, which is a
  // real case (a story flag) and one where naming a tile would be a lie.
  //
  // Nearest one you can actually WALK to, though, and that is not a refinement — on Esto Yensa it
  // is the difference between a hint and a wild goose chase. Every one of that dungeon's twelve
  // spike walls is opened by a pad on the far side of the map, in the half only the OTHER party
  // can reach, so the bare hint sent a player eighty-four steps east to a tile there is no route
  // to. A reachable opener therefore outranks a nearer one however much further off it is, and
  // when none of them is reachable the hint says so rather than pretending.
  //
  // Strict reach, not relaxed: the question is whether they can stand on it now, and relaxed
  // discounts exactly the blockers this is about. On a map that hands out two parties the answer
  // to "no route" is not "give up" but "do it with the other one", which is the whole puzzle and
  // the one thing about it nothing on screen says out loud.
  //
  // A push block is the one obstruction a player can clear on their own, and nothing on screen
  // says so — it is a rock sitting in a corridor, and the action button is not something anybody
  // tries on a wall. Which way it goes is which way they face, so this one sentence covers every
  // side it can be worked from and needs no directions of its own.
  PUSH_HINT: ' Face it and press the action button to push it.',

  // Which of those sides is open, though, is the half a sighted player gets for free and a blind
  // one cannot get at all. A block in a one-tile corridor has two open sides out of four; shove it
  // at either of the other two and the sound still plays, the block still does not move, and
  // nothing whatever tells those two apart. Working that out by pressing costs a press per side
  // per block, and Eagle's Cradle is eighteen blocks in four cramped rooms.
  //
  // Open means both halves of the shove: the block can enter the tile beyond, AND the tile behind
  // is somewhere the player can be standing. Both halves move as the puzzle is played — shove one
  // block into the tile another was pushed from and that second block is boxed in, which is how a
  // room gets shut and the whole reason this is read off the live map rather than the map file.
  //
  // Tile flags plus who is standing there for the player's side, rather than a route to it: the
  // block is itself standing on the tile any route would have to come through, so canPass from
  // behind it is false by definition. The question is whether that side is floor and free, not how
  // to walk round to it.
  //
  // canPass for the block's own side, so YEP_RegionRestrictions and every other alias in this
  // game's 78 plugins gets its say — the same reason flood() goes through it.
  _pushOpenDirs: function (rec) {
    var open = [];
    try {
      var ev = rec.ev, x = ev.x, y = ev.y;
      for (var i = 0; i < DIRS.length; i++) {
        var d = DIRS[i];
        var sx = x - d.dx, sy = y - d.dy;          // where the player has to stand to shove it
        if (!$gameMap.isValid(sx, sy)) continue;
        if (!ev.canPass(x, y, d.d)) continue;      // where it would land, events included
        // 10 - d is the way back (2<->8, 4<->6): leaving the standing tile towards the block, and
        // entering the block's tile from that side.
        if (!$gameMap.isPassable(sx, sy, d.d)) continue;
        if (!$gameMap.isPassable(x, y, 10 - d.d)) continue;
        if ($gamePlayer.isCollidedWithCharacters(sx, sy)) continue;
        open.push(d.name);
      }
    } catch (e) { return []; }
    return open;
  },

  // "north, south or east" — the last one joined with "or", so a two-way corridor reads as the
  // choice it is rather than as a list.
  _orList: function (words) {
    if (words.length < 2) return words[0] || '';
    return words.slice(0, -1).join(', ') + ' or ' + words[words.length - 1];
  },

  _pushHint: function (x, y) {
    for (var i = 0; i < this.entities.length; i++) {
      var e = this.entities[i];
      if (!e.push || e.x !== x || e.y !== y) continue;
      var open = this._pushOpenDirs(e);
      // Four open sides is a block standing in the open, where saying so adds a clause and no
      // information. Nowhere to go is worth saying outright: it is the one case where pressing
      // the action button at it is a waste of time whichever side you try.
      if (!open.length) return this.PUSH_HINT + ' It has nowhere left to go.';
      if (open.length >= 4) return this.PUSH_HINT;
      return this.PUSH_HINT + ' It will only move ' + this._orList(open) + '.';
    }
    return '';
  },

  // Where the blocks can be put back, and WHICH blocks each tile puts back.
  //
  // Nothing in this game ever reads where a block ENDS UP. No block page carries a switch,
  // self-switch or variable; no common event names one; the only parallel pages on any of the four
  // maps are the lamp-flicker loop that toggles switches 3 and 4 forever; every terrain tag under
  // them is 0, as is every region id on 436 and 475. Mythril Mine's two maps do paint regions 1
  // and 3, and those are YEP_RegionBattlebacks picking a battle background — RegionRestrictions is
  // configured with empty lists and NarcoRegionTrigger only fires on region 100. So there is no
  // target tile to push one onto, and no puzzle state to get permanently wrong: the only thing a
  // push changes is which tile is occupied.
  //
  // What CAN go wrong is geometric, and it is real. The corridors are one tile wide, so a block
  // can be shoved into the mouth it was there to clear. Solved exhaustively over every placement
  // the player can reach in Torian Grotto: entering from the east, 66 of 132 placements have
  // stranded the Tent; entering from the west, 1400 of 2068 strand the Tent and 832 strand both
  // the Guard Shard and the 1000 Gil. In every single one of those the player can still walk to a
  // passage out — and both passages into the puzzle carry a Set Event Location for all five blocks.
  //
  // That reset is the designed way back, and it is exactly the thing a sighted player reads off
  // the room at a glance: the blocks are where they started again. Read from the 203 commands
  // rather than from a map id, so it is the mechanism that is recognised and not one dungeon.
  //
  // The id list is what Eagle's Cradle added, and without it the hint is worse than none. That map
  // has four block rooms and nine reset tiles, and every one of the nine restores only its own
  // room — the tile at (64,54) puts back the six blocks around (35..47,55..59) and the three at
  // (64..67,66..67), and does nothing whatever for the four at (65..72,57..60) sitting six steps
  // from it. Picking the geometrically nearest reset sends the player to a tile that restores a
  // different room for 12 of that map's 18 blocks. Torian Grotto is unaffected: both of its resets
  // list all five, so the nearest is also a right answer.
  _blockResets: null,
  blockResets: function () {
    if (this._blockResets) return this._blockResets;
    var out = [];
    try {
      var mapId = $gameMap.mapId(), evs = $gameMap.events();
      for (var i = 0; i < evs.length; i++) {
        var page = evs[i] && evs[i].page && evs[i].page();
        var ids = this._blockResetIds(page, mapId);
        if (ids) out.push({ ev: evs[i], ids: ids });
      }
    } catch (e) {}
    return (this._blockResets = out);
  },

  // "If one ends up sealing a passage, Block reset 3, 14 steps north, puts them back where they
  // started." Nearest reset that restores THIS block — see above — and, among those, one the
  // player can still walk to, for the same reason _gateHint prefers a reachable opener: a bearing
  // to a tile there is no route to is a wild goose chase, and a block puzzle shoved shut is
  // exactly the situation where routes have stopped existing.
  _resetHint: function (x, y) {
    try {
      var list = this.blockResets();
      if (!list.length) return '';
      var i, want = 0;
      for (i = 0; i < this.entities.length; i++) {
        var e = this.entities[i];
        if (e.push && e.x === x && e.y === y && e.ev) { want = e.ev.eventId(); break; }
      }
      var best = null, bestD = Infinity, bestReach = false;
      for (i = 0; i < list.length; i++) {
        var r = list[i];
        if (want && r.ids.indexOf(want) < 0) continue;
        var d = this.spanDist($gamePlayer.x, $gamePlayer.y, r.ev.x, r.ev.y);
        var reach = this._goalIndex(r.ev.x, r.ev.y, false) !== -1;
        if (!best || (reach && !bestReach) || (reach === bestReach && d < bestD)) {
          bestD = d; best = r.ev; bestReach = reach;
        }
      }
      if (!best) return '';
      return ' If one ends up sealing a passage, ' + this._nameAt(best.x, best.y) + ', ' +
             this._bearing(best.x, best.y) + ', puts them back where they started.';
    } catch (e) { return ''; }
  },

  _gateHint: function (gate) {
    try {
      if (!gate || !gate.openers.length) return '';
      var best = null, bestD = Infinity, bestReach = false, i, o, d, reach;
      for (i = 0; i < gate.openers.length; i++) {
        o = gate.openers[i];
        d = this.spanDist($gamePlayer.x, $gamePlayer.y, o.x, o.y);
        reach = this._goalIndex(o.x, o.y, false) !== -1;
        if ((reach && !bestReach) || (reach === bestReach && d < bestD)) {
          bestD = d; best = o; bestReach = reach;
        }
      }
      if (!best) return '';
      var hint = ' It opens from ' + this._nameAt(best.x, best.y) + ', ' +
                 this._bearing(best.x, best.y) + '.';
      if (!bestReach) {
        hint += this.hasPartySwap() ? ' Your other party has to reach it.'
                                    : ' There is no route to it from here.';
      }
      return hint;
    } catch (e) { return ''; }
  },

  //---------------------------------------------------------------------------
  // Maps that hand you two parties.
  //
  // Esto Yensa splits the party in two and gives you one at a time. Page Up and Page Down swap
  // which half you are steering, and the swap teleports you across a 200x155 map to wherever the
  // other half was left standing. A sighted player sees the sprite change and the screen fade;
  // without that, the entire event is silent — you press a key and you are somewhere else, as
  // somebody else, with no way to tell which.
  //
  // Found from the map rather than from an id: a page that tests a Page Up / Page Down press AND
  // adds or removes party members is a party switcher, and nothing else in this game is. Memoised
  // per map, so the answer costs one sweep on arrival.
  //---------------------------------------------------------------------------
  _BRANCH_BUTTON: 11,                     // Conditional Branch subtype: a button is held
  _SWAP_BUTTONS: { pageup: 1, pagedown: 1 },
  _swapKey: -1,
  _swapPages: null,
  swapPages: function () {
    var id = 0;
    try { id = $gameMap.mapId(); } catch (e) { return []; }
    if (this._swapKey === id) return this._swapPages;
    var found = [];
    try {
      var evs = $gameMap.events();
      for (var i = 0; i < evs.length; i++) {
        var data = evs[i] && evs[i].event && evs[i].event();
        var pages = (data && data.pages) || [];
        for (var p = 0; p < pages.length; p++) {
          var list = pages[p].list || [], button = false;
          for (var j = 0; j < list.length; j++) {
            var c = list[j], q = c.parameters || [];
            if (c.code !== 111 || q[0] !== this._BRANCH_BUTTON) continue;
            if (this._SWAP_BUTTONS[String(q[1]).toLowerCase()]) { button = true; break; }
          }
          if (button && this._changesParty(list)) found.push(list);
        }
      }
    } catch (e) {}
    this._swapKey = id;
    this._swapPages = found;
    return found;
  },

  hasPartySwap: function () { return this.swapPages().length > 0; },

  // Where the half you are NOT steering is standing.
  //
  // The switcher plants a marker sprite on the tile it just took you off, so the other party is
  // drawn on the map the whole time you are away from them — and with no commands on it, that
  // sprite was scenery to classify() and "Dummy Vahn" to the blocked-route wording. It is the
  // only thing in the dungeon that says where the other half is, and at the end the two have to
  // meet, so it is also somewhere you have to walk to.
  //
  // Read off the switcher's own script rather than off the editor's name for it. Each branch
  // saves the player's coordinates, removes that party's actors, and then places its marker at
  // the coordinates it just saved — so the Change Party Member REMOVE immediately before a
  // variable-placed Set Event Location says whose marker that is. The other Set Event Location
  // in the same branch parks the marker for the party you are picking up, at literal
  // coordinates, and those are worth keeping: a marker sitting on its park tile is not standing
  // anywhere, which is exactly the state both are in before the first swap.
  //
  // Only the OTHER party's marker is named. Your own is parked, and pointing at it would be a
  // lie about where you are.
  // Only the switcher's own pages are read. Five of the tiles where the two halves finally meet
  // also relocate both markers — to (71,29), a corner of the map nobody ever stands in — and a
  // sweep of every event took those for the park tiles and stopped recognising a parked marker
  // at all.
  _markerKey: -1,
  _markers: null,
  partyMarkers: function () {
    var id = 0;
    try { id = $gameMap.mapId(); } catch (e) { return {}; }
    if (this._markerKey === id) return this._markers;
    var out = {};
    try {
      // Parks are collected apart and merged at the end: within one branch the park comes before
      // the placement that identifies the other marker, so pairing them as they are read would
      // depend on the switcher happening to repeat itself for the second key.
      var pages = this.swapPages(), parks = {}, k;
      for (var p = 0; p < pages.length; p++) {
        var list = pages[p], putDown = 0;
        for (var j = 0; j < list.length; j++) {
          var c = list[j], q = c.parameters || [];
          if (c.code === 129 && q[1] === 1) { putDown = q[0]; continue; }
          if (c.code !== 203 || !(q[0] > 0)) continue;
          if (q[1] === 1) {
            if (putDown) (out[q[0]] || (out[q[0]] = {})).actorId = putDown;
          } else if (q[1] === 0 && parks[q[0]] === undefined) {
            parks[q[0]] = [q[2], q[3]];
          }
        }
      }
      for (k in out) {
        if (parks[k]) { out[k].parkX = parks[k][0]; out[k].parkY = parks[k][1]; }
      }
    } catch (e) {}
    this._markerKey = id;
    this._markers = out;
    return out;
  },

  _partyMarkerName: function (ev, page) {
    try {
      if (!page || !page.image || !page.image.characterName) return '';   // nothing is drawn
      var m = this.partyMarkers()[ev.eventId()];
      if (!m || !m.actorId) return '';
      if (m.parkX === ev.x && m.parkY === ev.y) return '';    // parked: standing in for nobody
      var leader = $gameParty.leader && $gameParty.leader();
      if (leader && leader.actorId && leader.actorId() === m.actorId) return '';
      var actor = $gameActors && $gameActors.actor(m.actorId);
      var name = actor && actor.name ? BMA.Util.cleanText(actor.name()) : '';
      return name ? name + "'s party" : '';
    } catch (e) { return ''; }
  },

  // "Vera's party. Position 125, 152." Spoken when the half you are steering changes, and once on
  // arrival so a player who reloaded into the middle of the dungeon knows which one they have.
  //
  // The keys are named on that first line. The game does say them — an autorun on the way in puts
  // "Switch between Vahn and Vera by pressing Page Up/Down" on screen, and the dialogue layer
  // reads it — but it fires once, ever, behind a switch. Load a save made two rooms later and
  // nothing will ever say it again.
  _lastParty: null,
  announceParty: function () {
    try {
      if (!this.hasPartySwap()) { this._lastParty = null; return; }
      var leader = null;
      if ($gameParty.leader) leader = $gameParty.leader();
      if (!leader && $gameParty.members) leader = $gameParty.members()[0];
      if (!leader) return;
      var id = leader.actorId ? leader.actorId() : 0;
      if (id === this._lastParty) return;
      var first = this._lastParty === null;
      this._lastParty = id;
      var name = BMA.Util.cleanText(leader.name ? leader.name() : '');
      if (!name) return;
      BMA.Speech.speak(name + "'s party. " +
        (first ? 'Page Up or Page Down switches parties.'
               : 'Position ' + $gamePlayer.x + ', ' + $gamePlayer.y + '.'),
        { priority: 'critical' });
    } catch (e) {}
  },

  // What navigational role, if any, this event plays in getting across the map:
  // 'hazard' (it moves the player somewhere that cannot be worked out ahead of time),
  // 'portal' (a transfer landing back on this map), or 'jump' (a route that carries them).
  _warpRoleOf: function (ev) {
    try {
      var id = ev.eventId();
      var wp = this.warps();
      if (wp.hazardEvents[id]) return 'hazard';
      return wp.byEvent[id] || null;
    } catch (e) { return null; }
  },

  // Is this tile a route whose landing spot is unknowable? Used to warn before the player
  // walks onto something that will move them somewhere nobody can predict.
  hazardAt: function (x, y) {
    try {
      var hz = this.warps().hazards;
      for (var i = 0; i < hz.length; i++) if (hz[i].x === x && hz[i].y === y) return hz[i];
    } catch (e) {}
    return null;
  },

  // The first unpredictable mover a route walks over. Directions that quietly route a player
  // across one are worse than no directions: they get moved somewhere nobody announced, having
  // followed the instructions correctly.
  hazardOnPath: function (tiles) {
    try {
      if (!tiles || !this.warps().hazards.length) return null;
      for (var i = 0; i < tiles.length; i++) {
        var h = this.hazardAt(tiles[i][0], tiles[i][1]);
        if (h) return h;
      }
    } catch (e) {}
    return null;
  },

  // The nearest crossing the player can actually get to, named as a lead when a destination
  // has no route at all. "Nothing I can do" is a worse answer than "start from here".
  nearestCrossing: function () {
    try {
      var f = this.flood(true), w = f.w;
      var edges = this.warps().edges, best = null, bestD = Infinity;
      for (var i = 0; i < edges.length; i++) {
        var e = edges[i];
        if (f.dist[e.from] === -1) continue;               // cannot get to it either
        var ox = e.from % w, oy = (e.from - ox) / w;
        var d = this.spanDist($gamePlayer.x, $gamePlayer.y, ox, oy);
        if (d < bestD) { bestD = d; best = { x: ox, y: oy, name: e.name, kind: e.kind }; }
      }
      return best;
    } catch (e) { return null; }
  },

  // "3 steps northwest", for a tile the player is being pointed at.
  _bearing: function (x, y) {
    var s = this.span($gamePlayer.x, $gamePlayer.y, x, y);
    return BMA.Util.pluralSteps(BMA.Util.tileDist(s.dx, s.dy)) + ' ' + BMA.Util.compass(s.dx, s.dy);
  },

  // Tile indices holding a trap that is still armed, or null when the map has none. Read off
  // the scanned entities rather than the event list, so it inherits classify()'s judgement —
  // and so a bank that has just been switched off drops out on the same delta scan that
  // cleared the floods.
  // Memoised beside the floods rather than recomputed per call: pathTiles asks for the safe
  // route on every announce, and _clearFloods already fires on exactly the events that can
  // change the answer — a scan, a page flip, a map change.
  _trapCache: undefined,
  _trapTiles: function () {
    if (this._trapCache !== undefined) return this._trapCache;
    var out = null;
    try {
      var w = $gameMap.width(), list = this.entities;
      for (var i = 0; i < list.length; i++) {
        var e = list[i];
        if (e.category !== 'trap') continue;
        (out || (out = {}))[e.y * w + e.x] = true;
      }
    } catch (err) {}
    return (this._trapCache = out);
  },

  isTrapTile: function (x, y) {
    var t = this._trapTiles();
    return !!(t && t[y * $gameMap.width() + x]);
  },

  //---------------------------------------------------------------------------
  // Walls — the stone a map is built out of, which the engine will happily let you walk on.
  //
  // Every one of this game's 45 tilesets leaves its A4 block on the editor's default
  // passability, and that default is passable. So to the engine the walls are ground. It never
  // shows while playing: a wall reads as a wall, nobody walks into one, and the rooms are sealed
  // — on Life Shrine not one of the twenty walkable rooms so much as touches the surrounding
  // stone, which is why 14,311 of its 16,830 tiles form a single connected mass no one has ever
  // stood in.
  //
  // It shows the instant a warp lands the player beside it. Life Shrine's pads do exactly that:
  // Door 16 drops you in a two-tile nook whose south side is wall, and the route from there to
  // the clock room came out as 210 steps that left the shrine, ran east along the top of a wall
  // for 127 tiles, and crossed a map exit on the way. Every step of it is legal. None of it is a
  // route a player can follow.
  //
  // Stepping onto stone is allowed and walking out of it is not — see flood() for why there is
  // no fallback that crosses it. That is enough for the cases where the game means the player to
  // be on stone: of the 6,390 places its own Transfer commands put them, three are on wall
  // ground, and the flood always expands the tile it starts on.
  //
  // The engine's own classifier decides what a wall is, and it is asked about the tile that
  // decides passability, so stone under a star-flagged overlay is still judged as stone. Tile
  // events are left out: they come and go with pages, and this mask is a property of the map.
  // ~3.7 ms on the largest map in the game, once per visit.
  _wallGroundCache: undefined,
  _wallGround: function () {
    var mapId = $gameMap.mapId(), memo = this._wallGroundCache;
    if (memo && memo.key === mapId) return memo.mask;
    var mask = null;
    try {
      if ($gameMap.tileId && $gameMap.tilesetFlags &&
          typeof Tilemap !== 'undefined' && Tilemap.isWallTile) {
        var w = $gameMap.width(), h = $gameMap.height();
        var flags = $gameMap.tilesetFlags();
        var m = new Uint8Array(w * h), any = false;
        for (var y = 0; y < h; y++) {
          for (var x = 0; x < w; x++) {
            for (var z = 3; z >= 0; z--) {
              var t = $gameMap.tileId(x, y, z);
              if ((flags[t] & 0x10) !== 0) continue;   // [*] no effect on passage
              if (Tilemap.isWallTile(t)) { m[y * w + x] = 1; any = true; }
              break;                                   // this layer decides; stop looking down
            }
          }
        }
        mask = any ? m : null;
      }
    } catch (e) { mask = null; }
    this._wallGroundCache = { key: mapId, mask: mask };
    return mask;
  },

  flood: function (relaxed, avoid) {
    // Two masks, and they are not the same kind of thing.
    //
    // Stone is terrain. It belongs to the strict model of the map, not to a preference the
    // routing can trade away, so there is no fallback that walks over it — measured across the
    // 335 maps that have walkable stone and a known arrival tile, every route it takes away is
    // one made almost entirely of stone: 117 of Aether Mine's 122 tiles to Door 1, 20 of the 24
    // that map 543 used to get round the boulder standing in its corridor, 20,089 tiles of
    // Naddaha Pyramid reached without opening one sealed passage. Losing those is the point.
    //
    // A trap is a preference: a few extra steps to walk round one is worth it, but walking over
    // one is better than refusing to answer, so it stays in the 'safe' slot with the fallback.
    //
    // Stone is entered but never crossed. Aether Mine's portals stand on it and so does the chest
    // beside them; refusing to step on stone at all would lose real destinations, while stepping
    // through it is what produced the 127-tile wall walk out of Life Shrine.
    var stone = relaxed ? null : this._wallGround();
    var traps = avoid && !relaxed ? this._trapTiles() : null;
    // No traps: fall back to the strict flood rather than computing and caching a second
    // identical one. This is the case on all but three maps in the game.
    if (!traps) avoid = false;
    var slot = avoid ? 'safe' : (relaxed ? 'relaxed' : 'strict');
    var key = $gameMap.mapId() + ',' + $gamePlayer.x + ',' + $gamePlayer.y;
    // The two plugins change available player inputs without changing tile passability.
    var mode = this.movementMode();
    var walkDirs = mode ? WALK_DIRECTIONS[mode.key] : DIRS;
    if (mode) key += ',' + mode.key;
    var cached = this._floods[slot];
    if (cached && cached.key === key) return cached;
    var self = this;
    var w = $gameMap.width(), h = $gameMap.height();
    var loop = this._loops();
    var built = null;
    // Built outside _withEventIndex: reading pages has nothing to do with the tile lookups
    // that patch swaps out, and doing it here keeps the swap window as small as it was.
    var warp = null;
    try { warp = this.warps(); } catch (e) { warp = null; }
    var stopTiles = warp && warp.stops;
    try {
      BMA.Perf.time(avoid ? 'flood safe' : (relaxed ? 'flood relaxed' : 'flood'), function () {
        self._withEventIndex(w, function () {
          var dist = new Int32Array(w * h).fill(-1);
          var prev = new Int32Array(w * h).fill(-1);
          var via = new Array(w * h);                 // edge taken to reach a tile, if any
          var queue = new Int32Array(w * h);
          var qi = 0, qn = 0;
          var start = $gamePlayer.y * w + $gamePlayer.x;
          dist[start] = 0;
          queue[qn++] = start;
          while (qi < qn) {
            var cur = queue[qi++];
            var cx = cur % w, cy = (cur - cx) / w;
            // Stepping onto a touch-triggered warp IS taking it: the engine moves the player the
            // instant they arrive, so the tile is not ground they can cross. Its warp edge below
            // is the only way on.
            //
            // Aether Mine is what this costs when it is missed. Its two portals face each other
            // — (90,7) lands you at (140,82), and (140,83) one step south sends you straight back
            // — so a route that walked south off the landing tile read "take door 1, south 24",
            // warped the player home on the first of those 24 steps, and then said the same thing
            // again. A loop the player cannot get out of by following instructions correctly.
            //
            // Being PUT on one is the other case, and it is not the same. A touch trigger fires
            // from updateNonmoving only when wasMoving — the player finished a walking step onto
            // it — and performTransfer locates them without moving, so the pad they land on stays
            // silent until they step off and back on. Life Shrine is built entirely out of pads
            // that land on other pads: treating a landing tile as a dead end left 198 of its
            // 16,830 tiles reachable and answered "no path found" for all but five of the 78
            // things on the map.
            //
            // Stone is the other tile you can be on and not walk out of, for a different reason:
            // there is somewhere to stand on it but nowhere to go from it. Same shape, so it is
            // asked here rather than at the neighbour test below.
            var arrivedByWalking = cur !== start && !via[cur];
            var stopped = arrivedByWalking && stopTiles && stopTiles[cur];
            var walkable = !stopped && (!(warp && warp.forced[cur]) || !arrivedByWalking) &&
                           (!stone || !stone[cur] || cur === start);
            for (var i = 0; walkable && i < walkDirs.length; i++) {
              var d = walkDirs[i];
              var nx = cx + d.dx, ny = cy + d.dy;
              // Off the edge, or round it. These offsets are only ever 0 or ±1, so the wrap is
              // the opposite edge and needs no modulo — this runs ~230k times on an Overworld.
              if (nx < 0) { if (!loop.h) continue; nx = w - 1; }
              else if (nx >= w) { if (!loop.h) continue; nx = 0; }
              if (ny < 0) { if (!loop.v) continue; ny = h - 1; }
              else if (ny >= h) { if (!loop.v) continue; ny = 0; }
              var ni = ny * w + nx;
              if (dist[ni] !== -1) continue;
              if (traps && traps[ni]) continue;      // the safe flood: walk round it, not over it
              if (!$gamePlayer.canPass(cx, cy, d.d)) continue;
              dist[ni] = dist[cur] + 1;
              prev[ni] = cur;
              queue[qn++] = ni;
            }
            // Then the ways across that are not walking. Same cost as a step, so a route that
            // walks around beats one that warps only when walking is genuinely shorter.
            var out = !stopped && warp && warp.from[cur];
            if (out) {
              for (var k = 0; k < out.length; k++) {
                var to = out[k].to;
                if (dist[to] !== -1) continue;
                if (traps && traps[to]) continue;    // nor be dropped onto one by a crossing
                dist[to] = dist[cur] + 1;
                prev[to] = cur;
                via[to] = out[k];
                queue[qn++] = to;
              }
            }
          }
          built = { key: key, w: w, h: h, dist: dist, prev: prev, via: via };
        }, relaxed);
      });
    } catch (e) {
      // 78 plugins alias canPass/isMapPassable here. If one throws, the old code left the
      // PREVIOUS position's flood in the cache and went on answering questions about where the
      // player used to be standing. Fail closed and say so in the log instead.
      BMA.Log.write('flood threw (' + slot + '): ' + (e && e.message));
    }
    if (!built) {
      built = { key: key, w: w, h: h, failed: true, via: new Array(w * h),
                dist: new Int32Array(w * h).fill(-1), prev: new Int32Array(w * h).fill(-1) };
    }
    this._floods[slot] = built;
    return built;
  },

  // Best reachable target index for a tile: the tile itself, else the best reachable neighbour.
  //
  // "Best" is NOT "nearest". Only an ORTHOGONAL neighbour can actually work the thing being
  // approached: checkEventTriggerThere reads the one tile the player is facing, and facing is
  // 4-directional, so from a diagonal there is no direction that points at the target. Ranking all
  // eight by distance and taking the minimum therefore parked the player one tile off to the side
  // whenever a diagonal happened to be closer — the route completed, the mod said the chest was
  // beside them, and the action button did nothing. That is the whole of the "unopenable chest"
  // report, and it needs no switch, no quest flag and no blocker to reproduce.
  //
  // Mount Ozma (map 419) is the clean example. Its Turbo Ether and Remedy chests sit side by side
  // at (50,40) and (49,40) over a corridor entered from the west along row 41, so approaching the
  // Remedy chest ranked (48,41) at 4 steps, (49,41) at 5 and (50,41) at 6 — and the winner, (48,41),
  // is diagonal. Both chests in that alcove were unopenable, not just the one reported.
  //
  // So: orthogonal first, then across a counter, and a diagonal only as a last resort. The diagonal
  // is still worth returning — it is the closest the player can physically get, it keeps the
  // entity listed rather than silently dropped by reachable(), and where it genuinely is the only
  // approach nothing better exists. It is just never preferred over a tile that can be acted from.
  _goalIndex: function (tx, ty, relaxed, avoid) {
    var f = this.flood(relaxed, avoid), w = f.w, h = f.h;
    var loop = this._loops();
    if (tx >= 0 && ty >= 0 && tx < w && ty < h && f.dist[ty * w + tx] !== -1) return ty * w + tx;
    var best = -1, bestD = Infinity, diag = -1, diagD = Infinity, nx, ny, ni, d;
    for (var i = 0; i < APPROACH.length; i++) {
      // An entity standing against a looping edge is approached from the far side like any
      // other — on The Moon that is a real approach, not an out-of-bounds neighbour.
      nx = this._wrapX(tx + APPROACH[i].dx, w, loop.h);
      ny = this._wrapY(ty + APPROACH[i].dy, h, loop.v);
      if (nx < 0 || ny < 0) continue;
      ni = ny * w + nx;
      d = f.dist[ni];
      if (d === -1) continue;
      // APPROACH is DIRS (the four the player can face) followed by the four diagonals, so the
      // index is what separates "can act from here" from "can only stand here".
      if (i < DIRS.length) { if (d < bestD) { bestD = d; best = ni; } }
      else if (d < diagD) { diagD = d; diag = ni; }
    }
    if (best !== -1) return best;

    // Across a counter. MV lets you talk *through* a counter tile — checkEventTriggerThere tests
    // isCounter() on the tile you face and, when set, starts the event one tile further on. That
    // is how every shopkeeper behind a service counter is spoken to, and modelling approach as
    // "own tile or a neighbour" reported all 489 of them (across 112 maps) as unreachable.
    // Straight ahead only, exactly as the engine does it — never diagonal. Ranked above the
    // diagonal fallback because it is a real approach: the player can face the counter and act.
    try {
      if ($gameMap.isCounter) {
        for (var k = 0; k < DIRS.length; k++) {
          var cx = this._wrapX(tx + DIRS[k].dx, w, loop.h);
          var cy = this._wrapY(ty + DIRS[k].dy, h, loop.v);
          if (cx < 0 || cy < 0) continue;
          if (!$gameMap.isCounter(cx, cy)) continue;
          nx = this._wrapX(cx + DIRS[k].dx, w, loop.h);
          ny = this._wrapY(cy + DIRS[k].dy, h, loop.v);
          if (nx < 0 || ny < 0) continue;
          ni = ny * w + nx;
          if (f.dist[ni] !== -1 && f.dist[ni] < bestD) { bestD = f.dist[ni]; best = ni; }
        }
      }
    } catch (e) {}
    if (best !== -1) return best;
    return diag;
  },

  // Used by the path filter. Relaxed on purpose: the filter should hide what there is no route
  // to at all, not what merely has someone standing in the way. Fails open — showing a
  // destination that turns out to be blocked beats silently dropping it from the list.
  reachable: function (e) {
    try {
      // A flood that failed knows nothing, and answering "unreachable" from it would empty the
      // list — the very symptom the filter gets blamed for. Show everything instead.
      if (this.flood(true).failed) return true;
      return this._goalIndex(e.x, e.y, true) !== -1;
    } catch (err) { return true; }
  },

  _pathVia: function (tx, ty, relaxed, avoid) {
    try {
      var f = this.flood(relaxed, avoid), w = f.w;
      var goal = this._goalIndex(tx, ty, relaxed, avoid);
      if (goal === -1) return null;
      var tiles = [], cur = goal, guard = f.dist.length + 1;
      while (cur !== -1 && guard-- > 0) {
        var x = cur % w, y = (cur - x) / w;
        // Third slot carries the warp taken to arrive here, so describePath can name it
        // instead of reporting a nine-tile leap as a walk. Callers that only read [0]/[1]
        // are unaffected.
        tiles.unshift(f.via && f.via[cur] ? [x, y, f.via[cur]] : [x, y]);
        cur = f.prev[cur];
      }
      return tiles;
    } catch (e) { return null; }
  },

  // The route to speak. A way round the traps is preferred over a shorter way through them —
  // a few extra steps is a fair price for not taking 400 off the whole party — and the walk
  // through is used only when there is genuinely no way round, where directions() warns.
  // Neither flood walks over stone; that is terrain, not a preference. See flood().
  // Callers asking for the relaxed route are after "is there a route at all", so they skip this.
  pathTiles: function (tx, ty, relaxed) {
    if (!relaxed) {
      var safe = this._pathVia(tx, ty, false, true);
      if (safe) return safe;
    }
    return this._pathVia(tx, ty, relaxed, false);
  },

  // The first armed trap a route walks over, so a player is told before they step on it rather
  // than by the damage. Checked against the tiles actually returned, so it holds whichever
  // flood produced them.
  trapOnPath: function (tiles) {
    try {
      var t = this._trapTiles();
      if (!t || !tiles) return null;
      var w = $gameMap.width();
      for (var i = 0; i < tiles.length; i++) {
        if (!t[tiles[i][1] * w + tiles[i][0]]) continue;
        for (var k = 0; k < this.entities.length; k++) {
          var e = this.entities[k];
          if (e.category === 'trap' && e.x === tiles[i][0] && e.y === tiles[i][1]) return e;
        }
      }
    } catch (e) {}
    return null;
  },

  // How many turns are worth speaking before the rest becomes noise. A route recomputes from
  // wherever the player is standing, so they only ever need the next few; the 80-segment
  // recitals that crossing-aware routes can now produce are unusable as speech.
  PATH_TURNS: 8,

  // What to call the thing a warp edge belongs to. Prefer the name the scan already gave it,
  // so directions and the crossings list agree, and never speak an editor placeholder.
  _edgeName: function (edge) {
    try {
      var t = this.warps().eventTile[edge.evId];
      if (t) {
        var n = this._nameAt(t[0], t[1]);
        // "take Door 19, one way, south 3" reads as three instructions, and the warning is not
        // one anyway: a route has already decided to use the thing. The list is where a player
        // is choosing, and that is where the suffix belongs.
        if (n && n !== 'Something') return n.replace(/, one way$/, '');
      }
    } catch (e) {}
    // Both kinds are movers, so neither is spoken of as a "portal" — the difference between them
    // is the verb describePath picks ("take" vs "use ... to cross"), not a different noun.
    return edge.name || 'the crossing';
  },

  // A diagonal corridor is walked as a staircase, and saying so one step at a time is useless.
  //
  // Movement here is 4-directional (nothing in this game's 77 active plugins changes that), so a
  // corridor running diagonally can only be walked by alternating: east, south, east, south. The
  // run-length description turns each of those single steps into its own segment, and Archareon
  // Prison — whose central platform is a diamond outline, all four sides diagonal — produced 37
  // segments for the walk to its save point. PATH_TURNS then cut that to the first 8 and "then 29
  // more turns", which gets a player a third of the way round the diamond and abandons them.
  // Every route on that map came out that way; it is the reason pathfinding there was unusable.
  //
  // Pairing the steps is exact rather than a smoothing: two perpendicular steps ARE one diagonal
  // move, so k alternating steps are floor(k/2) diagonal moves with, if k is odd, one plain step
  // left over at the end — which keeps the leftover in the right place instead of guessing.
  //
  // Left alone below DIAG_MIN, because an ordinary L-shaped corner is not a staircase and
  // "east 4, south 3" is already the clearest way to say it. Only a genuine zigzag collapses.
  //
  // Which of the two directions to press first is not spoken. The geometry decides it — in a
  // one-tile diagonal corridor only one of the pair is open at a time — and pressing the wrong
  // one first is a wall bump, which already has its own cue, on a route that recomputes from
  // wherever the player is standing.
  DIAG_MIN: 2,                    // diagonal moves before a staircase is described as one

  describePath: function (tiles) {
    if (!tiles || tiles.length < 2) return 'You are here';
    var self = this;
    // One tile along exactly one axis.
    function isStep(s) {
      return !s.edge && (Math.abs(s.dx) + Math.abs(s.dy)) === 1;
    }

    // Unit steps first, with the crossings kept in place as their own entries. Deltas go through
    // spanX/spanY so a step across a looping seam reads as one step, not as one back round the map.
    var steps = [];
    for (var i = 1; i < tiles.length; i++) {
      var edge = tiles[i][2];
      // A warp is an instruction, not a direction: the player has to act on the thing, and
      // the tiles either side of it are not adjacent, so a compass run would be a lie.
      if (edge) { steps.push({ edge: edge }); continue; }
      steps.push({ dx: this.spanX(tiles[i][0] - tiles[i - 1][0]),
                   dy: this.spanY(tiles[i][1] - tiles[i - 1][1]) });
    }

    var segs = [];
    var j = 0;
    while (j < steps.length) {
      var s = steps[j];
      if (s.edge) {
        // "take" a portal — one step and you are through. "use ... to cross" a mover, which is
        // an act you perform on a thing beside you.
        segs.push(s.edge.kind === 'portal'
          ? ('take ' + self._edgeName(s.edge))
          : ('use ' + self._edgeName(s.edge) + ' to cross'));
        j++;
        continue;
      }

      // A staircase: this step and the next are perpendicular single steps, and the pair repeats.
      // Both halves have to be one tile along one axis — that is the only shape the flood can
      // produce, since DIRS is orthogonal, and requiring it keeps the rule from pairing up two
      // steps that were already diagonal and reporting their sum as a straight line.
      var b = steps[j + 1];
      if (b && !b.edge && isStep(s) && isStep(b) && (s.dx === 0) !== (b.dx === 0)) {
        var pairs = 0, k = j;
        while (k + 1 < steps.length) {
          var p = steps[k], q = steps[k + 1];
          if (p.edge || q.edge) break;
          if (p.dx !== s.dx || p.dy !== s.dy) break;
          if (q.dx !== b.dx || q.dy !== b.dy) break;
          pairs++; k += 2;
        }
        if (pairs >= this.DIAG_MIN) {
          segs.push(BMA.Util.compass(s.dx + b.dx, s.dy + b.dy) + ' ' + pairs);
          j = k;
          continue;
        }
      }

      // Otherwise the plain run of identical steps it always was.
      var n = 1;
      while (j + n < steps.length) {
        var t = steps[j + n];
        if (t.edge || t.dx !== s.dx || t.dy !== s.dy) break;
        n++;
      }
      segs.push(BMA.Util.compass(s.dx, s.dy) + ' ' + n);
      j += n;
    }

    if (segs.length <= this.PATH_TURNS) return segs.join(', ');
    var rest = segs.length - this.PATH_TURNS;
    return segs.slice(0, this.PATH_TURNS).join(', ') +
           ', then ' + rest + ' more turn' + (rest === 1 ? '' : 's');
  },

  // The name we already worked out for whatever occupies a tile, so the blocker is announced as
  // "Guard" or "Chest" rather than "Something" wherever the scan managed to identify it.
  // Does this event move under its own steam, and block while it does? MV's moveType: 1 random,
  // 2 approach the player, 3 a custom route. A route of nothing but waits and turns is an idle
  // animation standing still — the Mysidia villagers hop on the spot — so it has to contain a
  // step before it counts. See _nameAt, the only caller.
  _AUTO_STEP: { 1:1, 2:1, 3:1, 4:1, 5:1, 6:1, 7:1, 8:1, 9:1, 10:1, 11:1, 12:1, 13:1, 14:1 },
  _walksAbout: function (ev) {
    try {
      var page = ev && ev.page && ev.page();
      if (!page || page.priorityType !== 1 || page.through) return false;
      var img = page.image || {};
      if (!img.characterName && !(img.tileId > 0)) return false;
      if (page.moveType === 1 || page.moveType === 2) return true;
      if (page.moveType !== 3) return false;
      var route = (page.moveRoute && page.moveRoute.list) || [];
      for (var i = 0; i < route.length; i++) if (this._AUTO_STEP[route[i].code]) return true;
    } catch (e) {}
    return false;
  },

  _nameAt: function (x, y) {
    for (var k = 0; k < this.entities.length; k++) {
      var ent = this.entities[k];
      if (ent.x === x && ent.y === y) return ent.name;
    }
    // The scan only keeps things worth travelling to, so a blocker is very often not in that
    // list — which is how every obstruction in Conall Curach came out as "Something is in the
    // way", and "something" is not a thing a player can look for. Fall back to the editor's
    // own name for whatever is standing there before giving up on naming it.
    var walksAbout = false;
    try {
      var evs = $gameMap.eventsXy(x, y);
      for (var i = 0; i < evs.length; i++) {
        var raw = evs[i] && evs[i].event && evs[i].event();
        var nm = raw && raw.name ? BMA.Util.cleanText(raw.name) : '';
        // Editor placeholders (EV001, EV042) name nothing a player could recognise.
        if (nm && !/^ev\d+$/i.test(nm)) return nm;
        if (this._walksAbout(evs[i])) walksAbout = true;
      }
    } catch (e) {}
    // It has no name anywhere in the data, but it does have one property worth a word: it is
    // going to move. 64 events in the game patrol or wander on an autonomous route, carry a
    // graphic, block the player and run no commands at all, so there is nothing else to say about
    // them — 26 of those are in the caves (Cave to the Underworld's fourteen, Sodden Depths' eight,
    // Map 2's four) and the rest are town animals.
    //
    // The distinction is the whole value of the sentence. "Something is in the way" sends a player
    // hunting for the switch that clears it; there is no switch, and waiting four seconds is the
    // entire answer. Named only here, in the blocker hint — they are obstacles, not destinations,
    // and putting 64 of them in the navigation lists would be noise in every town in the game.
    if (walksAbout) return 'Something moving';
    // A wall that a switch somewhere will lift. Worth saying so: "Sealed passage is in the way"
    // is something a player can act on, and "Something is in the way" is not.
    if (this.gateAt(x, y)) return 'Sealed passage';
    // Nothing is standing here at all — the floor is missing. Named for the absence rather than
    // for the stone, because the stone is not the fact: something puts a bridge across it.
    if (this.spanAt(x, y)) return 'Missing bridge';
    return 'Something';
  },

  // Walk the relaxed route and name the first tile on it the player cannot currently enter.
  // Strictly better than blockerToward's "nearest blocker to the target": this is the next
  // obstacle they will actually meet, which is the one worth acting on.
  blockerOnPath: function (tiles) {
    try {
      var f = this.flood(), w = f.w;
      for (var i = 0; i < tiles.length; i++) {
        var x = tiles[i][0], y = tiles[i][1];
        if (f.dist[y * w + x] !== -1) continue;              // still walkable — not the obstruction
        // A bridge that is out is not standing anywhere: its event has no active page, so the
        // event test below cannot see it and the tile reads as plain stone. Asked first, because
        // it is the one obstruction on the tile that nothing else here can name.
        if (this.spanAt(x, y)) return { name: this._nameAt(x, y), x: x, y: y };
        var evs = $gameMap.eventsXyNt(x, y);
        for (var k = 0; k < evs.length; k++) {
          if (evs[k] && evs[k].isNormalPriority && evs[k].isNormalPriority()) {
            return { name: this._nameAt(x, y), x: x, y: y };
          }
        }
      }
    } catch (e) {}
    return null;
  },

  // What is standing between the player and an unreachable target?
  //
  // "No path found" is a dead end on its own — in Branch Castle the throne room door is
  // blocked by a guard who moves once the story advances, and without naming him there is
  // nothing to act on. Look for the event nearest the target that is unreachable itself but
  // touches ground the player can walk to: that is the thing plugging the gap.
  // Unreachable itself, touching ground the player can walk, nearest to where they are trying to
  // get. Shared by both finders below so "what is plugging the gap" means one thing.
  _frontierBlocker: function (tx, ty, cands) {
    try {
      if (!cands.length) return null;
      var f = this.flood(), w = f.w, h = f.h;
      var loop = this._loops();
      var best = null, bestD = Infinity;
      for (var i = 0; i < cands.length; i++) {
        var cx = cands[i][0], cy = cands[i][1];
        if (cx < 0 || cy < 0 || cx >= w || cy >= h) continue;
        if (f.dist[cy * w + cx] !== -1) continue;              // not blocking anything
        var touchesReachable = false;
        for (var d = 0; d < DIRS.length; d++) {
          var nx = this._wrapX(cx + DIRS[d].dx, w, loop.h);
          var ny = this._wrapY(cy + DIRS[d].dy, h, loop.v);
          if (nx < 0 || ny < 0) continue;
          if (f.dist[ny * w + nx] !== -1) { touchesReachable = true; break; }
        }
        if (!touchesReachable) continue;
        var dist = this.spanDist(tx, ty, cx, cy);
        if (dist < bestD) { bestD = dist; best = [cx, cy]; }
      }
      if (!best) return null;
      return { name: this._nameAt(best[0], best[1]), x: best[0], y: best[1] };
    } catch (e) { return null; }
  },

  // The bridges that are out, as tiles. Empty on 640 of the game's 645 maps, and _frontierBlocker
  // returns on an empty list, so this costs nothing where the mechanism is absent.
  //
  // Only the ones nothing else can see. Naddaha Pyramid lays its eight slabs from the sarcophagus
  // that stands on the tile — page 0 is the coffin, a solid blocker with fourteen commands on it,
  // and page 1 is the slab it slides aside to reveal. That coffin is an event standing in a
  // corridor: classify names it, blockerOnPath finds it, and the relaxed route round it is a real
  // route round a real thing. Claiming it here would rename it "Missing bridge", rank it ahead of
  // the finder that had it right, and throw away the route as fictional when it is not.
  _spanTiles: function () {
    var out = [];
    try {
      var spans = this.gates().spans, key, rec;
      for (key in spans) {
        rec = spans[key];
        if (this._spanIn(rec)) continue;                       // bridge is down: nothing blocking
        if (rec.ev.isNormalPriority && rec.ev.isNormalPriority()) continue;
        out.push([rec.ev.x, rec.ev.y]);
      }
    } catch (e) {}
    return out;
  },

  _pathCrosses: function (tiles, x, y) {
    for (var i = 0; tiles && i < tiles.length; i++) {
      if (tiles[i][0] === x && tiles[i][1] === y) return true;
    }
    return false;
  },

  // The missing bridge between here and there — the next one to go and put down.
  //
  // Its own finder, ranked ahead of everything else in directions(), because a bridge that is out
  // is the one obstruction on a map that CANNOT be walked round. Everything the other two finders
  // report is something that might move: a guard, a chest, a door with a switch on it, and the
  // relaxed flood is built to discount exactly those. It also drops the wall-ground rule, and that
  // is what made this necessary rather than merely tidier — 343 maps have stone that reads as
  // passable, and Etherdepths is floored with it outside the dungeon walls. So the relaxed flood
  // walked out of the dungeon, round the outside of the map and back in, found a 141-tile "route"
  // that crosses no bridge at all, and named whatever normal-priority event it met first. Asking
  // for Chiron from the entrance answered "Chiron is in the way, 66 steps southeast" — the
  // destination reported as its own obstruction, with a walkthrough of somewhere that is not there.
  //
  // Chained by construction, one bridge at a time, which is the useful shape: with nothing thrown
  // the frontier is Lever 2's bridge, so that is the lever named; throw it and the vestibule opens,
  // the frontier moves to Lever 1's bridge one tile north and the answer moves with it; throw that
  // and it becomes Lever 3's. Each answer is the next thing to do rather than the whole puzzle.
  spanBlockerToward: function (tx, ty) {
    return this._frontierBlocker(tx, ty, this._spanTiles());
  },

  blockerToward: function (tx, ty) {
    try {
      var cands = [];
      var evs = $gameMap.events();
      for (var i = 0; i < evs.length; i++) {
        var ev = evs[i];
        if (!ev || ev._erased || !ev.isNormalPriority || !ev.isNormalPriority()) continue;
        cands.push([ev.x, ev.y]);
      }
      return this._frontierBlocker(tx, ty, cands.concat(this._spanTiles()));
    } catch (e) { return null; }
  },

  // Warnings that belong to the route rather than to its destination: something on it will move
  // the player somewhere nobody can predict, or will hurt them for walking over it.
  _routeWarnings: function (tiles) {
    var out = '';
    try {
      // Ahead of the hazards, because it is not about this route: it is about every route, and
      // about the walking itself. A player who has just been told "6 west, 4 south" on a map that
      // will not let them go south needs to hear that before they set off, not after.
      var mode = this.movementMode();
      if (mode) out += ' ' + mode.route;
      var hz = this.hazardOnPath(tiles);
      if (hz) {
        out += ' Warning, this route crosses ' + (hz.name || 'something') +
               ', which moves you ' + hz.why + ', ' + this._bearing(hz.x, hz.y) + '.';
      }
      // Only ever reached when the trap-free flood found nothing: pathTiles hands back the way
      // round whenever one exists, so hearing this means there is no way round.
      var tp = this.trapOnPath(tiles);
      if (tp) {
        out += ' Warning, this route crosses a ' +
               tp.name.charAt(0).toLowerCase() + tp.name.slice(1) + ', ' +
               this._bearing(tp.x, tp.y) + '.';
      }
    } catch (e) {}
    return out;
  },

  // "<blocker> is in the way, 6 steps north. 10 north, 3 east. Straight line 12 northeast."
  //
  // No destination name on any branch. The player pressed this key about the thing they are
  // already selected on and just heard announced; repeating it front-loads every answer with a
  // word they did not need, and the directions — the part they have to hold in their head and
  // act on — arrive later for it.
  //
  // The blocker comes first for the same reason. "Soldier is in the way" changes what the player
  // does about the rest of the sentence, so hearing it after eight compass segments means either
  // remembering the route and discarding it, or asking again.
  directions: function () {
    var e = this.current();
    if (!e) { BMA.Speech.speak('No destination selected', { priority: 'critical' }); return; }
    var sp = this.span($gamePlayer.x, $gamePlayer.y, e.x, e.y);
    var dx = sp.dx, dy = sp.dy;
    var straight = ' Straight line ' +
                   BMA.Util.pluralSteps(BMA.Util.tileDist(dx, dy)) + ' ' + BMA.Util.compass(dx, dy);
    var self = this;

    // "<name> is in the way, 6 steps north." plus what opens it, when it is a sealed passage —
    // that turns the answer from a fact about a wall into a place to go.
    function blocked(b) {
      if (!b) return 'Something is in the way.';
      // The reset rides on the push instruction, so it is heard while the player is standing in
      // front of the thing it is about — and never on a map with no blocks to reset.
      var push = self._pushHint(b.x, b.y);
      return b.name + ' is in the way, ' + self._bearing(b.x, b.y) + '.' +
             push + (push ? self._resetHint(b.x, b.y) : '') +
             self._gateHint(self.gateAt(b.x, b.y) || self.spanAt(b.x, b.y));
    }

    // Already standing next to it: the route is empty, and "You are here" (what describePath
    // returns for a one-tile path) is not what the player wants to hear about an adjacent chest.
    //
    // Manhattan, not Chebyshev, on purpose. Facing is 4-directional and checkEventTriggerThere
    // reads the single tile ahead, so a DIAGONAL neighbour is one the thing cannot be worked from —
    // and "Beside you to the northeast" was an instruction to press the action button at something
    // out of reach, with nothing to explain the silence that followed. Diagonals fall through to
    // the route below instead, which squares the player up onto a tile they can act from. See
    // _goalIndex, which no longer steers them onto a diagonal in the first place.
    if (Math.abs(dx) + Math.abs(dy) === 1) {
      // Arriving beside a block is the moment the instruction is worth having: the route is over,
      // and without it the answer is "Beside you to the west" about a rock, with nothing to do.
      BMA.Speech.speak('Beside you to the ' + BMA.Util.compass(dx, dy) +
                       (e.push ? '.' + this._pushHint(e.x, e.y) : ''), { priority: 'critical' });
      return;
    }

    var tiles = this.pathTiles(e.x, e.y);
    // A route of one tile means the player is already standing on the best approach there is, and
    // both offsets being non-zero makes that a diagonal — _goalIndex only ever returns the tile
    // itself, one of its eight neighbours, or a counter tile straight out, and only the four
    // diagonals have neither offset zero. So this is the case with no orthogonal approach
    // reachable: say where the thing is and that there is nowhere to face it from, rather than
    // "You are here" followed by an action button that does nothing.
    //
    // The zero-offset case is deliberately left alone — standing ON something is how the pressure
    // pads, the dropped items and the save points are used, and "You are here" is right for those.
    if (tiles && tiles.length < 2 && dx && dy) {
      BMA.Speech.speak('Diagonally ' + BMA.Util.compass(dx, dy) + ', nothing to face it from',
                       { priority: 'critical' });
      return;
    }
    if (tiles) {
      BMA.Speech.speak(this.describePath(tiles) + '.' + this._routeWarnings(tiles) + straight,
                       { priority: 'critical' });
      if (BMA.Config.beacon) this._refreshBeacon();
      return;
    }

    // Nothing walkable right now. Before declaring it unreachable, ask whether a route exists at
    // all once the things that can move are discounted — a door, a chest or an NPC standing in a
    // corridor is a fact to announce, not grounds for hiding the destination.
    var via = this.pathTiles(e.x, e.y, true);
    if (via) {
      // Terrain first. See spanBlockerToward: a missing bridge outranks anything the relaxed route
      // turns up, because the relaxed route is allowed to walk through things that move and this
      // is not one of them.
      var b = this.spanBlockerToward(e.x, e.y) ||
              this.blockerOnPath(via) || this.blockerToward(e.x, e.y);
      // A route that does not cross the missing bridge is a route AROUND it, and there is no way
      // around a missing bridge. The relaxed flood found one only because it is allowed onto the
      // stone the strict flood keeps off — outside Etherdepths' walls that stone is the whole rest
      // of the map, so every blocked answer there ended with 21 turns of somewhere that is not
      // there. Read out straight after correctly naming the lever to go and pull, that is not
      // noise, it is an instruction, and following it walks into a wall.
      //
      // Only when the route misses the span. Where it crosses one the route is real — it goes over
      // the bridge, which is exactly what the player is being told to make possible — so it is
      // spoken as usual, blocker and all.
      if (b && this.spanAt(b.x, b.y) && !this._pathCrosses(via, b.x, b.y)) {
        BMA.Speech.speak(blocked(b) + straight, { priority: 'critical' });
        this._logRouteFailure(e, 'blocked', b, via);
        return;
      }
      // Only claim an obstruction when there is one to name. The relaxed flood differs from the
      // strict one in two ways and only one of them is an object: it discounts blocking events,
      // and it drops the wall-ground rule that keeps the strict flood off stone — which 343 of
      // this game's 645 maps have some of. When the difference is the stone, nothing is standing
      // anywhere, and "Something is in the way" sends the player hunting a thing that does not
      // exist. Both finders returning nothing IS that case, so say what is true instead.
      BMA.Speech.speak((b ? blocked(b) : 'No clear way through.') + ' ' +
                       this.describePath(via) + '.' + this._routeWarnings(via) + straight,
                       { priority: 'critical' });
      this._logRouteFailure(e, 'blocked', b, via);
      return;
    }

    // No route even once every blocker is discounted and every crossing is taken into account.
    // "No path found" was the old answer to this and it conflated two different situations: a
    // door held shut by a guard, and a destination on the far side of ground the mod cannot
    // work out how to cross. Say which, and in the second case give somewhere to start.
    // A missing bridge can sit on the reachable frontier even when an exit prevents the
    // relaxed flood from making a complete path. The actionable lever still comes first.
    var bt = this.spanBlockerToward(e.x, e.y) || this.blockerToward(e.x, e.y);
    var msg;
    if (bt) {
      msg = blocked(bt) + ' Beyond the area you can reach.';
    } else {
      msg = 'Beyond the area you can reach.';
      var cross = this.nearestCrossing();
      if (cross) {
        msg += ' Nearest crossing: ' + (cross.name || 'unnamed') + ', ' +
               this._bearing(cross.x, cross.y) + '.';
      }
    }
    BMA.Speech.speak(msg + straight, { priority: 'critical' });
    this._logRouteFailure(e, 'unreachable', bt, null);
  },

  // Why a route could not be given, in one line, written whenever one fails.
  //
  // A route failure is the one thing a player cannot describe well enough to act on. "It said
  // something is in the way" does not say where they were standing, which of the two floods found
  // anything, or whether a blocker was identified and merely unnameable — and those are the facts
  // that separate a real obstruction from the wall-ground rule from a destination on a part of the
  // map only reachable through another map. Mount Ozma's chest 4 is the case in point: it sits
  // behind three switch-gated party-split events at (16,50), (16,51) and (15,52), so whether it is
  // blocked at all depends on switches 813/814/816, and no amount of reading the map data settles
  // it. One line here does.
  //
  // Ungated on purpose. It only writes when the player asks for a route AND that route fails, so
  // it is rare, and it is worthless if it is off exactly when something goes wrong.
  _logRouteFailure: function (e, why, blocker, via) {
    try {
      var f = this.flood(), r = this.flood(true);
      var reached = function (fl) {
        if (!fl || fl.failed) return 'FAILED';
        var n = 0;
        for (var i = 0; i < fl.dist.length; i++) if (fl.dist[i] !== -1) n++;
        return String(n);
      };
      BMA.Log.write('route ' + why + ': map ' + $gameMap.mapId() +
        ' player ' + $gamePlayer.x + ',' + $gamePlayer.y +
        ' -> ' + (e && e.name) + ' (' + (e && e.category) + ') at ' + (e && e.x) + ',' + (e && e.y) +
        ' | strict reaches ' + reached(f) + ', relaxed ' + reached(r) +
        ' | blocker ' + (blocker ? blocker.name + '@' + blocker.x + ',' + blocker.y : 'none named') +
        (via ? ' | relaxed route ' + via.length + ' tiles' : ''));
    } catch (err) {}
  },

  announceMap: function () {
    try {
      var name = BMA.MapNames.current() || ('Map ' + $gameMap.mapId());
      var facing = { 2:'south', 4:'west', 6:'east', 8:'north' }[$gamePlayer.direction()] || '';
      BMA.Speech.speak(name + '. Position ' + $gamePlayer.x + ', ' + $gamePlayer.y +
                       (facing ? '. Facing ' + facing : ''), { priority: 'critical' });
    } catch (e) {}
  },

  // "Entering <map>" on a genuine map change. Scene_Map is recreated on every menu close
  // and battle return too, so this is gated on both the transfer flag and the map id.
  _lastAnnouncedMap: -1,
  announceMapEntry: function () {
    try {
      var id = $gameMap.mapId();
      if (id === this._lastAnnouncedMap) return;
      this._lastAnnouncedMap = id;
      // Said whether or not map-entry announcements are switched off: this is not the map's name,
      // it is what the direction keys are about to do, and a player who has turned the name off
      // has not asked to be surprised by that. See movementMode.
      //
      // Recorded as well as said, so the setter hook does not say it a second time. Gozmodan's
      // Grotto is the case that needs it either way round: the flag is turned on by the map
      // BEFORE it, as part of the transfer, so arriving is the only moment there is to hear it.
      var mode = this.movementMode();
      this._lastMoveMode = mode ? mode.key : null;
      if (mode) BMA.Speech.speak(mode.entering, { priority: 'critical' });
      if (!BMA.Config.announceMapEntry) return;
      var name = BMA.MapNames.current();
      if (name) BMA.Speech.speak('Entering ' + name, { priority: 'critical' });
    } catch (e) {}
  },

  //---------------------------------------------------------------------------
  // Maps that take the direction keys off you.
  //
  // Two of this game's 81 plugins do nothing but change what walking means, and both are switched
  // on and off by a bare script call inside an ordinary event — so nothing in any map file says a
  // map uses one, and no amount of reading the event data would have found them. They were found
  // in plugins.js:
  //
  //   ForcedLeftMovement    the player is dragged west every frame they are not steering, and the
  //                         east key is discarded outright. Forest (190) is the only user: a
  //                         255x16 corridor entered at the east end, run at speed 5, with 43 of
  //                         the game's damage tiles to be dodged and six ways out stacked at x=0.
  //                         Up and down are the whole of the controls.
  //   RedirectDownToUp      the south key is rewritten to north, so south cannot be walked at all.
  //                         Gygas Arena (76) turns it on as it transfers the party into Gozmodan's
  //                         Grotto (55) with their swimming sprites, and the grotto's tile at
  //                         (27,13) turns it off on the way out — 225 tiles of one-way swim, up.
  //
  // A sighted player is told neither of these either, but they can see the sprite moving without
  // them and see that a key did nothing. Blind, the entire event is that the character starts
  // walking on its own, or that one of the four keys silently does another key's job — with the
  // mod's own directions ("6 west, 4 south") still being spoken as if all four worked.
  //
  // Read from $gameSystem rather than from a map id, so it is the mechanism that is recognised:
  // both flags are saved with the game, and both are cleared from a different map than they were
  // set on, which is exactly the case a map-id list would get wrong.
  movementMode: function () {
    try {
      if (typeof $gameSystem === 'undefined' || !$gameSystem) return null;
      if ($gameSystem.isForcedLeft && $gameSystem.isForcedLeft()) {
        return { key: 'forcedLeft',
                 entering: 'You are being carried west and cannot stop. East does nothing here; ' +
                           'steer with north and south.',
                 route: 'You are being carried west; only north and south can be steered.' };
      }
      if ($gameSystem.isRedirectDownToUp && $gameSystem.isRedirectDownToUp()) {
        return { key: 'downIsUp',
                 entering: 'The way here is up only. South cannot be walked, and the south key ' +
                           'moves you north as well.',
                 route: 'South cannot be walked here; the south key moves you north.' };
      }
    } catch (e) {}
    return null;
  },

  // Said the moment the mode changes, because that is where the surprise is: the flag goes on
  // from an autorun the player did not trigger and off from a tile they walked over, and in
  // neither case does anything else on screen mark it. Hooked onto the two setters below rather
  // than polled — they are the only things in the game that move either flag, so there is nothing
  // to poll for and nothing to pay for on the 643 maps that use neither.
  _lastMoveMode: null,
  announceMovementMode: function () {
    try {
      var mode = this.movementMode();
      var key = mode ? mode.key : null;
      if (key === this._lastMoveMode) return;
      var was = this._lastMoveMode;
      this._lastMoveMode = key;
      if (!(SceneManager._scene instanceof Scene_Map)) return;
      if (mode) BMA.Speech.speak(mode.entering, { priority: 'critical' });
      else if (was) BMA.Speech.speak('Normal movement restored.', { priority: 'critical' });
    } catch (e) {}
  },

  //---------------------------------------------------------------------------
  // Audio cues
  //---------------------------------------------------------------------------
  // Doorway lookup, precomputed by scan() instead of scanning every event on the map four
  // times per step.
  _transferTiles: {},
  _isTransferAt: function (x, y) {
    return !!this._transferTiles[x + ',' + y];
  },

  // Which of the four neighbours are walls, memoised per tile.
  //
  // Each canPass here runs isCollidedWithEvents -> eventsXyNt -> events().filter(), rebuilding
  // and scanning the whole ~300-element event array, twice, plus YEP_RegionRestrictions' region
  // lookups — four times per step, on the main thread, in the gap between frames. That is what
  // made movement stutter when two tones and a footstep landed together; the Web Audio nodes are
  // the cheap part. Wrapped in _withEventIndex (the repo's own fix for exactly this, until now
  // spent only on flood()) and cached by tile, so walking a corridor recomputes once per tile and
  // standing still costs nothing.
  _wallKey: null,
  _wallBlocked: null,

  blockedDirections: function () {
    var key = $gameMap.mapId() + ',' + $gamePlayer.x + ',' + $gamePlayer.y;
    if (this._wallKey === key) return this._wallBlocked;
    var self = this, px = $gamePlayer.x, py = $gamePlayer.y;
    var w = $gameMap.width(), h = $gameMap.height(), loop = this._loops();
    var blocked = [];
    try {
      this._withEventIndex(w, function () {
        for (var i = 0; i < DIRS.length; i++) {
          var d = DIRS[i];
          // canPass already wraps (roundXWithDirection); the tile being asked about here has to
          // wrap with it, or an exit sitting just across a looping seam reads as a wall.
          var nx = self._wrapX(px + d.dx, w, loop.h), ny = self._wrapY(py + d.dy, h, loop.v);
          if (nx >= 0 && ny >= 0 && self._isTransferAt(nx, ny)) continue;   // exits aren't walls
          if (!$gamePlayer.canPass(px, py, d.d)) blocked.push(d.k);
        }
      });
    } catch (e) { BMA.Log.write('blockedDirections threw: ' + (e && e.message)); }
    this._wallKey = key;
    this._wallBlocked = blocked;
    return blocked;
  },

  updateWallTones: function () {
    if (!BMA.Config.wallTones) { BMA.Audio.stopAllWalls(); return; }
    var blocked = this.blockedDirections();
    if (BMA.Config.wallTonesContinuous) {
      BMA.Audio.setWallDirections(blocked);
    } else {
      // No pan argument: gen_sounds.js already bakes the direction into each WAV (wall_e hard
      // right, wall_w hard left, n/s centre), so a runtime StereoPannerNode was re-panning
      // already-panned audio — a no-op node allocated per tone per step.
      for (var b = 0; b < blocked.length; b++)
        BMA.Audio.play('wall_' + blocked[b], BMA.Config.vol.wallTone);
    }
  },

  footstep: function () {
    // Likewise pan-less: footstep.wav is centre and was being panned to 0.
    if (BMA.Config.footsteps) BMA.Audio.play('footstep', BMA.Config.vol.footstep);
  },

  //---------------------------------------------------------------------------
  // Airship landing.
  //
  // The airship flies over everything, so none of the other movement cues mean anything in it:
  // wall tones never sound, nothing blocks, and the only fact that matters — whether pressing
  // the confirm button here would put you down or do nothing — has no outward sign at all. A
  // sighted player reads it off the ground below.
  //
  // The question is asked of the engine rather than reimplemented. Game_Vehicle.isLandOk is the
  // same call getOffVehicle makes, so this answers with whatever the game would actually do,
  // including its two clauses that are easy to forget: the tile must carry the tileset's airship
  // flag AND be passable from every direction, and it must hold no event — which is why you
  // cannot set down on a town or a signpost even though the grass around it is fine. It also
  // means YEP_X_VehicleRestrict keeps working if its region parameters are ever set (they are
  // all 0 today), because it aliases the very method being called.
  //
  // On this game's Overworlds that comes to 12,349 landable tiles out of 57,500 — so on any real
  // flight it changes often, and the coastline is where it changes most.
  //
  // Which is why the answer has to settle before it is spoken. Skimming a ragged coast flips it
  // several times in under a second, and speech is queued: announcing every flip means hearing
  // the coast the player crossed a while ago. A change is held for LANDING_SETTLE and only
  // spoken if it is still true when the timer fires, so a flight along a shore says the thing
  // once it has committed to a side.
  LANDING_SETTLE: 220,       // ms an answer must hold before it is worth saying

  _landing: null,            // last SPOKEN answer; null = not in the airship, or no baseline yet
  _landingTimer: null,

  // true / false while riding the airship, null in anything else — on foot, in the boat or the
  // ship, or mid-transition while boarding or setting down, when the tile under the player is
  // not yet the one the answer is about.
  canLandHere: function () {
    try {
      if (!$gamePlayer || !$gamePlayer.isInAirship || !$gamePlayer.isInAirship()) return null;
      if ($gamePlayer._vehicleGettingOn || $gamePlayer._vehicleGettingOff) return null;
      var v = $gamePlayer.vehicle();
      if (!v || !v.isLandOk) return null;
      return !!v.isLandOk($gamePlayer.x, $gamePlayer.y, $gamePlayer.direction());
    } catch (e) { return null; }
  },

  updateLanding: function () {
    var self = this;
    if (!BMA.Config.airshipLanding) { this.clearLanding(); return; }
    var now = this.canLandHere();
    if (now === null) { this.clearLanding(); return; }

    // First answer of a flight is the baseline and is not spoken: the player has just lifted off
    // a tile they landed on themselves, so "can land" tells them something they already know.
    // Everything after it is a change they cannot see.
    if (this._landing === null) { this._landing = now; return; }

    if (now === this._landing) {
      // Flipped back before it was said. As far as the player is concerned nothing happened.
      if (this._landingTimer) { clearTimeout(this._landingTimer); this._landingTimer = null; }
      return;
    }
    if (this._landingTimer) return;                 // already waiting on this same change
    this._landingTimer = setTimeout(function () {
      self._landingTimer = null;
      var v = self.canLandHere();
      if (v === null || v === self._landing) return;
      self._landing = v;
      BMA.Speech.speak(v ? 'Can land' : 'Can not land', { priority: 'critical' });
    }, this.LANDING_SETTLE);
  },

  clearLanding: function () {
    if (this._landingTimer) { clearTimeout(this._landingTimer); this._landingTimer = null; }
    this._landing = null;
  },

  // Rate-limited: a blocked move does not stop the engine re-running moveByInput, so
  // holding into a wall re-enters moveStraight every frame. Firing on all of them meant
  // ~60 bump cues and ~180 Web Audio nodes per second.
  _lastBumpDir: 0,
  _lastBumpAt: 0,
  BUMP_INTERVAL: 250,             // ms between repeats while still shoving at the same wall

  // Cheap enough to ask every frame while shoving at a wall, which is the point: the caller
  // consults this before allocating a closure and scheduling a deferred task.
  shouldBump: function () {
    if (!BMA.Config.wallTones) return false;
    if ($gamePlayer.direction() === this._lastBumpDir &&
        (BMA.Perf.now() - this._lastBumpAt) < this.BUMP_INTERVAL) return false;
    return true;
  },

  wallBump: function () {
    if (!BMA.Config.wallTones) return;
    var dir = $gamePlayer.direction();
    var now = BMA.Perf.now();
    if (dir === this._lastBumpDir && (now - this._lastBumpAt) < this.BUMP_INTERVAL) return;
    this._lastBumpDir = dir;
    this._lastBumpAt = now;
    BMA.Perf.count('wallBump');
    var d = { 2:'s',4:'w',6:'e',8:'n' }[dir] || 'n';
    BMA.Audio.play('wall_bump', BMA.Config.vol.wallBump, { n:0,s:0,e:1,w:-1 }[d]);
  },

  clearBump: function () { this._lastBumpDir = 0; this._lastBumpAt = 0; },

  _refreshBeacon: function () {
    var self = this;
    if (!BMA.Config.beacon) { BMA.Audio.stopBeacon(); return; }
    BMA.Audio.startBeacon(function () {
      var e = self.current();
      if (!e || SceneManager._scene && !(SceneManager._scene instanceof Scene_Map)) return null;
      var s = self.span($gamePlayer.x, $gamePlayer.y, e.x, e.y);
      var dx = s.dx, dy = s.dy;
      var dist = BMA.Util.tileDist(dx, dy);
      if (dist <= 1) return null;                       // silent on the target and one step away
      var pan = Math.max(-1, Math.min(1, dx / Math.max(1, Math.abs(dx) + Math.abs(dy))));
      return { pan: pan, dist: dist, south: dy > 0 };
    });
  },

  toggleBeacon: function () {
    BMA.Config.beacon = !BMA.Config.beacon;
    BMA.Speech.speak('Beacon ' + (BMA.Config.beacon ? 'on' : 'off'), { priority: 'critical' });
    if (BMA.Config.beacon) this._refreshBeacon(); else BMA.Audio.stopBeacon();
  },
};

//-----------------------------------------------------------------------------
// Waypoints (optional, FF1 parity) — persisted to www/mod/waypoints.json
//-----------------------------------------------------------------------------
BMA.Waypoints = {
  data: {},        // mapId -> [{name,x,y}]
  index: 0,
  _fs: null, _path: null, file: null,

  init: function () {
    try {
      this._fs = require('fs'); this._path = require('path');
      if (BMA.TTS.modDir) {
        this.file = this._path.join(BMA.TTS.modDir, 'waypoints.json');
        if (this._fs.existsSync(this.file)) this.data = JSON.parse(this._fs.readFileSync(this.file, 'utf8')) || {};
      }
    } catch (e) { this.data = {}; }
  },
  _list: function () { return this.data[$gameMap.mapId()] || []; },
  _save: function () { try { if (this.file) this._fs.writeFileSync(this.file, JSON.stringify(this.data, null, 1)); } catch (e) {} },

  cycle: function (dir) {
    var list = this._list();
    if (!list.length) { BMA.Speech.speak('No waypoints on this map', { priority: 'critical' }); return; }
    this.index = (this.index + dir + list.length) % list.length;
    var wp = list[this.index];
    var s = BMA.Nav.span($gamePlayer.x, $gamePlayer.y, wp.x, wp.y);
    var dx = s.dx, dy = s.dy;
    BMA.Speech.speak('Waypoint ' + wp.name + ', ' + BMA.Util.pluralSteps(BMA.Util.tileDist(dx, dy)) +
                     ' ' + BMA.Util.compass(dx, dy), { priority: 'critical' });
  },
  pathfind: function () {
    var list = this._list();
    if (!list.length) { BMA.Speech.speak('No waypoints', { priority: 'critical' }); return; }
    var wp = list[this.index % list.length];
    var tiles = BMA.Nav.pathTiles(wp.x, wp.y);
    if (!tiles) {
      // Same shape as directions(), including leaving the name out: the player asked about the
      // waypoint they have selected and just heard, and a route is easier to hold on to when it
      // starts with the first instruction. A waypoint they dropped themselves is also exactly
      // the case where "no path" most often means "not on foot from here".
      var line = 'Beyond the area you can reach.';
      var cross = BMA.Nav.nearestCrossing();
      if (cross) {
        line += ' Nearest crossing: ' +
                (cross.name || 'unnamed') + ', ' +
                BMA.Nav._bearing(cross.x, cross.y) + '.';
      }
      BMA.Speech.speak(line, { priority: 'critical' });
      return;
    }
    BMA.Speech.speak(BMA.Nav.describePath(tiles) + '.' + BMA.Nav._routeWarnings(tiles),
                     { priority: 'critical' });
  },
  add: function () {
    var name = null;
    try { name = window.prompt('Waypoint name:', 'Waypoint'); } catch (e) {}
    if (!name) { BMA.Speech.speak('Cancelled', { priority: 'critical' }); return; }
    var id = $gameMap.mapId();
    if (!this.data[id]) this.data[id] = [];
    this.data[id].push({ name: name, x: $gamePlayer.x, y: $gamePlayer.y });
    this._save();
    BMA.Speech.speak('Added waypoint ' + name, { priority: 'critical' });
  },
};

//-----------------------------------------------------------------------------
// Engine hooks for audio cues
//-----------------------------------------------------------------------------
if (window.Game_Player) {
  var _increaseSteps = Game_Player.prototype.increaseSteps;
  Game_Player.prototype.increaseSteps = function () {
    _increaseSteps.call(this);
    // Deferred: the cues are cheap, but they have no business running inside the engine's
    // update call. BMA.defer batches them into a single timer drained after the frame.
    BMA.defer(function () {
      BMA.Perf.time('step cues', function () {
        try { BMA.Nav.footstep(); BMA.Nav.updateWallTones(); BMA.Nav.updateLanding(); } catch (e) {}
      });
    });
  };
}

// Boarding and leaving the airship. Both reset the landing cue rather than announce: getting on
// takes off from a tile the player landed on, and getting off has just answered the question by
// doing it. Without the reset the next flight's baseline would be last flight's answer, and the
// first real change of the new flight would go unspoken.
if (window.Game_Player) {
  var _getOnVehicle = Game_Player.prototype.getOnVehicle;
  Game_Player.prototype.getOnVehicle = function () {
    var r = _getOnVehicle.call(this);
    try { BMA.Nav.clearLanding(); } catch (e) {}
    return r;
  };
  var _getOffVehicle = Game_Player.prototype.getOffVehicle;
  Game_Player.prototype.getOffVehicle = function () {
    var r = _getOffVehicle.call(this);
    try { BMA.Nav.clearLanding(); } catch (e) {}
    return r;
  };
}

// On Game_Player, not Game_CharacterBase: hooked on the base class, every moving event on the map
// paid the alias frame and an isMovementSucceeded() call before being discarded by the identity
// check — and towns run a lot of wandering NPCs.
//
// The rate limit is consulted BEFORE deferring, too. A blocked move does not stop the engine
// re-running moveByInput, so holding into a wall re-enters this ~60 times a second; the old order
// allocated a closure and pushed onto the defer queue every one of those frames only for
// wallBump() to drop it. shouldBump() is a couple of integer compares.
if (window.Game_Player) {
  var _moveStraight = Game_Player.prototype.moveStraight;
  Game_Player.prototype.moveStraight = function (d) {
    _moveStraight.call(this, d);
    try {
      if (this.isMovementSucceeded()) { BMA.Nav.clearBump(); return; }
      if (!BMA.Nav.shouldBump()) return;
      BMA.defer(function () { try { BMA.Nav.wallBump(); } catch (e) {} });
    } catch (e) {}
  };
}

// A bridge going down or coming up.
//
// Game_Map.refresh is the one place the engine re-evaluates page conditions, and every route to a
// switch change ends here: Game_Switches.setValue calls onChange, which requests a refresh, and
// Game_Map.update performs it on the next frame. Hooking the switch itself would fire before the
// pages had been re-read and would have to guess at the outcome; here the answer is simply read
// off the map twice, once either side.
//
// spanState() returns null on a map with no bridges, and announceSpanChange returns on the first
// line for the null — so on 640 of the game's 645 maps this costs one memoised lookup per refresh.
if (window.Game_Map) {
  var _mapRefresh = Game_Map.prototype.refresh;
  Game_Map.prototype.refresh = function () {
    var before = null;
    try { before = BMA.Nav.spanState(); } catch (e) {}
    _mapRefresh.call(this);
    try { BMA.Nav.announceSpanChange(before); } catch (e) {}
  };

  // The third way this game opens a bridge, after the tile event and the gate: it swaps the whole
  // tileset out from under the map. Crescent Rivulet (217) is the only one that does it as a
  // mechanism — ten invisible tiles along its river banks flip between "Cave 2" (12) and
  // "Cave 2 BRIDGE UP" (29), and 132 tiles change from wall to floor when they do.
  //
  // Nothing announced it and, worse, nothing retired the caches: the passability of a tile is read
  // live off tilesetFlags(), but the flood that answers "how do I get there" is computed once and
  // kept until something is known to have moved. A tileset swap moves nothing — no event changes
  // page, no switch the scan watches is touched on the events it watches — so directions went on
  // being given from a map that had stopped existing, and 132 tiles' worth of it.
  //
  // Hooked on changeTileset rather than on refresh, because refresh is called for every switch in
  // the game and this is called by exactly the 19 Change Tileset commands in it. Same-value calls
  // are ignored: the Overworld's three swap between four of them in a cutscene loop.
  var _changeTileset = Game_Map.prototype.changeTileset;
  if (_changeTileset) {
    Game_Map.prototype.changeTileset = function (tilesetId) {
      var was = this._tilesetId;
      _changeTileset.call(this, tilesetId);
      if (was === tilesetId) return;
      try { BMA.Nav.announceTilesetChange(was); } catch (e) {}
    };
  }
}

// The two plugins that rewrite the direction keys. Both are switched by a script call from an
// ordinary event, so the setter is the only moment the change is observable — see movementMode.
// Guarded on the plugin being present: neither is part of MV, and the mod has to survive a game
// build that drops one.
if (window.Game_System && Game_System.prototype.setForcedLeft) {
  var _setForcedLeft = Game_System.prototype.setForcedLeft;
  Game_System.prototype.setForcedLeft = function (enabled) {
    _setForcedLeft.call(this, enabled);
    try { BMA.Nav.announceMovementMode(); } catch (e) {}
  };
}
if (window.Game_System && Game_System.prototype.setRedirectDownToUp) {
  var _setRedirect = Game_System.prototype.setRedirectDownToUp;
  Game_System.prototype.setRedirectDownToUp = function (enabled) {
    _setRedirect.call(this, enabled);
    try { BMA.Nav.announceMovementMode(); } catch (e) {}
  };
}

// Update wall tones when the player turns without moving, and rescan on map change.
if (window.Scene_Map) {
  var _onMapLoaded = Scene_Map.prototype.onMapLoaded;
  Scene_Map.prototype.onMapLoaded = function () {
    _onMapLoaded.call(this);
    try {
      // Where this visit started. Dungeon doors are numbered outward from here, and it has to be
      // read before the player takes a step or "closest to the entrance" drifts as they walk.
      BMA.Nav._arrival = { mapId: $gameMap.mapId(), x: $gamePlayer.x, y: $gamePlayer.y };
      // See announceTilesetChange: a tileset swap inside the first second is the map settling.
      BMA.Nav._mapLoadedFrame = (window.Graphics && Graphics.frameCount) || 0;
      BMA.Perf.time('scan', function () { BMA.Nav.scan(); });
      BMA.Nav.updateWallTones();
      // A transfer can put the airship over completely different ground, so the answer carried
      // over from the last map is not about anywhere the player now is. Re-baseline silently.
      BMA.Nav.clearLanding();
      BMA.Nav.updateLanding();
      // Entry cutscenes flip switches a beat after load; a single settle-pass catches that
      // reveal even before the first keypress (input and the beacon also self-heal via
      // ensureScanned). Guarded to the same map so a quick transfer doesn't scan the wrong one.
      var mid = $gameMap.mapId();
      setTimeout(function () {
        try {
          if (SceneManager._scene instanceof Scene_Map && $gameMap && $gameMap.mapId() === mid)
            BMA.Nav.deltaScan();
        } catch (e) {}
      }, 450);
    } catch (e) {}
  };
  // Scene_Map is rebuilt on every menu close, battle return and load, not just on a
  // transfer — so the gate is the map id, not the scene's _transfer flag. Closing the menu
  // or finishing a battle lands on the same id and stays silent; loading a save onto a
  // different map correctly announces, which a _transfer check would have missed.
  var _sceneStart = Scene_Map.prototype.start;
  Scene_Map.prototype.start = function () {
    _sceneStart.call(this);
    try { BMA.Nav.announceMapEntry(); } catch (e) {}
    // Same hook, and it has to be this one: a party swap is a Transfer Player, and MV rebuilds
    // Scene_Map for a transfer even when it lands on the map you are already on. Closing the menu
    // and coming back from a battle rebuild it too, and both leave the leader alone, so
    // announceParty stays silent for those on its own.
    try { BMA.Nav.announceParty(); } catch (e) {}
  };
  var _sceneTerminate = Scene_Map.prototype.terminate;
  Scene_Map.prototype.terminate = function () {
    try { BMA.Audio.stopAllWalls(); BMA.Audio.stopBeacon(); } catch (e) {}
    _sceneTerminate.call(this);
  };
}

//-----------------------------------------------------------------------------
// Field key registrations
//-----------------------------------------------------------------------------
BMA.Input.register('prevDest',        function () { BMA.Nav.cycle(-1); });
BMA.Input.register('nextDest',        function () { BMA.Nav.cycle(1); });
BMA.Input.register('prevCategory',    function () { BMA.Nav.switchCategory(-1); });
BMA.Input.register('nextCategory',    function () { BMA.Nav.switchCategory(1); });
BMA.Input.register('reannounce',      function () { BMA.Nav.reannounce(); });
// The bracket keyset. Only one set responds at a time (BMA.Input.isActive), so nothing is
// double-bound; p is in both sets and changes meaning instead.
BMA.Input.register('prevDestAlt',     function () { BMA.Nav.cycle(-1); });
BMA.Input.register('nextDestAlt',     function () { BMA.Nav.cycle(1); });
BMA.Input.register('prevCategoryAlt', function () { BMA.Nav.switchCategory(-1); });
BMA.Input.register('nextCategoryAlt', function () { BMA.Nav.switchCategory(1); });
// With the beacon active, the directions key re-announces the current target and re-arms the
// beacon toward it (reannounce -> announce -> _refreshBeacon) instead of giving turn-by-turn
// directions — handy for re-locking after the beacon falls silent near the target.
BMA.Input.register('directionsAlt',   function () {
  if (BMA.Config.beacon) BMA.Nav.reannounce();
  else BMA.Nav.directions();
});
BMA.Input.register('directions',      function () {
  if (BMA.Config.navKeyset === 'bracket' || BMA.Config.beacon) BMA.Nav.reannounce();
  else BMA.Nav.directions();
});
BMA.Input.register('rescan',          function () { BMA.Nav.scan(); BMA.Speech.speak('Rescanned', { priority: 'critical' }); });
BMA.Input.register('resetCategory',   function () { BMA.Nav.resetCategory(); });
BMA.Input.register('announceMap',     function () { BMA.Nav.announceMap(); });
BMA.Input.register('toggleBeacon',    function () { BMA.Nav.toggleBeacon(); });
// Path filter and the custom labeller each answer to the active keyset's family (p in
// classic, \ in bracket); one handler is shared between the two bindings.
var _togglePathFilter = function () {
  BMA.Config.pathFilter = !BMA.Config.pathFilter;
  BMA.Speech.speak('Path filter ' + (BMA.Config.pathFilter ? 'on' : 'off'), { priority: 'critical' });
};
BMA.Input.register('togglePathFilter',    _togglePathFilter);
BMA.Input.register('togglePathFilterAlt', _togglePathFilter);
var _customLabel = function () { BMA.Nav.customLabel(); };
BMA.Input.register('customLabel',    _customLabel);
BMA.Input.register('customLabelAlt', _customLabel);

// Reset category to "all" is per-keyset: shift+k (classic), shift+p (bracket), shift+s (left-hand).
BMA.Input.register('resetCategoryAlt', function () { BMA.Nav.resetCategory(); });

// The left-handed keyset (a/s/d/f). Same handlers as the other two sets; isActive keeps only the
// selected set live, so nothing is double-bound. f mirrors the directions key: with the beacon on
// it re-announces the target and re-arms the beacon, otherwise it gives turn-by-turn directions.
BMA.Input.register('prevDestLh',         function () { BMA.Nav.cycle(-1); });
BMA.Input.register('nextDestLh',         function () { BMA.Nav.cycle(1); });
BMA.Input.register('prevCategoryLh',     function () { BMA.Nav.switchCategory(-1); });
BMA.Input.register('nextCategoryLh',     function () { BMA.Nav.switchCategory(1); });
BMA.Input.register('reannounceLh',       function () { BMA.Nav.reannounce(); });
BMA.Input.register('directionsLh',       function () {
  if (BMA.Config.beacon) BMA.Nav.reannounce();
  else BMA.Nav.directions();
});
BMA.Input.register('togglePathFilterLh', _togglePathFilter);
BMA.Input.register('customLabelLh',      _customLabel);
BMA.Input.register('resetCategoryLh',    function () { BMA.Nav.resetCategory(); });
BMA.Input.register('toggleFootsteps', function () {
  BMA.Config.footsteps = !BMA.Config.footsteps;
  BMA.Speech.speak('Footsteps ' + (BMA.Config.footsteps ? 'on' : 'off'), { priority: 'critical' });
});
BMA.Input.register('toggleWallTones', function () {
  BMA.Config.wallTones = !BMA.Config.wallTones;
  if (!BMA.Config.wallTones) BMA.Audio.stopAllWalls();
  BMA.Speech.speak('Wall tones ' + (BMA.Config.wallTones ? 'on' : 'off'), { priority: 'critical' });
});
BMA.Input.register('prevWaypoint',    function () { BMA.Waypoints.cycle(-1); });
BMA.Input.register('nextWaypoint',    function () { BMA.Waypoints.cycle(1); });
BMA.Input.register('pathfindWaypoint',function () { BMA.Waypoints.pathfind(); });
BMA.Input.register('addWaypoint',     function () { BMA.Waypoints.add(); });

// Init waypoints and custom labels after boot.
if (window.Scene_Boot) {
  var _bootStart = Scene_Boot.prototype.start;
  Scene_Boot.prototype.start = function () {
    _bootStart.call(this);
    try { if (!BMA.Waypoints._inited) { BMA.Waypoints._inited = true; BMA.Waypoints.init(); } } catch (e) {}
    try { if (!BMA.Nav._labelsInited) { BMA.Nav._labelsInited = true; BMA.Nav.initLabels(); } } catch (e) {}
  };
}

})();
