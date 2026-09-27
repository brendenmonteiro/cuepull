// binaries.js: resolve absolute paths to yt-dlp and ffmpeg.
//
// Why this exists: the app used to call spawn("yt-dlp", …), relying on PATH.
// That works in a dev shell but fails with ENOENT when the app is launched from
// the Start Menu or Explorer, because a packaged GUI app does not inherit the
// user's full PATH. On Windows it is worse than that. CreateProcess (used by
// execFile/spawn without a shell) does not apply PATHEXT, so even a correct PATH
// can fail to find "yt-dlp" when the real file is "yt-dlp.exe".
//
// So: always resolve to a full absolute path, and never depend on PATH.

const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");

const isWindows = process.platform === "win32";
const exe = (name) => (isWindows ? `${name}.exe` : name);

// Bundled copies shipped with the packaged app (electron-builder extraResources
// puts them in resources/bin). DJ_BIN_DIR is set by the Electron main process.
function bundledDir() {
  return process.env.DJ_BIN_DIR || path.join(__dirname, "..", "resources", "bin");
}

// WinGet installs yt-dlp and ffmpeg into stable package directories. The ffmpeg
// package nests the binaries inside a *version-stamped* folder
// (ffmpeg-N-124716-g054dffd133-win64-gpl/bin), which changes on every update ,
// so that inner directory has to be discovered rather than hardcoded.
function wingetCandidates(name) {
  const local = process.env.LOCALAPPDATA;
  if (!isWindows || !local) return [];
  const pkgs = path.join(local, "Microsoft", "WinGet", "Packages");

  if (name === "yt-dlp") {
    return [path.join(pkgs, "yt-dlp.yt-dlp_Microsoft.Winget.Source_8wekyb3d8bbwe", "yt-dlp.exe")];
  }

  const ffRoot = path.join(pkgs, "yt-dlp.FFmpeg_Microsoft.Winget.Source_8wekyb3d8bbwe");
  let inner = [];
  try {
    inner = fs
      .readdirSync(ffRoot)
      .filter((d) => /^ffmpeg-.*win64/i.test(d))
      .map((d) => ({ d, mtime: fs.statSync(path.join(ffRoot, d)).mtimeMs }))
      .sort((a, b) => b.mtime - a.mtime) // newest install wins
      .map((x) => path.join(ffRoot, x.d, "bin", "ffmpeg.exe"));
  } catch {
    // ffmpeg not installed via WinGet, fall through to the other candidates.
  }
  return inner;
}

// Last resort: ask the OS where it would find the command.
function fromSystemPath(name) {
  try {
    const out = execFileSync(isWindows ? "where" : "which", [name], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    // "where" can return several lines; take the first that exists on disk.
    for (const line of out.split(/\r?\n/)) {
      const p = line.trim();
      if (p && fs.existsSync(p)) return p;
    }
  } catch {
    // Not on PATH.
  }
  return null;
}

// Resolution order, highest priority first:
//   1. explicit override (YTDLP_PATH / FFMPEG_PATH), lets the user point at a
//      newer copy than the bundled one, which matters because a stale yt-dlp
//      gets 403s from YouTube.
//   2. a copy installed via WinGet, the user can keep this current with
//      `yt-dlp -U`, so prefer it over the frozen bundled build.
//   3. the bundled copy, guarantees a fresh machine works at all.
//   4. bare PATH lookup.
function resolve(name, overrideEnv) {
  const candidates = [
    process.env[overrideEnv],
    ...wingetCandidates(name),
    path.join(bundledDir(), exe(name)),
  ].filter(Boolean);

  for (const c of candidates) {
    if (fs.existsSync(c)) return c;
  }
  return fromSystemPath(exe(name)) || fromSystemPath(name);
}

let cache = null;

// Resolved once and reused. Returns { ytDlp, ffmpeg, ffmpegDir, missing: [] }
// rather than throwing, so callers can surface a clear message instead of
// crashing the server on startup.
function getBinaries() {
  if (cache) return cache;

  const ytDlp = resolve("yt-dlp", "YTDLP_PATH");
  const ffmpeg = resolve("ffmpeg", "FFMPEG_PATH");
  const missing = [];
  if (!ytDlp) missing.push("yt-dlp");
  if (!ffmpeg) missing.push("ffmpeg");

  cache = {
    ytDlp,
    ffmpeg,
    // yt-dlp wants the *directory* for --ffmpeg-location.
    ffmpegDir: ffmpeg ? path.dirname(ffmpeg) : null,
    missing,
  };
  return cache;
}

// The path to hand execFile/spawn. Falls back to the bare name so behaviour in a
// dev shell is unchanged when resolution finds nothing.
function ytDlpPath() {
  return getBinaries().ytDlp || exe("yt-dlp");
}

// Args that tell yt-dlp exactly which ffmpeg to use. Without ffmpeg, every
// --extract-audio conversion (mp3/flac/wav) fails, so this is not optional.
function ffmpegArgs() {
  const { ffmpegDir } = getBinaries();
  return ffmpegDir ? ["--ffmpeg-location", ffmpegDir] : [];
}

module.exports = { getBinaries, ytDlpPath, ffmpegArgs };
