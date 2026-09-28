// Aggregates the library store into the numbers the dashboard shows.
//
// Every figure here is derived from tracks actually on disk. Anything that
// cannot be computed is returned as null so the UI can say so rather than
// showing a confident zero.

const fs = require("fs");
const path = require("path");
const library = require("./library");
// Resolved lazily: musicHandler reads DOWNLOADS_DIR at import time, and when
// this module is pulled in before dotenv has run it would capture the default
// rather than the configured library path.
function downloadsDir() {
  return require("./musicHandler").DOWNLOADS_DIR;
}

// Genre is inferred from the tags the source supplied. YouTube has no genre
// field, but its tag list usually contains something usable. Ordered so the
// more specific label wins over the broad one.
const GENRE_RULES = [
  ["Drum & Bass", ["drum and bass", "drum & bass", "dnb", "jungle", "liquid dnb"]],
  ["Dubstep / Bass", ["dubstep", "riddim", "bass music", "trap", "future bass"]],
  ["UK Garage", ["uk garage", "ukg", "2-step", "speed garage", "bassline"]],
  ["Hard Techno", ["hard techno", "hardgroove", "schranz", "hardstyle", "hardcore"]],
  ["Melodic House & Techno", ["melodic techno", "melodic house", "afterlife", "organic house"]],
  ["Tech House", ["tech house", "techhouse", "minimal house"]],
  ["Techno", ["techno", "peak time", "industrial techno", "acid techno"]],
  ["Progressive House", ["progressive house", "progressive"]],
  ["Deep House", ["deep house", "lo-fi house"]],
  ["Afro House", ["afro house", "afro tech", "amapiano"]],
  ["Disco / Funk", ["disco", "nu disco", "funk", "boogie"]],
  ["House", ["house music", "house"]],
  ["Trance", ["trance", "psytrance", "uplifting"]],
  ["Electro / Breaks", ["electro", "breakbeat", "breaks"]],
  ["Ambient", ["ambient", "downtempo", "chillout"]],
  ["Hip Hop / R&B", ["hip hop", "hip-hop", "rap", "r&b", "rnb"]],
  ["Pop", ["pop music", "pop"]],
  ["Rock", ["rock", "metal", "punk", "indie"]],
];

function inferGenre(tags) {
  if (!Array.isArray(tags) || !tags.length) return null;
  const hay = tags.map((t) => String(t).toLowerCase());
  for (const [label, needles] of GENRE_RULES) {
    if (needles.some((n) => hay.some((t) => t.includes(n)))) return label;
  }
  return null;
}

function pct(n, total) {
  return total > 0 ? Math.round((n / total) * 1000) / 10 : 0;
}

function median(values) {
  if (!values.length) return null;
  const s = [...values].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : Math.round(((s[mid - 1] + s[mid]) / 2) * 10) / 10;
}

// Camelot to a readable key name, for the key panel subtitle.
const CAMELOT_NAMES = {
  "1A": "Ab minor", "1B": "B major", "2A": "Eb minor", "2B": "F# major",
  "3A": "Bb minor", "3B": "Db major", "4A": "F minor", "4B": "Ab major",
  "5A": "C minor", "5B": "Eb major", "6A": "G minor", "6B": "Bb major",
  "7A": "D minor", "7B": "F major", "8A": "A minor", "8B": "C major",
  "9A": "E minor", "9B": "G major", "10A": "B minor", "10B": "D major",
  "11A": "F# minor", "11B": "A major", "12A": "Db minor", "12B": "E major",
};

function build() {
  const tracks = library.allTracks();

  // Only count what is still on disk: a deleted file should leave the stats.
  const present = tracks.filter((t) => {
    if (!t.fileName) return false;
    try {
      return fs.existsSync(path.join(downloadsDir(), ...t.fileName.split("/")));
    } catch {
      return false;
    }
  });

  const total = present.length;
  const totalBytes = present.reduce((n, t) => n + (t.bytes || 0), 0);
  const totalSecs = present.reduce((n, t) => n + (t.durationSec || 0), 0);

  // Format split.
  const formats = {};
  for (const t of present) {
    const f = (t.format || "mp3").toLowerCase();
    formats[f] = formats[f] || { tracks: 0, bytes: 0 };
    formats[f].tracks++;
    formats[f].bytes += t.bytes || 0;
  }
  const formatRows = Object.entries(formats)
    .map(([format, v]) => ({ format, ...v, share: pct(v.tracks, total) }))
    .sort((a, b) => b.tracks - a.tracks);

  const lossless = present.filter((t) =>
    ["flac", "wav"].includes((t.format || "").toLowerCase())
  ).length;

  // Where tracks came from.
  const sources = {};
  for (const t of present) {
    const s = t.source || "unknown";
    sources[s] = (sources[s] || 0) + 1;
  }
  const sourceRows = Object.entries(sources)
    .map(([source, count]) => ({ source, count, share: pct(count, total) }))
    .sort((a, b) => b.count - a.count);

  // Genre, inferred from source tags.
  const genres = {};
  let genreKnown = 0;
  for (const t of present) {
    const g = t.genre || inferGenre(t.tags);
    if (!g) continue;
    genreKnown++;
    genres[g] = genres[g] || { tracks: 0, bytes: 0, bpms: [] };
    genres[g].tracks++;
    genres[g].bytes += t.bytes || 0;
    if (t.bpm) genres[g].bpms.push(t.bpm);
  }
  const genreRows = Object.entries(genres)
    .map(([genre, v]) => ({
      genre,
      tracks: v.tracks,
      bytes: v.bytes,
      share: pct(v.tracks, genreKnown),
      avgBpm: v.bpms.length
        ? Math.round(v.bpms.reduce((a, b) => a + b, 0) / v.bpms.length)
        : null,
    }))
    .sort((a, b) => b.tracks - a.tracks);

  // BPM spread.
  const bpms = present.map((t) => t.bpm).filter((b) => typeof b === "number");
  bpms.sort((a, b) => a - b);
  let bpmRange = null;
  if (bpms.length >= 4) {
    // Interquartile range reads better as a "sweet spot" than min to max,
    // which one outlier can stretch across the whole scale.
    const q1 = bpms[Math.floor(bpms.length * 0.25)];
    const q3 = bpms[Math.floor(bpms.length * 0.75)];
    bpmRange = { low: Math.round(q1), high: Math.round(q3) };
  } else if (bpms.length) {
    bpmRange = { low: Math.round(bpms[0]), high: Math.round(bpms[bpms.length - 1]) };
  }

  // Key distribution.
  const keys = {};
  for (const t of present) {
    if (!t.camelot) continue;
    keys[t.camelot] = (keys[t.camelot] || 0) + 1;
  }
  const analysedKeys = Object.values(keys).reduce((a, b) => a + b, 0);
  const keyRows = Object.entries(keys)
    .map(([camelot, count]) => ({
      camelot,
      name: CAMELOT_NAMES[camelot] || camelot,
      count,
      share: pct(count, analysedKeys),
    }))
    .sort((a, b) => b.count - a.count);

  // Most played. Prefers rekordbox counts when imported, since this app never
  // plays audio and only knows what was marked played by hand.
  const played = present
    .map((t) => ({
      title: t.title || path.basename(t.fileName),
      artist: t.artist || "",
      plays: t.externalPlays ?? t.played ?? 0,
      cuePoints: t.cuePoints ?? null,
      bpm: t.bpm,
      camelot: t.camelot,
      external: t.externalPlays != null,
    }))
    .filter((t) => t.plays > 0)
    .sort((a, b) => b.plays - a.plays)
    .slice(0, 3);

  const analysed = present.filter((t) => t.bpm != null).length;

  return {
    totals: {
      tracks: total,
      bytes: totalBytes,
      hours: Math.round((totalSecs / 3600) * 10) / 10,
      avgDurationSec: total ? Math.round(totalSecs / total) : null,
      losslessShare: pct(lossless, total),
      analysed,
      pendingAnalysis: total - analysed,
    },
    formats: formatRows,
    sources: sourceRows,
    genres: genreRows,
    genreCoverage: { known: genreKnown, total },
    bpm: {
      range: bpmRange,
      median: median(bpms),
      count: bpms.length,
    },
    keys: keyRows.slice(0, 6),
    keyCoverage: { known: analysedKeys, total },
    mostPlayed: played,
    // Lets the UI say where play data came from, or that there is none yet.
    playSource: played.some((p) => p.external)
      ? "rekordbox"
      : played.length
        ? "manual"
        : null,
  };
}

module.exports = { build, inferGenre };
