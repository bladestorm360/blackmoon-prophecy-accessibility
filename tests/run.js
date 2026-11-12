// Run every test and aggregate the result.
//
//   node tests/run.js            all of them, one line each
//   node tests/run.js -v         stream each test's own output too
//   node tests/run.js shop       just the named one(s)
//
// Exit 0 only if every test passed. A test that cannot find the installed game exits 2
// and is reported as skipped rather than failed, so this stays runnable on a machine that has
// the repo but not the game.
//
// Discovery is "every .js here except run.js and _-prefixed helpers", so adding a test file is
// all it takes to have it run — an explicit name list is one more thing to forget to update.
const { spawnSync } = require('child_process');
const fs = require('fs'), path = require('path');

const argv = process.argv.slice(2);
const verbose = argv.includes('-v') || argv.includes('--verbose');
const wanted = argv.filter(a => !a.startsWith('-'));

const all = fs.readdirSync(__dirname)
  .filter(f => f.endsWith('.js') && f !== 'run.js' && !f.startsWith('_'))
  .sort();

const targets = wanted.length
  ? all.filter(f => wanted.some(w => f === w || f === w + '.js' || f.replace(/\.js$/, '') === w))
  : all;

if (!targets.length) {
  console.error('no test matched ' + JSON.stringify(wanted) + '\nknown: ' + all.join(', '));
  process.exit(2);
}

let failed = 0, skipped = 0;
for (const f of targets) {
  const t0 = Date.now();
  const r = spawnSync(process.execPath, [path.join(__dirname, f)],
                      { encoding: 'utf8', stdio: verbose ? 'inherit' : 'pipe' });
  const ms = Date.now() - t0;
  const code = r.status;
  const label = code === 0 ? 'PASS' : code === 2 ? 'SKIP' : 'FAIL';
  if (code === 2) skipped++; else if (code !== 0) failed++;
  console.log(`${label}  ${f.padEnd(13)} ${String(ms).padStart(5)} ms`);
  // On failure show the test's own output, so a CI-ish run explains itself without -v.
  if (code !== 0 && !verbose && r.stdout) {
    const lines = r.stdout.split('\n').filter(l => /FAIL|CHECK\(S\)/.test(l));
    lines.forEach(l => console.log('        ' + l.trim()));
    if (r.stderr) console.log('        ' + r.stderr.trim().split('\n').join('\n        '));
  }
}

console.log(`\n${targets.length - failed - skipped}/${targets.length} passed` +
            (skipped ? `, ${skipped} skipped (no game install)` : '') +
            (failed ? `, ${failed} FAILED` : ''));
process.exit(failed ? 1 : 0);
