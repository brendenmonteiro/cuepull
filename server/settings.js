// User settings.
//
// Kept in the same userData folder as the library store, so settings survive
// an update. The .env still works and wins on first run, but anything changed
// in the app is written here.

const fs = require("fs");
const path = require("path");

const STORE_DIR = process.env.DJ_DATA_DIR || path.join(__dirname, ".data");
const STORE_PATH = path.join(STORE_DIR, "settings.json");

// Format preference. "Best available" walks the list in order and takes the
// first that a source actually has, rather than failing when a track has no
// lossless version anywhere.
const FORMAT_MODES = {
  mp3: { label: "MP3 only", chain: ["mp3"] },
  flac: { label: "FLAC only", chain: ["flac"] },
  wav: { label: "WAV only", chain: ["wav"] },
  "flac-then-mp3": { label: "FLAC if available, else MP3", chain: ["flac", "mp3"] },
  "wav-then-flac": { label: "WAV if available, else FLAC", chain: ["wav", "flac"] },
  "wav-flac-mp3": { label: "Best available (WAV, FLAC, MP3)", chain: ["wav", "flac", "mp3"] },
  "flac-wav-mp3": { label: "Best available (FLAC, WAV, MP3)", chain: ["flac", "wav", "mp3"] },
};

const DEFAULTS = {
  // Download behaviour
  formatMode: "mp3",
  downloadsDir: null, // null means fall back to the env value
  dateFolders: true, // group saves into DD-MM-YYYY subfolders
  // Search behaviour
  askExtended: true, // prompt Extended Mix vs Original on single searches
  preferExtended: true, // for playlists, where there is no prompt
  // Analysis
  analyseOnDownload: true,
  // Appearance
  theme: "system", // system | light | dark
  // Credentials
  spotifyClientId: "",
  spotifyClientSecret: "",
};

let cache = null;

function load() {
  if (cache) return cache;
  let stored = {};
  try {
    stored = JSON.parse(fs.readFileSync(STORE_PATH, "utf8"));
  } catch {
    // No settings yet, or the file is unreadable. Defaults apply.
  }
  // Seed from the environment on first run so an existing .env keeps working.
  cache = {
    ...DEFAULTS,
    downloadsDir: process.env.DOWNLOADS_DIR || DEFAULTS.downloadsDir,
    spotifyClientId: process.env.SPOTIFY_CLIENT_ID || "",
    spotifyClientSecret: process.env.SPOTIFY_CLIENT_SECRET || "",
    ...(stored && typeof stored === "object" ? stored : {}),
  };
  return cache;
}

function save(patch) {
  const current = load();
  const next = { ...current };

  // Validate rather than trusting whatever the page sent.
  if (typeof patch.formatMode === "string" && FORMAT_MODES[patch.formatMode]) {
    next.formatMode = patch.formatMode;
  }
  if (typeof patch.downloadsDir === "string" && patch.downloadsDir.trim()) {
    next.downloadsDir = patch.downloadsDir.trim();
  }
  for (const k of ["dateFolders", "askExtended", "preferExtended", "analyseOnDownload"]) {
    if (typeof patch[k] === "boolean") next[k] = patch[k];
  }
  if (["system", "light", "dark"].includes(patch.theme)) next.theme = patch.theme;
  for (const k of ["spotifyClientId", "spotifyClientSecret"]) {
    if (typeof patch[k] === "string") next[k] = patch[k].trim();
  }

  cache = next;
  try {
    fs.mkdirSync(STORE_DIR, { recursive: true });
    const tmp = STORE_PATH + ".tmp";
    fs.writeFileSync(tmp, JSON.stringify(next, null, 2), "utf8");
    fs.renameSync(tmp, STORE_PATH);
  } catch (err) {
    console.error("[settings] could not save:", err.message);
  }
  return next;
}

// The formats to try, in order, for a given request. An explicit choice in the
// UI always wins over the stored preference.
function formatChain(explicit) {
  if (explicit && ["mp3", "flac", "wav"].includes(explicit)) return [explicit];
  const mode = FORMAT_MODES[load().formatMode] || FORMAT_MODES.mp3;
  return mode.chain;
}

module.exports = { load, save, formatChain, FORMAT_MODES, DEFAULTS, STORE_PATH };
