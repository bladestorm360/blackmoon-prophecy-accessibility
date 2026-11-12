// The name-entry screen (Scene_Name): the 90-cell grid, and the name being built above it.
//
// This game reaches it twice — Mount Palumpu's ev76 names actor 19 (up to 12 characters) and the
// Citadel Chocobo Forest's ev15 names the black chocobo, actor 29 (up to 10) — and both were
// silent. Window_NameInput has neither item() nor commandName(), so resolveText fell through to
// the multi-row guard and logged an unhandled 90-row list; and its cursor keys assign _index
// directly instead of calling select(), so the generic announce hook never fired either.
//
// The window classes below are the real rpg_windows.js implementations of everything the mod
// aliases. A stub that merely looked the part would test the stub — the point here is that the
// shipping aliases still work against the engine's own cursor arithmetic, page flipping and
// add/back bookkeeping.
const fs = require('fs'), path = require('path'), vm = require('vm');
const { SRC, requireGame, loadEngineAssignments } = require('./_paths');
requireGame('menus_name.js');

global.window = global;
global.document = { addEventListener() {} };
global.require = require;
global.performance = { now: () => 0 };
global.$gameVariables = { value: () => 0 };
global.$gameActors = { actor: () => null };
global.$gameParty = { members: () => [] };
global.SceneManager = { _scene: null };
global.SoundManager = { playOk() {}, playCancel() {}, playBuzzer() {}, playCursor() {} };
global.Graphics = { boxWidth: 816, boxHeight: 624 };
global.ImageManager = { reserveFace() {} };
global.$gameSystem = { isJapanese: () => false, isRussian: () => false };

// --- window classes shaped like MV's ---
function Window_Base() {}
Window_Base.prototype.initialize = function (x, y, width, height) {
  Object.assign(this, { x, y, width, height, _openness: 255, visible: true });
};
Window_Base.prototype.fittingHeight = rows => rows * 36 + 36;
Window_Base.prototype.deactivate = function () { this.active = false; };
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
function Window_Help() {}
function Window_Message() {}
function Window_ScrollText() {}
function Window_Command() {}
Window_Command.prototype = Object.create(Window_Selectable.prototype);
function Window_NumberInput() {}
Window_NumberInput.prototype = Object.create(Window_Selectable.prototype);

// Use the installed engine for character data and state changes. Drawing stays stubbed.
function Window_NameEdit() { this.initialize.apply(this, arguments); }
Window_NameEdit.prototype = Object.create(Window_Base.prototype);
Window_NameEdit.prototype.refresh = function () {};

function Window_NameInput() { this.initialize.apply(this, arguments); }
Window_NameInput.prototype = Object.create(Window_Selectable.prototype);
Window_NameInput.prototype.refresh = function () {};
Window_NameInput.prototype.itemRect = () => ({ x: 0, y: 0, width: 0, height: 0 });
Window_NameInput.prototype.setCursorRect = function () {};

// --- Scene_Name ---
function Scene_MenuBase() {}
function Scene_Name() {}
Scene_Name.prototype = Object.create(Scene_MenuBase.prototype);
Scene_Name.prototype.start = function () { this._editWindow.refresh(); };

// A `function` at module scope is a module-local binding, and the mod reads these off `window` —
// so they have to be published before it loads or every `window.Window_X` guard reads undefined.
Object.assign(global, {
  Window_Base, Window_Selectable, Window_Help, Window_Message, Window_ScrollText,
  Window_Command, Window_NumberInput, Window_NameEdit, Window_NameInput,
  Scene_MenuBase, Scene_Name,
});

loadEngineAssignments('rpg_windows.js', [
  ...['initialize', 'windowWidth', 'windowHeight', 'name', 'restoreDefault', 'add', 'back']
    .map(name => 'Window_NameEdit.prototype.' + name),
  ...['LATIN1', 'LATIN2'].map(name => 'Window_NameInput.' + name),
  ...['initialize', 'windowHeight', 'table', 'maxItems', 'character', 'isPageChange', 'isOk',
      'updateCursor', 'cursorRight', 'cursorDown', 'cursorPagedown', 'processJump']
    .map(name => 'Window_NameInput.prototype.' + name),
]);

for (const f of ['BMA_Core.js', 'BMA_Text.js', 'BMA_Menus.js', 'BMA_Nav.js']) {
  vm.runInThisContext(fs.readFileSync(path.join(SRC, f), 'utf8'), { filename: f });
}

let fails = 0;
function check(name, cond, extra) {
  if (cond) console.log('  ok   ' + name);
  else { fails++; console.log('  FAIL ' + name + (extra !== undefined ? '  -> ' + extra : '')); }
}
const drain = () => new Promise(r => setTimeout(r, 5));

// Speech is captured at the TTS layer, so what the checks see is what the reader would be handed.
const spoken = [];
BMA.TTS.speak = t => spoken.push(t);
const last = () => spoken[spoken.length - 1];

function mkActor(name) { return { name: () => name, faceName: () => '' }; }
function mkScene(actorName, maxLength) {
  const scene = Object.create(Scene_Name.prototype);
  scene._actor = mkActor(actorName);
  scene._editWindow = new Window_NameEdit(scene._actor, maxLength);
  scene._inputWindow = new Window_NameInput(scene._editWindow);
  scene._windowLayer = { children: [scene._editWindow, scene._inputWindow] };
  SceneManager._scene = scene;
  return scene;
}

(async () => {

// ---------- 1. one character at a time ----------
console.log('\n=== describeNameChar ===');
{
  const D = c => BMA.Menus.describeNameChar(c);
  // The whole point: 'A' and 'a' are ten cells apart and a reader says the same thing for both.
  check('a capital is stated as one', D('A') === 'capital A', D('A'));
  check('a lowercase letter is left alone', D('a') === 'a', D('a'));
  check('digits pass through', D('7') === '7', D('7'));
  check('space is named', D(' ') === 'space', D(' '));
  check('symbols are named', D('$') === 'dollar sign' && D('~') === 'tilde' &&
        D('[') === 'open square bracket', [D('$'), D('~'), D('[')].join('/'));
  // The accented page is covered by decomposition rather than by forty hand-written entries.
  check('an accented capital names base and mark',
        D('Á') === 'capital A acute', D('Á'));
  check('an accented lowercase does too', D('ü') === 'u diaeresis', D('ü'));
  check('a macron is not mistaken for a hyphen', D('Ū') === 'capital U macron', D('Ū'));
  check('a cedilla is named', D('ç') === 'c cedilla', D('ç'));
  // ...and the handful Unicode cannot take apart get their own words.
  check('an indivisible letter is named outright',
        D('ß') === 'sharp S' && D('Æ') === 'capital A E ligature',
        [D('ß'), D('Æ')].join('/'));
  check('nothing in, nothing out', D('') === '' && D(null) === '', JSON.stringify([D(''), D(null)]));
  // Every cell of both shipped pages must resolve to something speakable, or some letter of the
  // alphabet is a silent cell the player cannot tell from its neighbours.
  const silent = [];
  for (const page of [Window_NameInput.LATIN1, Window_NameInput.LATIN2]) {
    page.slice(0, 88).forEach((c, i) => { if (!D(c)) silent.push(i + ':' + JSON.stringify(c)); });
  }
  check('no cell on either shipped page is silent', silent.length === 0, silent.join(' '));
}

// ---------- 2. the name spelled out ----------
console.log('\n=== spellName ===');
{
  check('spelled character by character, case marked',
        BMA.Menus.spellName('Boco') === 'capital B o c o', BMA.Menus.spellName('Boco'));
  check('a space inside a name is not lost',
        BMA.Menus.spellName('Mr X') === 'capital M r space capital X',
        BMA.Menus.spellName('Mr X'));
  check('an empty name spells to nothing', BMA.Menus.spellName('') === '');
}

// ---------- 3. the cell under the cursor ----------
console.log('\n=== describeNameInput ===');
{
  const scene = mkScene('Shadow', 10);
  const win = scene._inputWindow;
  check('cell 0 is the first letter',
        BMA.Menus.describeNameInput(win) === 'capital A', BMA.Menus.describeNameInput(win));
  win._index = 87;
  check('the space cell says so', BMA.Menus.describeNameInput(win) === 'space');
  // Both command cells are drawn as words on a grid of single characters and say nothing about
  // themselves; character() returns '' for each, which is why neither could be read generically.
  win._index = 88;
  check('Page says what it does',
        BMA.Menus.describeNameInput(win) === 'Page, switch character set',
        BMA.Menus.describeNameInput(win));
  win._index = 89;
  check('OK says what it does', BMA.Menus.describeNameInput(win) === 'OK, finish');
  win._index = 0; win._page = 1;
  check('the second page reads as itself',
        BMA.Menus.describeNameInput(win) === 'capital A acute',
        BMA.Menus.describeNameInput(win));
}

// ---------- 4. it reaches the generic announce path ----------
console.log('\n=== resolveText / position ===');
{
  const scene = mkScene('Shadow', 10);
  const win = scene._inputWindow;
  // Before the fix this hit the "rows > 1" guard and returned '' — the silence being reported.
  check('resolveText handles the grid',
        BMA.Menus.resolveText(win) === 'capital A', BMA.Menus.resolveText(win));
  // "51 of 90" is not a place anyone can navigate to, and it would follow every arrow press.
  check('the linear index is suppressed', BMA.Menus._ownsPosition(win) === true);

  spoken.length = 0;
  BMA.Config.menuIndex = true;
  BMA.Menus.announceCurrent(win);
  await drain();
  check('the grid announces without an index suffix', last() === 'capital A', last());
  BMA.Config.menuIndex = false;
}

// ---------- 5. cursor movement ----------
//
// Window_NameInput replaces cursorDown/Up/Left/Right and none of them calls select(), so the
// generic hook cannot see a move. updateCursor is the call the engine makes after every one.
console.log('\n=== cursor movement ===');
{
  const scene = mkScene('Shadow', 10);
  const win = scene._inputWindow;
  spoken.length = 0;

  win.cursorRight(false);                       // A -> B
  win.updateCursor();
  await drain();
  check('moving across the grid speaks the new cell', last() === 'capital B', last());

  spoken.length = 0;
  win.updateCursor();                           // runs every frame; nothing changed
  await drain();
  check('a frame with no movement stays quiet', spoken.length === 0, JSON.stringify(spoken));

  spoken.length = 0;
  win.cursorDown(false);                        // B -> G, one row down
  win.updateCursor();
  await drain();
  check('a row change speaks too', last() === 'capital G', last());

  // Shift jumps straight to OK from processHandling, which runs after processCursorMove — so it
  // is picked up on the next frame's updateCursor rather than within the call that moved it.
  spoken.length = 0;
  win.processJump();
  win.updateCursor();
  await drain();
  check('the shift jump to OK is announced', last() === 'OK, finish', last());

  // Which alphabet is showing changes what all 90 cells mean, so it is said in front of the cell.
  spoken.length = 0;
  win._index = 0; win.updateCursor(); await drain();
  spoken.length = 0;
  win.cursorPagedown();
  win.updateCursor();
  await drain();
  check('a page flip is announced ahead of the cell',
        spoken[0] === 'Page 2 of 2' && last() === 'capital A acute', JSON.stringify(spoken));
}

// ---------- 6. building the name ----------
console.log('\n=== add / back / restore ===');
{
  const scene = mkScene('Boco', 6);
  const edit = scene._editWindow;
  check('the starting name is the actor\'s', edit.name() === 'Boco', edit.name());

  spoken.length = 0;
  check('add reports success', edit.add('X') === true);
  check('the accepted character is spoken back', last() === 'capital X', last());
  check('and it really went in', edit.name() === 'BocoX', edit.name());

  spoken.length = 0;
  edit.add('y');
  check('lowercase is spoken as itself', last() === 'y', last());

  // A full name answers with a buzzer and nothing else, which is indistinguishable from a
  // keypress that did not register.
  spoken.length = 0;
  check('add refuses past the limit', edit.add('z') === false);
  check('and says why', last() === 'Name full, 6 characters', last());
  check('the name is untouched', edit.name() === 'BocoXy', edit.name());

  spoken.length = 0;
  check('back reports success', edit.back() === true);
  check('the deleted character is named', last() === 'y deleted', last());
  check('and it really went', edit.name() === 'BocoX', edit.name());

  // Deleting to empty and then once more: the second one has nothing to take.
  for (let i = 0; i < 5; i++) edit.back();
  check('deleting to empty works', edit.name() === '', JSON.stringify(edit.name()));
  spoken.length = 0;
  check('back on an empty name reports failure', edit.back() === false);
  check('and says so', last() === 'Name is blank', last());

  // Confirming an empty name puts the original back instead of finishing, which from the outside
  // looks exactly like the OK cell not working.
  spoken.length = 0;
  check('restoreDefault reports success', edit.restoreDefault() === true);
  check('the restored name is spoken',
        last() === 'Name cannot be empty, restored Boco', last());
}

// ---------- 7. read-detail: the whole value ----------
console.log('\n=== describeNameEdit ===');
{
  const scene = mkScene('Boco', 6);
  const edit = scene._editWindow;
  check('the edit window is found from the scene',
        BMA.Menus.nameEditWindow() === edit);
  check('the name is given whole, spelled, and measured',
        BMA.Menus.describeNameEdit(edit) === 'Name Boco, capital B o c o, 4 of 6 characters',
        BMA.Menus.describeNameEdit(edit));
  edit._name = ''; edit._index = 0;
  check('a blank name says how much room there is',
        BMA.Menus.describeNameEdit(edit) === 'Name is blank, up to 6 characters',
        BMA.Menus.describeNameEdit(edit));
  SceneManager._scene = null;
  check('and nothing is found off the naming screen',
        BMA.Menus.nameEditWindow() === null);
}

// ---------- 8. entering the screen ----------
console.log('\n=== Scene_Name entry ===');
{
  // "capital A" on its own says nothing about where the player is or what is being named.
  const scene = mkScene('Shadow', 10);
  spoken.length = 0;
  scene.start();
  await drain();
  check('entry says what the screen is, the name and the limit',
        spoken[0] === 'Name entry. Shadow, up to 10 characters', JSON.stringify(spoken));

  // The actor's name and the starting text are the same string until the player edits, so saying
  // both would say it twice.
  const scene2 = mkScene('Boco', 6);
  scene2._editWindow._name = 'Bo';
  spoken.length = 0;
  scene2.start();
  await drain();
  check('an edited name is named alongside whose it is',
        spoken[0] === 'Name entry. Boco, Bo, up to 6 characters', JSON.stringify(spoken));
}

console.log(fails ? `\n${fails} CHECK(S) FAILED` : '\nall checks passed');
process.exit(fails ? 1 : 0);
})();
