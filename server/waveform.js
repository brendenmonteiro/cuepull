// Waveform peaks for the deck displays.
//
// Decoding a ten minute track in the browser to draw a waveform locks the UI
// for seconds. ffmpeg is already bundled and is far faster, so peaks are
// computed here and cached on disk. A cached read is a few milliseconds, which
// is what makes loading a deck feel instant.
//
// Two resolutions per track, because the decks need different things:
//   overview  a fixed number of buckets for the whole track, the zoomed out
//             strip you click to seek
//   detail    a fixed number of buckets per second, the scrolling view near
//             the playhead
//
// Peaks are min and max per bucket rather than an average, so transients stay
// visible instead of smearing into a sausage.

const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");
const { execFile } = require("child_process");
const { getBinaries } = require("./binaries");

const OVERVIEW_BUCKETS = 1600; // whole track, wide enough for a 1080p strip
const DETAIL_PER_SECOND = 140; // scrolling view
const SAMPLE_RATE = 8000; // plenty for an envelope, and quick to decode

function cacheDir() {
  const base = process.env.DJ_DATA_DIR || path.join(__dirname, ".data");
  return path.join(base, "waveforms");
}

// Keyed by path, size and mtime, so replacing a file invalidates its peaks
// without needing to hash the audio itself.
function cacheKey(file, stat) {
  return crypto
    .createHash("sha1")
    .update(`${file}|${stat.size}|${Math.round(stat.mtimeMs)}`)
    .digest("hex");
}

// Decode to mono PCM at a low sample rate. Whole track, unlike the analyser,
// which only needs the first three minutes to find a tempo.
function decode(file) {
  return new Promise((resolve, reject) => {
    const { ffmpeg } = getBinaries();
    if (!ffmpeg) return reject(new Error("ffmpeg not available"));

    const tmp = path.join(
      os.tmpdir(),
      `cuepull-wave-${Date.now()}-${Math.random().toString(36).slice(2)}.raw`
    );

    execFile(
      ffmpeg,
      ["-y", "-hide_banner", "-loglevel", "error",
       "-i", file,
       "-ac", "1",
       "-ar", String(SAMPLE_RATE),
       // Raw signed 16 bit, so there is no header to parse past.
       "-f", "s16le", tmp],
      { timeout: 180000, maxBuffer: 1 << 20 },
      (err) => {
        if (err) {
          fs.rmSync(tmp, { force: true });
          return reject(new Error(`decode failed: ${err.message}`));
        }
        try {
          const buf = fs.readFileSync(tmp);
          fs.rmSync(tmp, { force: true });
          resolve(buf);
        } catch (e) {
          fs.rmSync(tmp, { force: true });
          reject(e);
        }
      }
    );
  });
}

// Min and max per bucket, each quantised to one signed byte and packed as
// interleaved pairs. A detail track is tens of thousands of buckets, and as
// JSON arrays of numbers that runs to 200KB per track; as bytes it is a
// quarter of that, and socket.io sends a Buffer as binary rather than text.
// The client reads it back as an Int8Array.
function bucketise(buf, buckets) {
  const samples = Math.floor(buf.length / 2);
  if (!samples || buckets < 1) return Buffer.alloc(0);

  const per = samples / buckets;
  const out = Buffer.alloc(buckets * 2);

  for (let b = 0; b < buckets; b++) {
    const start = Math.floor(b * per);
    const end = Math.min(Math.floor((b + 1) * per), samples);

    let lo = 0;
    let hi = 0;
    for (let i = start; i < end; i++) {
      const v = buf.readInt16LE(i * 2);
      if (v < lo) lo = v;
      if (v > hi) hi = v;
    }
    // -127..127, so the client divides by 127 for a -1..1 float.
    out.writeInt8(Math.max(-127, Math.round((lo / 32768) * 127)), b * 2);
    out.writeInt8(Math.min(127, Math.round((hi / 32768) * 127)), b * 2 + 1);
  }

  return out;
}

// ── Beat grid ───────────────────────────────────────────────────────────
//
// A full beat tracker is a second wasm pass and several seconds per track.
// For a preview player that is not worth it, because the tempo is already
// known from analysis and electronic music holds a fixed grid. So: find where
// the first strong transient lands, then step forward by the beat interval.
//
// That gives a grid that is right for four-to-the-floor material and drifts on
// anything played by hand. It is a visual aid for lining up a mix, not a claim
// about the music, and the deck labels it as derived from the bpm.

// Onset strength as the rise in energy between short windows. Crude next to a
// spectral flux detector, but a kick drum is mostly low frequency energy
// appearing suddenly, which this catches.
function firstDownbeat(buf, bpm, sampleRate) {
  const beatSec = 60 / bpm;
  const win = Math.max(1, Math.floor(sampleRate * 0.01)); // 10ms
  const samples = Math.floor(buf.length / 2);
  // Only look through the first few beats: the grid repeats, so the earliest
  // strong onset is enough to phase-lock the whole track.
  const limit = Math.min(samples, Math.floor(sampleRate * beatSec * 8));
  if (limit < win * 4) return 0;

  const energies = [];
  for (let s = 0; s + win <= limit; s += win) {
    let sum = 0;
    for (let i = s; i < s + win; i++) {
      const v = buf.readInt16LE(i * 2) / 32768;
      sum += v * v;
    }
    energies.push(Math.sqrt(sum / win));
  }
  if (energies.length < 3) return 0;

  // Rise over the previous window, which is what a transient looks like.
  let bestIdx = 0;
  let bestRise = 0;
  for (let i = 1; i < energies.length; i++) {
    const rise = energies[i] - energies[i - 1];
    if (rise > bestRise) {
      bestRise = rise;
      bestIdx = i;
    }
  }

  // No clear transient, so a grid from zero is as good a guess as any.
  if (bestRise <= 0.01) return 0;

  const onset = (bestIdx * win) / sampleRate;
  // Fold back to the first beat of the track so the grid starts at the top.
  return onset % beatSec;
}

// In flight builds, so two decks loading the same track decode it once.
const pending = new Map();

// Cache layout: a one line JSON header, a newline, then the two peak blocks
// back to back. Keeping the peaks as raw bytes avoids inflating them into a
// JSON number array on every read, which was most of the cost.
function readCache(out) {
  const buf = fs.readFileSync(out);
  const nl = buf.indexOf(0x0a);
  if (nl < 0) throw new Error("no header");
  const head = JSON.parse(buf.toString("utf8", 0, nl));
  if (head.version !== 2) throw new Error("old version");

  const oBytes = head.overviewBuckets * 2;
  const start = nl + 1;
  return {
    version: 2,
    durationSec: head.durationSec,
    sampleRate: head.sampleRate,
    grid: head.grid ?? null,
    overview: {
      buckets: head.overviewBuckets,
      peaks: buf.subarray(start, start + oBytes),
    },
    detail: {
      buckets: head.detailBuckets,
      peaks: buf.subarray(start + oBytes),
    },
  };
}

async function build(file, bpm = null) {
  const stat = fs.statSync(file);
  // bpm is part of the key: re-analysing a track to a different tempo has to
  // rebuild the grid rather than serve the old one.
  const key = cacheKey(file, stat) + (bpm ? `-${Math.round(bpm * 10)}` : "");
  const out = path.join(cacheDir(), `${key}.wf`);

  try {
    return readCache(out);
  } catch {
    // Not cached yet, unreadable, or written by an older version. Rebuild.
  }

  if (pending.has(key)) return pending.get(key);

  const job = (async () => {
    const buf = await decode(file);
    const samples = Math.floor(buf.length / 2);
    const durationSec = samples / SAMPLE_RATE;

    const detailBuckets = Math.max(
      1,
      Math.min(Math.round(durationSec * DETAIL_PER_SECOND), 200000)
    );

    const overviewPeaks = bucketise(buf, OVERVIEW_BUCKETS);
    const detailPeaks = bucketise(buf, detailBuckets);

    const usableBpm = isFinite(bpm) && bpm > 20 && bpm < 400 ? Number(bpm) : null;
    const grid = usableBpm
      ? {
          bpm: usableBpm,
          beatSec: 60 / usableBpm,
          offsetSec:
            Math.round(firstDownbeat(buf, usableBpm, SAMPLE_RATE) * 1000) / 1000,
        }
      : null;

    const payload = {
      version: 2,
      durationSec: Math.round(durationSec * 1000) / 1000,
      sampleRate: SAMPLE_RATE,
      grid,
      overview: { buckets: OVERVIEW_BUCKETS, peaks: overviewPeaks },
      detail: { buckets: detailBuckets, peaks: detailPeaks },
    };

    try {
      fs.mkdirSync(cacheDir(), { recursive: true });
      const header = Buffer.from(
        JSON.stringify({
          version: 2,
          durationSec: payload.durationSec,
          sampleRate: SAMPLE_RATE,
          grid,
          overviewBuckets: OVERVIEW_BUCKETS,
          detailBuckets,
        }) + "\n",
        "utf8"
      );
      const tmp = `${out}.tmp`;
      fs.writeFileSync(tmp, Buffer.concat([header, overviewPeaks, detailPeaks]));
      fs.renameSync(tmp, out);
    } catch (err) {
      // A cache miss every time is slow, not broken.
      console.error("[waveform] could not cache:", err.message);
    }

    return payload;
  })();

  pending.set(key, job);
  try {
    return await job;
  } finally {
    pending.delete(key);
  }
}

// Drop cached peaks for files that no longer exist, so the folder does not
// grow without bound as a library churns.
function prune(validFiles) {
  const dir = cacheDir();
  let removed = 0;
  try {
    const keep = new Set();
    for (const f of validFiles) {
      try {
        keep.add(cacheKey(f, fs.statSync(f)));
      } catch {
        // Gone already.
      }
    }
    for (const name of fs.readdirSync(dir)) {
      if (!name.endsWith(".wf")) continue;
      if (keep.has(name.slice(0, -3))) continue;
      fs.rmSync(path.join(dir, name), { force: true });
      removed++;
    }
  } catch {
    // No cache directory yet.
  }
  return removed;
}

module.exports = { build, prune, cacheDir, OVERVIEW_BUCKETS, DETAIL_PER_SECOND };
