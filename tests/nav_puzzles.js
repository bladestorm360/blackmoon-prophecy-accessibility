// The endgame's puzzles, and the four ways the mod used to miss one.
//
// Testers are reaching content built out of mechanisms rather than out of rooms, and a sweep of
// all 645 maps for "a dungeon that does something unusual" turned up four separate blind spots.
// Each one is a rule in BMA_Nav.js and each is pinned here against the real map data, because a
// census can only say how many things moved category — not that the thing a player has to go and
// use is now in a list they would look in.
//
//   the invisible tail   classify()'s last test wanted a graphic. 871 events in this game are an
//                        action-button page with no graphic that does something — that is how
//                        nearly everything in it is built, the picture living in the map's own
//                        tiles — and the rewards test caught 719 of them (the chests), which is
//                        why the requirement went unnoticed. The 26 it dropped are the endgame:
//                        nine wall carvings that are the only way through three maps, and the
//                        clue plaques for two puzzles that cannot be solved without them.
//   take is not give     a Change Items command carries the direction it runs in. Nothing read
//                        it, so nineteen events that TOOK an item were filed as treasure.
//   invisible is not a   an action-button event with no graphic that asks a question and fights
//   monster              you for the wrong answer is a mechanism, not a monster in a corridor.
//   a jump is not a walk Game_CharacterBase.jump adds the offset to the player's coordinates and
//                        checks nothing, so Through — which governs walking — has nothing to say
//                        about it. Requiring it lost 23 launchers across six maps.
//
// Plus the two plugins that rewrite the direction keys, which no amount of reading map data would
// have found: they are in plugins.js, and they are switched by a bare script call.
const fs = require('fs'), path = require('path'), vm = require('vm');
const { DATA, MOD, requireGame, loadMod, installTilemap, loadEngineAssignments } = require('./_paths');
requireGame('nav_puzzles.js');
installTilemap();

global.window = global;
global.document = { addEventListener() {} };
global.require = require;
global.performance = { now: () => 0 };
const J = f => JSON.parse(fs.readFileSync(path.join(DATA, f), 'utf8'));
global.$dataMapInfos = J('MapInfos.json');
global.$dataActors = J('Actors.json');
global.$dataCommonEvents = J('CommonEvents.json');
global.$dataStates = J('States.json');
global.$dataTilesets = J('Tilesets.json');
global.$gameVariables = { value: () => 0 };
global.$gameActors = { actor: () => null };
global.$gameParty = { members: () => [] };
global.$gamePlayer = { x: 0, y: 0, direction: () => 2 };

let curMap = null, curId = 0, curEvents = [];
global.Game_Map = function Game_Map() {};
loadEngineAssignments('rpg_objects.js', ['Game_Map.prototype.tileId']);
global.$gameMap = {
  mapId: () => curId,
  displayName: () => (curMap && curMap.displayName) || '',
  width: () => (curMap && curMap.width) || 0,
  height: () => (curMap && curMap.height) || 0,
  tilesetId: () => (curMap && curMap.tilesetId) || 0,
  events: () => curEvents,
  tileId: Game_Map.prototype.tileId,
  tilesetFlags: () => $dataTilesets[(curMap && curMap.tilesetId) || 0].flags,
};
loadMod(vm);
BMA.TTS.modDir = MOD;

let fails = 0;
const check = (name, cond, extra) => {
  if (cond) console.log('  ok   ' + name);
  else { fails++; console.log('  FAIL ' + name + (extra !== undefined ? '  -> ' + extra : '')); }
};

// Scan one map and hand back its entities keyed by event id, plus the list itself.
function scan(id) {
  const f = path.join(DATA, `Map${String(id).padStart(3, '0')}.json`);
  const m = JSON.parse(fs.readFileSync(f, 'utf8'));
  curId = id; curMap = m; global.$dataMap = m;
  curEvents = m.events.filter(Boolean).map(ev => ({
    _erased: false, x: ev.x, y: ev.y, _x: ev.x, _y: ev.y, _pageIndex: 0,
    eventId: () => ev.id, page: () => ev.pages[0], event: () => ev,
  }));
  BMA.Nav._seen = {}; BMA.Nav._groups = {}; BMA.Nav._nameless = {};
  BMA.Nav._blockIds = {}; BMA.Nav._blockResets = null; BMA.Nav._gates = null; BMA.Nav._warps = null;
  BMA.Nav.scan();
  const by = {};
  for (const e of BMA.Nav.entities) if (e.ev) by[e.ev.eventId()] = e;
  return { by, all: BMA.Nav.entities.slice(), map: m };
}
const at = (r, id) => r.by[id] ? r.by[id].category + ': ' + r.by[id].name : 'DROPPED';

// ---- Osteinchyl (405): three statues, three switches, three riddles ----
//
// The dungeon is a 255x90 corridor with three statues in it. Each has four pages, one per symbol
// it faces — Symbol of Life, Mark of Death, North Star, Crescent Moon — and the action button
// offers "Rotate Clockwise" / "Rotate Opposite". Getting a statue onto the right symbol and
// pulling the switch beside it opens one of the map's three magically sealed doors.
//
// Which symbol is right is only ever said in one place, and it is not on the statue: three plaques
// scattered down the map say "The Knight of the West stands guard when the moon rises", "The Mage
// of Mysidia maintains the balance of life" and "The Bird of Prey hunts at the crack of dawn".
// They are invisible action-button events with a single line of text — carved into the map's own
// tiles, so a sighted player walks up and reads one — and all three were dropped outright. Without
// them the puzzle is four facings on each of three statues tried blind: 64 combinations, with
// nothing to tell a right one from a wrong one but a door somewhere else that may or may not have
// opened.
console.log('=== Osteinchyl (405): the statue riddles ===');
{
  const r = scan(405);
  check('the knight riddle is listed', /^interactable: The Knight of the West/.test(at(r, 1)), at(r, 1));
  check('the mage riddle is listed', /^interactable: The Mage of Mysidia/.test(at(r, 18)), at(r, 18));
  check('the bird riddle is listed', /^interactable: The Bird of Prey/.test(at(r, 27)), at(r, 27));
  // The statues name themselves in the only sentence anybody reads about them. "Object 1" beside
  // "Switch 1" is six things of two kinds with nothing connecting them.
  check('the knight statue is a statue', at(r, 2) === 'interactable: Knight statue', at(r, 2));
  check('the mage statue is a statue', at(r, 20) === 'interactable: Mage statue', at(r, 20));
  check('the bird statue is a statue', at(r, 28) === 'interactable: Bird statue', at(r, 28));
  check('each statue has its switch', at(r, 8) === 'interactable: Switch 1' &&
        at(r, 19) === 'interactable: Switch 2' && at(r, 29) === 'interactable: Switch 3',
        [at(r, 8), at(r, 19), at(r, 29)].join(' | '));
  // The three doors the puzzle opens keep the word that says they are shut. A door that describes
  // itself loses the 'Closed door' kind (see _makeRecord), and "The door is sealed through magical
  // means" is a self-description — so the subject-noun rule has a two-word minimum on it, and this
  // is the case that minimum exists for.
  check('the sealed doors are still called closed', /Closed door/.test(at(r, 9)) &&
        /Closed door/.test(at(r, 21)) && /Closed door/.test(at(r, 35)),
        [at(r, 9), at(r, 21), at(r, 35)].join(' | '));
}

// ---- The Inner (407): Odin's three children ----
//
// Three buttons in a 155-wide hall, inscribed "Baul", "Haljar" and "Vinro", to be pressed in the
// order a plaque at (27,9) gives: "The Esper Alera, wife of Odin, bore three children. Baul,
// Haljar, and Vinro. Baul the eldest, Vinro the youngest." Press them out of order and Odin's
// guard fights you.
//
// One puzzle, filed three different ways. Baul and Haljar carry the Battle Processing, so they
// came out as "Enemy 1" and "Enemy 3" — under enemies, where nobody looks for a button, and
// warning of a fight the game gives a sighted player no warning of. Vinro's branch has no fight in
// it, so it matched nothing at all and was dropped. And the plaque that holds the answer was
// dropped with it.
console.log('\n=== The Inner (407): the button order ===');
{
  const r = scan(407);
  check('the plaque with the birth order is listed', /^interactable: "The Esper Alera/.test(at(r, 40)), at(r, 40));
  check('Baul is a button, not an enemy', at(r, 41) === 'interactable: Button 1', at(r, 41));
  check('Vinro is listed at all', at(r, 42) === 'interactable: Button 2', at(r, 42));
  check('Haljar is a button, not an enemy', at(r, 43) === 'interactable: Button 3', at(r, 43));
  check('nothing on the map is filed under enemies but Odin himself',
        r.all.filter(e => e.category === 'enemy').every(e => /Odin/.test(e.name)),
        r.all.filter(e => e.category === 'enemy').map(e => e.name).join(', '));
}

// ---- Genesis Obelisk (605) and friends: the carvings that are the way through ----
//
// Seven Lunar Crystals on 605, one on Lunar Crystal (601) and one on Lunarscape Abyss (614). Each
// is an invisible action-button event over a crystal drawn in the tiles: "A Lunar Crystal shimmers
// quietly. Activate the Crystal?" and a Transfer to the next map. They are the only connections
// those maps have, and all nine were in no list of any kind — asking where the ways out were
// answered with the stairs and never with the nine tiles the dungeon is actually built on.
//
// They belong in the exits list rather than among the objects because that is where a player looks
// for the way on, and a transfer off the map is a way out however much it talks first.
console.log('\n=== Genesis Obelisk (605): the Lunar Crystals ===');
{
  const r = scan(605);
  const crystals = [3, 4, 11, 12, 13, 14, 15];
  check('all seven carvings are exits',
        crystals.every(id => r.by[id] && r.by[id].category === 'exit'),
        crystals.map(id => at(r, id)).join(' | '));
  check('and each says where it goes', crystals.every(id => /^To /.test(r.by[id].name)),
        crystals.map(id => at(r, id)).join(' | '));
  check('Lunar Crystal (601) has its way back', /^exit: To Genesis Obelisk/.test(at(scan(601), 2)));
  check('Lunarscape Abyss (614) has its carving too',
        scan(614).by[51] && scan(614).by[51].category === 'exit');
}

// ---- South Map (130) and Floating Ruins (552): sockets are not chests ----
//
// South Map is eight braziers scattered over an 80x95 dungeon, each wanting one Oil Cannister;
// light all eight and a door opens. Floating Ruins is five impressions wanting a Cyclone Core
// each. Both were filed under treasure because the page carries a Change Items command — with no
// one reading the direction it runs in, taking an item counted as loudly as giving one.
//
// Both halves of that were wrong. A player working through the treasure list was sent to something
// that wanted an item off them; and the eight braziers, which ARE South Map, were never named as
// anything to go and use. Note the chests renumber as a result: they are no longer sharing a run
// of numbers with things that are not chests.
console.log('\n=== South Map (130) / Floating Ruins (552): the sockets ===');
{
  const r = scan(130);
  const braziers = [2, 12, 21, 40, 43, 46, 53, 54];
  check('all eight braziers are objects, not chests',
        braziers.every(id => r.by[id] && r.by[id].category === 'interactable'),
        braziers.map(id => at(r, id)).join(' | '));
  // "Ignite these brazier?" — the game's own word, and the only place it exists.
  check('and each is called a brazier',
        braziers.every(id => /^Brazier \d+$/.test(r.by[id].name)),
        braziers.map(id => r.by[id].name).join(', '));
  check('the map still has its 15 real chests',
        r.all.filter(e => /^Chest \d+$/.test(e.name)).length === 15,
        r.all.filter(e => /^Chest \d+$/.test(e.name)).length);

  const f = scan(552);
  const sockets = [21, 22, 23, 24, 25];
  check('Floating Ruins\' five impressions are objects',
        sockets.every(id => f.by[id] && f.by[id].category === 'interactable' &&
                            /^Impression \d+$/.test(f.by[id].name)),
        sockets.map(id => at(f, id)).join(' | '));
}

// ---- Everlasting Tangle (556): a jump needs no Through ----
//
// Nine invisible touch tiles that jump the party seven or eight tiles in a fixed direction through
// the undergrowth. None turns Through on, and the crossing rule required it — correctly, for a
// WALKED route, which without Through can only put the player where they could already have walked
// and would otherwise file every cutscene nudge as a way across the map. A jump is not walked:
// Game_CharacterBase.jump does `this._x += xPlus` and consults nothing at all.
//
// Six of the map's thirteen chests sit where only a launcher reaches, so this was not cosmetic.
console.log('\n=== Everlasting Tangle (556): the launchers ===');
{
  const r = scan(556);
  const launchers = [2, 3, 4, 5, 6, 7, 8, 10, 11];
  check('all nine launchers are crossings',
        launchers.every(id => r.by[id] && r.by[id].category === 'crossing'),
        launchers.map(id => at(r, id)).join(' | '));
  // Each one is a real edge with a computed landing tile, which is what makes them routable.
  const wp = BMA.Nav.warps();
  check('and each yields at least one warp edge',
        launchers.every(id => wp.byEvent[id] === 'jump'),
        launchers.map(id => id + ':' + wp.byEvent[id]).join(' '));
  // Touch-triggered, so standing on one is not a choice: the tile is the launcher, not ground.
  check('their tiles are marked forced',
        launchers.every(id => {
          const e = r.by[id];
          return wp.forced[e.y * r.map.width + e.x];
        }));
}

// ---- Temple of Visions (229): the same rule, used as a fence ----
//
// Six tiles down the west wall, each jumping the player one tile back east. Not a crossing at all
// — a fence that bounces you off it — and the right answer is the same one: the tile is somewhere
// the player cannot be. tests/nav_realmap.js discounts exactly these six when it compares the
// shipping flood against a reference that only knows how to walk.
console.log('\n=== Temple of Visions (229): the bounce-back fence ===');
{
  const r = scan(229);
  const fence = [1, 2, 3, 4, 5, 6];
  check('the six fence tiles are crossings',
        fence.every(id => r.by[id] && r.by[id].category === 'crossing'),
        fence.map(id => at(r, id)).join(' | '));
  check('and all six are forced', fence.every(id => {
    const e = r.by[id];
    return BMA.Nav.warps().forced[e.y * r.map.width + e.x];
  }));
  check('its two half-moon sockets are not chests',
        r.by[8] && r.by[8].category === 'interactable' &&
        r.by[9] && r.by[9].category === 'interactable',
        [at(r, 8), at(r, 9)].join(' | '));
}

// ---- the two plugins that rewrite the direction keys ----
//
// ForcedLeftMovement drags the player west every frame they are not steering and discards the east
// key outright; Forest (190) is its only user, a 255x16 corridor entered at the east end and run at
// speed 5 with 43 damage tiles in it. RedirectDownToUp rewrites the south key to north, so south
// cannot be walked; Gygas Arena (76) turns it on as it transfers the party into Gozmodan's Grotto
// (55), 225 tiles of one-way swim, and the grotto's tile at (27,13) turns it off on the way out.
//
// Neither is visible in any map file — both are script calls — and neither is MV, so the mod has to
// answer sensibly when the plugin is absent as well as when it is present.
console.log('\n=== forced movement ===');
{
  const savedSystem = global.$gameSystem;
  global.$gameSystem = {};
  check('no plugin, no mode', BMA.Nav.movementMode() === null);

  let forced = false, redirect = false;
  global.$gameSystem = {
    isForcedLeft: () => forced,
    isRedirectDownToUp: () => redirect,
  };
  check('both off is no mode', BMA.Nav.movementMode() === null);

  forced = true;
  let m = BMA.Nav.movementMode();
  check('forced left is recognised', m && m.key === 'forcedLeft', m && m.key);
  check('and says which way it carries you', m && /carried west/.test(m.entering), m && m.entering);
  check('and that east is gone', m && /East does nothing/.test(m.entering), m && m.entering);
  forced = false;

  redirect = true;
  m = BMA.Nav.movementMode();
  check('down-is-up is recognised', m && m.key === 'downIsUp', m && m.key);
  check('and says south cannot be walked', m && /South cannot be walked/.test(m.entering), m && m.entering);
  // The route clause is the half that stops the mod contradicting itself: it is appended to every
  // set of directions, which are still spoken in all four compass directions.
  check('and warns on every route', m && /South cannot be walked/.test(m.route), m && m.route);
  redirect = false;
  check('turning it off clears the mode', BMA.Nav.movementMode() === null);
  global.$gameSystem = savedSystem;
}

// ---- Crescent Rivulet (217): a bridge made of tileset flags ----
//
// The third way this game opens a bridge, after the tile event and the switch-gated wall: ten
// invisible tiles along the river swap the map's whole tileset between "Cave 2" (12) and "Cave 2
// BRIDGE UP" (29), and 132 tiles change between wall and floor when they do. Passability is read
// live so the tiles themselves were always right — but the flood that answers "how do I get there"
// is computed once and held until something is known to have moved, and a tileset swap moves
// nothing the scan watches. Directions went on being given from a map that had stopped existing.
console.log('\n=== Crescent Rivulet (217): the tileset drawbridge ===');
{
  const m = JSON.parse(fs.readFileSync(path.join(DATA, 'Map217.json'), 'utf8'));
  curId = 217; curMap = m; global.$dataMap = m; curEvents = [];
  const flagsOf = id => $dataTilesets[id].flags;
  const before = BMA.Nav._tilesetPassMap(flagsOf(12));
  const after = BMA.Nav._tilesetPassMap(flagsOf(29));
  let opened = 0, closed = 0;
  const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
  for (const k of keys) {
    if (!!before[k] === !!after[k]) continue;
    if (after[k]) opened++; else closed++;
  }
  // Pinned exactly: this is fixed map data, so a change here is the game being patched — or
  // _tilesetPassMap drifting away from _groundPasses, which is the reading it has to share.
  check('raising the bridge opens 132 tiles', opened === 132, opened);
  check('and closes none', closed === 0, closed);
  check('the two tilesets are the same art, differently walkable',
        $dataTilesets[12].tilesetNames.join() === $dataTilesets[29].tilesetNames.join());
}

console.log('\n=== Cleft of Wind: doors follow the current approach ===');
{
  let upper = false;
  global.$gameSwitches = { value: () => upper };
  for (const [mapId, doorId, lower, higher, markerCount] of [
    [549, 6, [18, 71], [22, 28], 4],
    [550, 4, [36, 26], [7, 8], 3],
  ]) {
    upper = false;
    const state = scan(mapId);
    const targets = () => new Set(BMA.Nav.warps().edges.filter(edge => edge.evId === doorId)
      .map(edge => `${edge.x},${edge.y}`));
    check(`map ${mapId}: the lower or right approach has one landing`,
          targets().size === 1 && targets().has(lower.join(',')), [...targets()]);
    const marker = BMA.Nav.entities.filter(e => /route marker/i.test(e.name));
    check(`map ${mapId}: all approach markers can be selected`, marker.length === markerCount, marker.length);
    const cache = BMA.Nav.warps();
    const changesMode = state.by[mapId === 549 ? 8 : 6];
    const trigger = changesMode.y * state.map.width + changesMode.x;
    check(`map ${mapId}: walking to a marker that changes the route ends the plan there`, cache.stops[trigger]);
    upper = true;
    BMA.Nav.deltaScan();
    check(`map ${mapId}: flipping the switch retires the old route without a page change`,
          BMA.Nav.warps() !== cache && targets().size === 1 && targets().has(higher.join(',')), [...targets()]);
    check(`map ${mapId}: the same marker is walkable after setting that route`, !BMA.Nav.warps().stops[trigger]);
    const transfer = BMA.Nav._transferOf(state.by[doorId].ev);
    check(`map ${mapId}: door naming uses the same landing as routing`,
          transfer && `${transfer.x},${transfer.y}` === higher.join(','));
  }
  delete global.$gameSwitches;
}

console.log('\n=== Kohlingen Caves: story teleport is not an action ===');
scan(131);
check('the autorun scene contributes no traversable warp edge',
      !BMA.Nav.warps().edges.some(edge => edge.evId === 18));

console.log('\n=== Infinitarium: the next room is chosen when the player leaves ===');
{
  const bad = [];
  for (let id = 508; id <= 527; id++) {
    const state = scan(id);
    const passage = state.all.find(e => e.category === 'exit' && e.kind === 'Infinitarium passage');
    const warps = BMA.Nav.warps();
    if (!passage || !warps.stops?.[passage.y * state.map.width + passage.x] ||
        warps.edges.some(e => e.evId === passage.ev.eventId())) bad.push(id);
  }
  check('all 20 room exits are selectable and none assumes a fixed landing', !bad.length, bad.join(','));
}

console.log(fails ? `\n${fails} CHECK(S) FAILED` : '\nall checks passed');
process.exit(fails ? 1 : 0);
