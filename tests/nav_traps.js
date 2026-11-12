// Traps and gates, against real game map data with the same faithful MV passability stub
// nav_realmap.js uses.
//
// Two things are being guaranteed here, and both are safety properties rather than cosmetics:
//
//   1. the trap-free flood never routes the player onto a live trap, and pathTiles prefers it
//   2. when there is genuinely no way round, the route still comes back and trapOnPath finds
//      the trap on it, so directions() can warn instead of walking them over it silently
//
// Property-based rather than hand-picked coordinates: the test locates its own start tile by
// flooding outward from a trap, so it keeps testing the right thing if the map data ever moves.
const fs = require('fs'), path = require('path'), vm = require('vm');
const { SRC, DATA, requireGame, installTilemap, installedMapPassage } = require('./_paths');
installTilemap();
requireGame('nav_traps.js');

const TILESETS = JSON.parse(fs.readFileSync(path.join(DATA, 'Tilesets.json'), 'utf8'));

global.window = global;
global.document = { addEventListener() {} };
global.require = require;
global.performance = { now: () => 0 };
global.$dataMapInfos = JSON.parse(fs.readFileSync(path.join(DATA, 'MapInfos.json'), 'utf8'));
global.$dataActors = JSON.parse(fs.readFileSync(path.join(DATA, 'Actors.json'), 'utf8'));
global.$dataCommonEvents = JSON.parse(fs.readFileSync(path.join(DATA, 'CommonEvents.json'), 'utf8'));
global.$dataArmors = JSON.parse(fs.readFileSync(path.join(DATA, 'Armors.json'), 'utf8'));
global.$dataSystem = JSON.parse(fs.readFileSync(path.join(DATA, 'System.json'), 'utf8'));
global.$dataClasses = JSON.parse(fs.readFileSync(path.join(DATA, 'Classes.json'), 'utf8'));
global.$gameVariables = { value: () => 0 };
global.$gameActors = { actor: () => null };
global.$gameParty = { members: () => [] };

const BIT = { 2: 0x01, 4: 0x02, 6: 0x04, 8: 0x08 };
const REV = { 2: 8, 8: 2, 4: 6, 6: 4 };
let MAP = null, FLAGS = null, EVENTS = [];

const checkPassage = installedMapPassage(() => FLAGS);
function xWith(x, d) { return x + (d === 6 ? 1 : d === 4 ? -1 : 0); }
function yWith(y, d) { return y + (d === 2 ? 1 : d === 8 ? -1 : 0); }

global.$gameMap = {
  mapId: () => 92,
  width: () => MAP.width,
  height: () => MAP.height,
  displayName: () => MAP.displayName || '',
  tilesetId: () => MAP.tilesetId,
  isValid(x, y) { return x >= 0 && y >= 0 && x < MAP.width && y < MAP.height; },
  isPassable(x, y, d) { return checkPassage(x, y, BIT[d]); },
  // _wallGround() reads the map the same way checkPassage does, so the stub has to expose the
  // engine's two accessors as well as the derived isPassable.
  tilesetFlags: () => FLAGS,
  tileId: Game_Map.prototype.tileId,
  isCounter() { return false; },
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
BMA.TTS.modDir = path.join(DATA, '..', 'mod');

let fails = 0;
const check = (name, cond, extra) => {
  if (cond) console.log('  ok   ' + name);
  else { fails++; console.log('  FAIL ' + name + (extra !== undefined ? '  -> ' + extra : '')); }
};

// A fresh game: every switch off, so every trap bank is still armed and every gate still shut.
// That is the state this has to work in — once the switches are thrown there is nothing left to
// warn about.
function activePage(ev) {
  for (let i = ev.pages.length - 1; i >= 0; i--) {
    const c = ev.pages[i].conditions;
    if (!c) return ev.pages[i];
    if (c.switch1Valid || c.switch2Valid || c.selfSwitchValid || c.itemValid || c.actorValid) continue;
    if (c.variableValid && c.variableValue > 0) continue;
    return ev.pages[i];
  }
  return null;
}

function loadMap(id) {
  MAP = JSON.parse(fs.readFileSync(path.join(DATA, 'Map' + String(id).padStart(3, '0') + '.json'), 'utf8'));
  global.$dataMap = MAP;
  FLAGS = TILESETS[MAP.tilesetId].flags;
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
  BMA.Nav.scannedMap = -1;
  BMA.Nav._groups = {}; BMA.Nav._nameless = {};
  BMA.Nav.scan();
}

function placePlayer(x, y) {
  $gamePlayer.x = x; $gamePlayer.y = y;
  BMA.Nav._clearFloods();
}

const count = a => a.reduce((n, v) => n + (v !== -1 ? 1 : 0), 0);

// ---------------------------------------------------------------------------
// Naddaha Pyramid — 51 armed spike tiles, 400-500 to the whole party
// ---------------------------------------------------------------------------
console.log('=== map 92 Naddaha Pyramid ===');
loadMap(92);

const traps = BMA.Nav.entities.filter(e => e.category === 'trap');
check('traps are classified', traps.length === 51, traps.length);
check('a trap says what it costs',
  traps.every(t => /^Trap, 400 to 500 damage$/.test(t.name)),
  traps.map(t => t.name).find(n => !/^Trap, 400 to 500 damage$/.test(n)));

// The sarcophagi: the same stone box appears under three categories depending on whether it
// also fights you or moves you, and all 18 must answer to the same word.
const sarc = BMA.Nav.entities.filter(e => /^Sarcophagus \d+$/.test(e.name));
check('all 18 sarcophagi are named', sarc.length === 18, sarc.length);
check('sarcophagi are numbered uniquely',
  new Set(sarc.map(e => e.name)).size === 18, new Set(sarc.map(e => e.name)).size);
check('the trap lever is named',
  BMA.Nav.entities.some(e => e.name === 'Lever'),
  BMA.Nav.entities.filter(e => e.category === 'interactable').map(e => e.name).join(', '));

// No spoilers: breaking a sarcophagus can start a fight, and nothing on the map says so before
// you break it. Nine of the eighteen do, and every one of them has to sit in objects alongside
// the nine that do not — otherwise the enemies list tells a blind player which coffins are
// trapped, which is a warning no sighted player gets.
const fighters = [43, 45, 47, 52, 95, 97, 105, 108, 109];
const placed = fighters.map(id => BMA.Nav.entities.find(e => e.ev.eventId() === id)).filter(Boolean);
check('every fighting sarcophagus is found', placed.length === fighters.length, placed.length);
check('and none of them is filed under enemies',
  placed.every(e => e.category === 'interactable'),
  placed.filter(e => e.category !== 'interactable').map(e => e.category + ' ' + e.name).join(', '));
check('they are named for what they look like',
  placed.every(e => /^Sarcophagus \d+$/.test(e.name)),
  placed.map(e => e.name).find(n => !/^Sarcophagus \d+$/.test(n)));
// The inverse of the rule: nothing left in the enemies list is a tile-drawn thing you have to
// press the action button on. (Sprite-drawn monsters stay, and so do the graphic-less cutscene
// triggers, which were never objects — there is nothing standing there at all.)
const ambush = BMA.Nav.entities.filter(e => {
  if (e.category !== 'enemy') return false;
  const img = e.ev.page().image || {};
  return !img.characterName && img.tileId > 0 && e.ev.page().trigger === 0;
});
check('no tile-drawn ambush is left in enemies', ambush.length === 0,
  ambush.map(e => e.name).join(', '));

// A trap is somewhere to avoid, not somewhere to go. It has to be cyclable in its own category
// and absent from "all", or 51 of them bury the 18 chests and the way on.
$gamePlayer.x = 100; $gamePlayer.y = 130;
BMA.Nav.category = 'all';
check('traps stay out of the "all" list',
  BMA.Nav.filtered().every(e => e.category !== 'trap'),
  BMA.Nav.filtered().filter(e => e.category === 'trap').length);
BMA.Nav.category = 'trap';
check('and are all there in their own category',
  BMA.Nav.filtered().length === 51, BMA.Nav.filtered().length);
BMA.Nav.category = 'all';

// Start beside a trap, on ground the strict flood can actually get somewhere from — so the
// comparison below is between two real floods rather than two empty ones.
const W = MAP.width;
let start = null;
for (const t of traps) {
  for (const [dx, dy] of [[0, -1], [0, 1], [-1, 0], [1, 0]]) {
    const x = t.x + dx, y = t.y + dy;
    if (!$gameMap.isValid(x, y)) continue;
    placePlayer(x, y);
    let n = 0;
    const f = BMA.Nav.flood(false);
    for (let i = 0; i < f.dist.length; i++) if (f.dist[i] !== -1) n++;
    if (n > 200) { start = { x, y, reached: n }; break; }
  }
  if (start) break;
}
check('found somewhere to stand next to a trap', !!start, start && JSON.stringify(start));

if (start) {
  placePlayer(start.x, start.y);
  const strict = BMA.Nav.flood(false);
  const safe = BMA.Nav.flood(false, true);

  // The core invariant.
  const startIdx = start.y * W + start.x;
  const entered = traps.filter(t => {
    const i = t.y * W + t.x;
    return i !== startIdx && safe.dist[i] !== -1;
  });
  check('the safe flood never enters a live trap', entered.length === 0,
    entered.map(t => t.x + ',' + t.y).join(' '));

  // It must still be a real flood, and it must never claim more than the strict one: walling off
  // 51 tiles can legitimately cost a great deal of reach — the banks sit across the corridors, so
  // that is exactly what they are for — but it can never open anything up.
  let nStrict = 0, nSafe = 0, over = 0;
  for (let i = 0; i < strict.dist.length; i++) {
    if (strict.dist[i] !== -1) nStrict++;
    if (safe.dist[i] !== -1) nSafe++;
    if (safe.dist[i] !== -1 && strict.dist[i] === -1) over++;
  }
  check('the safe flood reaches somewhere', nSafe > 1, nSafe);
  check('and never reaches anywhere the strict flood cannot', over === 0, over);

  // Somewhere the safe flood reaches: the spoken route must not cross a trap.
  let clear = -1;
  for (let i = 0; i < safe.dist.length; i++) if (safe.dist[i] > 12) { clear = i; break; }
  if (clear >= 0) {
    const cx = clear % W, cy = (clear - cx) / W;
    const route = BMA.Nav.pathTiles(cx, cy);
    check('a route to trap-free ground crosses no trap',
      route && !BMA.Nav.trapOnPath(route), route ? 'crosses a trap' : 'no route');
  }

  // Somewhere only the trapped flood reaches: the route must still be given, and the trap on it
  // must be findable so directions() can warn.
  //
  // "Only across a trap" has to mean the goal AND every tile you could interact with it from are
  // sealed off — _goalIndex settles for a reachable neighbour, so a target whose own tile is
  // walled off but whose doorstep is not is still reached without stepping on anything, which is
  // the behaviour we want and not the case being tested here.
  let onlyTrapped = -1;
  for (let i = 0; i < strict.dist.length; i++) {
    if (strict.dist[i] === -1 || safe.dist[i] !== -1) continue;
    if (traps.some(t => t.y * W + t.x === i)) continue;
    const x = i % W, y = (i - x) / W;
    if (BMA.Nav._goalIndex(x, y, false, true) !== -1) continue;   // a safe way to its doorstep
    onlyTrapped = i; break;
  }
  if (onlyTrapped >= 0) {
    const ox = onlyTrapped % W, oy = (onlyTrapped - ox) / W;
    const route = BMA.Nav.pathTiles(ox, oy);
    check('ground reachable only across a trap still gets a route', !!route);
    const hit = route && BMA.Nav.trapOnPath(route);
    check('and the trap on it is reported', !!hit, hit ? hit.name : 'not found');
  } else {
    console.log('  --   no ground is reachable only across a trap from here');
  }
}

// Gates: the sealed passages, and what opens them.
const gates = BMA.Nav.gates().byTile;
const gateTiles = Object.keys(gates);
check('sealed passages are found', gateTiles.length === 20, gateTiles.length);
check('every gate names the switch that frees it',
  gateTiles.every(t => gates[t].opensWith > 0));
const withOpener = gateTiles.filter(t => gates[t].openers.length > 0);
check('and most name something on this map that throws it',
  withOpener.length >= 18, withOpener.length + ' of ' + gateTiles.length);

// The sentence a player actually hears when a sealed passage stops them. This is the whole
// point of the gate model: "Something is in the way" gives them nowhere to go.
const hint = BMA.Nav._gateHint(gates[withOpener[0]]);
check('a sealed passage says what opens it',
  / It opens from \w[\w ]*, \d+ steps? (north|south|east|west|north-?east|north-?west|south-?east|south-?west)\.$/.test(hint),
  JSON.stringify(hint));

// ---------------------------------------------------------------------------
// The other two trap maps — different shapes, same category
// ---------------------------------------------------------------------------
console.log('\n=== the other trap maps ===');
loadMap(110);
const mine = BMA.Nav.entities.filter(e => e.category === 'trap');
check('Aether Mine: invisible MP drains are found', mine.length === 92, mine.length);
check('Aether Mine: named for what they drain',
  mine.every(t => /drains 2 to 5 MP$/.test(t.name)), mine[0] && mine[0].name);

loadMap(190);
const forest = BMA.Nav.entities.filter(e => e.category === 'trap');
check('Forest: flat-damage traps are found', forest.length === 43, forest.length);
check('Forest: named for a flat amount',
  forest.every(t => /100 damage$/.test(t.name)), forest[0] && forest[0].name);

// A gate that is nothing but a wall — no transfer on any page, so classify() files it as
// nothing and the editor's "EV041" is all there is to go on. Esto Yensa has 65 of them, the
// most in the game, and this is where the "Sealed passage" fallback has to earn its place.
console.log('\n=== map 400 Esto Yensa ===');
loadMap(400);
const yensaTiles = Object.keys(BMA.Nav.gates().byTile);
check('Esto Yensa: sealed passages are found', yensaTiles.length === 64, yensaTiles.length);
const called = yensaTiles.map(t => BMA.Nav._nameAt(...t.split(',').map(Number)));
// The thing being guaranteed: a gate is never announced as "Something". 53 of these are bare
// walls the editor left as EV041 and they become "Sealed passage"; the rest already had a name
// worth keeping (9 closed doors, 2 the dev named), and those keep it.
check('no gate is announced as "Something"',
  !called.includes('Something'), called.filter(n => n === 'Something').length + ' anonymous');
check('the bare walls become sealed passages',
  called.filter(n => n === 'Sealed passage').length === 53,
  called.filter(n => n === 'Sealed passage').length);

// ---------------------------------------------------------------------------
// Forced warps — a tile you cannot walk across
// ---------------------------------------------------------------------------
//
// Aether Mine's two portals face each other: (90,7) lands you at (140,82), and (140,83) — one
// step south of that — sends you straight back. Walking is not what happens when you step on
// one, so a route that treated (140,83) as ordinary ground read "take door 1, south 24", warped
// the player home on the first of those 24 steps, and then issued the same instruction again.
//
// The rule: a forced tile may appear in a route only as its last tile, immediately before the
// tile its own warp lands on, or as a tile the route arrived on by warp. Anything else is an
// instruction the player cannot carry out.
//
// That third case is the whole of Life Shrine. A touch trigger fires from updateNonmoving only
// when wasMoving, and performTransfer locates the player without moving them, so a pad they were
// PUT on stays silent — they are standing on it and can step off. Requiring otherwise made every
// pad-to-pad hop in the shrine a dead end.
console.log('\n=== forced warps ===');
for (const [id, label] of [[110, 'Aether Mine'], [293, 'Life Shrine'], [123, 'Conall Curach']]) {
  loadMap(id);
  const wp = BMA.Nav.warps();
  const forced = Object.keys(wp.forced).map(Number);
  const W2 = MAP.width;
  if (id === 110) {
    check('Aether Mine: both facing portals are forced', forced.length === 2, forced.length);
    check('  and they are the two that loop',
      forced.includes(7 * W2 + 90) && forced.includes(83 * W2 + 140),
      forced.map(i => (i % W2) + ',' + Math.floor(i / W2)).join(' '));
    placePlayer(140, 82);                       // exactly where the return portal drops you
  } else {
    // Start from the first walkable tile the flood can spread out of.
    let placed = false;
    for (let i = 0; i < MAP.width * MAP.height && !placed; i += 13) {
      const x = i % W2, y = (i - x) / W2;
      placePlayer(x, y);
      if (count(BMA.Nav.flood(false).dist) > 50) placed = true;
    }
  }
  const f = BMA.Nav.flood(false);
  const bad = [];
  for (let i = 0; i < f.dist.length; i += 37) {
    if (f.dist[i] === -1) continue;
    const x = i % W2, y = (i - x) / W2;
    const route = BMA.Nav.pathTiles(x, y);
    if (!route) continue;
    for (let k = 0; k < route.length - 1; k++) {
      if (!wp.forced[route[k][1] * W2 + route[k][0]]) continue;
      if (route[k + 1][2]) continue;            // the next tile IS its warp: taking it, not crossing it
      if (route[k][2]) continue;                // a warp put them here: standing on it, free to step off
      if (k === 0) continue;                    // already standing there when the route was asked for
      bad.push(`to ${x},${y} walks off ${route[k][0]},${route[k][1]}`);
    }
  }
  check(`${label}: no route walks across a forced warp`, bad.length === 0,
    bad.slice(0, 3).join(' | '));
}

// ---------------------------------------------------------------------------
// Mimics — a chest that turns out to be a monster
// ---------------------------------------------------------------------------
//
// The game shouts "Monster-in-a-box!" once it is too late, and that is the whole point: nothing
// distinguishes one beforehand. Every one has to reach the treasure list as a plain numbered
// chest, or a blind player finds them by elimination.
console.log('\n=== mimics ===');
const boxes = [];
for (let id = 1; id < $dataMapInfos.length; id++) {
  const f = path.join(DATA, 'Map' + String(id).padStart(3, '0') + '.json');
  if (!fs.existsSync(f)) continue;
  const m = JSON.parse(fs.readFileSync(f, 'utf8'));
  if (!m.events) continue;
  const named = m.events.filter(Boolean).filter(ev => {
    const p = ev.pages[0];
    if (!p) return false;
    return /monster.?in.?a.?box/i.test((p.list || [])
      .filter(c => c.code === 401 || c.code === 405)
      .map(c => String(c.parameters[0])).join(' '));
  });
  if (!named.length) continue;
  loadMap(id);
  for (const ev of named) {
    const e = BMA.Nav.entities.find(q => q.ev.eventId() === ev.id);
    boxes.push({ id, ev: ev.id, cat: e ? e.category : 'DROPPED', name: e ? e.name : '-' });
  }
}
check('every mimic in the game is found', boxes.length === 31, boxes.length);
check('and each is a plain numbered chest',
  boxes.every(b => b.cat === 'treasure' && /^Chest \d+$/.test(b.name)),
  boxes.filter(b => b.cat !== 'treasure' || !/^Chest \d+$/.test(b.name))
       .map(b => 'map' + b.id + ' ' + b.cat + ' "' + b.name + '"').join(', '));

// CHEST_TILES is derived data living in source, which is the kind of thing that rots silently.
// Re-derive it from the game and insist it still matches: a content patch that redraws a chest
// should fail here rather than quietly un-hide five mimics.
const REWARD = new Set([125, 126, 127, 128]);
const derived = {};
for (let id = 1; id < $dataMapInfos.length; id++) {
  const f = path.join(DATA, 'Map' + String(id).padStart(3, '0') + '.json');
  if (!fs.existsSync(f)) continue;
  const m = JSON.parse(fs.readFileSync(f, 'utf8'));
  if (!m.events) continue;
  for (const ev of m.events.filter(Boolean)) {
    for (const p of ev.pages || []) {
      const img = p.image || {};
      if (p.trigger !== 0 || img.characterName || !(img.tileId > 0)) continue;
      const codes = new Set((p.list || []).map(c => c.code));
      if (![...codes].some(c => REWARD.has(c)) || codes.has(301)) continue;
      const t = (derived[m.tilesetId] = derived[m.tilesetId] || {});
      t[img.tileId] = (t[img.tileId] || 0) + 1;
    }
  }
}
const rebuilt = {};
for (const ts of Object.keys(derived)) {
  const ids = Object.keys(derived[ts]).map(Number).filter(t => derived[ts][t] >= 2).sort((a, b) => a - b);
  if (ids.length) rebuilt[ts] = ids;
}
check('CHEST_TILES still matches the game data',
  JSON.stringify(rebuilt) === JSON.stringify(BMA.Nav.CHEST_TILES),
  're-derived ' + Object.keys(rebuilt).length + ' tilesets vs ' +
  Object.keys(BMA.Nav.CHEST_TILES).length + ' in source');

// ---------------------------------------------------------------------------
// Objects that name themselves from something other than a verb phrase
// ---------------------------------------------------------------------------
//
// Four more places an anonymous event says what it is, each one the only description of that
// object anywhere in the data. Before these, all of it cycled as "Object N".
console.log('\n=== objects named from script shape ===');
{
  // A page whose only act is calling a common event IS that common event. The editor named these
  // "Infinitarium Chests" and "Miasma Stream Chest 1" — so they are chests, they belong with the
  // treasure, and the trailing index in the common event's name is not part of what they are.
  loadMap(508);                                   // Infinitarium / Forest 1
  const inf = BMA.Nav.entities.filter(e => /^Infinitarium chest \d+$/.test(e.name));
  check('the Infinitarium chests name themselves', inf.length === 4, inf.length);
  check('and are filed as treasure, not objects',
    inf.every(e => e.category === 'treasure'),
    inf.map(e => e.category).join(', '));

  loadMap(137);                                   // Miasma Stream / First Tier / Map 1
  const mia = BMA.Nav.entities.filter(e => /^Miasma Stream chest \d+$/.test(e.name));
  check('the Miasma Stream chests name themselves', mia.length === 6, mia.length);
  check('and are filed as treasure too',
    mia.every(e => e.category === 'treasure'), mia.map(e => e.category).join(', '));
  // The way back out asks a question and offers a choice; no verb governs a noun anywhere in it,
  // so the prompt has to be taken whole.
  check('a question prompt becomes the name',
    BMA.Nav.entities.some(e => /^Return to the surface/.test(e.name)),
    BMA.Nav.entities.filter(e => e.category === 'interactable').map(e => e.name).join(', '));

  // No words at all — the move route plays "Minecart" and that is the only place the word is.
  loadMap(488);
  const carts = BMA.Nav.entities.filter(e => /^Minecart \d+$/.test(e.name));
  check('Mythril Mine names its mine carts', carts.length === 42, carts.length);

  // Input Number is what makes a console a console; the text carries no noun to take.
  loadMap(285);
  const consoles = BMA.Nav.entities.filter(e => /^Security console/.test(e.name));
  check('the Fey Spire consoles are named', consoles.length === 3, consoles.length);

  // The posted codes are signs — text and a sound and nothing else — so they name themselves.
  // But a sign identifies itself, it does not read itself out: the number stays behind the
  // interaction, exactly as it does for a sighted player who has to walk up to the plaque.
  const posted = BMA.Nav.entities.filter(e => /^Security Code/.test(e.name));
  check('the posted codes are named', posted.length === 2,
        BMA.Nav.entities.filter(e => e.category === 'interactable').map(e => e.name).join(', '));
  check('and none of them gives the code away',
        !BMA.Nav.entities.some(e => /\b(324|735|591)\b/.test(e.name)),
        BMA.Nav.entities.map(e => e.name).join(', '));
  // Two on this map, so they are numbered; map 259 has one and leaves it bare.
  check('two on one map are told apart',
        new Set(posted.map(e => e.name)).size === 2, posted.map(e => e.name).join(', '));
  loadMap(259);
  check('a lone one is not numbered',
        BMA.Nav.entities.some(e => e.name === 'Security Code'),
        BMA.Nav.entities.filter(e => e.category === 'interactable').map(e => e.name).join(', '));

  // The spoiler rule still governs everything above it: a common event that fights you must not
  // become a named object, and a lone boss behind an action button stays anonymous.
  loadMap(611);
  check('a battle behind an action button is still not named for the fight',
    BMA.Nav.entities.filter(e => e.category === 'enemy').every(e => !/Ragnarok|Darkness/i.test(e.name)),
    BMA.Nav.entities.map(e => e.name).join(', '));
}

// ---------------------------------------------------------------------------
// Props drawn on a character sheet
// ---------------------------------------------------------------------------
//
// MV has one notion of "drawn with a character sheet" and the mod reads it as "a person is
// standing here". BPR_008 is a townsfolk sheet — Hunter, Nurse, Pirate, Taol, Dion, Hans — whose
// frame 4 is a glowing rune, so 26 events that are plainly objects were filed as people or as
// enemies. PROP_SPRITES withholds hasSprite from those, and nothing else.
console.log('\n=== props are not people ===');
{
  const named = id => { loadMap(id); return BMA.Nav.entities; };
  const at = (list, ev) => list.find(e => e.ev && e.ev.eventId() === ev);

  // Gulgur Volcano's five sealing glyphs speak with Elina's tag when she dispels them, so all
  // five were called "Elina" — on a map where Elina is also in the party.
  const volcano = named(53).filter(e => /^Glyph/.test(e.name));
  check('the five sealing glyphs are glyphs', volcano.length === 5, volcano.length);
  check('  numbered, not all the same word',
    new Set(volcano.map(e => e.name)).size === 5, volcano.map(e => e.name).join(' '));
  check('  and none of them is Elina',
    !named(53).some(e => e.name === 'Elina'),
    named(53).filter(e => e.name === 'Elina').length);

  // The twelve that start a fight. Same sprite as the harmless ones, and nothing on the map says
  // which is which, so the enemies list must not either — the sarcophagus rule.
  for (const [id, ev] of [[118, 55], [400, 171], [606, 2], [568, 50]]) {
    const e = at(named(id), ev);
    check(`map ${id} ev${ev}: a fighting glyph is an object, not an enemy`,
      !!e && e.category === 'interactable', e && e.category + '/' + e.name);
    check('  and is called a glyph', !!e && /^Glyph/.test(e.name), e && e.name);
  }

  // Anything that says what it is beats the sprite: the sprite name is the last thing tried.
  const rift = at(named(476), 1);
  check('a prop that names itself keeps its own name',
    !!rift && rift.name === 'Teleport to the Rift Shrine', rift && rift.name);
  const shard = at(named(537), 4);
  check('the Aether Crystal Shard is named from LABELS, not as a glyph',
    !!shard && shard.name === 'Aether Crystal Shard', shard && shard.name);
  const clock = at(named(293), 11);
  check('Life Shrine\'s clock centre is named to match "Return to the center"',
    !!clock && clock.name === 'Clock center', clock && clock.name);
  check('  and it is an object, not an NPC',
    !!clock && clock.category === 'interactable', clock && clock.category);

  // The narrow scope. Refusing every party-actor speaker instead of only those on a prop renames
  // 22 real people: Biggs and Wedge in the Quarters, Brindle in his own hovel, Ovelia in her
  // hidden abode. A party member standing on a map IS the person standing there.
  const biggs = at(named(12), 23);
  check('a party member standing on a map keeps their name',
    !!biggs && biggs.name === 'Biggs', biggs && biggs.category + '/' + biggs.name);
  const brindle = at(named(251), 12);
  check('  Brindle too, in his own hovel',
    !!brindle && brindle.name === 'Brindle', brindle && brindle.name);

  // The other half of "not a person": an event that draws nothing at all. Aether Mine's (140,79)
  // is the party working out what Atomos is — an invisible touch tile that hands over an item at
  // the end, so it is filed as treasure, and it was called "Vahn" after the party leader.
  const mine = at(named(110), 204);
  check('an invisible cutscene tile is not named after the party leader',
    !!mine && mine.name !== 'Vahn', mine && mine.name);
  // Nor is it a chest. Nothing is drawn on the tile: it is the scene, and the item is its last
  // line. See the 'event' category.
  check('  it is a scripted scene, not treasure', !!mine && mine.category === 'event',
    mine && mine.category);
  // Not one of the seventeen has a graphic; every party-named NPC has a sprite. That is the line.
  const invisible = [[23, 3], [92, 156], [364, 108], [410, 7], [581, 8]];
  for (const [id, ev] of invisible) {
    const e = at(named(id), ev);
    check(`map ${id} ev${ev}: no party name on a graphic-less event`,
      !!e && !BMA.Nav._isPartyActor(e.name), e && e.category + '/' + e.name);
  }
}

// ---------------------------------------------------------------------------
// A sound only names something you can see
// ---------------------------------------------------------------------------
//
// _routeSoundName exists for Mythril Mine's 46 mine carts, whose move route plays "Minecart" and
// does nothing else — the SE name is the only place the word exists in the data. Across the whole
// game it produced five distinct names, and two of them were filenames.
console.log('\n=== names taken from a sound ===');
{
  let carts = 0;
  for (const id of [487, 488]) {                  // Mythril Mine, 4 on the upper floor and 42 below
    loadMap(id);
    carts += BMA.Nav.entities.filter(e => /^Minecart/.test(e.name)).length;
  }
  check('the mine carts still name themselves', carts === 46, carts);

  loadMap(581);                                   // Malacore: route SE "ff6fall"
  const mal = BMA.Nav.entities.find(e => e.ev && e.ev.eventId() === 8);
  check('a filename with a digit in it names nothing',
    !!mal && !/ff6fall/i.test(mal.name), mal && mal.name);
  loadMap(263);                                   // route SE "Jump"
  const jump = BMA.Nav.entities.find(e => e.ev && e.ev.eventId() === 2);
  check('nor does a sound that describes the act', !!jump && jump.name !== 'Jump',
    jump && jump.name);
}

// ---------------------------------------------------------------------------
// Scripted scenes
// ---------------------------------------------------------------------------
//
// An invisible tile that talks when you walk onto it and then fights you or hands something over
// is a plot trigger, not a thing. They were filed as whatever their last line did.
console.log('\n=== scripted scenes ===');
{
  const evs = id => { loadMap(id); return BMA.Nav.entities.filter(e => e.category === 'event'); };

  check('Aether Mine has exactly one', evs(110).length === 1, evs(110).length);
  check('  at the tile that carries the Atomos scene',
    evs(110).some(e => e.x === 140 && e.y === 79),
    evs(110).map(e => e.x + ',' + e.y).join(' '));
  // Its 92 MP drains are invisible walk-on tiles too, and they are traps, answered first.
  loadMap(110);
  check('  and its 92 traps are untouched',
    BMA.Nav.entities.filter(e => e.category === 'trap').length === 92,
    BMA.Nav.entities.filter(e => e.category === 'trap').length);

  // A transfer is a doorway however much it talks, and a silent ambush is not a scene.
  loadMap(55);
  const silent = BMA.Nav.entities.filter(e => e.category === 'enemy' &&
    [34, 35, 36, 37].indexOf(e.ev.eventId()) >= 0);
  check('a fight with no dialogue stays an enemy', silent.length === 4, silent.length);

  // The MogNet signposts on the Overworld talk and are invisible, but do nothing at the end.
  // They are read out as you pass and are not destinations; the rule must not collect them.
  loadMap(1);
  check('the Overworld GPS signposts are not listed',
    !BMA.Nav.entities.some(e => e.category === 'event' && e.ev.eventId() <= 11),
    BMA.Nav.entities.filter(e => e.category === 'event' && e.ev.eventId() <= 11)
      .map(e => e.ev.eventId()).join(' '));

  // ---- and the name must not say what jumps out ----
  //
  // The first speaker names an entity everywhere else in the mod, and here it is the worst
  // answer available: 20 of the 35 open with a boss line, so the tile read "Yiazmat 2",
  // "Ultros 2", "Gilgamesh 2", "Archareon 1". The tile is invisible — a sighted player walks the
  // corridor and sees nothing, so that is a warning nobody else gets.
  const SAFE = /^(Party conversation|Conversation|Scene)( \d+)?$/;
  const named = [];
  for (const [id, ev, who] of [[608, 3, 'Yiazmat'], [392, 21, 'Ultros'], [161, 18, 'Gilgamesh'],
                               [317, 31, 'Archareon'], [310, 3, 'Leviathan'], [296, 2, '??????'],
                               [427, 34, 'Agammon'], [571, 32, 'Gylfi'], [127, 18, 'Garuda']]) {
    loadMap(id);
    const e = BMA.Nav.entities.find(x => x.ev && x.ev.eventId() === ev);
    if (!e || !SAFE.test(e.name)) named.push(id + '/' + ev + ' "' + (e ? e.name : 'missing') + '"');
    if (e && new RegExp(who.replace(/\?/g, '\\?'), 'i').test(e.name)) named.push(id + '/' + ev + ' names ' + who);
  }
  check('no scene is named after whoever speaks first', named.length === 0, named.join(' | '));

  // Who is talking is the one thing that is safe to say, at the coarsest grain worth hearing.
  loadMap(110);
  const atomos = BMA.Nav.entities.find(e => e.category === 'event');
  check('a scene only the party speaks in says so',
    !!atomos && atomos.name === 'Party conversation', atomos && atomos.name);
  loadMap(608);
  const yiaz = BMA.Nav.entities.find(e => e.category === 'event');
  check('one with an outsider in it does not', !!yiaz && yiaz.name === 'Conversation',
    yiaz && yiaz.name);
  loadMap(327);
  const narration = BMA.Nav.entities.find(e => e.category === 'event');
  check('and untagged narration is just a scene',
    !!narration && narration.name === 'Scene', narration && narration.name);

  // Numbered only where there is more than one: Branch Castle has three, Aether Mine one.
  loadMap(317);
  const three = BMA.Nav.entities.filter(e => e.category === 'event').map(e => e.name).sort();
  check('three on one map are told apart',
    three.join(',') === 'Conversation 1,Conversation 2,Conversation 3', three.join(','));
}

// ---------------------------------------------------------------------------
// A map with no traps and no walkable stone must pay nothing and behave exactly as before.
// ---------------------------------------------------------------------------
console.log('\n=== a map with nothing to avoid ===');
loadMap(34);
placePlayer(10, 10);
check('no traps classified', BMA.Nav.entities.every(e => e.category !== 'trap'));
check('trapOnPath finds nothing', BMA.Nav.trapOnPath([[10, 10], [11, 10]]) === null);
// Stone lives in the strict flood, so it never splits the two: only a trap does.
check('the safe flood is the strict flood itself',
  BMA.Nav.flood(false, true) === BMA.Nav.flood(false));

// ---------------------------------------------------------------------------
// Walls are ground, as far as the engine is concerned
// ---------------------------------------------------------------------------
//
// Every tileset in this game leaves its A4 block on the editor's default passability, which is
// passable, so the stone the maps are built out of can be walked on. It stays invisible while
// the rooms are sealed and shows the moment a warp lands the player beside it: the route from
// Life Shrine's entrance to its clock room came out as 210 steps that left the shrine, ran east
// along the top of a wall for 127 tiles, and crossed a map exit on the way.
console.log('\n=== walls are not ground ===');
loadMap(293);
const wallMask = BMA.Nav._wallGround();
check('Life Shrine has walkable stone', !!wallMask);
const wallCount = wallMask ? wallMask.reduce((n, v) => n + v, 0) : 0;
check('  and most of the map is made of it', wallCount > 10000, wallCount);
check('  the arrival tile is not', !!wallMask && !wallMask[62 * MAP.width + 20]);
check('  the tile the route escaped through is', !!wallMask && !!wallMask[62 * MAP.width + 28]);
const onStone = t => !!wallMask[t[1] * MAP.width + t[0]];

BMA.Nav._arrival = { mapId: 293, x: 20, y: 62 };
placePlayer(20, 62);                              // where map 260 puts the player
const clockRoute = BMA.Nav.pathTiles(119, 55);    // the clock pedestal
check('a route to the clock room exists', !!clockRoute);
check('  and it goes through the pads',
  !!clockRoute && clockRoute.filter(t => t[2]).length >= 5,
  clockRoute && clockRoute.filter(t => t[2]).length);
// Stone is terrain, not a preference: there is no flood that walks over it, so neither the
// strict route nor the trap-avoiding one may step through the shrine's walls.
for (const [label, tiles] of [['safe', clockRoute], ['strict', BMA.Nav._pathVia(119, 55, false, false)]])
  check('  the ' + label + ' route keeps off the stone',
    !!tiles && tiles.every(t => !onStone(t)),
    tiles && tiles.filter(onStone).slice(0, 3).map(t => t[0] + ',' + t[1]).join(' '));

// Entered, though — something can be standing on stone, and the route has to be able to end
// there. It may only ever be the last tile.
const walkedThrough = [];
const ff = BMA.Nav.flood(false);
for (let i = 0; i < ff.dist.length; i += 7) {
  if (ff.dist[i] === -1) continue;
  const x = i % MAP.width, y = (i - x) / MAP.width;
  const r = BMA.Nav.pathTiles(x, y);
  if (!r) continue;
  for (let k = 0; k < r.length - 1; k++) if (onStone(r[k]) && k > 0) walkedThrough.push(x + ',' + y);
}
check('  no route crosses stone to get anywhere', walkedThrough.length === 0,
  walkedThrough.slice(0, 3).join(' | '));

// The east wing is behind a map exit, not behind a wall walk: the honest answer from the
// entrance is that there is no route to it on this map.
check('  the east wing is not reachable by walking',
  BMA.Nav.pathTiles(173, 45) === null);

console.log(fails ? `\n  ${fails} CHECK(S) FAILED` : '\n  all checks passed');
process.exit(fails ? 1 : 0);
