// Downloads the yt-dlp and ffmpeg binaries bundled into the installer.
//
// They are not committed to the repo: they are large, and they carry their own
// licences. `npm run dist` fetches them first, so a fresh clone can build.
//
// Windows and macOS are supported. On Linux the app finds yt-dlp and ffmpeg on
// PATH instead, so nothing is bundled there.

const fs = require("fs");
const path = require("path");
const https = require("https");
const { execFileSync } = require("child_process");
const crypto = require("crypto");

const BIN_DIR = path.join(__dirname, "..", "resources", "bin");

const PLATFORM = process.platform;
// electron-builder sets this when cross-building; otherwise use the host.
const ARCH = process.env.BUILD_ARCH || process.arch;

// yt-dlp publishes a per-platform binary with every release. The macOS build
// is universal, so one file covers Apple Silicon and Intel.
const YTDLP = {
  win32: {
    url: "https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp.exe",
    out: "yt-dlp.exe",
  },
  darwin: {
    url: "https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp_macos",
    out: "yt-dlp",
  },
};

// ffmpeg has no official binaries, so these are the long-standing community
// static builds. gyan.dev for Windows, martin-riedl for macOS because it
// publishes arm64 as well as x86_64.
const FFMPEG = {
  win32: {
    kind: "zip",
    url: "https://www.gyan.dev/ffmpeg/builds/ffmpeg-release-essentials.zip",
    out: "ffmpeg.exe",
  },
  darwin: {
    kind: "zip",
    url: (arch) =>
      `https://ffmpeg.martin-riedl.de/redirect/latest/macos/${
        arch === "arm64" ? "arm64" : "amd64"
      }/release/ffmpeg.zip`,
    out: "ffmpeg",
  },
};

function get(url, dest, redirects = 0) {
  return new Promise((resolve, reject) => {
    if (redirects > 10) return reject(new Error("Too many redirects"));
    https
      .get(url, { headers: { "User-Agent": "cuepull-build" } }, (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          res.resume();
          return resolve(get(res.headers.location, dest, redirects + 1));
        }
        if (res.statusCode !== 200) {
          res.resume();
          return reject(new Error(`${url} -> HTTP ${res.statusCode}`));
        }
        const total = Number(res.headers["content-length"]) || 0;
        let seen = 0;
        let lastPct = -1;
        const file = fs.createWriteStream(dest);
        res.on("data", (c) => {
          seen += c.length;
          if (total) {
            const pct = Math.floor((seen / total) * 100);
            if (pct >= lastPct + 20) {
              lastPct = pct;
              process.stdout.write(`  ${pct}%\r`);
            }
          }
        });
        res.pipe(file);
        file.on("finish", () => file.close(() => resolve()));
        file.on("error", reject);
      })
      .on("error", reject);
  });
}

// yt-dlp publishes SHA2-256SUMS with every release. Checking it means a
// tampered or truncated download fails the build rather than being packaged
// into an installer other people run.
async function verifyYtDlp(file, assetName) {
  const sumsUrl =
    "https://github.com/yt-dlp/yt-dlp/releases/latest/download/SHA2-256SUMS";
  const tmp = file + ".sums";
  try {
    await get(sumsUrl, tmp);
    const line = fs
      .readFileSync(tmp, "utf8")
      .split(/\r?\n/)
      .find((l) => l.trim().endsWith(assetName));
    fs.rmSync(tmp, { force: true });
    if (!line) {
      console.warn("  no published checksum for this asset, skipping verify");
      return;
    }
    const expected = line.trim().split(/\s+/)[0].toLowerCase();
    const actual = crypto
      .createHash("sha256")
      .update(fs.readFileSync(file))
      .digest("hex");
    if (actual !== expected) {
      fs.rmSync(file, { force: true });
      throw new Error(
        `yt-dlp checksum mismatch.\n  expected ${expected}\n  got      ${actual}`
      );
    }
    console.log("  checksum verified");
  } catch (err) {
    fs.rmSync(tmp, { force: true });
    if (/mismatch/.test(err.message)) throw err;
    console.warn("  checksum check skipped:", err.message);
  }
}

function unzip(zipPath, destDir) {
  fs.rmSync(destDir, { recursive: true, force: true });
  fs.mkdirSync(destDir, { recursive: true });
  if (PLATFORM === "win32") {
    // Expand-Archive ships with Windows, so no unzip dependency is needed.
    execFileSync(
      "powershell",
      ["-NoProfile", "-Command",
       `Expand-Archive -Path "${zipPath}" -DestinationPath "${destDir}" -Force`],
      { stdio: "inherit" }
    );
  } else {
    execFileSync("unzip", ["-o", "-q", zipPath, "-d", destDir], { stdio: "inherit" });
  }
}

function findFile(dir, name) {
  const found = [];
  (function walk(d) {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name === name || e.name === `${name}.exe`) found.push(p);
    }
  })(dir);
  return found[0] || null;
}

async function main() {
  if (PLATFORM !== "win32" && PLATFORM !== "darwin") {
    console.log(
      `No binaries bundled on ${PLATFORM}. Install yt-dlp and ffmpeg with your\n` +
      `package manager; the app finds them on PATH.`
    );
    return;
  }

  fs.mkdirSync(BIN_DIR, { recursive: true });

  // yt-dlp
  const yt = YTDLP[PLATFORM];
  const ytPath = path.join(BIN_DIR, yt.out);
  if (fs.existsSync(ytPath)) {
    console.log(`${yt.out} already present, skipping`);
  } else {
    console.log("Downloading yt-dlp...");
    await get(yt.url, ytPath);
    await verifyYtDlp(ytPath, path.basename(yt.url));
    if (PLATFORM !== "win32") fs.chmodSync(ytPath, 0o755);
    console.log("  done");
  }

  // ffmpeg
  const ff = FFMPEG[PLATFORM];
  const ffPath = path.join(BIN_DIR, ff.out);
  if (fs.existsSync(ffPath)) {
    console.log(`${ff.out} already present, skipping`);
  } else {
    const url = typeof ff.url === "function" ? ff.url(ARCH) : ff.url;
    console.log(`Downloading ffmpeg (${PLATFORM}/${ARCH})...`);
    const zip = path.join(BIN_DIR, "_ffmpeg.zip");
    await get(url, zip);
    console.log("  extracting...");
    const tmp = path.join(BIN_DIR, "_ffmpeg");
    unzip(zip, tmp);
    const src = findFile(tmp, ff.out.replace(/\.exe$/, ""));
    if (!src) throw new Error("ffmpeg not found in archive");
    fs.copyFileSync(src, ffPath);
    if (PLATFORM !== "win32") fs.chmodSync(ffPath, 0o755);
    fs.rmSync(tmp, { recursive: true, force: true });
    fs.rmSync(zip, { force: true });
    console.log("  done");
  }

  for (const f of [yt.out, ff.out]) {
    const p = path.join(BIN_DIR, f);
    if (fs.existsSync(p)) {
      console.log(`  ${f}  ${(fs.statSync(p).size / 1048576).toFixed(1)} MB`);
    }
  }
}

main().catch((err) => {
  console.error("Failed:", err.message);
  process.exit(1);
});
