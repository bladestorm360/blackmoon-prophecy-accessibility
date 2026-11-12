# Blackmoon Prophecy Remake — Blind Accessibility Mod

## Purpose

Adds screen-reader speech, spoken pathfinding navigation, and audio cues (footsteps, wall
tones, target beacon) to **Final Fantasy Blackmoon Prophecy Remake** (an RPG Maker MV /
NW.js fan game).

The mod reads menus, dialogue, and battle text aloud, and lets you find and navigate to
exits, doors, shops, NPCs, treasure, save points, objects, events, enemies, crossings, traps,
and vehicles — cycling them by category, speaking step-by-step directions to whichever one you
select, and sounding an audio beacon that guides you in as you get closer.

Two of those categories are deliberately left out of **All**, because they are things to know
about rather than places to head for, and listing them alongside the chests would bury them:

- **Traps** — where the damage tiles are, so you can walk around them.
- **Crossings** — the stepping stones, gap jumps and shortcuts the router uses to get you
  across a map. On most maps you never need to ask. On a few — Archareon Prison is platforms
  over open sky joined only by jumps — travelling means going from one crossing to the next,
  and that is what this category is for.

## Known Issues / Notes

- **NVDA users: turn focus mode on before you play.** The game runs inside a Chromium
  window, so NVDA treats it as a web page and starts in browse mode — which swallows the
  arrow keys and most of the mod's own keys before the game ever sees them. With the game
  window in front, press **NVDA+Space**; you will hear a low tone, and NVDA+Space again
  switches back. If the game seems not to respond to any key at all, this is almost always
  why. JAWS and Narrator need nothing special.

- **Splitting the party at Esto Yensa: don't make Nobumasa your last pick for Vera's team.**
  This is a bug in the base game rather than in the mod. His confirmation step fails to
  record the last two members of Vera's team, and the game then crashes the first time you
  swap parties inside the dungeon. Nobumasa is safe to take — just not as the third and final
  one you add to Vera's side — and picking him last for Vahn's team is fine. In the same
  scene, answer **Yes** when asked to confirm a formation. Answering **No** empties the team
  but leaves the count behind, and that phase can then no longer be completed.

- The mod adds files plus one entry in `plugins.js`; it never rewrites the game's own
  scripts. Choosing **Remove the mod** in the setup program returns the folder to vanilla.

## Install

Obtain the game from:
https://uprc.itch.io/blackmoon-prophecy-remake
It is free.

Then:

1. Extract the game's own download anywhere you like — your Downloads folder is fine.

2. Extract this mod's zip and run **`BlackmoonProphecy-Accessibility-V<version>-Setup.exe`**.
   Everything the mod needs is inside that one program; there is nothing else to unpack
   and nothing to copy into the game folder yourself.

3. Setup finds your game folder on its own. If it doesn't, choose **Browse** and pick it.
   You can point it at either the folder that holds `Game.exe`, or the folder you
   extracted the game into — setup looks inside for you.

4. Choose **Install**, then **Finish**.

5. Launch `Game.exe`.

Because the setup program isn't code-signed, Windows may show a blue **"Windows protected
your PC"** box the first time. Choose **More info**, then **Run anyway**.

The screen-reader bridge — `Tolk.dll` and `nvdaControllerClient64.dll` (64-bit) — is
**included** and installed into `www\mod\` for you; you don't need to supply your own. If
those files are ever missing, the mod falls back to the browser's built-in speech.

Setup also writes `Blackmoon-Accessibility-ReadMe.txt` (this document) next to `Game.exe`,
so the key list is always to hand.

### Manual installation (optional)

If you'd rather place the files yourself, the same zip contains a **`Manual install`**
folder holding just the mod's files, already arranged the way they sit in the game folder:

```
www\js\plugins\BMA_Accessibility.js
www\mod\bma_tts.node
www\mod\Tolk.dll
www\mod\nvdaControllerClient64.dll
www\mod\audio\*.wav   (7 files)
```

1. Copy the **contents** of the `Manual install` folder into the game's root folder — the
   one containing `Game.exe` — so its `www` folder merges with the game's.

2. **Edit `www\js\plugins.js`. This step is required; the mod does nothing without it.**
   Open it in a plain-text editor. The file ends with a list that looks like this:

   ```
   {"name":"SomeOtherPlugin","status":true,"description":"...","parameters":{}}
   ];
   ```

   Put a comma after that last entry, then add **this exact line** on its own, directly
   above the `];`:

   ```
   {"name":"BMA_Accessibility","status":true,"description":"Blackmoon accessibility mod","parameters":{}}
   ```

   So the end of the file becomes:

   ```
   {"name":"SomeOtherPlugin","status":true,"description":"...","parameters":{}},
   {"name":"BMA_Accessibility","status":true,"description":"Blackmoon accessibility mod","parameters":{}}
   ];
   ```

   Save it as UTF-8. Keep this entry **last** in the list, so the mod's hooks wrap every
   other plugin. Back up `plugins.js` first if you want an easy way back.

3. Launch `Game.exe`.

To undo a manual install, delete the files listed above and remove that line (and the
comma you added) from `plugins.js`.

That still leaves the mod's settings, which it stores as one entry inside the game's own
`www\save\config.rpgsave` rather than in a file of its own. That file is compressed, not
plain text, so a text editor shows only gibberish and you can't pick that one entry out of
it by hand. Two ways to deal with it:

- **Run the setup program and choose Remove the mod**, with the settings box ticked. It
  takes out only the mod's entry and leaves your game settings alone. This works even if
  you installed manually, and even if you've already deleted the mod's files yourself.
- **Or delete `www\save\config.rpgsave`.** Nothing stops you — but that file also holds
  *your* game settings, so you'd lose your volume, window size and the rest along with the
  mod's. The game writes a fresh one with defaults next time it starts. Your saved games
  are separate files and are not affected.

## Uninstall

Run the same setup program again and choose **Remove the mod**. It restores your original
`plugins.js` and deletes the mod's files, including the bundled DLLs.

Two things would otherwise outlive the mod, so each gets its own tick box on the last page.
Both start unticked, and nothing of yours is removed unless you ask for it:

- **Your saved waypoints and custom entity labels** — the files the mod keeps in `www\mod\`.
- **The mod's settings** — speech and sound volumes, nav keyset, every toggle, and any
  custom key bindings. These live inside the game's own settings file, so only the mod's
  own entry is taken out; your game volume, window size and other RPG Maker settings are
  left exactly as they were.

Tick both to leave nothing of the mod behind. Leave them alone and a later reinstall picks
up exactly where you left off.

## Keys

### Game (base controls)

Standard RPG Maker MV controls, unchanged by the mod:

- Arrow keys: move on the field, move the cursor in menus.
- Enter, Space, or Z: confirm / talk / examine.
- Escape, X, or Numpad 0: cancel, and open the main menu on the field.
- Shift (hold): dash.
- Page Up / Page Down (or Q / W): cycle party member / page in menus.

### Mod — field navigation

There are three navigation keysets. Only one is live at a time; switch with **Nav keyset**
in the F8 mod menu. Everything under "Both keysets also share" works in all three. Each set
has the same six actions — previous / next destination, announce the current selection,
directions to it, previous / next category, toggle the path filter, label the entity, and
reset the category to All.

Left-handed (default):

- `A` / `D`: previous / next destination.
- `S`: announce the current selection.
- `F`: directions to the selected destination (with the beacon on, re-announces the target
  and re-arms the beacon toward it).
- `Shift+A` / `Shift+D`: previous / next category.
- `Shift+F`: toggle the path filter.
- `Ctrl+F`: label the selected entity.
- `Shift+S`: reset category to All.

Classic:

- `J` / `L`: previous / next destination.
- `K`: announce the current selection.
- `P`: directions to the selected destination.
- `Shift+J` / `Shift+L`: previous / next category.
- `Shift+P`: toggle the path filter.
- `Ctrl+P`: label the selected entity.
- `Shift+K`: reset category to All.

Alternative:

- `[` / `]`: previous / next destination.
- `P`: announce the current selection.
- `\`: directions to the selected destination.
- `Shift+[` / `Shift+]`: previous / next category.
- `Shift+\`: toggle the path filter.
- `Ctrl+\`: label the selected entity.
- `Shift+P`: reset category to All.

The path filter shows only reachable destinations. The labeller prompts you to type a
custom name for the selected entity (blank clears it); it persists and overrides the
automatic numbering.

**Levers and bridges.** A few dungeons — Etherdepths and the Elemental Abyss most of all —
are built around levers that put a walkway across a gap somewhere else on the map. Pull one
and the mod says **"Bridge open"** or **"Bridge closed"** along with how far away it is and
in which direction, because the bridge itself is usually off screen and the game gives no
other sign. Every one of these levers toggles, so pulling the same one twice takes the
walkway back out — which is what the "closed" message is there to catch. Levers appear in
the **objects** category as "Lever 1", "Lever 2" and so on.

Directions work through them. Select somewhere on the far side of the dungeon and the answer
names the **missing bridge** in your way and which lever puts it down — "Missing bridge is in
the way, 28 steps south. It opens from Lever 2, 29 steps southeast." Pull that lever and ask
again and it moves on to the next one, so you can steer by the objective rather than having
to know the puzzle in advance. When a bridge is out there is no turn-by-turn route offered,
because there is no way round it; the lever is the route.

**Blocks you push.** Three dungeons put something heavy in the corridor and expect you to
shove it out of the way: Torian Grotto's stone blocks, Eagle's Cradle's giant shells and
Mythril Mine's mine carts. They appear in the **objects** category — as "Block 1", "Block 2"
and so on, or "Minecart 1" in the mine — and you move one by standing next to it, facing it
and pressing the action button. It slides one tile in the direction you are facing, so which
way it goes is which way you stand.

Ask about one and you are told which ways it will actually go: "Face it and press the action
button to push it. It will only move north or south." A block in a one-tile corridor has two
open sides at most, and shoving it at a wall plays the same sound as a shove that worked, so
this is the part there is otherwise no way to find out. When a block has been wedged in
completely you hear "It has nowhere left to go" instead.

Directions work through them the same way bridges do — "Block 16 is in the way, 1 step west"
— and because a block can be pushed into the mouth of the passage it was blocking, the answer
also tells you how to undo that. Torian Grotto and Eagle's Cradle both have tiles that put
their blocks back where they started, and the hint names the one that resets **that** block —
which in Eagle's Cradle is rarely the nearest, because each of its four block rooms has its
own. In Torian Grotto they are the two passages into the puzzle, already in your doors list;
in Eagle's Cradle they are bare floor, so they are listed as "Block reset 1" and so on and you
can pick one and be routed to it. Mythril Mine has no reset at all — its carts stay wherever
you leave them.

**Statues, buttons and the plaques that tell you the answer.** Some late dungeons are a
riddle rather than a corridor, and the answer is always written down somewhere on the map —
carved into a wall, with nothing standing on the tile. Those carvings are now in the
**objects** category, listed by their opening words, so you can find one and be routed to it:

- **Osteinchyl** is three statues that rotate. Each is listed by what it is — "Knight
  statue", "Mage statue", "Bird statue" — and tells you which of four symbols it currently
  faces when you use it. Beside each is a "Switch" to pull once it faces the right one. The
  three plaques that say which symbol that is are scattered down the map: "The Knight of the
  West stands guard when the moon rises", and two more like it.
- **The Inner** is three buttons named for Odin's children, to be pressed in the order given
  by a plaque near the entrance. Press them out of order and you get a fight instead.

**Sockets and braziers.** Several maps want an item put into something rather than taken out
of one — South Map's eight braziers each want an Oil Cannister, the Floating Ruins' five
impressions each want a Cyclone Core, and there are a few more. They are in the **objects**
category under the game's own word for them ("Brazier 3", "Impression 5"), and no longer sit
in the treasure list pretending to be chests.

**Tiles that throw you.** Everlasting Tangle, the Temple of Visions and four other maps have
invisible tiles that fling you several squares the moment you step on one. They are listed as
crossings, and directions route through them — so a chest on the far side of a gap is
reachable rather than reported as unreachable. The mod treats the tile itself as somewhere you
cannot stand, because you cannot: stepping on it is the same as using it.

**Cleft of Wind.** Doorways change destination after you cross an approach marker. The
markers are listed under **Objects** as upper, lower, left, or right route markers. If a route
ends at a marker, step onto it and ask for directions again to use the new door layout.

**Infinitarium.** Choose **Infinitarium passage** under **Exits** to find the way out of the
current room. Ask for directions again after arriving. The game chooses the next room when
you step onto the passage.

**Maps that take the direction keys off you.** Two places in the game change what walking
means, and neither says so on screen:

- In the **Forest** you are carried west continuously and the east key does nothing. You
  steer with north and south only.
- Swimming up from **Gygas Arena** into **Gozmodan's Grotto**, south cannot be walked at all
  and the south key moves you north.

The mod says which one is in force as you arrive and says "Normal movement restored" when it
ends. Directions use the movement available in the current mode and repeat the restriction.

**Ground that changes under you.** Crescent Rivulet raises and lowers a bridge as you cross
certain tiles, by changing the map rather than by moving anything on it. You hear "A way has
opened" or "A way has closed" with a bearing, and any route you ask for afterwards is worked
out from the map as it now is.

**Something moving is in the way.** Some caves have things that patrol back and forth across
a corridor. They have no name anywhere in the game data, so when one blocks a route the answer
is "Something moving is in the way" — the point being that there is no switch to find and
nothing to do but wait for it to pass.

All three keysets also share:

- `` ` `` (backtick): rescan the current map.
- `M`: announce map name, position, and facing.
- `G`: announce total gil (field and shops only).
- `R`: re-read the on-screen text panel (dialogue, message, item / pop-up body); silent when
  nothing is showing.
- `'` (apostrophe): toggle footstep sounds.
- `;` (semicolon): toggle wall tones.
- `F6`: toggle the target beacon.

### Mod — waypoints (your own saved spots)

- `,` / `.`: previous / next waypoint.
- `/` (slash): directions to the current waypoint.
- `Shift+/`: add a waypoint at your position (prompts for a name).

### Mod — battle

- `H`: read the active character's vitals (name, HP, MP, status).

### Mod — status screen

The status screen is a browsable list of statistics. It opens on the first one; the arrow
keys walk it. Grouped as: Character, Vitals, Parameters, Extra, Equipment, Profile.

- Up / Down: previous / next statistic.
- `Shift+Up` / `Shift+Down`: previous / next group (speaks the group name).
- `Ctrl+Up` / `Ctrl+Down`: first / last statistic.
- `K` or `P`: repeat the current statistic.
- `Q` / `W`: previous / next party member.

`Q` and `W` also change party member on the equipment and skill screens, and the mod
announces whose screen you are now on.

### Mod — menus

- `I`: read detail of the highlighted item / setting. On the party screen this opens the
  browsable statistics for the highlighted character.
- `U`: read which classes can equip the highlighted gear.
- `F7`: toggle autodetail (auto-read detail on each move).
- `Shift+V`: enter review mode; arrow keys browse the text block, Escape exits (use on the
  quest log, status, and long text).
- `F8`: open the mod menu (volumes and all toggles).

On the naming screen — where you name the black chocobo, and one character later on — the
letter under the cursor is spoken as you move across the grid, with capitals called out as
"capital B" so they can be told from lowercase, and punctuation given its name. The two
command squares announce themselves as "Page, switch character set" and "OK, finish", and
`Shift` jumps straight to OK. Each letter is read back as it goes in, and deleting says
which one went. `I` reads the whole name so far and then spells it out.


## The F8 mod menu

Opens with `F8`. Holds the per-sound and speech volumes plus every toggle:

- **Nav keyset** — classic or bracket (see field navigation above).
- **Menu item numbers** — the "3 of 12" position readout.
- **Announce map on entry** — speak the map name when you arrive somewhere new.
- **Airship landing cue** — while flying, says "Can land" or "Can not land" as the ground below
  changes. See below.
- **Perf logging** — writes timing for the mod's own work to `www\mod\bma_log.txt`.
- **Speech log** — writes a transcript of everything spoken to the same file.

Both logs are **on by default** and the file is cleared each launch, so a problem you hit is
already recorded and the log is worth sending as-is. Turn them off if you would rather not
keep a transcript; with them off the file holds only the startup lines, which cannot show
what went wrong.

## Flying the airship

The airship passes over everything, so none of the usual movement cues apply in it — nothing
blocks, and no wall tone ever sounds. The one thing that changes as you fly is whether the ground
below is somewhere you could actually set down, and there is no sound for it in the game.

With **Airship landing cue** on (the default), the mod speaks **"Can land"** when you move over
ground the ship can be put down on and **"Can not land"** when you leave it. Nothing is spoken
while the answer stays the same, and nothing is spoken as you take off — that first tile is one
you landed on yourself.

It is the game's own rule, so it accounts for things that are easy to miss: a tile has to be
flagged for landing *and* be open on all four sides, and it must have nothing standing on it —
which is why you cannot come down directly on a town, a cave mouth or a signpost even though the
ground all around them is clear.

Crossing a ragged coastline flips the answer every step or two. Rather than read out every flip,
the mod waits for it to settle, so flying along a shore tells you once it has committed to a side.
