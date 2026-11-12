// Equip-slot readout, joinParts glue rule, and the wall-tone default + migration.
const fs = require('fs'), path = require('path'), vm = require('vm');
const { SRC, DATA, requireGame } = require('./_paths');
requireGame('equip_config.js');

global.window = global;
global.document = { addEventListener() {} };
global.require = require;
global.performance = { now: () => 0 };
global.$gameVariables = { value: () => 0 };
global.$gameActors = { actor: () => null };
global.$gameParty = { members: () => [], gold: () => 999, numItems: () => 0 };
global.$dataSystem = {
  // Straight from the game's System.json.
  equipTypes: ["", "Weapon", "Shield", "Head", "Body", "Relic", "Nethicite", "Arrows",
               "Card", "Juzu", "Orb", "Doll"],
};
global.DataManager = { isItem: () => false, isWeapon: () => false, isArmor: () => false, isSkill: () => false };

// --- window classes, shaped like MV's (YEP_EquipCore leaves item()/slotName() alone) ---
function Window_Base() {}
Window_Base.prototype.createContents = function () {};
Window_Base.prototype.drawText = function () {};
Window_Base.prototype.drawTextEx = function () {};
function Window_Selectable() {}
Window_Selectable.prototype = Object.create(Window_Base.prototype);
Window_Selectable.prototype.select = function (i) { this._index = i; };
Window_Selectable.prototype.activate = function () {};
Window_Selectable.prototype.index = function () { return this._index; };
function Window_EquipSlot() {}
Window_EquipSlot.prototype = Object.create(Window_Selectable.prototype);
Window_EquipSlot.prototype.maxItems = function () { return this._actor.equipSlots().length; };
Window_EquipSlot.prototype.item = function () { return this._actor.equips()[this.index()]; };
Window_EquipSlot.prototype.slotName = function (i) {
  return $dataSystem.equipTypes[this._actor.equipSlots()[i]];
};
function Window_EquipItem() {}
Window_EquipItem.prototype = Object.create(Window_Selectable.prototype);
global.Window_Base = Window_Base;
global.Window_Selectable = Window_Selectable;
global.Window_EquipSlot = Window_EquipSlot;
global.Window_EquipItem = Window_EquipItem;

for (const f of ['BMA_Core.js', 'BMA_Text.js', 'BMA_Menus.js', 'BMA_Nav.js']) {
  vm.runInThisContext(fs.readFileSync(path.join(SRC, f), 'utf8'), { filename: f });
}

let fails = 0;
const check = (name, cond, extra) => {
  if (cond) console.log('  ok   ' + name);
  else { fails++; console.log('  FAIL ' + name + (extra !== undefined ? '  -> ' + extra : '')); }
};

// --- real slot layouts and real equipment, not invented pairings ---
// Slot layouts come from each class's <Equip Slot> notetag, parsed exactly the way
// YEP_EquipCore.processEquipNotetags1 parses it. Every class in this game repeats a type.

const WEAPONS = JSON.parse(fs.readFileSync(path.join(DATA, 'Weapons.json'), 'utf8'));
const ARMORS  = JSON.parse(fs.readFileSync(path.join(DATA, 'Armors.json'), 'utf8'));
const CLASSES = JSON.parse(fs.readFileSync(path.join(DATA, 'Classes.json'), 'utf8'));

const NOTE1 = /<(?:EQUIP SLOT|equip slots):[ ]*(\d+(?:\s*,\s*\d+)*)>/i;
const NOTE2 = /<(?:EQUIP SLOT|equip slots)>/i;
const NOTE3 = /<\/(?:EQUIP SLOT|equip slots)>/i;
function classSlots(cls) {
  let slots = [], on = false;
  for (const line of (cls.note || '').split(/[\r\n]+/)) {
    let m;
    if ((m = line.match(NOTE1))) slots = slots.concat(JSON.parse('[' + m[1].match(/\d+/g) + ']'));
    else if (line.match(NOTE2)) on = true;
    else if (line.match(NOTE3)) on = false;
    else if (on && (m = line.match(/[ ]*(.*)/i))) {
      const id = $dataSystem.equipTypes.indexOf(String(m[1]));
      if (id >= 0) slots.push(id);
    }
  }
  if (!slots.length) for (let i = 1; i < $dataSystem.equipTypes.length; i++) slots.push(i);
  return slots;
}
// First real item in the game data that genuinely belongs in this slot type.
function itemFor(etype, nth) {
  const pool = etype === 1 ? WEAPONS.filter(w => w && w.name)
                           : ARMORS.filter(a => a && a.etypeId === etype && a.name);
  return pool[nth] || null;
}

console.log('\n=== equip slots (real class layouts + real items) ===');
const byName = {};
CLASSES.filter(Boolean).forEach(c => { if (!byName[c.name]) byName[c.name] = c; });

for (const className of ['Dragoon', 'Monk', 'Gambler', 'Red Mage']) {
  const slots = classSlots(byName[className]);
  // Fill every other occurrence so both filled and empty duplicates are covered.
  const seen = {};
  const loadout = slots.map((etype, i) => {
    seen[etype] = (seen[etype] || 0) + 1;
    return i % 2 === 0 ? itemFor(etype, seen[etype] - 1) : null;
  });
  const win = new Window_EquipSlot();
  win._actor = { equipSlots: () => slots.slice(), equips: () => loadout.slice() };

  const said = [];
  for (let i = 0; i < win.maxItems(); i++) { win._index = i; said.push(BMA.Menus.resolveText(win)); }
  console.log('  ' + className + '  ' + JSON.stringify(slots.map(s => $dataSystem.equipTypes[s])));
  said.forEach(s => console.log('       ' + JSON.stringify(s)));

  const counts = {};
  slots.forEach(s => { counts[s] = (counts[s] || 0) + 1; });
  const ord = {};
  slots.forEach((etype, i) => {
    ord[etype] = (ord[etype] || 0) + 1;
    const base = $dataSystem.equipTypes[etype];
    const label = counts[etype] > 1 ? base + ' ' + ord[etype] : base;
    const item = loadout[i];
    // Names go through cleanText, which strips decorative framing (the database's
    // "==== AXES ====" shop separator becomes "AXES").
    const want = label + ': ' + (item ? BMA.Util.cleanText(item.name) : 'empty');
    check(className + ' slot ' + i + ' reads "' + want + '"', said[i] === want, said[i]);
    // The label/item pairing invariant: an off-by-one would break this even if the
    // expected string above happened to be mistyped.
    if (item) {
      const itemEtype = etype === 1 ? 1 : item.etypeId;
      check('   ...' + base + ' item really belongs there', itemEtype === etype,
            'item etypeId=' + itemEtype + ' slot type=' + etype);
    }
  });
  // Every row must be uniquely identifiable — that is the whole point of the numbering.
  check(className + ': every slot label is unique',
        new Set(said.map(s => s.split(':')[0])).size === said.length, JSON.stringify(said));
}

// Guard that the pairing check can actually fail: shift items by one slot.
{
  const slots = classSlots(byName['Dragoon']);
  const loadout = slots.map((etype, i) => (i % 2 === 0 ? itemFor(etype, 0) : null));
  const badWin = new Window_EquipSlot();
  badWin._actor = { equipSlots: () => slots.slice(), equips: () => [null].concat(loadout.slice(0, -1)) };
  badWin._index = 0;
  check('an off-by-one loadout would be detected',
        BMA.Menus.resolveText(badWin) !== 'Weapon: ' + loadout[0].name,
        BMA.Menus.resolveText(badWin));
}

// Single-occurrence types must NOT be numbered.
{
  const win = new Window_EquipSlot();
  win._actor = { equipSlots: () => [1, 2, 3], equips: () => [null, null, null] };
  win._index = 0;
  check('unique slot types stay unnumbered', BMA.Menus.resolveText(win) === 'Weapon: empty',
        BMA.Menus.resolveText(win));
}

const win = new Window_EquipSlot();
win._actor = { equipSlots: () => classSlots(byName['Dragoon']),
               equips: () => classSlots(byName['Dragoon']).map(() => null) };
const said = [];
for (let i = 0; i < win.maxItems(); i++) { win._index = i; said.push(BMA.Menus.resolveText(win)); }

// The old failure mode: an empty slot fell through to the captured buffer and read the
// whole window back at once. Prove that path is gone even with a populated buffer.
win._bmaLines = said.slice();          // the whole window, exactly as it was drawn
win._index = 2;                        // Head — deliberately empty
check('empty slot ignores the captured window buffer',
      BMA.Menus.resolveText(win) === 'Head: empty', BMA.Menus.resolveText(win));

// "Remove equipment" row in the equip item list: item() is null, must not chunk either.
const list = new Window_EquipItem();
list._index = 0;
list.item = () => null;
list.maxItems = () => 4;
list._bmaLines = ['Spear', 'Lance', 'Pike'];
check('empty equip-item row reads "empty"', BMA.Menus.resolveText(list) === 'empty',
      BMA.Menus.resolveText(list));

console.log('\n=== joinParts glue rule ===');
const cases = [
  [['Vahn', 'Lv', '1', 'HP', '150', '/', '150'], 'Vahn Lv 1 HP 150/150'],
  [['Weapon:', 'Spear'], 'Weapon: Spear'],          // label ending in ':' keeps its space
  [['HP:', '150', '/', '150'], 'HP: 150/150'],
  [['Lv.', '12'], 'Lv 12'],
];
for (const [input, want] of cases) {
  const got = BMA.Util.joinParts(input);
  check(JSON.stringify(want), got === want, JSON.stringify(got));
}

console.log('\n=== wall tone default + migration ===');
check('default wallTone is 2.0', BMA.Config.vol.wallTone === 2.0, BMA.Config.vol.wallTone);
// Simulate a config.rpgsave written before this change: no cfgVersion, wallTone pinned to 1.0.
global.ConfigManager = { makeData: () => ({}), applyData: () => {} };
BMA.Persist.install();
ConfigManager.applyData({ bma: { vol: { footstep: 1, wallTone: 1.0, wallBump: 1, beacon: 1 } } });
check('old save is migrated up to 2.0', BMA.Config.vol.wallTone === 2.0, BMA.Config.vol.wallTone);
// A save written by this build must be respected, including a deliberate turn-down.
ConfigManager.applyData({ bma: { cfgVersion: 2, vol: { footstep: 1, wallTone: 0.5, wallBump: 1, beacon: 1 } } });
check('a deliberate user setting is not clobbered', BMA.Config.vol.wallTone === 0.5, BMA.Config.vol.wallTone);

console.log(fails ? `\n${fails} CHECK(S) FAILED` : '\nall checks passed');
process.exit(fails ? 1 : 0);
