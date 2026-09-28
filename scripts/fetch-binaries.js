// Downloads the yt-dlp and ffmpeg binaries bundled into the installer.
//
// They are not committed to the repo: they are large, and they carry their own
// licences. `npm run dist` fetches them first, so a fresh clone can build.
//
// Binaries land in resources/bin/<platform>-<arch>/, and electron-builder picks
// the matching directory per target through the substitution in extraResources.
// This matters because the macOS build produces both an arm64 and an x64 dmg:
// one shared directory would put a single architecture's ffmpeg into both, and
// the mismatched copy cannot run.
//
// Windows and macOS are supported. On Linux the app finds yt-dlp and ffmpeg on
// PATH instead, so nothing is bundled there.

const fs = require("fs");
const path = require("path");
const https = require("https");
const { execFileSync } = require("child_process");
const crypto = require("crypto");

const BIN_ROOT = path.join(__dirname, "..", "resources", "bin");
const PLATFORM = process.platform;

// Which architectures to fetch for the host platform. The defaults match the
// targets in the electron-builder config; BUILD_ARCH narrows it to one.
function targetArches() {
  if (process.env.BUILD_ARCH) return [process.env.BUILD_ARCH];
  if (PLATFORM === "darwin") return ["arm64", "x64"];
  return ["x64"];
}

// yt-dlp publishes a per-platform binary with every release. The macOS build is
// universal, so the same file serves both arm64 and x64.
const YTDLP = {
  win32: {
    x64: {
      url: "https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp.exe",
      out: "yt-dlp.exe",
    },
  },
  darwin: {
    arm64: {
      url: "https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp_macos",
      out: "yt-dlp",
    },
    x64: {
      url: "https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp_macos",
      out: "yt-dlp",
    },
  },
};

// ffmpeg has no official binaries, so these are the long-standing community
// static builds. gyan.dev for Windows, martin-riedl for macOS because it
// publishes arm64 as well as x86_64.
const FFMPEG = {
  win32: {
    x64: {
      url: "https://www.gyan.dev/ffmpeg/builds/ffmpeg-release-essentials.zip",
      out: "ffmpeg.exe",
    },
  },
  darwin: {
    arm64: {
      url: "https://ffmpeg.martin-riedl.de/redirect/latest/macos/arm64/release/ffmpeg.zip",
      out: "ffmpeg",
    },
    x64: {
      url: "https://ffmpeg.martin-riedl.de/redirect/latest/macos/amd64/release/ffmpeg.zip",
      out: "ffmpeg",
    },
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

// Retries a few times. The macOS ffmpeg host answers its redirect endpoint with
// an intermittent 404, and a transient blip should not fail a whole CI build.
async function getWithRetry(url, dest, attempts = 3) {
  let last;
  for (let i = 1; i <= attempts; i++) {
    try {
      await get(url, dest);
      return;
    } catch (err) {
      last = err;
      fs.rmSync(dest, { force: true });
      if (i < attempts) {
        console.warn(`  attempt ${i} failed (${err.message}), retrying`);
        await new Promise((r) => setTimeout(r, 2000 * i));
      }
    }
  }
  throw last;
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

// __MACOSX holds resource-fork stubs that carry the same names as the real
// files, so it has to be skipped or the wrong file gets copied out.
function findFile(dir, name) {
  const found = [];
  (function walk(d) {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      if (e.name === "__MACOSX") continue;
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name === name) found.push(p);
    }
  })(dir);
  return found[0] || null;
}

async function fetchArch(arch) {
  const yt = (YTDLP[PLATFORM] || {})[arch];
  const ff = (FFMPEG[PLATFORM] || {})[arch];
  if (!yt || !ff) {
    throw new Error(`No binary sources defined for ${PLATFORM}/${arch}`);
  }

  const dir = path.join(BIN_ROOT, `${PLATFORM}-${arch}`);
  fs.mkdirSync(dir, { recursive: true });
  console.log(`\n${PLATFORM}-${arch}`);

  const ytPath = path.join(dir, yt.out);
  if (fs.existsSync(ytPath)) {
    console.log(`  ${yt.out} already present, skipping`);
  } else {
    console.log("  downloading yt-dlp...");
    await getWithRetry(yt.url, ytPath);
    await verifyYtDlp(ytPath, path.basename(yt.url));
    if (PLATFORM !== "win32") fs.chmodSync(ytPath, 0o755);
  }

  const ffPath = path.join(dir, ff.out);
  if (fs.existsSync(ffPath)) {
    console.log(`  ${ff.out} already present, skipping`);
  } else {
    console.log("  downloading ffmpeg...");
    const zip = path.join(dir, "_ffmpeg.zip");
    await getWithRetry(ff.url, zip);
    console.log("  extracting...");
    const tmp = path.join(dir, "_ffmpeg");
    unzip(zip, tmp);
    const src = findFile(tmp, ff.out);
    if (!src) throw new Error(`ffmpeg not found in archive for ${arch}`);
    fs.copyFileSync(src, ffPath);
    if (PLATFORM !== "win32") fs.chmodSync(ffPath, 0o755);
    fs.rmSync(tmp, { recursive: true, force: true });
    fs.rmSync(zip, { force: true });
  }

  for (const f of [yt.out, ff.out]) {
    const p = path.join(dir, f);
    if (fs.existsSync(p)) {
      console.log(`  ${f}  ${(fs.statSync(p).size / 1048576).toFixed(1)} MB`);
    }
  }
}

async function main() {
  if (PLATFORM !== "win32" && PLATFORM !== "darwin") {
    console.log(
      `No binaries bundled on ${PLATFORM}. Install yt-dlp and ffmpeg with your\n` +
      `package manager; the app finds them on PATH.`
    );
    return;
  }

  for (const arch of targetArches()) {
    await fetchArch(arch);
  }
}

main().catch((err) => {
  console.error("Failed:", err.message);
  process.exit(1);
});
