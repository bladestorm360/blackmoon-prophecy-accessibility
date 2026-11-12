//=============================================================================
// BMAInstaller.cs - Blackmoon Prophecy Remake accessibility mod installer.
//
// A conventional Windows setup wizard (Welcome -> Folder -> Ready -> Finish)
// with the whole mod payload embedded in the .exe as managed resources, so a
// tester downloads one file and never extracts a patch or hunts for a path.
//
// Two things drive the design:
//   * Nobody should have to remember or type a file path. The wizard finds the
//     game folder itself, and Browse opens the normal Explorer folder picker.
//   * The audience is blind. Every wizard page puts its heading and explanation
//     in a focusable read-only text box that takes focus as the page opens, so
//     a screen reader reads the page the moment you arrive on it.
//
// Targets .NET Framework 4.8, which ships with Windows 10 1903+ and Windows 11,
// so there is no runtime for the user to install.
//
// COMPILER NOTE: built by the in-box csc.exe, which supports C# 5 ONLY. No
// string interpolation, no ?., no expression-bodied members, no nameof, no
// `out var`. Keep it that way or build.ps1 will fail.
//
// ENCODING NOTE: keep this file pure ASCII. A stray em-dash in a string literal
// is exactly what broke the previous PowerShell installer - Windows PowerShell
// read the BOM-less UTF-8 as CP1252, the dash's third byte decoded to a curly
// quote, and it terminated the string mid-parse.
//=============================================================================

using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.Reflection;
using System.Runtime.InteropServices;
using System.Text;
using System.Text.RegularExpressions;
using System.Threading;
using System.Windows.Forms;

namespace BMA
{
    //-------------------------------------------------------------------------
    // Well-known paths inside a game folder.
    //-------------------------------------------------------------------------
    internal static class Paths
    {
        internal static string Www(string root) { return Path.Combine(root, "www"); }
        internal static string ModDir(string root) { return Path.Combine(Www(root), "mod"); }
        internal static string AudioDir(string root) { return Path.Combine(ModDir(root), "audio"); }
        internal static string PluginsDir(string root) { return Path.Combine(Www(root), "js", "plugins"); }
        internal static string PluginsJs(string root) { return Path.Combine(Www(root), "js", "plugins.js"); }
        internal static string CoreJs(string root) { return Path.Combine(Www(root), "js", "rpg_core.js"); }
        internal static string Backup(string root) { return PluginsJs(root) + ".bma-backup"; }
        internal static string ConfigSave(string root) { return Path.Combine(Www(root), "save", "config.rpgsave"); }
        internal static string ReadMe(string root) { return Path.Combine(root, "Blackmoon-Accessibility-ReadMe.txt"); }
    }

    //-------------------------------------------------------------------------
    // The embedded mod files.
    //
    // Resource names are assigned by build.ps1 as "payload/<relative path>",
    // mirroring the old bma-payload\ folder. Install and uninstall both drive
    // off this enumeration, so the two can never drift apart: whatever the
    // build embeds is exactly what gets written and exactly what gets removed.
    //-------------------------------------------------------------------------
    internal static class Payload
    {
        private const string Prefix = "payload/";
        internal const string ReadMeResource = "ReadMe.txt";

        private static readonly Assembly Asm = Assembly.GetExecutingAssembly();

        internal static List<string> Names()
        {
            List<string> names = new List<string>();
            foreach (string n in Asm.GetManifestResourceNames())
            {
                if (n.StartsWith(Prefix, StringComparison.Ordinal)) names.Add(n);
            }
            names.Sort(StringComparer.OrdinalIgnoreCase);
            return names;
        }

        internal static bool Has(string resourceName)
        {
            return Asm.GetManifestResourceInfo(resourceName) != null;
        }

        /// <summary>Where a payload resource lands inside the game folder.</summary>
        internal static string DestinationFor(string root, string resourceName)
        {
            string rel = resourceName.Substring(Prefix.Length).Replace('/', Path.DirectorySeparatorChar);

            // The plugin script is the one file that goes to www\js\plugins\;
            // everything else (native addon, screen-reader DLLs, audio cues)
            // lives under www\mod\.
            if (string.Equals(rel, "BMA_Accessibility.js", StringComparison.OrdinalIgnoreCase))
                return Path.Combine(Paths.PluginsDir(root), rel);

            return Path.Combine(Paths.ModDir(root), rel);
        }

        internal static void Extract(string resourceName, string destPath)
        {
            using (Stream src = Asm.GetManifestResourceStream(resourceName))
            {
                if (src == null) throw new FileNotFoundException("Embedded resource missing: " + resourceName);

                string dir = Path.GetDirectoryName(destPath);
                if (!string.IsNullOrEmpty(dir)) Directory.CreateDirectory(dir);

                // Clear read-only so a re-install over a previous copy succeeds.
                if (File.Exists(destPath))
                {
                    try { File.SetAttributes(destPath, FileAttributes.Normal); }
                    catch (IOException) { }
                    catch (UnauthorizedAccessException) { }
                }

                using (FileStream dst = new FileStream(destPath, FileMode.Create, FileAccess.Write, FileShare.None))
                {
                    src.CopyTo(dst);
                }
            }
        }
    }

    //-------------------------------------------------------------------------
    // LZString, base64 variant - a C# port of Pieroxy's LZ-String reference.
    // See LZ-STRING-LICENSE.txt for the upstream copyright and license.
    //
    // RPG Maker MV writes config.rpgsave as LZString.compressToBase64(json). The mod
    // piggybacks its settings into that same file, so taking them back out means
    // decompressing, editing, and recompressing in byte-identical format. Anything less
    // exact and the game cannot read its own settings back.
    //-------------------------------------------------------------------------
    internal static class LzString
    {
        private const string KeyStrBase64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/=";

        internal static string CompressToBase64(string input)
        {
            if (input == null) return "";
            string res = Compress(input, 6, KeyStrBase64);
            switch (res.Length % 4)
            {
                case 1: return res + "===";
                case 2: return res + "==";
                case 3: return res + "=";
                default: return res;
            }
        }

        internal static string DecompressFromBase64(string input)
        {
            if (input == null) return "";
            if (input.Length == 0) return null;
            return Decompress(input.Length, 32, input, KeyStrBase64);
        }

        // Writes bits least-significant-first, packing them `bitsPerChar` at a time into
        // characters of the alphabet. The reference implementation's three emit shapes
        // (n zero bits / n bits of a value / a 1 then zeros) are all just Write(n, value).
        private sealed class BitWriter
        {
            private readonly StringBuilder _out = new StringBuilder();
            private readonly int _bitsPerChar;
            private readonly string _alphabet;
            private int _val;
            private int _pos;

            internal BitWriter(int bitsPerChar, string alphabet) { _bitsPerChar = bitsPerChar; _alphabet = alphabet; }

            internal void Write(int count, int value)
            {
                for (int i = 0; i < count; i++)
                {
                    _val = (_val << 1) | (value & 1);
                    if (_pos == _bitsPerChar - 1) { _pos = 0; _out.Append(_alphabet[_val]); _val = 0; }
                    else _pos++;
                    value = value >> 1;
                }
            }

            internal string Flush()
            {
                while (true)
                {
                    _val = _val << 1;
                    if (_pos == _bitsPerChar - 1) { _out.Append(_alphabet[_val]); break; }
                    _pos++;
                }
                return _out.ToString();
            }
        }

        private sealed class BitReader
        {
            private readonly string _input;
            private readonly string _alphabet;
            private readonly int _resetValue;
            internal int Val;
            internal int Position;
            internal int Index;

            internal BitReader(string input, string alphabet, int resetValue)
            {
                _input = input; _alphabet = alphabet; _resetValue = resetValue;
                Val = ValueAt(0); Position = resetValue; Index = 1;
            }

            private int ValueAt(int index)
            {
                if (index < 0 || index >= _input.Length) return 0;
                int i = _alphabet.IndexOf(_input[index]);
                return (i < 0) ? 0 : i;
            }

            internal int ReadBits(int numBits)
            {
                int bits = 0;
                int maxpower = 1 << numBits;
                int power = 1;
                while (power != maxpower)
                {
                    int resb = Val & Position;
                    Position >>= 1;
                    if (Position == 0) { Position = _resetValue; Val = ValueAt(Index++); }
                    bits |= (resb > 0 ? 1 : 0) * power;
                    power <<= 1;
                }
                return bits;
            }
        }

        private static void EmitWord(BitWriter w, string word, Dictionary<string, int> dict,
                                     Dictionary<string, bool> toCreate, ref int numBits, ref int enlargeIn)
        {
            if (toCreate.ContainsKey(word))
            {
                if (word[0] < 256) { w.Write(numBits, 0); w.Write(8, word[0]); }
                else { w.Write(numBits, 1); w.Write(16, word[0]); }

                enlargeIn--;
                if (enlargeIn == 0) { enlargeIn = 1 << numBits; numBits++; }
                toCreate.Remove(word);
            }
            else
            {
                w.Write(numBits, dict[word]);
            }

            enlargeIn--;
            if (enlargeIn == 0) { enlargeIn = 1 << numBits; numBits++; }
        }

        private static string Compress(string uncompressed, int bitsPerChar, string alphabet)
        {
            if (uncompressed == null) return "";

            Dictionary<string, int> dict = new Dictionary<string, int>(StringComparer.Ordinal);
            Dictionary<string, bool> toCreate = new Dictionary<string, bool>(StringComparer.Ordinal);
            BitWriter w = new BitWriter(bitsPerChar, alphabet);

            string contextW = "";
            int enlargeIn = 2;
            int dictSize = 3;
            int numBits = 2;

            for (int ii = 0; ii < uncompressed.Length; ii++)
            {
                string contextC = uncompressed[ii].ToString();
                if (!dict.ContainsKey(contextC)) { dict[contextC] = dictSize++; toCreate[contextC] = true; }

                string contextWc = contextW + contextC;
                if (dict.ContainsKey(contextWc))
                {
                    contextW = contextWc;
                }
                else
                {
                    EmitWord(w, contextW, dict, toCreate, ref numBits, ref enlargeIn);
                    dict[contextWc] = dictSize++;
                    contextW = contextC;
                }
            }

            if (contextW.Length != 0) EmitWord(w, contextW, dict, toCreate, ref numBits, ref enlargeIn);

            w.Write(numBits, 2);   // end-of-stream marker
            return w.Flush();
        }

        private static string Decompress(int length, int resetValue, string input, string alphabet)
        {
            List<string> dictionary = new List<string>();
            for (int i = 0; i < 3; i++) dictionary.Add(null);   // slots 0-2 are control codes

            int enlargeIn = 4;
            int dictSize = 4;
            int numBits = 3;
            StringBuilder result = new StringBuilder();
            BitReader data = new BitReader(input, alphabet, resetValue);

            string c;
            switch (data.ReadBits(2))
            {
                case 0: c = ((char)data.ReadBits(8)).ToString(); break;
                case 1: c = ((char)data.ReadBits(16)).ToString(); break;
                case 2: return "";
                default: return null;
            }

            dictionary.Add(c);            // slot 3; List.Count stays equal to dictSize
            string word = c;
            result.Append(c);

            while (true)
            {
                if (data.Index > length) return "";

                int code = data.ReadBits(numBits);
                switch (code)
                {
                    case 0:
                        dictionary.Add(((char)data.ReadBits(8)).ToString());
                        code = dictSize++;
                        enlargeIn--;
                        break;
                    case 1:
                        dictionary.Add(((char)data.ReadBits(16)).ToString());
                        code = dictSize++;
                        enlargeIn--;
                        break;
                    case 2:
                        return result.ToString();
                }

                if (enlargeIn == 0) { enlargeIn = 1 << numBits; numBits++; }

                string entry;
                if (code < dictionary.Count && dictionary[code] != null) entry = dictionary[code];
                else if (code == dictSize) entry = word + word[0];
                else return null;

                result.Append(entry);
                dictionary.Add(word + entry[0]);
                dictSize++;
                enlargeIn--;
                word = entry;

                if (enlargeIn == 0) { enlargeIn = 1 << numBits; numBits++; }
            }
        }
    }

    //-------------------------------------------------------------------------
    // The mod's settings inside the game's own config.rpgsave.
    //
    // BMA_Core.js hooks ConfigManager and parks everything it remembers - volumes,
    // nav keyset, every toggle, custom keybindings - under a single "bma" key. That
    // file also holds the GAME's settings, so it is never deleted wholesale; only our
    // one key is cut out, and only after the rewrite passes a read-back check.
    //-------------------------------------------------------------------------
    internal static class GameConfig
    {
        internal const string ModKey = "bma";

        internal static string ReadJson(string root)
        {
            try
            {
                string path = Paths.ConfigSave(root);
                if (!File.Exists(path)) return null;

                string json = LzString.DecompressFromBase64(File.ReadAllText(path).Trim());
                if (string.IsNullOrEmpty(json) || json[0] != '{') return null;
                return json;
            }
            catch (Exception) { return null; }
        }

        internal static bool HasModSettings(string root)
        {
            string json = ReadJson(root);
            return json != null && Regex.IsMatch(json, "\"" + ModKey + "\"\\s*:");
        }

        /// <summary>
        /// Cuts one top-level object-valued key out of a JSON document, brace-matching and
        /// string-aware so braces inside string values cannot fool it, and absorbing one
        /// separating comma. Returns null when the key is not there.
        /// </summary>
        internal static string RemoveJsonKey(string json, string key)
        {
            Match m = Regex.Match(json, "\"" + Regex.Escape(key) + "\"\\s*:");
            if (!m.Success) return null;

            int valueStart = m.Index + m.Length;
            while (valueStart < json.Length && char.IsWhiteSpace(json[valueStart])) valueStart++;
            if (valueStart >= json.Length || json[valueStart] != '{') return null;

            int depth = 0;
            int end = -1;
            bool inString = false;
            bool escape = false;
            for (int i = valueStart; i < json.Length; i++)
            {
                char ch = json[i];
                if (escape) { escape = false; continue; }
                if (ch == '\\') { escape = true; continue; }
                if (ch == '"') { inString = !inString; continue; }
                if (inString) continue;

                if (ch == '{') depth++;
                else if (ch == '}') { depth--; if (depth == 0) { end = i; break; } }
            }
            if (end < 0) return null;

            int cut = m.Index;
            int after = end + 1;

            int j = cut - 1;
            while (j >= 0 && char.IsWhiteSpace(json[j])) j--;
            if (j >= 0 && json[j] == ',')
            {
                cut = j;
            }
            else
            {
                int k = after;
                while (k < json.Length && char.IsWhiteSpace(json[k])) k++;
                if (k < json.Length && json[k] == ',') after = k + 1;
            }

            return json.Substring(0, cut) + json.Substring(after);
        }

        /// <summary>Returns true if the mod's settings were actually removed.</summary>
        internal static bool RemoveModSettings(string root, Action<string> log)
        {
            string json = ReadJson(root);
            if (json == null) { log("No readable game config found; no mod settings to clear."); return false; }

            string cleaned = RemoveJsonKey(json, ModKey);
            if (cleaned == null) { log("The game config holds no mod settings."); return false; }

            string rewritten = LzString.CompressToBase64(cleaned);

            // This file also holds the player's own volume and window settings. Prove the
            // rewrite reads back exactly before overwriting it; otherwise leave it alone.
            if (LzString.DecompressFromBase64(rewritten) != cleaned)
            {
                log("Left the game config alone: the rewritten copy failed its read-back check.");
                return false;
            }

            File.WriteAllText(Paths.ConfigSave(root), rewritten, new UTF8Encoding(false));
            log("Cleared the mod's settings from the game config; the game's own settings are untouched.");
            return true;
        }
    }

    //-------------------------------------------------------------------------
    // The actual install / uninstall work. No UI in here.
    //-------------------------------------------------------------------------
    internal static class Installer
    {
        // Runtime files the mod itself writes; not part of the payload, but ours to clean up.
        private static readonly string[] RuntimeArtifacts = { "bma_log.txt", "bma_addon.loading", "bma_safe.txt" };

        // User-created content. Deleted only on explicit request - a reinstall reuses it.
        internal static readonly string[] UserDataFiles = { "waypoints.json", "entity_labels.json" };

        private const string RegisteredPattern = "\"name\"\\s*:\\s*\"BMA_Accessibility\"";

        internal static bool IsGameFolder(string root)
        {
            if (string.IsNullOrEmpty(root)) return false;
            try { return File.Exists(Paths.CoreJs(root)) && File.Exists(Paths.PluginsJs(root)); }
            catch (ArgumentException) { return false; }
            catch (IOException) { return false; }
            catch (UnauthorizedAccessException) { return false; }
        }

        /// <summary>
        /// Turns whatever folder the user pointed at into the actual game folder(s) under it.
        ///
        /// The game ships as a zip that extracts to a wrapper folder ("Blackmoon Prophecy
        /// Remake 1.05S\Final Fantasy Blackmoon Prophecy Remake\Game.exe"), so "the folder I
        /// downloaded" and "the folder with Game.exe in it" are different, and a user will
        /// reasonably pick either. Accept both instead of rejecting the outer one.
        ///
        /// Returns every match found, so an ambiguous pick can be reported rather than
        /// guessed at - patching the wrong copy of the game silently would be worse.
        /// </summary>
        internal static string[] ResolveGameFolders(string path, int maxDepth)
        {
            if (string.IsNullOrEmpty(path)) return new string[0];
            if (IsGameFolder(path)) return new string[] { path };

            List<string> found = new List<string>();
            Queue<string> dirs = new Queue<string>();
            Queue<int> depths = new Queue<int>();
            dirs.Enqueue(path);
            depths.Enqueue(0);

            while (dirs.Count > 0 && found.Count < 8)
            {
                string cur = dirs.Dequeue();
                int depth = depths.Dequeue();
                if (depth >= maxDepth) continue;

                string[] subs;
                try { subs = Directory.GetDirectories(cur); }
                catch (IOException) { continue; }
                catch (UnauthorizedAccessException) { continue; }

                foreach (string s in subs)
                {
                    if (IsGameFolder(s))
                    {
                        // A game folder never contains another one; do not descend into it.
                        found.Add(s);
                        continue;
                    }
                    string name = Path.GetFileName(s);
                    if (!string.IsNullOrEmpty(name) && string.Equals(name, "www", StringComparison.OrdinalIgnoreCase)) continue;
                    dirs.Enqueue(s);
                    depths.Enqueue(depth + 1);
                }
            }

            found.Sort(StringComparer.OrdinalIgnoreCase);
            return found.ToArray();
        }

        internal static bool IsInstalled(string root)
        {
            try
            {
                if (File.Exists(Path.Combine(Paths.PluginsDir(root), "BMA_Accessibility.js"))) return true;
                if (File.Exists(Paths.PluginsJs(root)))
                {
                    string text = File.ReadAllText(Paths.PluginsJs(root));
                    if (Regex.IsMatch(text, RegisteredPattern)) return true;
                }
            }
            catch (IOException) { }
            catch (UnauthorizedAccessException) { }
            return false;
        }

        /// <summary>
        /// Is there anything of ours left here at all - files, user data, or settings
        /// parked in the game's config? Someone who deleted the mod's files by hand still
        /// needs a way to clear the settings, so Remove is offered whenever any trace
        /// remains, not only when the plugin itself is registered.
        /// </summary>
        internal static bool HasAnythingToRemove(string root)
        {
            if (IsInstalled(root)) return true;
            if (ExistingUserData(root).Length > 0) return true;
            if (File.Exists(Paths.Backup(root))) return true;
            if (GameConfig.HasModSettings(root)) return true;

            foreach (string res in Payload.Names())
            {
                if (File.Exists(Payload.DestinationFor(root, res))) return true;
            }
            return File.Exists(Paths.ReadMe(root));
        }

        internal static string[] ExistingUserData(string root)
        {
            List<string> found = new List<string>();
            foreach (string f in UserDataFiles)
            {
                string p = Path.Combine(Paths.ModDir(root), f);
                if (File.Exists(p)) found.Add(p);
            }
            return found.ToArray();
        }

        internal static void Install(string root, Action<string> log)
        {
            Directory.CreateDirectory(Paths.ModDir(root));
            Directory.CreateDirectory(Paths.AudioDir(root));
            Directory.CreateDirectory(Paths.PluginsDir(root));

            int count = 0;
            foreach (string res in Payload.Names())
            {
                Payload.Extract(res, Payload.DestinationFor(root, res));
                count++;
            }
            log("Copied " + count.ToString() + " mod files into the game folder.");

            // A stale crash-canary from a previous broken build would make the mod
            // auto-skip the freshly installed addon. Clear it for a clean first run.
            SafeDelete(Path.Combine(Paths.ModDir(root), "bma_addon.loading"));

            if (Payload.Has(Payload.ReadMeResource))
            {
                Payload.Extract(Payload.ReadMeResource, Paths.ReadMe(root));
                log("Wrote " + Path.GetFileName(Paths.ReadMe(root)) + " next to Game.exe.");
            }

            // Back up plugins.js, but only if no pristine backup exists yet - a second
            // install must not overwrite the vanilla copy with an already-modded one.
            string pluginsJs = Paths.PluginsJs(root);
            string backup = Paths.Backup(root);
            if (!File.Exists(backup))
            {
                File.Copy(pluginsJs, backup, false);
                log("Backed up plugins.js.");
            }
            else
            {
                log("Kept the existing pristine plugins.js backup.");
            }

            // Register the plugin (idempotent).
            string text = File.ReadAllText(pluginsJs);
            if (Regex.IsMatch(text, RegisteredPattern))
            {
                log("Already registered in plugins.js; skipped that edit.");
            }
            else
            {
                int lastBracket = text.LastIndexOf(']');
                if (lastBracket < 0)
                    throw new InvalidDataException("plugins.js has no closing bracket - unexpected format.");

                string entry = ",\r\n{\"name\":\"BMA_Accessibility\",\"status\":true,"
                             + "\"description\":\"Blackmoon accessibility mod\",\"parameters\":{}}\r\n";
                text = text.Substring(0, lastBracket) + entry + text.Substring(lastBracket);
                WriteUtf8NoBom(pluginsJs, text);
                log("Registered BMA_Accessibility in plugins.js.");
            }
        }

        internal static void Uninstall(string root, bool deleteUserData, bool deleteSettings, Action<string> log)
        {
            string pluginsJs = Paths.PluginsJs(root);
            string backup = Paths.Backup(root);

            if (File.Exists(backup))
            {
                File.Copy(backup, pluginsJs, true);
                File.Delete(backup);
                log("Restored the original plugins.js.");
            }
            else if (File.Exists(pluginsJs))
            {
                // No backup (deleted, or the game was updated over it). Surgically remove
                // just our own entry rather than leaving a plugin registered whose file
                // we are about to delete - that would break the game on next launch.
                string text = File.ReadAllText(pluginsJs);
                string cleaned = RemovePluginEntry(text);
                if (cleaned != null)
                {
                    WriteUtf8NoBom(pluginsJs, cleaned);
                    log("No backup found; removed the BMA_Accessibility entry from plugins.js directly.");
                }
                else
                {
                    log("No backup found and no BMA_Accessibility entry present; left plugins.js alone.");
                }
            }

            int removed = 0;
            foreach (string res in Payload.Names())
            {
                if (SafeDelete(Payload.DestinationFor(root, res))) removed++;
            }
            if (SafeDelete(Paths.ReadMe(root))) removed++;
            foreach (string rt in RuntimeArtifacts)
            {
                if (SafeDelete(Path.Combine(Paths.ModDir(root), rt))) removed++;
            }
            log("Removed " + removed.ToString() + " mod files.");

            if (deleteUserData)
            {
                foreach (string p in ExistingUserData(root)) SafeDelete(p);
                log("Deleted your saved waypoints and custom labels.");
            }
            else if (ExistingUserData(root).Length > 0)
            {
                log("Kept your waypoints and custom labels in www\\mod\\.");
            }

            if (deleteSettings)
            {
                GameConfig.RemoveModSettings(root, log);
            }
            else if (GameConfig.HasModSettings(root))
            {
                log("Kept the mod's settings in the game config, ready for a reinstall.");
            }

            // Leave the folder tidy, but never delete a directory that still holds
            // anything (kept user data, or files that are not ours).
            RemoveDirIfEmpty(Paths.AudioDir(root));
            RemoveDirIfEmpty(Paths.ModDir(root));
        }

        /// <summary>
        /// Strips the BMA_Accessibility object out of a plugins.js array, brace-matching
        /// so the nested "parameters":{} does not fool it, and absorbing one separating
        /// comma. Returns null when there is nothing to remove.
        /// </summary>
        internal static string RemovePluginEntry(string text)
        {
            Match m = Regex.Match(text, RegisteredPattern);
            if (!m.Success) return null;

            int start = text.LastIndexOf('{', m.Index);
            if (start < 0) return null;

            int depth = 0;
            int end = -1;
            for (int i = start; i < text.Length; i++)
            {
                if (text[i] == '{') depth++;
                else if (text[i] == '}')
                {
                    depth--;
                    if (depth == 0) { end = i; break; }
                }
            }
            if (end < 0) return null;

            int cut = start;
            int after = end + 1;

            // Prefer eating the comma before us; if there is none, eat the one after.
            int j = start - 1;
            while (j >= 0 && char.IsWhiteSpace(text[j])) j--;
            if (j >= 0 && text[j] == ',')
            {
                cut = j;
            }
            else
            {
                int k = after;
                while (k < text.Length && char.IsWhiteSpace(text[k])) k++;
                if (k < text.Length && text[k] == ',') after = k + 1;
            }

            return text.Substring(0, cut) + text.Substring(after);
        }

        private static void WriteUtf8NoBom(string path, string text)
        {
            File.WriteAllText(path, text, new UTF8Encoding(false));
        }

        private static bool SafeDelete(string path)
        {
            try
            {
                if (!File.Exists(path)) return false;
                File.SetAttributes(path, FileAttributes.Normal);
                File.Delete(path);
                return true;
            }
            catch (IOException) { return false; }
            catch (UnauthorizedAccessException) { return false; }
        }

        private static void RemoveDirIfEmpty(string dir)
        {
            try
            {
                if (Directory.Exists(dir) &&
                    Directory.GetFiles(dir).Length == 0 &&
                    Directory.GetDirectories(dir).Length == 0)
                {
                    Directory.Delete(dir);
                }
            }
            catch (IOException) { }
            catch (UnauthorizedAccessException) { }
        }
    }

    //-------------------------------------------------------------------------
    // Finding the game folder for the user.
    //
    // The whole point is that nobody should have to know where the game lives.
    // The wizard opens with the folder already filled in whenever it can.
    //-------------------------------------------------------------------------
    internal static class Detect
    {
        private static readonly string[] SkipDirs =
        {
            "node_modules", ".git", "AppData", "Windows", "ProgramData",
            "$Recycle.Bin", "System Volume Information", "www"
        };

        /// <summary>Instant checks: the exe's own folder, its ancestors, and their children.</summary>
        internal static string FromExeLocation()
        {
            string dir = null;
            try { dir = Path.GetDirectoryName(Application.ExecutablePath); }
            catch (ArgumentException) { return null; }

            for (int up = 0; up < 3 && !string.IsNullOrEmpty(dir); up++)
            {
                if (Installer.IsGameFolder(dir)) return dir;

                string[] children;
                try { children = Directory.GetDirectories(dir); }
                catch (IOException) { children = new string[0]; }
                catch (UnauthorizedAccessException) { children = new string[0]; }

                foreach (string c in children)
                {
                    if (Installer.IsGameFolder(c)) return c;
                }

                try { dir = Path.GetDirectoryName(dir); }
                catch (ArgumentException) { break; }
            }
            return null;
        }

        /// <summary>Bounded breadth-first sweep of the places a downloaded game actually lands.</summary>
        internal static string Search()
        {
            List<string> roots = new List<string>();
            AddIfReal(roots, Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.UserProfile), "Downloads"));
            AddIfReal(roots, Environment.GetFolderPath(Environment.SpecialFolder.Desktop));
            AddIfReal(roots, Environment.GetFolderPath(Environment.SpecialFolder.MyDocuments));

            try
            {
                foreach (DriveInfo d in DriveInfo.GetDrives())
                {
                    if (d.DriveType != DriveType.Fixed || !d.IsReady) continue;
                    AddIfReal(roots, Path.Combine(d.RootDirectory.FullName, "Games"));
                }
            }
            catch (IOException) { }

            try { AddIfReal(roots, Path.GetDirectoryName(Application.ExecutablePath)); }
            catch (ArgumentException) { }

            return BreadthFirst(roots, 4, 6000);
        }

        private static void AddIfReal(List<string> list, string path)
        {
            try
            {
                if (!string.IsNullOrEmpty(path) && Directory.Exists(path) && !list.Contains(path)) list.Add(path);
            }
            catch (IOException) { }
        }

        private static string BreadthFirst(List<string> roots, int maxDepth, int budget)
        {
            Queue<string> dirs = new Queue<string>();
            Queue<int> depths = new Queue<int>();
            foreach (string r in roots) { dirs.Enqueue(r); depths.Enqueue(0); }

            int examined = 0;
            while (dirs.Count > 0 && examined < budget)
            {
                string cur = dirs.Dequeue();
                int depth = depths.Dequeue();
                examined++;

                if (Installer.IsGameFolder(cur)) return cur;
                if (depth >= maxDepth) continue;

                string[] subs;
                try { subs = Directory.GetDirectories(cur); }
                catch (IOException) { continue; }
                catch (UnauthorizedAccessException) { continue; }

                foreach (string s in subs)
                {
                    string name = Path.GetFileName(s);
                    if (IsSkipped(name)) continue;

                    // Junctions and symlinks can loop or point off into the OS.
                    try
                    {
                        if ((new DirectoryInfo(s).Attributes & FileAttributes.ReparsePoint) != 0) continue;
                    }
                    catch (IOException) { continue; }
                    catch (UnauthorizedAccessException) { continue; }

                    dirs.Enqueue(s);
                    depths.Enqueue(depth + 1);
                }
            }
            return null;
        }

        private static bool IsSkipped(string name)
        {
            if (string.IsNullOrEmpty(name)) return true;
            if (name.Length > 0 && name[0] == '.') return true;
            foreach (string s in SkipDirs)
            {
                if (string.Equals(name, s, StringComparison.OrdinalIgnoreCase)) return true;
            }
            return false;
        }
    }

    //-------------------------------------------------------------------------
    // The folder picker.
    //
    // WinForms' own FolderBrowserDialog is the cramped tree-only control from
    // Windows 2000 - no address bar, no Quick Access, no way to paste a path.
    // IFileDialog in "pick folders" mode is the ordinary Explorer dialog every
    // other modern app opens, which is both what a sighted user expects and far
    // easier to drive with a screen reader. The old dialog stays as a fallback
    // so a failure here can never leave the user with no way to browse.
    //-------------------------------------------------------------------------
    internal static class FolderPicker
    {
        private const uint FOS_PICKFOLDERS = 0x00000020;
        private const uint FOS_FORCEFILESYSTEM = 0x00000040;
        private const uint FOS_PATHMUSTEXIST = 0x00000800;
        private const uint FOS_NOCHANGEDIR = 0x00000008;

        private const uint SIGDN_FILESYSPATH = 0x80058000;
        private const int ERROR_CANCELLED_HR = unchecked((int)0x800704C7);

        [ComImport, Guid("DC1C5A9C-E88A-4dde-A5A1-60F82A20AEF7")]
        private class FileOpenDialogRcw { }

        [ComImport, Guid("42f85136-db7e-439c-85f1-e4075d135fc8"),
         InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
        private interface IFileDialog
        {
            // IModalWindow
            [PreserveSig] int Show(IntPtr hwndParent);
            // IFileDialog - every slot must be declared, in order, even unused ones.
            void SetFileTypes(uint cFileTypes, IntPtr rgFilterSpec);
            void SetFileTypeIndex(uint iFileType);
            void GetFileTypeIndex(out uint piFileType);
            void Advise(IntPtr pfde, out uint pdwCookie);
            void Unadvise(uint dwCookie);
            void SetOptions(uint fos);
            void GetOptions(out uint pfos);
            void SetDefaultFolder(IShellItem psi);
            void SetFolder(IShellItem psi);
            void GetFolder(out IShellItem ppsi);
            void GetCurrentSelection(out IShellItem ppsi);
            void SetFileName([MarshalAs(UnmanagedType.LPWStr)] string pszName);
            void GetFileName([MarshalAs(UnmanagedType.LPWStr)] out string pszName);
            void SetTitle([MarshalAs(UnmanagedType.LPWStr)] string pszTitle);
            void SetOkButtonLabel([MarshalAs(UnmanagedType.LPWStr)] string pszText);
            void SetFileNameLabel([MarshalAs(UnmanagedType.LPWStr)] string pszLabel);
            void GetResult(out IShellItem ppsi);
            void AddPlace(IShellItem psi, int fdap);
            void SetDefaultExtension([MarshalAs(UnmanagedType.LPWStr)] string pszDefaultExtension);
            void Close([MarshalAs(UnmanagedType.Error)] int hr);
            void SetClientGuid(ref Guid guid);
            void ClearClientData();
            void SetFilter(IntPtr pFilter);
        }

        [ComImport, Guid("43826d1e-e718-42ee-bc55-a1e261c37bfe"),
         InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
        private interface IShellItem
        {
            void BindToHandler(IntPtr pbc, ref Guid bhid, ref Guid riid, out IntPtr ppv);
            void GetParent(out IShellItem ppsi);
            void GetDisplayName(uint sigdnName, out IntPtr ppszName);
            void GetAttributes(uint sfgaoMask, out uint psfgaoAttribs);
            void Compare(IShellItem psi, uint hint, out int piOrder);
        }

        [DllImport("shell32.dll", CharSet = CharSet.Unicode, PreserveSig = false)]
        private static extern void SHCreateItemFromParsingName(
            [MarshalAs(UnmanagedType.LPWStr)] string pszPath, IntPtr pbc, ref Guid riid,
            [MarshalAs(UnmanagedType.Interface)] out IShellItem ppv);

        /// <summary>Returns the chosen folder, or null if the user cancelled.</summary>
        internal static string Pick(IWin32Window owner, string title, string startFolder)
        {
            try { return PickModern(owner, title, startFolder); }
            catch (Exception) { return PickLegacy(owner, title, startFolder); }
        }

        private static string PickModern(IWin32Window owner, string title, string startFolder)
        {
            IFileDialog dlg = (IFileDialog)new FileOpenDialogRcw();
            try
            {
                uint options;
                dlg.GetOptions(out options);
                dlg.SetOptions(options | FOS_PICKFOLDERS | FOS_FORCEFILESYSTEM | FOS_PATHMUSTEXIST | FOS_NOCHANGEDIR);
                dlg.SetTitle(title);
                dlg.SetOkButtonLabel("Select Folder");

                if (!string.IsNullOrEmpty(startFolder) && Directory.Exists(startFolder))
                {
                    try
                    {
                        Guid shellItemGuid = new Guid("43826d1e-e718-42ee-bc55-a1e261c37bfe");
                        IShellItem start;
                        SHCreateItemFromParsingName(startFolder, IntPtr.Zero, ref shellItemGuid, out start);
                        if (start != null) dlg.SetFolder(start);
                    }
                    catch (Exception) { } // a bad starting folder must not stop the dialog opening
                }

                IntPtr hwnd = (owner != null) ? owner.Handle : IntPtr.Zero;
                int hr = dlg.Show(hwnd);
                if (hr == ERROR_CANCELLED_HR) return null;
                if (hr != 0) Marshal.ThrowExceptionForHR(hr);

                IShellItem result;
                dlg.GetResult(out result);
                if (result == null) return null;

                IntPtr pszPath;
                result.GetDisplayName(SIGDN_FILESYSPATH, out pszPath);
                if (pszPath == IntPtr.Zero) return null;
                try { return Marshal.PtrToStringUni(pszPath); }
                finally { Marshal.FreeCoTaskMem(pszPath); }
            }
            finally
            {
                Marshal.FinalReleaseComObject(dlg);
            }
        }

        private static string PickLegacy(IWin32Window owner, string title, string startFolder)
        {
            using (FolderBrowserDialog dlg = new FolderBrowserDialog())
            {
                dlg.Description = title;
                dlg.ShowNewFolderButton = false;
                if (!string.IsNullOrEmpty(startFolder) && Directory.Exists(startFolder)) dlg.SelectedPath = startFolder;
                return (dlg.ShowDialog(owner) == DialogResult.OK) ? dlg.SelectedPath : null;
            }
        }
    }

    //-------------------------------------------------------------------------
    // The wizard.
    //-------------------------------------------------------------------------
    internal sealed class WizardForm : Form
    {
        private enum Page { Welcome, Folder, Ready, Finish }

        private const string ModName = "Blackmoon Prophecy Accessibility Mod";

        // Header, shared by every page.
        private readonly Label _heading;
        private readonly TextBox _info;

        // Page panels.
        private readonly Panel _pageWelcome;
        private readonly Panel _pageFolder;
        private readonly Panel _pageReady;
        private readonly Panel _pageFinish;

        // Welcome page.
        private readonly RadioButton _optInstall;
        private readonly RadioButton _optRemove;

        // Folder page.
        private readonly TextBox _folder;
        private readonly Button _browse;
        private readonly TextBox _folderState;

        // Ready page.
        private readonly CheckBox _deleteUserData;
        private readonly CheckBox _deleteSettings;

        // Finish page.
        private readonly TextBox _log;
        private readonly Button _openReadMe;

        // Navigation.
        private readonly Button _back;
        private readonly Button _next;
        private readonly Button _cancel;

        private Page _page = Page.Welcome;
        private bool _scanning;
        private bool _busy;
        private bool _succeeded;

        // The game folder the wizard will act on. Usually what is in the folder box,
        // but one level down from it when the user picked the wrapper folder.
        private string _resolved;

        private bool Removing { get { return _optRemove.Checked; } }

        internal WizardForm(string initialPath)
        {
            Text = ModName + " Setup";
            FormBorderStyle = FormBorderStyle.FixedDialog;
            MaximizeBox = false;
            MinimizeBox = false;
            StartPosition = FormStartPosition.CenterScreen;
            AutoScaleMode = AutoScaleMode.Font;
            Font = SystemFonts.MessageBoxFont;
            ClientSize = new Size(700, 500);

            const int pad = 22;
            int inner = 700 - (pad * 2);

            //--- header ---
            _heading = new Label();
            _heading.SetBounds(pad, 18, inner, 26);
            _heading.Font = new Font(Font.FontFamily, Font.Size + 2f, FontStyle.Bold);

            // Focusable on purpose: this box takes focus as each page opens, so a screen
            // reader reads the page heading and explanation without the user hunting for it.
            _info = new TextBox();
            _info.SetBounds(pad, 48, inner, 96);
            _info.Multiline = true;
            _info.ReadOnly = true;
            _info.BorderStyle = BorderStyle.None;
            _info.BackColor = SystemColors.Control;
            _info.TabIndex = 0;
            _info.AccessibleName = "Page description";
            _info.KeyDown += OnReadOnlyBoxKeyDown;

            //--- welcome page ---
            _pageWelcome = NewPagePanel();

            _optInstall = new RadioButton();
            _optInstall.Text = "&Install or update the mod";
            _optInstall.SetBounds(0, 4, inner, 26);
            _optInstall.Checked = true;
            _optInstall.TabIndex = 0;
            _optInstall.AccessibleDescription = "Adds the accessibility mod to your copy of the game.";

            _optRemove = new RadioButton();
            _optRemove.Text = "&Remove the mod";
            _optRemove.SetBounds(0, 34, inner, 26);
            _optRemove.TabIndex = 1;
            _optRemove.AccessibleDescription = "Puts the game folder back to how it was before the mod.";

            _pageWelcome.Controls.AddRange(new Control[] { _optInstall, _optRemove });

            //--- folder page ---
            _pageFolder = NewPagePanel();

            Label folderLabel = new Label();
            folderLabel.Text = "&Game folder:";
            folderLabel.SetBounds(0, 0, inner, 20);
            folderLabel.TabIndex = 0;

            _folder = new TextBox();
            _folder.SetBounds(0, 22, inner - 130, 26);
            _folder.TabIndex = 1;
            _folder.AccessibleName = "Selected game folder";
            _folder.TextChanged += delegate { UpdateFolderState(); };

            _browse = new Button();
            _browse.Text = "B&rowse...";
            _browse.SetBounds(inner - 120, 21, 120, 29);
            _browse.TabIndex = 2;
            _browse.AccessibleName = "Browse for the game folder";
            _browse.AccessibleDescription = "Opens a window where you can look through your computer and pick the folder.";
            _browse.Click += OnBrowse;

            _folderState = new TextBox();
            _folderState.SetBounds(0, 60, inner, 60);
            _folderState.Multiline = true;
            _folderState.ReadOnly = true;
            _folderState.BorderStyle = BorderStyle.None;
            _folderState.BackColor = SystemColors.Control;
            _folderState.TabIndex = 3;
            _folderState.AccessibleName = "Folder status";
            _folderState.KeyDown += OnReadOnlyBoxKeyDown;

            _pageFolder.Controls.AddRange(new Control[] { folderLabel, _folder, _browse, _folderState });

            //--- ready page ---
            _pageReady = NewPagePanel();

            // Unchecked by default: waypoints and custom labels are the user's own work,
            // and a later reinstall picks them straight back up. Deleting them has to be
            // something you deliberately opt into, never something you fail to opt out of.
            _deleteUserData = new CheckBox();
            _deleteUserData.SetBounds(0, 4, inner, 26);
            _deleteUserData.Text = "Also &delete my saved waypoints and custom entity labels";
            _deleteUserData.Checked = false;
            _deleteUserData.TabIndex = 0;
            _deleteUserData.AccessibleName = "Also delete my saved waypoints and custom entity labels";
            _deleteUserData.AccessibleDescription =
                "Leave this unchecked to keep them. If you install the mod again later, they will still be there.";

            // The mod's settings live inside the game's own config.rpgsave. Leaving them
            // is what makes a reinstall feel like nothing happened, so this is opt-in too -
            // but it IS offered, so "remove everything" never means editing a save by hand.
            _deleteSettings = new CheckBox();
            _deleteSettings.SetBounds(0, 34, inner, 26);
            _deleteSettings.Text = "Also delete the mod's &settings (volumes, nav keyset, toggles, key bindings)";
            _deleteSettings.Checked = false;
            _deleteSettings.TabIndex = 1;
            _deleteSettings.AccessibleName = "Also delete the mod's settings: volumes, nav keyset, toggles and key bindings";
            _deleteSettings.AccessibleDescription =
                "These are stored inside the game's own settings file. Only the mod's are removed; the game's own settings are left alone.";

            _pageReady.Controls.AddRange(new Control[] { _deleteUserData, _deleteSettings });

            //--- finish page ---
            _pageFinish = NewPagePanel();

            Label logLabel = new Label();
            logLabel.Text = "&Details:";
            logLabel.SetBounds(0, 0, inner, 20);
            logLabel.TabIndex = 0;

            _log = new TextBox();
            _log.SetBounds(0, 22, inner, 176);
            _log.Multiline = true;
            _log.ReadOnly = true;
            _log.ScrollBars = ScrollBars.Vertical;
            _log.BackColor = SystemColors.Window;
            _log.TabIndex = 1;
            _log.AccessibleName = "Details";
            _log.AccessibleDescription = "Read-only. Use the arrow keys to review what setup did.";

            _openReadMe = new Button();
            _openReadMe.Text = "Open Read &Me";
            _openReadMe.SetBounds(0, 208, 160, 30);
            _openReadMe.TabIndex = 2;
            _openReadMe.AccessibleName = "Open the read me";
            _openReadMe.AccessibleDescription = "Opens the full instructions and key list in Notepad.";
            _openReadMe.Click += OnOpenReadMe;

            _pageFinish.Controls.AddRange(new Control[] { logLabel, _log, _openReadMe });

            //--- navigation ---
            Panel divider = new Panel();
            divider.SetBounds(0, 440, 700, 1);
            divider.BackColor = SystemColors.ControlDark;

            _back = new Button();
            _back.Text = "< &Back";
            _back.SetBounds(700 - pad - 350, 454, 110, 32);
            _back.TabIndex = 10;
            _back.Click += OnBack;

            _next = new Button();
            _next.Text = "&Next >";
            _next.SetBounds(700 - pad - 234, 454, 110, 32);
            _next.TabIndex = 11;
            _next.Click += OnNext;

            _cancel = new Button();
            _cancel.Text = "&Cancel";
            _cancel.SetBounds(700 - pad - 110, 454, 110, 32);
            _cancel.TabIndex = 12;
            _cancel.Click += OnCancel;

            Controls.AddRange(new Control[]
            {
                _heading, _info, _pageWelcome, _pageFolder, _pageReady, _pageFinish,
                divider, _back, _next, _cancel
            });

            AcceptButton = _next;
            CancelButton = _cancel;

            // Have the folder ready before the user ever reaches that page.
            if (!string.IsNullOrEmpty(initialPath))
            {
                _folder.Text = initialPath;
            }
            else
            {
                string quick = Detect.FromExeLocation();
                if (quick != null) _folder.Text = quick;
                else StartBackgroundScan();
            }

            GoTo(Page.Welcome);
        }

        private static Panel NewPagePanel()
        {
            Panel p = new Panel();
            p.SetBounds(22, 156, 700 - 44, 270);
            p.TabIndex = 1;
            p.Visible = false;
            return p;
        }

        //--- page flow -------------------------------------------------------

        private void GoTo(Page page)
        {
            _page = page;

            _pageWelcome.Visible = (page == Page.Welcome);
            _pageFolder.Visible = (page == Page.Folder);
            _pageReady.Visible = (page == Page.Ready);
            _pageFinish.Visible = (page == Page.Finish);

            switch (page)
            {
                case Page.Welcome:
                    _heading.Text = "Welcome to " + ModName + " Setup";
                    _info.Text =
                        "This will add screen-reader speech, spoken navigation and audio cues to "
                        + "Final Fantasy Blackmoon Prophecy Remake.\r\n\r\n"
                        + "Choose what you want to do, then select Next. "
                        + "Setup will find your game folder for you.";
                    _back.Enabled = false;
                    _next.Text = "&Next >";
                    _next.Enabled = true;
                    _cancel.Visible = true;
                    _cancel.Text = "&Cancel";
                    break;

                case Page.Folder:
                    _heading.Text = Removing ? "Choose the game folder" : "Choose where to install";
                    _info.Text = BuildFolderPageInfo();
                    _back.Enabled = true;
                    _next.Text = "&Next >";
                    _cancel.Visible = true;
                    UpdateFolderState();
                    break;

                case Page.Ready:
                    _heading.Text = Removing ? "Ready to remove" : "Ready to install";
                    _info.Text = BuildReadyPageInfo();
                    // Only offer the choice when removing, and only when there is
                    // actually something of the user's to lose.
                    _deleteUserData.Visible = Removing && HasUserData();
                    _deleteUserData.Text = "Also &delete " + UserDataPhrase("my");
                    _deleteUserData.AccessibleName = "Also delete " + UserDataPhrase("my");
                    _deleteSettings.Visible = Removing && HasModSettings();
                    // Keep them stacked with no gap when only the settings box is showing.
                    _deleteSettings.Top = _deleteUserData.Visible ? 34 : 4;
                    _back.Enabled = true;
                    _next.Text = Removing ? "&Remove" : "&Install";
                    _next.Enabled = true;
                    _cancel.Visible = true;
                    break;

                case Page.Finish:
                    _back.Enabled = false;
                    _next.Text = "&Finish";
                    _next.Enabled = !_busy;
                    _cancel.Visible = false;
                    _openReadMe.Visible = _succeeded && !Removing && Payload.Has(Payload.ReadMeResource);
                    break;
            }

            // Focus the description so a screen reader reads the new page immediately.
            if (page != Page.Finish) _info.Focus();
        }

        private string BuildFolderPageInfo()
        {
            string what = Removing
                ? "Setup will remove the mod from this folder:"
                : "Setup will install the mod into this folder:";

            return what + "\r\n\r\n"
                + "Select Browse to look through your computer and pick the folder. "
                + "You can choose either the folder that holds Game.exe, or the folder you "
                + "extracted the game into - setup will find Game.exe inside it.";
        }

        private string BuildReadyPageInfo()
        {
            if (Removing)
            {
                bool data = HasUserData();
                bool settings = HasModSettings();
                string extra;
                if (data && settings)
                    extra = "\r\n\r\n" + UserDataPhrase("Your") + ", and the mod's settings, are kept "
                          + "unless you tick the boxes below. Tick both to leave nothing of the mod behind.";
                else if (data)
                    extra = "\r\n\r\n" + UserDataPhrase("Your") + " are kept unless you tick the box below.";
                else if (settings)
                    extra = "\r\n\r\nThe mod's settings are kept unless you tick the box below.";
                else
                    extra = "";
                return "Setup is ready to remove the mod from:\r\n\r\n" + _resolved + "\r\n\r\n"
                     + "Your original plugins.js will be put back and the mod's files deleted."
                     + extra + "\r\n\r\nSelect Remove to continue, or Back to change the folder.";
            }

            bool reinstall = (_resolved != null) && Installer.IsInstalled(_resolved);
            return "Setup is ready to install the mod into:\r\n\r\n" + _resolved + "\r\n\r\n"
                 + (reinstall
                     ? "The mod is already installed here and will be updated. Your waypoints and custom labels are kept."
                     : "Your plugins.js will be backed up first, and nothing else in the game is changed.")
                 + "\r\n\r\nMake sure the game is closed. Select Install to continue, or Back to change the folder.";
        }

        private bool HasUserData()
        {
            return _resolved != null && Installer.ExistingUserData(_resolved).Length > 0;
        }

        private bool HasModSettings()
        {
            return _resolved != null && GameConfig.HasModSettings(_resolved);
        }

        /// <summary>
        /// Names only the user data that is actually present, so the checkbox never offers
        /// to delete waypoints someone has never made.
        /// </summary>
        private string UserDataPhrase(string possessive)
        {
            bool waypoints = false;
            bool labels = false;

            if (_resolved != null)
            {
                foreach (string p in Installer.ExistingUserData(_resolved))
                {
                    string n = Path.GetFileName(p);
                    if (string.Equals(n, "waypoints.json", StringComparison.OrdinalIgnoreCase)) waypoints = true;
                    else if (string.Equals(n, "entity_labels.json", StringComparison.OrdinalIgnoreCase)) labels = true;
                }
            }

            if (waypoints && !labels) return possessive + " saved waypoints";
            if (labels && !waypoints) return possessive + " custom entity labels";
            return possessive + " saved waypoints and custom entity labels";
        }

        private void OnBack(object sender, EventArgs e)
        {
            if (_page == Page.Folder) GoTo(Page.Welcome);
            else if (_page == Page.Ready) GoTo(Page.Folder);
        }

        private void OnNext(object sender, EventArgs e)
        {
            switch (_page)
            {
                case Page.Welcome:
                    GoTo(Page.Folder);
                    break;

                case Page.Folder:
                    if (_resolved == null)
                    {
                        // Rather than a dead Next button with no explanation, say what is wrong.
                        MessageBox.Show(this,
                            "Setup still needs the game folder.\r\n\r\n" + _folderState.Text
                            + "\r\n\r\nSelect Browse to pick the folder.",
                            "Choose a folder", MessageBoxButtons.OK, MessageBoxIcon.Information);
                        _browse.Focus();
                        return;
                    }
                    if (Removing && !Installer.HasAnythingToRemove(_resolved))
                    {
                        MessageBox.Show(this,
                            "There is no trace of the mod in that folder - no files, no saved waypoints "
                            + "and no leftover settings - so there is nothing to remove.",
                            "Nothing to remove", MessageBoxButtons.OK, MessageBoxIcon.Information);
                        return;
                    }
                    GoTo(Page.Ready);
                    break;

                case Page.Ready:
                    Execute();
                    break;

                case Page.Finish:
                    Close();
                    break;
            }
        }

        private void OnCancel(object sender, EventArgs e)
        {
            if (_busy) return;
            Close();
        }

        /// <summary>Enter on a read-only box would otherwise be swallowed by the multiline control.</summary>
        private void OnReadOnlyBoxKeyDown(object sender, KeyEventArgs e)
        {
            if (e.KeyCode == Keys.Enter && _next.Enabled)
            {
                e.Handled = true;
                e.SuppressKeyPress = true;
                OnNext(this, EventArgs.Empty);
            }
        }

        //--- folder page -----------------------------------------------------

        private void OnBrowse(object sender, EventArgs e)
        {
            string start = _folder.Text.Trim().Trim('"');
            if (start.Length == 0 || !DirectoryExists(start))
            {
                start = Environment.GetFolderPath(Environment.SpecialFolder.UserProfile);
            }

            string picked = FolderPicker.Pick(this,
                "Select the game folder (the one containing Game.exe)", start);

            if (picked != null)
            {
                _folder.Text = picked;
                _folderState.Focus();   // read the verdict on the pick straight away
            }
        }

        private void StartBackgroundScan()
        {
            _scanning = true;

            Thread t = new Thread(delegate ()
            {
                string found = null;
                try { found = Detect.Search(); }
                catch (Exception) { }

                string result = found;
                try { BeginInvoke((MethodInvoker)delegate { OnScanFinished(result); }); }
                // Window closed mid-scan. ObjectDisposedException derives from this one.
                catch (InvalidOperationException) { }
            });
            t.IsBackground = true;
            t.Start();
        }

        private void OnScanFinished(string found)
        {
            _scanning = false;

            // Never stomp on a folder the user picked while the scan was running.
            if (found != null && _folder.Text.Trim().Length == 0) _folder.Text = found;
            if (_page == Page.Folder) UpdateFolderState();
        }

        private void UpdateFolderState()
        {
            string root = _folder.Text.Trim().Trim('"');
            _resolved = null;
            string message;

            if (root.Length == 0)
            {
                message = _scanning
                    ? "Setup is still looking for your game folder. Select Browse to pick it yourself."
                    : "No folder chosen yet. Select Browse to pick one.";
            }
            else if (!DirectoryExists(root))
            {
                message = "That folder does not exist. Select Browse to pick one.";
            }
            else
            {
                // Two levels: enough for "the folder I extracted" wrapping the game folder,
                // without wandering off into unrelated parts of the disk.
                string[] matches = Installer.ResolveGameFolders(root, 2);

                if (matches.Length == 0)
                {
                    message = "Setup cannot find Game.exe and a www folder in there.\r\n"
                            + "Pick the game's own folder, or the folder you extracted the game into.";
                }
                else if (matches.Length > 1)
                {
                    message = "There is more than one copy of the game in there. "
                            + "Please pick just one of them, for example:\r\n" + matches[0];
                }
                else
                {
                    _resolved = matches[0];
                    bool installed = Installer.IsInstalled(_resolved);

                    string where = string.Equals(_resolved, root, StringComparison.OrdinalIgnoreCase)
                        ? "Game found in this folder."
                        : "Game found in: " + _resolved;

                    string what;
                    if (installed) what = "The mod is currently installed here.";
                    else if (Installer.HasAnythingToRemove(_resolved))
                        what = "The mod is not installed here, but some of its files or settings are still here.";
                    else what = "The mod is not installed here yet.";

                    message = where + "\r\n" + what;
                }
            }

            _folderState.Text = message;
        }

        private static bool DirectoryExists(string path)
        {
            try { return Directory.Exists(path); }
            catch (ArgumentException) { return false; }
            catch (IOException) { return false; }
        }

        //--- doing the work --------------------------------------------------

        private void Execute()
        {
            string root = _resolved;
            if (root == null) { GoTo(Page.Folder); return; }
            if (GameIsRunning()) return;

            bool removing = Removing;
            bool deleteUserData = removing && _deleteUserData.Visible && _deleteUserData.Checked;
            bool deleteSettings = removing && _deleteSettings.Visible && _deleteSettings.Checked;

            _busy = true;
            _succeeded = false;
            _log.Clear();
            GoTo(Page.Finish);

            _heading.Text = removing ? "Removing the mod..." : "Installing the mod...";
            _info.Text = "Please wait.";
            Cursor = Cursors.WaitCursor;
            Application.DoEvents();

            string errorText = null;
            try
            {
                if (removing) Installer.Uninstall(root, deleteUserData, deleteSettings, Log);
                else Installer.Install(root, Log);
                _succeeded = true;
            }
            catch (UnauthorizedAccessException)
            {
                Log("FAILED: Windows denied permission to change files in " + root);
                Cursor = Cursors.Default;
                _busy = false;
                if (OfferElevation(root)) return;   // relaunching elevated; this window is closing
                errorText =
                    "Windows would not let setup change files in:\r\n" + root + "\r\n\r\n"
                    + "Close this window, right-click the setup program, and choose "
                    + "\"Run as administrator\", then try again.";
            }
            catch (IOException ex)
            {
                Log("FAILED: " + ex.Message);
                errorText = "Setup could not finish:\r\n\r\n" + ex.Message
                          + "\r\n\r\nIf the game is open, close it completely and run setup again.";
            }
            catch (Exception ex)
            {
                Log("FAILED: " + ex.Message);
                errorText = "Setup could not finish:\r\n\r\n" + ex.Message;
            }
            finally
            {
                Cursor = Cursors.Default;
                _busy = false;
            }

            if (_succeeded)
            {
                _heading.Text = removing ? "The mod has been removed" : "Installation complete";
                _info.Text = removing
                    ? "The mod has been removed and your game folder is back to normal.\r\n\r\n"
                      + "Select Finish to close setup."
                    : "The mod is installed in:\r\n" + root + "\r\n\r\n"
                      + "Start the game with Game.exe. The full key list is in "
                      + Path.GetFileName(Paths.ReadMe(root)) + ", saved next to Game.exe, "
                      + "and you can open it now with the Open Read Me button.\r\n\r\n"
                      + "Select Finish to close setup.";
            }
            else
            {
                _heading.Text = removing ? "Could not remove the mod" : "Could not install the mod";
                _info.Text = errorText;
            }

            GoTo(Page.Finish);
            _info.Focus();   // read the outcome
        }

        /// <summary>Returns true if an elevated relaunch was started and this window is closing.</summary>
        private bool OfferElevation(string root)
        {
            DialogResult ans = MessageBox.Show(this,
                "Windows denied permission to change files in:\r\n" + root + "\r\n\r\n"
                + "This usually means the game is somewhere protected, such as Program Files.\r\n\r\n"
                + "Restart setup as administrator and try again?",
                "Administrator rights needed", MessageBoxButtons.YesNo, MessageBoxIcon.Warning,
                MessageBoxDefaultButton.Button1);
            if (ans != DialogResult.Yes) return false;

            try
            {
                ProcessStartInfo psi = new ProcessStartInfo(Application.ExecutablePath);
                psi.Arguments = "\"" + root + "\"";
                psi.UseShellExecute = true;
                psi.Verb = "runas";
                Process.Start(psi);
                Close();
                return true;
            }
            catch (Exception)
            {
                // User dismissed the UAC prompt, or policy blocks elevation.
                return false;
            }
        }

        /// <summary>
        /// NW.js games hold their native DLLs open. Copying over a running game fails
        /// halfway, which is far worse than refusing up front.
        /// </summary>
        private bool GameIsRunning()
        {
            Process[] running;
            try { running = Process.GetProcessesByName("Game"); }
            catch (Exception) { return false; }

            try
            {
                if (running.Length == 0) return false;

                MessageBox.Show(this,
                    "Blackmoon Prophecy appears to be running.\r\n\r\n"
                    + "Close the game completely, then select " + (Removing ? "Remove" : "Install") + " again.",
                    "Close the game first", MessageBoxButtons.OK, MessageBoxIcon.Warning);
                return true;
            }
            finally
            {
                foreach (Process p in running) p.Dispose();
            }
        }

        private void OnOpenReadMe(object sender, EventArgs e)
        {
            try
            {
                string target = (_resolved != null) ? Paths.ReadMe(_resolved) : null;
                if (target == null || !File.Exists(target))
                {
                    target = Path.Combine(Path.GetTempPath(), "Blackmoon-Accessibility-ReadMe.txt");
                    Payload.Extract(Payload.ReadMeResource, target);
                }
                ProcessStartInfo psi = new ProcessStartInfo(target);
                psi.UseShellExecute = true;
                Process.Start(psi);
            }
            catch (Exception ex)
            {
                MessageBox.Show(this, "Could not open the read me: " + ex.Message,
                    ModName, MessageBoxButtons.OK, MessageBoxIcon.Warning);
            }
        }

        private void Log(string line)
        {
            _log.AppendText(line + "\r\n");
        }

        protected override void OnFormClosing(FormClosingEventArgs e)
        {
            if (_busy) { e.Cancel = true; return; }
            base.OnFormClosing(e);
        }
    }

    internal static class Program
    {
        [STAThread]
        internal static void Main(string[] args)
        {
            // WinForms ships its post-4.7.1 accessibility improvements behind opt-in
            // switches normally set in an app.config. This installer is deliberately a
            // single file with no config beside it, so they get set here instead - first
            // thing in Main, before WinForms reads and caches them.
            //
            // The baseline MSAA tree that NVDA and JAWS read is correct either way; these
            // switches improve the UI Automation view that newer tooling prefers.
            EnableModernAccessibility();

            Application.EnableVisualStyles();
            Application.SetCompatibleTextRenderingDefault(false);

            // An elevated relaunch passes the already-chosen folder straight back in.
            string initial = (args != null && args.Length > 0) ? args[0] : null;
            Application.Run(new WizardForm(initial));
        }

        private static void EnableModernAccessibility()
        {
            string[] switches =
            {
                "Switch.System.Windows.Forms.UseLegacyAccessibilityFeatures",
                "Switch.System.Windows.Forms.UseLegacyAccessibilityFeatures.2",
                "Switch.System.Windows.Forms.UseLegacyAccessibilityFeatures.3",
                "Switch.System.Windows.Forms.UseLegacyAccessibilityFeatures.4"
            };
            foreach (string s in switches)
            {
                try { AppContext.SetSwitch(s, false); }
                catch (Exception) { } // an older framework that lacks the switch is no worse off
            }
        }
    }
}
