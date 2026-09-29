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
  if (head.version !== 1) throw new Error("old version");

  const oBytes = head.overviewBuckets * 2;
  const start = nl + 1;
  return {
    version: 1,
    durationSec: head.durationSec,
    sampleRate: head.sampleRate,
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

async function build(file) {
  const stat = fs.statSync(file);
  const key = cacheKey(file, stat);
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

    const payload = {
      version: 1,
      durationSec: Math.round(durationSec * 1000) / 1000,
      sampleRate: SAMPLE_RATE,
      overview: { buckets: OVERVIEW_BUCKETS, peaks: overviewPeaks },
      detail: { buckets: detailBuckets, peaks: detailPeaks },
    };

    try {
      fs.mkdirSync(cacheDir(), { recursive: true });
      const header = Buffer.from(
        JSON.stringify({
          version: 1,
          durationSec: payload.durationSec,
          sampleRate: SAMPLE_RATE,
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
