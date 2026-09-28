// Persistent record of every track ever saved.
//
// The queue lives in memory and is wiped when the app quits, so it cannot
// answer anything about the library as a whole. This is a small JSON store
// that survives restarts and backs the stats panel.
//
// Writes are atomic (temp file then rename) because the app can be killed at
// any moment, and a half-written JSON file would lose the whole history.

const fs = require("fs");
const path = require("path");

const STORE_DIR =
  process.env.DJ_DATA_DIR || path.join(__dirname, ".data");
const STORE_PATH = path.join(STORE_DIR, "library.json");

const EMPTY = { version: 1, tracks: {} };

let cache = null;
let writeTimer = null;

function load() {
  if (cache) return cache;
  try {
    const raw = fs.readFileSync(STORE_PATH, "utf8");
    const parsed = JSON.parse(raw);
    // Tolerate an older or hand-edited file rather than throwing on startup.
    cache = parsed && typeof parsed === "object" && parsed.tracks
      ? { version: 1, tracks: parsed.tracks }
      : { ...EMPTY };
  } catch {
    cache = { ...EMPTY };
  }
  return cache;
}

function flush() {
  if (!cache) return;
  try {
    fs.mkdirSync(STORE_DIR, { recursive: true });
    const tmp = STORE_PATH + ".tmp";
    fs.writeFileSync(tmp, JSON.stringify(cache), "utf8");
    fs.renameSync(tmp, STORE_PATH);
  } catch (err) {
    console.error("[library] could not save:", err.message);
  }
}

// Batch rapid writes: a playlist import can add dozens of tracks at once.
function scheduleFlush() {
  if (writeTimer) return;
  writeTimer = setTimeout(() => {
    writeTimer = null;
    flush();
  }, 400);
  if (writeTimer.unref) writeTimer.unref();
}

// Keyed by the relative fileName, which is stable and unique per saved file.
function recordDownload(entry) {
  const db = load();
  const key = entry.fileName;
  if (!key) return;

  const existing = db.tracks[key] || {};
  db.tracks[key] = {
    fileName: key,
    title: entry.title ?? existing.title ?? "",
    artist: entry.artist ?? existing.artist ?? "",
    format: entry.format ?? existing.format ?? "mp3",
    source: entry.source ?? existing.source ?? "unknown",
    durationSec: entry.durationSec ?? existing.durationSec ?? null,
    bytes: entry.bytes ?? existing.bytes ?? null,
    tags: entry.tags ?? existing.tags ?? [],
    // Filled in later by the analyser.
    bpm: existing.bpm ?? null,
    musicalKey: existing.musicalKey ?? null,
    camelot: existing.camelot ?? null,
    keyConfidence: existing.keyConfidence ?? null,
    firstSeen: existing.firstSeen ?? new Date().toISOString(),
    // How many times this track has been downloaded again.
    downloads: (existing.downloads ?? 0) + 1,
    played: existing.played ?? 0,
  };
  scheduleFlush();
  return db.tracks[key];
}

function setAnalysis(fileName, { bpm, musicalKey, camelot, keyConfidence }) {
  const db = load();
  const t = db.tracks[fileName];
  if (!t) return null;
  if (bpm != null) t.bpm = bpm;
  if (musicalKey != null) t.musicalKey = musicalKey;
  if (camelot != null) t.camelot = camelot;
  if (keyConfidence != null) t.keyConfidence = keyConfidence;
  t.analysedAt = new Date().toISOString();
  scheduleFlush();
  return t;
}

function markPlayed(fileName) {
  const db = load();
  const t = db.tracks[fileName];
  if (!t) return null;
  t.played = (t.played ?? 0) + 1;
  t.lastPlayed = new Date().toISOString();
  scheduleFlush();
  return t;
}

// Play counts imported from rekordbox, which knows what was actually played.
function mergeExternalPlays(rows) {
  const db = load();
  let matched = 0;
  for (const row of rows) {
    // Match on filename alone: the paths differ between apps.
    const base = path.basename(row.fileName || "").toLowerCase();
    if (!base) continue;
    const hit = Object.keys(db.tracks).find(
      (k) => path.basename(k).toLowerCase() === base
    );
    if (!hit) continue;
    const t = db.tracks[hit];
    if (row.playCount != null) t.externalPlays = row.playCount;
    if (row.cuePoints != null) t.cuePoints = row.cuePoints;
    if (row.bpm != null && t.bpm == null) t.bpm = row.bpm;
    if (row.key && !t.camelot) t.camelot = row.key;
    matched++;
  }
  scheduleFlush();
  return matched;
}

function allTracks() {
  return Object.values(load().tracks);
}

function getTrack(fileName) {
  return load().tracks[fileName] || null;
}

// Tracks that still need BPM/key analysis.
function pendingAnalysis() {
  return allTracks().filter((t) => t.bpm == null || t.camelot == null);
}

module.exports = {
  STORE_PATH,
  recordDownload,
  setAnalysis,
  markPlayed,
  mergeExternalPlays,
  allTracks,
  getTrack,
  pendingAnalysis,
  flush,
};
