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

// ── Beat aligned start ──────────────────────────────────────────────────
//
// Mirrors the scheduling in syncTo(). The point of sync is that the two
// downbeats coincide, so these check the arithmetic that picks when to start
// the follower and from where.

function planStart({
  ctxNow,
  leaderPos,
  leaderRate,
  leaderGrid,
  followerPos,
  followerRate,
  followerGrid,
  lead = 0.09,
}) {
  const lBeat = leaderGrid.beatSec / leaderRate;
  const fBeat = followerGrid.beatSec / followerRate;

  const targetTime = ctxNow + lead;
  const lAtTarget = leaderPos + lead * leaderRate;
  const beatsIn = (lAtTarget - leaderGrid.offsetSec) / lBeat;
  const nextBeatIndex = Math.ceil(beatsIn);
  const lAtBeat = leaderGrid.offsetSec + nextBeatIndex * lBeat;
  const startWhen = targetTime + (lAtBeat - lAtTarget) / leaderRate;

  const fBeatsIn = (followerPos - followerGrid.offsetSec) / fBeat;
  const fStart = followerGrid.offsetSec + Math.round(fBeatsIn) * fBeat;

  return { startWhen, fStart, lAtBeat, lBeat, fBeat, nextBeatIndex };
}

console.log("Beat aligned start");

{
  const grid = { bpm: 128, beatSec: 60 / 128, offsetSec: 0.2 };
  const p = planStart({
    ctxNow: 10,
    leaderPos: 31.4,
    leaderRate: 1,
    leaderGrid: grid,
    followerPos: 8.3,
    followerRate: 1,
    followerGrid: grid,
  });

  check("start is in the future", p.startWhen > 10, `got ${p.startWhen}`);
  check(
    "start is not scheduled too far out",
    p.startWhen < 10 + 0.09 + grid.beatSec + 1e-9,
    `got ${p.startWhen - 10}s ahead`
  );
  // The leader must be exactly on a beat at the moment the follower starts.
  const leaderAtStart = 31.4 + (p.startWhen - 10);
  const phase = ((leaderAtStart - grid.offsetSec) / p.lBeat) % 1;
  check(
    "leader is on a grid line when the follower starts",
    near(phase, 0, 1e-6) || near(phase, 1, 1e-6),
    `phase ${phase}`
  );
  // And the follower must begin exactly on one of its own.
  const fPhase = ((p.fStart - grid.offsetSec) / p.fBeat) % 1;
  check(
    "follower starts on its own grid line",
    near(fPhase, 0, 1e-6) || near(fPhase, 1, 1e-6),
    `phase ${fPhase}`
  );
}

{
  // Different tempos and offsets, with the leader pitched up.
  const lGrid = { bpm: 128, beatSec: 60 / 128, offsetSec: 0.05 };
  const fGrid = { bpm: 126, beatSec: 60 / 126, offsetSec: 0.71 };
  const leaderRate = 1.03;
  const followerRate = (128 * 1.03) / 126;
  const p = planStart({
    ctxNow: 100,
    leaderPos: 63.77,
    leaderRate,
    leaderGrid: lGrid,
    followerPos: 12.04,
    followerRate,
    followerGrid: fGrid,
  });

  const leaderAtStart = 63.77 + (p.startWhen - 100) * leaderRate;
  const lPhase = ((leaderAtStart - lGrid.offsetSec) / (lGrid.beatSec / leaderRate)) % 1;
  check(
    "works with mismatched grids and a pitched leader",
    near(lPhase, 0, 1e-6) || near(lPhase, 1, 1e-6),
    `phase ${lPhase}`
  );
  check("follower start is not negative", p.fStart >= 0, `got ${p.fStart}`);

  // Once both run, a beat of the leader and a beat of the follower are the
  // same length, which is what keeps them together.
  check(
    "beat lengths match after sync",
    near(lGrid.beatSec / leaderRate, fGrid.beatSec / followerRate, 1e-6),
    `${lGrid.beatSec / leaderRate} vs ${fGrid.beatSec / followerRate}`
  );
}

// ── Lock correction ─────────────────────────────────────────────────────

function lockCorrection(drift) {
  if (Math.abs(drift) > 0.33) return null; // a jump, not drift
  return Math.max(-0.004, Math.min(0.004, -drift * 0.02));
}

console.log("Lock correction");
check("no drift, no correction", lockCorrection(0) === 0);
check("behind pulls forward", lockCorrection(-0.1) > 0);
check("ahead pulls back", lockCorrection(0.1) < 0);
check("correction stays inaudible", Math.abs(lockCorrection(0.3)) <= 0.004);
check("a jump is left alone", lockCorrection(0.4) === null);
check(
  "correction always opposes the drift",
  [-0.3, -0.2, -0.05, 0.05, 0.2, 0.3].every((d) => {
    const c = lockCorrection(d);
    return c !== null && Math.sign(c) === -Math.sign(d);
  })
);

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
