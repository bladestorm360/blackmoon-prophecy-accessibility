// Shared path resolution for the tests.
//
// The tests load the real src/*.js under stubbed MV globals, so they exercise the shipping
// code rather than a copy of it. Most of them also read the installed game's data files —
// System.json, plugins.js, the Map###.json set — because the mod's behaviour is driven by this
// game's actual configuration (ICFSoft's status columns, YEP's equip slots, the shop plugins)
// and hardcoding a guess at those would test a fiction.
//
// Paths were absolute string literals while these lived in a scratchpad; keep them derived so
// the tests survive the repo being cloned somewhere else.
const fs = require('fs'), path = require('path'), vm = require('vm');

const ROOT = path.resolve(__dirname, '..');
const SRC  = path.join(ROOT, 'src');

// Override with BMA_GAME_DIR when the game is installed elsewhere. It must point at the folder
// holding Game.exe / package.json / www — note the doubly-nested default below is correct.
const GAME = process.env.BMA_GAME_DIR ||
  'D:\\Games\\Blackmoon Prophecy Remake 1.05S\\Final Fantasy Blackmoon Prophecy Remake';
const DATA = path.join(GAME, 'www', 'data');
const MOD  = path.join(GAME, 'www', 'mod');

// Exit 2 (distinct from 1 = assertion failure) so the runner can report "skipped, no game"
// rather than counting a missing install as a regression.
function requireGame(who) {
  if (!fs.existsSync(path.join(DATA, 'System.json'))) {
    console.error(who + ': cannot find the installed game at\n  ' + GAME +
      '\nSet BMA_GAME_DIR to the folder containing Game.exe and www\\.');
    process.exit(2);
  }
}

// Load the mod in bundle order. Order matters: Text/Menus/Nav all depend on Core.
function loadMod(vm) {
  for (const f of ['BMA_Core.js', 'BMA_Text.js', 'BMA_Menus.js', 'BMA_Nav.js']) {
    vm.runInThisContext(fs.readFileSync(path.join(SRC, f), 'utf8'), { filename: f });
  }
}

// Read selected top-level assignments from the local engine. The tested MV build puts
// method closing braces at the left margin and ends its literal arrays with a semicolon.
// Evaluate only the requested assignments, with the host objects supplied by the fixture.
function loadEngineAssignments(file, names) {
  const filename = path.join(GAME, 'www', 'js', file);
  const source = fs.readFileSync(filename, 'utf8');
  for (const name of names) {
    const key = name.replaceAll('.', '\\.');
    const start = new RegExp(`^${key}[ \\t]*=[ \\t]*`, 'm').exec(source);
    if (!start) throw new Error(`${file}: missing ${name}`);
    const rhs = source.slice(start.index + start[0].length);
    const body = /^(?:function\b[\s\S]*?^};|\s*\[[\s\S]*?\];|\d+;)/m.exec(rhs);
    if (!body || body.index !== 0) throw new Error(`${file}: unsupported definition for ${name}`);
    vm.runInThisContext(start[0] + body[0], { filename });
  }
}

function installTilemap() {
  requireGame('Tilemap fixture');
  global.Tilemap = {};
  loadEngineAssignments('rpg_core.js', [
    'TILE_ID_A1', 'TILE_ID_A3', 'TILE_ID_A4', 'TILE_ID_MAX',
    'getAutotileKind', 'isTileA3', 'isTileA4', 'isWallTopTile', 'isWallSideTile', 'isWallTile',
  ].map(name => 'Tilemap.' + name));
  return global.Tilemap;
}

// The fixture supplies live tile flags and optional tile-event IDs. The installed engine
// provides both the tile-layer access and the decision about whether a direction is passable.
function installedMapPassage(flags, eventTiles) {
  requireGame('map passage fixture');
  global.Game_Map = function Game_Map() {};
  loadEngineAssignments('rpg_objects.js', ['tileId', 'layeredTiles', 'checkPassage']
    .map(name => 'Game_Map.prototype.' + name));
  const map = new Game_Map();
  map.tilesetFlags = flags;
  map.allTiles = (x, y) => {
    const ground = map.layeredTiles(x, y);
    return eventTiles ? eventTiles(x, y).concat(ground) : ground;
  };
  return map.checkPassage.bind(map);
}

module.exports = { ROOT, SRC, GAME, DATA, MOD, requireGame, loadMod, installTilemap,
  loadEngineAssignments, installedMapPassage };
