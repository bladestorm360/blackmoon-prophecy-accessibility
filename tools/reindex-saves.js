// Rebuild www/save/global.rpgsave from the save files actually on disk.
//
// MV keeps two separate things: the save files themselves (file1.rpgsave ...) and an *index*
// (global.rpgsave) holding one summary record per slot. The Load screen is driven entirely by
// the index — DataManager.isThisGameFile() returns false for any slot the index has no record
// for, so a fileN.rpgsave that is present but unindexed is invisible to the game. The index only
// gets written by DataManager.saveGameWithoutRescue(), so files restored from a backup, copied
// in from another install, or written while the index was stale stay unreachable.
//
// This reads each fileN.rpgsave and regenerates its record the same way the running game would,
// then writes the whole index back. Stale records are corrected, missing ones added, and records
// for files no longer on disk dropped.
//
// Usage:  node tools/reindex-saves.js [--dry-run] [--game <dir>]
//         BMA_GAME_DIR=<dir> node tools/reindex-saves.js

const fs = require('fs');
const path = require('path');

const argv = process.argv.slice(2);
const DRY = argv.includes('--dry-run') || argv.includes('-n');
const gameArg = argv.indexOf('--game');

const GAME = (gameArg >= 0 && argv[gameArg + 1]) || require('./game-dir');

const SAVE = path.join(GAME, 'www', 'save');
const DATA = path.join(GAME, 'www', 'data');

if (!fs.existsSync(path.join(DATA, 'System.json'))) {
  console.error('Cannot find the installed game at\n  ' + GAME +
    '\nPass --game <dir> or set BMA_GAME_DIR to the folder holding Game.exe and www\\.');
  process.exit(2);
}
if (!fs.existsSync(SAVE)) {
  console.error('No save folder at\n  ' + SAVE + '\nNothing to index.');
  process.exit(2);
}

// Use the game's own lz-string so what we write is byte-compatible with what it reads.
const LZString = require(path.join(GAME, 'www', 'js', 'libs', 'lz-string.js'));

const system = JSON.parse(fs.readFileSync(path.join(DATA, 'System.json'), 'utf8'));
const GLOBAL_ID = 'RPGMV';                    // DataManager._globalId
const GAME_TITLE = system.gameTitle;

//-----------------------------------------------------------------------------
// Engine config that the index records depend on, read from plugins.js so the
// tool tracks the install rather than a hardcoded guess.
//-----------------------------------------------------------------------------
function activePlugins() {
  const src = fs.readFileSync(path.join(GAME, 'www', 'js', 'plugins.js'), 'utf8');
  const arr = JSON.parse(src.slice(src.indexOf('['), src.lastIndexOf(']') + 1));
  const map = {};
  for (const p of arr) if (p.status) map[p.name] = p.parameters || {};
  return map;
}

const PLUGINS = activePlugins();

// YEP_SaveCore raises the slot count past the engine's 20; the index is only consulted for
// slots 1..maxSavefiles, so a file above this is unreachable no matter what we write.
const MAX_SAVEFILES = PLUGINS.YEP_SaveCore
  ? Number(PLUGINS.YEP_SaveCore['Max Files']) || 20 : 20;

// YEP_PartySystem replaces battleMembers() with a _battleMembers roster instead of the first
// N of _actors, and makes the cap a saved value. Both change which faces the index records.
const PARTY_SYSTEM = !!PLUGINS.YEP_PartySystem;
const DEFAULT_MAX_BATTLE = PARTY_SYSTEM
  ? Number(PLUGINS.YEP_PartySystem['Max Battle Members']) || 4 : 4;

// HIME_SaveTitle, when active, overwrites info.title with $gameSystem.saveTitle().
const SAVE_TITLE = !!PLUGINS.HIME_SaveTitle;

//-----------------------------------------------------------------------------
// JsonEx decoding. JsonEx.stringify wraps arrays as {"@a": [...]} and tags objects
// with "@" (class name) / "@c" (instance id); plain JSON.parse leaves those in place.
//-----------------------------------------------------------------------------
function arr(v) {
  if (Array.isArray(v)) return v;
  if (v && Array.isArray(v['@a'])) return v['@a'];
  return [];
}

//-----------------------------------------------------------------------------
// The record the game itself would write: DataManager.makeSavefileInfo(), plus the
// overrides installed by the active plugins.
//-----------------------------------------------------------------------------
function battleMembers(contents) {
  const party = contents.party || {};
  const actorData = arr((contents.actors || {})._data);
  const actor = id => actorData[id] || null;
  const appeared = a => a && !a._hidden;

  if (!PARTY_SYSTEM) {
    // Engine default: first maxBattleMembers of _actors that are not hidden.
    return arr(party._actors).slice(0, 4).map(actor).filter(appeared);
  }

  const max = Math.max(
    party._BattleMaxSize === undefined ? DEFAULT_MAX_BATTLE : party._BattleMaxSize, 1);

  // Mirrors Game_Party.toInitializeBattleMembers(): a roster whose length no longer matches
  // the cap is rebuilt from _actors, which is what the game does on the next load.
  let roster = party._battleMembers === null ? null : arr(party._battleMembers);
  if (!roster || roster.length !== max) {
    const actors = arr(party._actors);
    roster = [];
    for (let i = 0; i < max; i++) roster.push(actors[i] || 0);
  }

  const out = [];
  for (const id of roster) {
    if (out.length > max) break;      // YEP uses >, not >=; keep the same boundary
    if (id === null) continue;
    const a = actor(id);
    if (!appeared(a)) continue;
    out.push(a);
  }
  return out;
}

function playtimeText(contents) {
  const frames = ((contents.system || {})._framesOnSave) || 0;
  const total = Math.floor(frames / 60);
  const pad = n => String(n).padStart(2, '0');
  return pad(Math.floor(total / 3600)) + ':' + pad(Math.floor(total / 60) % 60) + ':' +
         pad(total % 60);
}

function makeSavefileInfo(contents, mtimeMs) {
  const members = battleMembers(contents);
  const info = {
    globalId: GLOBAL_ID,
    title: GAME_TITLE,
    characters: members.map(a => [a._characterName, a._characterIndex]),
    faces: members.map(a => [a._faceName, a._faceIndex]),
    playtime: playtimeText(contents),
    // The engine stamps Date.now() at save time. That moment is gone, so use the file's
    // mtime — it is what decides which slot Continue picks (DataManager.latestSavefileId).
    timestamp: mtimeMs,
  };
  if (SAVE_TITLE) info.title = (contents.system || {})._saveTitle;
  return info;
}

//-----------------------------------------------------------------------------
// Scan, rebuild, report.
//-----------------------------------------------------------------------------
function decode(file) {
  return LZString.decompressFromBase64(fs.readFileSync(file, 'utf8'));
}

const oldIndex = (() => {
  const f = path.join(SAVE, 'global.rpgsave');
  if (!fs.existsSync(f)) return [];
  try {
    const parsed = JSON.parse(decode(f) || 'null');
    return Array.isArray(parsed) ? parsed : [];
  } catch (e) {
    console.warn('Existing global.rpgsave is unreadable (' + e.message + '); rebuilding it.');
    return [];
  }
})();

const onDisk = fs.readdirSync(SAVE)
  .map(n => ({ name: n, m: /^file(\d+)\.rpgsave$/.exec(n) }))
  .filter(e => e.m)
  .map(e => ({ id: Number(e.m[1]), name: e.name }))
  .sort((a, b) => a.id - b.id);

const index = [];
const rows = [];
const beyond = [];
const failed = [];

for (const f of onDisk) {
  if (f.id > MAX_SAVEFILES) { beyond.push(f); continue; }

  const full = path.join(SAVE, f.name);
  let contents;
  try {
    const json = decode(full);
    if (!json) throw new Error('empty after decompression');
    contents = JSON.parse(json);
  } catch (e) {
    // Leave whatever record the old index had: better a stale entry the player can try to
    // load than silently dropping a slot because we could not read it.
    failed.push({ file: f.name, why: e.message });
    if (oldIndex[f.id]) index[f.id] = oldIndex[f.id];
    continue;
  }

  const info = makeSavefileInfo(contents, Math.floor(fs.statSync(full).mtimeMs));
  const before = oldIndex[f.id];

  // mtime is only a stand-in for the Date.now() the engine stamped. Where the old record still
  // describes this exact file — same playtime and party, so it was not overwritten since — its
  // timestamp is the real one; keep it rather than nudging Continue's pick by a few ms.
  if (before && before.playtime === info.playtime &&
      JSON.stringify(before.characters) === JSON.stringify(info.characters) &&
      JSON.stringify(before.faces) === JSON.stringify(info.faces) &&
      typeof before.timestamp === 'number') {
    info.timestamp = before.timestamp;
  }
  index[f.id] = info;

  const diff = before ? Object.keys(info).filter(
    k => JSON.stringify(before[k]) !== JSON.stringify(info[k])) : [];
  const state = !before ? 'ADDED' : (diff.length ? 'UPDATED' : 'ok');
  rows.push({ id: f.id, state, info, before, diff });
}

const dropped = [];
for (let i = 1; i < Math.max(oldIndex.length, index.length); i++) {
  if (oldIndex[i] && !index[i]) dropped.push(i);
}

console.log('Game:  ' + GAME);
console.log('Saves: ' + SAVE);
console.log('Slots: ' + onDisk.length + ' file(s) on disk, index holds ' + MAX_SAVEFILES +
            ' slot(s)' + (PLUGINS.YEP_SaveCore ? ' (YEP_SaveCore)' : '') + '\n');

for (const r of rows) {
  const names = r.info.characters.map(c => c[0] + '#' + c[1]).join(', ') || '(no party)';
  console.log('  file' + r.id + '  ' + r.state.padEnd(8) + r.info.playtime +
              '  ' + new Date(r.info.timestamp).toISOString().replace('T', ' ').slice(0, 19) +
              '  [' + names + ']');
  if (r.state === 'UPDATED') {
    for (const k of r.diff) {
      console.log('           ' + k + ': ' + JSON.stringify(r.before[k]) +
                  '  ->  ' + JSON.stringify(r.info[k]));
    }
  }
}
for (const d of dropped) console.log('  file' + d + '  DROPPED  (indexed, but no file on disk)');
for (const f of failed) console.log('  ' + f.file + '  UNREADABLE (' + f.why + ') — left as-is');
for (const b of beyond) {
  console.log('  ' + b.name + '  OUT OF RANGE — slot ' + b.id + ' is past Max Files (' +
              MAX_SAVEFILES + '); the game cannot show it');
}

const changed = rows.some(r => r.state !== 'ok') || dropped.length > 0;
if (!changed) {
  console.log('\nIndex already matches what is on disk. Nothing written.');
  process.exit(0);
}
if (DRY) {
  console.log('\n--dry-run: nothing written.');
  process.exit(0);
}

// Back up before overwriting: the index is the only thing standing between the player and a
// save list that looks empty, and a bad write is not recoverable from the save files alone.
const target = path.join(SAVE, 'global.rpgsave');
if (fs.existsSync(target)) {
  const d = new Date(fs.statSync(target).mtimeMs);
  const pad = n => String(n).padStart(2, '0');
  const stamp = d.getFullYear() + pad(d.getMonth() + 1) + pad(d.getDate()) + '-' +
                pad(d.getHours()) + pad(d.getMinutes()) + pad(d.getSeconds());
  const backup = target + '.bak-' + stamp;
  if (!fs.existsSync(backup)) fs.copyFileSync(target, backup);
  console.log('\nBacked up old index to ' + path.basename(backup));
}

// JSON.stringify on a sparse array emits null for the holes, which is exactly the shape
// loadGlobalInfo() expects (slot 0 is unused).
fs.writeFileSync(target, LZString.compressToBase64(JSON.stringify(index)), 'utf8');

// Read it straight back through the same path the game uses, so a bad write is caught here
// rather than by the player at the load screen.
const verify = JSON.parse(decode(target));
const indexed = verify.map((v, i) => (v ? i : null)).filter(v => v !== null);
console.log('Wrote global.rpgsave — slots indexed: ' + indexed.join(', '));
