# Development notes — Blackmoon Prophecy accessibility mod

## Layout
- `src/` — the mod's JavaScript, split into modules (loaded in this order):
  `BMA_Core.js` → `BMA_Text.js` → `BMA_Menus.js` → `BMA_Nav.js`.
- `src/gen_sounds.js` — build-time WAV generator (ports ff1-screen-reader's ToneGenerator math).
- `native/bma_tts/` — N-API addon that calls Tolk.dll in-process (`bma_tts.cc`, `binding.gyp`).
- `installer/` — `install.bat`/`install.ps1`/`uninstall.*` (relative-path, idempotent).
- `build.ps1` — bundles `src/*.js` → `dist/bma-payload/BMA_Accessibility.js`, generates the
  WAVs, copies the prebuilt `bma_tts.node`, and stages the installer.
- `tests/` — the test suite (`node tests/run.js`); they load the real `src/*.js`, so they are not
  bundled and `build.ps1` never sees them.
- `dist/` — the shippable patch (bma-payload + installer scripts).

## Building

The source checkout excludes generated packages and native binaries. For native speech,
build the addon below and supply the compatible x64 Tolk and NVDA controller DLLs in `redist/`.
The release procedure describes the required payload. Tests read the separately installed game.

### The native addon (one-time, or when bma_tts.cc changes)
The addon is N-API, so it is ABI-stable and forward-compatible. It was built here with the
modern `node-gyp` capped at `NAPI_VERSION=7` (see `binding.gyp`), which loads in NW.js 0.49.2
by N-API forward compatibility:

```
cd native/bma_tts
set PYTHON=C:\path\to\python.exe        # if node-gyp can't find Python
npx node-gyp rebuild
```

`native/build.bat` documents the alternative `nw-gyp --target=0.49.2 --arch=x64` path. nw-gyp
3.6.8 rejects Python 3.14, so the node-gyp + NAPI_VERSION=7 route was used instead. Output:
`native/bma_tts/build/Release/bma_tts.node`.

### The patch
```
powershell -File build.ps1
```
Then ship the contents of `dist/`.

## Threading

`bma_tts.node` owns one worker thread. `Tolk_Output` blocks — it is an LRPC round-trip into
NVDA, or a SAPI call with COM apartment affinity — so calling it from JS stalled the render
thread mid-frame. `load()` now hands Tolk to the worker (which CoInitializes itself and runs
`Tolk_Load` there, keeping the SAPI apartment on one thread for the process's life); `speak()`
just enqueues. Measured: 20 `speak()` calls cost **0.022 ms** on the calling thread.

Everything else stays single-threaded, because it has to — Web Audio nodes and the MV globals
are main-thread only. What the JS side does instead:

- `BMA.defer(fn)` batches cue work into one `setTimeout(0)` so it runs *after* the engine's
  update call rather than inside it. Used by the footstep / wall-tone / wall-bump hooks.
- `BMA.Nav.flood()` swaps `$gameMap.events/eventsXy/eventsXyNt` for index-backed versions for
  the duration of the BFS. Vanilla `eventsXyNt` rebuilds and scans the whole event array on
  every call, and `canPass` calls it once per tile per direction — ~230k rebuilds of a
  ~300-element array on the Overworld. Patching the *lookup* (rather than reimplementing
  passability) keeps plugin aliases on `canPass`/`isMapPassable` in the path, so paths are
  unchanged; `tests/nav_flood.js` asserts the indexed BFS matches an unindexed reference exactly.
- **`updateWallTones` goes through the same index, and memoises per tile.** It was the one
  `canPass` caller that did not, and at four calls per step it — not the Web Audio nodes — was
  what made movement stutter when two tones and a footstep landed together. `blockedDirections()`
  caches on `(mapId, x, y)` and shares `_clearFloods()`'s invalidation, because an NPC stepping
  aside changes the flood and the wall set alike.
- **Rate-limit before deferring.** A blocked move does not stop the engine re-running
  `moveByInput`, so holding into a wall re-enters `moveStraight` ~60 times a second. Consult
  `BMA.Nav.shouldBump()` (a couple of integer compares) *before* allocating a closure and pushing
  onto the defer queue. Hook player-only behaviour on `Game_Player`, never `Game_CharacterBase` —
  on the base class every wandering NPC pays the alias frame before the identity check.
- **Pan is baked into the WAVs** by `gen_sounds.js` for `wall_n/s/e/w` (n/s centre, e hard right,
  w hard left) and `footstep`, so those take no runtime `StereoPannerNode`. `wall_bump` and
  `beacon` are generated centred and *do* pan at runtime — for the bump that is the only thing
  telling you which wall you hit. Every one-shot sets `onended → disconnect()`; without it the
  render graph grows for as long as the player walks.
- Turn on **Perf logging** in the F8 menu to get per-bucket timings in `www\mod\bma_log.txt`.

## Testing without the game

```
node tests/run.js              # every test, one line each
node tests/run.js -v           # stream each test's own output
node tests/run.js shop         # just that one
```

Exit code is 0 only if all passed. A test that cannot find the installed game exits **2** and
is reported as *skipped*, not failed, so the suite stays runnable on a machine with the repo but
no game.

The tests load `src/*.js` under stubbed MV globals, so they test the shipping code rather
than a copy. Most also read the installed game's data files, because the mod's behaviour is
driven by this game's real configuration (ICFSoft's status columns, YEP's equip slots, the shop
plugins) and hardcoding a guess at those would test a fiction. Set **`BMA_GAME_DIR`** if the
game is not at the default path in `tests/_paths.js`.

**These lived in a session scratchpad until they were moved here, and two of them had rotted
silently in the meantime** — see the notes below. That is the argument for keeping them tracked:
a test nobody diffs is a test nobody notices breaking.

- `tests/nav_scan.js` — runs `BMA.Nav.scan()` over all 644 maps and asserts `classify`'s verdict
  **exactly**: 9411 entities — 4157 exits, 2064 treasure, 1851 NPCs, 529 enemies, 351 objects,
  269 shops, 190 save points. Exact rather than a tolerance band because these are fixed data
  files, so any movement is a real classification change worth looking at; update the numbers
  when you mean to change `classify`, and re-verify them if the game is ever patched past 1.05S.
  Also spot-checks `joinParts`. The census is now **9896**; it moved when `classify` learned to
  read through a lone common-event call (treasure +140, interactable −140, and nothing else by a
  single entity), so the stubs load `CommonEvents.json`, and again when traps stopped having to
  cost HP (trap +142) and pads you step on became destinations (interactable +22) — the stubs
  load `States.json` for the first of those, and **without it the 138 that move are miscounted
  into `interactable` instead**, which fails two categories at once and looks like one bug.
  - **The stub events must carry `eventId()` and `_pageIndex`.** `scan()` reads both to key its
    `_seen` map for the delta scan and swallows any mismatch into `this.entities = []`. The stub
    predates the delta-scan refactor, so this test scanned **0 entities** while still exiting
    0 — and it had no failure exit code at all, so the runner would have called it a pass.
  - The old documented expectation of "38 save points" predated the all-pages `_hasSaveCommand`
    fix (see *Classification notes* below); 38 + the 153 it found ≈ the 190 asserted now.
- `tests/airship.js` — the landing cue. The state machine (silent baseline, transitions only, the
  settle timer that stops a ragged coast producing a stream of contradictions) against a stub
  whose landability the test sets directly, then `canLandHere` against **every one of the
  Overworld's 57,500 tiles**, checked against the installed engine's landing rule. It also
  asserts the fixture is a mix of both answers — a rule that always says "no" would pass the
  comparison while telling the player nothing. `LANDING_SETTLE` is shrunk to 5 ms; the test is
  async because the settle timer is real wall-clock time.
- `tests/nav_flood.js` — flood/event-index equivalence and restore-on-throw, mutually exclusive
  keysets, the wall-bump rate limit, and category-switch phrasing.
  - The `PATH_TURNS` truncation case feeds `describePath` a synthetic path whose steps are
    *already diagonal*. That is not a shape the flood can produce, and an early version of the
    staircase rule paired those up and reported their sum as a straight line — which the test
    caught. The rule requires both halves to be one tile along one axis.
  - The keyset section asserts **exactly one variant live per keyset** across all three sets.
    It used to assert that shift+p and ctrl+p were keyset-*independent*, which stopped being
    true when the left-handed set gave the path-filter toggle a third variant — and the ctrl+p
    half was checking `toggleLayerFilter`, removed outright in `0b5235f`. `isActive()` answers
    `true` for any action it has never heard of, so that half passed vacuously for months.
    Assert against `BMA.Config.keys` membership, not `isActive()`, when you mean "this binding
    exists".
- `tests/equip_config.js` — equip-slot readout, the `joinParts` glue rule, and config migration.
- `tests/menus_status.js` — `BMA.Buffer` wrap/group logic, `BMA.Status.build` against the game's real
  ICFSoft column configuration (read out of `plugins.js`) and with `ICF` absent, the status
  navigation keys, a replay of the `Window_SaveConfirm` construction sequence, and the party
  windows. Note it has to polyfill `String.prototype.format` — MV adds that in `rpg_core.js`
  and the database's EXP headings are format strings.
- `tests/shop.js` — shops: asserts the dropped command-row announce as a regression witness
  (replay `Scene_Shop.create`'s order with only the generic hooks and nothing is spoken), the
  focus watchdog, the quantity prompt's throttle and bounds latch, and the buy/sell price lines.
  Stub `BMA.Shop._now` to drive the throttle rather than sleeping.
- `native/bma_tts/test_load.js` — loads the addon and checks it degrades safely with no Tolk.dll.
- `test_thread.js` — drives the threaded addon against the real deployed `Tolk.dll`.

## Menus

- **`isFocusable`, not `active`.** `Window_Command`'s constructor calls `select(0)` then
  `activate()` (rpg_windows.js), so a window announces itself while its scene is still being
  built. YEP's `Window_SaveConfirm` is created last in `Scene_File.create` and only sets
  `openness = 0` *after* the super constructor returns — which is why opening the save screen
  used to say "Yes, 1 of 2" and swallow the save-list announcement. That window then stays
  `active` and closed forever, so `isOpen()` (`_openness >= 255`) is the only reliable test.
  `announceCurrent` is also deferred and coalesced to one per frame, so only the window still
  focused when the frame settles gets spoken.
- **Shops are the third transient-window casualty**, and the reason `BMA.Shop` exists.
  `Scene_Shop.create` builds the command window (whose `Window_Command` constructor selects and
  activates it) and *then* `createCategoryWindow`, and BM_ShopCore's `Window_Item2Category` is
  another `Window_Command` — so its constructor's `activate()` overwrites `announceCurrent`'s
  single `_pending` slot before the next two lines `hide()` and `deactivate()` it. The deferred
  run then finds an unfocusable window and drops the announce, so opening a shop said nothing at
  all. MrTS_NoItemCategories replays the race on every Sell (`commandSell` runs the stock
  category `show()`+`activate()` and only afterwards hands over to the sell list). The fix is a
  **focus watchdog** on `Scene_Shop.update` that announces whoever holds focus when that differs
  from `BMA.Menus._lastWin/_lastIndex` — what was last actually *spoken*, recorded in
  `_speakCurrent`. It claims the window *before* speaking, because `_speakCurrent` bails without
  recording when `resolveText` is empty and an unreadable window would otherwise be retried every
  frame. Deliberately **not** generalised into `announceCurrent`: retargeting `_pending` to
  `focusedWindow()` would double-speak against the `Scene_File.start` hook, break
  `BMA.Battle._consumeCmdSuppress` (keyed on the exact window object), and make every scene's
  construction announce whatever happened to be focused. Armed 50 ms after `start()`, as on
  `Scene_File`, so leftover transition speech from the outgoing map does not clobber it.
- **`Window_ShopNumber` has the same no-`maxItems` shape as `Window_Status`** — it inherits `0`,
  so `isCursorMovable()` is always false, `select()` is never called and its index stays `-1`;
  the hooks, `isFocusable` and `focusedWindow` can none of them see it. Unlike the status screen
  it is not worth a `BMA.Buffer`: read it from **`changeNumber()`**, the single choke point for
  the arrow keys *and* the touch buttons. **Do not override `maxItems()`** to give it an index —
  that switches on `processCursorMove`, whose `cursorDown()` evaluates `-1 < maxItems - maxCols`
  and calls `select(0)`, so the −10 key would also announce the window as a menu row and fight
  the quantity announce; it also switches on `processTouch`. Note the axis mapping is
  **left/right = ±1, up/down = ±10** via `Input.isRepeated` — with `keyRepeatInterval` at 6
  frames a held key fires ~10×/second, hence `BMA.Shop.THROTTLE`. Stock `changeNumber` gives
  **no feedback whatsoever when clamped** (no cursor SE, no redraw), which is why hitting the
  ceiling says "Maximum N" — latched, so holding says it once.
- **The status screen is read from the actor, not the screen.** `Window_Status` has no
  `maxItems`, so its index stays `-1` and the select/activate hooks can never fire there.
  `BMA.Status` builds a `BMA.Buffer` (a port of ff1-screen-reader's `Core/NavigationBuffer.cs`)
  of live closures instead. Parameters come from `Game_Actor.statusMenuCols()` —
  ICFSoft_StatusMenu makes the columns data-driven, so the buffer mirrors exactly what is drawn
  and follows any per-class `<Status-Menu-Col-N>` notetag; do not hardcode a stat list. It
  degrades to the eight base params when `ICF` is absent. Equipment lists **all** slots, unlike
  the window, which truncates at `maxEquipmentLines()` = 6 while every class here has 7+.
- **Party windows return numbers.** `Window_PartySelect.item()` and `Window_PartyList.item()`
  return an actor id (or `0`), not an item object; feeding that to `describeItem` produced an
  empty string and total silence. Both are special-cased ahead of the generic `item()` branch
  and use `curActor()`.
- **Never read a list window's capture buffer.** `_bmaLines` holds everything the window drew,
  so on a multi-row window it is *every row at once* — `Window_MenuStatus` came out as
  "Vahn Lv 1 HP 150/150 MP 18/18 Hans Lv 1 …" in one utterance. `resolveText` now only falls
  back to the capture when `maxItems() <= 1`; anything larger with no recognised accessor
  returns empty and logs the window class to the speech log. `Window_MenuStatus` (and
  `Window_MenuActor`, which extends it for item/skill targeting) has **no `item()`** — the row's
  actor is `$gameParty.members()[index]`, which is what the engine's own `processOk` uses.
- **The status buffer mirrors `drawEquipments`.** That function calls
  `drawItemName(equips[i], …)`, which draws nothing for a null slot, so the screen shows only
  equipped items — the buffer skips empty slots to match, and omits the Equipment group entirely
  when nothing is worn. It does *not* copy `maxEquipmentLines()`'s 6-line cap: every class here
  has 7+ slots, so that cap can hide a genuinely equipped item.
- **`BMA.Speech.queueNext()`** exists because announcements are deferred. When the mod speaks a
  heading (the actor whose page you moved to) the scene has *already* scheduled its own announce
  for the newly focused control — `Scene_Equip.onActorChange` activates the command window before
  the `nextActor` alias runs. Both default to `interrupt: true`, so the second wiped the first.
  `queueNext()` is a one-shot that forces the very next utterance to append instead; the addon
  passes `interrupt: false` straight through to Tolk, which queues it. One-shot on purpose — a
  follow-up that never arrives must not leave speech permanently non-interrupting.
- **Galv_QuestLog is the Marks screen**, and this game's *only* quest log — configured with
  `Quest Command: "Marks"` over `www/marks/marks.txt`, and pushed by `Galv.QUEST.viewLog()` from
  an event, not from a menu command. `Window_QuestList.item()` returns **two different shapes**: a
  category header `{categoryTitle, count}` with no `name` at all (which read as empty, hence the
  silent list) or a `Game_Quest` whose **`name` is a method**. `_nameOf()` resolves callable names
  generally, so `describeItem` can never send a function's source to the reader. Every icon in
  this config is `0`, so tracking has no on-screen marker — the readout says "tracked" anyway,
  because pressing OK is what tracking *is* and it would otherwise give no feedback.
- **Speech log** (`BMA.Log.say`, gated on `BMA.Config.speechLog`) writes each utterance to
  `bma_log.txt` after `cleanText`, so the transcript is exactly what the reader was handed.
  It goes through `BMA.defer` — `BMA.Log.write` ends in `fs.appendFileSync`.
- **Actor paging.** Alias `Scene_MenuBase.nextActor`/`previousActor`, not `onActorChange` —
  Status, Equip and Skill each replace `onActorChange` without calling super.

## Config defaults vs. saved settings

`BMA.Persist.VERSION` + `_migrate()` exist because settings live in `config.rpgsave`: once a
value has been written there, changing the default in `BMA.Config` has no effect for anyone who
has already played. Bump `VERSION` and add a case to `_migrate` when a changed default must win
over a stored one (v2 raised `vol.wallTone` to 2.0). Settings the player changed *after* that
version are left alone. `keys` is merged rather than replaced for the same reason — a config
written before a binding existed would otherwise delete it.

## Pathfinding

- **Two floods, not one.** MV blocks any tile holding a normal-priority event
  (`isCollidedWithEvents`), so chests, crystals, statues, NPCs, guards **and door/gate events**
  are walls to the BFS — and `canPass` blocks *entering* such a tile but never *leaving* it, so an
  event tile is a sink, not a bridge. That severs whole maps: Mohadmal Village floods 11 tiles
  instead of 1175, East Branch 9 instead of 963, Arcane Library 4 instead of 467. A player in the
  wrong pocket got "no path found" for *everything* while walking there perfectly well, because
  they trigger the door or the NPC wanders off. `flood(true)` re-runs the same BFS with
  `_withEventIndex`'s `ignoreEvents` making `eventsXyNt` report every tile empty — `canPass` still
  runs, still honours tile flags and every plugin alias, and simply finds nobody standing there.
  It runs **only after the strict pass fails**, so the common case is unchanged. `blockerOnPath`
  then walks the relaxed route and names the first tile the player cannot enter.
- **`reachable()` is relaxed and fails open.** It backs the path filter, and answering
  "unreachable" from a flood that failed empties the list — the symptom the filter kept getting
  blamed for. A `failed` flood answers `true` for everything.
- **`flood()` catches.** 78 enabled plugins alias `canPass`/`isMapPassable`. A throw used to leave
  the *previous position's* flood cached, so the mod answered questions about where the player
  used to be standing. It now fails closed with a log line, which the `failed` flag distinguishes
  from a genuinely empty map.
- **`_goalIndex` approaches diagonally** (`APPROACH`, not `DIRS`). Movement is 4-directional;
  standing is not, and an alcove reachable only from the diagonal was permanently unreachable.
- **`tileDist` is Chebyshev — straight line, not walking distance.** A target 5 east and 5 south
  is 5 by that measure and a 10-step walk. Announced step counts come from `pathTiles().length-1`;
  `tileDist` is still right for bearings, sort order and the beacon.
- **Do not harden tileset flag lookups.** Tileset 3's `flags` array is 2576 long, not 8192, so
  every A2 tile ID reads `undefined`. MV is accidentally tolerant (`undefined & bit === 0` ⇒
  passable) and real walkable tiles depend on it — a defensive `flags[t] || BLOCKED` collapses
  Valla from 529 reachable tiles to 1.
- **The walls are walkable, and the strict flood has to know that.** All 45 tilesets leave their
  A4 block on the editor's default passability, which is *passable*, so the stone every dungeon
  is built out of is ground as far as `canPass` is concerned — Naddaha Pyramid is 20,158 tiles of
  it, Life Shrine 14,135. Nothing shows while the rooms are sealed and nobody walks into a wall.
  It shows the moment a warp lands the player beside one: the route from Life Shrine's entrance
  to its clock room came out as 210 steps that left the shrine, ran east along the top of a wall
  for 127 tiles, and crossed a map exit on the way. `_wallGround()` asks the engine's own
  `Tilemap.isWallTile` about the tile that decides passability, and the strict flood may step
  onto stone (things stand on it) but never out of it.
  **There is deliberately no fallback that walks over it.** Stone is terrain, not a preference
  like a trap. Measured over the 335 maps with walkable stone and a known arrival tile, every
  route this takes away is one made almost entirely of stone: 117 of Aether Mine's 122 tiles to
  Door 1, 20 of the 24 that map 543 used to get round the boulder standing in its corridor, all
  294 of Naddaha Pyramid's "reachable" entities on a save where no sealed passage has been
  opened. Losing them is the point — several restore `blockerOnPath`'s ability to name what is
  actually in the way instead of routing around it through the rock.
- **A tile a warp *puts* you on is not a tile you walked onto.** `checkEventTriggerHere` runs from
  `updateNonmoving` only when `wasMoving`, and `performTransfer` locates the player without
  moving them, so a touch pad they land on stays silent until they step off and back on. Life
  Shrine is built entirely out of pads that land on other pads; treating a landing tile as a dead
  end left 198 of its 16,830 tiles reachable and answered "no path found" for all but five of the
  78 things on the map. The flood expands a forced tile when `via[cur]` says a warp put them
  there — see the Aether Mine note in `flood()` for the case that rule must *not* break.
- **17 maps loop, and the flood has to wrap with the engine.** `canPass` goes through
  `roundXWithDirection`, so it had been answering about the tile on the far side of the seam all
  along and only the BFS's own bounds test threw the step away. It cost nothing on most of them —
  all four Overworlds, the Underworld, Floating Ruins and Archareon Prison are ringed by ocean or
  void, so no tile pair across the seam is mutually passable. **The Moon is the one that pays**:
  45 of its rows and 30 of its columns join up, and clipping at the edge floods 195 of its 3,347
  walkable tiles, so on a surface that is one connected piece everything past the seam answered
  "beyond the area you can reach". Five of the nine 50x40 "Map N" maps lose 29–386 tiles the same
  way. The loop flags are read **once per flood** into locals and compared as integers — this is
  the innermost loop on a 250x230 map. Everything that speaks a direction goes through
  `spanX`/`spanY` instead of subtracting coordinates, or a bearing points the long way round the
  world: on The Moon, 4 steps west reads as 71 steps east.
- **A diagonal corridor is walked as a staircase, and saying so a step at a time is useless.**
  Movement is 4-directional (nothing in the 77 active plugins changes that), so the run-length
  description gives every single step its own segment. Archareon Prison's central platform is a
  diamond whose four sides are all diagonal, and the walk to its save point came out as 37
  segments — of which `PATH_TURNS` speaks 8 before saying "then 29 more turns", which strands the
  player a third of the way round the diamond. **Every route on that map was like this**, and it
  is what "pathfinding is broken there" actually was. `describePath` pairs perpendicular single
  steps into diagonals, which is exact rather than a smoothing: two perpendicular steps *are* one
  diagonal move, so k alternating steps are `floor(k/2)` diagonals plus, when k is odd, one plain
  step left over at the end — in the right place, not guessed at. Below `DIAG_MIN` pairs it is
  left alone, because an ordinary L-corner is not a staircase and "east 4, south 3" already says
  it best. Which of the two to press first is not spoken: in a one-tile diagonal corridor the
  geometry decides, and guessing wrong is a wall bump that already has a cue.
- **The list you cycle is not the list of entities, and a correct flood can still leave a map
  unusable.** Archareon Prison was reported broken a second time while the diagnostics showed
  everything healthy — 26 jump edges, 18 entities, 18 of 18 reachable, real routes. What the
  player got standing on the save platform was "Exits: none" and four things called "Object",
  because `filtered()` dropped every crossing outright and the way out was unclassified. When a
  map is reported broken and the flood looks right, **read the `say:` lines in the speech log**,
  not the diagnostics block: the diagnostics report `entities`, and the player experiences
  `filtered()`.
- **Crossings are a category, and are still hidden from "all".** They are not places anyone sets
  out for, so listing them beside the chests buries everything — but on a map that is *nothing*
  but crossings they are the only way to get anywhere. Same treatment as traps, for the same
  reason: cycleable where you go looking for them, absent where they would drown the map.
- **`warps()` already understood the jump, which is why Archareon Prison floods at all.** The
  prison is platforms over open sky joined by 13 invisible action-button events, each standing in
  a gap with a Through-on move route that jumps the player the two tiles across. That is the same
  shape as Conall Curach's marsh stones and needed no new code — without those edges the entrance
  platform is 39 tiles and nothing else on the map is reachable.

## Classification notes
- Camp return tiles are exits on maps 43, 265 and 299. Common event 5 saves the source
  map and position before entering camp; the return tiles use those values after the player
  confirms. The scan reads the saved map ID and the already loaded map index for the label.
  Without a valid map name the tiles still appear as exits. The rule does not resolve other
  variable transfers or change native movement. The real-map test checks all 53 tiles and
  reachability from the common event's arrival position on each map.
- Order matters in `BMA.Nav.classify`. An innkeeper is `text → choice → change gold →
  recover all → transfer`, so testing rewards before services files every inn under "treasure".
- An event with a graphic, an action trigger, and **no commands** is scenery (animated beds,
  torches, banners). There are 6249 of them; they are excluded, or every inn lists nine "objects".
- **A trap does not have to cost HP**, and the last test in `classify` takes touch triggers as
  well as the action button. These two go together and the order they were added in matters.
  Thunder Mountain Inner is floored with 138 visible tiles that inflict Poison, Blind or Silence
  on the whole party; because they change a state rather than a number they were not traps, and
  because they fire by being stood on they were not anything else either — they fell out of
  `classify` entirely and routes were spoken straight over them. Only *adding* a state counts;
  the same command with Remove is a cure tile. Archareon Prison's four pressure pads are the
  other half: step on all four and the barrier holding Lord Adder comes down, and not one of them
  appeared in any list, so the objective of the map had nothing to navigate to. **Widen the touch
  rule before the trap rule and the 138 damage tiles land in Objects**, which turns a list of
  hazards into a list of places worth walking to.
- Four traps on Archareon Rise are named "inflicts Archareon Rise". That is correct: state 68 is
  a real five-turn silence that seals ten skill types, and the game named it after the area. The
  name is read off the data like every other name here rather than guessed from its battle
  message.
- **A doorway does not need to be silent, but it does have to leave the map.** "Anything that
  also talks is an NPC who happens to move you" is a rule about *people*, and it needs somebody
  standing there; on an invisible tile nobody is, so it **is** the doorway however much it
  narrates. 16 events in the game are one, and the **only way out of Archareon Prison** is among
  them — a touch tile asking "Return to Branch Castle?" — as are the two tiles in Branch Castle
  that are the way in. Both ends of that trip were invisible, so the prison answered
  "Exits: none" with the player standing in it. The off-map clause is the whole rule: without it
  53 more arrive, every one a cutscene repositioning the player mid-scene (Rift Shrine's 39-line
  Ramuh scene shunts you four tiles north partway through), which put "Door 1" in rooms that have
  no door. Those were already caught as crossings, and crossings are hidden from "all", so the
  broader rule made things *worse* than the silence it replaced.
- **`classify` may set `singular`** to override the per-category word for something that shares a
  category but is not the same kind of thing. A drawn tile you *stand on* that throws a switch is
  a pad, not an "Object" — "Pad 1" is worth hearing when stepping on all four is the puzzle. It
  also keys the numbering, so pads and objects on one map count separately instead of
  interleaving into "Pad 1, Object 2, Pad 3". "Pad" is the game's own word: Lord Adder says the
  barrier falls "by stepping on some pads that power them".
- **Two categories cannot be judged from the active page**, and both are checked across all
  pages instead (`_hasSaveCommand`, `_hasTransferOnAnyPage`):
  - *Save points.* Not one of the 153 in this game has its Open Save Screen command on page 0 —
    page 0 activates the crystal on touch, and a later page behind a switch does the saving.
    Judging by the active page meant no save point existed until after you had found and used
    it, so Branch Castle appeared to have none.
  - *Sealed doors.* 62 events are a shut, movement-blocking door tile with no commands at all,
    whose Transfer only appears on a later page. They were invisible, leaving rooms whose only
    way onward listed nothing.
  Both require the **active** page to have a graphic, so a crystal or door switched to its
  hidden state stays out. The closed-door test runs last in `classify`, after NPC and treasure,
  so an NPC who teleports you keeps their own identity. Everything else is 96–98% page 0, so
  do not generalise this — applying it to treasure would keep opened chests in the list forever.
- `blockerToward()` answers "no path found" with *what* is in the way. Branch Castle's throne
  room door is blocked by a guard standing at 18,4 until the story moves him; the route exists
  geometrically (17 steps) and is severed purely by that event. It picks the event nearest the
  target that is itself unreachable but adjacent to walkable ground.
- **A castle is not a town, and its rooms are not houses.** `DoorPeek._phrase` names a room after
  whoever stands in it, which is right in Valla and wrong in a castle: Branch Castle's General
  Rickard holds a guard hall outside the throne room, and calling it "Rickard's house" asserts
  something false. `isCastle()` walks the parent chain (`/castle|palace|keep|throne/`, deliberately
  narrower than `SETTLEMENT` — "citadel" and "port" name towns here) and `_phrase` drops the
  *ownership claim* while keeping everything it counted: "Room, 2 chests" instead of "Cid's house,
  2 chests", "Empty room" instead of "Empty house". Faluhd Castle settles the wording — a ruin
  held by monsters, 22 treasure chambers, no householders at all. Shops, inns, save points and
  services are read off commands and are unaffected. Rooms only a person can identify go in
  **`BMA.Nav.ROOMS`**, keyed by destination map and landing tile, researched from who stands there
  and what they say (Lenadia's records room from "I need to alphabetize this section of our
  records"; the Citadel's kitchen from "I've got some hungry bellies to feed!"). **Never a
  person's name**: if the king is Donk, it is the throne room, not Donk's. Branch Castle is
  deliberately absent — the game already gives its rooms real map names.
- **`MAX_ROOM` firing is an answer, not a failure.** It means the door does not open into a room
  at all. Measured, because it looks like a bug until you check: Darnecles' interior is **one
  1,948-tile component, 89% of its map**, and four of its seven doors land in that same component;
  Lenadia's main body is **5,166 tiles, 93% of its map**. A town's houses are sealed boxes reached
  only from the town map — which is why Valla resolves and these cannot. Raising the cap would not
  turn them into rooms, it would describe most of a castle at every door. Those landings are named
  in `ROOMS` ("Main hall") instead. Tileset flag coverage was checked and is complete for both
  maps, so this is not the short-`flags` problem noted under *Pathfinding*.
- **`_nameInnerDoorways` is its own pass, and runs first.** A transfer landing back on the current
  map is category `door`, so it never reaches the exit grouping and could only ever be "Door
  1..24" — and in Faluhd, Castle Interior and Lenadia every room is behind one. It cannot sit
  inside `_disambiguateDoors`'s main body: that gives up early on a map with fewer than two exits,
  and Faluhd Castle has exactly one, so all 24 of its doorways stayed numbered even after the room
  table was written. `ROOMS` answers first, the peek fills in the rest.
- **`namesNothing` decides whether to look inside, not `isVagueDestination` alone.** A placeholder
  ("Interiors") never distinguished doors; neither does a destination whose name repeats the map
  you are standing on. Eleven doors reading "To Tomra Castle, door 1..11" hid three shops, an inn,
  a save point and the throne approach. Branch Castle is untouched because its doors lead to
  Library, Quarters, Hall and Darius Training — names that beat any peek, and none of which
  repeats "Branch Castle". Do **not** relax `isVagueDestination` itself; `tests/nav_realmap.js`
  pins its semantics directly.
- **A prop drawn on a character sheet is not a person** (`PROP_SPRITES`). MV has one notion of
  "drawn with a character sheet" and `classify` reads it as "somebody is standing here", which is
  right for every sheet in this game but one frame. `BPR_008` is Hunter, Nurse, Pirate, Taol,
  Dion, Hans and a second Pirate — and frame 4 is a glowing rune, used 26 times. So Gulgur
  Volcano's five sealing glyphs were NPCs (all five called **"Elina"**, after the party member
  whose line dispels them), the twelve that fight when touched were enemies, and Life Shrine's
  clock centre and the five Aether Crystal Shards were "NPC 1". Keyed on the art, the way
  `_looksLikeTreasure` reads a chest off the tileset. An entry withholds `hasSprite` and *only*
  `hasSprite` — `hasGraphic` must stay true or the scenery test discards the event entirely.
  The twelve leaving `enemy` is the sarcophagus rule: armed glyphs are drawn exactly like
  harmless ones and no map holds both kinds, so an enemies entry was a warning no sighted
  player gets.
- **A party-actor speaker names nothing that is not a person — but "not a person" is the
  graphic, not the category.** Two cases and they cover every one in the game: a prop sprite
  (Gulgur Volcano's five glyphs, called "Elina" after the party member who dispels them) and an
  event that draws *nothing at all* — an invisible touch tile that runs a scene. Seventeen of
  those, all touch-triggered: Aether Mine's (140,79) is the party working out what Atomos is,
  hands over an item at the end so it is filed as treasure, and was called "Vahn".
  Do **not** widen this to "never name anything after a party member". That is wrong 22 times
  over, because a party member standing on a map before or after they join *is* the person
  standing there: it renames Biggs and Wedge in the Quarters to "NPC 1"/"NPC 2", Brindle in his
  own hovel to "NPC 1", and Ovelia in her hidden abode to "Portal one day". Every one of those
  has a character sprite and not one of the seventeen has any graphic — that is the whole line.
- **`event` is for a scripted scene, and the qualifier is what it does at the end.** Nothing drawn
  on the tile, talks when you walk onto it, and finishes with a fight or a reward. Those were
  filed as whatever the last line happened to do: Aether Mine's (140,79) is the party working out
  what Atomos is and it hands over an item, so it was a chest; 31 more end in a fight, so they
  were enemies standing in an empty corridor. 35 on a fresh save (153 under `nav_scan`'s page-0
  fixture, because 118 have a page-0 switch a real save has not set).
  Three boundaries, each guarding a population far larger than the 35. A **transfer** is a
  doorway however much it talks, and is settled first. A **trap** is answered before all of it —
  Aether Mine's 92 silent MP drains are invisible walk-on tiles too. And it must end in a fight
  or a reward: without that clause the rule also takes 129 events `classify` has always dropped,
  including the 23 **MogNet GPS signposts** on each Overworld, invisible tiles that read out the
  nearest town as you pass. Those are spoken by the dialogue layer when you cross them and are
  not destinations. 229 invisible tiles that fight and say *nothing* stay under enemies: an
  ambush is not a scene.
  It leaks less than what it replaced, not more — the tile is invisible either way, and "Enemy 1"
  told a blind player a fight was coming where "Event 1" only says the story does something here.
- **A scene is never named after whoever speaks first.** The first speaker names an entity
  everywhere else in the mod; here it is the worst answer available, because 20 of the 35 open
  with a boss line — the tiles read "Yiazmat 2", "Ultros 2", "Gilgamesh 2", "Archareon 1",
  "??????". Nothing is drawn on them, so a sighted player walks the corridor and sees nothing:
  the same reason mimics stay filed as chests. `_sceneKind` answers with **who is doing the
  talking** at the coarsest grain still worth hearing — `Party conversation` (only the party
  speaks: 4, Aether Mine's Atomos scene among them), `Conversation` (somebody outside the party
  has a line: 28), `Scene` (nobody is tagged, narration: 3) — and `_numberDuplicates('event',
  null)` numbers them only where a map has more than one, so Branch Castle gets "Conversation
  1..3" and Aether Mine keeps a bare "Party conversation".
  Deliberately no finer. "The party meets a stranger" versus "a stranger speaks alone" is a real
  distinction in the data and a tell in the game: the second is nearly always an ambush.
  The `null` word argument to `_numberDuplicates` is what makes the name take a bare number
  rather than ", scene N" — the label already is the noun.
- **A sound only names something you can see.** `_routeSoundName` exists for Mythril Mine's 46
  mine carts, whose move route plays "Minecart" and does nothing else. Across the game it
  produced five distinct names and two were filenames, so it now refuses an event that draws
  nothing on any page (the scene's own noise, not a thing's name — Inner's Quetzalcoatl cutscene
  was "Monster3") and any name containing a digit (an index into the sound folder: "ff6fall",
  "Moogle2"). "Minecart" and "Chocobo" are what is left, and they are the reason it exists.
- **`LABELS` is the shipped last resort, and the bar is high.** Six entries, all of them the
  shared prop sprite: an entry earns its place only when the event says nothing about itself
  *and* the rules that would otherwise catch it would be wrong rather than merely silent. Life
  Shrine's "Clock center" is named to match the instruction the numerals give ("Return to the
  center"); the five Aether Crystal Shards say so only in narration ("The Aether Crystal Shard
  begins to glow"), which no rule reads, and "Glyph" would be a lie. Ranked below the player's
  own hand-typed labels and above everything automatic. Anything that names itself still wins —
  the Rift Shrine teleporter keeps "Teleport to the Rift Shrine" from its own prompt.
- **Number the passage, not the tile.** A doorway that lands back on this map is two events, and
  numbering them separately orders them by distance from the arrival tile — which *guarantees* the
  two ends get unrelated numbers, because the far end of a passage is nowhere near its near end.
  Life Shrine is forty-eight identical pads: the one at (23,50) was "Door 16" and the one it lands
  you beside was "Door 22". `_pairInnerDoorways` gives both ends of a reciprocal pair one name, so
  "take Door 5" works from either side and the Door 5 you land next to is the way back. 746
  same-map doorways game-wide: 531 pair up, 62 are genuinely one-way and say so, 153 already had a
  real name from `ROOMS`/the peek and keep it.
  Two details that are not optional. Reciprocity is *within a step*, not exact: a stairway lands
  the player one square clear of the return event so arriving does not fire it, so the two are
  never quite each other's destination. And the partner search runs over **all** same-map
  doorways including named ones — Throne Room's four pads each return through a door the room
  table already named, and searching only the bare ones labelled all four "one way" when none is.
- **A wide doorway is one way through, not seven.** Every tile of an arch carries its own Transfer
  and they all land on the *same* destination tile; numbering them invented choices that did not
  exist. 1,485 of this game's door entries are redundant tiles — Branch Castle's way into Darius
  Training is seven of them, Lindblum's front gate another seven. Ordinals now count distinct
  landing tiles, so "To Quarters, door 1/2" (genuinely two doors) survives and "door 1..7" does not.
- **A service beats a resident.** `serviceOf` reads it off the script, never off dialogue: a
  `Galv.QUEST` call is the Marks board (12 towns had it as "Hunter's house" — not a house and not
  his), and a choice followed by a transfer is transport. A tavern stays hand-authored, because
  "the ale's not too bad here" is a remark, not a service.
- **An event that only calls a common event is that common event.** 140 chests keep their gold and
  items inside "Infinitarium Chests" / "Miasma Stream Chest 1", so their own pages held nothing a
  reward test could see and all 140 read as "Object N". `classify` now merges a delegated common
  event's codes. Narrow on purpose — exactly one call and no behaviour of its own — which is why
  no other category moved by a single entity.
- Exit destinations come from `BMA.MapNames`, which reads `displayName` out of the first 4 KB of
  the destination's `Map###.json` (node `fs`), falling back to `$dataMapInfos` with a
  parent-chain prefix for generic editor names ("Inn" → "Branch Castle Inn").
- NPC names come from the speaker tag on the event's own dialogue, not the editor event name.
- Equip slot layouts come from each class's `<Equip Slot: ...>` notetag, which YEP_EquipCore
  parses into `class.equipSlots`; `Game_Actor.equipSlots()` is overridden to use it, so MV's
  "one of every equip type" default never applies here. **All 28 classes repeat a slot type** —
  every one has two Relic slots, Monk and Puppeteer have three, Gambler two Card, Red Mage two
  Orb — so `describeEquipSlot` numbers repeated types ("Relic 1", "Relic 2") and leaves unique
  ones bare. If you need to recompute this, copy the regexes out of
  `YEP_EquipCore.processEquipNotetags1`; guessing at them silently yields the default layout
  and hides every duplicate.

## 1.12 routing and puzzle checkpoint

The 1.12 data audit parsed all 645 indexed maps, 19,111 events, and 34,988 event pages.
All 6,361 fixed transfer commands name an indexed destination. Of the 57 variable transfer
commands, 53 are the three camps' return tiles and four are Esto Yensa's party-switch branches.
Between the local 1.09 data and 1.12, only Map180 and the map index changed among map files.
Map180 retained the same geometry and destinations for the three edited events. The audit
does not prove route availability under every save, switch combination, or script-controlled
movement. Ordinary room unlocks were left in navigation scope.

Set `BMA_GAME_DIR` to a 1.12 game root and run `node tests/run.js` through the shared bounded
runner. All 14 tests passed. This includes the full page-zero census and real-map fixtures for
the camp exits, Etherdepths' bridges, Eagle's Cradle's movable shells, Esto Yensa's party
switching, Archareon Prison's jumps and pads, and the endgame puzzle objects. The camp test
failed on the prior mod revision and passes with this change. The added classification only
reads one saved variable and the loaded map index for matching camp events; it adds no hook,
movement command, file read, or per-frame polling. Game responsiveness and spoken output
still need gameplay confirmation.

The follow-up checked destination coordinates as well as map IDs, classified every event page,
and reviewed the 20 unlisted switch-and-action candidates. Those are Crescent Rivulet's
existing bridge triggers, optional auction prompts, and story or party transitions. The
mechanism census also looked for multi-object groups, separately from ordinary unlocks.

- Cleft of Wind and its companion map (549 and 550) have 31 doors with two switch-controlled
  destinations. Routes and door names share the active branch. The seven touch markers are
  listed under Objects. Routes stop at a marker that changes the current layout, and the next
  navigation query rebuilds the doors and flood even if the active event pages did not change.
- All 20 Infinitarium room exits (maps 508–527) are selectable. The random transfer is an
  exit from the current route, including when the game happens to choose the same room.
- Automatic event pages contribute no player-operated edges. A walk onto an unconditional
  off-map exit terminates the route on that tile. A transfer landing directly on a tile still
  follows the engine's arrival behavior. Missing-bridge hints remain available when the
  destination is beyond the relaxed flood.
- Forest's forced west mode and Gozmodan's redirected south input constrain the flood. Its
  cache includes the active movement mode so changing it does not require a step to refresh.

The test harness reads the required RPG Maker MV methods and name tables from the local
installation at runtime. It evaluates those selected assignments with fixture globals and
never writes them out. The fixture does not launch RPG Maker or simulate timing in the game.
The map census and targeted fixtures exercise the route changes above. Arbitrary script
conditions, every save state, native timing, and screen reader speech remain outside the
offline proof.

## What still needs the real game + a screen reader
- Actual Tolk/NVDA speech (needs an x64 `Tolk.dll` + a running screen reader).
- Navigation "feel" tuning (verbosity, beacon cadence) — exposed as `BMA.Config` knobs and the
  F8 mod menu.
- Interaction of the enabled `ForcedLeftMovement` / `RedirectDownToUp` plugins with movement cues.
