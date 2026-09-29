"use client";

import { useCallback, useEffect, useRef, useState } from "react";

// One deck: load a file, play it, move the pitch fader, EQ it, seek it.
//
// Built on Web Audio rather than an <audio> element because a deck needs a
// gain and filter chain per channel and sample accurate restarts, neither of
// which a media element gives you.
//
// This is a preview player. Latency is fine for auditioning a transition, not
// for beatjuggling on a controller.

export interface DeckWaveform {
  durationSec: number;
  /** Derived from the analysed tempo, absent when a track has no bpm. */
  grid: { bpm: number; beatSec: number; offsetSec: number } | null;
  overview: { buckets: number; peaks: Int8Array };
  detail: { buckets: number; peaks: Int8Array };
}

export interface DeckTrack {
  fileName: string;
  title: string;
  artist: string;
  bpm: number | null;
  camelot: string | null;
}

export type EqBand = "low" | "mid" | "high";

// One AudioContext for the whole page. Browsers cap how many you can make, and
// two decks have to share a clock to be mixed against each other at all.
let sharedCtx: AudioContext | null = null;
function audioContext(): AudioContext {
  if (!sharedCtx) {
    sharedCtx = new (window.AudioContext ||
      (window as unknown as { webkitAudioContext: typeof AudioContext })
        .webkitAudioContext)();
  }
  return sharedCtx;
}

export function useDeck(serverUrl: string) {
  const ctxRef = useRef<AudioContext | null>(null);
  const bufferRef = useRef<AudioBuffer | null>(null);
  const sourceRef = useRef<AudioBufferSourceNode | null>(null);

  // Chain: source -> low -> mid -> high -> trim -> channel -> (crossfader)
  const eqRef = useRef<Record<EqBand, BiquadFilterNode> | null>(null);
  const trimRef = useRef<GainNode | null>(null);
  const outRef = useRef<GainNode | null>(null);

  // Where the playhead was when we last started, and the context time then.
  // Position is derived from these rather than stored, because an
  // AudioBufferSourceNode does not report its own position.
  const startedAtRef = useRef(0);
  const offsetRef = useRef(0);

  const [track, setTrack] = useState<DeckTrack | null>(null);
  const [waveform, setWaveform] = useState<DeckWaveform | null>(null);
  const [playing, setPlaying] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [duration, setDuration] = useState(0);
  const [position, setPosition] = useState(0);
  const [pitch, setPitch] = useState(0); // percent, -8 to +8
  const [cuePoint, setCuePoint] = useState(0);
  const [volume, setVolumeState] = useState(1); // channel fader, 0 to 1

  // Build the node chain once.
  useEffect(() => {
    const ctx = audioContext();
    ctxRef.current = ctx;

    const low = ctx.createBiquadFilter();
    low.type = "lowshelf";
    low.frequency.value = 200;

    const mid = ctx.createBiquadFilter();
    mid.type = "peaking";
    mid.frequency.value = 1000;
    mid.Q.value = 0.8;

    const high = ctx.createBiquadFilter();
    high.type = "highshelf";
    high.frequency.value = 4000;

    const trim = ctx.createGain();
    const out = ctx.createGain();

    low.connect(mid).connect(high).connect(trim).connect(out);

    eqRef.current = { low, mid, high };
    trimRef.current = trim;
    outRef.current = out;

    return () => {
      try {
        sourceRef.current?.stop();
      } catch {
        // Already stopped.
      }
      out.disconnect();
    };
  }, []);

  const rate = 1 + pitch / 100;

  // Position ticks off requestAnimationFrame while playing. Reading the
  // context clock is cheap and stays accurate; a counter would drift.
  useEffect(() => {
    if (!playing) return;
    let raf = 0;
    const tick = () => {
      const ctx = ctxRef.current;
      if (ctx) {
        const elapsed = (ctx.currentTime - startedAtRef.current) * rate;
        const p = offsetRef.current + elapsed;
        if (p >= duration) {
          setPosition(duration);
          setPlaying(false);
          return;
        }
        setPosition(p);
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [playing, rate, duration]);

  const stopSource = useCallback(() => {
    const s = sourceRef.current;
    if (!s) return;
    try {
      s.onended = null;
      s.stop();
    } catch {
      // Never started.
    }
    s.disconnect();
    sourceRef.current = null;
  }, []);

  const startAt = useCallback(
    (offset: number) => {
      const ctx = ctxRef.current;
      const buf = bufferRef.current;
      const eq = eqRef.current;
      if (!ctx || !buf || !eq) return;

      stopSource();

      const src = ctx.createBufferSource();
      src.buffer = buf;
      src.playbackRate.value = 1 + pitch / 100;
      src.connect(eq.low);
      src.onended = () => {
        // Only a natural end should clear the flag; a seek stops the node too.
        if (sourceRef.current === src) setPlaying(false);
      };
      src.start(0, Math.max(0, Math.min(offset, buf.duration)));

      sourceRef.current = src;
      startedAtRef.current = ctx.currentTime;
      offsetRef.current = offset;
      setPosition(offset);
    },
    [pitch, stopSource]
  );

  const load = useCallback(
    async (
      next: DeckTrack,
      fetchWaveform: (fileName: string) => Promise<DeckWaveform | null>
    ) => {
      setLoading(true);
      setError(null);
      stopSource();
      setPlaying(false);

      try {
        const ctx = ctxRef.current ?? audioContext();
        // Browsers start the context suspended until a gesture. Loading is
        // always triggered by a click, so this is the right place to resume.
        if (ctx.state === "suspended") await ctx.resume();

        const url = `${serverUrl}/downloads/${next.fileName
          .split("/")
          .map(encodeURIComponent)
          .join("/")}`;

        const [res, wf] = await Promise.all([
          fetch(url),
          fetchWaveform(next.fileName).catch(() => null),
        ]);
        if (!res.ok) throw new Error(`could not read the file (${res.status})`);

        const bytes = await res.arrayBuffer();
        const buf = await ctx.decodeAudioData(bytes);

        bufferRef.current = buf;
        setTrack(next);
        setWaveform(wf);
        setDuration(buf.duration);
        setPosition(0);
        offsetRef.current = 0;
        setCuePoint(0);
      } catch (err) {
        setError(err instanceof Error ? err.message : "could not load the track");
        bufferRef.current = null;
        setTrack(null);
        setWaveform(null);
        setDuration(0);
      } finally {
        setLoading(false);
      }
    },
    [serverUrl, stopSource]
  );

  const play = useCallback(async () => {
    const ctx = ctxRef.current;
    if (!ctx || !bufferRef.current) return;
    if (ctx.state === "suspended") await ctx.resume();
    startAt(offsetRef.current >= duration ? 0 : offsetRef.current);
    setPlaying(true);
  }, [startAt, duration]);

  const pause = useCallback(() => {
    const ctx = ctxRef.current;
    if (!ctx || !sourceRef.current) return;
    const elapsed = (ctx.currentTime - startedAtRef.current) * (1 + pitch / 100);
    offsetRef.current = Math.min(offsetRef.current + elapsed, duration);
    stopSource();
    setPlaying(false);
    setPosition(offsetRef.current);
  }, [pitch, duration, stopSource]);

  const toggle = useCallback(() => {
    if (playing) pause();
    else void play();
  }, [playing, pause, play]);

  const seek = useCallback(
    (seconds: number) => {
      const clamped = Math.max(0, Math.min(seconds, duration));
      offsetRef.current = clamped;
      setPosition(clamped);
      if (playing) startAt(clamped);
    },
    [duration, playing, startAt]
  );

  // Cue behaves like a CDJ:
  //   playing            jump back to the cue point and stop
  //   stopped, not at it return to it
  //   stopped, already at it  set a new cue point here
  //
  // The middle case is what was missing. Pressing cue while stopped only ever
  // moved the marker, so after seeking somewhere else there was no way back,
  // and the button looked like it did nothing.
  const cue = useCallback(() => {
    if (playing) {
      stopSource();
      setPlaying(false);
      offsetRef.current = cuePoint;
      setPosition(cuePoint);
      return;
    }
    // Within a frame of the cue point counts as "already there".
    if (Math.abs(offsetRef.current - cuePoint) < 0.02) {
      setCuePoint(offsetRef.current);
    } else {
      offsetRef.current = cuePoint;
      setPosition(cuePoint);
    }
  }, [playing, cuePoint, stopSource]);

  // Drop a cue point wherever the playhead is, whatever the transport state.
  const setCueHere = useCallback(() => {
    setCuePoint(offsetRef.current);
  }, []);

  // Momentary cue preview, the way a CDJ behaves: hold to audition from the
  // cue point, release and the deck snaps back and stops. Spamming it can
  // never leave the track running, which is what made it feel wrong before.
  const previewingRef = useRef(false);

  const cuePreviewStart = useCallback(async () => {
    const ctx = ctxRef.current;
    if (!ctx || !bufferRef.current || previewingRef.current) return;
    if (ctx.state === "suspended") await ctx.resume();
    previewingRef.current = true;
    startAt(cuePoint);
    setPlaying(true);
  }, [cuePoint, startAt]);

  const cuePreviewEnd = useCallback(() => {
    if (!previewingRef.current) return;
    previewingRef.current = false;
    stopSource();
    setPlaying(false);
    offsetRef.current = cuePoint;
    setPosition(cuePoint);
  }, [cuePoint, stopSource]);

  // Jump to the cue point and keep playing. This is the one that commits, so
  // it clears the preview flag rather than arming a snap back.
  const cuePlay = useCallback(async () => {
    const ctx = ctxRef.current;
    if (!ctx || !bufferRef.current) return;
    if (ctx.state === "suspended") await ctx.resume();
    previewingRef.current = false;
    startAt(cuePoint);
    setPlaying(true);
  }, [cuePoint, startAt]);

  // Pitch applies live, so a running deck can be nudged into time.
  useEffect(() => {
    const ctx = ctxRef.current;
    const src = sourceRef.current;
    if (!ctx || !src) return;
    // Bank the time already played at the old rate before changing it, or the
    // position calculation jumps.
    const elapsed = (ctx.currentTime - startedAtRef.current) * src.playbackRate.value;
    offsetRef.current += elapsed;
    startedAtRef.current = ctx.currentTime;
    src.playbackRate.value = 1 + pitch / 100;
  }, [pitch]);

  const setEq = useCallback((band: EqBand, db: number) => {
    const eq = eqRef.current;
    if (!eq) return;
    eq[band].gain.value = db;
  }, []);

  // Channel fader. Squared so the travel feels like a mixer: most of the
  // useful range sits in the top half rather than everything happening in the
  // last centimetre, which is how a linear gain control behaves.
  const setVolume = useCallback((v: number) => {
    const clamped = Math.max(0, Math.min(1, v));
    setVolumeState(clamped);
    if (trimRef.current) trimRef.current.gain.value = clamped * clamped;
  }, []);

  const eject = useCallback(() => {
    stopSource();
    bufferRef.current = null;
    setTrack(null);
    setWaveform(null);
    setPlaying(false);
    setDuration(0);
    setPosition(0);
    offsetRef.current = 0;
    setCuePoint(0);
    setError(null);
  }, [stopSource]);

  // Effective bpm once the pitch fader is taken into account.
  const playingBpm =
    track?.bpm != null ? Math.round(track.bpm * (1 + pitch / 100) * 10) / 10 : null;

  return {
    track,
    waveform,
    playing,
    loading,
    error,
    duration,
    position,
    pitch,
    cuePoint,
    playingBpm,
    outputNode: outRef,
    context: ctxRef,
    load,
    play,
    pause,
    toggle,
    seek,
    cue,
    cuePlay,
    cuePreviewStart,
    cuePreviewEnd,
    setCueHere,
    volume,
    setVolume,
    setPitch,
    setEq,
    eject,
  };
}

export type Deck = ReturnType<typeof useDeck>;
