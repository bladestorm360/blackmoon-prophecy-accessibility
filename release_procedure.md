# Release Procedure

Triggered when the user says **"prepare release X"** — e.g. `prepare release 1.0`,
`prepare release 1.1`, `prepare release 1.0.1`. Substitute `<version>` for the user's
number throughout.

This procedure builds a local versioned `.zip` and tags the source commit locally.
The public GitHub repository tracks source on `main`. Publishing the zip is a separate action.

## Inputs

- `<version>` — bare version string, no leading `V` (e.g. `1.0`, `1.0.1`). May carry a
  channel suffix (e.g. `0.5.3-test-build`); a space in the request ("prepare release 0.5.3
  test build") becomes a hyphen in the slug so it is legal in a tag and a filename.
- **The pre-release channel is called a "test build," never a "beta."** That is the
  terminology the user publishes under on their modding Patreon, so it is the word backers
  recognise. Use `-test-build` — lowercase, hyphenated — in the version, the tag, the
  directory and zip names, and the changelog prose. Never write "beta" anywhere, and never
  substitute it when the user says "test build." V0.5 through V0.5.2 were tagged `-beta` by
  mistake and had to be renamed after they had already shipped.
- Tag name is always `V<version>` (capital V), matching the ff1-screen-reader convention.
- Branch is `master` (not `main`).
- **A test build uses this exact same procedure as a stable release** — same build, same
  packaging, same tag form. There is no separate pre-release flow; the `-test-build` suffix
  is the only difference.

## Preconditions

1. Working tree is clean: `git status --porcelain` returns empty. If dirty, **stop and
   report** — the user must commit (or stash) first; release artifacts must come from a
   committed state. (Exception: the ReadMe/README regeneration in step 2 may itself create
   a change to commit — do that commit first, then re-check clean.)
2. HEAD is the commit being released. Do not tag mid-feature; if recent work isn't meant to
   ship, ask before tagging.
3. `Releases\V<version>\` does not already exist, and neither does
   `Releases\BlackmoonProphecy-Accessibility-V<version>.zip`. If either does, **stop and
   report** — never silently overwrite a prior release directory or archive.
4. The prebuilt native addon `native\bma_tts\build\Release\bma_tts.node` exists. If it does
   not, build it once (step 0). Without it the patch still ships and falls back to the
   browser's built-in Web Speech, but a real release should carry the in-process Tolk addon.
5. The bundled screen-reader DLLs `redist\Tolk.dll` and `redist\nvdaControllerClient64.dll`
   exist (both 64-bit). `build.ps1` copies them into the payload, from where the installer
   deploys them into `www\mod\`. If either is missing, `build.ps1` warns and the mod falls
   back to Web Speech — restore them before shipping a real release.

## Steps

### 0. (One-time / only if missing) Build the native addon

Only needed the first time, or after `native\bma_tts\*.cc` or `binding.gyp` changes. If
`bma_tts.node` is already present, skip this.

```
powershell.exe -Command "& 'D:\Games\Dev\BlackmoonProphecy\native\build.bat'"
```

`native\build.bat` documents the `nw-gyp` path; the working route on this machine is
`node-gyp` capped at `NAPI_VERSION=7` (see `docs\DEVELOPMENT.md`). Output lands at
`native\bma_tts\build\Release\bma_tts.node`. If the build fails, stop — do not ship a
release missing the addon without the user's OK.

### 1. Check the readme

`ReadMe.md` (repo root) is the **only readme that is ever committed**. `build.ps1`
regenerates the shipped plain-text copy into `obj\ReadMe.txt` on every build, via
`tools\readme-to-txt.ps1`, and ships it from there. That file is build output — it is
gitignored, never checked in, and never hand-edited, so it cannot drift from the master.

So this step is just: make sure `ReadMe.md` itself is current. In particular the Install
section, which covers both the setup program and the manual route including the exact
`plugins.js` line a hand-installer must paste.

The generator folds smart typography down to ASCII and then **fails the build** if any
non-ASCII character survived. That guard exists because a stray em-dash in a string literal
is precisely what broke the V0.5 installer.

### 2. Build a fresh patch

```
powershell.exe -File "D:\Games\Dev\BlackmoonProphecy\build.ps1" -Version <version>
```

Pass `-Version` exactly as it appears in the tag but without the leading `V` (e.g. `0.6`,
`0.6-test-build`). It is stamped into the installer's title bar and into its filename, so
renaming a folder or zip afterwards does **not** restamp it — a version change means a
rebuild, not a rename.

`build.ps1` bundles `src\*.js` (load order `BMA_Core` → `BMA_Text` → `BMA_Menus` →
`BMA_Nav`) into `dist\bma-payload\`, regenerates the WAV cues, copies the prebuilt
`bma_tts.node` and the two bundled DLLs, regenerates `obj\ReadMe.txt` from `ReadMe.md`,
compiles the installer with the in-box .NET Framework C# compiler (embedding the entire
payload plus the readme into the .exe), and stages the shippable tree into `dist\ship\`.
If the build throws, stop — a failed compile deliberately leaves the previous `dist\ship\`
untouched rather than destroying the last good installer.

Confirm the output tree:

```
dist\ship\ReadMe.txt
dist\ship\BlackmoonProphecy-Accessibility-V<version>-Setup.exe
dist\ship\Manual install\www\js\plugins\BMA_Accessibility.js
dist\ship\Manual install\www\mod\bma_tts.node
dist\ship\Manual install\www\mod\Tolk.dll
dist\ship\Manual install\www\mod\nvdaControllerClient64.dll
dist\ship\Manual install\www\mod\audio\  (beacon, footstep, wall_bump, wall_n/s/e/w — 7 wavs)
```

`dist\bma-payload\` is a build intermediate — it is embedded into the .exe and mirrored
into `Manual install\`. It is not shipped on its own.

If `build.ps1` warns that `bma_tts.node` or either DLL was not found, fix that before
shipping — do not ship a release silently missing the addon or the screen-reader bridge.

### 3. Assemble `Releases\V<version>\`

`dist\ship\` is exactly what ships. Copy its whole contents into a versioned snapshot
directory:

```
New-Item -ItemType Directory -Force -Path "Releases\V<version>" | Out-Null
Copy-Item "dist\ship\*" "Releases\V<version>\" -Recurse -Force
```

`Releases\V<version>\` must end up containing `ReadMe.txt`, the `-Setup.exe`, and the
`Manual install\` folder. Preserve casing exactly: lowercase `n` in
`nvdaControllerClient64.dll`, capital `T` in `Tolk.dll` — Tolk loads its NVDA client by
that exact name at runtime.

### 4. Zip with 7-Zip

```
& "C:\Program Files\7-Zip\7z.exe" a -tzip "Releases\BlackmoonProphecy-Accessibility-V<version>.zip" ".\Releases\V<version>\*"
```

Zip naming: `BlackmoonProphecy-Accessibility-V<version>.zip`, placed in `Releases\`
(sibling of the version directory, not inside it). The zip's root contains `ReadMe.txt`,
the `-Setup.exe`, and `Manual install\` **directly** — no nested `V<version>\` folder.

Note the change from the old patch: this zip is **not** extracted into the game folder. The
user extracts it anywhere and runs the setup program, which finds the game itself or lets
them Browse to it.

### 5. Tag locally

```
git tag V<version>
```

Tag the verified `main` commit for this build. Keep release tags local until publication is
requested. The older tags in the development checkout belong to archived local history.

### 6. Draft the changelog

Write end-user release notes to `release-notes-V<version>.txt` in the repo root. These are
**never committed** — `.gitignore` covers `release-notes-*.txt` and the other usual
spellings, so the rule is enforced rather than remembered. They are written for whoever
receives the zip, not for this repo, and a new one is produced every release.

**These notes are written for end users, not developers.** A player reads them before
downloading. They do not know what `BMA.Nav.flood`, `Window_SaveConfirm`, `classify`, or
`joinParts` are, and they should not have to. Translate every commit into the user-visible
*behavior* it produced.

Style:

- 2–6 hyphen bullets, no headings.
- Each bullet describes a user-visible behavior change in language a player would use.
  Verbs like "speak," "announce," "play," "read," "open"; nouns like "key," "menu,"
  "screen," "battle," "waypoint," and the mod's own domain words — "pip" (footstep),
  "beacon" (the audio target pathfinder), "wall tone," "Marks" (the quest log), "Mod menu."
- Themed by feature area (navigation / menus / battle / bundled files / fixes), not
  commit-by-commit.
- **First release (no previous tag):** summarize the whole shipped feature set — speech for
  menus/dialogue/battle, spoken pathfinding, footstep/wall-tone/beacon cues, waypoints,
  status browsing, Marks, the F8 mod menu.
- **Later releases:** cover all user-visible work since the previous tag — review
  `git log V<previous>..HEAD` and `git diff V<previous>..HEAD --stat`, then translate into
  user terms.

**Always exclude:**

- Commit hashes, file paths, type names, method names, field names.
- Internal refactors with no user-visible effect. Say nothing, or describe the *fix* they
  enabled.
- Regressions introduced mid-development that never reached a prior release. If V<previous>
  shipped fine and a bug existed only between V<previous> and V<current>, no user ever saw
  it; do not advertise the fix.
- Developer-internal counts ("644 maps, ~9.2k entities scanned"); say what *works* for the
  user.

**Concrete contrast:**

| ❌ developer-language (do NOT write) | ✅ end-user language (DO write) |
|---|---|
| Beacon retrigger uses step-based acceleration ramp | The target beacon now speeds up as you get closer, so you can hear when you're nearly there |
| Window_SaveConfirm openness race fixed; entry announce added | Opening the save/load screen now announces the screen and reads the highlighted slot |
| Reliable turn-command read via deferred coalesced announce | In battle, whose turn it is and their first command are now read together and reliably |
| Strip ANSI color/escape codes before handing text to Tolk | Menu and dialogue text no longer reads out stray color codes |
| Per-frame tile-cross footstep hook silenced off-field | (omit — internal, no user-visible change) |

Re-read `release-notes-V<version>.txt` once before shipping.

### 7. Output the release artifact path

After the zip is built, emit its full path as a single standalone line in the terminal,
with nothing else on the line, so the user can triple-click to select and copy it when
handing off to testers:

```
D:\Games\Dev\BlackmoonProphecy\Releases\BlackmoonProphecy-Accessibility-V<version>.zip
```

Then report, in prose, that this zip is the one to distribute and that `release-notes-V<version>.txt`
holds the changelog to paste alongside it.

## What this procedure does NOT do

- Prepares the zip and tag locally. Source checkpoints and package publication are separate.
- Does **not** modify `ReadMe.md` *content*. `build.ps1` only regenerates the plain-text
  `obj\ReadMe.txt` from it. If the readme needs real changes, that's a separate commit
  before the "prepare release" trigger.
- Does **not** overwrite an existing `Releases\V<version>\` directory or zip. If either
  exists, stop and report.
- Does **not** bump any version string in source. There is no csproj/manifest version of
  record here; the tag `V<version>` is the source of truth.

## Publishing an authorized package

Use the verified public `main` commit and its specific release tag. Confirm that the tag is
reachable from `main`, and push it explicitly. Use the hand-written notes with the verified
zip when creating the GitHub release. Leave existing release artifacts in place.
