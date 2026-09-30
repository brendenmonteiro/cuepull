// Builds a demo library for the README screenshots.
//
// The screenshots must not show a real crate. Naming commercial releases, and
// their labels, is what turned the 2020 youtube-dl takedown from a dispute
// about code into a dispute about evidence: the RIAA quoted the project's own
// README back at it. A picture of this app holding a shelf of chart tracks
// makes exactly that argument for someone else.
//
// So the screenshots use tones generated here. The audio is synthesised with
// ffmpeg, the names are invented, and every track is at a tempo and key that
// makes the setlist ordering legible. Nothing is copied from anywhere.

const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");
const { getBinaries } = require("../server/binaries");

const OUT = process.argv[2] || "C:/Music/Cuepull";
const FOLDER = "12-06-2026";

// Invented titles and artists. Tempos and keys are chosen to give the setlist
// something real to solve: a tight cluster with a few clean harmonic runs.
const TRACKS = [
  { artist: "Test Signal", title: "Calibration Tone", bpm: 126, key: "A minor", camelot: "8A", root: 220.0 },
  { artist: "Test Signal", title: "Reference Level", bpm: 126, key: "C major", camelot: "8B", root: 261.6 },
  { artist: "Placeholder", title: "Sine Study One", bpm: 128, key: "E minor", camelot: "9A", root: 329.6 },
  { artist: "Placeholder", title: "Sine Study Two", bpm: 128, key: "G major", camelot: "9B", root: 392.0 },
  { artist: "Grey Noise", title: "Low Pass", bpm: 128, key: "B minor", camelot: "10A", root: 246.9 },
  { artist: "Grey Noise", title: "High Pass", bpm: 130, key: "D major", camelot: "10B", root: 293.7 },
  { artist: "Null Input", title: "Silent Partner", bpm: 130, key: "F# minor", camelot: "11A", root: 370.0 },
  { artist: "Null Input", title: "Open Channel", bpm: 130, key: "A major", camelot: "11B", root: 440.0 },
  { artist: "Dry Run", title: "First Pass", bpm: 132, key: "Db minor", camelot: "12A", root: 277.2 },
  { artist: "Dry Run", title: "Second Pass", bpm: 132, key: "E major", camelot: "12B", root: 659.3 },
  { artist: "Loopback", title: "Return Path", bpm: 124, key: "D minor", camelot: "7A", root: 293.7 },
];

// A four to the floor kick plus a held tone, so the waveform has visible
// transients for the beat grid to sit against.
function render(track, file) {
  const { ffmpeg } = getBinaries();
  if (!ffmpeg) throw new Error("ffmpeg not found");

  const seconds = 200;
  const beat = 60 / track.bpm;

  // A short percussive click every beat, plus a quiet sustained tone.
  const kick = `sine=frequency=55:duration=${seconds}`;
  const tone = `sine=frequency=${track.root}:duration=${seconds}`;

  execFileSync(
    ffmpeg,
    [
      "-y", "-hide_banner", "-loglevel", "error",
      "-f", "lavfi", "-i", kick,
      "-f", "lavfi", "-i", tone,
      "-filter_complex",
      // Gate the kick into beats, keep the tone low, mix them.
      `[0:a]atrim=0:${seconds},asetpts=N/SR/TB,` +
        `volume='if(lt(mod(t,${beat}),0.06),1,0)':eval=frame[k];` +
        `[1:a]volume=0.10[t];` +
        `[k][t]amix=inputs=2:duration=shortest[a]`,
      "-map", "[a]",
      "-ac", "2", "-ar", "44100", "-b:a", "320k",
      "-metadata", `title=${track.title}`,
      "-metadata", `artist=${track.artist}`,
      file,
    ],
    { stdio: "inherit", timeout: 120000 }
  );
}

function main() {
  const dir = path.join(OUT, FOLDER);
  fs.mkdirSync(dir, { recursive: true });

  const library = { tracks: {} };

  for (const t of TRACKS) {
    const name = `${t.artist} - ${t.title}.mp3`;
    const rel = `${FOLDER}/${name}`;
    const file = path.join(dir, name);

    if (!fs.existsSync(file)) {
      process.stdout.write(`  ${t.artist} - ${t.title}  `);
      render(t, file);
      console.log(`${(fs.statSync(file).size / 1048576).toFixed(1)} MB`);
    }

    library.tracks[rel] = {
      fileName: rel,
      title: t.title,
      artist: t.artist,
      format: "mp3",
      source: "archive",
      durationSec: 200,
      bytes: fs.statSync(file).size,
      tags: ["Demo"],
      bpm: t.bpm,
      musicalKey: t.key,
      camelot: t.camelot,
      keyConfidence: 0.9,
      firstSeen: "2026-06-12T10:00:00.000Z",
      downloads: 1,
      played: 0,
      analysedAt: "2026-06-12T10:00:30.000Z",
      cuePoints: 0,
    };
  }

  fs.writeFileSync(
    path.join(OUT, "demo-library.json"),
    JSON.stringify(library, null, 2)
  );
  console.log(`\n${TRACKS.length} tracks in ${dir}`);
  console.log(`library written to ${path.join(OUT, "demo-library.json")}`);
}

main();
