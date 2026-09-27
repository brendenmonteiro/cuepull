// Writes SHA-256 checksums for everything in dist/ that ships to a user.
//
// The installer is not code signed, so Windows SmartScreen warns on first run.
// A published checksum is what lets a careful person confirm the file they
// downloaded is byte for byte the one that was built, which is the actual
// concern behind that warning.

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const DIST = path.join(__dirname, "..", "dist");

function sha256(file) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash("sha256");
    const stream = fs.createReadStream(file);
    stream.on("data", (c) => hash.update(c));
    stream.on("end", () => resolve(hash.digest("hex")));
    stream.on("error", reject);
  });
}

async function main() {
  if (!fs.existsSync(DIST)) {
    console.error("No dist/ directory. Run the build first.");
    process.exit(1);
  }

  // Only the artifacts a user actually downloads.
  const targets = fs
    .readdirSync(DIST)
    .filter((f) => /\.(exe|msi|zip|dmg|AppImage|deb|rpm)$/i.test(f))
    .filter((f) => !f.includes("__uninstaller"))
    .sort();

  if (!targets.length) {
    console.error("No release artifacts found in dist/.");
    process.exit(1);
  }

  const lines = [];
  for (const name of targets) {
    const full = path.join(DIST, name);
    const hash = await sha256(full);
    const mb = (fs.statSync(full).size / 1048576).toFixed(1);
    lines.push(`${hash}  ${name}`);
    console.log(`${name}  ${mb} MB`);
    console.log(`  sha256 ${hash}`);
  }

  const out = path.join(DIST, "SHA256SUMS.txt");
  fs.writeFileSync(out, lines.join("\n") + "\n", "utf8");
  console.log(`\nWrote ${path.relative(path.join(__dirname, ".."), out)}`);
  console.log("Upload this alongside the installer on the release page.");
}

main().catch((err) => {
  console.error("Failed:", err.message);
  process.exit(1);
});
