// Battle narration: what gets said when a target is hit, afflicted, or killed.
const fs = require('fs'), path = require('path'), vm = require('vm');
const { SRC } = require('./_paths');

global.window = global;
global.document = { addEventListener() {} };
global.require = require;
global.performance = { now: () => 0 };
global.$dataSystem = { optDisplayTp: false, terms: { basic: [], commands: [], params: [] } };
global.$gameVariables = { value: () => 0 };
global.$gameActors = { actor: () => null };
global.$gameParty = { members: () => [], inBattle: () => true };
global.$gameMap = { mapId: () => 1, width: () => 1, height: () => 1, events: () => [] };
global.$gamePlayer = { x: 0, y: 0, direction: () => 2 };

// Just enough of MV's battler for the death hook: die() is what addState(deathStateId) calls.
function Game_BattlerBase() {}
Game_BattlerBase.prototype.die = function () { this._hp = 0; this._dead = true; };
Game_BattlerBase.prototype.isAlive = function () { return !this._dead; };
Game_BattlerBase.prototype.deathStateId = function () { return 1; };
global.Game_BattlerBase = Game_BattlerBase;

// YEP_StealSnatch's message path, reproduced exactly: it never calls addText, it pushes into
// the log window's _lines and refreshes. The mod hooks this method, so it has to exist before
// the mod loads or the hook silently declines to install.
global.SceneManager = { _scene: { _logWindow: { _lines: [], refresh() {} } } };
global.TextManager = { currencyUnit: 'Gil' };
function Game_Action() {}
Game_Action.prototype.displayStealText = function (text) {
  if (!$gameParty.inBattle()) return;
  const scene = SceneManager._scene;
  if (text === '') return;
  if (!scene._logWindow) return;
  scene._logWindow._lines.push(text);
  scene._logWindow.refresh();
};
global.Game_Action = Game_Action;

for (const f of ['BMA_Core.js', 'BMA_Text.js', 'BMA_Menus.js', 'BMA_Nav.js']) {
  vm.runInThisContext(fs.readFileSync(path.join(SRC, f), 'utf8'), { filename: f });
}

let fails = 0;
const check = (name, cond, extra) => {
  if (cond) console.log('  ok   ' + name);
  else { fails++; console.log('  FAIL ' + name + (extra !== undefined ? '  -> ' + extra : '')); }
};
const said = [];
BMA.TTS.speak = t => said.push(t);
const drain = () => new Promise(r => setTimeout(r, 5));

const KNOCKOUT = { id: 1, name: 'Knockout' };
function battler(name) {
  const b = new Game_BattlerBase();
  b.name = () => name;
  return b;
}
// A result shaped like Game_ActionResult.
function result(o) {
  return Object.assign({
    used: true, missed: false, evaded: false, critical: false,
    hpDamage: 0, mpDamage: 0, tpDamage: 0,
    addedStateObjects: () => [], removedStateObjects: () => [],
  }, o);
}
// Mirrors MV: gainHp -> refresh -> addState(deathStateId) -> addNewState -> die(), all during
// the action, before the log ever reports the result.
function hit(target, r) {
  target.result = () => r;
  BMA.Battle.begin(battler('Vahn'), null, [target]);
  if (r.addedStateObjects().some(s => s && s.id === 1)) target.die();
  BMA.Battle.record(target);
  BMA.Battle.flush();
}

(async () => {

// ---------- status afflictions ----------
console.log('\n=== status afflictions ===');
{
  said.length = 0;
  const goblin = battler('Goblin');
  hit(goblin, result({ hpDamage: 12,
    addedStateObjects: () => [{ id: 4, name: 'Poison' }] }));
  await drain();
  check('poison is named', said.join(' ').indexOf('Poison') !== -1, JSON.stringify(said));

  said.length = 0;
  hit(goblin, result({ addedStateObjects: () => [{ id: 10, name: 'Sleep' }] }));
  await drain();
  check('sleep is named', said.join(' ').indexOf('Sleep') !== -1, JSON.stringify(said));

  // Confuse has no message1/message2 in this game's database, which is why the mod speaks state
  // NAMES rather than the engine's messages -- messages would drop it silently.
  said.length = 0;
  hit(goblin, result({ addedStateObjects: () => [{ id: 8, name: 'Confuse' }] }));
  await drain();
  check('confuse is named even though it has no engine message',
        said.join(' ').indexOf('Confuse') !== -1, JSON.stringify(said));

  said.length = 0;
  hit(goblin, result({ removedStateObjects: () => [{ id: 4, name: 'Poison' }] }));
  await drain();
  check('a cured state says so', /Poison recovered/.test(said.join(' ')), JSON.stringify(said));
}

// ---------- KO from an action ----------
console.log('\n=== KO by an attack ===');
{
  said.length = 0;
  const goblin = battler('Goblin');
  hit(goblin, result({ hpDamage: 45, addedStateObjects: () => [KNOCKOUT] }));
  await drain();
  const line = said.join(' ');
  check('the kill is announced', /\bKO\b/.test(line), JSON.stringify(said));
  check('and not as the raw state name', !/Knockout/.test(line), JSON.stringify(said));
  check('alongside the damage', /45 damage/.test(line), JSON.stringify(said));
}

// ---------- KO by instant death / status, still inside an action ----------
console.log('\n=== KO with no damage ===');
{
  said.length = 0;
  const wolf = battler('Wolf');
  hit(wolf, result({ hpDamage: 0, addedStateObjects: () => [KNOCKOUT] }));
  await drain();
  check('a kill dealing no damage is still announced', /\bKO\b/.test(said.join(' ')),
        JSON.stringify(said));
}

// ---------- KO outside any action: poison ticking at end of turn ----------
console.log('\n=== KO by poison, outside an action ===');
{
  said.length = 0;
  const rat = battler('Rat');
  rat.die();                                    // what regenerateHp -> addState(death) reaches
  await drain();
  check('a death with no action in flight is announced', said.some(s => /Rat KO/.test(s)),
        JSON.stringify(said));
}

// ---------- and never twice for the same kill ----------
console.log('\n=== no double announcement ===');
{
  said.length = 0;
  const orc = battler('Orc');
  hit(orc, result({ hpDamage: 30, addedStateObjects: () => [KNOCKOUT] }));
  await drain();
  const hits = said.join(' ').match(/\bKO\b/g) || [];
  check('the kill is reported exactly once', hits.length === 1, JSON.stringify(said));
}

// ---------- an action left open must not swallow the KO ----------
//
// The regression this replaced: the announcement was skipped whenever an action was in flight,
// on the assumption the action's own line would carry it. Anything that leaves _acc set — or any
// break in the displayActionResults path, which this game's battle-log plugin already rewrites —
// then silenced every KO in the game.
console.log('\n=== KO with an action still open ===');
{
  // The next action drains it, so it lands before that action's own narration.
  said.length = 0;
  const bat = battler('Bat');
  BMA.Battle.begin(battler('Vahn'), null, [bat]);   // begun, never flushed
  bat.die();
  await drain();
  check('held back while the action is open', !said.some(s => /Bat KO/.test(s)),
        JSON.stringify(said));
  said.length = 0;
  BMA.Battle.begin(battler('Vahn'), null, [battler('Rat')]);
  await drain();
  check('the next action drains it first', /Bat KO/.test(said[0] || ''), JSON.stringify(said));
  BMA.Battle._acc = null;

  // A battler the action killed but did not report on -- a counter's victim, say -- is said by
  // flush() rather than left pending. No timers anywhere.
  said.length = 0;
  const moth = battler('Moth');
  BMA.Battle.begin(battler('Vahn'), null, [battler('Rat')]);
  moth.die();                                     // not among this action's targets
  BMA.Battle.flush();
  await drain();
  check('flush says the ones its own lines did not cover',
        said.some(s => /Moth KO/.test(s)), JSON.stringify(said));
  check('and nothing is left pending', BMA.Battle._pendingKO.length === 0,
        BMA.Battle._pendingKO.length);
}

// ---------- ordering ----------
console.log('\n=== the KO follows the blow ===');
{
  said.length = 0;
  const imp = battler('Imp');
  hit(imp, result({ hpDamage: 45, addedStateObjects: () => [KNOCKOUT] }));
  await drain();
  const line = said.find(s => /\bKO\b/.test(s)) || '';
  check('damage and KO share one line', /45 damage/.test(line), JSON.stringify(said));
  check('and the damage comes first',
        line.indexOf('45 damage') < line.indexOf('KO'), line);
}

// ---------- a battler already dead does not re-announce ----------
console.log('\n=== already dead ===');
{
  said.length = 0;
  const slime = battler('Slime');
  slime.die();
  await drain();
  said.length = 0;
  slime.die();                                  // clearStates() can route through die() again
  await drain();
  check('dying twice announces once', said.length === 0, JSON.stringify(said));
}

// ---------- steal: all three outcomes reach speech ----------
//
// These were silent because the plugin bypasses addText. The three cases are the three call
// sites of displayStealText in YEP_StealSnatch (success, failure, empty pouch); the formats
// are this game's configured ones.
console.log('\n=== steal ===');
{
  const act = new Game_Action();
  const win = SceneManager._scene._logWindow;

  const steal = text => { said.length = 0; win._lines.length = 0; act.displayStealText(text); };

  // "Stole %4%3!" -- %4 is an icon code, so the raw line carries \i[n].
  steal('Stole \\i[176]Potion!');
  check('success is announced', said.length === 1, JSON.stringify(said));
  check('the icon code is not read aloud', said[0] === 'Stole Potion!', JSON.stringify(said[0]));
  check('the original still reaches the log window',
        win._lines[0] === 'Stole \\i[176]Potion!', JSON.stringify(win._lines));

  steal("Couldn't steal anything!");
  check('failure is announced', said[0] === "Couldn't steal anything!", JSON.stringify(said));

  steal('Nothing to steal...');
  check('an empty pouch is announced, distinctly from a failure',
        said[0] === 'Nothing to steal...', JSON.stringify(said));

  // YEP prepends this itself when Center Text is on.
  steal('<CENTER>Stole \\i[176]Potion!');
  check('a centre tag is not read aloud', said[0] === 'Stole Potion!', JSON.stringify(said[0]));

  steal('');
  check('an empty format stays silent', said.length === 0, JSON.stringify(said));

  said.length = 0;
  $gameParty.inBattle = () => false;
  act.displayStealText('Stole Potion!');
  $gameParty.inBattle = () => true;
  check('nothing is said outside battle', said.length === 0, JSON.stringify(said));
}

console.log(fails ? `\n${fails} CHECK(S) FAILED` : '\nall checks passed');
process.exit(fails ? 1 : 0);
})();
