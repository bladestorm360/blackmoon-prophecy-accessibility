// Etherdepths — the drawbridge dungeon, and the one engine trick the mod could not see.
//
// Three levers, and until now nothing about them was speakable. Each is a bare tile graphic that
// plays a short sound and throws a switch; the switch puts a single passable tile down over a
// gap somewhere between 9 and 31 steps away, off screen. A sighted player watches the bridge
// slide into place. A blind one heard "Object 1", a beep, and silence — and pulling the same
// lever again silently took the bridge back out.
//
// The reason nothing could see it is worth stating, because it is not a missing rule but a
// missing SHAPE. A bridge that is out is not an event standing in a doorway: its page conditions
// are unmet, so it has no active page, no priority, no graphic and no commands. It is a plain
// impassable map tile. Every blocker-finder in the mod looks for something standing in the way,
// so a destination across a missing bridge produced "Beyond the area you can reach" with no
// obstruction named — the one answer a player can do nothing at all with.
//
// What makes the map a puzzle rather than a corridor is asserted here too, through the shipping
// flood: the pocket at (50..52,35) is walled all round but for one tile north and one tile south,
// so BOTH Lever 1 and Lever 2 have to be thrown before anyone can climb out of the y37 corridor,
// and those two levers stand 31 tiles apart.
//
// Passability here is MV's, tile events included — allTiles() consults them AHEAD of the map's
// own layers, which is the entire mechanism under test. A stub that skipped them would be testing
// a game that does not have bridges in it.
const fs = require('fs'), path = require('path'), vm = require('vm');
const { SRC, DATA, MOD, requireGame, installTilemap, installedMapPassage } = require('./_paths');
installTilemap();
requireGame('nav_etherdepths.js');

const TILESETS = JSON.parse(fs.readFileSync(path.join(DATA, 'Tilesets.json'), 'utf8'));

global.window = global;
global.document = { addEventListener() {} };
global.require = require;
global.performance = { now: () => 0 };
for (const k of ['MapInfos', 'Actors', 'CommonEvents', 'Armors', 'System', 'Classes', 'States'])
  global['$data' + k] = JSON.parse(fs.readFileSync(path.join(DATA, k + '.json'), 'utf8'));
global.$gameVariables = { value: () => 0 };

const actorStub = id => (id && $dataActors[id]
  ? { actorId: () => id, name: () => $dataActors[id].name } : null);
global.$gameActors = { actor: actorStub };
global.$gameParty = { leader: () => actorStub(1), members: () => [actorStub(1)] };

// ---- MV passability, faithful, WITH tile events (rpg_objects.js checkPassage/allTiles) ----
const BIT = { 2: 0x01, 4: 0x02, 6: 0x04, 8: 0x08 };
const REV = { 2: 8, 8: 2, 4: 6, 6: 4 };
let MAP = null, FLAGS = null, EVENTS = [];

function layeredTiles(x, y) { return Game_Map.prototype.layeredTiles(x, y); }
function tileEventTiles(x, y) {
  return EVENTS.filter(e => e.isTile() && e.posNt(x, y)).map(e => e.tileId());
}
const checkPassage = installedMapPassage(() => FLAGS, tileEventTiles);
const xWith = (x, d) => x + (d === 6 ? 1 : d === 4 ? -1 : 0);
const yWith = (y, d) => y + (d === 2 ? 1 : d === 8 ? -1 : 0);

global.$gameMap = {
  mapId: () => 473,
  width: () => MAP.width, height: () => MAP.height,
  displayName: () => MAP.displayName || '',
  tilesetId: () => MAP.tilesetId,
  isValid(x, y) { return x >= 0 && y >= 0 && x < MAP.width && y < MAP.height; },
  isLoopHorizontal: () => false, isLoopVertical: () => false,
  roundX: x => x, roundY: y => y,
  isPassable(x, y, d) { return checkPassage(x, y, BIT[d]); },
  tilesetFlags: () => FLAGS,
  layeredTiles,
  tileId: Game_Map.prototype.tileId,
  isCounter(x, y) {
    if (!this.isValid(x, y)) return false;
    for (const t of layeredTiles(x, y)) {
      const f = FLAGS[t] | 0;
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
global.SceneManager = { _scene: null };
global.Scene_Map = function () {};

for (const f of ['BMA_Core.js', 'BMA_Text.js', 'BMA_Menus.js', 'BMA_Nav.js'])
  vm.runInThisContext(fs.readFileSync(path.join(SRC, f), 'utf8'), { filename: f });
BMA.TTS.modDir = MOD;

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

// Rebuild the event objects for the current switch set. clearPageSettings leaves _tileId at 0 on
// an event with no active page, which is exactly how the mod tells a bridge that is out from one
// that is down — so a stub that kept the tile id would hide the bug this file exists for.
function buildEvents() {
  EVENTS = MAP.events.filter(Boolean).map(ev => {
    const p = activePage(ev);
    const img = (p && p.image) || {};
    return {
      _x: ev.x, _y: ev.y, x: ev.x, y: ev.y, _erased: false, _pageIndex: p ? 0 : -1,
      _priorityType: p ? p.priorityType : 0,
      _through: p ? !!p.through : true,
      _tileId: p ? (img.tileId || 0) : 0,
      eventId: () => ev.id,
      tileId() { return this._tileId; },
      isTile() { return this._tileId > 0 && this._priorityType === 0; },
      pos(px, py) { return this._x === px && this._y === py; },
      posNt(px, py) { return this.pos(px, py) && !this._through; },
      isNormalPriority() { return this._priorityType === 1; },
      event: () => ev, page: () => p,
    };
  });
}
function loadMap(id) {
  MAP = JSON.parse(fs.readFileSync(path.join(DATA, 'Map' + String(id).padStart(3, '0') + '.json'), 'utf8'));
  global.$dataMap = MAP;
  FLAGS = TILESETS[MAP.tilesetId].flags;
  $gameMap.mapId = () => id;
  buildEvents();
  resetNav();
}
// Flipping a switch is a page refresh: rebuild the events, then drop everything the mod caches
// about where you can walk. _gates is NOT dropped — the span table is static map data, and the
// point of spanAt() is that it re-reads the live tile id through it.
function setSwitches(ids) {
  ON = new Set(ids);
  buildEvents();
  BMA.Nav._clearFloods();
  BMA.Nav.scannedMap = null;
  BMA.Nav._nameless = {};
  BMA.Nav.scan();
}
function resetNav() {
  BMA.Nav.scannedMap = null;
  BMA.Nav.entities = [];
  BMA.Nav._clearFloods();
  BMA.Nav._gates = null;
  BMA.Nav._warps = null;
  BMA.Nav._swapKey = -1;
  BMA.Nav._markerKey = -1;
  BMA.Nav._nameless = {};
  BMA.Nav._groups = {};
  BMA.Nav._blockResets = null;
}
function standAt(x, y) {
  $gamePlayer.x = x; $gamePlayer.y = y;
  BMA.Nav._clearFloods();
  BMA.Nav._arrival = { mapId: $gameMap.mapId(), x, y };
}

let fails = 0;
function check(what, ok, got) {
  if (ok) { console.log('  ok   ' + what); return; }
  fails++;
  console.log('  FAIL ' + what + (got !== undefined ? '  got: ' + got : ''));
}
const _speak = BMA.Speech.speak;
let SAID = [];
BMA.Speech.speak = t => { SAID.push(BMA.Util.cleanText(t)); };

//---------------------------------------------------------------------------
console.log('=== map 473: the three levers ===');
//---------------------------------------------------------------------------
loadMap(473);
setSwitches([]);
standAt(43, 38);                                    // stood at Lever 1, nothing thrown yet

const levers = BMA.Nav.entities.filter(e => /^Lever \d+$/.test(e.name))
                               .sort((a, b) => a.name.localeCompare(b.name));
check('all three levers are levers, not "Object N"', levers.length === 3,
      BMA.Nav.entities.filter(e => e.ev && [1, 4, 7].indexOf(e.ev.eventId()) >= 0)
                      .map(e => e.name).join(', '));
check('Lever 1 is the one at (43,37)',
      levers[0] && levers[0].name === 'Lever 1' && levers[0].x === 43 && levers[0].y === 37,
      levers[0] && levers[0].name + '@' + levers[0].x + ',' + levers[0].y);
check('Lever 2 is the one at (74,37)',
      levers[1] && levers[1].x === 74 && levers[1].y === 37,
      levers[1] && levers[1].name + '@' + levers[1].x + ',' + levers[1].y);
check('Lever 3 is the one at (23,16)',
      levers[2] && levers[2].x === 23 && levers[2].y === 16,
      levers[2] && levers[2].name + '@' + levers[2].x + ',' + levers[2].y);
check('and they are objects you can go to, not scenery',
      levers.every(e => e.category === 'interactable'));

//---------------------------------------------------------------------------
console.log('\n=== the bridges they lay ===');
//---------------------------------------------------------------------------
const spans = BMA.Nav.gates().spans;
const spanKeys = Object.keys(spans).sort();
check('four tiles on this map are bridged by a switch', spanKeys.length === 4, spanKeys.join(' '));
check('Lever 1 lays (51,34)', !!spans['51,34'] && spans['51,34'].opensWith === 876,
      spans['51,34'] && spans['51,34'].opensWith);
check('Lever 2 lays (51,36)', !!spans['51,36'] && spans['51,36'].opensWith === 877,
      spans['51,36'] && spans['51,36'].opensWith);
check('Lever 3 lays both of (42,33) and (43,33)',
      !!spans['42,33'] && !!spans['43,33'] &&
      spans['42,33'].opensWith === 878 && spans['43,33'].opensWith === 878);

check('with nothing thrown, every one of them is out',
      spanKeys.every(k => !!BMA.Nav.spanAt(...k.split(',').map(Number))));
check('a missing bridge is named as one rather than as "Something"',
      BMA.Nav._nameAt(51, 34) === 'Missing bridge', BMA.Nav._nameAt(51, 34));
check('and the tile really is impassable while it is out',
      !$gameMap.isPassable(51, 34, 2) && !$gameMap.isPassable(51, 34, 8));

// The hint is the whole point: a gap 9 steps away is useless without the handle that closes it.
const hint1 = BMA.Nav._gateHint(BMA.Nav.spanAt(51, 34));
check('the gap at (51,34) says it opens from Lever 1', /opens from Lever 1,/.test(hint1), hint1);
const hint3 = BMA.Nav._gateHint(BMA.Nav.spanAt(43, 33));
check('the gap at (43,33) says it opens from Lever 3', /opens from Lever 3,/.test(hint3), hint3);

//---------------------------------------------------------------------------
console.log('\n=== throwing one ===');
//---------------------------------------------------------------------------
setSwitches([876]);
standAt(43, 38);
check('Lever 1 thrown puts its bridge down', BMA.Nav.spanAt(51, 34) === null);
check('so the tile becomes walkable', $gameMap.isPassable(51, 34, 2));
check('and the other two are still out',
      !!BMA.Nav.spanAt(51, 36) && !!BMA.Nav.spanAt(42, 33));

//---------------------------------------------------------------------------
console.log('\n=== the vestibule needs both levers, and they are 31 steps apart ===');
//---------------------------------------------------------------------------
// (50..52,35) is a pocket in the wall between the y37 corridor and the y33 shelf, with exactly
// two ways in: (51,36) from the south and (51,34) from the north. Everything past it — Lever 3,
// and through Lever 3 the way to Chiron and the prisoners — is behind both.
function reaches(x, y) {
  const f = BMA.Nav.flood();
  return f.dist[y * f.w + x] !== -1;
}
setSwitches([]);
standAt(43, 38);
check('from the corridor, the vestibule is shut with nothing thrown', !reaches(51, 35));
setSwitches([876]);
standAt(43, 38);
check('Lever 1 alone does not open it — it opens the far side', !reaches(51, 35));
setSwitches([877]);
standAt(43, 38);
check('Lever 2 alone lets you in but not out', reaches(51, 35) && !reaches(51, 33));
setSwitches([876, 877]);
standAt(43, 38);
check('both together are what get you through', reaches(51, 35) && reaches(51, 33));
check('and that is the only way to Lever 3', reaches(24, 16));

//---------------------------------------------------------------------------
console.log('\n=== a route blocked by a missing bridge names it ===');
//---------------------------------------------------------------------------
setSwitches([]);
standAt(51, 37);                                    // directly below the vestibule's south door
const b = BMA.Nav.blockerToward(51, 35) || BMA.Nav.blockerOnPath([[51, 36], [51, 35]]);
check('the obstruction is found at all', !!b, String(b));
check('and it is the missing bridge, not "Something"',
      b && b.name === 'Missing bridge' && b.x === 51 && b.y === 36,
      b && b.name + '@' + b.x + ',' + b.y);

//---------------------------------------------------------------------------
console.log('\n=== the announcement ===');
//---------------------------------------------------------------------------
SceneManager._scene = new Scene_Map();
setSwitches([]);
standAt(43, 38);
let before = BMA.Nav.spanState();
setSwitches([876]);
standAt(43, 38);
SAID = [];
BMA.Nav.announceSpanChange(before);
check('pulling a lever says the bridge went down, and where',
      SAID.length === 1 && /^Bridge open, \d+ steps? /.test(SAID[0]), JSON.stringify(SAID));

before = BMA.Nav.spanState();
setSwitches([]);
standAt(43, 38);
SAID = [];
BMA.Nav.announceSpanChange(before);
check('pulling it again says it came back up — the failure that stranded people',
      SAID.length === 1 && /^Bridge closed, \d+ steps? /.test(SAID[0]), JSON.stringify(SAID));

// Lever 3 lays two tiles side by side. One crossing, one sentence.
before = BMA.Nav.spanState();
setSwitches([878]);
standAt(43, 38);
SAID = [];
BMA.Nav.announceSpanChange(before);
check('a two-tile bridge is announced once, not twice',
      SAID.length === 1 && (SAID[0].match(/Bridge/g) || []).length === 1, JSON.stringify(SAID));

before = BMA.Nav.spanState();
setSwitches([878]);
standAt(43, 38);
SAID = [];
BMA.Nav.announceSpanChange(before);
check('and nothing changing says nothing', SAID.length === 0, JSON.stringify(SAID));

//---------------------------------------------------------------------------
console.log('\n=== asking for the far end names the next lever, one at a time ===');
//---------------------------------------------------------------------------
// The question a player actually asks: pick the objective, get told what to do next. Chiron is at
// the far end of the dungeon behind all three bridges, so the answer has to name whichever lever
// is the next one that can be reached — and change as each is thrown.
SceneManager._scene = new Scene_Map();
function directionsTo(target) {
  BMA.Nav.category = 'all';
  const list = BMA.Nav.filtered();
  let e = null, best = Infinity;
  for (const c of list) {
    const d = Math.abs(c.x - target[0]) + Math.abs(c.y - target[1]);
    if (d < best) { best = d; e = c; }
  }
  BMA.Nav._sel = e;
  BMA.Nav.index = list.indexOf(e);
  SAID = [];
  BMA.Nav.directions();
  return SAID.join(' ');
}
const CHIRON = [112, 40];
loadMap(473);

setSwitches([]); standAt(46, 8);
let said = directionsTo(CHIRON);
check('from the entrance, the answer is the missing bridge and Lever 2',
      /^Missing bridge is in the way, .*It opens from Lever 2,/.test(said), said);

setSwitches([877]); standAt(46, 8);
said = directionsTo(CHIRON);
check('with Lever 2 thrown it moves on to Lever 1',
      /^Missing bridge is in the way, .*It opens from Lever 1,/.test(said), said);

setSwitches([876, 877]); standAt(46, 8);
said = directionsTo(CHIRON);
check('with both thrown it moves on to Lever 3',
      /^Missing bridge is in the way, .*It opens from Lever 3,/.test(said), said);

setSwitches([876, 877, 878]); standAt(46, 8);
said = directionsTo(CHIRON);
check('and with all three thrown it is a route, with no bridge in it',
      said.indexOf('Missing bridge') === -1 && /steps? (south|east|north|west)/.test(said), said);

// The relaxed flood is allowed onto stone the strict flood keeps off, and outside this dungeon's
// walls that stone is the rest of the map — so it will happily find a 141-tile way round a bridge
// that cannot be gone round. Naming the lever and then reading out that walk is an instruction to
// walk into a wall.
setSwitches([]); standAt(46, 8);
said = directionsTo(CHIRON);
check('and a way round a missing bridge is never read out as a route',
      !/, then \d+ more turns/.test(said), said);

//---------------------------------------------------------------------------
console.log('\n=== map 92: a sarcophagus is not a missing bridge ===');
//---------------------------------------------------------------------------
// Naddaha Pyramid lays its eight slabs from the coffin standing on the tile: page 0 is a solid
// blocker with fourteen commands, page 1 the slab it slides aside. That coffin is an event in a
// corridor — already named, already found, and the way round it is a real way round a real thing.
loadMap(92);
setSwitches([]);
standAt(16, 142);
check('the pyramid has bridge tiles', Object.keys(BMA.Nav.gates().spans).length === 8,
      Object.keys(BMA.Nav.gates().spans).length);
check('but none of them is claimed as a missing bridge', BMA.Nav._spanTiles().length === 0,
      JSON.stringify(BMA.Nav._spanTiles()));
said = directionsTo([91, 128]);
check('the sarcophagus remains the obstruction even when the relaxed route stops at an exit',
      /^Sarcophagus \d+ is in the way,/.test(said) && /Beyond the area you can reach/.test(said), said);

//---------------------------------------------------------------------------
console.log('\n=== map 580: Elemental Abyss, the same mechanism at four times the size ===');
//---------------------------------------------------------------------------
// The game names these switches "Bridge 1".."Bridge 4" itself, which is where the word comes from.
loadMap(580);
setSwitches([]);
standAt(24, 26);
const abyss = BMA.Nav.gates().spans;
check('all twelve of its bridge tiles are found', Object.keys(abyss).length === 12,
      Object.keys(abyss).length);
const abyssLevers = BMA.Nav.entities.filter(e => /^Lever \d+$/.test(e.name));
check('and all four of its levers are levers', abyssLevers.length === 4,
      abyssLevers.map(e => e.name + '@' + e.x + ',' + e.y).join(', '));
check('every bridge is out with nothing thrown',
      Object.keys(abyss).every(k => !!BMA.Nav.spanAt(...k.split(',').map(Number))));

//---------------------------------------------------------------------------
console.log('\n=== map 408: a special effect is not a bridge ===');
//---------------------------------------------------------------------------
// Water Shrine Barrier lays passable tiles over impassable ground off "Animation1"/"Animation2",
// which a parallel event flips every 15 frames forever. It matches the shape exactly and is not a
// bridge; without the player-thrown test this map would talk over the game four times a second.
loadMap(408);
setSwitches([]);
standAt(23, 30);
check('an animation loop registers no bridges', Object.keys(BMA.Nav.gates().spans).length === 0,
      JSON.stringify(Object.keys(BMA.Nav.gates().spans)));

//---------------------------------------------------------------------------
console.log('\n=== nothing else in the game grew a lever ===');
//---------------------------------------------------------------------------
// Six maps have one. The rule is narrow on purpose — widening it by a single command takes in
// every NPC who flips a story flag mid-conversation — so the count is asserted, not sampled.
const LEVER_MAPS = { 9: 1, 92: 5, 339: 1, 466: 3, 473: 3, 580: 4 };
const info = JSON.parse(fs.readFileSync(path.join(DATA, 'MapInfos.json'), 'utf8'));
let found = 0;
for (const m of info) {
  if (!m) continue;
  const file = path.join(DATA, 'Map' + String(m.id).padStart(3, '0') + '.json');
  if (!fs.existsSync(file)) continue;
  const data = JSON.parse(fs.readFileSync(file, 'utf8'));
  let n = 0;
  for (const ev of data.events || []) {
    if (!ev) continue;
    if ((ev.pages || []).some(p => {
      const img = p.image || {};
      if (p.trigger !== 0 || !(img.characterName || img.tileId > 0)) return false;
      return BMA.Nav._leverSwitches(p).length > 0;
    })) n++;
  }
  if (!n) continue;
  found++;
  check('map ' + m.id + ' (' + m.name + ') has ' + LEVER_MAPS[m.id] + ' lever(s)',
        LEVER_MAPS[m.id] === n, n);
}
check('and no other map in the game has one', found === Object.keys(LEVER_MAPS).length, found);

BMA.Speech.speak = _speak;
console.log(fails ? `\n${fails} CHECK(S) FAILED` : '\nall checks passed');
process.exit(fails ? 1 : 0);
