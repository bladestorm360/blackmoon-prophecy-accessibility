// gen_sounds.js — build-time WAV generator for the Blackmoon Prophecy accessibility mod.
//
// Ports the procedural tone math from ff1-screen-reader (Utils/ToneGenerator.cs +
// Utils/SoundConstants.cs) to Node, writing real .wav files that the mod plays via the
// Web Audio API. These are the mod's own sound effects — no game assets are used.
//
// Usage:  node gen_sounds.js [outputDir]
//   outputDir defaults to ../dist/bma-payload/audio
//
// All output is 22050 Hz, 16-bit PCM. Wall tones use the sustain (cycle-aligned) path so
// they loop seamlessly under Web Audio's AudioBufferSourceNode.loop.

'use strict';
const fs = require('fs');
const path = require('path');

const SAMPLE_RATE = 22050;

// ---- constants (from SoundConstants.cs) ----
const WALL = {
  freq: { N: 294, S: 165, E: 247, W: 196 },          // Em7 chord: E3 G3 B3 D4
  volMul: { base: 0.12, N: 1.00, S: 0.70, E: 0.85, W: 0.85 },
  pan: { N: 0.5, S: 0.5, E: 1.0, W: 0.0 },            // 0=left 0.5=center 1=right
  sustainMs: 200,
};
const WALL_BUMP = { freq: 27, ms: 60, vol: 0.506 };
const FOOTSTEP  = { freq: 500, ms: 25, vol: 0.1436 };
const BEACON    = { freqNorth: 400, ms: 60, vol: 0.9 }; // pan/pitch/gain applied at runtime

// Deterministic PRNG (seed 42) so builds are reproducible — mirrors FF1's new Random(42).
function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ---- WAV writer ----
function writeWav(filePath, channels, samples /* Int16Array interleaved */) {
  const blockAlign = channels * 2;
  const dataSize = samples.length * 2;
  const buf = Buffer.alloc(44 + dataSize);
  buf.write('RIFF', 0, 'ascii');
  buf.writeInt32LE(36 + dataSize, 4);
  buf.write('WAVE', 8, 'ascii');
  buf.write('fmt ', 12, 'ascii');
  buf.writeInt32LE(16, 16);
  buf.writeInt16LE(1, 20);                 // PCM
  buf.writeInt16LE(channels, 22);
  buf.writeInt32LE(SAMPLE_RATE, 24);
  buf.writeInt32LE(SAMPLE_RATE * blockAlign, 28);
  buf.writeInt16LE(blockAlign, 32);
  buf.writeInt16LE(16, 34);
  buf.write('data', 36, 'ascii');
  buf.writeInt32LE(dataSize, 40);
  for (let i = 0; i < samples.length; i++) buf.writeInt16LE(samples[i], 44 + i * 2);
  fs.writeFileSync(filePath, buf);
  return dataSize + 44;
}

function clampI16(v) {
  const s = Math.round(v * 32767);
  return s < -32768 ? -32768 : s > 32767 ? 32767 : s;
}

// ---- generators (ports of ToneGenerator.cs) ----

// GenerateStereoTone with sustain=true: cycle-aligned flat-amplitude sine, pan baked in.
function stereoSustainTone(freq, ms, vol, pan) {
  const samplesPerCycle = SAMPLE_RATE / freq;
  const target = Math.floor((SAMPLE_RATE * ms) / 1000);
  let numCycles = Math.round(target / samplesPerCycle);
  if (numCycles < 1) numCycles = 1;
  const samples = Math.round(numCycles * samplesPerCycle);

  const panAngle = pan * Math.PI / 2;
  const left = vol * Math.cos(panAngle);
  const right = vol * Math.sin(panAngle);

  const out = new Int16Array(samples * 2);
  for (let i = 0; i < samples; i++) {
    const t = i / SAMPLE_RATE;
    const s = Math.sin(2 * Math.PI * freq * t);
    out[i * 2] = clampI16(s * left);
    out[i * 2 + 1] = clampI16(s * right);
  }
  return out;
}

// GenerateStereoTone with sustain=false: attack(10%)+decay envelope. Used for the beacon ping.
function stereoEnvelopeTone(freq, ms, vol, pan) {
  const samples = Math.floor((SAMPLE_RATE * ms) / 1000);
  const attackSamples = Math.max(1, Math.floor(samples / 10));
  const panAngle = pan * Math.PI / 2;
  const left = vol * Math.cos(panAngle);
  const right = vol * Math.sin(panAngle);

  const out = new Int16Array(samples * 2);
  for (let i = 0; i < samples; i++) {
    const t = i / SAMPLE_RATE;
    const attack = Math.min(1.0, i / attackSamples);
    const decay = (samples - i) / samples;
    const s = Math.sin(2 * Math.PI * freq * t) * attack * decay;
    out[i * 2] = clampI16(s * left);
    out[i * 2 + 1] = clampI16(s * right);
  }
  return out;
}

// GenerateThudTone (mono) → stereo. Soft quadratic attack, filtered-noise mix, linear decay.
function thudStereo(freq, ms, vol) {
  const samples = Math.floor((SAMPLE_RATE * ms) / 1000);
  const attackSamples = Math.max(1, Math.floor(samples / 4));
  const rand = mulberry32(42);
  let filteredNoise = 0;
  const out = new Int16Array(samples * 2);
  for (let i = 0; i < samples; i++) {
    const t = i / SAMPLE_RATE;
    const attackLinear = Math.min(1.0, i / attackSamples);
    const attack = attackLinear * attackLinear;
    const decay = (samples - i) / samples;
    const envelope = attack * decay;
    const sine = Math.sin(2 * Math.PI * freq * t);
    const rawNoise = rand() * 2 - 1;
    filteredNoise = filteredNoise * 0.9 + rawNoise * 0.1;
    const noise = filteredNoise * 0.3 * attack;
    const v = (sine * 0.7 + noise) * vol * envelope;
    const s = clampI16(v);
    out[i * 2] = s; out[i * 2 + 1] = s;
  }
  return out;
}

// GenerateClickTone (mono) → stereo. Filtered-noise click, exponential decay.
function clickStereo(freq, ms, vol) {
  const samples = Math.floor((SAMPLE_RATE * ms) / 1000);
  const rand = mulberry32(42);
  const out = new Int16Array(samples * 2);
  for (let i = 0; i < samples; i++) {
    const decay = Math.exp(-10.0 * i / samples);
    const noise = (rand() * 2 - 1) * vol * decay;
    const s = clampI16(noise);
    out[i * 2] = s; out[i * 2 + 1] = s;
  }
  return out;
}

// ---- main ----
function main() {
  const outDir = process.argv[2] || path.join(__dirname, '..', 'dist', 'bma-payload', 'audio');
  fs.mkdirSync(outDir, { recursive: true });

  const files = {
    'wall_n.wav':   stereoSustainTone(WALL.freq.N, WALL.sustainMs, WALL.volMul.base * WALL.volMul.N, WALL.pan.N),
    'wall_s.wav':   stereoSustainTone(WALL.freq.S, WALL.sustainMs, WALL.volMul.base * WALL.volMul.S, WALL.pan.S),
    'wall_e.wav':   stereoSustainTone(WALL.freq.E, WALL.sustainMs, WALL.volMul.base * WALL.volMul.E, WALL.pan.E),
    'wall_w.wav':   stereoSustainTone(WALL.freq.W, WALL.sustainMs, WALL.volMul.base * WALL.volMul.W, WALL.pan.W),
    'wall_bump.wav': thudStereo(WALL_BUMP.freq, WALL_BUMP.ms, WALL_BUMP.vol),
    'footstep.wav':  clickStereo(FOOTSTEP.freq, FOOTSTEP.ms, FOOTSTEP.vol),
    'beacon.wav':    stereoEnvelopeTone(BEACON.freqNorth, BEACON.ms, BEACON.vol, 0.5),
  };

  let total = 0;
  for (const [name, data] of Object.entries(files)) {
    const bytes = writeWav(path.join(outDir, name), 2, data);
    total += bytes;
    console.log(`  ${name.padEnd(14)} ${data.length / 2} frames  ${bytes} bytes`);
  }
  console.log(`Wrote ${Object.keys(files).length} files (${total} bytes) to ${outDir}`);
}

main();
