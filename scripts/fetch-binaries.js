// Downloads the yt-dlp and ffmpeg binaries that get bundled into the installer.
// They are NOT committed to the repo (≈117 MB, and they have their own
// licences), so `npm run dist` calls this first on a fresh clone.
//
// Windows x64 only for now, that is what the installer targets.

const fs = require("fs");
const path = require("path");
const https = require("https");
const { execFileSync } = require("child_process");
const crypto = require("crypto");

const BIN_DIR = path.join(__dirname, "..", "resources", "bin");

const YTDLP_URL =
  "https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp.exe";
// Gyan's "essentials" build: a static ffmpeg.exe with no extra DLLs.
const FFMPEG_ZIP =
  "https://www.gyan.dev/ffmpeg/builds/ffmpeg-release-essentials.zip";

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
            if (pct >= lastPct + 10) {
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
// tampered or truncated download fails the build instead of being packaged
// into an installer other people run.
async function verifyYtDlp(file) {
  const sumsUrl =
    "https://github.com/yt-dlp/yt-dlp/releases/latest/download/SHA2-256SUMS";
  const tmp = file + ".sums";
  try {
    await get(sumsUrl, tmp);
    const line = fs
      .readFileSync(tmp, "utf8")
      .split(/\r?\n/)
      .find((l) => l.trim().endsWith("yt-dlp.exe"));
    fs.rmSync(tmp, { force: true });
    if (!line) {
      console.warn("  could not find a published checksum, skipping verify");
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
        `yt-dlp checksum mismatch.
  expected ${expected}
  got      ${actual}`
      );
    }
    console.log("  checksum verified");
  } catch (err) {
    fs.rmSync(tmp, { force: true });
    if (/mismatch/.test(err.message)) throw err;
    console.warn("  checksum check skipped:", err.message);
  }
}

async function main() {
  if (process.platform !== "win32") {
    console.error("This script currently fetches Windows x64 binaries only.");
    console.error("On macOS/Linux install yt-dlp and ffmpeg with your package");
    console.error("manager, the app finds them on PATH.");
    process.exit(1);
  }

  fs.mkdirSync(BIN_DIR, { recursive: true });

  const ytDlp = path.join(BIN_DIR, "yt-dlp.exe");
  if (fs.existsSync(ytDlp)) {
    console.log("yt-dlp.exe already present, skipping");
  } else {
    console.log("Downloading yt-dlp...");
    await get(YTDLP_URL, ytDlp);
    await verifyYtDlp(ytDlp);
    console.log("  done");
  }

  const ffmpeg = path.join(BIN_DIR, "ffmpeg.exe");
  if (fs.existsSync(ffmpeg)) {
    console.log("ffmpeg.exe already present, skipping");
  } else {
    console.log("Downloading ffmpeg (~115 MB)...");
    const zip = path.join(BIN_DIR, "_ffmpeg.zip");
    await get(FFMPEG_ZIP, zip);
    console.log("  extracting...");
    const tmp = path.join(BIN_DIR, "_ffmpeg");
    fs.rmSync(tmp, { recursive: true, force: true });
    // Expand-Archive ships with Windows; avoids adding an unzip dependency.
    execFileSync(
      "powershell",
      ["-NoProfile", "-Command", `Expand-Archive -Path "${zip}" -DestinationPath "${tmp}" -Force`],
      { stdio: "inherit" }
    );
    // The zip nests everything under ffmpeg-<version>-essentials_build/bin.
    const found = [];
    (function walk(dir) {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) walk(p);
        else if (e.name.toLowerCase() === "ffmpeg.exe") found.push(p);
      }
    })(tmp);
    if (!found.length) throw new Error("ffmpeg.exe not found in archive");
    fs.copyFileSync(found[0], ffmpeg);
    fs.rmSync(tmp, { recursive: true, force: true });
    fs.rmSync(zip, { force: true });
    console.log("  done");
  }

  for (const f of ["yt-dlp.exe", "ffmpeg.exe"]) {
    const p = path.join(BIN_DIR, f);
    const mb = (fs.statSync(p).size / 1048576).toFixed(1);
    console.log(`  ${f}  ${mb} MB`);
  }
}

main().catch((err) => {
  console.error("Failed:", err.message);
  process.exit(1);
});
