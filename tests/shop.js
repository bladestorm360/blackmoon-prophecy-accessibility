// Shops: the dropped command-row announce, the focus watchdog, and the quantity prompt.
// Loads src/*.js under stubbed MV globals, so it exercises shipping code.
const fs = require('fs'), path = require('path'), vm = require('vm');
const { SRC, GAME, DATA, requireGame, loadEngineAssignments } = require('./_paths');
requireGame('shop.js');

const system = JSON.parse(fs.readFileSync(path.join(DATA, 'System.json'), 'utf8'));

loadEngineAssignments('rpg_core.js', ['String.prototype.format']);

global.window = global;
global.document = { addEventListener() {} };
global.require = require;
global.performance = { now: () => 0 };
global.$dataSystem = system;
global.$gameVariables = { value: () => 0 };
global.$gameActors = { actor: () => null };

// currencyUnit comes from the game's own System.json ("Gil"), not a literal.
global.TextManager = { currencyUnit: system.currencyUnit };

const POTION = { id: 1, name: 'Potion', price: 50, iconIndex: 0 };
let owned = 3, gold = 1500, maxed = false;
global.$gameParty = {
  members: () => [],
  gold: () => gold,
  numItems: () => owned,
  hasMaxItems: () => maxed,
};
global.DataManager = {
  isItem: it => it === POTION, isWeapon: () => false, isArmor: () => false, isSkill: () => false,
};

// --- window classes shaped like MV's ---
function Window_Base() {}
Window_Base.prototype.createContents = function () {};
Window_Base.prototype.drawText = function () {};
Window_Base.prototype.drawTextEx = function () {};
Window_Base.prototype.isOpen = function () { return this._openness >= 255; };
Window_Base.prototype.show = function () { this.visible = true; };
Window_Base.prototype.hide = function () { this.visible = false; };
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

function Window_Command() {}
Window_Command.prototype = Object.create(Window_Selectable.prototype);
function Window_ItemList() {}
Window_ItemList.prototype = Object.create(Window_Selectable.prototype);

// Window_ShopCommand: 3 commands, from the game's own terms.
function Window_ShopCommand() {}
Window_ShopCommand.prototype = Object.create(Window_Command.prototype);
Window_ShopCommand.prototype.maxItems = function () { return 3; };
Window_ShopCommand.prototype.commandName = function (i) {
  return [system.terms.commands[24], system.terms.commands[25], system.terms.commands[22]][i];
};
Window_ShopCommand.prototype.currentSymbol = function () {
  return ['buy', 'sell', 'cancel'][this._index];
};
// BM_ShopCore's category window — a Window_Command too, which is what makes it a hijacker.
function Window_Item2Category() {}
Window_Item2Category.prototype = Object.create(Window_Command.prototype);
Window_Item2Category.prototype.maxItems = function () { return 4; };
Window_Item2Category.prototype.commandName = function (i) {
  return ['Item', 'Weapon', 'Armor', 'Key Item'][i];
};

// Window_ShopBuy extends Window_Selectable in MV, NOT Window_ItemList.
function Window_ShopBuy() {}
Window_ShopBuy.prototype = Object.create(Window_Selectable.prototype);
Window_ShopBuy.prototype.maxItems = function () { return 1; };
Window_ShopBuy.prototype.item = function () { return POTION; };
Window_ShopBuy.prototype.price = function () { return 50; };
Window_ShopBuy.prototype.isEnabled = function (it) {
  return it.price <= gold && !$gameParty.hasMaxItems(it);
};
function Window_ShopSell() {}
Window_ShopSell.prototype = Object.create(Window_ItemList.prototype);
Window_ShopSell.prototype.maxItems = function () { return 1; };
Window_ShopSell.prototype.item = function () { return POTION; };

// Window_ShopNumber: the degenerate selectable — no maxItems override, so it inherits 0.
function Window_ShopNumber() {}
Window_ShopNumber.prototype = Object.create(Window_Selectable.prototype);
Window_ShopNumber.prototype.refresh = function () {};
Window_ShopNumber.prototype.setup = function (item, max, price) {
  this._item = item; this._max = Math.floor(max); this._price = price; this._number = 1;
  this.refresh();
};
Window_ShopNumber.prototype.changeNumber = function (amount) {
  const last = this._number;
  this._number = Math.min(Math.max(this._number + amount, 1), this._max);
  if (this._number !== last) this.refresh();
};

function Scene_MenuBase() {}
function Scene_Shop() {}
Scene_Shop.prototype = Object.create(Scene_MenuBase.prototype);
Scene_Shop.prototype.start = function () {};
Scene_Shop.prototype.update = function () {};
Scene_Shop.prototype.terminate = function () {};
Scene_Shop.prototype.buyingPrice = function () { return 50; };
Scene_Shop.prototype.sellingPrice = function () { return Math.floor(this._item.price / 2); };
Scene_Shop.prototype.doBuy = function (n) { gold -= n * this.buyingPrice(); };
Scene_Shop.prototype.doSell = function (n) { gold += n * this.sellingPrice(); };

Object.assign(global, {
  Window_Base, Window_Selectable, Window_Command, Window_ItemList,
  Window_ShopCommand, Window_Item2Category, Window_ShopBuy, Window_ShopSell, Window_ShopNumber,
  Scene_MenuBase, Scene_Shop,
});
global.SceneManager = { _scene: null };

for (const f of ['BMA_Core.js', 'BMA_Text.js', 'BMA_Menus.js', 'BMA_Nav.js']) {
  vm.runInThisContext(fs.readFileSync(path.join(SRC, f), 'utf8'), { filename: f });
}

let fails = 0;
const check = (name, cond, extra) => {
  if (cond) console.log('  ok   ' + name);
  else { fails++; console.log('  FAIL ' + name + (extra !== undefined ? '  -> ' + extra : '')); }
};
const drain = () => new Promise(r => setTimeout(r, 5));

const said = [];
BMA.TTS.speak = t => said.push(t);
BMA.Config.autodetail = false;          // isolate the announce from the detail readout

// A shop scene with MV's real window order: help, gold, command, dummy, number, status,
// buy, category, sell. Only the Window_Selectables matter to focusedWindow().
function buildShop() {
  const scene = new Scene_Shop();
  const cmd = new Window_ShopCommand();  cmd.initialize();
  const num = new Window_ShopNumber();   num.initialize();
  const buy = new Window_ShopBuy();      buy.initialize();
  const cat = new Window_Item2Category(); cat.initialize();
  const sell = new Window_ShopSell();    sell.initialize();
  scene._commandWindow = cmd; scene._numberWindow = num;
  scene._buyWindow = buy; scene._categoryWindow = cat; scene._sellWindow = sell;
  scene._windowLayer = { children: [cmd, num, buy, cat, sell] };
  return scene;
}

(async () => {

// ---------- 1. the bug, asserted as a fact ----------
console.log('\n=== Scene_Shop.create: the category window hijacks the announce ===');
let scene, cmd, num;
{
  said.length = 0;
  BMA.Shop._armed = false;                       // generic hooks only
  BMA.Menus._lastWin = null; BMA.Menus._lastIndex = -1;
  scene = buildShop(); cmd = scene._commandWindow; num = scene._numberWindow;
  SceneManager._scene = scene;

  // createCommandWindow: Window_Command.initialize does select(0) then activate().
  cmd.select(0); cmd.activate();
  // ...then createNumberWindow/createBuyWindow hide theirs...
  num.hide(); scene._buyWindow.hide(); scene._sellWindow.hide();
  // ...then createCategoryWindow constructs another Window_Command and hides it.
  scene._categoryWindow.select(0);
  scene._categoryWindow.activate();
  scene._categoryWindow.hide();
  scene._categoryWindow.deactivate();

  await drain();
  check('with only the generic hooks, opening a shop says NOTHING', said.length === 0,
        JSON.stringify(said));
  check('the command window is genuinely focusable', BMA.Menus.isFocusable(cmd) === true);
  check('and it IS what focusedWindow resolves to', BMA.Menus.focusedWindow() === cmd);
}

// ---------- 2. the watchdog ----------
console.log('\n=== focus watchdog ===');
{
  said.length = 0;
  BMA.Shop._armed = true;
  scene.update();
  await drain();
  check('one tick announces the focused command', said.length === 1 && said[0] === 'Buy 1 of 3',
        JSON.stringify(said));

  said.length = 0;
  scene.update(); scene.update();
  await drain();
  check('further ticks are silent', said.length === 0, JSON.stringify(said));

  // Arrowing across the row: the generic select hook announces, the watchdog must not repeat it.
  said.length = 0;
  cmd.select(1);
  await drain();
  const afterSelect = said.slice();
  scene.update();
  await drain();
  check('cursor move reads once', afterSelect.length === 1 && afterSelect[0] === 'Sell 2 of 3',
        JSON.stringify(afterSelect));
  check('watchdog does not double-speak what the hooks read', said.length === 1,
        JSON.stringify(said));

  // ...but if that announce is dropped, the watchdog fills the gap.
  said.length = 0;
  BMA.Menus._pending = null;
  cmd._index = 2;                                 // index moved with no announce at all
  scene.update();
  await drain();
  check('a dropped announce is recovered', said.length === 1 && said[0] === 'Cancel 3 of 3',
        JSON.stringify(said));
}

// ---------- 3. a window that resolves to nothing must not spin ----------
console.log('\n=== unreadable focused window ===');
{
  said.length = 0;
  const mystery = new Window_Selectable();
  mystery.initialize();
  mystery.maxItems = () => 5;                     // >1, no item()/commandName() -> resolveText ''
  mystery.select(0); mystery.activate();
  scene._windowLayer.children.push(mystery);
  scene.update(); scene.update(); scene.update();
  await drain();
  check('says nothing', said.length === 0, JSON.stringify(said));
  check('and stops retrying', BMA.Menus._lastWin === mystery);
  scene._windowLayer.children.pop();
  mystery.deactivate();
}

// ---------- 4. quantity prompt ----------
console.log('\n=== quantity prompt ===');
let clock = 10000;
BMA.Shop._now = () => clock;
{
  said.length = 0;
  num.show(); num.activate();                     // onBuyOk: setup, then show + activate
  cmd._index = 0;                                 // buying
  num.setup(POTION, 20, 50);
  await drain();
  check('opening reads item, quantity and total',
        said.length === 1 && said[0] === 'Buy Potion, quantity 1 of 20, total 50 Gil',
        JSON.stringify(said));
  check('the number window is still not focusable', BMA.Menus.focusedWindow() !== num);
  check('but BMA.Shop can find it', BMA.Shop.numberWindow() === num);

  // Throttle: a held key fires ~10x a second; one utterance, carrying the value landed on.
  said.length = 0;
  clock += 1000;
  for (let i = 0; i < 5; i++) num.changeNumber(1);
  await drain();
  check('a burst of changes speaks once', said.length === 1, JSON.stringify(said));
  check('and carries the final value', said[0] === '6, 300 Gil', JSON.stringify(said));

  // Bounds: the engine gives no feedback at all when clamped.
  said.length = 0;
  clock += 1000;
  num._number = 20;
  num.changeNumber(10);
  await drain();
  check('pinned at the ceiling says so', said.length === 1 && said[0] === 'Maximum 20',
        JSON.stringify(said));

  said.length = 0;
  clock += 1000;
  num.changeNumber(10);
  await drain();
  check('and does not repeat while held', said.length === 0, JSON.stringify(said));

  said.length = 0;
  clock += 1000;
  num.changeNumber(-1);
  await drain();
  check('moving off the bound resets the latch', said.length === 1 && said[0] === '19, 950 Gil',
        JSON.stringify(said));

  said.length = 0;
  clock += 1000;
  num._number = 1;
  num.changeNumber(-10);
  await drain();
  check('pinned at the floor says so', said.length === 1 && said[0] === 'Minimum 1',
        JSON.stringify(said));

  // read-detail
  num._number = 3;
  check('detail line carries unit price, owned and the balance after',
        BMA.Shop.detailLine(num) ===
        'Buy Potion, quantity 3 of 20, total 150 Gil, 50 Gil each, have 3, 1350 Gil after, ' +
        'left and right change by 1, up and down by 10',
        BMA.Shop.detailLine(num));
}

// ---------- 5. purchase confirmation ----------
console.log('\n=== confirmation ===');
{
  said.length = 0;
  scene._item = POTION;
  gold = 1500;
  scene.doBuy(3);
  check('bought line reports spend and the new balance',
        said.length === 1 && said[0] === 'Bought 3 Potion, 150 Gil spent, 1350 Gil left',
        JSON.stringify(said));
  check('and the next utterance appends instead of interrupting', BMA.Speech._appendNext === true);
  BMA.Speech._appendNext = false;

  said.length = 0;
  gold = 1500;
  scene.doSell(2);
  check('sold line reports receipt and the new balance',
        said.length === 1 && said[0] === 'Sold 2 Potion, 50 Gil received, 1550 Gil left',
        JSON.stringify(said));
  BMA.Speech._appendNext = false;
}

// ---------- 6. describeItem ----------
console.log('\n=== buy/sell list detail ===');
{
  gold = 1500; owned = 3; maxed = false;
  const buy = scene._buyWindow, sell = scene._sellWindow;
  check('buy: price in the game currency, and owned count',
        BMA.Menus.describeItem(buy, POTION) === 'Potion 50 Gil have 3',
        BMA.Menus.describeItem(buy, POTION));

  maxed = true;
  check('a full stack is not a money problem',
        /cannot carry more/.test(BMA.Menus.describeItem(buy, POTION)),
        BMA.Menus.describeItem(buy, POTION));
  maxed = false; gold = 10;
  check('too poor still says cannot afford',
        /cannot afford/.test(BMA.Menus.describeItem(buy, POTION)),
        BMA.Menus.describeItem(buy, POTION));
  gold = 1500;

  check('sell: the sell price is announced at all',
        BMA.Menus.describeItem(sell, POTION) === 'Potion 25 Gil have 3',
        BMA.Menus.describeItem(sell, POTION));

  const worthless = { id: 2, name: 'Rock', price: 0 };
  check('an unsellable item says so',
        /cannot sell/.test(BMA.Menus.describeItem(sell, worthless)),
        BMA.Menus.describeItem(sell, worthless));

  // sellPriceOf borrows scene._item; it must put it back, including when the borrow throws.
  scene._item = POTION;
  BMA.Shop.sellPriceOf({ price: 80 });
  check('sellPriceOf restores scene._item', scene._item === POTION);
  const boom = Scene_Shop.prototype.sellingPrice;
  Scene_Shop.prototype.sellingPrice = function () { throw new Error('nope'); };
  BMA.Shop.sellPriceOf({ price: 80 });
  check('...even when sellingPrice throws', scene._item === POTION);
  Scene_Shop.prototype.sellingPrice = boom;
}

// ---------- 7. currency wording ----------
console.log('\n=== currency ===');
{
  check('currency uses the game term', BMA.Util.currency(150) === '150 Gil', BMA.Util.currency(150));
  check('no unit falls back to the bare number',
        (() => { const t = TextManager.currencyUnit; TextManager.currencyUnit = '';
                 const r = BMA.Util.currency(7); TextManager.currencyUnit = t; return r === '7'; })());
  // announceGil is registered inside boot(), which this test does not run, so check the
  // source instead: the duplicated || 'Gil' fallback must be gone and routed through currency().
  const core = fs.readFileSync(path.join(SRC, 'BMA_Core.js'), 'utf8');
  check('the g key routes through currency()', /announceGil[\s\S]{0,200}Util\.currency/.test(core));
  check('and no longer hardcodes a fallback unit', !/\|\|\s*'Gil'/.test(core));
  check('describeItem no longer says "gold"',
        !/'\s*gold'|" gold"/.test(fs.readFileSync(path.join(SRC, 'BMA_Menus.js'), 'utf8')));
}

console.log(fails ? '\n' + fails + ' FAILED' : '\nall passed');
process.exit(fails ? 1 : 0);
})();
