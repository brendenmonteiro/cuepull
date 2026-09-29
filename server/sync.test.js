// Tests for the beat sync maths.
//
// The calculation lives in the deck UI, but it is plain arithmetic, so it is
// mirrored here and checked against the cases that matter. Run with:
//   node server/sync.test.js

let passed = 0;
let failed = 0;
const check = (name, cond, detail) => {
  if (cond) passed++;
  else {
    failed++;
    console.log(`  FAIL  ${name}${detail ? `\n          ${detail}` : ""}`);
  }
};
const near = (a, b, tol = 0.01) => Math.abs(a - b) <= tol;

// Mirrors syncTo() in Decks.tsx: pick the nearest of single, double or half
// time, then work out the pitch percentage that lands the follower on it.
function syncPitch(followerBpm, leaderBpm, leaderPitch = 0) {
  const targets = [leaderBpm, leaderBpm * 2, leaderBpm / 2];
  let best = targets[0];
  let bestPct = Infinity;
  for (const t of targets) {
    const pct = Math.abs(t - followerBpm) / followerBpm;
    if (pct < bestPct) {
      bestPct = pct;
      best = t;
    }
  }
  const leaderRate = 1 + leaderPitch / 100;
  const wanted = ((best * leaderRate) / followerBpm - 1) * 100;
  if (!isFinite(wanted) || Math.abs(wanted) > 8) return null; // beyond the fader
  return Math.round(wanted * 100) / 100;
}

console.log("Sync pitch");

// Same tempo needs no correction.
check("identical tempos need no move", near(syncPitch(128, 128), 0));

// A small gap is exactly the ratio, as a percentage.
check("128 to 130 is +1.56%", near(syncPitch(128, 130), 1.56));
check("130 to 128 is -1.54%", near(syncPitch(130, 128), -1.54));

// Applying the returned pitch must actually land on the leader's tempo.
for (const [f, l] of [[128, 130], [130, 128], [124, 128], [132, 127]]) {
  const p = syncPitch(f, l);
  check(
    `${f} pitched ${p}% lands on ${l}`,
    p != null && near(f * (1 + p / 100), l, 0.05),
    p == null ? "refused" : `got ${(f * (1 + p / 100)).toFixed(2)}`
  );
}

// Half and double time are legitimate matches.
check("75 syncs to a 150 leader", near(syncPitch(75, 150), 0));
check("150 syncs to a 75 leader", near(syncPitch(150, 75), 0));
check("74 to 150 uses half time", near(syncPitch(74, 150), 1.35));

// Beyond the pitch fader it has to refuse rather than clamp, because a
// clamped value would silently leave the decks unmatched.
check("100 to 127 is refused", syncPitch(100, 127) === null);
check("128 to 160 is refused", syncPitch(128, 160) === null);
check("just inside the range is allowed", syncPitch(128, 137) !== null);
check("just outside the range is refused", syncPitch(128, 139) === null);

// The leader's own pitch fader counts: syncing to a leader that is itself
// pitched up has to account for what it is actually playing at.
check(
  "leader pitched +4% is followed",
  near(syncPitch(128, 128, 4), 4),
  `got ${syncPitch(128, 128, 4)}`
);
check(
  "follower lands on the leader's real tempo",
  (() => {
    const p = syncPitch(126, 128, 2);
    return p != null && near(126 * (1 + p / 100), 128 * 1.02, 0.05);
  })()
);

// Phase correction: the follower is nudged by at most half a beat, in
// whichever direction is shorter.
function phaseDrift(followerPhase, leaderPhase) {
  return ((followerPhase - leaderPhase + 1.5) % 1) - 0.5;
}

console.log("Phase drift");
check("already aligned", near(phaseDrift(0.5, 0.5), 0));
check("a tenth ahead", near(phaseDrift(0.6, 0.5), 0.1));
check("a tenth behind", near(phaseDrift(0.4, 0.5), -0.1));
// Wrapping: 0.95 against 0.05 is a tenth apart the short way, not nine tenths.
check("wraps the short way forward", near(phaseDrift(0.95, 0.05), -0.1));
check("wraps the short way back", near(phaseDrift(0.05, 0.95), 0.1));
check(
  "never more than half a beat",
  [0, 0.1, 0.25, 0.5, 0.75, 0.9, 0.99].every((a) =>
    [0, 0.2, 0.5, 0.8].every((b) => Math.abs(phaseDrift(a, b)) <= 0.5 + 1e-9)
  )
);

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
