// Esto Yensa — the one dungeon in this game that hands you two parties and asks them to open
// each other's way through.
//
// Nothing about that mechanic has an outward sign a screen reader can pick up. Page Up and Page
// Down swap which half you are steering and teleport you across a 200x155 map; twelve pressure
// pads clear twelve walls of spikes, and every pad is in the half the OTHER party is walking.
// So the three things this asserts are the three things a blind player cannot otherwise learn:
// which party they have, that the pads are pads, and that the wall in front of them opens from
// somewhere they cannot get to.
//
// It runs the SHIPPING flood over the real map on the faithful passability stub, the same way
// nav_realmap.js does, so "the pathfinder works here" is measured rather than assumed.
const fs = require('fs'), path = require('path'), vm = require('vm');
const { SRC, DATA, MOD, requireGame, installTilemap, installedMapPassage } = require('./_paths');
installTilemap();
requireGame('nav_estoyensa.js');

const TILESETS = JSON.parse(fs.readFileSync(path.join(DATA, 'Tilesets.json'), 'utf8'));

global.window = global;
global.document = { addEventListener() {} };
global.require = require;
global.performance = { now: () => 0 };
for (const k of ['MapInfos', 'Actors', 'CommonEvents', 'Armors', 'System', 'Classes', 'States'])
  global['$data' + k] = JSON.parse(fs.readFileSync(path.join(DATA, k + '.json'), 'utf8'));
global.$gameVariables = { value: () => 0 };

// A party whose leader the tests set, because which half you are steering is the whole subject.
let LEADER = 0;
const actorStub = id => (id && $dataActors[id]
  ? { actorId: () => id, name: () => $dataActors[id].name } : null);
global.$gameActors = { actor: actorStub };
global.$gameParty = {
  leader: () => actorStub(LEADER),
  members: () => (LEADER ? [actorStub(LEADER)] : []),
};

// ---- MV passability, faithful (see nav_realmap.js) ----
const BIT = { 2: 0x01, 4: 0x02, 6: 0x04, 8: 0x08 };
const REV = { 2: 8, 8: 2, 4: 6, 6: 4 };
let MAP = null, FLAGS = null, EVENTS = [], LOOPH = false, LOOPV = false;
const modn = (a, n) => ((a % n) + n) % n;
const roundX = x => (LOOPH ? modn(x, MAP.width) : x);
const roundY = y => (LOOPV ? modn(y, MAP.height) : y);
const checkPassage = installedMapPassage(() => FLAGS);
const xWith = (x, d) => roundX(x + (d === 6 ? 1 : d === 4 ? -1 : 0));
const yWith = (y, d) => roundY(y + (d === 2 ? 1 : d === 8 ? -1 : 0));

global.$gameMap = {
  mapId: () => 400,
  width: () => MAP.width, height: () => MAP.height,
  displayName: () => MAP.displayName || '',
  tilesetId: () => MAP.tilesetId,
  isValid(x, y) { return x >= 0 && y >= 0 && x < MAP.width && y < MAP.height; },
  isLoopHorizontal: () => LOOPH, isLoopVertical: () => LOOPV,
  roundX, roundY,
  isPassable(x, y, d) { return checkPassage(x, y, BIT[d]); },
  tilesetFlags: () => FLAGS,
  tileId: Game_Map.prototype.tileId,
  isCounter(x, y) {
    if (!this.isValid(x, y)) return false;
    const W = MAP.width, H = MAP.height, dd = MAP.data;
    for (let z = 3; z >= 0; z--) {
      const f = FLAGS[dd[(z * H + y) * W + x]] | 0;
      if ((f & 0x10) !== 0) continue;
      return (f & 0x80) !== 0;
    }
    return false;
  },
  events: () => EVENTS.slice(),
  eventsXy(x, y) { return this.events().filter(e => e.pos(x, y)); },
  eventsXyNt(x, y) { return this.events().filter(e => e.posNt(x, y)); },
};
global.$gamePlayer = {
  x: 0, y: 0, direction: () => 2, isThrough: () => false,
  isMapPassable(x, y, d) {
    return $gameMap.isPassable(x, y, d) && $gameMap.isPassable(xWith(x, d), yWith(y, d), REV[d]);
  },
  isCollidedWithCharacters(x, y) { return $gameMap.eventsXyNt(x, y).some(e => e.isNormalPriority()); },
  canPass(x, y, d) {
    const x2 = xWith(x, d), y2 = yWith(y, d);
    if (!$gameMap.isValid(x2, y2)) return false;
    if (this.isThrough()) return true;
    if (!this.isMapPassable(x, y, d)) return false;
    if (this.isCollidedWithCharacters(x2, y2)) return false;
    return true;
  },
};

for (const f of ['BMA_Core.js', 'BMA_Text.js', 'BMA_Menus.js', 'BMA_Nav.js'])
  vm.runInThisContext(fs.readFileSync(path.join(SRC, f), 'utf8'), { filename: f });
BMA.TTS.modDir = MOD;

// Which page MV would run: the highest-indexed one whose conditions are met. ON names the story
// switches a save at this point in the game would have set; everything else is off, so inside the
// dungeon the spikes are all up and nothing has been opened yet.
let ON = new Set();
function meets(page) {
  const c = page.conditions; if (!c) return true;
  if (c.switch1Valid && !ON.has(c.switch1Id)) return false;
  if (c.switch2Valid && !ON.has(c.switch2Id)) return false;
  if (c.selfSwitchValid) return false;
  if (c.variableValid && c.variableValue > 0) return false;
  if (c.itemValid || c.actorValid) return false;
  return true;
}
function activePage(ev) {
  for (let i = ev.pages.length - 1; i >= 0; i--) if (meets(ev.pages[i])) return ev.pages[i];
  return null;
}
function loadMap(id) {
  MAP = JSON.parse(fs.readFileSync(path.join(DATA, 'Map' + String(id).padStart(3, '0') + '.json'), 'utf8'));
  global.$dataMap = MAP;
  FLAGS = TILESETS[MAP.tilesetId].flags;
  LOOPH = MAP.scrollType === 2 || MAP.scrollType === 3;
  LOOPV = MAP.scrollType === 1 || MAP.scrollType === 3;
  EVENTS = MAP.events.filter(Boolean).map(ev => {
    const p = activePage(ev) || {};
    return {
      _x: ev.x, _y: ev.y, x: ev.x, y: ev.y, _erased: false, _pageIndex: 0,
      _priorityType: p.priorityType, _through: !!p.through,
      eventId: () => ev.id,
      pos(px, py) { return this._x === px && this._y === py; },
      posNt(px, py) { return this.pos(px, py) && !this._through; },
      isNormalPriority() { return this._priorityType === 1; },
      event: () => ev, page: () => p,
    };
  });
  $gameMap.mapId = () => id;
  resetNav();
}
// Everything the mod memoises per map, so a test that moves an event sees the new answer.
function resetNav() {
  BMA.Nav.scannedMap = null;
  BMA.Nav.entities = [];
  BMA.Nav._clearFloods();
  BMA.Nav._gates = null;
  BMA.Nav._swapKey = -1;
  BMA.Nav._markerKey = -1;
  BMA.Nav._nameless = {};
  BMA.Nav._groups = {};
}
function standAt(x, y) {
  $gamePlayer.x = x; $gamePlayer.y = y;
  BMA.Nav._clearFloods();
  BMA.Nav._arrival = { mapId: $gameMap.mapId(), x, y };
}

// Independent reference BFS — same rules as the strict flood, written separately from the mod.
// Both of its extra masks matter on this map: Esto Yensa is floored with jump crossings, and its
// A4 stone is walkable as far as the tileset is concerned.
//
// forced: a tile that moves you the instant you arrive is somewhere you pass through, not ground
// you can set off from again.
function forcedTiles() {
  const W = MAP.width, out = {};
  for (const e of EVENTS) {
    const p = e.page() || {};
    if (p.trigger !== 1 && p.trigger !== 2) continue;
    let moves = false;
    for (const c of p.list || []) {
      if (c.code === 201 && c.parameters[0] === 0 && c.parameters[1] === $gameMap.mapId()) moves = true;
      if (c.code === 205 && c.parameters[0] === -1) {
        let through = false, shifts = false;
        for (const s of (c.parameters[1] && c.parameters[1].list) || []) {
          if (s.code === 37) through = true;
          if (s.code === 14 || (s.code >= 1 && s.code <= 8)) shifts = true;
        }
        if (through && shifts) moves = true;
      }
    }
    if (moves) out[e._y * W + e._x] = true;
  }
  return out;
}
// stone: entered but never crossed — every tileset in this game leaves its A3/A4 wall block on
// the editor's default passability.
function stoneTiles() {
  const W = MAP.width, H = MAP.height, d = MAP.data, out = new Uint8Array(W * H);
  const kind = t => Math.floor((t - 2048) / 48);
  const isA3 = t => t >= 4352 && t < 5888, isA4 = t => t >= 5888 && t < 8192;
  const isWall = t => (isA4(t) && kind(t) % 16 < 8) || ((isA3(t) || isA4(t)) && kind(t) % 16 >= 8);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    for (let z = 3; z >= 0; z--) {
      const t = d[(z * H + y) * W + x] || 0;
      if ((FLAGS[t] | 0) & 0x10) continue;
      if (isWall(t)) out[y * W + x] = 1;
      break;
    }
  }
  return out;
}
// The crossings a flood may use are the mod's own list: deriving those again here would be
// rewriting warps() rather than checking it, and nav_realmap.js draws the line in the same place.
// What this states independently is how a flood is allowed to USE one — a forced tile is
// somewhere you are carried through, not ground you can walk off again, unless a crossing was
// what put you there.
function reference(sx, sy) {
  const W = MAP.width, H = MAP.height;
  const dist = new Int32Array(W * H).fill(-1);
  const via = new Uint8Array(W * H);
  const start = sy * W + sx, forced = forcedTiles(), stone = stoneTiles();
  const warp = BMA.Nav.warps();
  dist[start] = 0;
  const q = [start];
  const DD = [[0, -1, 8], [0, 1, 2], [1, 0, 6], [-1, 0, 4]];
  for (let i = 0; i < q.length; i++) {
    const c = q[i], cx = c % W, cy = (c - cx) / W;
    const walkable = (!forced[c] || c === start || via[c]) && (!stone[c] || c === start);
    if (walkable) for (const [dx, dy, d] of DD) {
      const nx = cx + dx, ny = cy + dy;
      if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
      const ni = ny * W + nx;
      if (dist[ni] !== -1) continue;
      if (!$gamePlayer.isMapPassable(cx, cy, d)) continue;
      if (EVENTS.some(e => e.pos(nx, ny) && !e._through && e.isNormalPriority())) continue;
      dist[ni] = dist[c] + 1; q.push(ni);
    }
    for (const e of warp.from[c] || []) {
      if (dist[e.to] !== -1) continue;
      dist[e.to] = dist[c] + 1; via[e.to] = 1; q.push(e.to);
    }
  }
  return dist;
}
const count = a => a.reduce((n, v) => n + (v !== -1 ? 1 : 0), 0);

let fails = 0;
const check = (name, cond, extra) => {
  if (cond) console.log('  ok   ' + name);
  else { fails++; console.log('  FAIL ' + name + (extra !== undefined ? '  -> ' + extra : '')); }
};

// The two doors out of the forecourt (map 324) land here. Vahn takes the left one, Vera the right.
const VAHN_IN = [17, 152], VERA_IN = [125, 152];

//---------------------------------------------------------------------------
console.log('=== map 400: the flood over real geometry ===');
//---------------------------------------------------------------------------
loadMap(400);
for (const [who, [ax, ay]] of [['Vahn', VAHN_IN], ['Vera', VERA_IN]]) {
  LEADER = who === 'Vahn' ? 1 : 5;
  standAt(ax, ay);
  const strict = BMA.Nav.flood();
  const ref = reference(ax, ay);
  check(`${who}'s half: the strict flood matches the reference`,
        !strict.failed && count(strict.dist) === count(ref),
        count(strict.dist) + ' vs ' + count(ref));
  check(`${who}'s half: the flood leaves the entrance`, count(strict.dist) > 1, count(strict.dist));
  // Both halves start walled in — that is the puzzle, not a routing failure.
  check(`${who}'s half: the spikes wall it off from the rest of the map`,
        count(strict.dist) < 1000, count(strict.dist));
}

//---------------------------------------------------------------------------
console.log('\n=== map 400: the twelve pressure pads ===');
//---------------------------------------------------------------------------
LEADER = 1;
standAt(VAHN_IN[0], VAHN_IN[1]);
BMA.Nav.scan();
const pads = BMA.Nav.entities.filter(e => /^Pad \d+$/.test(e.name));
check('all twelve pads are listed', pads.length === 12,
      pads.length + ': ' + pads.map(e => e.name).join(', '));
check('and every one is an object, a category the cycle reaches',
      pads.every(e => e.category === 'interactable'),
      [...new Set(pads.map(e => e.category))].join(', '));
// "Lever 3" is the wrong word for something you step on, and the two that carry a conditional
// used to escape that rule and come out "Pad 1" and "Pad 2" beside ten Levers.
check('none of them is called a lever',
      !BMA.Nav.entities.some(e => /^Lever/.test(e.name)),
      BMA.Nav.entities.filter(e => /^Lever/.test(e.name)).map(e => e.name).join(', '));
check('the save points are all found', BMA.Nav.entities.filter(e => e.category === 'savepoint').length === 5);
check('and the chests are too', BMA.Nav.entities.filter(e => e.category === 'treasure').length === 32);

//---------------------------------------------------------------------------
console.log('\n=== map 400: the spike walls, and what opens them ===');
//---------------------------------------------------------------------------
const gates = BMA.Nav.gates().byTile;
const gateTiles = Object.keys(gates);
check('the spike walls are recognised as gates', gateTiles.length === 64, gateTiles.length);
check('and every one of them names an opener',
      gateTiles.every(k => gates[k].openers.length > 0),
      gateTiles.filter(k => !gates[k].openers.length).join(' '));

// The wall in Vahn's way, and the pad that lifts it. Switch 732 is "Vahn Spikes 1" and the pad
// that throws it stands at (101,136) — 84 steps east, in the half only Vera can walk.
const WALL = '46,113';
check('the first wall in Vahn\'s way is a gate', !!gates[WALL], Object.keys(gates).slice(0, 3));
if (gates[WALL]) {
  const hint = BMA.Nav._gateHint(gates[WALL]);
  check('the hint names the pad that opens it', /It opens from Pad \d+/.test(hint), hint);
  check('and says the other party has to reach it',
        /other party has to reach it/.test(hint), hint);
  // The whole point: from here there is no route to that pad at all.
  const opener = gates[WALL].openers[0];
  check('because there is genuinely no route to it from here',
        BMA.Nav._goalIndex(opener.x, opener.y, false) === -1,
        opener.x + ',' + opener.y);
}

//---------------------------------------------------------------------------
console.log('\n=== map 400: which party you are steering ===');
//---------------------------------------------------------------------------
check('the map is recognised as one that swaps parties', BMA.Nav.hasPartySwap() === true);

const spoken = [];
const _speak = BMA.Speech.speak;
BMA.Speech.speak = s => spoken.push(String(s));

BMA.Nav._lastParty = null;
LEADER = 1;
BMA.Nav.announceParty();
check('arriving says whose party you have, and names the keys',
      spoken.length === 1 && /^Vahn's party\./.test(spoken[0]) && /Page Up/.test(spoken[0]),
      JSON.stringify(spoken));

spoken.length = 0;
BMA.Nav.announceParty();
check('asking again with nothing changed stays silent', spoken.length === 0, JSON.stringify(spoken));

spoken.length = 0;
LEADER = 5;                                    // Page Down: now steering Vera
standAt(VERA_IN[0], VERA_IN[1]);
BMA.Nav.announceParty();
check('the swap announces the party you now have, and where it put you',
      spoken.length === 1 && /^Vera's party\./.test(spoken[0]) &&
      spoken[0].indexOf('Position ' + VERA_IN[0] + ', ' + VERA_IN[1]) >= 0,
      JSON.stringify(spoken));

spoken.length = 0;
LEADER = 1;
standAt(VAHN_IN[0], VAHN_IN[1]);
BMA.Nav.announceParty();
check('and swapping back says so', spoken.length === 1 && /^Vahn's party\./.test(spoken[0]),
      JSON.stringify(spoken));

//---------------------------------------------------------------------------
console.log('\n=== map 400: where the other half is standing ===');
//---------------------------------------------------------------------------
const markers = BMA.Nav.partyMarkers();
check('the switcher\'s two marker events are read off its script',
      markers[30] && markers[30].actorId === 1 && markers[31] && markers[31].actorId === 5,
      JSON.stringify(markers));
check('including the tiles it parks them on',
      markers[30] && markers[30].parkX === 51 && markers[30].parkY === 153 &&
      markers[31] && markers[31].parkX === 52 && markers[31].parkY === 153,
      JSON.stringify(markers));

// Before the first swap both are parked, and a parked marker stands in for nobody.
LEADER = 1;
standAt(VAHN_IN[0], VAHN_IN[1]);
BMA.Nav.scannedMap = null; BMA.Nav.entities = []; BMA.Nav.scan();
check('parked markers are not announced as anybody',
      !BMA.Nav.entities.some(e => /'s party$/.test(e.name)),
      BMA.Nav.entities.filter(e => /'s party$/.test(e.name)).map(e => e.name).join(', '));

// After a swap the switcher plants Vahn's marker on the tile it took you off.
const dummyVahn = EVENTS.find(e => e.eventId() === 30);
dummyVahn._x = dummyVahn.x = 46; dummyVahn._y = dummyVahn.y = 112;
LEADER = 5;
resetNav();
standAt(VERA_IN[0], VERA_IN[1]);
BMA.Nav.scan();
const other = BMA.Nav.entities.filter(e => /'s party$/.test(e.name));
check('the marker for the half you are not steering is named after them',
      other.length === 1 && other[0].name === "Vahn's party" &&
      other[0].x === 46 && other[0].y === 112,
      JSON.stringify(other.map(e => e.name + '@' + e.x + ',' + e.y)));
check('so a route blocked by them says who it is, not "Dummy Vahn"',
      BMA.Nav._nameAt(46, 112) === "Vahn's party", BMA.Nav._nameAt(46, 112));
// Your own marker is the one that is parked; naming it would be a lie about where you are.
LEADER = 1;
resetNav();
standAt(VAHN_IN[0], VAHN_IN[1]);
BMA.Nav.scan();
check('and your own marker is never named at you',
      !BMA.Nav.entities.some(e => e.name === "Vahn's party"),
      BMA.Nav.entities.filter(e => /'s party$/.test(e.name)).map(e => e.name).join(', '));

//---------------------------------------------------------------------------
console.log('\n=== map 324: the forecourt where the party is split ===');
//---------------------------------------------------------------------------
// The forecourt only exists once the story has sent you for the leystones, and four of the
// fourteen only stand in the line-up if they were recruited — Adder, Bosche, Brindle and Lyric,
// each behind their own "Joins" switch. On a fresh save every page here is blank, so this is the
// state the scene is actually played in.
ON = new Set([710, 471, 611, 407, 614]);
loadMap(324);
LEADER = 1;
standAt(8, 10);
BMA.Nav.scan();
const people = BMA.Nav.entities.filter(e => e.category === 'npc').map(e => e.name);
// Every one of these ends by fading out and dropping you back at the door, which used to file
// them as crossings — hidden from "all" and from the NPC list at once.
for (const who of ['Darius', 'Adder', 'Ami', 'Oalston', 'Elina', 'Nobumasa', 'Bosche',
                   'Siegfried', 'Laka', 'Jasmine', 'Brindle', 'Lyric']) {
  check(who + ' is somebody you can find in the NPC list', people.indexOf(who) >= 0, people.join(', '));
}
check('and none of them is a crossing any more',
      BMA.Nav.entities.filter(e => e.category === 'crossing').length === 0,
      BMA.Nav.entities.filter(e => e.category === 'crossing').map(e => e.name).join(', '));
check('the forecourt is not mistaken for a party-swap map', BMA.Nav.hasPartySwap() === false);

//---------------------------------------------------------------------------
console.log('\n=== map 180: the Overworld\'s dropped items ===');
//---------------------------------------------------------------------------
loadMap(180);
LEADER = 1;
standAt(71, 61);
BMA.Nav.scan();
const items = BMA.Nav.entities.filter(e => /^Item \d+$/.test(e.name));
check('the dropped items are in the treasure list', items.length === 49, items.length);
check('all of them, as treasure', items.every(e => e.category === 'treasure'));
check('and the Overworld has no anonymous NPCs left',
      !BMA.Nav.entities.some(e => /^NPC \d+$/.test(e.name)),
      BMA.Nav.entities.filter(e => /^NPC \d+$/.test(e.name)).length);
check('an ordinary map is not a party-swap map', BMA.Nav.hasPartySwap() === false);

BMA.Speech.speak = _speak;
console.log(fails ? `\n${fails} CHECK(S) FAILED` : '\nall checks passed');
process.exit(fails ? 1 : 0);
