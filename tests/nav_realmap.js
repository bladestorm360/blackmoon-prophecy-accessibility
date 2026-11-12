// Run the SHIPPING flood against real game map data, with a faithful MV passability stub.
//
// The unit tests use a hand-made 8x6 fixture, which cannot catch a bug that only shows on real
// geometry. This drives BMA.Nav.flood/_goalIndex/reachable over an actual map and compares them
// against an independent reference BFS, so a disagreement is a bug in the mod rather than in a
// mock.
const fs = require('fs'), path = require('path'), vm = require('vm');
const { SRC, DATA, requireGame, installTilemap, installedMapPassage } = require('./_paths');
installTilemap();
requireGame('nav_realmap.js');

const TILESETS = JSON.parse(fs.readFileSync(path.join(DATA, 'Tilesets.json'), 'utf8'));

global.window = global;
global.document = { addEventListener() {} };
global.require = require;
global.performance = { now: () => 0 };
global.$dataMapInfos = JSON.parse(fs.readFileSync(path.join(DATA, 'MapInfos.json'), 'utf8'));
global.$dataActors = JSON.parse(fs.readFileSync(path.join(DATA, 'Actors.json'), 'utf8'));
global.$dataCommonEvents = JSON.parse(fs.readFileSync(path.join(DATA, 'CommonEvents.json'), 'utf8'));
// shopKindOf reads an armour's equip slot to tell a relic shop from an armour shop.
global.$dataArmors = JSON.parse(fs.readFileSync(path.join(DATA, 'Armors.json'), 'utf8'));
global.$dataSystem = JSON.parse(fs.readFileSync(path.join(DATA, 'System.json'), 'utf8'));
// _isRank rejects class names so a house is never named after a rank.
global.$dataClasses = JSON.parse(fs.readFileSync(path.join(DATA, 'Classes.json'), 'utf8'));
global.$gameVariables = { value: () => 0 };
global.$gameActors = { actor: () => null };
global.$gameParty = { members: () => [] };

// ---- MV passability, faithful ----
//
// checkPassage walks layers 3..0; a flag with 0x10 (star) is skipped, otherwise the first layer
// that has an opinion decides. flags[] can be SHORTER than 8192 in this game's data, and MV reads
// the hole as 0 = passable — `| 0` reproduces that exactly. Do not "harden" it.
const BIT = { 2: 0x01, 4: 0x02, 6: 0x04, 8: 0x08 };
const REV = { 2: 8, 8: 2, 4: 6, 6: 4 };
let MAP = null, FLAGS = null, EVENTS = [];
// 17 of this game's maps set a looping scrollType, and the engine wraps every neighbour lookup
// through roundXWithDirection. The stub has to do it too or the mod's loop handling is being
// tested against a map that does not actually loop.
let LOOPH = false, LOOPV = false;
const modn = (a, n) => ((a % n) + n) % n;
const roundX = x => (LOOPH ? modn(x, MAP.width) : x);
const roundY = y => (LOOPV ? modn(y, MAP.height) : y);

const checkPassage = installedMapPassage(() => FLAGS);
function xWith(x, d) { return roundX(x + (d === 6 ? 1 : d === 4 ? -1 : 0)); }
function yWith(y, d) { return roundY(y + (d === 2 ? 1 : d === 8 ? -1 : 0)); }

global.$gameMap = {
  mapId: () => 34,
  width: () => MAP.width,
  height: () => MAP.height,
  displayName: () => MAP.displayName || '',
  isValid(x, y) { return x >= 0 && y >= 0 && x < MAP.width && y < MAP.height; },
  isLoopHorizontal: () => LOOPH,
  isLoopVertical: () => LOOPV,
  roundX, roundY,
  isPassable(x, y, d) { return checkPassage(x, y, BIT[d]); },
  // _wallGround() reads the map the same way checkPassage does, so the stub has to expose the
  // engine's two accessors as well as the derived isPassable.
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
  x: 0, y: 0, direction: () => 2,
  isThrough: () => false,
  isMapPassable(x, y, d) {
    const x2 = xWith(x, d), y2 = yWith(y, d);
    return $gameMap.isPassable(x, y, d) && $gameMap.isPassable(x2, y2, REV[d]);
  },
  isCollidedWithCharacters(x, y) {
    return $gameMap.eventsXyNt(x, y).some(e => e.isNormalPriority());
  },
  canPass(x, y, d) {
    const x2 = xWith(x, d), y2 = yWith(y, d);
    if (!$gameMap.isValid(x2, y2)) return false;
    if (this.isThrough()) return true;
    if (!this.isMapPassable(x, y, d)) return false;
    if (this.isCollidedWithCharacters(x2, y2)) return false;
    return true;
  },
};

for (const f of ['BMA_Core.js', 'BMA_Text.js', 'BMA_Menus.js', 'BMA_Nav.js']) {
  vm.runInThisContext(fs.readFileSync(path.join(SRC, f), 'utf8'), { filename: f });
}
// MapNames derives the data directory from this, and DoorPeek reads map files through it.
BMA.TTS.modDir = path.join(DATA, '..', 'mod');

let fails = 0;
const check = (name, cond, extra) => {
  if (cond) console.log('  ok   ' + name);
  else { fails++; console.log('  FAIL ' + name + (extra !== undefined ? '  -> ' + extra : '')); }
};

// Which page MV would actually run, on a fresh game with every switch off: the HIGHEST-indexed
// page whose conditions are met. Page 0 is not automatically the live one -- Conall Curach's
// shortcut moogles have a single page gated on "Conall Curach Done", so on a first visit they
// have no valid page at all and must not contribute anything to navigation.
let SWITCHES_ON = false;                 // flip to model a later save, where story flags are set
// Or name the ones that are on. Life Shrine's clock is a bank of fifteen switches that step
// through the puzzle one stage at a time, and all-or-nothing cannot model a stage: with every
// switch set, each numeral falls through to its spent page, which has no graphic and no
// commands, and the clock face disappears entirely.
let SWITCH_SET = null;
const switchOn = id => (SWITCH_SET ? SWITCH_SET.has(id) : SWITCHES_ON);
function meetsConditions(page) {
  const c = page.conditions;
  if (!c) return true;
  if (c.switch1Valid && !switchOn(c.switch1Id)) return false;
  if (c.switch2Valid && !switchOn(c.switch2Id)) return false;
  if (c.selfSwitchValid) return false;
  if (c.variableValid && c.variableValue > 0) return false;
  if (c.itemValid || c.actorValid) return false;
  return true;
}
function activePage(ev) {
  for (let i = ev.pages.length - 1; i >= 0; i--) {
    if (meetsConditions(ev.pages[i])) return ev.pages[i];
  }
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
}

// Tiles that move the player the instant they arrive: a touch-triggered transfer landing back on
// this map, or a touch-triggered move route that carries them with Through on. Walking out of one
// is not something a player can do — Aether Mine's two portals face each other, so a route that
// walked off the landing tile was warped straight back and reissued the same instruction forever.
//
// Derived here from the raw event data rather than by asking BMA.Nav.warps(), so this stays an
// independent statement of the rule instead of a copy of the mod's answer.
function forcedTiles() {
  const W = MAP.width, out = {};
  // The census uses the default switch state. These approach tiles change that state,
  // so the walk to one of them ends the current route through Cleft of Wind.
  const mapId = $gameMap.mapId();
  if (mapId === 549) for (const x of [21, 22, 23]) out[29 * W + x] = true;
  if (mapId === 550) for (const x of [7, 8]) out[10 * W + x] = true;
  for (const e of EVENTS) {
    const p = e.page() || {};
    if (p.trigger !== 1 && p.trigger !== 2) continue;
    let moves = false;
    for (const c of p.list || []) {
      if (c.code === 201 && c.parameters[0] === 0) {
        if (c.parameters[1] === $gameMap.mapId() || (p.priorityType !== 1 && c.indent === 0)) moves = true;
      }
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

// Independent reference BFS — same rules, written separately from the mod.
// The stone a map is built out of, worked out here rather than borrowed from the mod so this
// stays an independent check. Every tileset in this game leaves its A4 block on the editor's
// default passability, so walls are walkable ground as far as the engine is concerned; the strict
// flood treats them as terrain you can step onto and not cross. The relaxed one still walks them,
// so this mirrors that and is applied only to the strict reference.
function stoneTiles() {
  const W = MAP.width, H = MAP.height, d = MAP.data, out = new Uint8Array(W * H);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    for (let z = 3; z >= 0; z--) {
      const t = d[(z * H + y) * W + x] || 0;
      if ((FLAGS[t] | 0) & 0x10) continue;
      if (Tilemap.isWallTile(t)) out[y * W + x] = 1;
      break;
    }
  }
  return out;
}

function reference(sx, sy, ignoreEvents) {
  const W = MAP.width, H = MAP.height;
  const dist = new Int32Array(W * H).fill(-1);
  const start = sy * W + sx;
  const forced = forcedTiles();
  const stone = ignoreEvents ? null : stoneTiles();
  dist[start] = 0;
  const q = [start];
  const DD = [[0, -1, 8], [0, 1, 2], [1, 0, 6], [-1, 0, 4]];
  for (let i = 0; i < q.length; i++) {
    const c = q[i], cx = c % W, cy = (c - cx) / W;
    if (forced[c] && c !== start) continue;      // arriving here is being moved somewhere else
    if (stone && stone[c] && c !== start) continue;   // somewhere to stand, nowhere to go from
    for (const [dx, dy, d] of DD) {
      const nx = roundX(cx + dx), ny = roundY(cy + dy);
      if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
      const ni = ny * W + nx;
      if (dist[ni] !== -1) continue;
      if (!$gamePlayer.isMapPassable(cx, cy, d)) continue;
      if (!ignoreEvents && EVENTS.some(e => e.pos(nx, ny) && !e._through && e.isNormalPriority())) continue;
      dist[ni] = dist[c] + 1; q.push(ni);
    }
  }
  return dist;
}
const count = a => a.reduce((n, v) => n + (v !== -1 ? 1 : 0), 0);

// Reference approach rule, mirroring _goalIndex: the entity's own tile, any of its 8 neighbours,
// or -- as MV's checkEventTriggerThere allows -- the tile two straight steps out across a counter.
function refReach(dist, x, y) {
  const W = MAP.width, H = MAP.height;
  for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
    const nx = roundX(x + dx), ny = roundY(y + dy);
    if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
    if (dist[ny * W + nx] !== -1) return true;
  }
  for (const [dx, dy] of [[0, -1], [0, 1], [1, 0], [-1, 0]]) {
    if (!$gameMap.isCounter(roundX(x + dx), roundY(y + dy))) continue;
    const nx = roundX(x + 2 * dx), ny = roundY(y + 2 * dy);
    if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
    if (dist[ny * W + nx] !== -1) return true;
  }
  return false;
}

console.log('\n=== map 34 "Valla Interiors": shipping flood vs reference ===');
loadMap(34);
// The seven doors from Valla land here; each is its own walled room.
const ARRIVALS = [[13, 15], [41, 15], [65, 15], [83, 15], [101, 15], [123, 15], [148, 15]];

for (const [ax, ay] of ARRIVALS) {
  $gamePlayer.x = ax; $gamePlayer.y = ay;
  BMA.Nav._clearFloods();
  BMA.Nav.scannedMap = 34;                       // skip scan(); we set entities by hand below
  BMA.Nav.entities = [];

  const strict = BMA.Nav.flood(), relaxed = BMA.Nav.flood(true);
  const refS = reference(ax, ay, false), refR = reference(ax, ay, true);
  const ns = count(strict.dist), nr = count(relaxed.dist);

  check(`(${ax},${ay}) strict flood matches the reference`,
        !strict.failed && ns === count(refS), ns + ' vs ' + count(refS));
  check(`(${ax},${ay}) relaxed flood matches the reference`,
        !relaxed.failed && nr === count(refR), nr + ' vs ' + count(refR));
  check(`(${ax},${ay}) the flood leaves the start tile`, ns > 1, ns);

  // Every event whose own tile or an approach tile the reference says is reachable must be
  // reported reachable by the mod. This is the actual reported bug, stated as an assertion.
  const disagree = [];
  for (const ev of EVENTS) {
    const want = refReach(refR, ev.x, ev.y);
    const got = BMA.Nav.reachable({ x: ev.x, y: ev.y });
    if (want !== got) disagree.push(`${ev.eventId()}@${ev.x},${ev.y} want=${want} got=${got}`);
  }
  check(`(${ax},${ay}) reachable() agrees with the reference for all ${EVENTS.length} events`,
        disagree.length === 0, disagree.slice(0, 6).join('  '));
}

// ---- the Valla inn: the reported bug, as a named case ----
//
// Event 17 "Marcel" at (42,10) on map 34 is the Valla innkeeper -- his page carries Recover All
// plus Change Gold, which is what an inn is. He stands behind a service counter, so his own tile
// and all eight neighbours are outside the room's flood: before the across-a-counter rule he was
// reported unreachable, which is exactly "I walked into the inn and nothing has a valid path".
console.log('\n=== map 34: the Valla innkeeper behind his counter ===');
loadMap(34);
{
  $gamePlayer.x = 41; $gamePlayer.y = 15;                 // the door Valla's inn leads to
  BMA.Nav._clearFloods();
  BMA.Nav.scannedMap = 34; BMA.Nav.entities = [];
  const f = BMA.Nav.flood(true), W = MAP.width;
  const at = (x, y) => f.dist[y * W + x] !== -1;

  check('Marcel is walled off from the room by tiles', !at(42, 10));
  let anyNeighbour = false;
  for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++)
    if ((dx || dy) && at(42 + dx, 10 + dy)) anyNeighbour = true;
  check('and none of his 8 neighbours are reachable either', !anyNeighbour);
  check('there is a counter directly south of him', $gameMap.isCounter(42, 11) === true);
  check('and the tile beyond it is somewhere you can stand', at(42, 12));
  check('so the counter rule reaches him', BMA.Nav.reachable({ x: 42, y: 10 }) === true);
  check('standing two straight steps out, as the engine requires',
        BMA.Nav._goalIndex(42, 10, true) === 12 * W + 42,
        BMA.Nav._goalIndex(42, 10, true));
}

// ---- the scan path ----
//
// Everything above feeds _goalIndex raw event coordinates. The mod feeds it records built by
// scan() -> classify() -> _makeRecord(), so a coordinate that goes astray in there would produce
// exactly "a reachable thing reported unreachable" while the flood itself stays perfect.
console.log('\n=== map 34: entities as scan() actually builds them ===');
loadMap(34);
{
  $gamePlayer.x = 13; $gamePlayer.y = 15;                 // the first interior room
  BMA.Nav.scannedMap = null;
  BMA.Nav._clearFloods();
  BMA.Nav.scan();

  check('scan produced entities', BMA.Nav.entities.length > 0, BMA.Nav.entities.length);
  check('and marked the map scanned (i.e. did not throw)', BMA.Nav.scannedMap === 34,
        BMA.Nav.scannedMap);

  const bad = BMA.Nav.entities.filter(e =>
    !Number.isInteger(e.x) || !Number.isInteger(e.y) ||
    e.x < 0 || e.y < 0 || e.x >= MAP.width || e.y >= MAP.height);
  check('every entity has in-range integer coordinates', bad.length === 0,
        JSON.stringify(bad.slice(0, 4)));

  // Each scanned entity must sit on an event that really is at those coordinates.
  const mismatched = BMA.Nav.entities.filter(e => !EVENTS.some(v => v.x === e.x && v.y === e.y));
  check('every entity sits on a real event tile', mismatched.length === 0,
        JSON.stringify(mismatched.slice(0, 4).map(e => e.name + '@' + e.x + ',' + e.y)));

  const refR = reference(13, 15, true);
  const wrong = BMA.Nav.entities.filter(e =>
    refReach(refR, e.x, e.y) !== BMA.Nav.reachable(e));
  check('reachable() agrees with the reference for every scanned entity', wrong.length === 0,
        JSON.stringify(wrong.slice(0, 4).map(e => e.name + '@' + e.x + ',' + e.y)));

  const inRoom = BMA.Nav.entities.filter(e => refReach(refR, e.x, e.y));
  console.log('       ' + BMA.Nav.entities.length + ' entities scanned, ' + inRoom.length +
              ' reachable from the (13,15) room: ' +
              inRoom.map(e => e.name + '@' + e.x + ',' + e.y).join(', '));
}

// ---- door labels ----
//
// Seven doors in Valla all announced "To Valla Interiors". These are the labels the shipping
// DoorPeek produces for them, checked against what is actually in each room.
console.log('\n=== Valla doors: what the label says ===');

{
  // Through the real path: _exitKind names each door, then _disambiguateDoors decides whether
  // the destination name can tell them apart and looks inside only when it cannot.
  const valla = JSON.parse(fs.readFileSync(path.join(DATA, 'Map020.json'), 'utf8'));
  const ents = [];
  for (const ev of valla.events.filter(Boolean)) {
    const p = ev.pages[0]; if (!p) continue;
    const t = (p.list || []).find(c => c.code === 201);
    if (!t || t.parameters[0] !== 0) continue;
    ents.push({ x: ev.x, y: ev.y, category: 'exit', ev: { page: () => p },
                name: BMA.Nav._exitKind(p.list) });
  }
  $gameMap.mapId = () => 20;
  BMA.Nav.entities = ents;
  BMA.Nav._arrival = { mapId: 20, x: 23, y: 36 };
  BMA.Nav._disambiguateDoors();
  const got = {};
  for (const e of ents) {
    got[e.x + ',' + e.y] = e.name;
    console.log('       door@' + (e.x + ',' + e.y).padEnd(7) + '  "' + e.name + '"');
  }
  check('the weapon shop is named', got['31,13'] === 'Weapon shop', got['31,13']);
  check('the armor shop is named', got['35,28'] === 'Armor shop', got['35,28']);
  // Sells two etypeId-5 armours, and this game calls slot 5 "Relic" -- so it is a relic shop,
  // not the second armour shop it used to read as.
  check('the relic shop is told apart from the armor shop',
        got['34,36'] === 'Relic shop', got['34,36']);
  check('the item shop is named', got['7,33'] === 'Item shop', got['7,33']);
  check('the inn is named', got['23,30'] === 'Inn', got['23,30']);
  check('a resident names their own house, contents and all',
        got['8,12'] === "Elise's house, 1 chest", got['8,12']);
  check('and so does the elder', /^Elder Maxim's house/.test(got['41,14'] || ''), got['41,14']);
  // Every one of these is behind a service counter, so without the across-a-counter approach
  // they all read as "Empty house" -- which is what the first sweep over this data reported.
  check('none of Valla is mistaken for empty',
        !Object.values(got).some(v => v === 'Empty house'), JSON.stringify(got));
  // The one door out of town keeps its destination name: it is the only one going there, so the
  // name already tells them apart and looking inside would only make it worse.
  check('the door out of town keeps its destination name',
        got['0,26'] === 'To Overworld', got['0,26']);

  // An actually-empty room, from elsewhere: Overworld door@35,120 lands at map 49 (21,5).
  check('a genuinely empty room says so', BMA.DoorPeek.label(49, 21, 5) === 'Empty house',
        BMA.DoorPeek.label(49, 21, 5));
}

// ---- what a room is for beats who is standing in it ----
//
// The Hunter runs this game's Marks board (Galv_QuestLog, pushed from the event rather than from
// a menu). Reading the room as "Hunter's house" was wrong twice over: it is not a house, and it
// is not his. The same twelve rooms exist in twelve towns and every one of them said it.
console.log('\n=== a service names its own room ===');
{
  check('the marks board is named for what it does',
        BMA.DoorPeek.label(70, 8, 11) === 'Marks board', BMA.DoorPeek.label(70, 8, 11));
  // And the rule has to stay narrow: an ordinary resident still names their own house.
  check('a resident still names their house',
        BMA.DoorPeek.label(34, 8, 12) === "Elise's house, 1 chest",
        BMA.DoorPeek.label(34, 8, 12));
}

// ---- a castle's rooms are not houses ----
//
// The reported bug: eleven doors in Tomra Castle all read "To Tomra Castle, door 1..11", hiding
// three shops, an inn, a save point and the way to the throne room. The destination map is named
// after the castle it is inside, so it is not "vague" and the peek never ran.
//
// The other half is that the peek must not run *unsupervised* here. Its contents test names a
// room after whoever is standing in it, which is right in a town and wrong in a castle: the
// general outside the throne room is not a resident and the hall is not his house.
console.log('\n=== a castle is not a dungeon, and not a town either ===');
{
  const N = (src, dest) => BMA.DoorPeek.namesNothing(src, dest);
  check('a destination named after the map you are on distinguishes nothing',
        N(258, 281) === true);
  check('and Branch Castle is untouched by that rule',
        [11, 12, 13].every(id => N(2, id) === false),
        [11, 12, 13].map(id => id + ':' + N(2, id)).join(' '));

  check('Tomra names its throne approach', BMA.DoorPeek.label(281, 221, 15) === 'Throne approach',
        BMA.DoorPeek.label(281, 221, 15));
  check('and its training hall, save point and all',
        BMA.DoorPeek.label(281, 126, 14) === 'Training hall, save point',
        BMA.DoorPeek.label(281, 126, 14));
  check('and its marks board', BMA.DoorPeek.label(281, 192, 14) === 'Marks board',
        BMA.DoorPeek.label(281, 192, 14));

  // Cid stands in a room inside Lindblum Castle. "Cid's house" is a guess about a room that is
  // not a house — say nothing and let the door keep its number, which is at least honest.
  check('no room inside a castle is called somebody\'s house',
        !/'s house|^House,|^Empty house/.test(BMA.DoorPeek.label(206, 56, 16)),
        BMA.DoorPeek.label(206, 56, 16));
  check('a castle is recognised through its parent chain', BMA.DoorPeek.isCastle(206) === true);
  check('and an ordinary town is not', BMA.DoorPeek.isCastle(34) === false);

  // The ownership claim is the only thing dropped. Faluhd is a ruin held by monsters with no
  // householders at all, and its chambers are worth finding — the chest counts are counted off
  // the commands, not guessed, so they stay.
  check('a castle room keeps its contents and loses the owner',
        BMA.DoorPeek.label(118, 202, 59) === 'Room, 10 chests',
        BMA.DoorPeek.label(118, 202, 59));
  // Straight at the phrasing, so it does not depend on finding a room that happens to be empty
  // and under the 400-tile cap.
  const bare = { shop: {}, shops: 0, inn: 0, save: 0, chest: 0, named: [], people: 0, service: '' };
  check('an empty castle room says so without calling itself a house',
        BMA.DoorPeek._phrase(bare, true) === 'Empty room',
        BMA.DoorPeek._phrase(bare, true));
  check('and an empty room in a town is still a house',
        BMA.DoorPeek._phrase(bare, false) === 'Empty house',
        BMA.DoorPeek._phrase(bare, false));

  // Rooms only a person could identify, from the room table.
  check('the Citadel kitchen', BMA.DoorPeek.label(364, 148, 52) === 'Kitchen',
        BMA.DoorPeek.label(364, 148, 52));          // "I've got some hungry bellies to feed!"
  check('the Citadel scholars\' room', BMA.DoorPeek.label(364, 79, 51) === "Scholars' room",
        BMA.DoorPeek.label(364, 79, 51));
  check('Lenadia\'s records room, save point and all',
        BMA.DoorPeek.label(166, 46, 23) === 'Records room, save point',
        BMA.DoorPeek.label(166, 46, 23));           // "I need to alphabetize ... our records"
  check('Lenadia\'s infirmary', BMA.DoorPeek.label(166, 72, 23) === 'Infirmary',
        BMA.DoorPeek.label(166, 72, 23));

  // The whole rule, stated once, over every door in every castle in the game: nothing a castle
  // door leads to is ever described as somebody's house. Judged on where the door LANDS — a door
  // out of Lenadia Castle into Lenadia City lands in a real townhouse, and that one is right.
  const CASTLES = [118, 125, 166, 194, 206, 207, 258, 281, 364, 440, 467, 500, 544, 546];
  const owned = [];
  for (const id of CASTLES) {
    const f = path.join(DATA, 'Map' + String(id).padStart(3, '0') + '.json');
    if (!fs.existsSync(f)) continue;
    const m = JSON.parse(fs.readFileSync(f, 'utf8'));
    for (const ev of m.events.filter(Boolean)) {
      for (const p of ev.pages || []) {
        const t = (p.list || []).find(c => c.code === 201 && c.parameters[0] === 0);
        if (!t) continue;
        const dest = t.parameters[1];
        if (!BMA.DoorPeek.isCastle(dest)) break;     // leads out of the castle; not our rule
        const lab = BMA.DoorPeek.label(dest, t.parameters[2], t.parameters[3]);
        if (lab && /'s house|^House(,|$)|^Empty house/.test(lab)) owned.push(id + '->' + dest + ': ' + lab);
        break;
      }
    }
  }
  check('no room in any castle is called somebody\'s house', owned.length === 0,
        owned.slice(0, 5).join(' | '));
}

// ---- a wide doorway is one way through, not seven ----
//
// Every tile of a wide arch carries its own Transfer and they all land on the same destination
// tile. Numbering them invented choices that do not exist: Branch Castle's way into Darius
// Training is seven tiles of one entrance, and Lindblum Castle's front gate is seven of another.
console.log('\n=== a wide doorway is one doorway ===');
{
  // Same path as the Valla block above: real _exitKind names, then _disambiguateDoors decides.
  const names = id => {
    const m = JSON.parse(fs.readFileSync(
      path.join(DATA, 'Map' + String(id).padStart(3, '0') + '.json'), 'utf8'));
    const ents = [];
    for (const ev of m.events.filter(Boolean)) {
      const p = ev.pages[0]; if (!p) continue;
      const t = (p.list || []).find(c => c.code === 201);
      if (!t || t.parameters[0] !== 0 || t.parameters[1] === id) continue;
      ents.push({ x: ev.x, y: ev.y, category: 'exit',
                  ev: { page: () => p, event: () => ev, eventId: () => ev.id },
                  name: BMA.Nav._exitKind(p.list) });
    }
    $gameMap.mapId = () => id;
    BMA.Nav.entities = ents;
    BMA.Nav._arrival = { mapId: id, x: ents.length ? ents[0].x : 0, y: ents.length ? ents[0].y : 0 };
    BMA.Nav._disambiguateDoors();
    return ents.map(e => e.name);
  };
  const branch = names(2);
  check('seven tiles of one arch are not seven doors',
        branch.filter(n => /^To Darius Training/.test(n)).every(n => n === 'To Darius Training'),
        branch.filter(n => /Darius/.test(n)).join(', '));
  // ...but two doors that really do land in different places keep their numbers.
  check('two real doors are still told apart',
        new Set(branch.filter(n => /^To Quarters/.test(n))).size === 2,
        branch.filter(n => /Quarters/.test(n)).join(', '));
  check('and so are the two into the Hall',
        new Set(branch.filter(n => /^To Hall/.test(n))).size === 2,
        branch.filter(n => /Hall/.test(n)).join(', '));
  const lind = names(194);
  check('Lindblum\'s front gate is one exit',
        lind.filter(n => /^To Overworld/.test(n)).every(n => n === 'To Overworld'),
        lind.filter(n => /Overworld/.test(n)).join(', '));
}

// ---- a destination with a real name is never described by its contents ----
//
// Branch Castle's doors read "To Darius Training", "To Quarters", "To Hall", "To Throne
// Approach". Those say more than anything we could work out by looking inside, and replacing
// them with "Empty house" and "General Ricard's house" threw away the useful part. Only a
// placeholder destination name ("Interiors") earns a peek.
console.log('\n=== a named destination keeps its name ===');
{
  const V = id => BMA.DoorPeek.isVagueDestination(id);
  const byName = re => { for (let i = 1; i < $dataMapInfos.length; i++)
    if (re.test((($dataMapInfos[i] || {}).name || ''))) return i; return -1; };
  check('"Interiors" is a placeholder', V(34) === true);
  for (const n of ['Quarters', 'Hall', 'Darius Training', 'Throne Approach', 'Library']) {
    const id = byName(new RegExp('^' + n + '$', 'i'));
    if (id > 0) check('"' + n + '" is a real name and is left alone', V(id) === false, id);
  }
  check('a map the game names on screen is left alone', V(20) === false);   // Valla
}

// ---- houses belong to settlements; dungeons only want numbering ----
//
// These are two separate rules and crossing them filled a water shrine with houses. A dungeon's
// side rooms get numbered; only a town or castle gets somebody's name on the door.
console.log('\n=== settlement vs dungeon ===');
{
  const named = id => (($dataMapInfos[id] || {}).name || '');
  const S = (src, dest) => BMA.DoorPeek.isSettlement(src, dest);
  // Water Shrine (21) and its own sub-map (22) — the reported case.
  check('a shrine is not a settlement', S(21, 22) === false, named(21));
  check('nor is its inner map', S(22, 21) === false, named(22));
  check('a castle is', S(2, 3) === true, named(2));
  // Map 32 is a castle whose editor chain reads "Branch Castle / Dungeon Flashback / Library /
  // ...". Testing the whole chain at once let a sibling folder veto a genuine castle.
  check('and a castle whose ancestry mentions a dungeon still is', S(32, 3) === true, named(32));
  // Valla says neither; the trade behind its doors settles it.
  check('a proper-noun town qualifies on its commerce', S(20, 34) === true, named(20));
  // "Citadel Chocobo Forest" contains a settlement word AND a dungeon word.
  let mixed = -1;
  for (let i = 1; i < $dataMapInfos.length; i++)
    if (/citadel chocobo forest/i.test(named(i))) { mixed = i; break; }
  if (mixed > 0) check('a dungeon word beats a settlement word in the same name',
                       S(mixed, 34) === false, named(mixed));
}

// ---- a rank is not a name ----
console.log('\n=== rank filter ===');
{
  const R = n => BMA.DoorPeek._isRank(n);
  check('a class name is a rank', R('Dragoon') && R('Red Mage'));
  check('a generic role is a rank', R('Soldier') && R('Guard') && R('Villager') && R('Blacksmith'));
  check('case does not matter', R('dragoon') && R('SOLDIER'));
  check('a real name is not', !R('Elise') && !R('Mozme') && !R('Choco-Bob') && !R('Laka'));
  check('a title with a name attached is not', !R('Elder Maxim'));
}

// ---- sweep every map ----
//
// The room-by-room checks above only prove map 34. Sweep the whole game so a disagreement between
// the shipping flood and an independently written reference cannot hide on some map nobody thought
// to test. This is the check that would catch "genuinely reachable entity reported unreachable".
//
// The reference walks and only walks. The shipping flood also crosses warp edges — the jump
// routes and same-map transfers that carry the player over terrain they cannot step on — so the
// two are no longer expected to agree exactly. The invariant that survives is one-directional
// and is the one worth holding: **a warp can only ever add reachability, never remove it.**
// So the reference is a floor. Anything the reference can walk to, the mod must report; anything
// extra the mod reports is a warp doing its job, and the map 123 block below pins those numbers
// exactly rather than leaving "extra" unbounded.
console.log('\n=== all maps: shipping flood vs reference (reference is a floor) ===');
{
  let maps = 0, floodBad = [], reachBad = [], collapsed = [];
  for (let id = 1; id < $dataMapInfos.length; id++) {
    const f = path.join(DATA, 'Map' + String(id).padStart(3, '0') + '.json');
    if (!fs.existsSync(f)) continue;
    loadMap(id);
    if (!MAP.events || !TILESETS[MAP.tilesetId]) continue;
    const W = MAP.width, H = MAP.height;

    // Start somewhere the player could actually stand: first tile that is passable and not
    // occupied by a blocking event. Stone is skipped on the first pass — scanning from (0,0)
    // lands in the wall on nearly every map in this game, and a start buried in stone reaches
    // its four neighbours and stops, which sweeps 600 maps without exercising any of them.
    const stoneHere = stoneTiles();
    let sx = -1, sy = -1;
    for (const avoidStone of [true, false]) {
      for (let y = 0; y < H && sx < 0; y++) for (let x = 0; x < W; x++) {
        if (avoidStone && stoneHere[y * W + x]) continue;
        if (EVENTS.some(e => e.pos(x, y) && e.isNormalPriority())) continue;
        if (checkPassage(x, y, 0x01)) { sx = x; sy = y; break; }
      }
      if (sx >= 0) break;
    }
    if (sx < 0) continue;
    maps++;

    $gamePlayer.x = sx; $gamePlayer.y = sy;
    BMA.Nav._clearFloods();
    BMA.Nav.scannedMap = id;
    BMA.Nav.entities = [];

    const strict = BMA.Nav.flood(), relaxed = BMA.Nav.flood(true);
    const refS = reference(sx, sy, false), refR = reference(sx, sy, true);
    // The one way a warp legitimately takes reach away: a FORCED tile. A touch-triggered mover
    // fires the instant the player stands on it, so the tile is not somewhere they can be — and
    // the reference, which only walks, has no way to know that. Temple of Visions (229) is the
    // case that needs it: six tiles down its west wall each bounce the player one step back east,
    // a fence rather than a crossing, and the reference walks all six.
    //
    // Discounted rather than waived, so the invariant still holds everywhere else and still
    // catches a warp that loses reach for any other reason.
    const forced = (BMA.Nav.warps().forced) || {};
    const lost = d => Object.keys(forced).reduce((n, k) => n + (d[k] !== -1 ? 1 : 0), 0);
    if (strict.failed || relaxed.failed ||
        count(strict.dist) < count(refS) - lost(refS) ||
        count(relaxed.dist) < count(refR) - lost(refR)) {
      floodBad.push(id + ' strict ' + count(strict.dist) + '/' + count(refS) +
                    ' relaxed ' + count(relaxed.dist) + '/' + count(refR) +
                    ' forced ' + Object.keys(forced).length);
    }
    // A flood that reaches only the tile it started on, on a map with somewhere to go, is the
    // "everything is unreachable" signature.
    if (count(refR) > 1 && count(relaxed.dist) <= 1) collapsed.push(id);

    for (const ev of EVENTS) {
      // One-directional: walk-reachable must be reported. Warp-reachable-only is allowed.
      if (refReach(refR, ev.x, ev.y) && !BMA.Nav.reachable({ x: ev.x, y: ev.y })) {
        reachBad.push(id + ':' + ev.eventId() + '@' + ev.x + ',' + ev.y + ' walkable but unreported');
        break;
      }
    }
  }
  console.log('  swept ' + maps + ' maps');
  check('no map reaches less than walking alone would',
        floodBad.length === 0, floodBad.slice(0, 8).join(' | '));
  check('no map collapses to a single tile', collapsed.length === 0, collapsed.slice(0, 20).join(','));
  check('no walk-reachable entity is reported unreachable', reachBad.length === 0,
        reachBad.slice(0, 8).join(' | '));
}

// ---- map 123 "Conall Curach": the reported bug, with its numbers pinned ----
//
// The map that produced "no path found" for every destination. It is 45 terrain components over
// 1,349 walkable tiles; the arrival area is 103 of them and all 22 chests sit on islands of their
// own. Crossing it means facing a marsh tile and pressing the action button, which runs a jump
// route on the player. These are the exact figures measured from the map data, so a regression in
// the route parser shows up as a number rather than as a vague loss of reach.
console.log('\n=== map 123 "Conall Curach": jump routes ===');
loadMap(123);
{
  $gamePlayer.x = 103; $gamePlayer.y = 26;          // where the Overworld door at (104,26) lands
  BMA.Nav._clearFloods();
  BMA.Nav.scannedMap = 123; BMA.Nav.entities = [];

  const warps = BMA.Nav.warps();
  check('the map yields jump edges', warps.edges.length > 0, warps.edges.length);
  check('no route on this map is unknowable', warps.unknowable === 0, warps.unknowable);

  // EV001 is a stepping stone: "if the player is facing left" wrapping three separate Set
  // Movement Route commands of one jump each. Three, not six -- MV mirrors every route step as
  // a 505 line after its 205, and counting those as well doubles the distance silently.
  // (27,42) is the tile you stand on to face EV001@(26,42) west.
  const e1 = warps.edges.filter(e => e.from === 42 * MAP.width + 27);
  check('EV001 fires from the tile east of it', e1.length === 1, e1.length);
  check('and carries the player exactly 3 tiles west, not 6',
        e1[0] && e1[0].to === 42 * MAP.width + 24,
        e1[0] && (e1[0].to % MAP.width) + ',' + Math.floor(e1[0].to / MAP.width));

  const walked = count(reference(103, 26, true));
  const reached = count(BMA.Nav.flood(true).dist);
  check('walking alone strands the player before the return exit', walked === 102, walked);
  check('jump routes open the map up', reached > 1000, reached);

  // The player-facing symptom, stated as the assertion: every chest becomes routable.
  const chests = EVENTS.filter(ev => (ev.page().list || [])
    .some(c => [125, 126, 127, 128].includes(c.code)));
  const before = chests.filter(c => refReach(reference(103, 26, true), c.x, c.y)).length;
  const after = chests.filter(c => BMA.Nav.reachable({ x: c.x, y: c.y })).length;
  check('all ' + chests.length + ' chests are reachable (walking alone found ' + before + ')',
        after === chests.length, after);

  // Mogbeth and Moss transfer within map 123, but their only page needs switch 281
  // ("Conall Curach Done"), so on a first visit they have no active page and must contribute
  // nothing. A portal edge appearing here would mean the page gate was ignored.
  check('the shortcut moogles contribute no edge while their switch is off',
        warps.edges.every(e => e.kind !== 'portal'),
        JSON.stringify(warps.edges.filter(e => e.kind === 'portal').slice(0, 3)));

  // The Through test, on real data. 16 events here carry Through-on player routes; three more
  // move the player without it, and those three are story beats, not crossings. EV008 at
  // (98,26) is the clearest: a player-touch cutscene trigger that the scan would otherwise
  // list as a way across the marsh, named after whoever speaks in it.
  BMA.Nav.scannedMap = null;
  BMA.Nav._clearFloods();
  BMA.Nav.scan();
  const crossings = BMA.Nav.entities.filter(e => e.category === 'crossing');
  check('16 crossings, one per Through route', crossings.length === 16,
        crossings.length + ': ' + crossings.map(c => c.name + '@' + c.x + ',' + c.y).join(' '));
  check('the cutscene trigger at 98,26 is not among them',
        !crossings.some(c => c.x === 98 && c.y === 26),
        JSON.stringify(crossings.filter(c => c.x === 98).map(c => c.name)));
  check('crossings are numbered, not all called the same thing',
        new Set(crossings.map(c => c.name)).size === crossings.length);
  // The moogles are the only portals here and their switch is off, so the portal list is empty
  // on a first visit while the crossings carry all the traffic.
  check('and no portals, the moogles being switched off',
        BMA.Nav.entities.filter(e => e.category === 'portal').length === 0);

  // The whole point, end to end: ask for directions to the furthest chest and get a route
  // that names a crossing, rather than the old blanket refusal.
  const chest = BMA.Nav.entities.filter(e => e.category === 'treasure')
    .sort((a, b) => (b.x - a.x) * -1)[0];
  BMA.Nav.category = 'all';
  BMA.Nav._sel = chest;
  BMA.Nav.index = BMA.Nav.filtered().indexOf(chest);
  const heard = [];
  const realSpeak = BMA.Speech.speak;
  BMA.Speech.speak = t => heard.push(t);
  BMA.Nav.directions();
  BMA.Speech.speak = realSpeak;
  check('a far chest gets a route naming a crossing',
        heard[0] && /use Crossing \d+ to cross/.test(heard[0]), heard[0]);
  check('and it is not the old blanket refusal',
        heard[0] && heard[0].indexOf('no path found') === -1, heard[0]);

  // Crossings are routed through but never cycled to, so they must not appear in any list.
  check('no crossing is offered as a destination',
        BMA.Nav.filtered().every(e => e.category !== 'crossing'),
        JSON.stringify(BMA.Nav.filtered().filter(e => e.category === 'crossing').map(e => e.name)));
}

// ---- the same map once "Conall Curach Done" is set ----
//
// Mogbeth and Moss each transfer to the far side of the map, and each opens with dialogue and a
// yes/no choice. That put them past classify()'s npc test -- sprite plus text -- and filed them
// as people rather than as passages. What an event says matters less than where it puts you.
//
// They are crossings, not a category of their own: you ask them to carry you and they do, which
// is a mover. The pathfinder routes through them and names them ("take Moss"), and they stay out
// of the cycle because nobody sets out for a ferryman -- they set out for what is on the far side.
console.log('\n=== map 123 with the story flag set: the shortcut moogles ===');
SWITCHES_ON = true;
loadMap(123);
{
  $gamePlayer.x = 103; $gamePlayer.y = 26;
  BMA.Nav.scannedMap = null;
  BMA.Nav._clearFloods();
  BMA.Nav.scan();
  const movers = BMA.Nav.entities.filter(
    e => e.category === 'crossing' && /Mogbeth|Moss/.test(e.name));
  check('both moogles are movers now', movers.length === 2,
        movers.length + ': ' + movers.map(p => p.name + '@' + p.x + ',' + p.y).join(' '));
  check('and they are named after themselves, not numbered',
        movers.every(p => /Mogbeth|Moss/.test(p.name)),
        JSON.stringify(movers.map(p => p.name)));
  check('neither is filed as an NPC',
        !BMA.Nav.entities.some(e => e.category === 'npc' && /Mogbeth|Moss/.test(e.name)),
        JSON.stringify(BMA.Nav.entities.filter(e => e.category === 'npc').map(e => e.name)));
  check('and neither is cycled to',
        BMA.Nav.filtered().every(e => !/Mogbeth|Moss/.test(e.name)),
        JSON.stringify(BMA.Nav.filtered().filter(e => /Mogbeth|Moss/.test(e.name)).map(e => e.name)));
  // The edge kind is a separate vocabulary from the category, and it stays: a same-map transfer
  // is spoken as "take Moss", a stepping stone as "use Crossing 7 to cross".
  const warps = BMA.Nav.warps();
  check('and each contributes a portal-kind warp edge',
        warps.edges.filter(e => e.kind === 'portal').length > 0,
        warps.edges.filter(e => e.kind === 'portal').length);
}
SWITCHES_ON = false;

// ---- map 293 "Life Shrine": a dungeon made entirely of teleport pads ----
//
// The other shape a map takes when it is not meant to be walked. Conall Curach is crossed by
// jumping; Life Shrine is crossed by stepping on pads that transfer you somewhere else on the
// same map — forty-eight of them, all drawn with the same sprite, over twenty sealed rooms that
// share no walkable ground at all.
//
// Two things had to be true before any of it could be routed, and both are pinned here:
// a tile a warp PUTS you on can be walked off (the pads land on each other, so treating a
// landing tile as a dead end stopped every hop after the first), and the two ends of one passage
// answer to one name.
function placeIn293(x, y, on) {
  SWITCH_SET = new Set(on || []);
  loadMap(293);
  BMA.Nav._arrival = { mapId: 293, x: 20, y: 62 };
  $gamePlayer.x = x; $gamePlayer.y = y;
  BMA.Nav._clearFloods();
  BMA.Nav.scannedMap = -1; BMA.Nav._groups = {}; BMA.Nav._nameless = {};
  BMA.Nav.scan();
  $gamePlayer.x = x; $gamePlayer.y = y;
  BMA.Nav._clearFloods();
}

console.log('\n=== map 293 "Life Shrine": pad routes ===');
{
  placeIn293(20, 62, []);                        // where the door on map 260 lands the player

  const doors = BMA.Nav.entities.filter(e => e.category === 'door');
  check('the shrine is 48 same-map doorways', doors.length === 48, doors.length);

  // Landing tiles. Every pad in the shrine lands on or beside another pad, so if being put on
  // one counted as arriving at a dead end there would be nothing past the first hop.
  const wp = BMA.Nav.warps();
  const landsOnPad = wp.edges.filter(e => wp.forced[e.to]).length;
  check('  most pads land straight onto another pad', landsOnPad >= 20, landsOnPad);
  const clock = BMA.Nav.pathTiles(119, 55);      // the pedestal, five rooms away
  check('  the clock room is reachable from the entrance', !!clock);
  check('  by taking pads, not by walking', !!clock && clock.filter(t => t[2]).length >= 5,
        clock && clock.filter(t => t[2]).length);

  // Pairing. Numbered by straight-line distance from the arrival tile, the two ends of one
  // passage always came out with unrelated numbers — (23,50) was "Door 16" and the tile it lands
  // on was "Door 22" — which is the whole map's worth of doors telling the player nothing.
  const byName = {};
  for (const e of doors) (byName[e.name] || (byName[e.name] = [])).push(e);
  const shared = Object.keys(byName).filter(n => byName[n].length === 2);
  check('  the 48 collapse to fewer names', Object.keys(byName).length < 32,
        Object.keys(byName).length);
  check('  and 19 of them are two ends of one passage', shared.length === 19, shared.length);
  check('  no name is worn by three doorways',
        Object.keys(byName).every(n => byName[n].length <= 2),
        Object.keys(byName).filter(n => byName[n].length > 2).join(', '));

  // A shared name has to be earned: each end must land within a step of the other, which is how
  // a stairway is built — one square clear, so arriving does not fire the return.
  const bad = [];
  for (const n of shared) {
    const [a, b] = byName[n];
    const da = BMA.Nav._transferOf(a.ev), db = BMA.Nav._transferOf(b.ev);
    if (!da || !db || da.mapId !== 293 || db.mapId !== 293 ||
        Math.max(Math.abs(da.x - b.x), Math.abs(da.y - b.y)) > 1 ||
        Math.max(Math.abs(db.x - a.x), Math.abs(db.y - a.y)) > 1) bad.push(n);
  }
  check('  each shared name really is a return trip', bad.length === 0, bad.join(', '));

  // And the ones that are not: (67,52) -> (69,58) -> (82,58) -> (67,52) is a ring of three, and
  // stepping onto any of them cannot be undone.
  const oneWay = doors.filter(e => /, one way$/.test(e.name));
  check('  the one-way pads say so', oneWay.length === 10, oneWay.length);
  check('  and none of them shares a number',
        oneWay.every(e => byName[e.name].length === 1),
        oneWay.filter(e => byName[e.name].length > 1).map(e => e.name).join(', '));
  check('  the ring of three is among them',
        [[67, 52], [69, 58], [82, 58]].every(p =>
          oneWay.some(e => e.x === p[0] && e.y === p[1])),
        oneWay.map(e => e.x + ',' + e.y).join(' '));
  // The warning belongs in the list, where a player is choosing. A route has already chosen.
  check('  but a route does not read the warning back',
        !!clock && !/one way/.test(BMA.Nav.describePath(clock)),
        clock && BMA.Nav.describePath(clock));
}

// ---- the clock: "The path to Life opens with the light of dawn" ----
//
// The pedestal at (119,55) asks for an hour, then a minute; twelve numerals ring it at radius 5,
// each setting the hour it is named for on the first press and five times its number in minutes
// on the second. Six then twelve — 6:00 — opens the stairs at (117,57). The numerals do not exist
// until the pedestal is used: their pages are gated on Show Time, so a first visit to the room
// finds nothing there but the pedestal.
console.log('\n=== map 293: the clock ===');
{
  placeIn293(119, 56, []);
  const ringAt = () => BMA.Nav.entities.filter(e => /^\d{1,2}:00$/.test(e.name));
  check('the clock face is not there until the pedestal is used', ringAt().length === 0,
        ringAt().map(e => e.name).join(' '));

  placeIn293(119, 56, [523, 528]);                // Show Time + Select An Hour
  const ring = ringAt();
  check('  all twelve numerals appear once it is', ring.length === 12,
        ring.map(e => e.name).join(' '));
  check('  each of them is reachable from the pedestal',
        ring.every(e => !!BMA.Nav.pathTiles(e.x, e.y)),
        ring.filter(e => !BMA.Nav.pathTiles(e.x, e.y)).map(e => e.name).join(' '));
  const six = ring.find(e => e.name === '6:00');
  check('  6:00 is four steps south of it', !!six && six.x === 119 && six.y === 60,
        six && six.x + ',' + six.y);

  // Answering resets the bank and, if the answer was 6:00, leaves Clock Puzzle Stairs on.
  placeIn293(119, 56, [527]);
  const stairs = BMA.Nav.entities.filter(e => e.category === 'door' && e.x === 117 && e.y === 57);
  check('  the stairs exist once the clock is answered', stairs.length === 1, stairs.length);
  check('  and there is a route to them', !!BMA.Nav.pathTiles(117, 57));

  // They land at (157,45), which is the only way into the east wing by walking. Before the
  // clock is answered there is no route to it at all, and saying so is the honest answer:
  // the alternative is the exit to Before Save, not a walk.
  placeIn293(20, 62, []);
  check('  the east wing is closed until then', BMA.Nav.pathTiles(173, 45) === null);
  placeIn293(157, 45, [527]);
  check('  and open from where they put you', !!BMA.Nav.pathTiles(173, 45));
}
SWITCH_SET = null;

// ---- looping maps: walking off one edge and onto the other ----
//
// 17 maps set a looping scrollType. The flood used to reject any neighbour outside the map
// rectangle, which is right for a map that does not loop and silently wrong for one that does —
// the engine had been wrapping all along (canPass goes through roundXWithDirection), so the step
// was legal and only the BFS's own bounds test threw it away.
//
// It cost nothing on most of them: all four Overworlds, the Underworld, Floating Ruins and
// Archareon Prison are ringed by ocean or open void, so not one tile pair across the seam is
// mutually passable. The Moon is the map that pays, and it pays enormously.
console.log('\n=== map 577 "The Moon": the seam is walkable ===');
loadMap(577);
{
  check('the map loops both ways', $gameMap.isLoopHorizontal() && $gameMap.isLoopVertical());

  // Genesis Obelisk is the way in.
  $gamePlayer.x = 41; $gamePlayer.y = 38;
  BMA.Nav._clearFloods();
  BMA.Nav.scannedMap = 577; BMA.Nav.entities = [];

  const strict = BMA.Nav.flood(), ref = reference(41, 38, false);
  const ns = count(strict.dist), nref = count(ref);
  check('the strict flood matches the wrapping reference', !strict.failed && ns === nref,
        ns + ' vs ' + nref);
  // Stated as a floor rather than an exact figure: the point is that the surface is one piece,
  // not that it is precisely this many tiles. Clipping at the edge reached 195.
  check('and it is the whole surface, not the piece before the seam', ns > 3000, ns);

  // The seam itself, named. Column 0 and column 74 are neighbours on a horizontally looping map.
  const W = MAP.width, H = MAP.height;
  let joinedH = 0, joinedV = 0;
  for (let y = 0; y < H; y++)
    if (strict.dist[y * W + 0] !== -1 && strict.dist[y * W + (W - 1)] !== -1 &&
        $gamePlayer.canPass(W - 1, y, 6)) joinedH++;
  for (let x = 0; x < W; x++)
    if (strict.dist[0 * W + x] !== -1 && strict.dist[(H - 1) * W + x] !== -1 &&
        $gamePlayer.canPass(x, H - 1, 2)) joinedV++;
  check('rows join across the east-west seam', joinedH > 0, joinedH);
  check('columns join across the north-south seam', joinedV > 0, joinedV);

  // A bearing that ignores the wrap points the player the long way round the world.
  check('spanX takes the short way round', BMA.Nav.spanX(71) === -4, BMA.Nav.spanX(71));
  check('spanY takes the short way round', BMA.Nav.spanY(-70) === 5, BMA.Nav.spanY(-70));
  check('and leaves an ordinary offset alone', BMA.Nav.spanX(6) === 6, BMA.Nav.spanX(6));
}

// A map that loops but whose seam is void must be unaffected — this is the regression that a
// careless wrap would cause, and it is most of the 17.
console.log('\n=== map 318 "Archareon Prison": loops, but the seam is void ===');
loadMap(318);
{
  check('the map loops both ways', $gameMap.isLoopHorizontal() && $gameMap.isLoopVertical());
  const W = MAP.width, H = MAP.height;
  let crossable = 0;
  for (let y = 0; y < H; y++) if ($gamePlayer.canPass(W - 1, y, 6)) crossable++;
  for (let x = 0; x < W; x++) if ($gamePlayer.canPass(x, H - 1, 2)) crossable++;
  check('no tile pair across the seam is passable', crossable === 0, crossable);
}

// ---- Archareon Prison: a map held together entirely by gap jumps ----
//
// The prison is a scatter of platforms over open sky with no walkable ground between them. Every
// join is an invisible action-button event standing in the gap: face it, press the button, and a
// move route with Through on jumps the player the two tiles across. Thirteen of them are the whole
// connectivity of the map — without them the entrance platform is 39 tiles and nothing else on the
// map can be reached.
//
// The puzzle is four pressure pads in the far corners. Stepping on all four brings down the
// barrier holding Lord Adder and his men, and all four are touch-triggered tile events, which
// classify() dropped until it learned to accept them — so the objective of the map was in no list.
console.log('\n=== map 318: the gap jumps and the pads ===');
{
  $gamePlayer.x = 36; $gamePlayer.y = 40;                  // where Branch Castle puts you
  BMA.Nav.scannedMap = null;
  BMA.Nav._clearFloods();
  BMA.Nav.scan();

  const warp = BMA.Nav.warps();
  const jumps = warp.edges.filter(e => e.kind === 'jump');
  check('all thirteen gaps are found, both ways across', jumps.length === 26, jumps.length);

  const strict = BMA.Nav.flood();
  check('the flood crosses them instead of stopping at the entrance',
        count(strict.dist) > 200, count(strict.dist));

  // The four pads, by the coordinates the map gives them.
  const PADS = [[30, 17], [48, 27], [52, 41], [23, 37]];
  const pads = PADS.map(([x, y]) => BMA.Nav.entities.find(e => e.x === x && e.y === y));
  check('every pressure pad is a destination', pads.every(Boolean),
        PADS.filter((p, i) => !pads[i]).join(' '));
  check('  and every one of them has a route',
        PADS.every(([x, y]) => !!BMA.Nav.pathTiles(x, y)),
        PADS.filter(([x, y]) => !BMA.Nav.pathTiles(x, y)).join(' '));

  // The route out of the entrance platform runs round a diamond whose four sides are diagonal,
  // so it is walked as a staircase. Described one step at a time that is 15 segments for the
  // nearest crossing alone, of which PATH_TURNS speaks 8 before giving up — which is what made
  // this map unusable. Paired into diagonals it is six segments and complete.
  const toCrossing = BMA.Nav.pathTiles(35, 47);
  const spoken = BMA.Nav.describePath(toCrossing);
  check('a staircase is spoken as a diagonal', /southwest 4/.test(spoken), spoken);
  check('  and the whole route fits without being cut off',
        !/more turns?$/.test(spoken) && spoken.split(',').length <= BMA.Nav.PATH_TURNS, spoken);

  // ---- what the player standing in the prison can actually reach for ----
  //
  // The flood and the routes were correct while the map was still unusable, because the list you
  // cycle is not the list of entities. Standing on the save-point platform it offered "Exits:
  // none" and four things called "Object", which is what "completely broken" was.
  $gamePlayer.x = 12; $gamePlayer.y = 25;                  // the save-point platform
  BMA.Nav.scannedMap = null;
  BMA.Nav._clearFloods();
  BMA.Nav.scan();

  const inCat = c => { BMA.Nav.category = c; BMA.Nav.index = 0; BMA.Nav._sel = null;
                       return BMA.Nav.filtered(); };

  // The way out. It is an invisible touch tile that asks "Return to Branch Castle?", so the
  // "a doorway does not talk" rule dropped it and the prison had no exit at all.
  const exits = inCat('exit');
  check('the way out of the prison is listed', exits.length === 1,
        exits.map(e => e.name).join(', '));
  check('  and it is the tile Branch Castle put you on',
        exits[0] && exits[0].x === 36 && exits[0].y === 40,
        exits[0] && exits[0].x + ',' + exits[0].y);
  check('  and there is a route to it', !!BMA.Nav.pathTiles(36, 40));

  // Crossings are the only structure this map has, so they have to be reachable for as a
  // category — though still not in "all", where they would bury everything else.
  const cross = inCat('crossing');
  check('all thirteen crossings can be cycled to', cross.length === 13, cross.length);
  check('  and every one has a route',
        cross.every(e => !!BMA.Nav.pathTiles(e.x, e.y)),
        cross.filter(e => !BMA.Nav.pathTiles(e.x, e.y)).map(e => e.name).join(' '));
  check('  but they stay out of "all"',
        inCat('all').every(e => e.category !== 'crossing'),
        inCat('all').filter(e => e.category === 'crossing').length);

  // "all" is the save point, the four pads and the way out: six things, and the pads are named
  // for what they are rather than "Object 3".
  const all = inCat('all');
  check('"all" holds the save point, the four pads and the exit', all.length === 6,
        all.map(e => e.name).join(', '));
  const named = all.filter(e => /^Pad \d$/.test(e.name));
  check('  the pads are called pads', named.length === 4, all.map(e => e.name).join(', '));
  check('  and they are the four the puzzle needs',
        PADS.every(([x, y]) => named.some(p => p.x === x && p.y === y)),
        named.map(p => p.name + '@' + p.x + ',' + p.y).join(' '));
  BMA.Nav.category = 'all';

  // A cutscene that shunts the player a few tiles mid-scene is not a doorway. These were caught
  // as crossings (hidden from "all") and promoting them to doors put "Door 1" in rooms with no
  // door — the regression that the "must leave the map" clause exists to prevent.
  loadMap(282);                                            // Throne Room: King Doran's scene
  BMA.Nav.scannedMap = null; BMA.Nav._clearFloods();
  $gamePlayer.x = 8; $gamePlayer.y = 12;
  BMA.Nav.scan();
  const doorsAt87 = BMA.Nav.entities.filter(e => e.x === 8 && e.y === 7);
  check('a mid-scene reposition is not a door',
        doorsAt87.every(e => e.category !== 'door' && e.category !== 'exit'),
        doorsAt87.map(e => e.category + ':' + e.name).join(' '));
  loadMap(318);
  BMA.Nav.scannedMap = null; BMA.Nav._clearFloods();
  $gamePlayer.x = 36; $gamePlayer.y = 40;
  BMA.Nav.scan();

  // An ordinary corner is not a staircase and must still be spoken as two runs.
  check('a plain corner is left alone',
        BMA.Nav.describePath([[0, 0], [1, 0], [2, 0], [2, 1], [2, 2]]) === 'east 2, south 2',
        BMA.Nav.describePath([[0, 0], [1, 0], [2, 0], [2, 1], [2, 2]]));
  // One zigzag is a corner too; it takes DIAG_MIN pairs before it is a corridor.
  check('  and so is a single jog',
        BMA.Nav.describePath([[0, 0], [1, 0], [1, 1]]) === 'east 1, south 1',
        BMA.Nav.describePath([[0, 0], [1, 0], [1, 1]]));
}

// Camp entry lands at the same coordinates in each variant. Its return tiles read the
// saved source map. The list must expose them and there must be an approach from arrival.
console.log('\n=== camp return exits ===');
SWITCH_SET = new Set([1, 26]);
for (const [campId, count, returnId] of [[43, 11, 180], [265, 31, 180], [299, 11, 180]]) {
  loadMap(campId);
  $gameVariables.value = id => id === 4 ? returnId : 0;
  $gamePlayer.x = 8; $gamePlayer.y = 6;
  BMA.Nav.scannedMap = null;
  BMA.Nav._clearFloods();
  BMA.Nav.scan();
  const exits = BMA.Nav.entities.filter(e => e.category === 'exit' && e.kind === 'To Overworld');
  check(`map ${campId}: all ${count} camp exits identify the return map`, exits.length === count, exits.length);
  check(`map ${campId}: a return tile can be approached from arrival`, exits.some(e => BMA.Nav.reachable(e)));
}
$gameVariables.value = () => 0;
BMA.Nav.scannedMap = null;
BMA.Nav.scan();
check('a missing return map still leaves the camp exits listed',
      BMA.Nav.entities.filter(e => e.category === 'exit' && e.kind === 'Exit').length === 11);

console.log(fails ? `\n${fails} CHECK(S) FAILED` : '\nall checks passed');
process.exit(fails ? 1 : 0);
