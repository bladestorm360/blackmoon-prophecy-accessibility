//=============================================================================
// BMA_Text.js — dialogue, choices, scrolling text, and battle log.
// FFPR model: read what's shown, as it's shown. No deduplication.
//=============================================================================

(function () {
'use strict';
if (typeof BMA === 'undefined') return;

//----- Messages -----
if (window.Window_Message) {
  var _startMessage = Window_Message.prototype.startMessage;
  Window_Message.prototype.startMessage = function () {
    _startMessage.call(this);
    try {
      var speaker = BMA.Text._speakerName();
      var body = $gameMessage.allText();
      var text = (speaker ? speaker + ': ' : '') + body;
      BMA.Speech.speak(text, { priority: 'normal', category: 'dialogue' });
    } catch (e) {}
  };
}

//----- Scrolling text (e.g. intros) -----
if (window.Window_ScrollText) {
  var _scrollStart = Window_ScrollText.prototype.startMessage ||
                     Window_ScrollText.prototype.refresh;
  if (Window_ScrollText.prototype.refresh) {
    var _refresh = Window_ScrollText.prototype.refresh;
    Window_ScrollText.prototype.refresh = function () {
      _refresh.call(this);
      try {
        var t = $gameMessage.allText();
        if (t) BMA.Speech.speak(t, { priority: 'normal', category: 'dialogue' });
      } catch (e) {}
    };
  }
}

//----- Choices -----
if (window.Window_ChoiceList) {
  var _choiceStart = Window_ChoiceList.prototype.start;
  Window_ChoiceList.prototype.start = function () {
    _choiceStart.call(this);
    try {
      var n = this._list ? this._list.length : (this.maxItems ? this.maxItems() : 0);
      BMA.Speech.speak('Choice, ' + n + (n === 1 ? ' option' : ' options'),
                       { priority: 'critical', category: 'menu' });
    } catch (e) {}
  };
}

//----- Battle log (Coolie_FF_Battle_Log redefines Window_BattleLog as Window_Selectable) -----
if (window.Window_BattleLog) {
  var _addText = Window_BattleLog.prototype.addText;
  Window_BattleLog.prototype.addText = function (text) {
    if (_addText) _addText.call(this, text);
    try { BMA.Speech.speak(text, { priority: 'normal', category: 'battle' }); } catch (e) {}
  };
}

//----- Steal (YEP_StealSnatch) -----
//
// Steal never reached the addText hook above because the plugin does not use addText. Its
// displayStealText pushes the line straight into the log window's _lines array and calls
// refresh(), so the text appears on screen while every hook the mod owns stays silent.
// displayActionResults does not see it either — steal text is not a per-target damage result.
//
// Hooking displayStealText instead of addText is also the tighter join: all three outcomes
// funnel through this one method — stole an item, failed, and "nothing to steal" — so one
// wrapper covers them and there is no fourth path to miss.
//
// cleanText matters more here than for addText's plain narration: the configured Success Text
// is "Stole %4%3!" where %4 is an icon code, so the raw string carries \i[n].
if (window.Game_Action && Game_Action.prototype.displayStealText) {
  var _stealText = Game_Action.prototype.displayStealText;
  Game_Action.prototype.displayStealText = function (text) {
    _stealText.call(this, text);
    try {
      // Deliberately not gated on the log window existing, unlike the original: if the window
      // is missing the sighted player loses the message and we would rather not lose it too.
      if (!$gameParty.inBattle()) return;
      var said = BMA.Util.cleanText(text);
      if (said) BMA.Speech.speak(said, { priority: 'normal', category: 'battle' });
    } catch (e) {}
  };
}

//----- Level up -----
//
// A level-up reaches the player twice. `levelUp()` is the model change and this alias spoke it;
// `changeExp()` then calls `displayLevelUp()`, which pushes "%1 has reached %2 %3!" into
// $gameMessage — and the Window_Message hook at the top of this file speaks the whole box. Both
// are priority 'normal', so neither interrupts the other and the line is simply said twice.
//
// The alias cannot just go, though: `changeExp(exp, show)` skips `displayLevelUp` when `show` is
// false — event command 316, Change Level — and then this is the only announcement there is.
//
// So record the level-up and settle it a tick later. `levelUp()` runs inside changeExp's loop and
// `displayLevelUp()` right after it, both well before the deferred flush, so by the time the
// flush runs the message box has already claimed everything it is going to say.
if (window.Game_Actor) {
  var _pendingLevels = [], _levelFlushArmed = false;

  var _flushLevels = function () {
    _levelFlushArmed = false;
    var q = _pendingLevels;
    _pendingLevels = [];
    for (var i = 0; i < q.length; i++) {
      BMA.Speech.speak(q[i].name + ' reached level ' + q[i].level,
                       { priority: 'normal', category: 'battle' });
    }
  };

  var _levelUp = Game_Actor.prototype.levelUp;
  Game_Actor.prototype.levelUp = function () {
    _levelUp.call(this);
    try {
      _pendingLevels.push({ id: this.actorId(), name: this.name(), level: this._level });
      if (!_levelFlushArmed) { _levelFlushArmed = true; BMA.defer(_flushLevels); }
    } catch (e) {}
  };

  // The message box is about to say it, so drop ours. Clears every pending entry for this actor,
  // not just the last: several levels at once call levelUp() once per level, and MV's own message
  // names only the level landed on.
  if (Game_Actor.prototype.displayLevelUp) {
    var _displayLevelUp = Game_Actor.prototype.displayLevelUp;
    Game_Actor.prototype.displayLevelUp = function (newSkills) {
      try {
        var id = this.actorId();
        _pendingLevels = _pendingLevels.filter(function (p) { return p.id !== id; });
      } catch (e) {}
      _displayLevelUp.call(this, newSkills);
    };
  }
}

BMA.Text = {
  _speakerName: function () {
    // YEP_MessageCore name box: Window_NameBox holds the current speaker.
    try {
      var scene = SceneManager._scene;
      var win = scene && scene._messageWindow;
      var nb = win && win._nameBoxWindow;
      if (nb && nb._text) return BMA.Util.cleanText(nb._text);
      if (nb && nb.windowText) return BMA.Util.cleanText(nb.windowText());
    } catch (e) {}
    return '';
  },

  // Re-read the text panel that is on screen right now — dialogue, a Show Text / pop-up body,
  // or scrolling text. The 'r' key is gated (BMA.Input._textActions) to fire only while a
  // message is active, so with nothing showing this is never reached and the key stays silent.
  readLast: function () {
    try {
      if (!(window.$gameMessage && $gameMessage.isBusy())) return;
      var body = $gameMessage.allText();
      if (!body) return;
      var speaker = this._speakerName();
      BMA.Speech.speak((speaker ? speaker + ': ' : '') + body, { priority: 'critical' });
    } catch (e) {}
  },
};

if (BMA.Input) BMA.Input.register('repeat', function () { BMA.Text.readLast(); });

//=============================================================================
// Battle — combat log, targeting, and the active member's vitals.
//
// The active battle-log plugin (Coolie_FF_Battle_Log) comments out every addText
// call, so the addText hook above is dead in battle. Narration is captured from the
// model layer instead: BattleManager frames each action, Coolie's live
// displayActionResults carries per-target results, and BEC's Window_Help.setBattler
// carries target-cursor moves.
//=============================================================================
BMA.Battle = {
  _acc: null,            // per-action accumulator: { showNames, drain, targets:[...] }
  _counterWord: null,    // 'Counter'/'Reflect' captured from displayCounter/displayReflection
  _counterPending: false,// the next recorded result is the retaliation's own line

  // Action begins: reset the accumulator and announce "Actor: Action". When the action has
  // exactly one target, name it here ("Gordan: Attack: Goblin A") so the result line can drop
  // the name and just say "18 damage".
  begin: function (subject, item, targets) {
    // Anything still unclaimed belongs to the action that just finished — say it before this one
    // starts, so a KO never drifts past the blow that caused it.
    this._drainKO();
    var distinct = [];
    if (targets) for (var i = 0; i < targets.length; i++)
      if (targets[i] && distinct.indexOf(targets[i]) < 0) distinct.push(targets[i]);
    var dtype = item && item.damage ? item.damage.type : 0;   // 5 = HP drain, 6 = MP drain
    this._acc = { showNames: distinct.length > 1, drain: (dtype === 5 || dtype === 6), targets: [] };
    try {
      var who = subject ? BMA.Util.cleanText(subject.name()) : '';
      var act = item && item.name ? BMA.Util.cleanText(item.name) : '';
      var line = who ? (act ? who + ': ' + act : who) : act;
      if (distinct.length === 1 && distinct[0] !== subject)
        line += ': ' + BMA.Util.cleanText(distinct[0].name());
      if (line) BMA.Speech.speak(line, { priority: 'normal', category: 'battle', interrupt: false });
    } catch (e) {}
  },

  _entryFor: function (b) {
    for (var i = 0; i < this._acc.targets.length; i++) if (this._acc.targets[i].b === b) return this._acc.targets[i];
    var e = { b: b, name: BMA.Util.cleanText(b.name()), dmg: 0, heal: 0, mpDmg: 0, mpHeal: 0,
              tpDmg: 0, tpHeal: 0, missed: false, crit: false, states: [], removed: [] };
    this._acc.targets.push(e);
    return e;
  },

  _accumulate: function (target, r) {
    var e = this._entryFor(target);
    if (r.missed || r.evaded) { e.missed = true; return; }
    if (r.critical) e.crit = true;
    if (r.hpDamage > 0) e.dmg += r.hpDamage;
    else if (r.hpDamage < 0) e.heal += -r.hpDamage;
    if (r.mpDamage > 0) e.mpDmg += r.mpDamage;
    else if (r.mpDamage < 0) e.mpHeal += -r.mpDamage;
    if (r.tpDamage > 0) e.tpDmg += r.tpDamage;
    else if (r.tpDamage < 0) e.tpHeal += -r.tpDamage;
    // The death state is spoken as "KO" — the game's own word for it is "Knockout", and the full
    // name buried in a list of afflictions reads as just another status when it is the thing you
    // most need to hear. Matched by name as well as by id: this database has two Knockout states
    // (1 and 49) and only the first is deathStateId().
    var dead = 0;
    try { dead = target.deathStateId(); } catch (e1) {}
    // The death state is left off the line on purpose — noteDeath() announces every KO from
    // die(), which is the only path all causes share, so putting it here too would double it.
    try { r.addedStateObjects().forEach(function (s) {
      if (!s) return;
      var n = s.name ? BMA.Util.cleanText(s.name) : '';
      if (s.id === dead || /knock\s*out/i.test(n)) return;
      if (n && e.states.indexOf(n) < 0) e.states.push(n);
    }); } catch (e2) {}
    try { r.removedStateObjects().forEach(function (s) {
      var n = s && s.name ? BMA.Util.cleanText(s.name) : ''; if (n && e.removed.indexOf(n) < 0) e.removed.push(n);
    }); } catch (e3) {}
  },

  // A counter/reflection: emit the main action's results so far, announce the game's word for
  // it ("Counter"/"Reflect"), then let its damage flush as its own nameless line.
  noteCounter: function (word) {
    var showNames = this._acc ? this._acc.showNames : false;
    this.flush();
    this._acc = { showNames: showNames, drain: false, targets: [] };
    this._counterPending = true;
    try { if (word) BMA.Speech.speak(word, { priority: 'normal', category: 'battle', interrupt: false }); } catch (e) {}
  },

  // One hit's result (target = the battler hit). Multi-hit damage sums into one total.
  // What the game calls death. Its death state is named "Knockout", so KO is its own word rather
  // than one imposed on it, and it is short enough to sit in a list of results without crowding
  // out the damage figure. One constant, so every route to a kill says the same thing.
  KO_WORD: 'KO',

  // Every death, whatever killed it. die() is the one place MV routes them all through:
  // addNewState(deathStateId) calls it, so damage, instant death, a poison or doom tick, and a
  // story event dropping HP to zero all arrive here.
  //
  // Deliberately NOT conditional on an action being in flight. Suppressing it while _acc was set
  // and relying on the action line to carry the KO meant that anything leaving an action open —
  // or any break in the displayActionResults path, which this game's battle-log plugin already
  // rewrites — swallowed the announcement completely. The death state is stripped from the
  // action line instead, so this is the single source and it cannot double up.
  // A KO seen mid-action waits here for that action's line to claim it. No timer: the wait is
  // bounded by the action ending, not by the clock. flush() takes the ones whose battler it is
  // reporting on and says the rest itself, so nothing outlives the action that caused it.
  _pendingKO: [],

  _takeKO: function (b) {
    for (var i = 0; i < this._pendingKO.length; i++) {
      if (this._pendingKO[i].b !== b) continue;
      return this._pendingKO.splice(i, 1)[0];
    }
    return null;
  },

  _drainKO: function () {
    while (this._pendingKO.length) {
      var p = this._pendingKO.shift();
      BMA.Speech.speak(p.name + ' ' + this.KO_WORD, { priority: 'critical' });
    }
  },

  noteDeath: function (battler) {
    try {
      if (!battler) return;
      if (!$gameParty || !$gameParty.inBattle()) return;
      var nm = '';
      try { nm = BMA.Util.cleanText(battler.name()); } catch (e1) {}
      if (!nm) return;
      var word = this.KO_WORD, self = this;

      // Nothing in flight — say it now.
      if (!this._acc) {
        BMA.defer(function () { BMA.Speech.speak(nm + ' ' + word, { priority: 'critical' }); });
        return;
      }
      // Mid-action. die() runs during damage resolution but the damage line is not spoken until
      // the action ends, so announcing here put the KO before the blow that caused it. Hand it to
      // the action's line instead and it reads "45 damage, KO", in the order it happened.
      this._pendingKO.push({ b: battler, name: nm });
    } catch (e) {}
  },

  record: function (target) {
    if (!target) return;
    var r; try { r = target.result(); } catch (e) { return; }
    if (!r || !r.used) return;
    if (this._counterPending) {            // isolate the retaliation onto its own nameless line
      this._counterPending = false;
      var saved = this._acc;
      this._acc = { showNames: false, drain: false, targets: [] };
      this._accumulate(target, r);
      this.flush();
      this._acc = saved;
      return;
    }
    if (!this._acc) return;
    this._accumulate(target, r);
  },

  // Spoken segments for one target: damage / drain / heal / MP / TP / states / miss.
  _segments: function (e, drain) {
    var segs = [], tp = false;
    try { tp = $dataSystem.optDisplayTp; } catch (x) {}
    if (e.dmg > 0) segs.push((e.crit ? 'Critical, ' : '') + e.dmg + (drain ? ' HP drained' : ' damage'));
    if (e.heal > 0) segs.push('Recovered ' + e.heal + ' HP');
    if (e.mpDmg > 0) segs.push(e.mpDmg + (drain ? ' MP drained' : ' MP damage'));
    if (e.mpHeal > 0) segs.push('Recovered ' + e.mpHeal + ' MP');
    if (tp && e.tpDmg > 0) segs.push(e.tpDmg + ' TP damage');
    if (tp && e.tpHeal > 0) segs.push('Recovered ' + e.tpHeal + ' TP');
    if (e.states.length) segs.push(e.states.join(', '));
    if (e.removed.length) segs.push(e.removed.join(', ') + ' recovered');
    if (!segs.length && e.missed) segs.push('Miss');
    return segs;
  },

  // Action ends: one consolidated line per affected target. The name is dropped when the
  // action named its single target up front (or for a retaliation's implied target).
  flush: function () {
    if (!this._acc) return;
    var acc = this._acc; this._acc = null;
    for (var i = 0; i < acc.targets.length; i++) {
      var e = acc.targets[i], segs = this._segments(e, acc.drain);
      // Last on the line, after the damage that caused it.
      if (this._takeKO(e.b)) segs.push(this.KO_WORD);
      if (!segs.length) continue;
      var prefix = acc.showNames ? (e.name + ': ') : '';
      BMA.Speech.speak(prefix + segs.join(', '), { priority: 'normal', category: 'battle', interrupt: false });
    }
    // Anything this action killed that it did not report on — a counter's victim, a battler cut
    // down by something other than the blow itself. The action is over, so it is said now rather
    // than left waiting for one that may never come.
    this._drainKO();
  },

  // Target cursor moved onto a battler. Allies show exact HP/MP; enemies show an HP
  // percentage, simulating the on-screen gauge rather than revealing exact totals.
  // Not deduped: BEC drives this only on cursor moves / re-entry (never per frame), so every
  // target read — including selecting the same target again — must speak, and rapid duplicate
  // calls simply interrupt down to one utterance.
  announceTarget: function (b) {
    if (!b) return;
    try {
      var isActor = b.isActor && b.isActor();
      var text = BMA.Util.cleanText(b.name());
      if (isActor) {
        text += ', HP ' + b.hp + '/' + b.mhp + ', MP ' + b.mp + '/' + b.mmp;
      } else {
        var pct = b.mhp > 0 ? Math.round(b.hp / b.mhp * 100) : 0;
        if (b.hp > 0 && pct === 0) pct = 1;
        text += ', HP ' + pct + ' percent';
      }
      var st = b.states ? b.states().map(function (s) { return BMA.Util.cleanText(s.name); }).filter(Boolean) : [];
      if (st.length) text += ', ' + st.join(', ');
      try {
        var scene = SceneManager._scene;
        var tw = scene && ((scene._enemyWindow && scene._enemyWindow.active && scene._enemyWindow) ||
                           (scene._actorWindow && scene._actorWindow.active && scene._actorWindow));
        if (tw && tw.maxItems && BMA.Config.menuIndex && tw.maxItems() > 1)
          text += ' ' + (tw.index() + 1) + ' of ' + tw.maxItems();
      } catch (e2) {}
      BMA.Speech.speak(text, { priority: 'critical', category: 'menu' });
    } catch (e) {}
  },

  // 'h' — the ACTIVE party member (whose turn it is): name, HP, MP, statuses.
  readVitals: function () {
    try {
      var a = (window.BattleManager && BattleManager.actor && BattleManager.actor()) || null;
      if (!a && window.BattleManager && BattleManager._subject &&
          BattleManager._subject.isActor && BattleManager._subject.isActor()) a = BattleManager._subject;
      if (!a) { BMA.Speech.speak('No active character', { priority: 'critical' }); return; }
      var st = a.states().map(function (s) { return BMA.Util.cleanText(s.name); }).filter(Boolean);
      var line = BMA.Util.cleanText(a.name()) + ': HP ' + a.hp + '/' + a.mhp + ', MP ' + a.mp + '/' + a.mmp;
      if (st.length) line += ', ' + st.join(', ');
      BMA.Speech.speak(line, { priority: 'critical' });
    } catch (e) {}
  },

  //----- Turn heading: command-window readout -----
  // The menu layer announces command-window moves on a deferred, coalesced frame, and its
  // isFocusable/isOpen guard drops that announce while the window is still opening — which is
  // why the very first actor's opening command sometimes went unread. So the turn heading reads
  // the focused command DIRECTLY (below) and arms a one-shot to suppress the menu layer's own
  // announce of that same initial selection, avoiding a double-read.
  _cmdSuppress: null,

  // Text for the command window's current selection ("Attack 1 of 5"), reusing the menu layer's
  // resolveText so it matches ordinary command navigation. Available synchronously regardless of
  // the open animation, since the command list is built before the window opens.
  _commandLine: function (cmd) {
    try {
      if (!cmd || cmd.index() < 0) return '';
      var text = BMA.Menus.resolveText(cmd);
      if (!text) return '';
      if (BMA.Config.menuIndex && cmd.maxItems && cmd.maxItems() > 0)
        text += ' ' + (cmd.index() + 1) + ' of ' + cmd.maxItems();
      return text;
    } catch (e) { return ''; }
  },

  _armCmdSuppress: function (cmd) {
    this._cmdSuppress = cmd;
    var self = this;
    // Disarm on the same defer drain the menu announce runs in: if that announce was dropped
    // (window still opening) it never consumes the token, so clearing it here keeps the token
    // from swallowing the next real navigation read.
    BMA.defer(function () { if (self._cmdSuppress === cmd) self._cmdSuppress = null; });
  },

  // The menu layer calls this before speaking; true means "already read by the turn heading".
  _consumeCmdSuppress: function (win) {
    if (win && win === this._cmdSuppress) { this._cmdSuppress = null; return true; }
    return false;
  },
};
// Victory rewards are the DEFAULT RPG Maker MV flow here (YEP_VictoryAftermath is not enabled):
// each reward is an ordinary message-box line ("18 Gil found!", "... received!", "... dropped!",
// "X reached Level N!"), already spoken by the Window_Message hook at the top of this file. No
// battle-specific victory code is needed — see cleanText's \G handling for the currency wording.

// Frame each action (announce + reset) and flush its results at the end.
if (window.BattleManager) {
  var _bmStartAction = BattleManager.startAction;
  BattleManager.startAction = function () {
    _bmStartAction.call(this);
    try {
      var action = this._action ||
                   (this._subject && this._subject.currentAction && this._subject.currentAction());
      var targets = this._allTargets || this._targets || [];
      BMA.Battle.begin(this._subject, action && action.item ? action.item() : null, targets);
    } catch (e) {}
  };
  var _bmEndAction = BattleManager.endAction;
  BattleManager.endAction = function () {
    try { BMA.Battle.flush(); } catch (e) {}
    _bmEndAction.call(this);
  };
  // Tag the retaliation with the game's word so its results announce as "Counter"/"Reflect".
  // (YEP_X_CounterControl routes counters through invokeCounterAttack but not displayCounter,
  // so these methods — wrapped last by BMA — are the reliable capture point.)
  if (BattleManager.invokeCounterAttack) {
    var _invokeCounter = BattleManager.invokeCounterAttack;
    BattleManager.invokeCounterAttack = function (subject, target) {
      try { BMA.Battle._counterWord = 'Counter'; } catch (e) {}
      _invokeCounter.call(this, subject, target);
      try { BMA.Battle._counterWord = null; } catch (e) {}
    };
  }
  if (BattleManager.invokeMagicReflection) {
    var _invokeReflect = BattleManager.invokeMagicReflection;
    BattleManager.invokeMagicReflection = function (subject, target) {
      try { BMA.Battle._counterWord = 'Reflect'; } catch (e) {}
      _invokeReflect.call(this, subject, target);
      try { BMA.Battle._counterWord = null; } catch (e) {}
    };
  }
}

// Coolie's live per-target results carrier (its addText narration is commented out).
if (window.Window_BattleLog) {
  var _dispResults = Window_BattleLog.prototype.displayActionResults;
  Window_BattleLog.prototype.displayActionResults = function (subject, target) {
    if (_dispResults) _dispResults.call(this, subject, target);
    try {
      // A result whose acting subject isn't the turn's subject is a counter/reflection —
      // give it its own announce line. Prefer the game's word; fall back to "Counter".
      var mismatch = window.BattleManager && BattleManager._subject && subject &&
                     subject !== BattleManager._subject;
      if (BMA.Battle._acc && (BMA.Battle._counterWord || mismatch)) {
        var word = BMA.Battle._counterWord || 'Counter';
        BMA.Battle._counterWord = null;
        BMA.Battle.noteCounter(word);
      }
      BMA.Battle.record(target);   // 2nd arg is always the battler hit
    } catch (e) {}
  };
}

// Turn heading: fires once when an actor's command window appears (not on cursor
// navigation or submenu cancel). Reads the actor name plus the focused command as one
// reliable utterance, so the initial selection is never lost to the deferred menu announce.
if (window.Scene_Battle) {
  var _startActorCmd = Scene_Battle.prototype.startActorCommandSelection;
  Scene_Battle.prototype.startActorCommandSelection = function () {
    _startActorCmd.call(this);
    try {
      var a = BattleManager.actor && BattleManager.actor();
      if (!a) return;
      var name = BMA.Util.cleanText(a.name());
      var cmd = this._actorCommandWindow;
      var line = BMA.Battle._commandLine(cmd);
      if (line) {
        // Name + command together, and suppress the menu layer's own read of this same open.
        BMA.Speech.speak(name + '. ' + line, { priority: 'critical', category: 'menu' });
        BMA.Battle._armCmdSuppress(cmd);
      } else {
        // Command not resolvable this frame — fall back to name, letting the menu announce follow.
        BMA.Speech.speak(name, { priority: 'critical' });
        BMA.Speech.queueNext();
      }
    } catch (e) {}
  };
}

// Target-cursor readout (BEC routes both ally and enemy highlighting through this).
if (window.Window_Help && Window_Help.prototype.setBattler) {
  var _setBattler = Window_Help.prototype.setBattler;
  Window_Help.prototype.setBattler = function (battler) {
    _setBattler.call(this, battler);
    try { if (battler) BMA.Battle.announceTarget(battler); } catch (e) {}
  };
}

// Every death in MV funnels through here: addState(deathStateId) calls die(), and so does any
// plugin that kills a battler directly. Hooking the state instead would miss slip damage.
if (window.Game_BattlerBase) {
  var _die = Game_BattlerBase.prototype.die;
  Game_BattlerBase.prototype.die = function () {
    var alive = false;
    try { alive = this.isAlive(); } catch (e) {}
    _die.call(this);
    try { if (alive) BMA.Battle.noteDeath(this); } catch (e) {}
  };
}

if (BMA.Input) BMA.Input.register('readVitals', function () { BMA.Battle.readVitals(); });

})();
