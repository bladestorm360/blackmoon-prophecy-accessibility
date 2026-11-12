//=============================================================================
// BMA_Menus.js — menu/window readout, detail reading, autodetail, usable-by,
// and the virtual review buffer.
//
// Enabling primitive: a text-capture layer that records every string a window draws
// (drawText / drawTextEx) into an ordered per-window buffer, turning any panel —
// quest info, status stats, help, item description — into readable, browsable text.
//=============================================================================

(function () {
'use strict';
if (typeof BMA === 'undefined' || !window.Window_Base) return;

//-----------------------------------------------------------------------------
// Text-capture layer
//-----------------------------------------------------------------------------
var _createContents = Window_Base.prototype.createContents;
Window_Base.prototype.createContents = function () {
  _createContents.call(this);
  if (!this._bmaLines) this._bmaLines = [];
  var win = this;
  if (this.contents && !this.contents._bmaWrapped) {
    this.contents._bmaWrapped = true;
    var _clear = this.contents.clear.bind(this.contents);
    this.contents.clear = function () { win._bmaLines = []; return _clear(); };
  }
};

// A window that redraws without calling contents.clear() never resets its buffer, so cap
// it: only the most recent lines are ever read back anyway.
var BMA_MAX_LINES = 200;
function bmaPush(win, text) {
  win._bmaLines.push(String(text));
  if (win._bmaLines.length > BMA_MAX_LINES) win._bmaLines.shift();
}

var _drawText = Window_Base.prototype.drawText;
Window_Base.prototype.drawText = function (text, x, y, maxWidth, align) {
  if (this._bmaLines && text !== '' && text != null) bmaPush(this, text);
  return _drawText.apply(this, arguments);
};

var _drawTextEx = Window_Base.prototype.drawTextEx;
Window_Base.prototype.drawTextEx = function (text, x, y) {
  if (this._bmaLines && text) bmaPush(this, text);
  return _drawTextEx.apply(this, arguments);
};

//-----------------------------------------------------------------------------
// Generic selectable readout
//-----------------------------------------------------------------------------
var _select = Window_Selectable.prototype.select;
Window_Selectable.prototype.select = function (index) {
  var changed = this._index !== index;
  _select.call(this, index);
  try {
    if (changed && index >= 0 && this.active && this.visible) BMA.Menus.announceCurrent(this);
  } catch (e) {}
};

var _activate = Window_Selectable.prototype.activate;
Window_Selectable.prototype.activate = function () {
  _activate.call(this);
  try {
    if (this.index() >= 0 && this.visible) BMA.Menus.announceCurrent(this, true);
  } catch (e) {}
};

//-----------------------------------------------------------------------------
BMA.Menus = {
  // Is this window actually presented to the player right now?
  //
  // `active` alone is not enough. Window_Command's constructor calls select(0) then activate()
  // (rpg_windows.js), so a window announces itself while the scene is still being built — that
  // is why opening the save screen said "Yes, 1 of 2": YEP's Window_SaveConfirm is created last
  // and only sets openness = 0 *after* the super constructor returns. It then stays active and
  // closed forever, so isOpen() (openness >= 255) is the reliable test.
  isFocusable: function (win) {
    try {
      if (!win || !win.active || !win.visible) return false;
      if (typeof win.isOpen === 'function' && !win.isOpen()) return false;
      if (typeof win.index !== 'function' || win.index() < 0) return false;
      return true;
    } catch (e) { return false; }
  },

  // Announcements are deferred and coalesced to one per frame: a scene fires several
  // select/activate calls while constructing, and only the window still focused once the frame
  // settles is the one the player is on.
  _pending: null,
  announceCurrent: function (win, onActivate) {
    // Keep an on-entry (onActivate) flag if a same-window select() coalesces into a just-set
    // activate() — a pop-up calls open()+activate()+select(0) in one breath, and the trailing
    // select would otherwise downgrade it and drop the entry-only extras (the pop-up body).
    if (this._pending && this._pending.win === win && this._pending.onActivate) onActivate = true;
    this._pending = { win: win, onActivate: onActivate };
    var self = this;
    if (this._announceScheduled) return;
    this._announceScheduled = true;
    var tries = 0;
    function run() {
      var p = self._pending;
      // A pop-up (e.g. Window_SaveConfirm) activates while still animating open, so its opening
      // read would be dropped by the isOpen gate below. Wait for the open animation to finish
      // instead of losing the initial announce. Capped so a window that never opens can't spin.
      if (p && p.win && p.win.active && p.win.visible &&
          typeof p.win.index === 'function' && p.win.index() >= 0 &&
          typeof p.win.isOpening === 'function' && p.win.isOpening() && tries++ < 30) {
        setTimeout(run, 16);
        return;
      }
      self._announceScheduled = false;
      self._pending = null;
      if (!p || !self.isFocusable(p.win)) return;
      if (self.focusedWindow() !== p.win) return;      // something above it took focus
      // The battle turn heading already read this actor-command window's opening selection.
      if (BMA.Battle && BMA.Battle._consumeCmdSuppress && BMA.Battle._consumeCmdSuppress(p.win)) return;
      self._speakCurrent(p.win, p.onActivate);
    }
    BMA.defer(run);
  },

  _speakCurrent: function (win, onActivate) {
    var text = this.resolveText(win);
    // On entry, prefix any pop-up prompt (e.g. "Save to this file?") ahead of the focused option.
    var body = onActivate ? this.popupBody(win) : '';
    if (!text && !body) return;
    var pos = '';
    try {
      // Its own toggle rather than a side effect of verbosity, and no leading comma —
      // the mod does not add punctuation the game did not draw.
      if (text && BMA.Config.menuIndex && win.maxItems && win.maxItems() > 0 &&
          !this._ownsPosition(win))
        pos = ' ' + (win.index() + 1) + ' of ' + win.maxItems();
    } catch (e) {}
    var line = (body ? body + '. ' : '') + (text ? text + pos : '');
    BMA.Speech.speak(line, { priority: 'critical', category: 'menu' });
    this.noteSpoken(win);
    if (BMA.Config.autodetail && !onActivate) this.readDetail(win, true);
  },

  // Windows that say where the cursor is as part of their own readout, so the generic
  // "N of M" suffix would say it twice. Number entry is the only one: "digit 2 of 3" has to be
  // spoken whether or not the player has the index suffix turned on, because a code is a
  // position-sensitive value and a bare digit tells them nothing about which one they just moved.
  // ...and the naming grid, for the opposite reason: its index is a position in a 90-cell block
  // laid out ten to a row, so "51 of 90" is not somewhere anybody can navigate to, and it would be
  // repeated after every arrow press. On that screen the character IS the position — a player
  // finds a letter by hearing it go past.
  _ownsPosition: function (win) {
    return !!((window.Window_NumberInput && win instanceof Window_NumberInput) ||
              (window.Window_NameInput && win instanceof Window_NameInput));
  },

  // What the player was last actually told they are on. The shop watchdog compares against this
  // to tell "the generic hooks already read this" from "the announce was dropped" — recorded
  // after the speak, so a window that resolved to nothing does not count as read.
  _lastWin: null,
  _lastIndex: -1,
  noteSpoken: function (win) {
    this._lastWin = win || null;
    try { this._lastIndex = (win && typeof win.index === 'function') ? win.index() : -1; }
    catch (e) { this._lastIndex = -1; }
  },

  // Pop-up prompt/body — the line a confirm pop-up draws above its Yes/No (e.g. "Save to this
  // file?"). Spoken once on entry ahead of the focused option. YEP's confirm pop-ups are
  // Window_Command subclasses that stash the prompt in _text (Window_SaveConfirm; other confirms
  // follow the same shape). Window_Help/Window_Message/Window_ScrollText also carry _text but are
  // read by their own hooks, so exclude them.
  popupBody: function (win) {
    try {
      if (!win || typeof win._text !== 'string' || !win._text) return '';
      if (window.Window_Help && win instanceof Window_Help) return '';
      if (window.Window_Message && win instanceof Window_Message) return '';
      if (window.Window_ScrollText && win instanceof Window_ScrollText) return '';
      if (window.Window_Command && win instanceof Window_Command)
        return BMA.Util.cleanText(win._text);
      return '';
    } catch (e) { return ''; }
  },

  resolveText: function (win) {
    try {
      // Battle target windows are read by BMA.Battle.announceTarget via the help
      // window's setBattler hook; stay silent here so they never double-speak.
      if ((window.Window_BattleActor && win instanceof Window_BattleActor) ||
          (window.Window_BattleEnemy && win instanceof Window_BattleEnemy)) return '';
      if (window.Window_Options && win instanceof Window_Options) {
        return BMA.Util.joinParts([win.commandName(win.index()), win.statusText(win.index())]);
      }
      if (window.Window_SavefileList && win instanceof Window_SavefileList) {
        return this.describeSavefile(win);
      }
      if (window.Window_EquipSlot && win instanceof Window_EquipSlot) {
        return this.describeEquipSlot(win);
      }
      // YEP_PartySystem's two lists return an actor ID (a bare number) from item(), which the
      // generic item branch below turns into an empty string — that is why the party screen
      // said nothing at all. Both expose curActor(); use it.
      if (window.Window_PartySelect && win instanceof Window_PartySelect) {
        var pa = win.curActor && win.curActor();
        if (pa) return this.describeActorBrief(pa);
        var emptyText = '';
        try { emptyText = BMA.Util.cleanText(Yanfly.Param.PartyEmptyText || ''); } catch (e) {}
        return emptyText || 'Empty';
      }
      if (window.Window_PartyList && win instanceof Window_PartyList) {
        if (!win.item || !win.item()) return 'Remove';    // the roster's remove rows are id 0
        var la = win.curActor && win.curActor();
        return la ? this.describeActorBrief(la) : 'Remove';
      }
      // The main menu's character list (and Window_MenuActor, which extends it for item and
      // skill targeting) has no item() — the engine itself reads the row as
      // $gameParty.members()[index]. Without this it fell through to the whole-window capture
      // and read every party member in one breath.
      if (window.Window_MenuStatus && win instanceof Window_MenuStatus) {
        if (win.cursorAll && win.cursorAll()) return 'All party members';
        var ma = $gameParty.members()[win.index()];
        return ma ? this.describeActorBrief(ma) : '';
      }
      // Galv_QuestLog, which this game configures as the Marks screen. Its item() returns two
      // different shapes — a category header object or a Game_Quest — and neither survives
      // describeItem: the header has no `name` at all (hence the silence), and Game_Quest's
      // `name` is a method.
      if (window.Window_QuestList && win instanceof Window_QuestList) {
        return this.describeMark(win);
      }
      // Number entry — in this game, the Fey Spire's three security consoles. Unlike
      // Window_ShopNumber this *is* a proper Window_Selectable (maxItems() is the digit count and
      // start() calls select(0)), so the generic hooks do fire on it. It just has neither item()
      // nor commandName(), so it fell past every branch to the multi-row guard below and was
      // logged as an unhandled list — three digits' worth of silence.
      if (window.Window_NumberInput && win instanceof Window_NumberInput) {
        return this.describeNumberInput(win);
      }
      // Name entry. Same shape as number entry and the same blind spot: it IS a proper
      // Window_Selectable, so the generic hooks do reach it, but it has neither item() nor
      // commandName() — so all 90 cells fell past every branch to the multi-row guard below and
      // the screen was logged as an unhandled list rather than spoken. Its cursor keys need a hook
      // of their own as well; see Window_NameInput.updateCursor further down.
      if (window.Window_NameInput && win instanceof Window_NameInput) {
        return this.describeNameInput(win);
      }
      if (typeof win.item === 'function') {
        var it = win.item();
        if (it) return this.describeItem(win, it);
        // A list entry with no item is an empty equip slot or the "remove equipment" row.
        // Falling through to the captured buffer here read the whole window back as one
        // chunk — every slot at once — which is what made empty slots unusable.
        if (win.maxItems && win.maxItems() > 0) return this.EMPTY_SLOT;
      }
      if (typeof win.commandName === 'function' && win.index() >= 0) {
        var c = win.commandName(win.index());
        if (c) return BMA.Util.cleanText(c);
      }
      // The capture buffer holds everything the window drew, so it is only ever a safe stand-in
      // for the selection on a single-row window. On a list it is every row at once — which is
      // how the character list came out as "Vahn Lv 1 ... Hans Lv 1 ...". Say nothing instead,
      // and leave a breadcrumb in the speech log so an unhandled list shows up as a log line
      // rather than a wall of speech.
      var rows = 1;
      try { if (typeof win.maxItems === 'function') rows = win.maxItems(); } catch (e) {}
      if (rows > 1) {
        BMA.Log.say('unhandled list window: ' + this._className(win) + ', ' + rows + ' rows');
        return '';
      }
      // Windows draw a status row as separate fragments ('Vahn','Lv','1','HP','150','/','150');
      // joinParts stitches them without inventing the periods that used to appear between them.
      if (win._bmaLines && win._bmaLines.length) {
        return BMA.Util.joinParts(win._bmaLines.map(function (s) { return BMA.Util.cleanText(s); }));
      }
    } catch (e) {}
    return '';
  },

  _className: function (win) {
    try {
      if (win.constructor && win.constructor.name) return win.constructor.name;
    } catch (e) {}
    return 'unknown';
  },

  // "4, digit 2 of 3" — the digit the cursor is on first, because that is what the player just
  // changed and what they are listening for, then where it sits.
  //
  // Terse by default: both axes repeat (~10 a second on a held key), so the automatic readout has
  // to be short enough to survive being interrupted by the next one. `full` adds the whole value
  // and is what the read-detail key asks for. The value is spelled out digit by digit on purpose
  // — a reader says "341" as "three hundred forty-one", which is not what somebody copying a
  // posted code wants to hear.
  //
  // Mirrors drawItem's own padZero(_maxDigits), so what is spoken is what is drawn, leading
  // zeros included.
  describeNumberInput: function (win, full) {
    try {
      var digits = win._maxDigits || (win.maxItems && win.maxItems()) || 1;
      var i = win.index();
      if (i < 0 || i >= digits) i = 0;
      var s = String(win._number == null ? 0 : win._number);
      while (s.length < digits) s = '0' + s;
      var line = s.slice(i, i + 1) + ', digit ' + (i + 1) + ' of ' + digits;
      return full ? line + ', code ' + s.split('').join(' ') : line;
    } catch (e) {}
    return '';
  },

  //---------------------------------------------------------------------------
  // Name entry (Scene_Name). Two places in this game reach it: Mount Palumpu's ev76 names a party
  // member (actor 19, up to 12 characters) and the Citadel Chocobo Forest's ev15 names the black
  // chocobo (actor 29, up to 10). Both were silent.
  //
  // A reader cannot make the 90-cell grid usable on its own. It says the same thing for 'A' and
  // 'a' — which is exactly what separates two cells sitting ten apart on the same page — and a
  // bare '#', '~' or ' ' is either silence or a word that depends on the reader's punctuation
  // level, which the mod does not control. So case is stated and every symbol is named.
  //
  // Nothing here is keyed to LATIN1: the cell contents come from the window's own table(), and a
  // character with no entry is decomposed if it can be and passed through if it cannot.
  //---------------------------------------------------------------------------
  NAME_SYMBOLS: {
    ' ': 'space', '!': 'exclamation mark', '#': 'hash', '$': 'dollar sign', '%': 'percent',
    '&': 'ampersand', '(': 'open parenthesis', ')': 'close parenthesis', '*': 'asterisk',
    '+': 'plus', '-': 'hyphen', '/': 'slash', ':': 'colon', ';': 'semicolon', '<': 'less than',
    '=': 'equals', '>': 'greater than', '@': 'at sign', '[': 'open square bracket',
    ']': 'close square bracket', '^': 'caret', '_': 'underscore', '{': 'open brace',
    '}': 'close brace', '|': 'vertical bar', '~': 'tilde',
    '«': 'open guillemet', '»': 'close guillemet',
  },

  // The letters on the accented page that Unicode cannot take apart into base-plus-accent. They
  // are single indivisible characters, so each needs its own word.
  NAME_LETTERS: {
    'Æ': 'capital A E ligature', 'æ': 'A E ligature',
    'Ð': 'capital eth',          'ð': 'eth',
    'Ø': 'capital O slash',      'ø': 'O slash',
    'Þ': 'capital thorn',        'þ': 'thorn',
    'ß': 'sharp S',
    'Ĳ': 'capital I J ligature', 'ĳ': 'I J ligature',
    'Œ': 'capital O E ligature', 'œ': 'O E ligature',
  },

  // For the ones it CAN take apart. 'Á'.normalize('NFD') is 'A' followed by U+0301, so naming nine
  // combining marks covers the whole accented page instead of writing out forty letters by hand.
  NAME_ACCENTS: {
    '̀': 'grave', '́': 'acute', '̂': 'circumflex', '̃': 'tilde',
    '̄': 'macron', '̈': 'diaeresis', '̊': 'ring', '̌': 'caron',
    '̧': 'cedilla',
  },

  describeNameChar: function (ch) {
    try {
      if (ch == null || ch === '') return '';
      ch = String(ch);
      var sym = this.NAME_SYMBOLS[ch];
      if (sym) return sym;
      var letter = this.NAME_LETTERS[ch];
      if (letter) return letter;
      if (/^[0-9]$/.test(ch)) return ch;
      // Only the case of a letter is worth stating, and only for the half of the grid that has
      // both. "capital B" against "b" is the whole distinction the reader was losing.
      if (/^[A-Za-z]$/.test(ch)) return ch === ch.toUpperCase() ? 'capital ' + ch : ch;
      if (typeof ch.normalize === 'function') {
        var d = ch.normalize('NFD');
        if (d.length > 1) {
          var base = this.describeNameChar(d.charAt(0)), acc = this.NAME_ACCENTS[d.charAt(1)];
          if (base) return acc ? base + ' ' + acc : base;
        }
      }
      return ch;                       // an alphabet this table does not cover; let the reader try
    } catch (e) {}
    return '';
  },

  // The name spelled out. A reader hands "Boco" back as a word, which cannot be checked against
  // what was actually typed — a name is a position-sensitive value, the same reason
  // describeNumberInput spells a code out digit by digit, and it is joined the same way.
  spellName: function (name) {
    try {
      var s = String(name == null ? '' : name), out = [];
      for (var i = 0; i < s.length; i++) {
        var part = this.describeNameChar(s.charAt(i));
        if (part) out.push(part);
      }
      return out.join(' ');
    } catch (e) {}
    return '';
  },

  // The cell under the cursor. The two command cells are drawn as words on a grid of single
  // characters and say nothing about themselves, so each one is given what it does.
  describeNameInput: function (win) {
    try {
      if (win.isPageChange && win.isPageChange()) return 'Page, switch character set';
      if (win.isOk && win.isOk()) return 'OK, finish';
      return this.describeNameChar(win.character ? win.character() : '');
    } catch (e) {}
    return '';
  },

  // The name built so far, for the read-detail key: the word as typed, then spelled out, then how
  // much room is left. The cursor readout is deliberately terse because it repeats on every arrow
  // press, so the whole value lives here — exactly the split number entry uses.
  describeNameEdit: function (win) {
    try {
      var name = (win && win.name) ? win.name() : '';
      var max = (win && win._maxLength) || 0;
      if (!name) return 'Name is blank' + (max ? ', up to ' + max + ' characters' : '');
      return 'Name ' + name + ', ' + this.spellName(name) +
             (max ? ', ' + name.length + ' of ' + max + ' characters' : '');
    } catch (e) {}
    return '';
  },

  // Scene_Name's edit window, or null anywhere else. It is a Window_Base rather than a
  // Window_Selectable, so focusedWindow() never returns it — that finds the 90-cell grid, whose
  // whole readout is one character.
  nameEditWindow: function () {
    try {
      var s = SceneManager._scene;
      if (window.Scene_Name && s instanceof Scene_Name) return s._editWindow || null;
    } catch (e) {}
    return null;
  },

  // The game leaves an empty slot blank on screen (YEP_EquipCore's "Empty Text" is ""),
  // so speech has to supply the word.
  EMPTY_SLOT: 'empty',

  // "Vahn Lv 12 HP 340/340" — joinParts keeps the slash tight and adds no punctuation of ours.
  describeActorBrief: function (actor) {
    if (!actor) return '';
    try {
      return BMA.Util.joinParts([
        BMA.Util.cleanText(actor.name()),
        TextManager.levelA, actor.level,
        TextManager.hpA, actor.hp, '/', actor.mhp,
      ]);
    } catch (e) { return ''; }
  },

  // A row of the Marks list: either a category header or a mark.
  //
  // Every icon in this game's Galv_QuestLog config is 0, so a row draws nothing but its text —
  // which means tracking, the whole point of pressing OK here, has no visible marker. We say it
  // anyway; otherwise the action gives no feedback at all.
  describeMark: function (win) {
    try {
      var it = win.item();
      if (!it) return '';
      if (it.categoryTitle !== undefined) {
        var cat = Galv.QUEST.categories[it.categoryTitle];
        var text = BMA.Util.cleanText((cat && cat.name) || 'Marks') + ': ' + (it.count || 0);
        // Categories start expanded, so this stays quiet in the normal case and speaks up
        // exactly when the marks underneath are not browsable.
        var hidden = $gameSystem._quests.categoryHide[win._category];
        if (hidden && hidden[it.categoryTitle]) text += ', collapsed';
        return text;
      }
      var name = BMA.Util.cleanText(this._nameOf(it));
      if (it._id !== undefined && it._id === $gameSystem._quests.tracked) name += ', tracked';
      return name;
    } catch (e) { return ''; }
  },

  // Items usually carry `name` as a string, but some (Game_Quest) expose it as a method.
  // Without this, String(fn) would send the function's source code to the reader.
  _nameOf: function (it) {
    try {
      if (!it) return '';
      return typeof it.name === 'function' ? String(it.name()) : String(it.name || '');
    } catch (e) { return ''; }
  },

  // "Hans, 2 of 2" — who this page of a per-character screen belongs to. Position comes from
  // $gameParty.members(), the same list Q/W pages through.
  describeActorPage: function (actor) {
    if (!actor) return '';
    var name = '';
    try { name = BMA.Util.cleanText(actor.name()); } catch (e) {}
    try {
      var members = $gameParty.members();
      var i = members.indexOf(actor);
      if (i >= 0 && members.length > 1) return name + ', ' + (i + 1) + ' of ' + members.length;
    } catch (e) {}
    return name;
  },

  // The actor whose detail panel is showing on the party screen, or null elsewhere.
  partyScreenActor: function () {
    try {
      var scene = SceneManager._scene;
      if (!window.Scene_Party || !(scene instanceof Scene_Party)) return null;
      var win = this.focusedWindow();
      if (win && typeof win.curActor === 'function' && win.curActor()) return win.curActor();
      if (scene._detailWindow && scene._detailWindow._actor) return scene._detailWindow._actor;
    } catch (e) {}
    return null;
  },

  // "Weapon: Spear" / "Relic 2: empty". Slot names come from $dataSystem.equipTypes via the
  // window's own slotName(), so they match whatever the game calls them.
  describeEquipSlot: function (win) {
    var i = win.index();
    var slot = '';
    try { if (typeof win.slotName === 'function') slot = BMA.Util.cleanText(win.slotName(i)); }
    catch (e) {}
    slot = this.equipSlotLabel(win, i, slot);
    var value = this.EMPTY_SLOT;
    try {
      var it = win.item();
      if (it) value = BMA.Util.cleanText(it.name || '') || this.EMPTY_SLOT;
    } catch (e) {}
    return slot ? slot + ': ' + value : value;
  },

  // Every class in this game repeats at least one slot type — the <Equip Slot> notetags
  // give all 28 two Relic slots, Monk and Puppeteer three, Gambler two Card, Red Mage two
  // Orb. Two rows both reading "Relic: empty" are indistinguishable while browsing, so a
  // repeated type gets an occurrence number. Types that appear once are left alone.
  equipSlotLabel: function (win, index, slotName) {
    if (!slotName) return slotName;
    try {
      var slots = win._actor && win._actor.equipSlots ? win._actor.equipSlots() : null;
      if (!slots || index < 0 || index >= slots.length) return slotName;
      var type = slots[index], total = 0, ordinal = 0;
      for (var i = 0; i < slots.length; i++) {
        if (slots[i] !== type) continue;
        total++;
        if (i <= index) ordinal++;
      }
      return total > 1 ? slotName + ' ' + ordinal : slotName;
    } catch (e) { return slotName; }
  },

  describeItem: function (win, it) {
    var parts = [];
    parts.push(BMA.Util.cleanText(this._nameOf(it)));
    try {
      // Shop prices. Window_ShopBuy has price()/isEnabled(); Window_ShopSell — which IS a
      // Window_ItemList — has neither, so the sell figure never reached the reader at all.
      if (window.Window_ShopBuy && win instanceof Window_ShopBuy) {
        parts.push(BMA.Util.currency(win.price(it)));
        // isEnabled() is false for two different reasons, and "cannot afford" is wrong for the
        // second: a full stack of 99 potions is not a money problem.
        if (typeof win.isEnabled === 'function' && !win.isEnabled(it)) {
          parts.push($gameParty && $gameParty.hasMaxItems(it) ? 'cannot carry more'
                                                              : 'cannot afford');
        }
      } else if (window.Window_ShopSell && win instanceof Window_ShopSell) {
        var sp = BMA.Shop.sellPriceOf(it);
        parts.push(sp > 0 ? BMA.Util.currency(sp) : 'cannot sell');
      } else if (typeof win.price === 'function') {
        var pr = win.price(it);
        parts.push(BMA.Util.currency(pr));
        if ($gameParty && $gameParty.gold() < pr) parts.push('cannot afford');
      }
      // Owned quantity. Window_ShopBuy extends Window_Selectable, not Window_ItemList, so the
      // buy list never said how many you already had — the one list where that decides it.
      if ($gameParty &&
          (DataManager.isItem(it) || DataManager.isWeapon(it) || DataManager.isArmor(it)) &&
          ((window.Window_ItemList && win instanceof Window_ItemList) ||
           (window.Window_ShopBuy && win instanceof Window_ShopBuy))) {
        var n = $gameParty.numItems(it);
        if (n > 0) parts.push('have ' + n);
      }
      // Skill costs
      if (DataManager.isSkill && DataManager.isSkill(it)) {
        if (it.mpCost) parts.push(it.mpCost + ' MP');
        if (it.tpCost) parts.push(it.tpCost + ' TP');
      }
      // Equip slot context
      if (window.Window_EquipItem && win instanceof Window_EquipItem && it.params) {
        var atk = it.params[2], def = it.params[3];
        if (atk) parts.push('attack ' + atk);
        if (def) parts.push('defense ' + def);
      }
    } catch (e) {}
    return BMA.Util.joinParts(parts);
  },

  describeSavefile: function (win) {
    try {
      var id = win.index() + 1;
      var info = DataManager.loadSavefileInfo(id);
      if (!info) return 'File ' + id + ' empty';
      return BMA.Util.joinParts([
        'File ' + id,
        info.title || '',
        (info.characters && info.characters.length) ? info.characters.length + ' members' : '',
        info.playtime || '',
      ]);
    } catch (e) { return 'File ' + (win.index() + 1); }
  },

  // Read the paired help/detail/info panel's captured buffer.
  detailLines: function (win) {
    try {
      if (win._helpWindow && win._helpWindow._bmaLines && win._helpWindow._bmaLines.length)
        return win._helpWindow._bmaLines.slice();
      var paired = this._pairedInfoWindow(win);
      if (paired && paired._bmaLines && paired._bmaLines.length) return paired._bmaLines.slice();
      if (typeof win.item === 'function') {
        var it = win.item();
        if (it && it.description) return [it.description];
      }
    } catch (e) {}
    return [];
  },

  // Find an info/detail window on the current scene (quest info, status detail, etc.).
  _pairedInfoWindow: function (win) {
    try {
      var scene = SceneManager._scene;
      if (!scene) return null;
      var names = ['_questInfoWindow', '_infoWindow', '_statusWindow', '_detailWindow',
                   '_descriptionWindow', '_dataWindow'];
      for (var i = 0; i < names.length; i++) {
        var w = scene[names[i]];
        if (w && w !== win && w._bmaLines && w._bmaLines.length) return w;
      }
    } catch (e) {}
    return null;
  },

  readDetail: function (win, auto) {
    win = win || this.focusedWindow();
    if (!win) return;
    var lines = this.detailLines(win);
    if (lines.length) {
      BMA.Speech.speak(BMA.Util.joinParts(lines.map(function (s) { return BMA.Util.cleanText(s); })),
                       { priority: auto ? 'normal' : 'critical', category: 'menu' });
    } else if (!auto) {
      BMA.Speech.speak('No detail', { priority: 'critical', category: 'menu' });
    }
  },

  usableBy: function (win) {
    win = win || this.focusedWindow();
    var it = win && typeof win.item === 'function' ? win.item() : null;
    if (!it || !(DataManager.isWeapon(it) || DataManager.isArmor(it))) {
      BMA.Speech.speak('No equip info', { priority: 'critical', category: 'menu' });
      return;
    }
    try {
      var isW = DataManager.isWeapon(it);
      var typeId = isW ? it.wtypeId : it.atypeId;
      var traitCode = isW ? Game_BattlerBase.TRAIT_EQUIP_WTYPE : Game_BattlerBase.TRAIT_EQUIP_ATYPE;
      var names = [];
      $dataClasses.forEach(function (cls) {
        if (!cls) return;
        var can = cls.traits.some(function (t) { return t.code === traitCode && t.dataId === typeId; });
        if (can) names.push(cls.name);
      });
      var msg = names.length ? 'Usable by ' + names.join(', ') : 'No class can equip this';
      BMA.Speech.speak(msg, { priority: 'critical', category: 'menu' });
    } catch (e) {
      BMA.Speech.speak('No equip info', { priority: 'critical', category: 'menu' });
    }
  },

  focusedWindow: function () {
    try {
      var scene = SceneManager._scene;
      if (!scene || !scene._windowLayer) return null;
      var children = scene._windowLayer.children;
      for (var i = children.length - 1; i >= 0; i--) {
        var w = children[i];
        // isFocusable, not just `active`: a closed-but-active window (YEP's save confirm)
        // would otherwise steal read-detail and review mode.
        if (w instanceof Window_Selectable && this.isFocusable(w)) return w;
      }
    } catch (e) {}
    return null;
  },
};

//-----------------------------------------------------------------------------
// Status buffer — the status screen as a browsable list of stats, after
// ff1-screen-reader's StatusNavigationReader.
//
// Window_Status never sets an index (it has no maxItems), so the select/activate hooks above
// can never fire there and the screen was silent. Instead of scraping what it drew, read the
// actor directly and expose it as a BMA.Buffer: up/down one stat, shift for groups, ctrl for
// the ends. Entries are closures, so paging to another actor with Q/W re-reads live values.
//-----------------------------------------------------------------------------
BMA.Status = {
  active: false,
  buffer: null,
  actor: null,

  //--- parameter resolution -------------------------------------------------
  // ICFSoft_StatusMenu makes the status columns data-driven: statusMenuCols() returns arrays
  // of parameter keys ("atk", "hit", ...) per actor. Resolving those keys the same way the
  // plugin's drawParameters does means the buffer mirrors exactly what is on screen, including
  // any per-class <Status-Menu-Col-N> override. Everything degrades to the base params if the
  // plugin is absent.
  _icf: function () {
    try { return (typeof ICF !== 'undefined' && ICF.Param) ? ICF.Param : null; } catch (e) { return null; }
  },

  _pct: function (v) { return (Number(v) * 100).toFixed(2) + '%'; },

  // Returns {label, value} for one column key, or null if the key is unknown.
  _param: function (actor, key) {
    var P = this._icf();
    try {
      if (P) {
        var i;
        if (P.NParams && (i = P.NParams.indexOf(key)) > -1)
          return { label: P.NParamsFullName[i], value: actor.NParam(i) };
        if (P.PParams && (i = P.PParams.indexOf(key)) > -1) {
          var pv = actor.PParam(i);
          var isPct = P.PercentageParams && P.PercentageParams.indexOf(key) > -1;
          return { label: P.PParamsFullName[i], value: isPct ? this._pct(pv) : Math.trunc(pv) };
        }
        if (P.BParams && (i = P.BParams.indexOf(key)) > -1)
          return { label: TextManager.param(i), value: actor.param(i) };
        if (P.XParams && (i = P.XParams.indexOf(key)) > -1)
          return { label: P.XParamsFullName[i], value: this._pct(actor.xparam(i)) };
        if (P.SParams && (i = P.SParams.indexOf(key)) > -1)
          return { label: P.SParamsFullName[i], value: this._pct(actor.sparam(i)) };
        var m;
        if ((m = key.match(/^eval(\d+)$/i)) && P.EvalParams && P.EvalParams[m[1]])
          return { label: P.EvalParams[m[1]][0], value: eval(P.EvalParams[m[1]][1]) };
        if ((m = key.match(/^percentage(\d+)$/i)) && P.EvalPercentParams && P.EvalPercentParams[m[1]])
          return { label: P.EvalPercentParams[m[1]][0], value: this._pct(eval(P.EvalPercentParams[m[1]][1])) };
        return null;
      }
      // No ICFSoft: fall back to the eight base parameters by their engine key.
      var base = ['mhp', 'mmp', 'atk', 'def', 'mat', 'mdf', 'agi', 'luk'];
      var bi = base.indexOf(key);
      if (bi > -1) return { label: TextManager.param(bi), value: actor.param(bi) };
    } catch (e) {}
    return null;
  },

  // The column key lists the game will actually draw for this actor.
  _columns: function (actor) {
    try {
      if (typeof actor.statusMenuCols === 'function') {
        var st = actor.statusMenuCols();
        return [st[1] || [], st[2] || [], st[3] || []];
      }
    } catch (e) {}
    return [['atk', 'def', 'mat', 'mdf', 'agi', 'luk'], [], []];
  },

  //--- buffer construction --------------------------------------------------
  build: function (actor) {
    var self = this;
    var entries = [], starts = [], names = [];

    function group(name) { starts.push(entries.length); names.push(name); }
    function add(label, fn) {
      entries.push(function () {
        var v;
        try { v = fn(); } catch (e) { v = null; }
        if (v === null || v === undefined || v === '') v = 'none';
        return label ? label + ': ' + v : String(v);
      });
    }

    group('Character');
    add('Name', function () { return actor.name(); });
    add('Class', function () { return actor.currentClass() ? actor.currentClass().name : null; });
    if (actor.nickname && actor.nickname()) add('Title', function () { return actor.nickname(); });
    add('Level', function () { return actor.level; });
    // The EXP headings are format strings in the database ("%1 Total"); fall back to plain
    // words rather than letting a label computation kill the whole buffer.
    function term(tpl, arg, fallback) {
      try { return tpl.format(arg); } catch (e) { return fallback; }
    }
    add(term(TextManager.expTotal, TextManager.exp, 'EXP'),
        function () { return actor.isMaxLevel() ? 'maximum' : actor.currentExp(); });
    add(term(TextManager.expNext, TextManager.level, 'To next level'),
        function () { return actor.isMaxLevel() ? 'maximum' : actor.nextRequiredExp(); });
    add('States', function () {
      var s = actor.states().map(function (st) { return BMA.Util.cleanText(st.name); }).filter(Boolean);
      return s.length ? s.join(', ') : 'none';
    });

    group('Vitals');
    add(TextManager.hp, function () { return actor.hp + '/' + actor.mhp; });
    add(TextManager.mp, function () { return actor.mp + '/' + actor.mmp; });
    try {
      if ($dataSystem.optDisplayTp) add(TextManager.tp, function () { return actor.tp + '/' + actor.maxTp(); });
    } catch (e) {}

    var cols = this._columns(actor);
    function addColumn(label, keys) {
      if (!keys || !keys.length) return;
      var any = false;
      for (var i = 0; i < keys.length; i++) {
        var probe = self._param(actor, keys[i]);
        if (!probe || !probe.label) continue;
        if (!any) { group(label); any = true; }
        (function (key, lbl) {
          add(lbl, function () { var p = self._param(actor, key); return p ? p.value : null; });
        })(keys[i], probe.label);
      }
    }
    addColumn('Parameters', cols[0]);
    addColumn('Extra', cols[1].concat(cols[2]));

    // Equipped items only. drawEquipments() calls drawItemName(equips[i]), which draws nothing
    // for a null slot, so the screen shows just what you are wearing — no labels, no blanks.
    // (It does cap at maxEquipmentLines() = 6 while every class here has 7+ slots; a seventh
    // equipped item is silently not drawn. We still list it — that is a layout limit, not
    // information worth withholding.)
    var slots = [], equipped = [];
    try {
      slots = actor.equipSlots() || [];
      var eq = actor.equips() || [];
      for (var s = 0; s < slots.length; s++) if (eq[s]) equipped.push(s);
    } catch (e) {}
    if (equipped.length) {
      group('Equipment');
      for (var k = 0; k < equipped.length; k++) {
        (function (i) {
          var label = self._slotLabel(actor, slots, i);
          add(label, function () {
            var item = actor.equips()[i];
            return item ? BMA.Util.cleanText(item.name) : null;
          });
        })(equipped[k]);
      }
    }

    var profile = '';
    try { profile = BMA.Util.cleanText(actor.profile() || ''); } catch (e) {}
    if (profile) {
      group('Profile');
      add('', function () { return profile; });
    }

    return new BMA.Buffer(entries, starts, names);
  },

  // Same numbering rule as the equip screen: repeated slot types get an occurrence number, so
  // an actor's two Relic slots are tellable apart.
  _slotLabel: function (actor, slots, index) {
    var base = '';
    try { base = BMA.Util.cleanText($dataSystem.equipTypes[slots[index]] || ''); } catch (e) {}
    if (!base) return 'Slot ' + (index + 1);
    var total = 0, ordinal = 0;
    for (var i = 0; i < slots.length; i++) {
      if (slots[i] !== slots[index]) continue;
      total++;
      if (i <= index) ordinal++;
    }
    return total > 1 ? base + ' ' + ordinal : base;
  },

  //--- overlay --------------------------------------------------------------
  open: function (actor, silent) {
    if (!actor) return false;
    var keep = (this.actor === actor && this.buffer) ? this.buffer.index : 0;
    this.actor = actor;
    this.buffer = this.build(actor);
    this.buffer.index = Math.min(keep, Math.max(0, this.buffer.count() - 1));
    this.active = true;
    if (!silent) this.speak(this.buffer.current());
    return true;
  },

  close: function () { this.active = false; this.buffer = null; this.actor = null; },

  // Rebuild for a different actor, holding the cursor where it was.
  retarget: function (actor) {
    if (!this.active || !actor) return;
    var keep = this.buffer ? this.buffer.index : 0;
    this.actor = actor;
    this.buffer = this.build(actor);
    this.buffer.index = Math.min(keep, Math.max(0, this.buffer.count() - 1));
  },

  speak: function (text) {
    if (!text) return;
    var pos = this.buffer.groupPosition();
    var suffix = pos.count > 1 ? ', ' + (pos.index + 1) + ' of ' + pos.count : '';
    BMA.Speech.speak(text + suffix, { priority: 'critical', category: 'menu' });
  },

  readCurrent: function () { if (this.active && this.buffer) this.speak(this.buffer.current()); },

  // Returns true only for keys it consumes.
  handleKey: function (e) {
    if (!this.active || !this.buffer) return false;
    var k = e.key;
    if (k !== 'ArrowUp' && k !== 'ArrowDown') return false;
    var up = (k === 'ArrowUp');
    var text;
    if (e.ctrlKey) text = up ? this.buffer.top() : this.buffer.bottom();
    else if (e.shiftKey) text = up ? this.buffer.prevGroup() : this.buffer.nextGroup();
    else text = up ? this.buffer.prev() : this.buffer.next();
    this.speak(text);
    return true;
  },
};

//-----------------------------------------------------------------------------
// Virtual review buffer (browse mode)
//-----------------------------------------------------------------------------
BMA.Review = {
  active: false,
  lines: [],
  li: 0, wi: 0,

  enter: function () {
    // The shop's quantity prompt is never "focused" (no index), so ask BMA.Shop for it.
    var win = BMA.Menus.focusedWindow() || (BMA.Shop && BMA.Shop.numberWindow());
    var lines = [];
    if (win) {
      var d = BMA.Menus.detailLines(win);
      lines = (d && d.length) ? d : (win._bmaLines || []);
    }
    if (!win) {
      // fall back to any captured panel on the scene
      var p = BMA.Menus._pairedInfoWindow({});
      if (p) lines = p._bmaLines;
    }
    lines = (lines || []).map(function (s) { return BMA.Util.cleanText(s); }).filter(Boolean);
    if (!lines.length) { BMA.Speech.speak('Nothing to review', { priority: 'critical' }); return; }
    this.active = true; this.lines = lines; this.li = 0; this.wi = 0;
    BMA.Speech.speak('Review mode, ' + lines.length + (lines.length === 1 ? ' line. ' : ' lines. ') + lines[0],
                     { priority: 'critical' });
  },

  exit: function () {
    if (!this.active) return;
    this.active = false;
    BMA.Speech.speak('Exit review', { priority: 'critical' });
  },

  _line: function () { return this.lines[this.li] || ''; },
  _words: function () { return this._line().split(/\s+/).filter(Boolean); },

  // Returns true if the key was consumed.
  handleKey: function (e) {
    if (!this.active) return false;
    var k = e.key;
    if (k === 'Escape' || k === 'Backspace') { this.exit(); return true; }
    if (k === 'ArrowDown') { this.li = Math.min(this.lines.length - 1, this.li + 1); this.wi = 0; BMA.Speech.speak(this._line(), { priority: 'critical' }); return true; }
    if (k === 'ArrowUp')   { this.li = Math.max(0, this.li - 1); this.wi = 0; BMA.Speech.speak(this._line(), { priority: 'critical' }); return true; }
    if (k === 'ArrowRight'){ var w = this._words(); this.wi = Math.min(w.length - 1, this.wi + 1); BMA.Speech.speak(w[this.wi] || '', { priority: 'critical' }); return true; }
    if (k === 'ArrowLeft') { var w2 = this._words(); this.wi = Math.max(0, this.wi - 1); BMA.Speech.speak(w2[this.wi] || '', { priority: 'critical' }); return true; }
    if (k === 'Home')      { this.li = 0; this.wi = 0; BMA.Speech.speak(this._line(), { priority: 'critical' }); return true; }
    if (k === 'End')       { this.li = this.lines.length - 1; this.wi = 0; BMA.Speech.speak(this._line(), { priority: 'critical' }); return true; }
    return false;
  },
};

//-----------------------------------------------------------------------------
// Mod menu (F8) — a self-contained spoken overlay: up/down move, left/right
// adjust, Escape closes. No Scene needed, so it works from field or menus.
//-----------------------------------------------------------------------------
BMA.ModMenu = {
  active: false,
  i: 0,
  items: null,

  _build: function () {
    var C = BMA.Config;
    function toggle(name, key) {
      return { label: name, get: function () { return C[key] ? 'on' : 'off'; },
               adjust: function () { C[key] = !C[key]; return C[key] ? 'on' : 'off'; } };
    }
    function vol(name, key) {
      return { label: name + ' volume',
               get: function () { return Math.round(C.vol[key] * 100) + ' percent'; },
               adjust: function (dir) {
                 C.vol[key] = Math.max(0, Math.min(2, Math.round((C.vol[key] + dir * 0.1) * 100) / 100));
                 // A sustaining wall tone took its gain when it started, so turning the slider
                 // did nothing until you walked away from the wall and back.
                 if (key === 'wallTone') BMA.Audio.refreshWallGain();
                 return Math.round(C.vol[key] * 100) + ' percent';
               } };
    }
    // A menu row that does something instead of holding a value. adjust() returns what to say.
    function action(name, fn) {
      return { label: name, get: function () { return 'press enter'; },
               adjust: function () { return fn(); } };
    }
    function cycle(name, key, order, labels) {
      function show(v) { return (labels && labels[v]) ? labels[v] : v; }
      return { label: name, get: function () { return show(C[key]); },
               adjust: function (dir) {
                 var i = (order.indexOf(C[key]) + (dir || 1) + order.length) % order.length;
                 C[key] = order[i]; return show(C[key]);
               } };
    }
    this.items = [
      toggle('Speech', 'speechEnabled'),
      cycle('Verbosity', 'verbosity', ['terse', 'normal', 'verbose']),
      // classic = j/l/k/p, bracket = [ ] p \, left-handed = a/d/s/f. Only one set responds;
      // left-handed is the fresh-install default.
      cycle('Nav keyset', 'navKeyset', ['classic', 'bracket', 'lefthand'],
            { lefthand: 'left-handed' }),
      toggle('Menu item numbers', 'menuIndex'),
      toggle('Announce map on entry', 'announceMapEntry'),
      toggle('Footsteps', 'footsteps'),
      toggle('Wall tones', 'wallTones'),
      toggle('Continuous wall tones', 'wallTonesContinuous'),
      toggle('Beacon', 'beacon'),
      toggle('Airship landing cue', 'airshipLanding'),
      toggle('Path filter', 'pathFilter'),
      toggle('Autodetail', 'autodetail'),
      vol('Footstep', 'footstep'),
      vol('Wall tone', 'wallTone'),
      vol('Wall bump', 'wallBump'),
      vol('Beacon', 'beacon'),
      toggle('Perf logging', 'perfLog'),
      toggle('Speech log', 'speechLog'),
      // Writes what the pathfinder can see from where you are standing to bma_log.txt. "Nothing
      // else here" and "everything is unreachable" sound identical from outside; this tells them
      // apart in one press.
      action('Navigation diagnostics', function () {
        try { return BMA.Nav.logDiagnostics(); } catch (e) { return 'failed'; }
      }),
    ];
  },

  open: function () {
    if (this.active) { this.close(); return; }
    this._build();
    this.active = true; this.i = 0;
    BMA.Speech.speak('Mod menu. ' + this._say(), { priority: 'critical' });
  },

  close: function () {
    if (!this.active) return;
    this.active = false;
    try { if (window.ConfigManager) ConfigManager.save(); } catch (e) {}
    BMA.Speech.speak('Closed mod menu', { priority: 'critical' });
  },

  _say: function () {
    var it = this.items[this.i];
    return it.label + ', ' + it.get() + ', ' + (this.i + 1) + ' of ' + this.items.length;
  },

  handleKey: function (e) {
    if (!this.active) return false;
    var k = e.key;
    if (k === 'Escape' || k === 'F8') { this.close(); return true; }
    if (k === 'ArrowDown') { this.i = (this.i + 1) % this.items.length; BMA.Speech.speak(this._say(), { priority: 'critical' }); return true; }
    if (k === 'ArrowUp')   { this.i = (this.i - 1 + this.items.length) % this.items.length; BMA.Speech.speak(this._say(), { priority: 'critical' }); return true; }
    if (k === 'ArrowRight'){ var v = this.items[this.i].adjust(1); BMA.Speech.speak(this.items[this.i].label + ', ' + v, { priority: 'critical' }); return true; }
    if (k === 'ArrowLeft') { var v2 = this.items[this.i].adjust(-1); BMA.Speech.speak(this.items[this.i].label + ', ' + v2, { priority: 'critical' }); return true; }
    if (k === 'Enter' || k === ' ') { var v3 = this.items[this.i].adjust(1); BMA.Speech.speak(this.items[this.i].label + ', ' + v3, { priority: 'critical' }); return true; }
    return false;
  },
};

//-----------------------------------------------------------------------------
// Scene wiring for the status buffer and actor paging
//-----------------------------------------------------------------------------
if (window.Scene_Status) {
  var _statusStart = Scene_Status.prototype.start;
  Scene_Status.prototype.start = function () {
    _statusStart.call(this);
    try {
      var actor = this.actor();
      if (actor && BMA.Status.open(actor, true)) {
        BMA.Speech.speak(BMA.Menus.describeActorPage(actor) + ', status',
                         { priority: 'critical', category: 'menu' });
        BMA.Speech.queueNext();          // the first stat follows, it does not replace this
        BMA.defer(function () { BMA.Status.readCurrent(); });
      }
    } catch (e) {}
  };
  var _statusTerminate = Scene_Status.prototype.terminate;
  Scene_Status.prototype.terminate = function () {
    try { BMA.Status.close(); } catch (e) {}
    _statusTerminate.call(this);
  };
}

// Q / W page between party members on the status, equip and skill screens. Each of those
// scenes REPLACES onActorChange without calling super, so alias nextActor/previousActor on
// Scene_MenuBase instead — those are not overridden anywhere and both end by calling it.
if (window.Scene_MenuBase) {
  ['nextActor', 'previousActor'].forEach(function (m) {
    var _orig = Scene_MenuBase.prototype[m];
    if (!_orig) return;
    Scene_MenuBase.prototype[m] = function () {
      _orig.call(this);
      try {
        var actor = this.actor();
        if (!actor) return;
        // Just who you are now looking at. The level and HP are entries in the status buffer
        // the player is standing in, so repeating them here is noise.
        var label = BMA.Menus.describeActorPage(actor);
        BMA.Speech.speak(label, { priority: 'critical', category: 'menu' });
        // Whatever the scene focuses next — the status buffer's current stat, or the equip
        // screen's command window, whose activate() already queued a deferred announcement —
        // must follow the name instead of cutting it off.
        BMA.Speech.queueNext();
        if (BMA.Status.active) {
          BMA.Status.retarget(actor);
          BMA.defer(function () { BMA.Status.readCurrent(); });
        }
      } catch (e) {}
    };
  });
}

// Save/Load: speak the initially-focused slot on entry. YEP Save Core / AltSaveScreen select the
// savefile list's slot in create() but never call activate() on it — the list is active-by-default,
// so our generic activate-hook announce never fires on entry (it only fires on back-out from the
// action window, via onActionCancel -> _listWindow.activate(), which already reads fine). So read
// the focused slot directly here, reusing describeSavefile so entry reads identically to cursor
// movement. Deferred one frame: a synchronous read at start time gets clobbered by leftover
// transition speech from the outgoing scene, and the list settles a frame after start. Scene_Save
// and Scene_Load both extend Scene_File (neither overrides start), so this one hook covers both.
if (window.Scene_File) {
  var _sceneFileStart = Scene_File.prototype.start;
  Scene_File.prototype.start = function () {
    _sceneFileStart.call(this);
    var scene = this;
    setTimeout(function () {
      try {
        if (SceneManager._scene !== scene) return;          // left the scene during the delay
        var win = scene._listWindow;
        if (!win || typeof win.index !== 'function' || win.index() < 0) return;
        var text = BMA.Menus.describeSavefile(win);
        if (!text) return;
        var pos = '';
        if (BMA.Config.menuIndex && win.maxItems && win.maxItems() > 0)
          pos = ' ' + (win.index() + 1) + ' of ' + win.maxItems();
        BMA.Speech.speak(text + pos, { priority: 'critical', category: 'menu' });
      } catch (e) {}
    }, 50);
  };
}

//-----------------------------------------------------------------------------
// Shops — the command row and the quantity prompt.
//
// Two shop windows fall outside the generic select/activate hooks:
//
//  * Window_ShopCommand announces itself from Window_Command's constructor, but
//    createCategoryWindow runs next and BM_ShopCore's Window_Item2Category is another
//    Window_Command — so ITS constructor's activate() overwrites announceCurrent's single
//    _pending slot, and the very next two lines hide() and deactivate() it. The deferred run
//    then finds an unfocusable window and drops the announce, so opening a shop said nothing.
//    Same failure class as YEP's Window_SaveConfirm. MrTS_NoItemCategories replays the race on
//    every Sell: commandSell runs the stock body (category show()+activate()) and only then
//    deactivates it in favour of the sell list.
//
//  * Window_ShopNumber has no maxItems() — it inherits 0 — so isCursorMovable() is always
//    false, select() is never called, and its index stays -1. The hooks, isFocusable and
//    focusedWindow can none of them see it, which is why the quantity was silent.
//
// The command row is fixed with a focus watchdog rather than another Scene_File-style entry
// hook: an entry hook only covers arriving at the scene, and the row was reported silent while
// arrowing too. Comparing against what was last *spoken* means the watchdog stays quiet
// whenever the generic hooks already did the job (the buy and sell lists), and fills the gap
// when an announce is dropped — whichever step dropped it. Scoped to Scene_Shop so no other
// scene's arbitration changes.
//-----------------------------------------------------------------------------
BMA.Shop = {
  // Input.keyRepeatInterval is 6 frames, so a held arrow calls changeNumber ~10x a second.
  // Every announce is 'critical' and therefore interrupts, so unthrottled the reader is handed
  // cancel+speak every 100 ms and never finishes saying a number.
  THROTTLE: 140,
  _win: null, _fixed: null, _bound: 0, _lastAt: 0, _timer: null, _armed: false,

  _now: function () { return Date.now(); },     // seam so the harness can drive the throttle

  scene: function () {
    try {
      var s = SceneManager._scene;
      return (window.Scene_Shop && s instanceof Scene_Shop) ? s : null;
    } catch (e) { return null; }
  },

  // The quantity prompt, when it is what the player is on. isFocusable/focusedWindow cannot
  // answer this — the window never gets an index — so read-detail and review ask here instead.
  numberWindow: function () {
    var s = this.scene(), w = s && s._numberWindow;
    return (w && w.active && w.visible) ? w : null;
  },

  verb: function () {
    try {
      var s = this.scene(), sym = s && s._commandWindow && s._commandWindow.currentSymbol();
      if (sym === 'buy') return 'Buy';
      if (sym === 'sell') return 'Sell';
    } catch (e) {}
    return '';
  },

  // sellingPrice() lives on the scene and reads scene._item, so borrow it rather than
  // reimplementing price / 2 — a shop plugin that changes the rate then still wins. Safe to
  // borrow: describeItem runs from a deferred announce, and _item is read only by the scene's
  // synchronous handlers.
  sellPriceOf: function (item) {
    if (!item) return 0;
    var s = this.scene();
    if (s && typeof s.sellingPrice === 'function') {
      var saved = s._item;
      try { s._item = item; return s.sellingPrice(); }
      catch (e) {}
      finally { s._item = saved; }
    }
    try { return Math.floor((item.price || 0) / 2); } catch (e) { return 0; }
  },

  // From _price * _number, never scraped from what was drawn: maxDigits() is 2, so the drawn
  // field truncates once the quantity passes 99.
  total: function (win) { return (win._price || 0) * (win._number || 0); },

  entryLine: function (win) {
    var v = this.verb(), n = BMA.Util.cleanText(BMA.Menus._nameOf(win._item));
    return [v ? v + ' ' + n : n,
            'quantity ' + win._number + ' of ' + win._max,
            'total ' + BMA.Util.currency(this.total(win))].join(', ');
  },

  // Terse, because a held key repeats this several times a second: the value, and what it now
  // costs — the one number the player cannot work out while scrubbing.
  changeLine: function (win) {
    return win._number + ', ' + BMA.Util.currency(this.total(win));
  },

  // The read-detail (i) readout. The prompt is where the unit price, what you already own and
  // the gil you are left with all matter at once, and BM_ShopCore hides the gold window, so
  // nothing on screen carries the balance. The key hint lives only here: left/right = 1 while
  // up/down = 10 is unusual enough to state once and far too long to hear on every keypress.
  detailLine: function (win) {
    var parts = [this.entryLine(win), BMA.Util.currency(win._price) + ' each'];
    try { parts.push('have ' + $gameParty.numItems(win._item)); } catch (e) {}
    try {
      var sign = (this.verb() === 'Sell') ? 1 : -1;
      parts.push(BMA.Util.currency($gameParty.gold() + sign * this.total(win)) + ' after');
    } catch (e) {}
    parts.push('left and right change by 1, up and down by 10');
    return parts.join(', ');
  },

  // setup() runs before show()/activate() in onBuyOk, so defer past the frame and re-check that
  // the prompt really came up.
  onOpen: function (win) {
    this._cancel();
    this._bound = 0;
    var self = this;
    BMA.defer(function () {
      if (self.numberWindow() !== win) return;
      self._lastAt = self._now();
      BMA.Speech.speak(self.entryLine(win), { priority: 'critical', category: 'menu' });
    });
  },

  // `before` is the value on entry. Unchanged means we are pinned at an end — which the engine
  // signals with nothing at all: no cursor SE, no redraw. Latched, so holding a key against the
  // ceiling says it once instead of several times a second.
  onChange: function (win, before, amount) {
    if (win._number === before) {
      var end = amount > 0 ? 1 : -1;
      if (this._bound === end) return;
      this._bound = end;
      this._say(win, end > 0 ? 'Maximum ' + win._max : 'Minimum 1');
      return;
    }
    this._bound = 0;
    this._say(win, null);
  },

  // Trailing-edge throttle: at most one line per THROTTLE ms, and always the value the player
  // actually landed on. BMA.defer alone only coalesces within a frame.
  _say: function (win, fixed) {
    this._win = win; this._fixed = fixed;
    var self = this, wait = this.THROTTLE - (this._now() - this._lastAt);
    if (wait > 0) {
      if (!this._timer)
        this._timer = setTimeout(function () { self._timer = null; self._flush(); }, wait);
      return;
    }
    BMA.defer(function () { self._flush(); });
  },

  _flush: function () {
    var win = this._win, fixed = this._fixed;
    this._win = null; this._fixed = null;
    if (!win || this.numberWindow() !== win) return;
    this._lastAt = this._now();
    BMA.Speech.speak(fixed || this.changeLine(win), { priority: 'critical', category: 'menu' });
  },

  _cancel: function () {
    if (this._timer) { clearTimeout(this._timer); this._timer = null; }
    this._win = null; this._fixed = null;
  },

  // endNumberInput reactivates the buy/sell list a moment later and its announce would cut this
  // off, so queue it to follow instead — the same one-shot the actor-paging heading uses.
  // Gold has already moved by the time doBuy/doSell return, so gold() is the new balance.
  confirm: function (scene, number, sold) {
    try {
      var each = sold ? scene.sellingPrice() : scene.buyingPrice();
      var name = BMA.Util.cleanText(BMA.Menus._nameOf(scene._item));
      BMA.Speech.speak(
        (sold ? 'Sold ' : 'Bought ') + number + ' ' + name + ', ' +
        BMA.Util.currency(number * each) + (sold ? ' received, ' : ' spent, ') +
        BMA.Util.currency($gameParty.gold()) + ' left',
        { priority: 'critical', category: 'menu' });
      BMA.Speech.queueNext();
    } catch (e) {}
  },

  // Announce whoever actually holds focus, if that is not who was last read out.
  watch: function () {
    if (!this._armed) return;
    var win = BMA.Menus.focusedWindow();
    if (!win) return;
    var idx = -1;
    try { idx = win.index(); } catch (e) {}
    if (win === BMA.Menus._lastWin && idx === BMA.Menus._lastIndex) return;
    // Claim it before speaking, not after: _speakCurrent bails without recording anything when
    // resolveText comes back empty, and an unreadable window would then be retried every frame.
    BMA.Menus.noteSpoken(win);
    BMA.Menus._speakCurrent(win, false);
  },
};

if (window.Scene_Shop && window.Window_ShopNumber) {
  // 50 ms before the watchdog arms, as on Scene_File: a read at scene-start time is clobbered by
  // leftover transition speech from the outgoing map scene, and it lets the stale category-window
  // defer drain first. _lastWin is deliberately NOT cleared here — if the generic hooks did
  // manage to announce the command row, they own it and the watchdog stays quiet.
  var _shopStart = Scene_Shop.prototype.start;
  Scene_Shop.prototype.start = function () {
    _shopStart.call(this);
    var scene = this;
    BMA.Shop._armed = false;
    setTimeout(function () {
      if (SceneManager._scene === scene) BMA.Shop._armed = true;
    }, 50);
  };

  var _shopUpdate = Scene_Shop.prototype.update;
  Scene_Shop.prototype.update = function () {
    _shopUpdate.call(this);
    try { BMA.Shop.watch(); } catch (e) {}
  };

  var _shopTerminate = Scene_Shop.prototype.terminate;
  Scene_Shop.prototype.terminate = function () {
    try { BMA.Shop._armed = false; BMA.Shop._cancel(); } catch (e) {}
    _shopTerminate.call(this);
  };

  var _numSetup = Window_ShopNumber.prototype.setup;
  Window_ShopNumber.prototype.setup = function () {
    _numSetup.apply(this, arguments);
    try { BMA.Shop.onOpen(this); } catch (e) {}
  };

  // The single choke point for the arrow keys AND the touch buttons. Overriding maxItems() to
  // give the window an index instead would switch on processCursorMove, whose cursorDown()
  // evaluates -1 < maxItems - maxCols and calls select(0) — so the -10 key would also announce
  // the window as a menu row, fighting this announce.
  var _numChange = Window_ShopNumber.prototype.changeNumber;
  Window_ShopNumber.prototype.changeNumber = function (amount) {
    var before = this._number;
    _numChange.apply(this, arguments);
    try { BMA.Shop.onChange(this, before, amount); } catch (e) {}
  };

  var _doBuy = Scene_Shop.prototype.doBuy;
  Scene_Shop.prototype.doBuy = function (number) {
    _doBuy.call(this, number);
    try { BMA.Shop.confirm(this, number, false); } catch (e) {}
  };

  var _doSell = Scene_Shop.prototype.doSell;
  Scene_Shop.prototype.doSell = function (number) {
    _doSell.call(this, number);
    try { BMA.Shop.confirm(this, number, true); } catch (e) {}
  };
}

// Up and down change the digit under the cursor without moving it, so select() is never called
// and the generic announce hook cannot fire — the same blind spot as the shop's quantity keys.
// changeDigit is the one choke point for the arrow keys and the touch buttons alike.
// Left and right do move the cursor, so those come through select() and need nothing here.
if (window.Window_NumberInput) {
  var _changeDigit = Window_NumberInput.prototype.changeDigit;
  Window_NumberInput.prototype.changeDigit = function (up) {
    _changeDigit.call(this, up);
    try {
      // 'critical' so a held key interrupts rather than queueing ten digits behind each other.
      BMA.Speech.speak(BMA.Menus.describeNumberInput(this),
                       { priority: 'critical', category: 'menu' });
      BMA.Menus.noteSpoken(this);
    } catch (e) {}
  };
}

//-----------------------------------------------------------------------------
// Name entry — the 90-cell grid, and the name being built above it.
//
// Window_NameInput REPLACES cursorDown/Up/Left/Right rather than extending them, and none of its
// versions calls select() — they assign this._index straight. So the generic select() hook, which
// every other list in the game announces through, never fires here: the player could walk the
// whole grid in silence. updateCursor is the one call the engine makes after every move (its own
// processCursorMove ends with it), and shift-jump and the page keys land there a frame later, so
// it catches all four ways the cursor can move for the price of one alias.
//
// It runs every frame regardless of whether anything changed, hence the remembered index and page.
// Announcing through announceCurrent rather than speaking here keeps the one-per-frame coalescing
// and the isFocusable gate that the rest of the menu layer relies on.
if (window.Window_NameInput) {
  var _nameUpdateCursor = Window_NameInput.prototype.updateCursor;
  Window_NameInput.prototype.updateCursor = function () {
    _nameUpdateCursor.call(this);
    try {
      if (this._bmaIndex === this._index && this._bmaPage === this._page) return;
      var flipped = this._bmaPage !== undefined && this._bmaPage !== this._page;
      this._bmaIndex = this._index;
      this._bmaPage = this._page;
      // Which alphabet is showing changes what all 90 cells mean, so it is said once, in front of
      // whichever cell the cursor kept. Page numbers come from the window's own table().
      if (flipped) {
        var pages = 1;
        try { pages = this.table().length; } catch (e) {}
        BMA.Speech.speak('Page ' + (this._page + 1) + ' of ' + pages,
                         { priority: 'critical', category: 'menu' });
        BMA.Speech.queueNext();
      }
      BMA.Menus.announceCurrent(this);
    } catch (e) {}
  };
}

// The name itself. Adding and deleting are the only things on this screen that change it, and
// neither draws anything the capture layer can pick up — the edit window redraws the whole name as
// one row, so there is no "what just happened" in it. Both report the character, which is also the
// only way to tell an accepted keypress from a refused one: the game answers a full name with a
// buzzer and nothing else.
if (window.Window_NameEdit) {
  var _nameAdd = Window_NameEdit.prototype.add;
  Window_NameEdit.prototype.add = function (ch) {
    var ok = _nameAdd.call(this, ch);
    try {
      BMA.Speech.speak(ok ? BMA.Menus.describeNameChar(ch)
                          : 'Name full, ' + (this._maxLength || 0) + ' characters',
                       { priority: 'critical', category: 'menu' });
    } catch (e) {}
    return ok;
  };

  var _nameBack = Window_NameEdit.prototype.back;
  Window_NameEdit.prototype.back = function () {
    var before = this._name;
    var ok = _nameBack.call(this);
    try {
      // Read what actually went, rather than assuming it was one character off the end — back()
      // slices to its own index, and this way the readout cannot disagree with the window.
      var gone = ok ? String(before).slice(String(this._name).length) : '';
      BMA.Speech.speak(ok ? (BMA.Menus.describeNameChar(gone) || 'character') + ' deleted'
                          : 'Name is blank',
                       { priority: 'critical', category: 'menu' });
    } catch (e) {}
    return ok;
  };

  // Confirming an empty name puts the original back instead of finishing, which looks from the
  // outside exactly like OK not working. Say what came back.
  var _nameRestore = Window_NameEdit.prototype.restoreDefault;
  Window_NameEdit.prototype.restoreDefault = function () {
    var ok = _nameRestore.call(this);
    try {
      BMA.Speech.speak(ok ? 'Name cannot be empty, restored ' + this.name()
                          : 'Name cannot be empty',
                       { priority: 'critical', category: 'menu' });
    } catch (e) {}
    return ok;
  };
}

// On entry the grid's own activate() already queues the focused cell, but "capital A" on its own
// says nothing about where the player is or what is being named. Speak the context first and let
// that deferred cell read follow it — queueNext, because the cell announce is 'critical' and would
// otherwise cut this off mid-sentence.
if (window.Scene_Name) {
  var _sceneNameStart = Scene_Name.prototype.start;
  Scene_Name.prototype.start = function () {
    _sceneNameStart.call(this);
    try {
      var win = this._editWindow;
      var who = (this._actor && this._actor.name && this._actor.name()) || '';
      var name = (win && win.name && win.name()) || '';
      var max = (win && win._maxLength) || 0;
      // The actor's name and the starting text are the same string until the player edits, so
      // saying both would say it twice. Name whoever it is only when they differ.
      var head = 'Name entry. ' + (name ? (who && who !== name ? who + ', ' : '') + name
                                        : (who ? who + ', blank' : 'blank'));
      BMA.Speech.speak(head + (max ? ', up to ' + max + ' characters' : ''),
                       { priority: 'critical', category: 'menu' });
      BMA.Speech.queueNext();
    } catch (e) {}
  };
}

//-----------------------------------------------------------------------------
// Register menu actions
//-----------------------------------------------------------------------------
BMA.Input.register('readDetail', function () {
  // Number entry (the Fey Spire consoles) has an index, so focusedWindow() does find it — but the
  // automatic readout is deliberately terse, and the whole point of the detail key here is to
  // hear the code built so far without disturbing it.
  var ni = BMA.Menus.focusedWindow();
  if (window.Window_NumberInput && ni instanceof Window_NumberInput) {
    BMA.Speech.speak(BMA.Menus.describeNumberInput(ni, true),
                     { priority: 'critical', category: 'menu' });
    return;
  }
  // Name entry, for the same reason: the grid is what has focus, and its readout is one character.
  // The value being built is in the edit window, which is not selectable and so cannot be focused
  // at all — this key is the only way to hear the name back, and the only way to hear it spelled.
  var ne = BMA.Menus.nameEditWindow();
  if (ne) {
    BMA.Speech.speak(BMA.Menus.describeNameEdit(ne), { priority: 'critical', category: 'menu' });
    return;
  }
  // The shop's quantity prompt has no index, so focusedWindow() cannot find it — yet while it
  // is up nothing else is focused, and it is exactly the panel worth re-reading in full.
  var num = BMA.Shop && BMA.Shop.numberWindow();
  if (num) {
    BMA.Speech.speak(BMA.Shop.detailLine(num), { priority: 'critical', category: 'menu' });
    return;
  }
  // On the party screen the detail panel is another actor's stats, so the read-detail key
  // opens the same browsable buffer rather than reading a wall of text.
  var actor = BMA.Menus.partyScreenActor();
  if (actor) { BMA.Status.open(actor); return; }
  BMA.Menus.readDetail(null, false);
});
BMA.Input.register('usableBy',   function () { BMA.Menus.usableBy(null); });
BMA.Input.register('reviewBuffer', function () { BMA.Review.enter(); });

})();
