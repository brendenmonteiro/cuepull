// Tests for the setlist ordering.
//
// Run with: node server/setlist.test.js
//
// No test framework: the server has no test dependency and this does not need
// one. Exits non-zero on failure so it can gate a build later.

const s = require("./setlist");

let passed = 0;
let failed = 0;

function check(name, cond, detail) {
  if (cond) {
    passed++;
  } else {
    failed++;
    console.log(`  FAIL  ${name}${detail ? `\n          ${detail}` : ""}`);
  }
}

function near(a, b, tol = 1e-9) {
  return Math.abs(a - b) <= tol;
}

// ── Camelot ─────────────────────────────────────────────────────────────

console.log("Camelot distance");
check("same key is free", near(s.keyDistance("8A", "8A"), 0));
check("relative major/minor", near(s.keyDistance("8A", "8B"), 0.2));
check("one step up", near(s.keyDistance("8A", "9A"), 0.15));
check("one step down", near(s.keyDistance("8A", "7A"), 0.15));
check("two steps is a lift", near(s.keyDistance("8A", "10A"), 0.45));
check("distant keys clash", near(s.keyDistance("8A", "2A"), 1));
check("unknown key is neutral", near(s.keyDistance("8A", null), 0.6));

// The wheel wraps: 12 and 1 are neighbours, not eleven hours apart.
check("12 -> 1 wraps", near(s.keyDistance("12A", "1A"), 0.15));
check("1 -> 12 wraps", near(s.keyDistance("1A", "12A"), 0.15));
check("11 -> 1 is two steps", near(s.keyDistance("11A", "1A"), 0.45));

check("garbage parses to null", s.parseCamelot("banana") === null);
check("hour 0 rejected", s.parseCamelot("0A") === null);
check("hour 13 rejected", s.parseCamelot("13A") === null);
check("lowercase accepted", s.parseCamelot("8a") !== null);

// ── Tempo ───────────────────────────────────────────────────────────────

console.log("Tempo distance");
check("same tempo is free", near(s.tempoDistance(128, 128), 0));
check("6% is the limit", near(s.tempoDistance(100, 106), 1));
// 200 against 100 is exactly double time, which is a normal move, so the
// clamp has to be checked with a tempo that is not a multiple.
check("beyond the limit stays clamped", near(s.tempoDistance(100, 137), 1));
check("half time is free", near(s.tempoDistance(140, 70), 0));
check("double time is free", near(s.tempoDistance(128, 256), 0));
check("missing bpm is neutral", near(s.tempoDistance(128, null), 0.6));
check("zero bpm is neutral", near(s.tempoDistance(128, 0), 0.6));

// Percentage, not absolute: the same gap costs more at a lower tempo.
check(
  "distance is relative, not absolute",
  s.tempoDistance(100, 103) > s.tempoDistance(160, 163)
);

// ── Energy arc ──────────────────────────────────────────────────────────

console.log("Energy arc");
const arcStart = s.arcTarget(0, 20);
const arcMid = s.arcTarget(13, 20);
const arcEnd = s.arcTarget(19, 20);
check("arc starts low", arcStart < 0.5, `got ${arcStart}`);
check("arc peaks in the last third", arcMid > arcStart, `got ${arcMid}`);
check("arc eases at the end", arcEnd < arcMid, `got ${arcEnd}`);
check("single track does not divide by zero", isFinite(s.arcTarget(0, 1)));

// ── Ordering ────────────────────────────────────────────────────────────

console.log("Ordering");

const t = (fileName, camelot, bpm, durationSec = 300) => ({
  fileName,
  title: fileName,
  camelot,
  bpm,
  durationSec,
});

// Shuffled, but there is one obviously correct harmonic walk through these.
const crate = [
  t("e", "12A", 130),
  t("a", "8A", 128),
  t("c", "10A", 129),
  t("b", "9A", 128),
  t("d", "11A", 130),
];

const set = s.buildSetlist(crate);
check("every track is placed", set.tracks.length === 5, `got ${set.tracks.length}`);
check(
  "no track is duplicated",
  new Set(set.tracks.map((x) => x.fileName)).size === 5
);
check("positions are 1..n", set.tracks.every((x, i) => x.position === i + 1));
check("transitions are one fewer than tracks", set.transitions.length === 4);
check(
  "adjacent keys throughout",
  set.transitions.every((x) => x.keyDistance <= 0.2),
  set.tracks.map((x) => x.camelot).join(" ")
);

// Ordering must not mutate what it was handed.
const before = crate.map((x) => x.fileName).join(",");
s.buildSetlist(crate);
check("input array is untouched", crate.map((x) => x.fileName).join(",") === before);

// ── Outliers ────────────────────────────────────────────────────────────

console.log("Outliers");

const withOutlier = [
  t("h1", "8A", 128),
  t("h2", "9A", 128),
  t("h3", "8A", 129),
  t("h4", "9A", 130),
  // 62 would double to 124 and mix fine with 128, so the odd one out has to
  // be a tempo that is not near the crate at single, half or double time.
  t("odd", "4B", 97),
];

const oset = s.buildSetlist(withOutlier);
check("outlier is held back", oset.outliers.length === 1, JSON.stringify(oset.outliers.map((x) => x.fileName)));
check("outlier is the odd one", oset.outliers[0] && oset.outliers[0].fileName === "odd");
check("the rest still play", oset.tracks.length === 4);
check("outlier carries a reason", Boolean(oset.outliers[0] && oset.outliers[0].reason));

// Half time is not an outlier: 75 sits fine in a 150 crate.
const halfTime = [
  t("f1", "8A", 150),
  t("f2", "9A", 150),
  t("f3", "8A", 151),
  t("f4", "9A", 149),
  t("half", "8A", 75),
];
check(
  "half time track is not an outlier",
  s.buildSetlist(halfTime).outliers.length === 0
);

// A tiny crate should not be emptied by outlier removal.
const tiny = [t("x", "8A", 128), t("y", "4B", 70)];
const tinySet = s.buildSetlist(tiny);
check("small crate keeps everything", tinySet.tracks.length === 2, `got ${tinySet.tracks.length}`);

// ── 2-opt ───────────────────────────────────────────────────────────────

console.log("2-opt");
const messy = [
  t("m1", "8A", 128),
  t("m2", "2A", 128),
  t("m3", "9A", 128),
  t("m4", "3A", 128),
  t("m5", "10A", 128),
];
const costBefore = s.pathCost(messy);
const costAfter = s.pathCost(s.twoOpt(messy));
check("2-opt never makes it worse", costAfter <= costBefore + 1e-9,
  `before ${costBefore.toFixed(3)} after ${costAfter.toFixed(3)}`);
check("2-opt keeps every track", s.twoOpt(messy).length === messy.length);

// ── Edge cases ──────────────────────────────────────────────────────────

console.log("Edge cases");
check("empty crate", s.buildSetlist([]).tracks.length === 0);
check("null input", s.buildSetlist(null).tracks.length === 0);
check("one track", s.buildSetlist([t("solo", "8A", 128)]).tracks.length === 1);
check("one track has no transitions", s.buildSetlist([t("solo", "8A", 128)]).transitions.length === 0);
check(
  "entries without a fileName are dropped",
  s.buildSetlist([t("ok", "8A", 128), { camelot: "9A", bpm: 128 }]).tracks.length === 1
);
check(
  "unanalysed tracks still place",
  s.buildSetlist([
    { fileName: "u1" },
    { fileName: "u2" },
    { fileName: "u3" },
  ]).tracks.length === 3
);

// A description should never crash on missing data.
const d = s.describeTransition({ fileName: "a" }, { fileName: "b" });
check("describeTransition survives empty tracks", typeof d.score === "number");

// ── Summary ─────────────────────────────────────────────────────────────

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
