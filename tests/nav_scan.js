// Load the real src/*.js against stubbed MV globals and run BMA.Nav.scan() over every map
// in the game. This exercises the shipping classify/entityName/MapNames code, not a copy.
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const { SRC, DATA, MOD, requireGame } = require('./_paths');
requireGame('nav_scan.js');

// ---- minimal MV stubs ----
global.window = global;
global.document = { addEventListener() {} };
global.require = require;
global.performance = { now: () => Number(process.hrtime.bigint() / 1000n) / 1000 };

global.$dataMapInfos = JSON.parse(fs.readFileSync(path.join(DATA, 'MapInfos.json'), 'utf8'));
global.$dataActors   = JSON.parse(fs.readFileSync(path.join(DATA, 'Actors.json'), 'utf8'));
// classify() reads through a lone Common Event call to the event it delegates to, so the chests
// that keep their gold and items in one are seen as chests. Without this global they read as
// anonymous objects again and the census below moves by 140.
global.$dataCommonEvents = JSON.parse(fs.readFileSync(path.join(DATA, 'CommonEvents.json'), 'utf8'));
// A trap that inflicts a state is named after the state, so _trapOf needs the state table to
// recognise one at all. Without this global Thunder Mountain Inner's 138 poison/blind/silence
// tiles are not traps, and — since they are drawn and touch-triggered — they land in
// 'interactable' instead, moving the census by 138 in two categories at once.
global.$dataStates = JSON.parse(fs.readFileSync(path.join(DATA, 'States.json'), 'utf8'));
global.$gameVariables = { value: () => 0 };
global.$gameActors = { actor: () => null };
global.$gameParty = { members: () => [] };
global.$gamePlayer = { x: 0, y: 0, direction: () => 2 };

let curMap = null, curId = 0;
global.$gameMap = {
  mapId: () => curId,
  displayName: () => (curMap && curMap.displayName) || '',
  width: () => (curMap && curMap.width) || 0,
  height: () => (curMap && curMap.height) || 0,
  // Which tile is a chest is a tileset property — classify() consults it to tell a mimic from
  // any other tile-drawn ambush.
  tilesetId: () => (curMap && curMap.tilesetId) || 0,
  events: () => curEvents,
};
let curEvents = [];

// ---- load the mod ----
for (const f of ['BMA_Core.js', 'BMA_Text.js', 'BMA_Menus.js', 'BMA_Nav.js']) {
  vm.runInThisContext(fs.readFileSync(path.join(SRC, f), 'utf8'), { filename: f });
}
BMA.TTS.modDir = MOD;    // lets BMA.MapNames find www/data

// ---- drive it over every map ----
function loadMap(id) {
  const num = String(id).padStart(3, '0');
  const f = path.join(DATA, `Map${num}.json`);
  return fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, 'utf8')) : null;
}

const tally = {};
const nameSource = { kind: 0, speaker: 0, eventName: 0, numbered: 0 };
const samples = {};
const doorsLeavingMap = [];
const pushBlocks = [];
const resetTiles = [];
const chestyNames = [];
const shellyNames = [];
const wanted = new Set([3, 7, 20, 24]);
let totalEntities = 0;

const t0 = Date.now();
for (let id = 1; id < $dataMapInfos.length; id++) {
  const m = loadMap(id);
  if (!m || !m.events) continue;
  curId = id; curMap = m;
  // eventId() and _pageIndex are NOT optional: scan() reads both to key its _seen map for the
  // delta scan, and scan() swallows the resulting TypeError into `this.entities = []`. Without
  // them this test silently measured nothing while still reporting success.
  curEvents = m.events.filter(Boolean).map(ev => ({
    _erased: false, x: ev.x, y: ev.y, _x: ev.x, _y: ev.y, _pageIndex: 0,
    eventId: () => ev.id,
    page: () => ev.pages[0],
    event: () => ev,
  }));
  BMA.Nav.scan();
  for (const e of BMA.Nav.entities) {
    totalEntities++;
    tally[e.category] = (tally[e.category] || 0) + 1;
    // The invariant behind the door/exit split, asserted directly rather than only through the
    // census: "door" means a doorway ON this map. Anything that carries the player off it belongs
    // in the exits list, which is where somebody looks for the way on. Read across every page,
    // because a closed door's Transfer lives on the page a switch elsewhere turns on — that is
    // exactly the case that used to slip through.
    if (e.category === 'door') {
      const raw = e.ev && e.ev.event && e.ev.event();
      const leaves = ((raw && raw.pages) || []).some(pg => (pg.list || []).some(
        c => c.code === 201 && c.parameters[0] === 0 && c.parameters[1] !== id));
      if (leaves) doorsLeavingMap.push(`map${id} ev${raw.id} "${e.name}" at ${e.x},${e.y}`);
    }
    if (e.push) pushBlocks.push(`map${id} ev${e.ev.eventId()} "${e.name}" at ${e.x},${e.y}`);
    if (e.resets) resetTiles.push(`map${id} ev${e.ev.eventId()} "${e.name}" restores ${e.resets.length}`);
    // "Chest1" and "Chest 1" on one map is the shape of the Torian Grotto report: an editor name
    // that collides with the numbering of a real category, differing only by a space. Nothing in
    // the game should reach a player under a name like that.
    if (/^Chest\d/.test(e.name)) chestyNames.push(`map${id} ev${e.ev.eventId()} "${e.name}"`);
    if (/^Shell\d/.test(e.name)) shellyNames.push(`map${id} ev${e.ev.eventId()} "${e.name}"`);
    if (e.kind) nameSource.kind++;
    else if (/ \d+$/.test(e.name) && /^(NPC|Chest|Object|Enemy|Exit|Shop|Save point)/.test(e.name)) nameSource.numbered++;
    else nameSource.speaker++;   // refined below by the dedicated npc pass
  }
  if (wanted.has(id)) {
    samples[id] = BMA.Nav.entities.map(e => `${e.category.padEnd(13)} ${String(e.x + ',' + e.y).padEnd(8)} ${e.name}`);
  }
}
console.log(`scanned ${totalEntities} entities across all maps in ${Date.now() - t0} ms`);
console.log('by category:', tally);
console.log('named by kind (exit/shop/save):', nameSource.kind,
            '| numbered fallback:', nameSource.numbered,
            '| from speaker or event name:', nameSource.speaker);

for (const id of [7, 3, 20]) {
  console.log(`\n=== Map ${id} — ${BMA.MapNames.get(id)} ===`);
  (samples[id] || []).forEach(s => console.log('  ' + s));
}

// ---- the scan itself ----
//
// A snapshot of classify()'s verdict over the whole game, asserted exactly rather than as a
// tolerance band: these are fixed data files, so any movement is a real change in
// classification and is worth looking at deliberately. Update the numbers when you mean to
// change classify() — and re-verify them if the game itself is ever patched past 1.05S.
console.log('\n=== scan totals ===');
let fails = 0;
const check = (name, cond, extra) => {
  if (cond) console.log('  ok   ' + name);
  else { fails++; console.log('  FAIL ' + name + (extra !== undefined ? '  -> ' + extra : '')); }
};

// The obvious failure mode is measuring nothing: scan() swallows a stub mismatch into an empty
// entity list, which is exactly how this test sat broken while still exiting 0.
check('the scan actually ran', totalEntities > 0, totalEntities);

// A census of every classifiable event in the game. It is a fixture, so it moves when the game
// data moves or when classify() changes its mind — both of which happened at once:
//
//   the 1.09 content patch      exit +2, npc +1, treasure +15, shop +2
//   'portal' and 'crossing'     interactable 351 -> 320, npc 1852 -> 1809, and 189 ways across
//                               a map where there were none: 84 portals (a transfer landing
//                               back on the same map) and 105 crossings (a move route that
//                               carries the player over ground they cannot walk)
//
// The 43 that came out of npc are events that talk before they ferry you — Conall Curach's two
// moogles are the shape. The portal test sits directly above the npc test and nowhere higher:
// promoting transfers ahead of treasure and enemy as well took 9 bosses and a chest out of the
// lists a player looks for them in.
//
// Of the 105 crossings, only 31 came out of interactable. The other 74 were events classify()
// used to discard outright — a jump route with no graphic matched nothing and fell off the end
// — which is the same blindness that made Conall Curach unnavigable.
//
// 105 and not the 240 an earlier pass produced: a crossing has to turn Through on in its route.
// Without that test every cutscene that nudges the player counted as a way across the map.
//
//   'trap'                      186 damage-on-touch tiles, and not one of them came out of
//                               another category — every other count above is unchanged. They
//                               were being discarded outright: they carry no dialogue, reward
//                               or transfer, so classify() fell through to its last test, which
//                               requires the action button, and a tile you walk onto never has
//                               it. They sit on three maps — Naddaha Pyramid 54 (400-500 to the
//                               whole party), Aether Mine 92 (MP drain, and no graphic at all)
//                               and Forest 43 — and routes were being spoken across them.
//   ambushes out of 'enemy'       enemy 529 -> 480, interactable 320 -> 369. 49 events that run
//                                 a battle off the action button while showing a tileset tile:
//                                 sarcophagi, switches, keypads, and the chests the game itself
//                                 labels "Monster-in-a-box!". None of them is a visible monster
//                                 — each is a single tile that switches to tileId 0 once the
//                                 fight is won — so a sighted player gets no warning either, and
//                                 listing them under enemies was a spoiler rather than an
//                                 accessibility gain. The four bosses among them (Ymir,
//                                 Phunbaba, Yemaja, Dreamweaver) speak from inside the page the
//                                 action button runs, so they are no more on show than the rest.
//                                 A monster genuinely standing on the map has a character
//                                 sprite, and all 480 of those stayed put.
//   mimics into 'treasure'        treasure 2079 -> 2108, interactable 369 -> 340. 29 of those 49
//                                 ambushes are drawn with the tile their map (or their tileset)
//                                 uses for real chests, and the game shouts "Monster-in-a-box!"
//                                 at exactly the 31 that are meant to be mimics. They are filed
//                                 as chests and share the chests' numbering, because an "Object"
//                                 sitting among the chests, or a category of its own, would give
//                                 the surprise away by elimination just as surely as the enemies
//                                 list did.
//   exits split, portal retired   exit 4159 -> 3409, door 0 -> 750, crossing 105 -> 189, and
//                                 'portal' is gone. "Exits" was answering two questions at once:
//                                 3,409 ways off this map, and 750 doorways on it — 690 that
//                                 carry you across and 60 still shut. Asking where you can leave
//                                 from should not read out the other 750 first.
//
//                                 The old 'portal' category held both of those doorways and
//                                 Conall Curach's two talking moogles, which are not the same
//                                 thing: the moogles are movers, so they are crossings now,
//                                 routed through and named but never cycled to. Nothing was
//                                 gained or lost — 4159+84 = 3409+750+84.
//   common events resolved     treasure 2108 -> 2248, interactable 340 -> 200, and nothing else
//                              moved at all. 140 chests keep their gold and items inside a called
//                              common event — "Infinitarium Chests" and "Miasma Stream Chest 1",
//                              named exactly that by the editor — so their own pages hold nothing
//                              but a variable, a switch and the call. Every reward test here
//                              looked at the page and found nothing, and all 140 came out as
//                              "Object N" in the objects list rather than with the chests a
//                              player goes looking for. classify() now reads through a page whose
//                              only act is a single common event call and treats that event's
//                              commands as the page's own.
//
//                              Narrow on purpose: exactly one call and no behaviour of its own.
//                              An event that talks *and* calls a common event is doing something
//                              itself and is left alone — which is why the other eight categories
//                              are untouched to the entity.
//   props off the people sheet  npc 1809 -> 1797, enemy 480 -> 468, interactable 200 -> 224, and
//                               nothing else moved. 24 events, all one frame of one sheet: BPR_008
//                               is Hunter, Nurse, Pirate, Taol, Dion, Hans and a second Pirate,
//                               and frame 4 is a glowing rune. MV has one notion of "drawn with a
//                               character sheet" and the mod reads it as "a person is standing
//                               here", so Gulgur Volcano's five sealing glyphs were people (all
//                               five called "Elina", after the party member whose line dispels
//                               them), the twelve that fight when touched were enemies, and Life
//                               Shrine's clock centre and the five Aether Crystal Shards were
//                               "NPC 1".
//
//                               The twelve leaving 'enemy' is the sarcophagus rule again: the
//                               armed glyphs are drawn exactly like the harmless ones and no map
//                               in the game holds both kinds, so an enemies entry was a warning
//                               no sighted player gets. The sheet is named in PROP_SPRITES and
//                               nothing else in the game uses that frame.
//   scripted scenes            treasure 2248 -> 2129, enemy 468 -> 434, and a new 'event' with
//                              the 153 between them. Nothing is drawn on the tile, it talks when
//                              you walk onto it, and the scene ends in a fight or a reward — so
//                              it was filed as whatever its last line happened to do. Aether
//                              Mine's (140,79) is the party working out what Atomos is, and the
//                              item at the end made it a chest; the rest end in a fight, so they
//                              were enemies standing in an empty corridor.
//
//                              153 here against 35 in a live game, and the gap is this fixture
//                              rather than the rule: it reads page 0 for determinism, and 118 of
//                              the 153 have a switch on page 0 that a real save has not set yet.
//
//                              The "ends in a fight or a reward" clause is what keeps this to
//                              events already being listed somewhere. Without it the rule also
//                              takes 129 that classify has always dropped, among them the 23
//                              MogNet GPS signposts on each Overworld — invisible tiles that read
//                              out the nearest town as you pass, which the dialogue layer already
//                              speaks and which nobody needs a route to.
//   traps that change a state  trap 186 -> 328, and nothing moved out of another category —
//                              all 142 were being dropped by classify() altogether. A trap was
//                              only ever a tile that took HP or MP off you, so Thunder Mountain
//                              Inner's floor of 138 (Poison 50, Blind 48, Silence 40) and the
//                              four on Archareon Rise were invisible, and routes were spoken
//                              straight over them without a word.
//
//                              Add only. The same command with Remove is a cure tile, which is
//                              the opposite thing, and there are some of those.
//
//                              The Archareon Rise four are named "inflicts Archareon Rise",
//                              which reads oddly and is correct: state 68 is a real five-turn
//                              silence that seals ten skill types, and the game named it after
//                              the area rather than the ailment. The name is read off the data
//                              like every other name here rather than guessed at from its
//                              battle message.
//   pads you step on           interactable 224 -> 246, and nothing else moved. classify()'s
//                              last test accepted the action button only, so anything drawn on
//                              the map that fires by being STOOD on fell off the end.
//
//                              Archareon Prison is why it matters: its four pressure pads are
//                              the whole objective of the map — step on all four and the barrier
//                              holding Lord Adder comes down — and not one of them appeared in
//                              any list. Esto Yensa's twelve switches are the same shape; the
//                              remaining six are single events on five other maps.
//
//                              This had to wait for the trap rule above. Widening it first would
//                              have swept Thunder Mountain's 138 damage tiles into Objects, which
//                              turns a list of hazards into a list of places worth walking to.
//   invisible doorways         exit 3409 -> 3425, and nothing moved out of another category —
//                              all 16 were dropped entirely. "Anything that also talks is an NPC
//                              who happens to move you" needs somebody to be standing there, and
//                              on an invisible tile nobody is: it IS the doorway, however much it
//                              narrates. **The only way out of Archareon Prison is one of these**
//                              — a touch tile that asks "Return to Branch Castle?" — as are the
//                              two tiles in Branch Castle that are the way in, so both ends of
//                              that trip were invisible and the prison answered "Exits: none"
//                              while the player stood in it.
//
//                              It has to LEAVE the map, and that clause is the whole rule. Drop
//                              it and 53 more arrive, every one a cutscene that repositions the
//                              player mid-scene: Rift Shrine's 39-line Ramuh scene shunts you
//                              four tiles north partway through, and Laka's house and King
//                              Doran's throne room do the same. Those were already being caught
//                              as crossings, which are hidden from "all" — promoting them to
//                              doors put "Door 1" in rooms that have no door.
//   arena and casino counters  shop 271 -> 287, and it comes from three places at once: 8 slot
//                              machines that were in no category at all, 7 casino desks out of
//                              'npc' (1797 -> 1790), and the arena's match desk out of 'crossing'
//                              (189 -> 188). Total moves by the 8 that were being dropped.
//
//                              The arena desk is the one that mattered. Dalton runs the Gygas
//                              Arena's matches, and his script ends by transferring you back to
//                              the tile in front of him — a same-map transfer, which the portal
//                              test files as a crossing, and crossings are hidden from "all" and
//                              from the NPC list. The only thing on that map you have to use was
//                              in no list a player can reach.
//
//                              Exactly 16 events in the whole game meet the rule and all 16 are
//                              these. The portal test is not narrowed to make room for them: the
//                              188 crossings left are the moogle ferries and the cutscene tiles
//                              that reposition you, and this census is what pins that.
//   dropped items              npc 1790 -> 1493, treasure 2129 -> 2426, and nothing else moved.
//                              297 events hand over goods off a character sprite and then erase
//                              themselves — 255 of them one frame of BPR_V, which is also the
//                              save crystal, so the art proves nothing. They are the game's
//                              dropped loot ("An item was dropped here!" then "Obtained Mega
//                              Potion!"), and "a sprite that talks and pays out is an NPC who
//                              gives you a gift" took every one: each Overworld read out around
//                              fifty "NPC 1..57" that are not people and are not where anybody
//                              is, while the loot was in no list a player looks for loot in.
//
//                              CONSUMED is the whole rule. A gift-giver is still standing there
//                              afterwards; these switch to a page with no graphic and no commands
//                              at all, gated on the very switch the payout turned on. Three
//                              clauses keep the people out and each is a real population: nobody
//                              speaks (Brindle charges 10,000 gil, the Lindblum soldier hands
//                              over 1,000 — both leave, both have a speaker tag), no battle (the
//                              eight optional dragons drop an item as they die), and not autorun
//                              (Bosche's recruitment scene ends with him joining).
//
//                              They are "Item 3" and not "Chest 3": the same list, because that
//                              is where a player looks for loot, but their own numbering, so a
//                              map's real chests still count 1,2,3 without these interleaving.
//   party management           npc 1493 -> 1505, crossing 188 -> 176, and nothing else moved.
//                              Esto Yensa's forecourt is the party lined up to be split in two,
//                              and picking somebody ends by fading out and dropping you back at
//                              the door. That same-map transfer is the portal test, so all twelve
//                              of the ones you can choose were "Crossing 1..12" — hidden from
//                              "all" AND from the NPC list, which is every list a player would
//                              look in for the people they are being asked to choose between.
//
//                              Same shape as the arena counter, one test higher up: somebody you
//                              walk up to and talk to who adds or removes party members is
//                              managing the roster, and the transfer is the game standing you
//                              back up. Action button only — on an autorun it would also take the
//                              Arcane Library's departure cutscene, which is nobody standing
//                              anywhere; Laka's three recruitment tiles are invisible and were
//                              already excluded by needing a sprite.
//   closed doors that leave    exit 3425 -> 3455, door 750 -> 720, and nothing else moved: all 30
//   the map                    came straight across. A closed door is an inert blocker whose
//                              Transfer only exists on a page some switch elsewhere turns on, and
//                              the test for one asked whether SOME page transfers without ever
//                              asking where to — so a sealed way OFF the map was filed under "what
//                              is shut" and never under "where can I leave from", which is the
//                              list a player checks for the way on. Both of Wind Shrine's sealed
//                              doors are these, both of Naddaha Pyramid's, and Chocobo Stable's
//                              way back out to the Overworld.
//
//                              Destination-in-a-variable does not count. Those cannot be resolved
//                              without running the event, and moving a doorway into the exits list
//                              on a guess is worse than leaving it where it was, so they stay
//                              doors — which is what keeps this to 30 rather than sweeping every
//                              closed door in the game.
//   block-reset tiles          interactable 246 -> 255, and nothing else moved: all 9 were being
//                              dropped by classify() altogether. They are Eagle's Cradle's way
//                              back out of a push puzzle shoved shut — bare floor with nothing
//                              drawn on it, triggered by walking over it, whose whole page is Set
//                              Event Location aimed at that room's blocks. An invisible touch
//                              tile is exactly the shape the mod refuses to list, because the game
//                              has thousands of them and none of the rest is a destination; this
//                              one is the only way to undo a mistake that cannot otherwise be
//                              undone, and with no entry of its own the recovery hint could only
//                              call it "Something" and give a bearing.
//
//                              Nine and not eleven: Torian Grotto's two resets carry a Transfer as
//                              well, so they are settled at the door test long before this one and
//                              stay the doorways they look like. The rule needs a Set Event
//                              Location aimed at an event the map's own data proves is a block, so
//                              it cannot reach a map with no blocks on it.
//   the invisible tail        exit 3455 -> 3465, interactable 255 -> 290, and +26 on the total,
//                             because every one of these was being dropped outright.
//
//                             871 events in this game are an action-button page with no graphic
//                             that does something, and that is not an oddity — it is how nearly
//                             everything in it is built, the picture being in the map's own tiles
//                             rather than on the event. 719 of the 871 are the chests, which the
//                             rewards test has always caught, which is why the graphic requirement
//                             on classify()'s last test went unnoticed for so long. What it
//                             dropped was the tail, and the tail is the endgame's puzzles: the
//                             nine Lunar Crystal carvings that are the only way through Genesis
//                             Obelisk (605), Lunar Crystal (601) and Lunarscape Abyss (614) — all
//                             nine now exits, which is the list a player checks for the way on —
//                             Osteinchyl's three riddle plaques, the plaque and the third button
//                             of The Inner's Odin puzzle, and eight memorial plaques.
//   sockets are not chests    treasure 2426 -> 2407, interactable to 290 by way of them.
//
//                             A Change Items command carries the direction it runs in and nothing
//                             read it, so an event that TOOK an item counted as treasure exactly
//                             as loudly as one that gave it. 19 events only take, and they are
//                             four puzzles: South Map's eight braziers (an Oil Cannister each),
//                             Floating Ruins' five impressions (a Cyclone Core each), Temple of
//                             Visions' two half-moon sockets, and four one-offs. Both halves of
//                             that were wrong — the treasure list sent a player to something that
//                             wanted an item off them, and the thing the map is built around was
//                             never named as anything to go and use.
//   buttons are not enemies   enemy 434 -> 424, event 153 -> 162, and 2 into interactable.
//
//                             Ten invisible action-button and touch tiles that ran a Battle
//                             Processing somewhere inside them. Two are The Inner's Baul and
//                             Haljar buttons, which fight you for pressing them out of order —
//                             "Enemy 1" and "Enemy 3" for two thirds of a puzzle whose remaining
//                             third was dropped. The other eight are story tiles that talk, fight
//                             and shunt the player a few tiles within the same map; they reach the
//                             scripted-scene rule now that it counts a transfer landing back HERE
//                             as the cutscene nudge it is. Same reasoning as the sarcophagi: the
//                             tile is invisible, so a sighted player gets no warning either, and
//                             "Enemy 1" handed a blind one a spoiler instead of a destination.
//   jumps need no Through     crossing 176 -> 199. Through governs walking, and
//                             Game_CharacterBase.jump does not walk — it adds the offset to the
//                             player's coordinates and checks nothing at all. Requiring it lost 23
//                             launchers across six maps: Everlasting Tangle's nine, which fling
//                             the party seven or eight tiles through the undergrowth and are the
//                             only way to six of that map's chests, Temple of Visions' six, and
//                             eight more on Maps (579), Thunder Mountain (97), Inner Lake Map
//                             (496) and Elemental Abyss (580).
const EXPECTED = {
  // Camp return tiles are exits. Seven Cleft of Wind approach markers are objects.
  // Four visible scene actors are NPCs again once autorun stops producing crossings.
  exit: 3518, npc: 1509, treasure: 2407, enemy: 424, event: 162,
  savepoint: 190, shop: 287, interactable: 297, crossing: 195,
  door: 720, trap: 328,
};
for (const [cat, want] of Object.entries(EXPECTED)) {
  check(cat + ' = ' + want, tally[cat] === want, tally[cat]);
}
check('nothing in the doors list leaves its own map',
      doorsLeavingMap.length === 0,
      doorsLeavingMap.length + ': ' + doorsLeavingMap.slice(0, 4).join(' | '));
check('no unexpected category appeared',
  Object.keys(tally).every(c => c in EXPECTED),
  Object.keys(tally).filter(c => !(c in EXPECTED)).join(', '));
check('total is the sum of the categories',
  totalEntities === Object.values(EXPECTED).reduce((a, b) => a + b, 0), totalEntities);

// ---- push blocks ----
//
// Three sliding-block dungeons, not one. Torian Grotto's five stone blocks in one-tile corridors
// gate three of its chests; Eagle's Cradle has eighteen giant shells across four rooms, standing
// in the way of six of its thirteen chests; Mythril Mine has forty-six mine carts over two maps.
//
// This test asserted five for as long as the rule missed sixty-four of them, and the miss was one
// command wide: every block outside Torian Grotto plays a sound as it moves, so its move route is
// two steps long rather than one, and a two-step route was read as a cutscene walking something
// about. The sound is skipped now. That the census was exact is what made the gap visible the
// moment it closed — the number went from 5 to 69 in one run, with the maps named.
//
// The count stays exact on purpose. _pushDirs matches "if the player is facing D, move me one step
// D" and nothing else; if a content patch or a looser rule ever adds a fifth map, that is a new
// mechanism somewhere and worth reading before it ships.
console.log('\n=== push blocks ===');
pushBlocks.forEach(p => console.log('  ' + p));
const byMap = id => pushBlocks.filter(p => p.startsWith(`map${id} `));
check('sixty-nine push blocks in the game', pushBlocks.length === 69, pushBlocks.length);
check('five in Torian Grotto (436)', byMap(436).length === 5, byMap(436).length);
check('eighteen in Eagle\'s Cradle (475)', byMap(475).length === 18, byMap(475).length);
check('forty-six in Mythril Mine (487 + 488)',
      byMap(487).length === 4 && byMap(488).length === 42,
      byMap(487).length + ' + ' + byMap(488).length);
check('and no fifth map has any',
      pushBlocks.every(p => /^map(436|475|487|488) /.test(p)),
      pushBlocks.filter(p => !/^map(436|475|487|488) /.test(p)).join(' | '));

// Naming. The editor's shorthand goes — "ChestN" because it is wrong on a map with eight real
// chests, "ShellN" because the word appears nowhere in the game's dialogue and says nothing about
// what the thing does — and a name the data really holds stays: the carts are named off the SE
// they play, which is a word for the object and better than the generic one.
check('Torian Grotto\'s five are Block 1..5, not the editor\'s "ChestN"',
      [1, 2, 3, 4, 5].every(n => byMap(436).some(p => p.includes(`"Block ${n}"`))),
      byMap(436).join(' | '));
check('Eagle\'s Cradle\'s eighteen are Block 1..18, not the editor\'s "ShellN"',
      Array.from({ length: 18 }, (_, i) => i + 1)
        .every(n => byMap(475).some(p => p.includes(`"Block ${n}"`))),
      byMap(475).join(' | '));
check('Mythril Mine\'s forty-six keep the name the data gives them',
      byMap(487).concat(byMap(488)).every(p => /"Minecart \d+"/.test(p)),
      byMap(487).concat(byMap(488)).filter(p => !/"Minecart /.test(p)).join(' | '));
check('nothing anywhere is named "ChestN" beside the real "Chest N"',
      chestyNames.length === 0,
      chestyNames.length + ': ' + chestyNames.slice(0, 6).join(' | '));
check('nor "ShellN" beside anything', shellyNames.length === 0,
      shellyNames.length + ': ' + shellyNames.slice(0, 6).join(' | '));

// The tile that puts the blocks back is a destination in its own right, and on Eagle's Cradle it
// is the only kind of destination the mod would otherwise refuse to list: bare floor, nothing
// drawn on it, triggered by walking over it. Nine of them, all on 475 — Torian Grotto's two carry
// a Transfer, so they are the doorways they look like and keep those names.
check('nine block-reset tiles in the game, all on Eagle\'s Cradle',
      resetTiles.length === 9 && resetTiles.every(p => p.startsWith('map475 ')),
      resetTiles.join(' | '));

// The other half of the report: a block that has been shoved changes the map without changing any
// page, so deltaScan's integer page compare cannot see it — and the strict flood is cached on the
// PLAYER's tile, which does not change when they stand still and press the action button. Before
// _pushMoved, pushing a block open and asking again replayed the flood from before the push.
curId = 436; curMap = loadMap(436);
const live436 = {};
curEvents = curMap.events.filter(Boolean).map(ev => {
  const o = { _erased: false, x: ev.x, y: ev.y, _pageIndex: 0,
              eventId: () => ev.id, page: () => ev.pages[0], event: () => ev };
  live436[ev.id] = o;
  return o;
});
BMA.Nav.scan();
BMA.Nav.deltaScan();                                    // seed the block positions
BMA.Nav._floods.strict = { key: 'sentinel' };
BMA.Nav.deltaScan();
check('a pass with nothing moved keeps the flood', BMA.Nav._floods.strict !== null);
live436[21].x -= 1;                                     // shove Block 1 one tile west
BMA.Nav.deltaScan();
check('pushing a block retires the flood', BMA.Nav._floods.strict === null);
BMA.Nav._floods.strict = { key: 'sentinel' };
BMA.Nav.deltaScan();
check('and it is retired once, not on every pass afterwards', BMA.Nav._floods.strict !== null);

// The blocks have no target tile — nothing in the game reads where one ends up — but the corridors
// are one tile wide, so a block can be shoved into the mouth it was there to clear. Recovery is the
// Set Event Location on the two passages that enter the puzzle, and finding those is what lets the
// mod say so. EV004 and EV010 carry five each.
const resets = BMA.Nav.blockResets().map(r => r.ev.eventId()).sort((a, b) => a - b);
console.log('  reset events on 436:', resets.join(', ') || 'none');
check('both entrances are found as block resets', resets.join(',') === '4,10', resets.join(','));
check('and each of them puts all five back',
      BMA.Nav.blockResets().every(r => r.ids.length === 5),
      BMA.Nav.blockResets().map(r => r.ids.length).join(','));
check('a map with no blocks has no resets to offer',
      (curId = 3, curMap = loadMap(3),
       curEvents = curMap.events.filter(Boolean).map(ev => ({
         _erased: false, x: ev.x, y: ev.y, _pageIndex: 0,
         eventId: () => ev.id, page: () => ev.pages[0], event: () => ev })),
       BMA.Nav.scan(), BMA.Nav.blockResets().length === 0));

// ---- joinParts spot checks ----
console.log('\n=== joinParts ===');
const cases = [
  [['Vahn', 'Lv', '1', 'HP', '150', '/', '150', 'MP', '18', '/', '18'], 'Vahn Lv 1 HP 150/150 MP 18/18'],
  [['Lv.', '12'], 'Lv 12'],
  [['Potion', '50 Gil', 'have 3'], 'Potion 50 Gil have 3'],
  [['Always Dash', 'ON'], 'Always Dash ON'],
];
for (const [input, want] of cases) {
  const got = BMA.Util.joinParts(input);
  check(JSON.stringify(input.slice(0, 2)) + '...', got === want, JSON.stringify(got));
}

console.log(fails ? `\n${fails} CHECK(S) FAILED` : '\nall checks passed');
process.exit(fails ? 1 : 0);
