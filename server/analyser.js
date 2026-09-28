// BPM and musical key detection.
//
// Runs locally with Essentia (the same library Spotify used to derive the
// audio features it retired in 2024), compiled to WebAssembly so there is no
// native build step. Nothing is uploaded: the audio is decoded to mono 16 kHz
// with the ffmpeg we already ship, analysed in process, then the temp file is
// deleted.
//
// Roughly 2 to 3 seconds per track. Results are cached in the library store so
// a track is never analysed twice.

const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFile } = require("child_process");
const { getBinaries } = require("./binaries");

// Camelot wheel. DJs mix by these, not by "B flat minor".
const CAMELOT = {
  "Ab minor": "1A",  "B major": "1B",
  "Eb minor": "2A",  "F# major": "2B",
  "Bb minor": "3A",  "Db major": "3B",
  "F minor": "4A",   "Ab major": "4B",
  "C minor": "5A",   "Eb major": "5B",
  "G minor": "6A",   "Bb major": "6B",
  "D minor": "7A",   "F major": "7B",
  "A minor": "8A",   "C major": "8B",
  "E minor": "9A",   "G major": "9B",
  "B minor": "10A",  "D major": "10B",
  "F# minor": "11A", "A major": "11B",
  "Db minor": "12A", "E major": "12B",
};

// Essentia reports sharps; the table above uses flats for the keys DJs name
// that way. Normalise before lookup.
const ENHARMONIC = {
  "A#": "Bb", "C#": "Db", "D#": "Eb", "G#": "Ab",
  "Gb": "F#", "Cb": "B",  "Fb": "E",  "E#": "F", "B#": "C",
};

function toCamelot(key, scale) {
  if (!key || !scale) return null;
  const root = ENHARMONIC[key] || key;
  return CAMELOT[`${root} ${scale.toLowerCase()}`] || null;
}

// Decode to the smallest thing Essentia can work with. Mono 16 kHz is plenty
// for tempo and chroma, and keeps analysis fast.
function decodeToPcm(file) {
  return new Promise((resolve, reject) => {
    const { ffmpeg } = getBinaries();
    if (!ffmpeg) return reject(new Error("ffmpeg not available"));

    const tmp = path.join(
      os.tmpdir(),
      `cuepull-analyse-${Date.now()}-${Math.random().toString(36).slice(2)}.wav`
    );
    execFile(
      ffmpeg,
      ["-y", "-hide_banner", "-loglevel", "error",
       "-i", file,
       // Only the first 3 minutes. Long extended mixes do not need a full pass
       // and it keeps the worst case bounded.
       "-t", "180",
       "-ac", "1", "-ar", "16000", "-f", "wav", tmp],
      { timeout: 120000 },
      (err) => {
        if (err) {
          fs.rmSync(tmp, { force: true });
          return reject(new Error(`decode failed: ${err.message}`));
        }
        try {
          const buf = fs.readFileSync(tmp);
          fs.rmSync(tmp, { force: true });
          const dataIdx = buf.indexOf("data") + 8;
          if (dataIdx < 8) return reject(new Error("unexpected wav layout"));
          const samples = new Float32Array((buf.length - dataIdx) / 2);
          for (let i = 0; i < samples.length; i++) {
            samples[i] = buf.readInt16LE(dataIdx + i * 2) / 32768;
          }
          resolve(samples);
        } catch (e) {
          fs.rmSync(tmp, { force: true });
          reject(e);
        }
      }
    );
  });
}

let essentiaInstance = null;
function getEssentia() {
  if (essentiaInstance) return essentiaInstance;
  // Loading the wasm module takes a moment, so do it once and keep it.
  const { Essentia, EssentiaWASM } = require("essentia.js");
  essentiaInstance = new Essentia(EssentiaWASM);
  return essentiaInstance;
}

const SR = 16000;

async function analyseFile(file) {
  if (!fs.existsSync(file)) throw new Error("file not found");

  const samples = await decodeToPcm(file);
  if (!samples.length) throw new Error("no audio decoded");

  const essentia = getEssentia();
  const vec = essentia.arrayToVector(samples);

  let bpm = null;
  try {
    const r = essentia.PercivalBpmEstimator(vec, 1024, 2048, 128, 128, 210, 50, SR);
    bpm = r && isFinite(r.bpm) ? Math.round(r.bpm * 10) / 10 : null;
    // Beat trackers routinely lock onto half or double time. Dance music
    // almost always sits in 80 to 180, so fold an out of range result back
    // into that window rather than reporting 75 for a 150 BPM track.
    if (bpm != null) {
      while (bpm < 80) bpm = Math.round(bpm * 2 * 10) / 10;
      while (bpm > 180) bpm = Math.round((bpm / 2) * 10) / 10;
    }
  } catch (err) {
    console.warn("[analyser] bpm failed:", err.message);
  }

  let musicalKey = null;
  let camelot = null;
  let keyConfidence = null;
  try {
    const k = essentia.KeyExtractor(
      vec, true, 4096, 4096, 12, 3500, 60, 25, 0.2,
      "bgate", SR, 0.0001, 440, "cosine", "hann"
    );
    if (k && k.key) {
      musicalKey = `${k.key} ${k.scale}`;
      camelot = toCamelot(k.key, k.scale);
      keyConfidence = isFinite(k.strength)
        ? Math.round(k.strength * 100) / 100
        : null;
    }
  } catch (err) {
    console.warn("[analyser] key failed:", err.message);
  }

  return { bpm, musicalKey, camelot, keyConfidence };
}

// AcousticBrainz has BPM and key for ~7.5 million recordings under CC0. It
// stopped taking submissions in 2022, so recent releases are usually absent,
// but it is free and instant when a track is there. Needs a MusicBrainz id,
// which we only have if the source metadata supplied one.
function lookupAcousticBrainz(mbid) {
  return new Promise((resolve) => {
    if (!mbid) return resolve(null);
    const https = require("https");
    const req = https.get(
      `https://acousticbrainz.org/api/v1/${mbid}/low-level`,
      { timeout: 6000, headers: { "User-Agent": "Cuepull/1.0" } },
      (res) => {
        if (res.statusCode !== 200) {
          res.resume();
          return resolve(null);
        }
        let body = "";
        res.on("data", (c) => (body += c));
        res.on("end", () => {
          try {
            const j = JSON.parse(body);
            const bpm = j?.rhythm?.bpm ?? null;
            const key = j?.tonal?.key_key ?? null;
            const scale = j?.tonal?.key_scale ?? null;
            resolve({
              bpm: bpm != null ? Math.round(bpm * 10) / 10 : null,
              musicalKey: key && scale ? `${key} ${scale}` : null,
              camelot: toCamelot(key, scale),
              keyConfidence: j?.tonal?.key_strength ?? null,
              source: "acousticbrainz",
            });
          } catch {
            resolve(null);
          }
        });
      }
    );
    req.on("error", () => resolve(null));
    req.on("timeout", () => {
      req.destroy();
      resolve(null);
    });
  });
}

module.exports = { analyseFile, lookupAcousticBrainz, toCamelot, CAMELOT };
