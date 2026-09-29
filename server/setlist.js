// Setlist ordering.
//
// Takes a crate and puts it in an order you could actually play: keys that sit
// next to each other on the Camelot wheel, tempos close enough to ride the
// pitch fader, and an energy arc that builds rather than wandering.
//
// None of this is machine learning. Harmonic mixing is a lookup table DJs have
// used for decades, and the ordering is a shortest path problem over a graph
// whose edge weight is "how awkward is this transition". A greedy walk with a
// little lookahead gets close enough for a crate of this size and runs in
// milliseconds.

// ── Camelot distance ────────────────────────────────────────────────────
//
// The wheel is 12 hours around, A (minor) inside, B (major) outside. The moves
// that work:
//   same key                perfect
//   same hour, other mode   relative major/minor
//   one hour apart, same mode   the standard move, a fifth away
//   two hours apart, same mode  a noticeable lift, still usable
// Anything else clashes.

function parseCamelot(c) {
  const m = /^(\d{1,2})([AB])$/.exec(String(c || "").trim().toUpperCase());
  if (!m) return null;
  const hour = Number(m[1]);
  if (hour < 1 || hour > 12) return null;
  return { hour, mode: m[2] };
}

// Hours apart on a 12 hour clock, so 12 and 1 are neighbours.
function hourGap(a, b) {
  const d = Math.abs(a - b) % 12;
  return Math.min(d, 12 - d);
}

// 0 is a perfect match, 1 is unusable. At or below 0.5 is a move a DJ would
// actually make. An unanalysed track is placeable but never preferred.
function keyDistance(fromCamelot, toCamelot) {
  const a = parseCamelot(fromCamelot);
  const b = parseCamelot(toCamelot);
  if (!a || !b) return 0.6;

  const gap = hourGap(a.hour, b.hour);
  const sameMode = a.mode === b.mode;

  if (gap === 0) return sameMode ? 0 : 0.2;
  if (gap === 1) return sameMode ? 0.15 : 0.5;
  if (gap === 2 && sameMode) return 0.45;
  return 1;
}

// ── Tempo distance ──────────────────────────────────────────────────────
//
// Pitch faders are usually +/- 8%, and past about 6% vocals start sounding
// wrong. Measured as a percentage so it means the same thing at 128 and 174.
//
// Half and double time count as close: 140 over a 70 bpm track is a normal
// move, and plenty of drum and bass sits next to half time house this way.

const MAX_TEMPO_PCT = 6;

function tempoDistance(fromBpm, toBpm) {
  const a = Number(fromBpm);
  const b = Number(toBpm);
  if (!isFinite(a) || !isFinite(b) || a <= 0 || b <= 0) return 0.6;

  const candidates = [b, b * 2, b / 2];
  let best = Infinity;
  for (const c of candidates) {
    const pct = (Math.abs(c - a) / a) * 100;
    if (pct < best) best = pct;
  }
  // Linear up to the limit, then clamped. 0% is 0, 6% or more is 1.
  return Math.min(best / MAX_TEMPO_PCT, 1);
}

// ── Energy ──────────────────────────────────────────────────────────────
//
// There is no energy field in the library yet, so it is estimated from what we
// do have. Tempo carries most of it, and minor keys read as darker than major.
// Rough, but enough to stop a set from lurching between a peak track and an
// intro. Replaced by real loudness analysis when Phase C adds it.

function energyOf(track) {
  if (isFinite(track.energy)) return Math.max(0, Math.min(1, track.energy));

  const bpm = Number(track.bpm);
  if (!isFinite(bpm)) return 0.5;

  // 120 is a floor, 150 and up is peak time.
  let e = (bpm - 118) / 34;
  const c = parseCamelot(track.camelot);
  if (c && c.mode === "B") e += 0.06; // major, brighter
  return Math.max(0, Math.min(1, e));
}

// ── Transition cost ─────────────────────────────────────────────────────

// Key and tempo weigh the same, energy is a tiebreaker.
//
// These are measured, not guessed. Sweeping tempo from 1.0 to 2.6 against a
// real 55 track crate, weighting tempo harder made the result worse every
// time: 9 rough joins at 1.0, 15 at 2.2. Leaning on tempo makes each single
// step look cheap, so the walk creeps through the middle of the crate and
// strands the fast tracks, which then need one big jump to reach. Treating a
// key clash as equally expensive keeps the ordering honest about both.
const WEIGHTS = { key: 1, tempo: 1, energy: 0.35 };

// Cost of playing `to` after `from`. `targetSlope` is the energy change the
// arc wants at this point, so the same pair can be right early and wrong late.
function transitionCost(from, to, targetSlope = 0) {
  const k = keyDistance(from.camelot, to.camelot);
  const t = tempoDistance(from.bpm, to.bpm);

  const actualSlope = energyOf(to) - energyOf(from);
  const e = Math.abs(actualSlope - targetSlope);

  return WEIGHTS.key * k + WEIGHTS.tempo * t + WEIGHTS.energy * e;
}

// ── Energy arc ──────────────────────────────────────────────────────────
//
// Where a set should be, energy wise, at a given point. Build through the
// first two thirds, hold near the peak, ease off at the end. The ordering
// follows this loosely: it is a preference, not a rule, because a clean key
// and tempo move matters more than hitting a curve exactly.

function arcTarget(position, total) {
  if (total < 2) return 0.5;
  const p = position / (total - 1);
  if (p < 0.65) return 0.35 + (p / 0.65) * 0.55; // 0.35 up to 0.90
  if (p < 0.85) return 0.9;                      // hold
  return 0.9 - ((p - 0.85) / 0.15) * 0.3;        // ease to 0.60
}

// ── Ordering ────────────────────────────────────────────────────────────
//
// Greedy nearest neighbour with lookahead. At each step it scores every
// remaining track on the cost of playing it next, plus a discounted look at
// the best move available after that. Lookahead is what stops it stranding
// itself on a track whose key has no way out.
//
// Complexity is O(n^2 * k), fine well past a few hundred tracks.

const LOOKAHEAD_DISCOUNT = 0.4;

function bestNext(current, pool, targetSlope) {
  let best = null;
  for (const cand of pool) {
    const cost = transitionCost(current, cand, targetSlope);
    if (!best || cost < best.cost) best = { track: cand, cost };
  }
  return best;
}

function orderTracks(tracks, { startWith = null } = {}) {
  const pool = tracks.slice();
  if (pool.length <= 2) return pool;

  // Open on the lowest energy track unless told otherwise, so there is
  // somewhere to build from.
  let currentIdx = 0;
  if (startWith) {
    const i = pool.findIndex((t) => t.fileName === startWith);
    if (i >= 0) currentIdx = i;
  } else {
    let lowest = Infinity;
    pool.forEach((t, i) => {
      const e = energyOf(t);
      if (e < lowest) {
        lowest = e;
        currentIdx = i;
      }
    });
  }

  const ordered = [pool.splice(currentIdx, 1)[0]];

  while (pool.length) {
    const position = ordered.length;
    const total = tracks.length;
    const current = ordered[ordered.length - 1];

    const slope = arcTarget(position, total) - arcTarget(position - 1, total);

    let best = null;
    for (let i = 0; i < pool.length; i++) {
      const cand = pool[i];
      let cost = transitionCost(current, cand, slope);

      // Peek one move further so we do not paint ourselves into a corner.
      if (pool.length > 1) {
        const rest = pool.filter((_, j) => j !== i);
        const nextSlope =
          arcTarget(position + 1, total) - arcTarget(position, total);
        const peek = bestNext(cand, rest, nextSlope);
        if (peek) cost += peek.cost * LOOKAHEAD_DISCOUNT;
      }

      if (!best || cost < best.cost) best = { i, cost };
    }

    ordered.push(pool.splice(best.i, 1)[0]);
  }

  return ordered;
}

// ── Cleanup ─────────────────────────────────────────────────────────────
//
// Greedy ordering takes the easy move every time, which means it spends the
// comfortable tracks early and leaves the outliers to pile up at the end. On a
// real crate that showed as a clean run through the middle and a tail that
// lurched 159 -> 126 -> 95 -> 87 bpm.
//
// This is the standard fix for that failure: 2-opt. Reverse any segment where
// doing so lowers the total cost, and repeat until nothing improves. It cannot
// make the set worse, since a swap is only kept when the cost drops, and it
// repairs exactly the stranded-outlier case greedy creates.

function pathCost(list) {
  let sum = 0;
  const n = list.length;
  for (let i = 0; i < n - 1; i++) {
    const slope = arcTarget(i + 1, n) - arcTarget(i, n);
    sum += transitionCost(list[i], list[i + 1], slope);
  }
  return sum;
}

function twoOpt(list, { maxPasses = 12 } = {}) {
  const n = list.length;
  if (n < 4) return list;

  let best = list.slice();
  let bestCost = pathCost(best);

  for (let pass = 0; pass < maxPasses; pass++) {
    let improved = false;

    for (let i = 0; i < n - 2; i++) {
      for (let j = i + 2; j < n; j++) {
        // Reverse the segment between i+1 and j.
        const candidate = best
          .slice(0, i + 1)
          .concat(best.slice(i + 1, j + 1).reverse(), best.slice(j + 1));
        const cost = pathCost(candidate);
        if (cost < bestCost - 1e-9) {
          best = candidate;
          bestCost = cost;
          improved = true;
        }
      }
    }

    if (!improved) break;
  }

  return best;
}

// ── Public shape ────────────────────────────────────────────────────────
//
// Returns the ordered tracks each annotated with how it got there, so the UI
// can show why two tracks sit together and flag the joins worth rethinking.

function describeTransition(from, to) {
  const k = keyDistance(from.camelot, to.camelot);
  const t = tempoDistance(from.bpm, to.bpm);

  const a = parseCamelot(from.camelot);
  const b = parseCamelot(to.camelot);
  let keyNote = "keys not analysed";
  if (a && b) {
    const gap = hourGap(a.hour, b.hour);
    const sameMode = a.mode === b.mode;
    if (gap === 0 && sameMode) keyNote = "same key";
    else if (gap === 0) keyNote = "relative major/minor";
    else if (gap === 1 && sameMode) keyNote = "one step on the wheel";
    else if (gap === 1) keyNote = "diagonal move";
    else if (gap === 2 && sameMode) keyNote = "two steps, energy lift";
    else keyNote = "keys clash";
  }

  const fb = Number(from.bpm);
  const tb = Number(to.bpm);
  let bpmNote = "tempo unknown";
  let bpmDelta = null;
  if (isFinite(fb) && isFinite(tb) && fb > 0) {
    // Report against whichever of single, double or half time is nearest,
    // since that is the one you would actually beatmatch to.
    const options = [
      { bpm: tb, label: "" },
      { bpm: tb * 2, label: " (double time)" },
      { bpm: tb / 2, label: " (half time)" },
    ];
    let pick = options[0];
    let bestPct = Infinity;
    for (const o of options) {
      const pct = Math.abs(o.bpm - fb) / fb;
      if (pct < bestPct) {
        bestPct = pct;
        pick = o;
      }
    }
    bpmDelta = Math.round((pick.bpm - fb) * 10) / 10;
    const pct = Math.round(bestPct * 1000) / 10;
    bpmNote =
      bpmDelta === 0
        ? `same tempo${pick.label}`
        : `${bpmDelta > 0 ? "+" : ""}${bpmDelta} bpm, ${pct}%${pick.label}`;
  }

  const score = 1 - Math.min((k + t) / 2, 1);

  return {
    keyNote,
    bpmNote,
    bpmDelta,
    keyDistance: Math.round(k * 100) / 100,
    tempoDistance: Math.round(t * 100) / 100,
    // 0 to 1, higher is smoother. Below 0.5 is worth a second look.
    score: Math.round(score * 100) / 100,
    rough: k >= 1 || t >= 1,
  };
}

// Tracks with no tempo neighbour cannot be mixed into anything here, whatever
// order they go in. Ordering them anyway produces a set that lurches, and the
// lurch looks like an algorithm bug rather than what it is: a track that does
// not belong with the rest. Pull them out and say so.
//
// "Neighbour" allows half and double time, so a 75 bpm track sits happily in a
// 150 bpm crate and is not flagged.
function findOutliers(tracks) {
  const kept = [];
  const outliers = [];

  for (const t of tracks) {
    const bpm = Number(t.bpm);
    if (!isFinite(bpm) || bpm <= 0) {
      kept.push(t); // unanalysed, no evidence either way
      continue;
    }
    const hasNeighbour = tracks.some(
      (o) => o !== t && tempoDistance(bpm, o.bpm) < 1
    );
    (hasNeighbour ? kept : outliers).push(t);
  }

  return { kept, outliers };
}

function buildSetlist(tracks, opts = {}) {
  const all = (tracks || []).filter((t) => t && t.fileName);
  if (!all.length) {
    return { tracks: [], transitions: [], outliers: [], stats: null };
  }

  // Keep everything if separating would leave almost nothing to play.
  const split = findOutliers(all);
  const separate = opts.includeOutliers === false || split.kept.length >= 4;
  const usable = separate ? split.kept : all;
  const outliers = separate ? split.outliers : [];

  if (!usable.length) return { tracks: [], transitions: [], outliers, stats: null };

  // Greedy gets a sensible shape, 2-opt repairs the joins it stranded.
  const ordered = twoOpt(orderTracks(usable, opts));

  const transitions = [];
  for (let i = 0; i < ordered.length - 1; i++) {
    transitions.push({
      fromFile: ordered[i].fileName,
      toFile: ordered[i + 1].fileName,
      ...describeTransition(ordered[i], ordered[i + 1]),
    });
  }

  const scores = transitions.map((t) => t.score);
  const stats = {
    count: ordered.length,
    rough: transitions.filter((t) => t.rough).length,
    averageScore: scores.length
      ? Math.round((scores.reduce((a, b) => a + b, 0) / scores.length) * 100) / 100
      : null,
    totalSeconds: ordered.reduce((sum, t) => sum + (Number(t.durationSec) || 0), 0),
    bpmRange: (() => {
      const bs = ordered.map((t) => Number(t.bpm)).filter(isFinite);
      return bs.length ? { min: Math.min(...bs), max: Math.max(...bs) } : null;
    })(),
  };

  return {
    tracks: ordered.map((t, i) => ({
      ...t,
      position: i + 1,
      energy: Math.round(energyOf(t) * 100) / 100,
    })),
    transitions,
    // Left out because nothing else in the crate is near their tempo. Shown
    // separately rather than wedged into the set.
    outliers: outliers.map((t) => ({
      ...t,
      reason: "no other track within mixing range of this tempo",
    })),
    stats,
  };
}

module.exports = {
  twoOpt,
  pathCost,
  buildSetlist,
  orderTracks,
  transitionCost,
  describeTransition,
  keyDistance,
  tempoDistance,
  energyOf,
  arcTarget,
  parseCamelot,
  hourGap,
};
