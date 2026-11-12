// The airship landing cue: is the ground under us somewhere the ship can be set down?
//
// Two halves. First the state machine — baseline, transitions, the settle timer that keeps a
// ragged coastline from producing a stream of contradictions — driven by a stub whose landability
// the test sets directly. Then the real rule, against the actual Overworld: canLandHere is only
// worth anything if it agrees with what the game itself would do when the player presses confirm,
// so it is checked against the installed Game_Map.isAirshipLandOk over real
// map data rather than against the stub's say-so.
const fs = require('fs'), path = require('path'), vm = require('vm');
const { SRC, DATA, requireGame, loadEngineAssignments, installedMapPassage } = require('./_paths');
requireGame('airship.js');

global.window = global;
global.document = { addEventListener() {} };
global.require = require;
global.performance = { now: () => 0 };

const W = 8, H = 6;
// What the stub says about each tile, and which vehicle the player is in. Both are set per case.
let LANDABLE = {};                       // "x,y" -> bool
let VEHICLE = null;                      // null | 'airship' | 'boat'
let GETTING = false;                     // mid-boarding / mid-landing

const airship = {
  isAirship: () => true,
  isLandOk(x, y) { return !!LANDABLE[x + ',' + y]; },
};
const boat = { isAirship: () => false, isLandOk: () => false };

global.$gameMap = {
  mapId: () => 1, width: () => W, height: () => H, displayName: () => 'Testville',
  events: () => [], eventsXy: () => [], eventsXyNt: () => [],
};
global.$gamePlayer = {
  x: 0, y: 0, direction: () => 2,
  isInAirship() { return VEHICLE === 'airship'; },
  vehicle() { return VEHICLE === 'airship' ? airship : VEHICLE ? boat : null; },
  canPass: () => true,
};
Object.defineProperty($gamePlayer, '_vehicleGettingOn', { get: () => GETTING });
Object.defineProperty($gamePlayer, '_vehicleGettingOff', { get: () => false });

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

// Capture speech instead of speaking it.
const said = [];
BMA.Speech.speak = t => said.push(String(t));

// The settle window is real wall-clock time in the mod. Shrink it so the test does not sleep for
// a fifth of a second per case, and step the clock with a promise that outlives it.
BMA.Nav.LANDING_SETTLE = 5;
const settle = () => new Promise(r => setTimeout(r, 25));

// Fly to a tile and let the cue react, exactly as increaseSteps would.
async function flyTo(x, y) {
  $gamePlayer.x = x; $gamePlayer.y = y;
  BMA.Nav.updateLanding();
  await settle();
}

(async function () {
  // ---------- 1. what canLandHere answers, and when it declines to ----------
  console.log('\n=== canLandHere ===');
  LANDABLE = { '0,0': true };
  VEHICLE = null;
  check('on foot it has no opinion', BMA.Nav.canLandHere() === null, BMA.Nav.canLandHere());
  VEHICLE = 'boat';
  check('in the boat it has no opinion', BMA.Nav.canLandHere() === null, BMA.Nav.canLandHere());
  VEHICLE = 'airship';
  $gamePlayer.x = 0; $gamePlayer.y = 0;
  check('in the airship over open ground it says yes', BMA.Nav.canLandHere() === true);
  $gamePlayer.x = 1;
  check('and over anything else it says no', BMA.Nav.canLandHere() === false);
  // Mid-transition the player's tile is not yet the one the answer is about.
  GETTING = true; $gamePlayer.x = 0;
  check('while boarding it has no opinion', BMA.Nav.canLandHere() === null, BMA.Nav.canLandHere());
  GETTING = false;

  // ---------- 2. the cue only speaks changes ----------
  console.log('\n=== what gets spoken ===');
  //                x: 0    1     2     3     4     5
  LANDABLE = { '0,0': true, '1,0': true, '4,0': true, '5,0': true };
  VEHICLE = 'airship';
  BMA.Nav.clearLanding();
  said.length = 0;

  await flyTo(0, 0);
  check('taking off from landable ground says nothing', said.length === 0, said.join(' | '));
  await flyTo(1, 0);
  check('and staying over it says nothing', said.length === 0, said.join(' | '));

  await flyTo(2, 0);
  check('crossing onto water says so once', said.join(' | ') === 'Can not land', said.join(' | '));
  await flyTo(3, 0);
  check('and staying over it repeats nothing', said.length === 1, said.join(' | '));

  await flyTo(4, 0);
  check('reaching land again says so', said.join(' | ') === 'Can not land | Can land',
        said.join(' | '));

  // ---------- 3. a ragged coast does not produce a stream of contradictions ----------
  //
  // Flying along a shore flips the answer every step or two. Speech is queued, so announcing
  // every flip means hearing about a coast the player crossed several tiles ago. A change has to
  // hold for LANDING_SETTLE before it is spoken.
  console.log('\n=== a coastline crossed and immediately re-crossed ===');
  BMA.Nav.clearLanding();
  said.length = 0;
  LANDABLE = { '0,0': true, '2,0': true };

  $gamePlayer.x = 0; $gamePlayer.y = 0;
  BMA.Nav.updateLanding();                       // baseline: landable, silent
  await settle();
  check('baseline is silent', said.length === 0, said.join(' | '));

  $gamePlayer.x = 1; BMA.Nav.updateLanding();    // over water...
  $gamePlayer.x = 2; BMA.Nav.updateLanding();    // ...and back on land before the timer fires
  await settle();
  check('a flip that undoes itself is never spoken', said.length === 0, said.join(' | '));

  // But one that sticks still is.
  $gamePlayer.x = 3; BMA.Nav.updateLanding();
  await settle();
  check('a change that holds is spoken', said.join(' | ') === 'Can not land', said.join(' | '));

  // ---------- 4. leaving the airship resets the baseline ----------
  console.log('\n=== boarding and landing ===');
  said.length = 0;
  VEHICLE = null;
  BMA.Nav.updateLanding();
  check('walking around says nothing', said.length === 0, said.join(' | '));
  check('  and the remembered answer is dropped', BMA.Nav._landing === null, BMA.Nav._landing);

  // Next flight starts from its own baseline rather than the last one's answer.
  VEHICLE = 'airship';
  LANDABLE = { '3,0': true };
  said.length = 0;
  await flyTo(3, 0);
  check('the next flight re-baselines instead of announcing', said.length === 0, said.join(' | '));

  // ---------- 5. the toggle ----------
  console.log('\n=== the setting ===');
  BMA.Config.airshipLanding = false;
  BMA.Nav.clearLanding();
  said.length = 0;
  LANDABLE = { '0,0': true };
  await flyTo(0, 0);
  await flyTo(1, 0);
  check('turned off, it says nothing at all', said.length === 0, said.join(' | '));
  BMA.Config.airshipLanding = true;

  // ---------- 6. the real rule, over the real Overworld ----------
  //
  // Everything above trusts the stub's isLandOk. This half checks that asking the engine is the
  // right thing to ask: MV lands an airship where the tileset's airship flag is set AND the tile
  // is passable from all four sides AND no event stands on it. The third clause is the one that
  // is easy to forget, and it is why a town or a signpost cannot be landed on even though the
  // grass around it can.
  console.log('\n=== map 180 "Overworld": the engine rule, restated ===');
  const TILESETS = JSON.parse(fs.readFileSync(path.join(DATA, 'Tilesets.json'), 'utf8'));
  const MAP = JSON.parse(fs.readFileSync(path.join(DATA, 'Map180.json'), 'utf8'));
  const FLAGS = TILESETS[MAP.tilesetId].flags;
  const MW = MAP.width, MH = MAP.height;
  global.$dataMap = MAP;
  const checkPassage = installedMapPassage(() => FLAGS);
  loadEngineAssignments('rpg_objects.js', ['Game_Map.prototype.isAirshipLandOk']);
  const mapRules = { checkPassage };
  const evAt = new Set(MAP.events.filter(Boolean).map(e => e.x + ',' + e.y));
  // Game_Map.isAirshipLandOk, plus Game_Vehicle.isLandOk's event clause.
  const landableGround = (x, y) => Game_Map.prototype.isAirshipLandOk.call(mapRules, x, y);
  const refLandOk = (x, y) => landableGround(x, y) && !evAt.has(x + ',' + y);

  // Point the stub's vehicle at the real rule and walk the whole map through canLandHere.
  const realAirship = { isAirship: () => true, isLandOk: (x, y) => refLandOk(x, y) };
  $gameMap.width = () => MW; $gameMap.height = () => MH;
  $gamePlayer.vehicle = () => realAirship;
  VEHICLE = 'airship';

  let landable = 0, disagree = 0, firstBad = null;
  for (let y = 0; y < MH; y++) for (let x = 0; x < MW; x++) {
    $gamePlayer.x = x; $gamePlayer.y = y;
    const want = refLandOk(x, y), got = BMA.Nav.canLandHere();
    if (want) landable++;
    if (want !== got && !firstBad) firstBad = `${x},${y} want=${want} got=${got}`;
    if (want !== got) disagree++;
  }
  check('canLandHere matches the engine rule on all 57,500 tiles', disagree === 0,
        disagree + ' disagreed, first ' + firstBad);
  // Sanity on the fixture itself: an answer that is always yes or always no would pass the
  // check above while telling the player nothing.
  check('  and the map really is a mix of both', landable > 1000 && landable < MW * MH - 1000,
        landable + ' of ' + MW * MH);

  // The event clause, named. These are the tiles a player would expect to be able to land on.
  let blockedByEvent = 0;
  for (const key of evAt) {
    const [x, y] = key.split(',').map(Number);
    if (landableGround(x, y)) blockedByEvent++;
  }
  check('  towns and signposts cannot be landed on despite the ground being fine',
        blockedByEvent > 0, blockedByEvent);

  console.log(fails ? `\n${fails} CHECK(S) FAILED` : '\nall checks passed');
  process.exit(fails ? 1 : 0);
})();
