// Behaviour checks on the riskiest new logic: the flood's event-index monkey-patch,
// the mutually-exclusive keysets, the wall-bump rate limit, and category-switch phrasing.
const fs = require('fs'), path = require('path'), vm = require('vm');
const { SRC } = require('./_paths');

global.window = global;
global.document = { addEventListener() {} };
global.require = require;
let clock = 0;
global.performance = { now: () => clock };

// --- tiny fake map: 8x6, a wall column at x=3 (except y=2), one event at (5,4) ---
const W = 8, H = 6;
function mkEvent(x, y, priority) {
  return { _x: x, _y: y, x, y, _priorityType: priority,
    pos(px, py) { return this._x === px && this._y === py; },
    posNt(px, py) { return this.pos(px, py) && this._priorityType === 1; },
    isNormalPriority() { return this._priorityType === 1; } };
}
const EVENTS = [mkEvent(5, 4, 1), mkEvent(1, 1, 0)];
global.$gameMap = {
  mapId: () => 1, width: () => W, height: () => H, displayName: () => 'Testville',
  events: () => EVENTS.slice(),
  eventsXy(x, y) { return this.events().filter(e => e.pos(x, y)); },
  eventsXyNt(x, y) { return this.events().filter(e => e.posNt(x, y)); },
};
global.$gamePlayer = {
  x: 0, y: 0, direction: () => 2,
  canPass(x, y, d) {
    const nx = x + (d === 6 ? 1 : d === 4 ? -1 : 0);
    const ny = y + (d === 2 ? 1 : d === 8 ? -1 : 0);
    if (nx < 0 || ny < 0 || nx >= W || ny >= H) return false;
    if (nx === 3 && ny !== 2) return false;                       // wall column
    return $gameMap.eventsXyNt(nx, ny).length === 0;              // blocked by the event
  },
};
global.$dataMapInfos = [null, { id: 1, name: 'Testville', parentId: 0 }];
global.$dataActors = [null, { name: 'Vahn' }];
global.$gameVariables = { value: () => 0 };
global.$gameActors = { actor: () => null };
global.$gameParty = { members: () => [] };

for (const f of ['BMA_Core.js', 'BMA_Text.js', 'BMA_Menus.js', 'BMA_Nav.js']) {
  vm.runInThisContext(fs.readFileSync(path.join(SRC, f), 'utf8'), { filename: f });
}

let fails = 0;
function check(name, cond, extra) {
  if (cond) console.log('  ok   ' + name);
  else { fails++; console.log('  FAIL ' + name + (extra !== undefined ? '  -> ' + extra : '')); }
}

// ---------- 1. flood: identical result with and without the index ----------
console.log('\n=== flood / event index ===');
const plainEvents = $gameMap.events, plainXy = $gameMap.eventsXy, plainXyNt = $gameMap.eventsXyNt;

BMA.Nav._clearFloods();
const f1 = BMA.Nav.flood();
check('$gameMap.events restored', $gameMap.events === plainEvents);
check('$gameMap.eventsXy restored', $gameMap.eventsXy === plainXy);
check('$gameMap.eventsXyNt restored', $gameMap.eventsXyNt === plainXyNt);

// Reference BFS using the untouched engine lookups.
const ref = new Int32Array(W * H).fill(-1);
{
  ref[0] = 0; const q = [0];
  const D = [[0, -1, 8], [0, 1, 2], [1, 0, 6], [-1, 0, 4]];
  for (let qi = 0; qi < q.length; qi++) {
    const cur = q[qi], cx = cur % W, cy = (cur - cx) / W;
    for (const [dx, dy, d] of D) {
      const nx = cx + dx, ny = cy + dy;
      if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
      const ni = ny * W + nx;
      if (ref[ni] !== -1) continue;
      if (!$gamePlayer.canPass(cx, cy, d)) continue;
      ref[ni] = ref[cur] + 1; q.push(ni);
    }
  }
}
let same = true;
for (let i = 0; i < W * H; i++) if (ref[i] !== f1.dist[i]) same = false;
check('indexed BFS matches unindexed BFS exactly', same);
check('event tile (5,4) is unreachable in both', ref[4 * W + 5] === -1 && f1.dist[4 * W + 5] === -1);
check('gap at (3,2) is reachable', f1.dist[2 * W + 3] !== -1);
// (4,0) is only reachable by detouring through the gap, so its cost must beat straight-line.
check('wall column forces a detour to (4,0)', f1.dist[0 * W + 4] === 8, f1.dist[0 * W + 4]);

// restore must survive an exception thrown inside the callback
try { BMA.Nav._withEventIndex(W, function () { throw new Error('boom'); }); } catch (e) {}
check('lookups restored after a throw', $gameMap.eventsXy === plainXy && $gameMap.events === plainEvents);

// ---------- 1b. a blocking event in the only gap ----------
//
// MV blocks any tile holding a normal-priority event, and canPass blocks entering such a tile but
// never leaving it — so an event tile is a sink, not a bridge. Drop one into the single gap in the
// wall column and the whole right-hand side of the map goes unreachable, which is what made towns
// answer "no path found" for every destination while the player could walk there perfectly well.
console.log('\n=== blocking event severs the map ===');
const GATE = mkEvent(3, 2, 1);                       // a door/guard standing in the gap
EVENTS.push(GATE);
BMA.Nav._clearFloods();
BMA.Nav.entities = [{ x: 3, y: 2, name: 'Guard', category: 'npc' }];

const strict = BMA.Nav.flood();
const relaxed = BMA.Nav.flood(true);
const RIGHT = 1 * W + 5;                             // (5,1), right of the wall
check('strict flood cannot reach past the blocked gap', strict.dist[RIGHT] === -1);
check('relaxed flood reaches it', relaxed.dist[RIGHT] !== -1, relaxed.dist[RIGHT]);
check('the two floods are cached separately', strict !== relaxed && strict.dist !== relaxed.dist);

check('pathTiles finds nothing strictly', BMA.Nav.pathTiles(5, 1) === null);
const viaTiles = BMA.Nav.pathTiles(5, 1, true);
check('pathTiles finds a relaxed route', !!viaTiles && viaTiles.length > 1,
      viaTiles && viaTiles.length);
check('the relaxed route runs through the gap',
      !!viaTiles && viaTiles.some(t => t[0] === 3 && t[1] === 2));

const blocker = BMA.Nav.blockerOnPath(viaTiles);
check('blockerOnPath names what is standing in the route',
      !!blocker && blocker.name === 'Guard' && blocker.x === 3 && blocker.y === 2,
      JSON.stringify(blocker));

// The path filter must hide only what there is genuinely no route to, which is the whole point
// of it being relaxed — a destination behind an NPC is still somewhere you can get to.
check('reachable() is relaxed, so the filter keeps it',
      BMA.Nav.reachable({ x: 5, y: 1 }) === true);

// An entity ON the blocked tile is still reachable — you stand next to it to interact.
check('the blocking event itself is reachable (stand adjacent)',
      BMA.Nav.reachable({ x: 3, y: 2 }) === true);

EVENTS.pop();
BMA.Nav._clearFloods();

// ---------- 1c. _goalIndex accepts a diagonal approach ----------
//
// Movement is 4-directional, but standing is not: a chest in an alcove may only be approachable
// from the diagonal, and orthogonal-only made those permanently unreachable.
console.log('\n=== _goalIndex approach tiles ===');
{
  const dist = new Int32Array(W * H).fill(-1);
  dist[0] = 0;
  dist[2 * W + 2] = 7;                               // (2,2) — diagonal neighbour of (3,3) only
  BMA.Nav._floods.strict = { key: $gameMap.mapId() + ',' + $gamePlayer.x + ',' + $gamePlayer.y,
                             w: W, h: H, dist: dist, prev: new Int32Array(W * H).fill(-1) };
  check('diagonal-only approach resolves', BMA.Nav._goalIndex(3, 3) === 2 * W + 2,
        BMA.Nav._goalIndex(3, 3));
  check('nothing adjacent at all still fails', BMA.Nav._goalIndex(7, 5) === -1);

  // ...but a diagonal is a tile the player can STAND on, not one they can act from. Facing is
  // 4-directional and checkEventTriggerThere reads the single tile ahead, so from a diagonal no
  // direction points at the target and the action button does nothing. A nearer diagonal must
  // therefore still lose to a further orthogonal. Mount Ozma's two chests sit side by side over a
  // corridor entered from the side, which ranked the diagonal first and left both unopenable with
  // no switch, no blocker and nothing to explain it.
  //
  // The flood is cached under a key this block already installed, so mutating dist in place is
  // what _goalIndex will read — clearing here would recompute it from the fake map instead.
  dist[3 * W + 2] = 12;                              // (2,3) — orthogonal, and further away
  check('an orthogonal approach beats a nearer diagonal',
        BMA.Nav._goalIndex(3, 3) === 3 * W + 2, BMA.Nav._goalIndex(3, 3));
  dist[3 * W + 2] = -1;
  check('the diagonal is still the fallback once it is the only approach',
        BMA.Nav._goalIndex(3, 3) === 2 * W + 2, BMA.Nav._goalIndex(3, 3));
}
BMA.Nav._clearFloods();

// ---------- 1d. a throwing canPass must not leave a stale flood ----------
//
// 78 plugins alias canPass here. The old code let the exception escape and kept the PREVIOUS
// position's flood in the cache, so the mod went on answering questions about where the player
// used to be standing.
console.log('\n=== flood failure is not stale ===');
{
  const good = BMA.Nav.flood();
  check('a good flood reached somewhere', good.dist.some(d => d > 0));
  const realCanPass = $gamePlayer.canPass;
  $gamePlayer.canPass = () => { throw new Error('plugin alias exploded'); };
  $gamePlayer.x = 1;                                  // move, so the cache key changes
  BMA.Nav._clearFloods();
  const bad = BMA.Nav.flood();
  check('the failed flood is flagged', bad.failed === true);
  check('and reaches nothing rather than reusing the old answer',
        bad.dist.every(d => d === -1), bad.dist.filter(d => d !== -1).length);
  check('pathTiles degrades to null, it does not throw', BMA.Nav.pathTiles(5, 1) === null);
  check('reachable() fails open so destinations are not silently hidden',
        BMA.Nav.reachable({ x: 5, y: 1 }) === true);
  $gamePlayer.canPass = realCanPass;
  $gamePlayer.x = 0;
  BMA.Nav._clearFloods();
}

// ---------- 2. keysets are mutually exclusive ----------
console.log('\n=== nav keysets ===');
BMA.Config.navKeyset = 'classic';
check('classic: j/l/k live', ['prevDest', 'nextDest', 'reannounce'].every(a => BMA.Input.isActive(a)));
check('classic: [ ] \\ dead', ['prevDestAlt', 'nextDestAlt', 'directionsAlt'].every(a => !BMA.Input.isActive(a)));
BMA.Config.navKeyset = 'bracket';
check('bracket: [ ] \\ live', ['prevDestAlt', 'nextDestAlt', 'directionsAlt'].every(a => BMA.Input.isActive(a)));
check('bracket: j/l/k dead', ['prevDest', 'nextDest', 'reannounce'].every(a => !BMA.Input.isActive(a)));
BMA.Config.navKeyset = 'lefthand';
check('lefthand: the Lh set is live',
  ['prevDestLh', 'nextDestLh', 'reannounceLh', 'directionsLh'].every(a => BMA.Input.isActive(a)));
check('lefthand: the other two sets are dead',
  ['prevDest', 'nextDest', 'reannounce', 'prevDestAlt', 'nextDestAlt', 'directionsAlt']
    .every(a => !BMA.Input.isActive(a)));
// 'directions' is the shared p key, and isActive() special-cases it: classic and bracket share
// it, but lefthand has its own directionsLh, so p must go dead there rather than double-binding.
check('p (directions) shared by classic and bracket', ['classic', 'bracket'].every(ks => {
  BMA.Config.navKeyset = ks; return BMA.Input.isActive('directions');
}));
BMA.Config.navKeyset = 'lefthand';
check('p (directions) hands over to directionsLh under lefthand',
  !BMA.Input.isActive('directions') && BMA.Input.isActive('directionsLh'));

// The path-filter toggle is per-keyset like the rest of nav (shift+p classic, shift+\ bracket,
// shift+f lefthand). It stopped being a keyset-independent binding when the left-handed set was
// added, so the old "shift+p / ctrl+p unaffected" assertion was testing a design that no longer
// exists. Assert the real invariant instead: exactly one variant answers per keyset.
const pathVariants = ['togglePathFilter', 'togglePathFilterAlt', 'togglePathFilterLh'];
check('every path-filter variant is a real binding',
  pathVariants.every(a => a in BMA.Config.keys),
  pathVariants.filter(a => !(a in BMA.Config.keys)).join(', '));
for (const ks of ['classic', 'bracket', 'lefthand']) {
  BMA.Config.navKeyset = ks;
  const live = pathVariants.filter(a => BMA.Input.isActive(a));
  check(ks + ': exactly one path-filter toggle is live', live.length === 1, live.join(', ') || 'none');
}
// ctrl+p was dropped in 0b5235f. isActive() answers true for any action it has never heard of,
// so the old assertion on it passed vacuously — check the binding table, not isActive().
check('the removed ctrl+p binding is really gone', !('toggleLayerFilter' in BMA.Config.keys));

BMA.Config.navKeyset = 'classic';

// ---------- 3. wall-bump rate limit ----------
console.log('\n=== wall bump rate limit ===');
let plays = 0;
BMA.Audio.play = function () { plays++; };
BMA.Config.wallTones = true;
BMA.Nav.clearBump();
clock = 0;
for (let frame = 0; frame < 300; frame++) { BMA.Nav.wallBump(); clock += 1000 / 60; }  // 5 s held
check('5 s against one wall fires ~20 times, not 300', plays >= 18 && plays <= 22, plays);
plays = 0; BMA.Nav.clearBump();
BMA.Nav.wallBump();
$gamePlayer.direction = () => 6;      // turn into a different wall
BMA.Nav.wallBump();
check('a new direction bumps immediately', plays === 2, plays);
$gamePlayer.direction = () => 2;

// shouldBump() is what the per-frame hook consults before allocating a closure and scheduling a
// deferred task, so it has to agree with wallBump()'s own limiter.
BMA.Nav.clearBump();
clock = 0;
check('shouldBump allows the first bump', BMA.Nav.shouldBump() === true);
BMA.Nav.wallBump();
check('and refuses the next frame', BMA.Nav.shouldBump() === false);
clock += BMA.Nav.BUMP_INTERVAL + 1;
check('and allows it again after the interval', BMA.Nav.shouldBump() === true);
BMA.Config.wallTones = false;
check('and refuses outright when wall tones are off', BMA.Nav.shouldBump() === false);
BMA.Config.wallTones = true;

// ---------- 3b. wall directions are computed once per tile ----------
//
// Each canPass here rebuilds and scans the whole event array (twice) plus the region lookups from
// YEP_RegionRestrictions, four times per step, on the main thread between frames. That -- not the
// Web Audio nodes -- is what made movement stutter when two tones and a footstep landed together.
console.log('\n=== wall direction memo ===');
{
  const realCanPass = $gamePlayer.canPass;
  let calls = 0;
  $gamePlayer.canPass = function (x, y, d) { calls++; return realCanPass.call(this, x, y, d); };

  $gamePlayer.x = 2; $gamePlayer.y = 2;
  BMA.Nav._clearFloods();
  const first = BMA.Nav.blockedDirections();
  const afterFirst = calls;
  for (let i = 0; i < 20; i++) BMA.Nav.blockedDirections();
  check('recomputed once per tile, not once per call', calls === afterFirst, calls - afterFirst);
  check('at most one canPass per direction', afterFirst <= 4, afterFirst);
  check('east of (2,2) is the wall gap, so not blocked', first.indexOf('e') === -1,
        JSON.stringify(first));

  $gamePlayer.y = 1;                                  // (2,1): east is the wall column
  const second = BMA.Nav.blockedDirections();
  check('moving recomputes', calls > afterFirst);
  check('and east is now a wall', second.indexOf('e') !== -1, JSON.stringify(second));

  // An NPC stepping aside changes the answer without the player moving, which is what
  // _clearFloods is for.
  const before = calls;
  BMA.Nav._clearFloods();
  BMA.Nav.blockedDirections();
  check('_clearFloods drops the memo too', calls > before);

  $gamePlayer.canPass = realCanPass;
  $gamePlayer.x = 0; $gamePlayer.y = 0;
  BMA.Nav._clearFloods();
}

// ---------- 4. category switch phrasing ----------
console.log('\n=== category switch ===');
const said = [];
BMA.TTS.speak = function (t) { said.push(t); };
BMA.Nav.entities = [
  { x: 2, y: 0, category: 'shop', kind: 'Inn', name: 'Inn' },
  { x: 6, y: 0, category: 'exit', kind: 'To Valla', name: 'To Valla' },
];
BMA.Nav.scannedMap = 1;
BMA.Nav.category = 'all'; BMA.Nav.index = 0; BMA.Nav._sel = null;
said.length = 0;
BMA.Nav.switchCategory(1);                                    // all -> exit
check('one utterance per switch', said.length === 1, JSON.stringify(said));
// 10, not 6: the target is 6 tiles east in a straight line but the wall column forces a detour
// through the gap at (3,2), and the step count is now the real walking distance.
check('reads the true walking distance, not the straight line',
      said[0] === 'Exits: To Valla, 10 steps east', said[0]);
said.length = 0;
BMA.Nav.switchCategory(1);                                    // exit -> door (none present)
// A doorway on this map is not a way off it. Its own step, straight after the exits.
check('doors sit between exits and shops',
      said[0] === 'Doors: none', said[0]);
said.length = 0;
// No 'portals' step -- there is no such category -- and no 'crossings' step either: a crossing is
// routed through and named, never cycled to.
BMA.Nav.switchCategory(1);                                    // door -> shop
check('reads "Shops: Inn, 2 steps east"', said[0] === 'Shops: Inn, 2 steps east', said[0]);
said.length = 0;
BMA.Nav.switchCategory(1);                                    // shop -> npc (none present)
check('empty category says "NPCs: none"', said[0] === 'NPCs: none', said[0]);

// ---------- 4c. talking across a counter ----------
//
// MV's checkEventTriggerThere tests isCounter() on the tile you face and, when set, starts the
// event one tile further on -- which is how every shopkeeper behind a service counter is spoken
// to. 489 such events exist across 112 maps in this game; without this they all read as
// unreachable while being perfectly talkable.
console.log('\n=== counter approach ===');
{
  const counters = {};
  $gameMap.isCounter = (x, y) => !!counters[x + ',' + y];

  // Hand-built flood, as in the _goalIndex section above: the shopkeeper stands at (2,4) walled
  // in behind a counter at (2,3), and the ONLY tile the player can stand on is (2,2), two
  // straight steps out. Nothing adjacent to the keeper is reachable, so only the counter rule
  // can resolve it.
  const key = $gameMap.mapId() + ',' + $gamePlayer.x + ',' + $gamePlayer.y;
  function floodWith(reached) {
    const dist = new Int32Array(W * H).fill(-1);
    reached.forEach(([x, y], i) => { dist[y * W + x] = i; });
    return { key, w: W, h: H, dist, prev: new Int32Array(W * H).fill(-1) };
  }
  const keeper = { x: 2, y: 4 };
  BMA.Nav._floods.relaxed = floodWith([[0, 0], [2, 2]]);

  check('without the counter flag the keeper is unreachable',
        BMA.Nav.reachable(keeper) === false);

  counters['2,3'] = true;
  check('with it, the keeper is reachable', BMA.Nav.reachable(keeper) === true);
  check('and the approach tile is two straight steps out, not the counter itself',
        BMA.Nav._goalIndex(2, 4, true) === 2 * W + 2, BMA.Nav._goalIndex(2, 4, true));

  // Straight ahead only, exactly as checkEventTriggerThere does it.
  delete counters['2,3'];
  counters['1,3'] = true;                        // diagonally placed counter
  check('a diagonal counter does not qualify', BMA.Nav.reachable(keeper) === false);

  // And the tile beyond the counter still has to be somewhere the player can actually stand.
  delete counters['1,3'];
  counters['2,3'] = true;
  BMA.Nav._floods.relaxed = floodWith([[0, 0]]);
  check('a counter leading nowhere reachable does not qualify either',
        BMA.Nav.reachable(keeper) === false);

  delete $gameMap.isCounter;
  BMA.Nav._clearFloods();
}

// ---------- 4c-2. the diagnostics dump ----------
//
// Rarely run, so it is exactly the sort of code that rots. Assert it produces the numbers the
// investigation needs rather than throwing.
console.log('\n=== diagnostics dump ===');
{
  const logged = [];
  const realWrite = BMA.Log.write;
  BMA.Log.write = m => logged.push(String(m));
  BMA.Nav.entities = [
    { x: 2, y: 0, category: 'shop', kind: 'Inn', name: 'Inn' },
    { x: 5, y: 4, category: 'npc', kind: null, name: 'Blocked' },
  ];
  BMA.Nav.category = 'all';
  BMA.Nav._clearFloods();
  const summary = BMA.Nav.logDiagnostics();
  BMA.Log.write = realWrite;

  check('returns a spoken summary', /tiles reachable/.test(summary), summary);
  check('reports the flood size and bounding box',
        logged.some(m => /flood strict\s*:\s*\d+ tiles/.test(m)) &&
        logged.some(m => /box \d+,\d+\.\.\d+,\d+/.test(m)), JSON.stringify(logged.slice(0, 6)));
  check('reports both floods', logged.some(m => /flood relaxed/.test(m)));
  check('lists every entity with its approach classes',
        logged.filter(m => /strict\[/.test(m) && /relaxed\[/.test(m)).length === 2,
        JSON.stringify(logged.filter(m => /strict\[/.test(m))));
  check('marks the blocked NPC as reachable via a neighbour, not its own tile',
        logged.some(m => /Blocked/.test(m) && /strict\[-\/adj\//.test(m)),
        JSON.stringify(logged.filter(m => /Blocked/.test(m))));
}

// ---------- 4d. a scan that throws must not look like an empty map ----------
console.log('\n=== scan failure ===');
{
  const realEvents = $gameMap.events;
  const logged = [];
  const realWrite = BMA.Log.write;
  BMA.Log.write = m => logged.push(String(m));
  $gameMap.events = () => { throw new Error('classify exploded'); };
  BMA.Nav.scannedMap = null;
  BMA.Nav.scan();
  check('the throw is logged, not swallowed', logged.some(m => /scan threw/.test(m)),
        JSON.stringify(logged));
  check('and the map is NOT marked scanned', BMA.Nav.scannedMap !== 1, BMA.Nav.scannedMap);
  BMA.Log.write = realWrite;
  $gameMap.events = () => [];                    // trivially successful scan
  BMA.Nav.scan();
  check('a good scan does mark it', BMA.Nav.scannedMap === 1, BMA.Nav.scannedMap);
  $gameMap.events = realEvents;
}
BMA.Nav.category = 'npc';

// ---------- 5. map names ----------
console.log('\n=== map names ===');
check('current() prefers displayName', BMA.MapNames.current() === 'Testville', BMA.MapNames.current());

// ---------- 6. multi-page save points and sealed doors ----------
// Both are built the same way in this game: an inert, blocking page 0 and the real command
// on a later page behind a switch. Judging by the active page alone hides them entirely.
console.log('\n=== multi-page events ===');
function pageOf(codes, opts) {
  opts = opts || {};
  return { trigger: opts.trigger === undefined ? 0 : opts.trigger,
           priorityType: opts.priority === undefined ? 1 : opts.priority,
           image: { characterName: opts.sprite || '', tileId: opts.tile === undefined ? 3 : opts.tile },
           list: codes.map(c => ({ code: c,
                    parameters: c === 201 ? [0, opts.to === undefined ? 20 : opts.to, 5, 5, 0, 0] : [] }))
                      .concat([{ code: 0, parameters: [] }]) };
}
function evWith(pages, name) {
  const data = { id: 1, name: name || 'EV001', x: 4, y: 4, pages: pages };
  return { _erased: false, x: 4, y: 4, _x: 4, _y: 4, page: () => pages[0], event: () => data };
}
let info;
info = BMA.Nav.classify(evWith([pageOf([]), pageOf([352])]));
check('shut save crystal (page 0 inert) is a save point',
      info && info.category === 'savepoint' && info.kind === 'Save point', JSON.stringify(info));
// Where it opens onto is what decides the list, the same as for a doorway already open. A sealed
// door onto THIS map is a door: a player asking where the ways out are should not be read a list
// of things that lead nowhere but here.
info = BMA.Nav.classify(evWith([pageOf([]), pageOf([201], { to: 1 })]));
check('a sealed door onto this map is a door "Closed door"',
      info && info.category === 'door' && info.kind === 'Closed door', JSON.stringify(info));
// ...and one onto another map is a way OFF this map that happens to be shut, so it belongs in the
// list a player checks for the way on. 30 events in the game are one, and all 30 were doors.
info = BMA.Nav.classify(evWith([pageOf([]), pageOf([201], { to: 20 })]));
check('a sealed door onto another map is an exit, still named "Closed door"',
      info && info.category === 'exit' && info.kind === 'Closed door', JSON.stringify(info));
// A destination held in variables cannot be resolved without running the event, and guessing
// "probably off-map" would move a doorway into the exits list on no evidence.
info = BMA.Nav.classify(evWith([pageOf([]), { trigger: 0, priorityType: 1,
  image: { characterName: '', tileId: 3 },
  list: [{ code: 201, parameters: [1, 0, 0, 0, 0, 0] }, { code: 0, parameters: [] }] }]));
check('a sealed door whose destination is in a variable stays a door',
      info && info.category === 'door' && info.kind === 'Closed door', JSON.stringify(info));
info = BMA.Nav.classify(evWith([pageOf([], { tile: 0 }), pageOf([201])]));
check('graphic-less trigger stays unlisted', info === null, JSON.stringify(info));
info = BMA.Nav.classify(evWith([pageOf([101, 401], { sprite: 'BPR_003' }), pageOf([201])]));
check('an NPC who teleports you stays an NPC',
      info && info.category === 'npc', JSON.stringify(info));
info = BMA.Nav.classify(evWith([pageOf([]), pageOf([])]));
check('plain scenery is still excluded', info === null, JSON.stringify(info));

// ---------- 7. naming what blocks an unreachable target ----------
console.log('\n=== blocked route ===');
EVENTS.length = 0;
EVENTS.push(mkEvent(3, 2, 1));          // plug the only gap in the wall column
BMA.Nav._clearFloods();
BMA.Nav.scannedMap = 1;
BMA.Nav.category = 'exit'; BMA.Nav.index = 0; BMA.Nav._sel = null;
BMA.Nav.entities = [
  { x: 3, y: 2, category: 'npc', kind: null, name: 'Gatekeeper' },
  { x: 5, y: 0, category: 'exit', kind: 'To Somewhere', name: 'To Somewhere' },
];
said.length = 0;
BMA.Nav.directions();
// The route still exists — a gatekeeper standing in a doorway is a fact to announce, not grounds
// for refusing to give directions. The blocker leads, because it is the part that changes what
// the player does with the rest of the sentence; the route follows.
check('a blocked target still gets a route',
      /east/.test(said[0]) && said[0].indexOf('no path found') === -1, said[0]);
check('and the thing standing in it is named first',
      /^Gatekeeper is in the way, /.test(said[0]), said[0]);
// The destination is what the player is selected on and just heard announced. Saying it again
// delays the directions they actually have to memorise.
check('the destination name is not repeated',
      said[0].indexOf('To Somewhere') === -1, said[0]);
check('the route runs through the plugged gap',
      (BMA.Nav.pathTiles(5, 0, true) || []).some(t => t[0] === 3 && t[1] === 2),
      JSON.stringify(BMA.Nav.pathTiles(5, 0, true)));
// With the gap open the same target must route normally, so the message above is not just
// a permanent fallback.
EVENTS.length = 0;
BMA.Nav._clearFloods();
said.length = 0;
BMA.Nav.directions();
check('same target routes normally once unblocked',
      said[0] && said[0].indexOf('no path found') === -1, said[0]);
// A clear route opens on the first instruction — no destination, and nothing in the way to
// mention. This is the common case, and it is the one that has to be shortest.
check('a clear route opens with the first step',
      /^(north|south|east|west) \d/.test(said[0]), said[0]);
check('and names neither the destination nor a blocker',
      said[0].indexOf('To Somewhere') === -1 && said[0].indexOf('in the way') === -1, said[0]);

// ---------- 6. warp edges: crossings, cutscene nudges and unpredictable movers ----------
//
// The wall column at x=3 is solid except for the gap at y=2. These build events sitting beside
// it whose move route carries the player over it, which is Conall Curach's shape in miniature.
console.log('\n=== warp edges ===');
{
  // A Set Movement Route command as MV stores it: the route lives in the 205's own parameters.
  const route = (...steps) => ({ code: 205, parameters: [-1, { list: steps.concat([{ code: 0 }]) }] });
  const THROUGH = { code: 37 };
  const WEST = { code: 2 };                                      // ROUTE_STEP: move left
  const jump = (x, y) => ({ code: 14, parameters: [x, y] });
  const RANDOM = { code: 9 };
  const facingWest = { code: 111, parameters: [6, -1, 4] };       // "player is facing left"
  const endIf = { code: 412, parameters: [] };

  function warpEvent(id, x, y, list) {
    const page = { list, trigger: 0, priorityType: 0, image: { characterName: '', tileId: 0 },
                   conditions: {} };
    return Object.assign(mkEvent(x, y, 0), {
      eventId: () => id, page: () => page, event: () => ({ id, name: '', pages: [page] }),
    });
  }

  // (4,0) is on the far side of the wall from the player at (0,0), and the only walking route
  // is the long way round through the gap at (3,2).
  const stone = warpEvent(10, 4, 0, [facingWest, route(THROUGH, jump(-2, 0)), endIf]);
  EVENTS.length = 0; EVENTS.push(stone);
  BMA.Nav._clearFloods();
  let wp = BMA.Nav.warps();
  check('a Through route yields one edge', wp.edges.length === 1, wp.edges.length);
  check('it fires from the tile east of the stone, facing it',
        wp.edges[0] && wp.edges[0].from === 0 * W + 5, wp.edges[0] && wp.edges[0].from);
  check('and lands two tiles west of there',
        wp.edges[0] && wp.edges[0].to === 0 * W + 3, wp.edges[0] && wp.edges[0].to);
  // A mover is a crossing, not a portal: a portal is a transfer that puts you somewhere else
  // on the map in one step, this is a thing you stand beside and act on.
  check('the stone is classified as a crossing',
        BMA.Nav.classify(stone).category === 'crossing', JSON.stringify(BMA.Nav.classify(stone)));

  // A WALKED route without Through: the steps can only put the player where they could already
  // walk, so it must not register as a way across. This is the check that keeps cutscenes out.
  //
  // It has to be steps and not a jump. Through governs walking, and Game_CharacterBase.jump does
  // not walk — it adds the offset to the player's coordinates and checks nothing at all — so a
  // jump crosses whether or not Through is set. The two cases are asserted apart below.
  const nudge = warpEvent(11, 4, 0, [facingWest, route(WEST, WEST), endIf]);
  EVENTS.length = 0; EVENTS.push(nudge);
  BMA.Nav._clearFloods();
  check('a walked route without Through yields no edge', BMA.Nav.warps().edges.length === 0);
  // classify returns null outright here: with no graphic and nothing but a nudge, it is not a
  // destination of any kind, which is exactly how it should have been treated all along.
  check('and is not called a crossing', (BMA.Nav.classify(nudge) || {}).category !== 'crossing',
        JSON.stringify(BMA.Nav.classify(nudge)));

  // The other half of that pair. Everlasting Tangle's nine launchers, Temple of Visions' six and
  // thirteen more across four maps are jump routes with no Through on them, and requiring Through
  // lost every one: twenty-five invisible tiles that fling the player seven or eight tiles, on
  // maps where some chests are only reachable by being flung.
  const launcher = warpEvent(13, 4, 0, [facingWest, route(jump(-2, 0)), endIf]);
  EVENTS.length = 0; EVENTS.push(launcher);
  BMA.Nav._clearFloods();
  wp = BMA.Nav.warps();
  check('a jump route without Through still yields an edge', wp.edges.length === 1, wp.edges.length);
  check('landing where the arithmetic says', wp.edges[0] && wp.edges[0].to === 0 * W + 3,
        wp.edges[0] && wp.edges[0].to);
  check('and it is a crossing', BMA.Nav.classify(launcher).category === 'crossing',
        JSON.stringify(BMA.Nav.classify(launcher)));

  // Mixing the two takes the stricter answer: the walked steps are still walked, so a route that
  // is not all jumps needs Through exactly as before.
  const mixed = warpEvent(14, 4, 0, [facingWest, route(jump(-1, 0), WEST), endIf]);
  EVENTS.length = 0; EVENTS.push(mixed);
  BMA.Nav._clearFloods();
  check('a jump mixed with a step still needs Through', BMA.Nav.warps().edges.length === 0,
        BMA.Nav.warps().edges.length);

  // An unpredictable mover: no edge, but its tile is remembered so a route over it can warn.
  // Placed at (2,2), on the only walking route east — the wall column forces everything through
  // the gap at (3,2), so a path to the far side cannot avoid stepping on it.
  const drift = warpEvent(12, 2, 2, [route(THROUGH, RANDOM), endIf]);
  EVENTS.length = 0; EVENTS.push(drift);
  BMA.Nav._clearFloods();
  wp = BMA.Nav.warps();
  check('an unpredictable route yields no edge', wp.edges.length === 0, wp.edges.length);
  check('but is counted', wp.unknowable === 1, wp.unknowable);
  check('and its tile is a hazard', !!BMA.Nav.hazardAt(2, 2));
  check('a route crossing it is flagged',
        !!BMA.Nav.hazardOnPath([[0, 2], [1, 2], [2, 2], [3, 2]]));
  check('a route avoiding it is not',
        !BMA.Nav.hazardOnPath([[0, 0], [0, 1], [0, 2]]));

  // The only gap also makes a useful exit. You can walk to it, but stepping onto it
  // transfers to another map, so the flood must not use it to walk to a local chest.
  const exit = warpEvent(13, 3, 2, [{ code: 201, indent: 0, parameters: [0, 2, 1, 1] }]);
  exit.page().trigger = 1;
  EVENTS.length = 0; EVENTS.push(exit);
  BMA.Nav._clearFloods();
  check('a touch exit is reachable but does not let a route cross it',
        BMA.Nav.flood().dist[2 * W + 3] >= 0 && BMA.Nav.flood().dist[RIGHT] === -1);
  EVENTS.length = 0; EVENTS.push(drift);
  BMA.Nav._clearFloods();

  // The player must hear the risk before walking it, not after being moved.
  //
  // Warm the scan first: filtered() runs deltaScan, which rebuilds entities from the map
  // whenever it sees an event it has not recorded. Letting it settle means the hand-made list
  // below survives the next call instead of being replaced by the fixture's own events.
  BMA.Nav.scannedMap = 1;
  BMA.Nav.ensureScanned();
  BMA.Nav.entities = [{ x: 4, y: 0, category: 'treasure', name: 'Chest' }];
  BMA.Nav.category = 'all'; BMA.Nav.index = 0; BMA.Nav._sel = null;
  said.length = 0;
  BMA.Nav.directions();
  check('directions warn before crossing an unpredictable mover',
        /Warning, this route crosses/.test(said[0]) && /random/.test(said[0]), said[0]);

  // Long routes get cut short: a recital of 80 turns is not usable as speech, and the route
  // recomputes from wherever the player stands anyway.
  const long = [];
  for (let i = 0; i < 40; i++) long.push([i % 2 ? i : i, i % 2 ? 0 : 1]);
  const spoken = BMA.Nav.describePath(long);
  check('a long route is cut to PATH_TURNS and counts the rest',
        /then \d+ more turns$/.test(spoken) &&
        spoken.split(',').length === BMA.Nav.PATH_TURNS + 1, spoken);

  // Nothing reachable at all: say so, and point at a crossing rather than stopping dead.
  EVENTS.length = 0; EVENTS.push(stone);
  BMA.Nav.scannedMap = 1;
  BMA.Nav.ensureScanned();
  BMA.Nav.entities = [{ x: 7, y: 5, category: 'treasure', name: 'Chest' },
                      { x: 4, y: 0, category: 'crossing', name: 'Crossing 1' }];
  BMA.Nav._clearFloods();
  const marooned = { canPass: $gamePlayer.canPass };
  $gamePlayer.canPass = () => false;                 // stand the player on an island
  BMA.Nav._clearFloods();
  BMA.Nav.category = 'all'; BMA.Nav.index = 0; BMA.Nav._sel = null;
  said.length = 0;
  BMA.Nav.directions();
  // Sentence-initial now that the destination name no longer leads.
  check('an unreachable target says so plainly, not "no path found"',
        /^Beyond the area you can reach\./.test(said[0]) &&
        said[0].indexOf('no path found') === -1, said[0]);
  check('and does not name the destination either',
        said[0].indexOf('Chest') === -1, said[0]);
  $gamePlayer.canPass = marooned.canPass;
  EVENTS.length = 0;
  BMA.Nav._clearFloods();
}

console.log('\n=== the installed movement modes constrain routes ===');
{
  const previous = global.$gameSystem;
  let forced = false, redirect = false;
  global.$gameSystem = { isForcedLeft: () => forced, isRedirectDownToUp: () => redirect };
  $gamePlayer.x = 1; $gamePlayer.y = 1;
  BMA.Nav._clearFloods();
  const east = W + 2, south = 2 * W + 1;
  const normal = BMA.Nav.flood();
  check('the normal map offers both steps', normal.dist[east] === 1 && normal.dist[south] === 1);
  forced = true;
  const drifting = BMA.Nav.flood();
  check('forced west refreshes the cached route and never plans an east input',
        drifting !== normal && drifting.dist[east] === -1 && drifting.dist[south] === 1);
  forced = false; redirect = true;
  const swimming = BMA.Nav.flood();
  check('redirected south refreshes the route and never plans a south input',
        swimming !== drifting && swimming.dist[south] === -1 && swimming.dist[east] === 1);
  global.$gameSystem = previous;
}

console.log(fails ? `\n${fails} CHECK(S) FAILED` : '\nall checks passed');
process.exit(fails ? 1 : 0);
