// Eagle's Cradle — eighteen push blocks, and the one route command that hid every one of them.
//
// The dungeon is a 255x100 map with four block rooms in it. Six giant shells stand in the
// corridors around (35..47,55..59), four more around (65..72,57..60), three at (64..67,66..67) and
// five around (143..153,36..39), and between them they hold six of the map's thirteen chests. You
// clear one by squaring up to it and pressing the action button; it slides one tile the way you
// are facing.
//
// None of that was speakable. The rule that recognises a block wanted a move route of exactly one
// step, and these routes are two: Play SE ff6knife, then the step. So all eighteen fell out as
// "Shell2", "Shell4", "Shell5" — the editor's own shorthand, in the order the editor happened to
// place them — with no hint that the action button does anything at a wall, and nothing anywhere
// to say what to do when one is shoved into the mouth of the corridor it was blocking. The same
// one-command gap hid Mythril Mine's 46 mine carts, whose routes play "Minecart" AFTER the step;
// see tests/nav_scan.js, which now counts 69 blocks in the game where it counted 5.
//
// Three things are asserted here that the census cannot reach, because they need real geometry:
//
//   which way a block will actually go   A block in a one-tile corridor has two open sides out of
//                                        four. Shove it at either of the other two and the sound
//                                        still plays and the block still does not move — there is
//                                        no way at all to tell that apart from a push that
//                                        worked. One of these eighteen has no open side left.
//   which reset puts THIS block back     Nine reset tiles on the map, and every one restores only
//                                        its own room. Naming the nearest sends the player to a
//                                        tile that restores a different room for 12 of the 18.
//   that the reset tile has a name       All nine are bare floor with nothing drawn on them, so
//                                        they were in no list and _nameAt could only call one
//                                        "Something". A bearing to "Something" is not a recovery.
//
// Passability here is MV's, tile events and event collision included: whether a block can move is
// whether Game_Event.canPass says so, and that consults the other blocks standing beside it.
const fs = require('fs'), path = require('path'), vm = require('vm');
const { SRC, DATA, MOD, requireGame, installTilemap, installedMapPassage } = require('./_paths');
installTilemap();
requireGame('nav_eaglescradle.js');

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
  mapId: () => 475,
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

// Game_Event, not Game_CharacterBase: an event's isCollidedWithEvents counts ANY non-through event
// on the tile, not only the normal-priority ones. That is what stops one block being shoved into
// another, and _pushOpenDirs is asking exactly that question.
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
      isMapPassable(px, py, d) {
        return $gameMap.isPassable(px, py, d) &&
               $gameMap.isPassable(xWith(px, d), yWith(py, d), REV[d]);
      },
      canPass(px, py, d) {
        const x2 = xWith(px, d), y2 = yWith(py, d);
        if (!$gameMap.isValid(x2, y2)) return false;
        if (this._through) return true;
        if (!this.isMapPassable(px, py, d)) return false;
        return $gameMap.eventsXyNt(x2, y2).length > 0 ? false : true;
      },
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
const block = n => BMA.Nav.entities.find(e => e.name === 'Block ' + n);
// Stand on the first side of a block that is floor, so the hints are produced from somewhere a
// player could really be asking from.
function standBeside(e) {
  for (const [dx, dy] of [[0, 1], [0, -1], [1, 0], [-1, 0]]) {
    const sx = e.x + dx, sy = e.y + dy;
    if ($gameMap.isValid(sx, sy) && checkPassage(sx, sy, BIT[2])) { standAt(sx, sy); return; }
  }
  standAt(e.x, e.y + 1);
}

let fails = 0;
function check(what, ok, got) {
  if (ok) { console.log('  ok   ' + what); return; }
  fails++;
  console.log('  FAIL ' + what + (got !== undefined ? '  got: ' + got : ''));
}
let SAID = [];
BMA.Speech.speak = t => { SAID.push(BMA.Util.cleanText(t)); };

//---------------------------------------------------------------------------
console.log('=== map 475: the eighteen shells are blocks ===');
//---------------------------------------------------------------------------
loadMap(475);
standAt(50, 28);                                    // the tile you arrive on from map 474

const blocks = BMA.Nav.entities.filter(e => e.push);
check('all eighteen are recognised as push blocks', blocks.length === 18, blocks.length);
check('and they are Block 1..18, not the editor\'s Shell1..Shell18',
      blocks.every(e => /^Block \d+$/.test(e.name)) &&
      Array.from({ length: 18 }, (_, i) => !!block(i + 1)).every(Boolean),
      blocks.map(e => e.name).join(', '));
check('nothing on the map is still called "ShellN"',
      !BMA.Nav.entities.some(e => /^Shell\d/.test(e.name)),
      BMA.Nav.entities.filter(e => /^Shell/.test(e.name)).map(e => e.name).join(', '));
check('each one reads as pushable from all four sides in the data',
      blocks.every(e => e.push.length === 4),
      blocks.map(e => e.push.length).join(','));
check('they are objects a player can go to, not scenery',
      blocks.every(e => e.category === 'interactable'));
// The rooms, so a content patch that moves one is a failure here rather than a surprise in play.
const room = (x0, y0, x1, y1) =>
  blocks.filter(e => e.x >= x0 && e.x <= x1 && e.y >= y0 && e.y <= y1).length;
check('six in the first room, four in the second, three in the third, five in the fourth',
      room(35, 55, 47, 59) === 6 && room(65, 57, 72, 60) === 4 &&
      room(64, 66, 67, 67) === 3 && room(143, 36, 153, 39) === 5,
      [room(35, 55, 47, 59), room(65, 57, 72, 60), room(64, 66, 67, 67),
       room(143, 36, 153, 39)].join(','));

//---------------------------------------------------------------------------
console.log('\n=== which way each one will actually go ===');
//---------------------------------------------------------------------------
// Read off the live map: a side is open when the block can enter the tile beyond AND the tile
// behind is floor to stand on. Four open sides says nothing worth a clause; none at all does.
const open = {};
for (let n = 1; n <= 18; n++) open[n] = BMA.Nav._pushOpenDirs(block(n));

check('Block 9, boxed in at (69,58), has no open side at all',
      open[9].length === 0, open[9].join('/'));
check('Block 7 can only be sent east', open[7].join('/') === 'east', open[7].join('/'));
check('Block 2, in a north-south corridor, goes north or south',
      open[2].sort().join('/') === 'north/south', open[2].join('/'));
check('Block 16, in an east-west one, goes east or west',
      open[16].sort().join('/') === 'east/west', open[16].join('/'));
check('five of the eighteen stand in the open with all four sides free',
      Object.values(open).filter(o => o.length === 4).length === 5,
      Object.values(open).filter(o => o.length === 4).length);
check('twelve are hemmed in on at least one side but can still be moved',
      Object.values(open).filter(o => o.length > 0 && o.length < 4).length === 12,
      Object.values(open).filter(o => o.length > 0 && o.length < 4).length);

standBeside(block(9));
BMA.Nav._syncPositions();
check('and the hint for the boxed-in one says so outright',
      BMA.Nav._pushHint(block(9).x, block(9).y).endsWith('It has nowhere left to go.'),
      BMA.Nav._pushHint(block(9).x, block(9).y));
standBeside(block(2));
BMA.Nav._syncPositions();
check('while a corridor block names the two ways it will go',
      BMA.Nav._pushHint(block(2).x, block(2).y) ===
      ' Face it and press the action button to push it. It will only move north or south.',
      BMA.Nav._pushHint(block(2).x, block(2).y));

// One push can box another block in, which is the whole reason this is read off the live map
// rather than off the map file. Block 3 sits at (41,59) in an east-west corridor and Block 2 at
// (40,58) in the north-south one that crosses it. Shove Block 3 one tile west and it lands on
// (40,59) — which is at once where Block 2 would have gone south and the only tile a player could
// have stood on to send it north. Block 2 is then stuck, and nothing on screen says so.
const live3 = block(3).ev;
live3._x -= 1; live3.x = live3._x;                   // shoved west, onto (40,59)
BMA.Nav.deltaScan();
BMA.Nav._syncPositions();
check('shoving Block 3 west leaves Block 2 with nowhere to go',
      BMA.Nav._pushOpenDirs(block(2)).length === 0,
      BMA.Nav._pushOpenDirs(block(2)).join('/'));
live3._x += 1; live3.x = live3._x;
BMA.Nav.deltaScan();
BMA.Nav._syncPositions();
check('and putting it back frees Block 2 again',
      BMA.Nav._pushOpenDirs(block(2)).sort().join('/') === 'north/south',
      BMA.Nav._pushOpenDirs(block(2)).join('/'));

//---------------------------------------------------------------------------
console.log('\n=== the nine tiles that put them back ===');
//---------------------------------------------------------------------------
const resets = BMA.Nav.blockResets();
check('all nine reset tiles are found', resets.length === 9, resets.length);
check('and every one of them is in the entity list under a name',
      resets.every(r => BMA.Nav._nameAt(r.ev.x, r.ev.y) !== 'Something'),
      resets.map(r => BMA.Nav._nameAt(r.ev.x, r.ev.y)).join(' | '));
check('they are Block reset 1..9',
      BMA.Nav.entities.filter(e => /^Block reset \d+$/.test(e.name)).length === 9,
      BMA.Nav.entities.filter(e => /^Block reset/.test(e.name)).map(e => e.name).join(', '));
// Each reset reaches its own room and no other. This is the fact the hint turns on: no tile on
// this map puts all eighteen back.
check('no single reset restores all eighteen',
      resets.every(r => r.ids.length < 18),
      resets.map(r => r.ids.length).join(','));
const restoredBy = id => resets.filter(r => r.ids.indexOf(id) >= 0).length;
check('and every block is restored by at least one of them',
      blocks.every(e => restoredBy(e.ev.eventId()) >= 1),
      blocks.filter(e => !restoredBy(e.ev.eventId())).map(e => e.name).join(', '));

//---------------------------------------------------------------------------
console.log('\n=== the hint names a reset that restores THIS block ===');
//---------------------------------------------------------------------------
// The regression this guards. Measured from the block's own tile so the number does not depend on
// where the test chooses to stand: for 12 of the 18, the geometrically nearest reset tile is one
// that restores a different room and would do nothing whatever for the block being asked about.
let naiveWrong = 0;
for (const e of blocks) {
  const id = e.ev.eventId();
  const near = resets.slice().sort((a, b) =>
    (Math.abs(a.ev.x - e.x) + Math.abs(a.ev.y - e.y)) -
    (Math.abs(b.ev.x - e.x) + Math.abs(b.ev.y - e.y)))[0];
  if (near.ids.indexOf(id) < 0) naiveWrong++;
}
check('the nearest reset is the wrong reset for 12 of the 18', naiveWrong === 12, naiveWrong);

let named = 0, wrong = [];
for (const e of blocks) {
  standBeside(e);
  BMA.Nav._syncPositions();
  const hint = BMA.Nav._resetHint(e.x, e.y);
  const m = /Block reset (\d+)/.exec(hint);
  if (!m) { wrong.push(e.name + ': no reset named'); continue; }
  named++;
  const tile = BMA.Nav.entities.find(q => q.name === 'Block reset ' + m[1]);
  if (!tile || tile.resets.indexOf(e.ev.eventId()) < 0)
    wrong.push(e.name + ' -> ' + m[1]);
}
check('every block gets a reset named for it', named === 18, named);
check('and in every case that reset really does restore it', wrong.length === 0, wrong.join(' | '));

//---------------------------------------------------------------------------
console.log('\n=== what a player hears on the way to a chest ===');
//---------------------------------------------------------------------------
standAt(146, 36);                                    // in the fourth block room
BMA.Nav.deltaScan();
const chest7 = BMA.Nav.entities.find(e => e.name === 'Chest 7');
const cur = BMA.Nav.current;
BMA.Nav.current = () => chest7;
SAID = [];
BMA.Nav.directions();
BMA.Nav.current = cur;
const line = SAID.join(' ');
check('the blocker is named as a Block, not as scenery', /^Block 16 is in the way/.test(line), line);
check('the push instruction rides on it', line.includes('press the action button to push it'), line);
check('so does which way it will go', line.includes('It will only move east or west'), line);
check('and so does the way back out of a mistake',
      /Block reset \d+, .*puts them back where they started/.test(line), line);

//---------------------------------------------------------------------------
console.log('\n=== the way in ===');
//---------------------------------------------------------------------------
// The dungeon is three maps: 474 is the mouth, 475 is all of the above, 476 is the teleport pad
// out to the Rift Shrine. Nothing here is a block puzzle, but a way in that does not announce
// itself is a dungeon nobody reaches.
loadMap(474);
standAt(10, 22);
const ways = BMA.Nav.entities.filter(e => e.category === 'exit');
check('the mouth of the dungeon offers both ways out of it', ways.length === 2,
      ways.map(e => e.name + '@' + e.x + ',' + e.y).join(' | '));
check('one of them goes on into the dungeon proper',
      ways.some(e => e.x === 10 && e.y === 3),
      ways.map(e => e.x + ',' + e.y).join(' | '));

console.log(fails ? `\n${fails} CHECK(S) FAILED` : '\nall checks passed');
process.exit(fails ? 1 : 0);
