"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Waveform } from "./Waveform";
import { useDeck, type Deck, type DeckTrack, type DeckWaveform, type EqBand } from "./useDeck";

// Two decks and a mixer. A preview player: load a track on each side, line
// them up, move the crossfader. Good enough to hear whether a transition
// works, not a replacement for a controller.

function fmt(secs: number) {
  if (!isFinite(secs) || secs < 0) return "0:00";
  const m = Math.floor(secs / 60);
  const s = Math.floor(secs % 60);
  return `${m}:${String(s).padStart(2, "0")}`;
}

function Knob({
  label,
  value,
  min,
  max,
  step,
  onChange,
  onReset,
  format,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  onChange: (v: number) => void;
  onReset?: () => void;
  format?: (v: number) => string;
}) {
  return (
    <label className="flex flex-col gap-1">
      <span className="flex items-baseline justify-between font-label-mono text-label-mono text-secondary">
        <button
          type="button"
          onDoubleClick={onReset}
          onClick={(e) => e.preventDefault()}
          title={onReset ? "Double click to reset" : undefined}
          className="uppercase"
        >
          {label}
        </button>
        <span>{format ? format(value) : value}</span>
      </span>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
        onDoubleClick={onReset}
        className="w-full accent-primary"
        aria-label={label}
      />
    </label>
  );
}

// Vertical channel fader, sitting outside its deck the way it would on a
// mixer. A range input rotated with writing-mode rather than a CSS transform,
// so it keeps normal keyboard and pointer behaviour.
function ChannelFader({
  value,
  onChange,
  side,
}: {
  value: number;
  onChange: (v: number) => void;
  side: "A" | "B";
}) {
  return (
    <div className="flex flex-col items-center gap-stack-sm border border-primary px-2 py-3 shrink-0">
      <span className="font-label-mono text-label-mono text-secondary">
        {Math.round(value * 100)}
      </span>
      {/* Fixed height: h-full here inherits the row and stretches the fader
          down the whole page. */}
      <input
        type="range"
        min={0}
        max={1}
        step={0.01}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
        onDoubleClick={() => onChange(1)}
        className="accent-primary cursor-pointer"
        style={{ writingMode: "vertical-lr", direction: "rtl", height: "9rem" }}
        aria-label={`Deck ${side} volume`}
        title="Channel volume. Double click for full."
      />
      <span className="font-label-caps text-label-caps uppercase">{side}</span>
    </div>
  );
}

function DeckPanel({
  deck,
  side,
  eq,
  onEq,
  zoomSec,
  onZoom,
  keyHint,
}: {
  deck: Deck;
  side: "A" | "B";
  eq: Record<EqBand, number>;
  onEq: (band: EqBand, db: number) => void;
  zoomSec: number;
  onZoom: (v: number) => void;
  keyHint: { play: string; cue: string };
}) {
  const { track, waveform, playing, loading, error, duration, position, pitch } = deck;

  return (
    <div className="border border-primary flex flex-col">
      <div className="flex items-baseline justify-between px-3 py-2 border-b border-primary">
        <span className="font-label-caps text-label-caps uppercase">Deck {side}</span>
        <div className="flex items-center gap-stack-md font-label-mono text-label-mono">
          {waveform?.grid && (
            <span
              className="text-secondary"
              title="Beat grid derived from the analysed tempo, not a full beat detection pass"
            >
              grid
            </span>
          )}
          {track?.camelot && <span>{track.camelot}</span>}
          {deck.playingBpm != null && (
            <span className={pitch !== 0 ? "text-primary" : "text-secondary"}>
              {deck.playingBpm.toFixed(1)} BPM
            </span>
          )}
          {track && (
            <button
              onClick={deck.eject}
              className="material-symbols-outlined text-[16px] text-secondary hover:text-primary transition-none"
              aria-label={`Eject deck ${side}`}
            >
              eject
            </button>
          )}
        </div>
      </div>

      <div className="px-3 py-2 border-b border-outline-variant min-h-[2.75rem] flex items-center">
        {loading ? (
          <span className="font-label-mono text-label-mono text-secondary">Loading.</span>
        ) : error ? (
          <span className="font-label-mono text-label-mono text-error">{error}</span>
        ) : track ? (
          <span className="font-body-sm text-body-sm truncate">
            <span className="text-secondary">{track.artist}</span> {track.title}
          </span>
        ) : (
          <span className="font-label-mono text-label-mono text-secondary">
            Press play on a setlist row to load this deck.
          </span>
        )}
      </div>

      <Waveform
        peaks={waveform?.detail.peaks ?? null}
        buckets={waveform?.detail.buckets ?? 0}
        durationSec={duration}
        position={position}
        grid={waveform?.grid ?? null}
        mode="detail"
        windowSec={zoomSec}
        height={96}
        onSeek={deck.seek}
      />
      <div className="border-t border-outline-variant">
        <Waveform
          peaks={waveform?.overview.peaks ?? null}
          buckets={waveform?.overview.buckets ?? 0}
          durationSec={duration}
          position={position}
          cuePoint={deck.cuePoint}
          mode="overview"
          height={40}
          onSeek={deck.seek}
        />
      </div>

      <div className="flex items-center justify-between px-3 py-2 font-label-mono text-label-mono border-b border-outline-variant">
        <span>{fmt(position)}</span>
        <div className="flex items-center gap-stack-sm text-secondary">
          <span>zoom</span>
          <input
            type="range"
            min={4}
            max={40}
            step={1}
            value={zoomSec}
            onChange={(e) => onZoom(Number(e.target.value))}
            onDoubleClick={() => onZoom(16)}
            className="w-20 accent-primary"
            aria-label={`Deck ${side} waveform zoom, seconds visible`}
            title="Seconds of track shown. Wider is slower moving."
          />
          <span className="w-8 text-right">{zoomSec}s</span>
        </div>
        <span className="text-secondary">-{fmt(Math.max(0, duration - position))}</span>
      </div>

      <div className="flex items-stretch gap-1 p-3 border-b border-outline-variant">
        <button
          onClick={deck.setCueHere}
          disabled={!track}
          className="flex-1 font-label-caps text-label-caps border border-primary py-2 hover:bg-primary hover:text-on-primary transition-none disabled:opacity-30"
          title="Drop a cue point at the playhead"
        >
          SET
        </button>
        <button
          onPointerDown={(e) => {
            e.currentTarget.setPointerCapture(e.pointerId);
            void deck.cuePreviewStart();
          }}
          onPointerUp={deck.cuePreviewEnd}
          onPointerCancel={deck.cuePreviewEnd}
          onPointerLeave={deck.cuePreviewEnd}
          disabled={!track}
          className="flex-1 font-label-caps text-label-caps border border-primary py-2 hover:bg-primary hover:text-on-primary active:bg-primary active:text-on-primary transition-none disabled:opacity-30 select-none"
          title={`Hold to preview from the cue point, release to snap back  [${keyHint.cue} plays from it]`}
        >
          CUE
        </button>
        <button
          onClick={deck.toggle}
          disabled={!track}
          className={`flex-[2] font-label-caps text-label-caps border border-primary py-2 transition-none disabled:opacity-30 ${
            playing ? "bg-primary text-on-primary" : "hover:bg-primary hover:text-on-primary"
          }`}
          title={`Play or pause  [${keyHint.play}]`}
        >
          {playing ? "PAUSE" : "PLAY"}
        </button>
      </div>

      <div className="grid grid-cols-3 gap-3 px-3 py-3 border-b border-outline-variant">
        {(["high", "mid", "low"] as EqBand[]).map((band) => (
          <Knob
            key={band}
            label={band}
            value={eq[band]}
            min={-26}
            max={6}
            step={1}
            onChange={(v) => onEq(band, v)}
            onReset={() => onEq(band, 0)}
            format={(v) => (v <= -26 ? "kill" : `${v > 0 ? "+" : ""}${v}`)}
          />
        ))}
      </div>

      <div className="px-3 py-3">
        <Knob
          label="pitch"
          value={pitch}
          min={-8}
          max={8}
          step={0.1}
          onChange={deck.setPitch}
          onReset={() => deck.setPitch(0)}
          format={(v) => `${v > 0 ? "+" : ""}${v.toFixed(1)}%`}
        />
      </div>
    </div>
  );
}

export function Decks({
  serverUrl,
  loadRequest,
  onLoaded,
  fetchWaveform,
}: {
  serverUrl: string;
  /** Set by the setlist when a row's play button is pressed. */
  loadRequest: { track: DeckTrack; nonce: number } | null;
  onLoaded: () => void;
  fetchWaveform: (fileName: string) => Promise<DeckWaveform | null>;
}) {
  const deckA = useDeck(serverUrl);
  const deckB = useDeck(serverUrl);

  const [crossfade, setCrossfade] = useState(0.5);
  const [eqA, setEqA] = useState<Record<EqBand, number>>({ low: 0, mid: 0, high: 0 });
  const [eqB, setEqB] = useState<Record<EqBand, number>>({ low: 0, mid: 0, high: 0 });
  // Seconds of track visible in the detail view. Wider means the waveform
  // crawls rather than races, which makes it far easier to hit a beat.
  const [zoomA, setZoomA] = useState(16);
  const [zoomB, setZoomB] = useState(16);
  // Which deck the next load goes to. Alternates so two presses fill both.
  const nextDeck = useRef<"A" | "B">("A");

  // Wire both decks into the crossfader once their chains exist.
  //
  // Both channels meet at a master node, which then feeds the speakers and,
  // when armed, the recorder. Recording from that single point captures
  // exactly what you hear: both decks, the EQ, the faders, the lot.
  const faderRef = useRef<{ a: GainNode; b: GainNode; master: GainNode } | null>(null);
  const recordDestRef = useRef<MediaStreamAudioDestinationNode | null>(null);
  const [recorderReady, setRecorderReady] = useState(false);

  useEffect(() => {
    const ctx = deckA.context.current;
    const outA = deckA.outputNode.current;
    const outB = deckB.outputNode.current;
    if (!ctx || !outA || !outB || faderRef.current) return;

    const a = ctx.createGain();
    const b = ctx.createGain();
    const master = ctx.createGain();
    outA.connect(a).connect(master);
    outB.connect(b).connect(master);
    master.connect(ctx.destination);

    const recDest = ctx.createMediaStreamDestination();
    master.connect(recDest);

    faderRef.current = { a, b, master };
    recordDestRef.current = recDest;
    setRecorderReady(typeof MediaRecorder !== "undefined");

    return () => {
      a.disconnect();
      b.disconnect();
      master.disconnect();
      recDest.disconnect();
      faderRef.current = null;
      recordDestRef.current = null;
    };
  }, [deckA.context, deckA.outputNode, deckB.outputNode]);

  // Recording. MediaRecorder writes webm/opus, which every browser can play
  // and ffmpeg can convert. Chunks are held in memory and saved on stop.
  const recorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const [recording, setRecording] = useState(false);
  const [recordSecs, setRecordSecs] = useState(0);

  useEffect(() => {
    if (!recording) return;
    const started = Date.now();
    const id = window.setInterval(
      () => setRecordSecs(Math.floor((Date.now() - started) / 1000)),
      500
    );
    return () => window.clearInterval(id);
  }, [recording]);

  const startRecording = useCallback(async () => {
    const dest = recordDestRef.current;
    const ctx = deckA.context.current;
    if (!dest || !ctx) return;
    if (ctx.state === "suspended") await ctx.resume();

    // Pick whatever this build actually supports rather than assuming.
    const preferred = [
      "audio/webm;codecs=opus",
      "audio/webm",
      "audio/ogg;codecs=opus",
    ];
    const mimeType = preferred.find((t) => MediaRecorder.isTypeSupported(t));

    const rec = new MediaRecorder(dest.stream, mimeType ? { mimeType } : undefined);
    chunksRef.current = [];
    rec.ondataavailable = (e) => {
      if (e.data.size) chunksRef.current.push(e.data);
    };
    rec.onstop = () => {
      const blob = new Blob(chunksRef.current, {
        type: mimeType || "audio/webm",
      });
      chunksRef.current = [];
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      const stamp = new Date()
        .toISOString()
        .replace(/[:T]/g, "-")
        .slice(0, 19);
      a.href = url;
      a.download = `cuepull-mix-${stamp}.webm`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      // Revoking immediately can cancel the download in some builds.
      setTimeout(() => URL.revokeObjectURL(url), 30000);
    };

    rec.start(1000); // flush once a second so a crash loses at most that
    recorderRef.current = rec;
    setRecordSecs(0);
    setRecording(true);
  }, [deckA.context]);

  const stopRecording = useCallback(() => {
    const rec = recorderRef.current;
    if (!rec || rec.state === "inactive") return;
    rec.stop();
    recorderRef.current = null;
    setRecording(false);
  }, []);

  // Constant power crossfade, so the middle does not sound quieter than
  // either end the way a linear fade does.
  useEffect(() => {
    const f = faderRef.current;
    if (!f) return;
    f.a.gain.value = Math.cos((crossfade * Math.PI) / 2);
    f.b.gain.value = Math.cos(((1 - crossfade) * Math.PI) / 2);
  }, [crossfade]);

  const applyEq = useCallback(
    (side: "A" | "B", band: EqBand, db: number) => {
      const deck = side === "A" ? deckA : deckB;
      const set = side === "A" ? setEqA : setEqB;
      deck.setEq(band, db);
      set((prev) => ({ ...prev, [band]: db }));
    },
    [deckA, deckB]
  );

  // A load request from the setlist goes to whichever deck is free, or
  // alternates when both are busy.
  useEffect(() => {
    if (!loadRequest) return;

    let target: "A" | "B";
    if (!deckA.track) target = "A";
    else if (!deckB.track) target = "B";
    else if (!deckA.playing) target = "A";
    else if (!deckB.playing) target = "B";
    else {
      target = nextDeck.current;
      nextDeck.current = target === "A" ? "B" : "A";
    }

    const deck = target === "A" ? deckA : deckB;
    void deck.load(loadRequest.track, fetchWaveform).then(onLoaded);
    // Only react to a new request, not to every deck state change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loadRequest?.nonce]);

  // Keyboard mapping, laid out like a controller: deck A on the left of the
  // keyboard, deck B on the right, so muscle memory matches the screen.
  //
  //   Q / P        play or pause that deck
  //   W / O        cue play: jump to the cue point and run from it
  //   S / L        drop a cue point at the playhead
  //   1..4 / 7..0  nudge that deck's pitch
  //   Z / X        crossfader hard left / hard right
  //   C            crossfader centre
  //   space        play or pause whichever deck is focused last, or A
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement | null;
      // Never steal a key from a text field or a slider being nudged.
      if (el && /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName)) return;
      if (el && el.isContentEditable) return;
      if (e.ctrlKey || e.metaKey || e.altKey) return;

      const A = deckA;
      const B = deckB;
      const handled = () => {
        e.preventDefault();
        e.stopPropagation();
      };

      switch (e.code) {
        case "KeyQ":
          if (A.track) { handled(); A.toggle(); }
          return;
        case "KeyP":
          if (B.track) { handled(); B.toggle(); }
          return;
        // Hold to preview from the cue point, release to snap back. e.repeat
        // guards the key auto-repeating while held, which would otherwise
        // restart the preview many times a second.
        case "KeyW":
          if (A.track && !e.repeat) { handled(); void A.cuePreviewStart(); }
          return;
        case "KeyO":
          if (B.track && !e.repeat) { handled(); void B.cuePreviewStart(); }
          return;
        // Commit: jump to the cue point and keep running.
        case "KeyE":
          if (A.track) { handled(); void A.cuePlay(); }
          return;
        case "KeyI":
          if (B.track) { handled(); void B.cuePlay(); }
          return;
        case "KeyS":
          if (A.track) { handled(); A.setCueHere(); }
          return;
        case "KeyL":
          if (B.track) { handled(); B.setCueHere(); }
          return;
        case "KeyZ":
          handled(); setCrossfade(0);
          return;
        case "KeyX":
          handled(); setCrossfade(1);
          return;
        case "KeyC":
          handled(); setCrossfade(0.5);
          return;
        case "Space":
          if (A.track) { handled(); A.toggle(); }
          else if (B.track) { handled(); B.toggle(); }
          return;
        default:
          break;
      }

      // Pitch nudges. Small steps, because this is for riding a deck into
      // time rather than changing key.
      const nudge: Record<string, [Deck, number]> = {
        Digit1: [A, -0.5],
        Digit2: [A, -0.1],
        Digit3: [A, 0.1],
        Digit4: [A, 0.5],
        Digit7: [B, -0.5],
        Digit8: [B, -0.1],
        Digit9: [B, 0.1],
        Digit0: [B, 0.5],
      };
      const hit = nudge[e.code];
      if (hit && hit[0].track) {
        handled();
        const [deck, delta] = hit;
        const next = Math.max(-8, Math.min(8, Math.round((deck.pitch + delta) * 10) / 10));
        deck.setPitch(next);
      }
    };

    // Releasing the preview key snaps the deck back. Also fires on blur,
    // because a keyup that lands on another window would otherwise never
    // arrive and leave a deck running.
    const onKeyUp = (e: KeyboardEvent) => {
      if (e.code === "KeyW") deckA.cuePreviewEnd();
      if (e.code === "KeyO") deckB.cuePreviewEnd();
    };
    const onBlur = () => {
      deckA.cuePreviewEnd();
      deckB.cuePreviewEnd();
    };

    window.addEventListener("keydown", onKey);
    window.addEventListener("keyup", onKeyUp);
    window.addEventListener("blur", onBlur);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("keyup", onKeyUp);
      window.removeEventListener("blur", onBlur);
    };
  }, [deckA, deckB]);

  // How far apart the two decks are, so you can see whether they will ride
  // into each other before you try.
  const bpmGap =
    deckA.playingBpm != null && deckB.playingBpm != null
      ? Math.round((deckB.playingBpm - deckA.playingBpm) * 10) / 10
      : null;

  // Beat sync. Matches the follower's tempo to the leader by moving its pitch
  // fader, then lines the two grids up so the beats land together.
  //
  // This is tempo and phase matching, not time stretching: the follower's
  // pitch moves with its tempo, exactly as if you had ridden the fader by
  // hand. A large correction will audibly change its key, which is why the
  // button reports the amount and refuses a match it cannot reach.
  const [syncNote, setSyncNote] = useState<string | null>(null);
  // Which deck is the sync leader, or null when nothing is locked.
  const [lockedTo, setLockedTo] = useState<"A" | "B" | null>(null);

  // Clear the note after a few seconds so it does not sit there stale.
  useEffect(() => {
    if (!syncNote) return;
    const id = window.setTimeout(() => setSyncNote(null), 5000);
    return () => window.clearTimeout(id);
  }, [syncNote]);

  const syncTo = useCallback(
    (leaderSide: "A" | "B") => {
      const leader = leaderSide === "A" ? deckA : deckB;
      const follower = leaderSide === "A" ? deckB : deckA;

      const lBpm = leader.track?.bpm;
      const fBpm = follower.track?.bpm;
      if (!lBpm || !fBpm) {
        setSyncNote("Both decks need an analysed tempo to sync");
        return;
      }

      // Match against half or double time when that is the closer target, so
      // a 150 can ride against a 75 without an impossible fader move.
      const targets = [lBpm, lBpm * 2, lBpm / 2];
      let best = targets[0];
      let bestPct = Infinity;
      for (const t of targets) {
        const pct = Math.abs(t - fBpm) / fBpm;
        if (pct < bestPct) {
          bestPct = pct;
          best = t;
        }
      }

      // The leader's own pitch counts: sync to what it is actually playing.
      const leaderRate = 1 + leader.pitch / 100;
      const wanted = ((best * leaderRate) / fBpm - 1) * 100;

      // A pitch fader only reaches 8%. Beyond that the tracks genuinely
      // cannot be beatmatched this way, so say so rather than doing nothing
      // and leaving the button looking broken.
      if (!isFinite(wanted) || Math.abs(wanted) > 8) {
        setSyncNote(
          `${fBpm} and ${lBpm} bpm are ${Math.abs(Math.round(wanted))}% apart, past the 8% the pitch fader reaches`
        );
        return;
      }

      const nextPitch = Math.round(wanted * 100) / 100;
      follower.setPitch(nextPitch);
      setSyncNote(
        `Deck ${leaderSide === "A" ? "B" : "A"} pitched ${nextPitch > 0 ? "+" : ""}${nextPitch}% to match`
      );

      // Phase: line the grids up so downbeats land together.
      const lGrid = leader.waveform?.grid;
      const fGrid = follower.waveform?.grid;
      if (!lGrid || !fGrid || !leader.playing) return;

      const ctx = leader.context.current;
      if (!ctx) return;

      const fRate = 1 + nextPitch / 100;
      const lBeat = lGrid.beatSec / leaderRate; // beat length in real seconds
      const fBeat = fGrid.beatSec / fRate;

      // Read the leader off the audio clock, not React state, which is up to
      // a frame stale. At 128bpm a frame is a tenth of a beat.
      const lNow = leader.exactPosition();

      // Schedule far enough ahead that the browser can honour it, then find
      // the leader's beat boundary at or after that instant.
      const lead = 0.09;
      const targetTime = ctx.currentTime + lead;
      const lAtTarget = lNow + lead * leaderRate;
      const beatsIn = (lAtTarget - lGrid.offsetSec) / lBeat;
      const nextBeatIndex = Math.ceil(beatsIn);
      const lAtBeat = lGrid.offsetSec + nextBeatIndex * lBeat;
      const startWhen = targetTime + (lAtBeat - lAtTarget) / leaderRate;

      // Start the follower from ITS nearest grid line, so the two downbeats
      // coincide rather than merely the tempos matching.
      const fNow = follower.playing ? follower.exactPosition() : follower.position;
      const fBeatsIn = (fNow - fGrid.offsetSec) / fBeat;
      const fStart = fGrid.offsetSec + Math.round(fBeatsIn) * fBeat;

      follower.startAt(Math.max(0, fStart), startWhen);
      setSyncNote(
        `Deck ${leaderSide === "A" ? "B" : "A"} pitched ${nextPitch > 0 ? "+" : ""}${nextPitch}% and locked to the grid`
      );
      setLockedTo(leaderSide);
    },
    [deckA, deckB]
  );

  // Beat lock.
  //
  // Matching tempo once is not enough: two decks drift because the grid is a
  // straight line and the music is not, and because the pitch fader has a
  // resolution limit. A CDJ holds the lock by continuously correcting, so
  // this does the same. Every quarter second it measures how far the
  // follower's beat has slipped and applies a tiny rate change to pull it
  // back, in the region of a tenth of a percent, which is inaudible.
  useEffect(() => {
    if (!lockedTo) return;
    const leader = lockedTo === "A" ? deckA : deckB;
    const follower = lockedTo === "A" ? deckB : deckA;

    const id = window.setInterval(() => {
      const lGrid = leader.waveform?.grid;
      const fGrid = follower.waveform?.grid;
      if (!lGrid || !fGrid || !leader.playing || !follower.playing) return;

      const leaderRate = 1 + leader.pitch / 100;
      const baseRate = 1 + follower.pitch / 100;
      const lBeat = lGrid.beatSec / leaderRate;
      const fBeat = fGrid.beatSec / baseRate;

      const lPhase = ((leader.exactPosition() - lGrid.offsetSec) / lBeat) % 1;
      const fPhase = ((follower.exactPosition() - fGrid.offsetSec) / fBeat) % 1;
      // Shortest way round the beat, so a deck a hair behind is not dragged
      // almost a whole beat forward.
      const drift = ((fPhase - lPhase + 1.5) % 1) - 0.5;

      // More than a third of a beat out is a jump, not drift. Correcting that
      // with a rate change would be audible, so leave it: the user can press
      // sync again.
      if (Math.abs(drift) > 0.33) return;

      // Proportional correction, capped so it stays inaudible.
      const correction = Math.max(-0.004, Math.min(0.004, -drift * 0.02));
      follower.nudgeRate(baseRate * (1 + correction));
    }, 250);

    return () => {
      window.clearInterval(id);
      // Hand the deck back to its pitch fader.
      follower.nudgeRate(1 + follower.pitch / 100);
    };
  }, [lockedTo, deckA, deckB]);

  // Any manual transport move breaks the lock, the way letting go of sync on
  // a CDJ does. Without this the lock would fight the user.
  useEffect(() => {
    if (!lockedTo) return;
    const follower = lockedTo === "A" ? deckB : deckA;
    const leader = lockedTo === "A" ? deckA : deckB;
    if (!follower.playing || !leader.playing) setLockedTo(null);
  }, [lockedTo, deckA.playing, deckB.playing, deckA, deckB]);

  const canSync =
    Boolean(deckA.track?.bpm) && Boolean(deckB.track?.bpm);

  return (
    <section className="mt-stack-lg border-t border-dashed border-outline-variant pt-stack-md">
      <div className="flex flex-wrap items-baseline justify-between gap-stack-sm mb-stack-md">
        <p className="font-label-mono text-label-mono text-secondary">// DECKS</p>
        <span className="font-label-mono text-label-mono text-secondary">
          <strong className="text-primary">Q</strong>/<strong className="text-primary">P</strong> play
          {"  "}
          <strong className="text-primary">W</strong>/<strong className="text-primary">O</strong> hold to cue
          {"  "}
          <strong className="text-primary">E</strong>/<strong className="text-primary">I</strong> cue play
          {"  "}
          <strong className="text-primary">S</strong>/<strong className="text-primary">L</strong> set cue
          {"  "}
          <strong className="text-primary">1-4</strong>/<strong className="text-primary">7-0</strong> pitch
          {"  "}
          <strong className="text-primary">Z</strong>/<strong className="text-primary">C</strong>/<strong className="text-primary">X</strong> fader
        </span>
      </div>

      {/* Faders sit on the outside edges, mirroring a mixer layout. */}
      <div className="grid gap-stack-md md:grid-cols-2">
        <div className="flex gap-stack-sm items-start">
          <ChannelFader value={deckA.volume} onChange={deckA.setVolume} side="A" />
          <div className="flex-1 min-w-0">
            <DeckPanel
              deck={deckA}
              side="A"
              eq={eqA}
              onEq={(b, v) => applyEq("A", b, v)}
              zoomSec={zoomA}
              onZoom={setZoomA}
              keyHint={{ play: "Q", cue: "W" }}
            />
          </div>
        </div>
        <div className="flex gap-stack-sm items-start">
          <div className="flex-1 min-w-0">
            <DeckPanel
              deck={deckB}
              side="B"
              eq={eqB}
              onEq={(b, v) => applyEq("B", b, v)}
              zoomSec={zoomB}
              onZoom={setZoomB}
              keyHint={{ play: "P", cue: "O" }}
            />
          </div>
          <ChannelFader value={deckB.volume} onChange={deckB.setVolume} side="B" />
        </div>
      </div>

      <div className="mt-stack-md border border-primary p-gutter">
        <div className="flex flex-wrap items-center justify-between gap-stack-sm mb-stack-md">
          <div className="flex items-center gap-stack-sm">
            <button
              onClick={() => syncTo("B")}
              disabled={!canSync}
              className="font-label-caps text-label-caps border border-primary px-3 py-1 hover:bg-primary hover:text-on-primary transition-none disabled:opacity-30"
              title="Match deck A to deck B's tempo and beat"
            >
              SYNC A TO B
            </button>
            <button
              onClick={() => syncTo("A")}
              disabled={!canSync}
              className="font-label-caps text-label-caps border border-primary px-3 py-1 hover:bg-primary hover:text-on-primary transition-none disabled:opacity-30"
              title="Match deck B to deck A's tempo and beat"
            >
              SYNC B TO A
            </button>
            {lockedTo && (
              <button
                onClick={() => setLockedTo(null)}
                className="flex items-center gap-1 font-label-mono text-label-mono text-primary border border-primary px-2 py-1 hover:bg-primary hover:text-on-primary transition-none"
                title="Release the beat lock"
              >
                <span className="material-symbols-outlined text-[14px]">lock</span>
                locked to {lockedTo}
              </button>
            )}
            {syncNote && (
              <span className="font-label-mono text-label-mono text-secondary">
                {syncNote}
              </span>
            )}
          </div>

          <button
            onClick={recording ? stopRecording : startRecording}
            disabled={!recorderReady}
            className={`flex items-center gap-2 font-label-caps text-label-caps border px-3 py-1 transition-none disabled:opacity-30 ${
              recording
                ? "border-error text-error"
                : "border-primary hover:bg-primary hover:text-on-primary"
            }`}
            title={
              recording
                ? "Stop and save the recording"
                : "Record the mix as it plays, exactly what comes out of the crossfader"
            }
          >
            <span className="material-symbols-outlined text-[16px]">
              {recording ? "stop_circle" : "fiber_manual_record"}
            </span>
            {recording ? `RECORDING ${fmt(recordSecs)}` : "RECORD"}
          </button>
        </div>

        <div className="flex items-baseline justify-between mb-stack-sm font-label-mono text-label-mono">
          <span className="text-secondary">A</span>
          <span className="uppercase">
            Crossfader
            {bpmGap != null && (
              <span className={`ml-3 ${Math.abs(bpmGap) < 0.2 ? "text-primary" : "text-secondary"}`}>
                {bpmGap === 0
                  ? "decks matched"
                  : `${bpmGap > 0 ? "+" : ""}${bpmGap} bpm apart`}
              </span>
            )}
          </span>
          <span className="text-secondary">B</span>
        </div>
        <input
          type="range"
          min={0}
          max={1}
          step={0.01}
          value={crossfade}
          onChange={(e) => setCrossfade(Number(e.target.value))}
          onDoubleClick={() => setCrossfade(0.5)}
          className="w-full accent-primary"
          aria-label="Crossfader"
        />
      </div>
    </section>
  );
}
