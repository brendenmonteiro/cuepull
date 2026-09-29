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

  // Cue behaves like a CDJ: press cue when stopped to set the point, press it
  // while playing to jump back to it and stop.
  const cue = useCallback(() => {
    if (playing) {
      stopSource();
      setPlaying(false);
      offsetRef.current = cuePoint;
      setPosition(cuePoint);
    } else {
      setCuePoint(offsetRef.current);
    }
  }, [playing, cuePoint, stopSource]);

  const cuePlay = useCallback(() => {
    seek(cuePoint);
    void play();
  }, [cuePoint, seek, play]);

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

  const setTrim = useCallback((gain: number) => {
    if (trimRef.current) trimRef.current.gain.value = gain;
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
    setPitch,
    setEq,
    setTrim,
    eject,
  };
}

export type Deck = ReturnType<typeof useDeck>;
