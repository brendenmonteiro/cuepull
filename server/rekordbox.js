// Rekordbox collection XML: read and write.
//
// Rekordbox reads and writes a documented DJ_PLAYLISTS format. It is the same
// bridge Mixed In Key and Lexicon use, and it carries the two things this app
// cannot know on its own: how often a track was actually played, and where its
// cue points are.
//
// Export writes a collection with BPM and key already filled in, so tracks
// import pre-analysed instead of needing a rekordbox analysis pass.

const fs = require("fs");
const path = require("path");

// Minimal attribute reader. The format is flat: one TRACK element per track
// with everything in attributes, so a full XML parser would be overkill and
// another dependency to ship.
function attrs(tag) {
  const out = {};
  const re = /([A-Za-z]+)="([^"]*)"/g;
  let m;
  while ((m = re.exec(tag))) out[m[1]] = m[2];
  return out;
}

function decodeEntities(s) {
  return String(s)
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'");
}

function encodeEntities(s) {
  return String(s == null ? "" : s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

// Location is a file:// URL with percent encoding.
function locationToPath(loc) {
  if (!loc) return "";
  let p = loc.replace(/^file:\/\/localhost\//, "").replace(/^file:\/\//, "");
  try {
    p = decodeURIComponent(p);
  } catch {
    // Leave it as-is if it is not valid percent encoding.
  }
  return p.replace(/^\/+([A-Za-z]:)/, "$1");
}

function pathToLocation(abs) {
  const norm = abs.replace(/\\/g, "/");
  // Encode each segment, keeping the drive colon and separators intact.
  const encoded = norm
    .split("/")
    .map((seg) => (/^[A-Za-z]:$/.test(seg) ? seg : encodeURIComponent(seg)))
    .join("/");
  return `file://localhost/${encoded}`;
}

// Read a rekordbox export. Returns play counts, cue points, BPM and key.
function parseCollection(xmlPath) {
  const xml = fs.readFileSync(xmlPath, "utf8");
  const tracks = [];

  // Each TRACK either self-closes or wraps POSITION_MARK children.
  const trackRe = /<TRACK\s([^>]*?)(\/>|>([\s\S]*?)<\/TRACK>)/g;
  let m;
  while ((m = trackRe.exec(xml))) {
    const a = attrs(m[1]);
    // The PLAYLISTS section repeats TRACK elements with only a Key attribute;
    // skip those, they carry no metadata.
    if (!a.Location && !a.Name) continue;

    const inner = m[3] || "";
    const cues = (inner.match(/<POSITION_MARK\s/g) || []).length;
    const filePath = locationToPath(decodeEntities(a.Location || ""));

    tracks.push({
      name: decodeEntities(a.Name || ""),
      artist: decodeEntities(a.Artist || ""),
      genre: decodeEntities(a.Genre || ""),
      fileName: filePath ? path.basename(filePath) : "",
      filePath,
      bpm: a.AverageBpm ? parseFloat(a.AverageBpm) : null,
      // Tonality is Camelot only when rekordbox is set to alphanumeric key
      // display; otherwise it is a note name like "Abm".
      key: a.Tonality || null,
      playCount: a.PlayCount ? parseInt(a.PlayCount, 10) : null,
      rating: a.Rating ? parseInt(a.Rating, 10) : null,
      cuePoints: cues,
      totalTime: a.TotalTime ? parseInt(a.TotalTime, 10) : null,
    });
  }
  return tracks;
}

// Write a collection rekordbox can import.
function buildCollection(tracks, downloadsDir) {
  const rows = tracks
    .filter((t) => t.fileName)
    .map((t, i) => {
      const abs = path.join(downloadsDir, ...t.fileName.split("/"));
      const secs = t.durationSec ? Math.round(t.durationSec) : 0;
      const a = [
        `TrackID="${i + 1}"`,
        `Name="${encodeEntities(t.title || path.basename(t.fileName))}"`,
        `Artist="${encodeEntities(t.artist || "")}"`,
        `Kind="${(t.format || "mp3").toUpperCase()} File"`,
        t.bytes ? `Size="${t.bytes}"` : "",
        secs ? `TotalTime="${secs}"` : "",
        t.bpm ? `AverageBpm="${t.bpm.toFixed(2)}"` : "",
        t.camelot ? `Tonality="${encodeEntities(t.camelot)}"` : "",
        t.genre ? `Genre="${encodeEntities(t.genre)}"` : "",
        `DateAdded="${(t.firstSeen || new Date().toISOString()).slice(0, 10)}"`,
        `Location="${pathToLocation(abs)}"`,
      ]
        .filter(Boolean)
        .join(" ");
      return `    <TRACK ${a}/>`;
    });

  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<DJ_PLAYLISTS Version="1.0.0">',
    '  <PRODUCT Name="Cuepull" Version="1.0.0" Company="Cuepull"/>',
    `  <COLLECTION Entries="${rows.length}">`,
    ...rows,
    "  </COLLECTION>",
    "  <PLAYLISTS>",
    '    <NODE Type="0" Name="ROOT" Count="1">',
    `      <NODE Name="Cuepull" Type="1" KeyType="0" Entries="${rows.length}">`,
    ...rows.map((_, i) => `        <TRACK Key="${i + 1}"/>`),
    "      </NODE>",
    "    </NODE>",
    "  </PLAYLISTS>",
    "</DJ_PLAYLISTS>",
    "",
  ].join("\n");
}

function writeCollection(outPath, tracks, downloadsDir) {
  const xml = buildCollection(tracks, downloadsDir);
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, xml, "utf8");
  return { path: outPath, count: tracks.filter((t) => t.fileName).length };
}

module.exports = { parseCollection, buildCollection, writeCollection, pathToLocation, locationToPath };
