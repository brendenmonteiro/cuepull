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

function DeckPanel({
  deck,
  side,
  eq,
  onEq,
}: {
  deck: Deck;
  side: "A" | "B";
  eq: Record<EqBand, number>;
  onEq: (band: EqBand, db: number) => void;
}) {
  const { track, waveform, playing, loading, error, duration, position, pitch } = deck;

  return (
    <div className="border border-primary flex flex-col">
      <div className="flex items-baseline justify-between px-3 py-2 border-b border-primary">
        <span className="font-label-caps text-label-caps uppercase">Deck {side}</span>
        <div className="flex items-center gap-stack-md font-label-mono text-label-mono">
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
        mode="detail"
        windowSec={8}
        height={72}
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
        <span className="text-secondary">-{fmt(Math.max(0, duration - position))}</span>
      </div>

      <div className="flex items-stretch gap-1 p-3 border-b border-outline-variant">
        <button
          onClick={deck.cue}
          disabled={!track}
          className="flex-1 font-label-caps text-label-caps border border-primary py-2 hover:bg-primary hover:text-on-primary transition-none disabled:opacity-30"
          title="Set the cue point when stopped, jump back to it when playing"
        >
          CUE
        </button>
        <button
          onClick={deck.toggle}
          disabled={!track}
          className={`flex-[2] font-label-caps text-label-caps border border-primary py-2 transition-none disabled:opacity-30 ${
            playing ? "bg-primary text-on-primary" : "hover:bg-primary hover:text-on-primary"
          }`}
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
  // Which deck the next load goes to. Alternates so two presses fill both.
  const nextDeck = useRef<"A" | "B">("A");

  // Wire both decks into the crossfader once their chains exist.
  const faderRef = useRef<{ a: GainNode; b: GainNode } | null>(null);
  useEffect(() => {
    const ctx = deckA.context.current;
    const outA = deckA.outputNode.current;
    const outB = deckB.outputNode.current;
    if (!ctx || !outA || !outB || faderRef.current) return;

    const a = ctx.createGain();
    const b = ctx.createGain();
    outA.connect(a).connect(ctx.destination);
    outB.connect(b).connect(ctx.destination);
    faderRef.current = { a, b };

    return () => {
      a.disconnect();
      b.disconnect();
      faderRef.current = null;
    };
  }, [deckA.context, deckA.outputNode, deckB.outputNode]);

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

  // Space toggles the deck that has a track, or deck A when both do.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement | null;
      if (el && /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName)) return;
      if (e.code !== "Space") return;
      e.preventDefault();
      if (deckA.track) deckA.toggle();
      else if (deckB.track) deckB.toggle();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [deckA, deckB]);

  // How far apart the two decks are, so you can see whether they will ride
  // into each other before you try.
  const bpmGap =
    deckA.playingBpm != null && deckB.playingBpm != null
      ? Math.round((deckB.playingBpm - deckA.playingBpm) * 10) / 10
      : null;

  return (
    <section className="mt-stack-lg border-t border-dashed border-outline-variant pt-stack-md">
      <div className="flex items-baseline justify-between mb-stack-md">
        <p className="font-label-mono text-label-mono text-secondary">// DECKS</p>
        <span className="font-label-mono text-label-mono text-secondary">
          space plays, double click a fader to reset
        </span>
      </div>

      <div className="grid gap-stack-md md:grid-cols-2">
        <DeckPanel deck={deckA} side="A" eq={eqA} onEq={(b, v) => applyEq("A", b, v)} />
        <DeckPanel deck={deckB} side="B" eq={eqB} onEq={(b, v) => applyEq("B", b, v)} />
      </div>

      <div className="mt-stack-md border border-primary p-gutter">
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
