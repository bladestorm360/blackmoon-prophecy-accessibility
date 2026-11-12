// Status buffer, the save-screen transient-window bug, and the party windows.
// Loads src/*.js under stubbed MV globals, so it exercises shipping code.
const fs = require('fs'), path = require('path'), vm = require('vm');
const { SRC, GAME, DATA, requireGame, loadEngineAssignments } = require('./_paths');
requireGame('menus_status.js');

const system = JSON.parse(fs.readFileSync(path.join(DATA, 'System.json'), 'utf8'));

// MV adds this in rpg_core.js; the database's EXP headings are format strings that use it.
loadEngineAssignments('rpg_core.js', ['String.prototype.format']);

global.window = global;
global.document = { addEventListener() {} };
global.require = require;
global.performance = { now: () => 0 };
global.$dataSystem = system;
global.$gameVariables = { value: () => 0 };
global.$gameActors = { actor: id => ACTORS[id] || null };
global.$gameParty = { members: () => [], gold: () => 0, numItems: () => 0 };
global.TextManager = {
  param: i => system.terms.params[i],
  hp: system.terms.basic[2], hpA: system.terms.basic[3],
  mp: system.terms.basic[4], mpA: system.terms.basic[5],
  tp: system.terms.basic[6], level: system.terms.basic[0], levelA: system.terms.basic[1],
  exp: system.terms.basic[8], expA: system.terms.basic[9],
  expTotal: '%1 Total', expNext: 'To Next %1',
};
global.DataManager = { isItem: () => false, isWeapon: () => false, isArmor: () => false, isSkill: () => false };

// --- window classes shaped like MV's ---
function Window_Base() {}
Window_Base.prototype.createContents = function () {};
Window_Base.prototype.drawText = function () {};
Window_Base.prototype.drawTextEx = function () {};
Window_Base.prototype.isOpen = function () { return this._openness >= 255; };
Object.defineProperty(Window_Base.prototype, 'openness', {
  get() { return this._openness; }, set(v) { this._openness = v; },
});
function Window_Selectable() {}
Window_Selectable.prototype = Object.create(Window_Base.prototype);
Window_Selectable.prototype.initialize = function () {
  this._index = -1; this._openness = 255; this.visible = true; this.active = false;
};
Window_Selectable.prototype.index = function () { return this._index; };
Window_Selectable.prototype.select = function (i) { this._index = i; };
Window_Selectable.prototype.activate = function () { this.active = true; };
Window_Selectable.prototype.deactivate = function () { this.active = false; };
Window_Selectable.prototype.maxItems = function () { return 0; };
function Window_EquipSlot() {}
Window_EquipSlot.prototype = Object.create(Window_Selectable.prototype);
function Window_PartySelect() {}
Window_PartySelect.prototype = Object.create(Window_Selectable.prototype);
function Window_PartyList() {}
Window_PartyList.prototype = Object.create(Window_Selectable.prototype);
function Window_Command() {}
Window_Command.prototype = Object.create(Window_Selectable.prototype);
function Window_SavefileList() {}
Window_SavefileList.prototype = Object.create(Window_Selectable.prototype);
global.Window_SavefileList = Window_SavefileList;
function Window_QuestList() {}
Window_QuestList.prototype = Object.create(Window_Selectable.prototype);
global.Window_QuestList = Window_QuestList;
function Window_MenuStatus() {}
Window_MenuStatus.prototype = Object.create(Window_Selectable.prototype);
Window_MenuStatus.prototype.maxItems = function () { return $gameParty.members().length; };
function Window_MenuActor() {}                       // extends MenuStatus in MV
Window_MenuActor.prototype = Object.create(Window_MenuStatus.prototype);
global.Window_MenuStatus = Window_MenuStatus;
global.Window_MenuActor = Window_MenuActor;
global.Window_Base = Window_Base; global.Window_Selectable = Window_Selectable;
global.Window_EquipSlot = Window_EquipSlot; global.Window_PartySelect = Window_PartySelect;
global.Window_PartyList = Window_PartyList; global.Window_Command = Window_Command;
global.Yanfly = { Param: { PartyEmptyText: '' } };
global.SceneManager = { _scene: null };

// --- the game's real ICFSoft configuration, read from plugins.js ---
const pluginList = JSON.parse(
  fs.readFileSync(path.join(GAME, 'www', 'js', 'plugins.js'), 'utf8').match(/\[[\s\S]*\]/)[0]);
const icfParams = pluginList.find(p => p.name === 'ICFSoft_StatusMenu').parameters;
const COL1 = icfParams.Column1.toLowerCase().trim().split(/\s+/);
const COL2 = icfParams.Column2.toLowerCase().trim().split(/\s+/);
global.ICF = { Param: {
  NParams: [], PParams: [], PercentageParams: [],
  BParams: ['mhp', 'mmp', 'atk', 'def', 'mat', 'mdf', 'agi', 'luk'],
  XParams: ['hit', 'eva', 'cri', 'cev', 'mev', 'mrf', 'cnt', 'hrg', 'mrg', 'trg'],
  SParams: ['tgr', 'grd', 'rec', 'pha', 'mcr', 'tcr', 'pdr', 'mdr', 'fdr', 'exr'],
  XParamsFullName: Array.from({ length: 10 }, (_, i) => icfParams['XParam' + i + ' Full Name']),
  SParamsFullName: Array.from({ length: 10 }, (_, i) => icfParams['SParam' + i + ' Full Name']),
  EvalParams: [], EvalPercentParams: [],
}};

// --- a real actor: Dragoon slot layout, real items ---
const WEAPONS = JSON.parse(fs.readFileSync(path.join(DATA, 'Weapons.json'), 'utf8'));
const ARMORS  = JSON.parse(fs.readFileSync(path.join(DATA, 'Armors.json'), 'utf8'));
const SLOTS = [1, 2, 3, 4, 5, 5, 6];                       // Dragoon's <Equip Slot: 1,2,3,4,5,5,6>
const EQUIPS = SLOTS.map((et, i) => (i === 2 || i === 5) ? null
  : (et === 1 ? WEAPONS.find(w => w && w.name) : ARMORS.find(a => a && a.etypeId === et && a.name)));
function makeActor(name, level) {
  return {
    name: () => name, level, hp: 340, mhp: 340, mp: 42, mmp: 60, tp: 0, maxTp: () => 100,
    currentClass: () => ({ name: 'Dragoon' }), nickname: () => '',
    isMaxLevel: () => false, currentExp: () => 1234, nextRequiredExp: () => 567,
    states: () => [],
    param: i => [340, 60, 25, 18, 12, 14, 20, 9][i],
    xparam: i => [0.95, 0.05, 0.04, 0, 0, 0, 0, 0, 0, 0][i],
    sparam: i => [1, 1, 1, 1, 0.9, 1, 1, 1, 1, 1.5][i],
    profile: () => 'A dragoon of Branch.',
    equipSlots: () => SLOTS.slice(), equips: () => EQUIPS.slice(),
    statusMenuCols: () => { const s = []; s[1] = COL1; s[2] = COL2; s[3] = []; return s; },
  };
}
const ACTORS = { 12: makeActor('Vahn', 12), 13: makeActor('Hans', 10) };

for (const f of ['BMA_Core.js', 'BMA_Text.js', 'BMA_Menus.js', 'BMA_Nav.js']) {
  vm.runInThisContext(fs.readFileSync(path.join(SRC, f), 'utf8'), { filename: f });
}

let fails = 0;
const check = (name, cond, extra) => {
  if (cond) console.log('  ok   ' + name);
  else { fails++; console.log('  FAIL ' + name + (extra !== undefined ? '  -> ' + extra : '')); }
};
const drain = () => new Promise(r => setTimeout(r, 5));

(async () => {

// ---------- 1. BMA.Buffer ----------
console.log('\n=== BMA.Buffer ===');
{
  const vals = ['a', 'b', 'c', 'd', 'e', 'f'];
  const b = new BMA.Buffer(vals.map(v => () => v), [0, 2, 4], ['One', 'Two', 'Three']);
  check('starts at first entry', b.current() === 'a');
  check('next advances', b.next() === 'b');
  check('prev wraps to the end', (b.index = 0, b.prev()) === 'f', b.current());
  check('next wraps to the top', b.next() === 'a');
  b.index = 0;
  check('nextGroup lands on a group start and names it', b.nextGroup() === 'Two. c', b.current());
  check('nextGroup wraps to the first group', (b.index = 4, b.nextGroup()) === 'One. a');
  check('prevGroup wraps to the last group', (b.index = 0, b.prevGroup()) === 'Three. e');
  b.index = 3;
  const p = b.groupPosition();
  check('groupPosition is within-group', p.index === 1 && p.count === 2, JSON.stringify(p));
  check('top/bottom', b.top() === 'a' && b.bottom() === 'f');
  const empty = new BMA.Buffer([]);
  check('empty buffer is inert', empty.current() === null && empty.next() === null);
  const nogroups = new BMA.Buffer(vals.map(v => () => v));
  check('no groups: group jump is a no-op', nogroups.nextGroup() === 'a');
  check('no groups: position spans the buffer',
        nogroups.groupPosition().count === 6, JSON.stringify(nogroups.groupPosition()));
}

// ---------- 2. BMA.Status.build ----------
console.log('\n=== BMA.Status.build (real ICFSoft columns) ===');
{
  const actor = ACTORS[12];
  const buf = BMA.Status.build(actor);
  const all = [];
  buf.index = 0;
  for (let i = 0; i < buf.count(); i++) { buf.index = i; all.push(buf.current()); }
  all.forEach(s => console.log('       ' + JSON.stringify(s)));

  check('every entry has a value', all.every(s => s && s.length > 0));
  check('no entry is a bare label', !all.some(s => /:\s*$/.test(s)), all.find(s => /:\s*$/.test(s)));
  check('name entry', all[0] === 'Name: Vahn', all[0]);
  check('HP reads current/max', all.some(s => s === 'HP: 340/340'), all.find(s => s.startsWith('HP')));
  check('Column1 params present (game terms)',
        COL1.every(k => {
          const label = TextManager.param(ICF.Param.BParams.indexOf(k));
          return all.some(s => s.indexOf(label + ':') === 0);
        }), JSON.stringify(COL1));
  check('Column2 params present with % values',
        all.some(s => s.indexOf('Hit Rate:') === 0 && s.indexOf('%') > 0),
        all.find(s => s.indexOf('Hit Rate') === 0));
  // Equipment behaviour is asserted in full below, against what the screen actually draws.
  check('equipment group present when something is equipped',
        all.some(s => /^Weapon:/.test(s)), all.filter(s => /^Weapon/.test(s)).join(' | '));
  check('profile included', all.some(s => s === 'A dragoon of Branch.'));
  check('groups named', JSON.stringify(buf.groupNames) ===
        JSON.stringify(['Character', 'Vitals', 'Parameters', 'Extra', 'Equipment', 'Profile']),
        JSON.stringify(buf.groupNames));
}

// ---------- 3. fallback when ICFSoft is absent ----------
console.log('\n=== no ICFSoft ===');
{
  const saved = global.ICF;
  global.ICF = undefined;
  const actor = ACTORS[12];
  const noCols = Object.assign({}, actor, { statusMenuCols: undefined });
  const buf = BMA.Status.build(noCols);
  const all = [];
  for (let i = 0; i < buf.count(); i++) { buf.index = i; all.push(buf.current()); }
  check('still builds without the plugin', buf.count() > 0);
  check('falls back to base params', all.some(s => s.indexOf(TextManager.param(2) + ':') === 0),
        all.join(' | ').slice(0, 120));
  check('no entry threw', all.every(s => s !== null));
  global.ICF = saved;
}

// ---------- 4. status navigation keys ----------
console.log('\n=== status navigation ===');
{
  const said = [];
  BMA.TTS.speak = t => said.push(t);
  BMA.Status.open(ACTORS[12]);
  check('opening speaks the first stat with position',
        said[0] === 'Name: Vahn, 1 of 6', said[0]);
  const key = (k, mods) => BMA.Status.handleKey(Object.assign({ key: k, shiftKey: false, ctrlKey: false }, mods));
  said.length = 0;
  check('down is consumed', key('ArrowDown') === true);
  check('down reads the next stat', said[0] === 'Class: Dragoon, 2 of 6', said[0]);
  said.length = 0;
  key('ArrowDown', { shiftKey: true });
  check('shift+down jumps to the next group and names it',
        said[0] === 'Vitals. HP: 340/340, 1 of 2', said[0]);
  said.length = 0;
  key('ArrowUp', { ctrlKey: true });
  check('ctrl+up goes to the very top', said[0] === 'Name: Vahn, 1 of 6', said[0]);
  check('left/right are NOT consumed', key('ArrowLeft') === false && key('ArrowRight') === false);
  check('q and w fall through to the scene', key('q') === false && key('w') === false);
  check('escape falls through', key('Escape') === false);
  // Paging to another actor keeps the cursor and re-reads live values.
  BMA.Status.buffer.index = 1;
  BMA.Status.retarget(ACTORS[13]);
  said.length = 0;
  BMA.Status.readCurrent();
  check('retarget keeps the cursor position', said[0] === 'Class: Dragoon, 2 of 6', said[0]);
  BMA.Status.buffer.index = 0;
  said.length = 0;
  BMA.Status.readCurrent();
  check('retarget reads the NEW actor', said[0] === 'Name: Hans, 1 of 6', said[0]);
  BMA.Status.close();
  check('closed buffer ignores keys', BMA.Status.handleKey({ key: 'ArrowDown' }) === false);
}

// ---------- 5. the save-screen transient window ----------
console.log('\n=== save screen: Window_SaveConfirm ===');
{
  const said = [];
  BMA.TTS.speak = t => said.push(t);

  // Reproduce YEP's construction order exactly: Window_Command's constructor selects and
  // activates, and Window_SaveConfirm only zeroes openness afterwards.
  DataManager.loadSavefileInfo = id => ({ title: 'Branch Castle', playtime: '1:23:45', characters: [1] });
  const list = new Window_SavefileList();
  list.initialize();
  list.maxItems = () => 4;
  list.select(0); list.activate();

  const confirm = new Window_Command();
  confirm.initialize();
  confirm.maxItems = () => 2;
  confirm.commandName = i => ['Yes', 'No'][i];
  confirm.select(0);                       // <- Window_Command.initialize does this...
  confirm.activate();                      // <- ...and this, while still openness 255
  BMA.Menus.announceCurrent(confirm, true);
  confirm.openness = 0;                    // <- Window_SaveConfirm.initialize, after super

  SceneManager._scene = { _windowLayer: { children: [list, confirm] } };
  BMA.Menus.announceCurrent(list, true);

  await drain();
  check('the closed confirm window says nothing',
        !said.some(s => /^Yes/.test(s)), JSON.stringify(said));
  check('the save list announces instead', said.length === 1 && /^File 1/.test(said[0]),
        JSON.stringify(said));
  check('isFocusable rejects a closed window', BMA.Menus.isFocusable(confirm) === false);
  check('focusedWindow skips it', BMA.Menus.focusedWindow() === list);

  // ...but once it really opens, it must announce.
  said.length = 0;
  confirm.openness = 255;
  BMA.Menus.announceCurrent(confirm, true);
  await drain();
  check('an open confirm window does announce', said[0] === 'Yes 1 of 2', JSON.stringify(said));
}

// ---------- 6. party windows ----------
console.log('\n=== party windows ===');
{
  const sel = new Window_PartySelect();
  sel.initialize();
  sel._data = [12, 13, 0, 0];
  sel.item = function () { return this._data[this._index]; };
  sel.curActor = function () { return $gameActors.actor(this._data[this._index]); };
  sel._index = 0;
  check('battle slot reads name, level and HP',
        BMA.Menus.resolveText(sel) === 'Vahn Lv 12 HP 340/340', BMA.Menus.resolveText(sel));
  sel._index = 2;
  check('empty battle slot says Empty', BMA.Menus.resolveText(sel) === 'Empty', BMA.Menus.resolveText(sel));

  const list = new Window_PartyList();
  list.initialize();
  list._data = [0, 12, 13, 0];
  list.item = function () { return this._data[this._index]; };
  list.curActor = function () { return $gameActors.actor(this._data[this._index]); };
  list._index = 0;
  check('roster remove row says Remove', BMA.Menus.resolveText(list) === 'Remove', BMA.Menus.resolveText(list));
  list._index = 2;
  check('roster actor row reads the actor',
        BMA.Menus.resolveText(list) === 'Hans Lv 10 HP 340/340', BMA.Menus.resolveText(list));

  // The old failure: item() returns a number, describeItem turned it into ''.
  check('never falls back to the captured buffer',
        (list._bmaLines = ['Remove', 'Vahn', 'Hans'], list._index = 1,
         BMA.Menus.resolveText(list)) === 'Vahn Lv 12 HP 340/340', BMA.Menus.resolveText(list));
}

// ---------- 7. status buffer matches what the screen draws ----------
// Reference: the screenshot of Vahn's status page. Only equipped items are drawn
// (drawItemName renders nothing for a null slot), and TP is never drawn at all.
console.log('\n=== status buffer vs. the actual screen ===');
{
  const buf = BMA.Status.build(ACTORS[12]);
  const all = [];
  for (let i = 0; i < buf.count(); i++) { buf.index = i; all.push(buf.current()); }
  const equipEntries = all.filter(s => /^(Weapon|Shield|Head|Body|Relic \d|Nethicite):/.test(s));
  console.log('     equipment entries: ' + JSON.stringify(equipEntries));
  check('only equipped slots appear', equipEntries.length === EQUIPS.filter(Boolean).length,
        equipEntries.length + ' vs ' + EQUIPS.filter(Boolean).length);
  check('no "empty" equipment entries', !all.some(s => / empty$/.test(s)),
        all.find(s => / empty$/.test(s)));
  check('a filled duplicate slot type is still numbered',
        equipEntries.some(s => s.indexOf('Relic 1:') === 0), JSON.stringify(equipEntries));
  check('no TP entry (optDisplayTp is false)', !all.some(s => /^TP:/.test(s)),
        all.find(s => /^TP:/.test(s)));
  check('every group still non-empty',
        buf.groupStarts.every((s, i) => (i + 1 < buf.groupStarts.length ? buf.groupStarts[i + 1] : buf.count()) > s),
        JSON.stringify(buf.groupStarts));

  // An actor wearing nothing must not get an empty Equipment heading.
  const bare = Object.assign({}, ACTORS[12], { equips: () => SLOTS.map(() => null) });
  const bareBuf = BMA.Status.build(bare);
  check('no Equipment group when nothing is equipped',
        bareBuf.groupNames.indexOf('Equipment') === -1, JSON.stringify(bareBuf.groupNames));
  const bareAll = [];
  for (let i = 0; i < bareBuf.count(); i++) { bareBuf.index = i; bareAll.push(bareBuf.current()); }
  check('...and no orphaned equipment entries',
        !bareAll.some(s => /^(Weapon|Shield|Relic)/.test(s)), JSON.stringify(bareAll.slice(-3)));
}

// ---------- 8. character list windows ----------
console.log('\n=== character list windows ===');
{
  const members = [ACTORS[12], ACTORS[13]];
  $gameParty.members = () => members;

  const menu = new Window_MenuStatus();
  menu.initialize();
  // Exactly the blob that was being spoken: the window's whole capture buffer.
  menu._bmaLines = ['Vahn', 'Lv', '1', 'HP', '150', '/', '150', 'MP', '18', '/', '18',
                    'Hans', 'Lv', '1', 'HP', '120', '/', '120', 'MP', '12', '/', '12'];
  menu._index = 0;
  const first = BMA.Menus.resolveText(menu);
  menu._index = 1;
  const second = BMA.Menus.resolveText(menu);
  console.log('     row 0: ' + JSON.stringify(first));
  console.log('     row 1: ' + JSON.stringify(second));
  check('row 0 reads only the first member', first === 'Vahn Lv 12 HP 340/340', first);
  check('row 1 reads only the second member', second === 'Hans Lv 10 HP 340/340', second);
  check('never both in one utterance',
        first.indexOf('Hans') === -1 && second.indexOf('Vahn') === -1);
  check('the capture buffer is not used at all',
        first.indexOf('MP') === -1, first);

  // Window_MenuActor inherits the fix.
  const target = new Window_MenuActor();
  target.initialize();
  target._index = 1;
  check('item targeting reads per-character',
        BMA.Menus.resolveText(target) === 'Hans Lv 10 HP 340/340', BMA.Menus.resolveText(target));
  target.cursorAll = () => true;
  check('a whole-party item says so',
        BMA.Menus.resolveText(target) === 'All party members', BMA.Menus.resolveText(target));

  // Any other multi-row window must stay silent rather than read every row.
  const unknown = new Window_Selectable();
  unknown.initialize();
  unknown.maxItems = () => 5;
  unknown._index = 0;
  unknown._bmaLines = ['row one', 'row two', 'row three'];
  check('an unrecognised list window says nothing', BMA.Menus.resolveText(unknown) === '',
        BMA.Menus.resolveText(unknown));
  // ...but a single-row window may still fall back to its capture.
  const single = new Window_Selectable();
  single.initialize();
  single.maxItems = () => 1;
  single._index = 0;
  single._bmaLines = ['Quest', 'Complete'];
  check('a single-row window still falls back', BMA.Menus.resolveText(single) === 'Quest Complete',
        BMA.Menus.resolveText(single));
}

// ---------- 9. decorative dashes and actor paging ----------
console.log('\n=== misc ===');
{
  check('framing dashes are stripped', BMA.Util.cleanText('- Empty -') === 'Empty',
        BMA.Util.cleanText('- Empty -'));
  check('inner hyphens survive', BMA.Util.cleanText('Choco-Brett') === 'Choco-Brett',
        BMA.Util.cleanText('Choco-Brett'));
  check('actor page label is name and position',
        BMA.Menus.describeActorPage(ACTORS[13]) === 'Hans, 2 of 2',
        BMA.Menus.describeActorPage(ACTORS[13]));
  $gameParty.members = () => [ACTORS[12]];
  check('a lone party member gets no position',
        BMA.Menus.describeActorPage(ACTORS[12]) === 'Vahn',
        BMA.Menus.describeActorPage(ACTORS[12]));
}

// ---------- 10. speech log ----------
console.log('\n=== speech log ===');
{
  const lines = [];
  BMA.Log.write = m => lines.push(m);
  BMA.TTS.speak = () => {};
  // On by default now. A log written with it off is the boot sequence and nothing else, so a
  // player who sends one after hitting something has sent no evidence — see BMA.Config.speechLog.
  check('speech logging is on out of the box', BMA.Config.speechLog === true);
  check('so is perf logging', BMA.Config.perfLog === true);
  // Log.say defers its write, so the sections above — which now run with logging on — still have
  // entries in flight. Turn it off, let those land, and only then start counting.
  BMA.Config.speechLog = false;
  await drain();
  lines.length = 0;
  BMA.Speech.speak('quiet please', { priority: 'critical' });
  await drain();
  check('the toggle still gates it: nothing logged when off', lines.length === 0,
        JSON.stringify(lines));
  BMA.Config.speechLog = true;
  BMA.Speech.speak('Entering Branch Castle', { priority: 'critical' });
  await drain();
  check('on: the utterance is logged', lines.length === 1 && lines[0] === 'say: Entering Branch Castle',
        JSON.stringify(lines));
  lines.length = 0;
  BMA.Speech.speak('\\C[3]Wylla:\\C[0] Need a rest?', { priority: 'critical' });
  await drain();
  check('logs the cleaned text the reader was handed',
        lines[0] === 'say: Wylla: Need a rest?', JSON.stringify(lines));
  BMA.Config.speechLog = false;

  // The installs that most need the diagnostics are the ones that have been played, and those
  // already have a config.rpgsave holding the old `false`. Without the migration the new default
  // would reach nobody but a fresh install — which is the one case where nothing has gone wrong.
  BMA.Config.perfLog = false;
  BMA.Persist._migrate(2);
  check('migrating an older config turns both diagnostics on',
        BMA.Config.speechLog === true && BMA.Config.perfLog === true,
        JSON.stringify([BMA.Config.speechLog, BMA.Config.perfLog]));
  check('the config version was bumped to carry it', BMA.Persist.VERSION >= 3, BMA.Persist.VERSION);
  BMA.Config.speechLog = false;
}

// ---------- 11. queued announcements ----------
console.log('\n=== queueNext ===');
{
  const spoken = [];                       // [text, interrupt]
  BMA.TTS.speak = (t, i) => spoken.push([t, i]);
  BMA.Speech.speak('first', { priority: 'critical' });
  BMA.Speech.queueNext();
  BMA.Speech.speak('second', { priority: 'critical' });
  BMA.Speech.speak('third', { priority: 'critical' });
  check('the heading interrupts', spoken[0][0] === 'first' && spoken[0][1] === true,
        JSON.stringify(spoken[0]));
  check('the queued follow-up appends', spoken[1][0] === 'second' && spoken[1][1] === false,
        JSON.stringify(spoken[1]));
  check('the flag is one-shot', spoken[2][0] === 'third' && spoken[2][1] === true,
        JSON.stringify(spoken[2]));
}

// Replay the equip-screen sequence: onActorChange activates the command window (scheduling a
// deferred announce) and only then does the alias speak the actor name.
console.log('\n=== equip screen actor switch ===');
{
  const spoken = [];
  BMA.TTS.speak = (t, i) => spoken.push([t, i]);
  const cmd = new Window_Command();
  cmd.initialize();
  cmd.maxItems = () => 3;
  cmd.commandName = i => ['Equip', 'Optimize', 'Clear'][i];
  cmd.select(0); cmd.activate();
  SceneManager._scene = { _windowLayer: { children: [cmd] } };

  BMA.Menus.announceCurrent(cmd, true);                     // what activate() does
  BMA.Speech.speak('Hans, 2 of 2', { priority: 'critical' }); // what the alias does
  BMA.Speech.queueNext();
  await drain();

  check('name is spoken first and interrupts',
        spoken[0][0] === 'Hans, 2 of 2' && spoken[0][1] === true, JSON.stringify(spoken[0]));
  check('the focused command follows without cutting it off',
        spoken[1] && spoken[1][0] === 'Equip 1 of 3' && spoken[1][1] === false,
        JSON.stringify(spoken[1]));
  check('exactly two utterances', spoken.length === 2, JSON.stringify(spoken));
}

// ---------- 12. Marks list ----------
console.log('\n=== Marks (Galv_QuestLog) ===');
{
  global.Galv = { QUEST: { categories: [
    { id: 0, name: 'Standard Marks', color: '#ffcc66' },
    { id: 1, name: 'Elite Marks', color: '#ffff99' },
  ]}};
  global.$gameSystem = { _quests: {
    tracked: 2,
    categoryHide: { active: [], completed: [] },
  }};
  // Shaped like Galv's Game_Quest: name is a METHOD, not a string.
  function quest(id, name) {
    return { _id: id, _status: 0, name: () => name };
  }
  const rows = [
    { categoryTitle: 0, count: 3 },
    quest(1, 'Vertumnus'),
    quest(2, 'Hell House'),
    quest(3, 'Angler'),
    { categoryTitle: 1, count: 0 },
  ];
  const list = new Window_QuestList();
  list.initialize();
  list._category = 'active';
  list.maxItems = () => rows.length;
  list.item = function () { return rows[this._index]; };

  const read = i => { list._index = i; return BMA.Menus.resolveText(list); };
  const all = rows.map((_, i) => read(i));
  all.forEach(s => console.log('       ' + JSON.stringify(s)));

  check('category header reads name and count', all[0] === 'Standard Marks: 3', all[0]);
  check('empty category still reads', all[4] === 'Elite Marks: 0', all[4]);
  check('a mark reads its name', all[1] === 'Vertumnus', all[1]);
  check('the tracked mark says so', all[2] === 'Hell House, tracked', all[2]);
  check('an untracked mark does not', all[3] === 'Angler', all[3]);
  // The bug this replaces: Game_Quest.name is a function, and String(fn) is its source.
  check('never reads function source', !all.some(s => /function|return/.test(s)),
        all.find(s => /function|return/.test(s)));
  check('never silent on a populated list', all.every(s => s && s.length), JSON.stringify(all));

  // A collapsed category hides its marks, so say so — that is the one case where the entries
  // underneath are genuinely not browsable.
  $gameSystem._quests.categoryHide.active[0] = true;
  check('a collapsed category is flagged', read(0) === 'Standard Marks: 3, collapsed', read(0));
  $gameSystem._quests.categoryHide.active[0] = false;
  check('...and not flagged when expanded', read(0) === 'Standard Marks: 3', read(0));

  // The same callable-name resolution must work through the generic item path.
  check('describeItem resolves a callable name',
        BMA.Menus.describeItem({}, { name: () => 'Potion' }) === 'Potion',
        BMA.Menus.describeItem({}, { name: () => 'Potion' }));
  check('describeItem still handles a plain string name',
        BMA.Menus.describeItem({}, { name: 'Ether' }) === 'Ether',
        BMA.Menus.describeItem({}, { name: 'Ether' }));
}

console.log(fails ? `\n${fails} CHECK(S) FAILED` : '\nall checks passed');
process.exit(fails ? 1 : 0);
})();
