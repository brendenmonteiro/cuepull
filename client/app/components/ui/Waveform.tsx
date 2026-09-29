"use client";

import { useEffect, useRef } from "react";

// Canvas waveform. Two modes:
//   overview  the whole track, click to seek, played part dimmed
//   detail    a few seconds either side of the playhead, for lining up a mix
//
// Peaks arrive as interleaved min/max signed bytes from the server, so drawing
// is a straight walk over the array with no decoding in the browser.

function cssVar(el: HTMLElement, name: string, fallback: string) {
  const v = getComputedStyle(el).getPropertyValue(name).trim();
  return v || fallback;
}

export interface BeatGrid {
  bpm: number;
  beatSec: number;
  offsetSec: number;
}

export function Waveform({
  peaks,
  buckets,
  durationSec,
  position,
  cuePoint,
  grid,
  mode,
  windowSec = 8,
  height = 64,
  onSeek,
}: {
  peaks: Int8Array | null;
  buckets: number;
  durationSec: number;
  position: number;
  cuePoint?: number;
  grid?: BeatGrid | null;
  mode: "overview" | "detail";
  windowSec?: number;
  height?: number;
  onSeek?: (seconds: number) => void;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const wrapRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    const wrap = wrapRef.current;
    if (!canvas || !wrap) return;

    const dpr = window.devicePixelRatio || 1;
    const w = wrap.clientWidth;
    const h = height;
    if (!w) return;

    canvas.width = Math.floor(w * dpr);
    canvas.height = Math.floor(h * dpr);
    canvas.style.width = `${w}px`;
    canvas.style.height = `${h}px`;

    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);

    const played = cssVar(wrap, "--color-secondary", "#888");
    const ahead = cssVar(wrap, "--color-primary", "#000");
    const mid = h / 2;

    if (!peaks || !buckets || !durationSec) {
      // A flat line reads as "loaded but silent", so draw nothing instead.
      return;
    }

    // Which slice of the track is on screen, as bucket indices.
    let firstBucket = 0;
    let lastBucket = buckets;
    if (mode === "detail") {
      const perSec = buckets / durationSec;
      const half = (windowSec / 2) * perSec;
      const centre = position * perSec;
      firstBucket = Math.floor(centre - half);
      lastBucket = Math.ceil(centre + half);
    }

    const span = Math.max(1, lastBucket - firstBucket);
    const playheadBucket = (position / durationSec) * buckets;

    // Seconds visible at each edge, used for both the grid and seeking.
    const viewStart =
      mode === "detail" ? position - windowSec / 2 : 0;
    const viewSpan = mode === "detail" ? windowSec : durationSec;

    // Beat grid behind the waveform. Bars (every fourth beat) are drawn
    // solid and full height, plain beats are short ticks, so the phrase
    // structure is readable at a glance without cluttering the view.
    if (grid && grid.beatSec > 0 && mode === "detail") {
      const first = Math.floor((viewStart - grid.offsetSec) / grid.beatSec);
      const last = Math.ceil((viewStart + viewSpan - grid.offsetSec) / grid.beatSec);
      // Skip drawing if the beats would be closer together than a few pixels.
      if (((grid.beatSec / viewSpan) * w) >= 3) {
        for (let n = first; n <= last; n++) {
          const t = grid.offsetSec + n * grid.beatSec;
          if (t < 0) continue;
          const x = ((t - viewStart) / viewSpan) * w;
          if (x < 0 || x > w) continue;
          const isBar = n >= 0 && n % 4 === 0;
          ctx.strokeStyle = played;
          ctx.globalAlpha = isBar ? 0.55 : 0.22;
          ctx.beginPath();
          ctx.moveTo(x + 0.5, isBar ? 0 : h * 0.78);
          ctx.lineTo(x + 0.5, h);
          ctx.stroke();
        }
        ctx.globalAlpha = 1;
      }
    }

    // One vertical line per pixel column, picking the loudest bucket that
    // falls in it, so a long track does not alias into a thin smear.
    for (let x = 0; x < w; x++) {
      const b0 = firstBucket + Math.floor((x / w) * span);
      const b1 = firstBucket + Math.floor(((x + 1) / w) * span);

      let lo = 0;
      let hi = 0;
      let any = false;
      for (let b = b0; b < Math.max(b0 + 1, b1); b++) {
        if (b < 0 || b >= buckets) continue;
        const min = peaks[b * 2];
        const max = peaks[b * 2 + 1];
        if (min < lo) lo = min;
        if (max > hi) hi = max;
        any = true;
      }
      if (!any) continue;

      ctx.strokeStyle = b0 < playheadBucket ? played : ahead;
      ctx.beginPath();
      ctx.moveTo(x + 0.5, mid - (hi / 127) * mid);
      ctx.lineTo(x + 0.5, mid - (lo / 127) * mid);
      ctx.stroke();
    }

    // Cue marker, overview only: in detail view it is usually off screen and
    // a line at the edge is more confusing than helpful.
    if (mode === "overview" && cuePoint != null && cuePoint > 0 && durationSec) {
      const x = (cuePoint / durationSec) * w;
      ctx.strokeStyle = ahead;
      ctx.setLineDash([2, 3]);
      ctx.beginPath();
      ctx.moveTo(x + 0.5, 0);
      ctx.lineTo(x + 0.5, h);
      ctx.stroke();
      ctx.setLineDash([]);
    }

    // Playhead. Centred in detail view, tracks across in overview.
    const px = mode === "detail" ? w / 2 : (position / durationSec) * w;
    ctx.fillStyle = ahead;
    ctx.fillRect(px - 1, 0, 2, h);
  }, [peaks, buckets, durationSec, position, cuePoint, grid, mode, windowSec, height]);

  const click = (e: React.MouseEvent<HTMLDivElement>) => {
    if (!onSeek || !durationSec) return;
    const rect = e.currentTarget.getBoundingClientRect();
    const frac = (e.clientX - rect.left) / rect.width;
    if (mode === "overview") {
      onSeek(frac * durationSec);
    } else {
      // In detail view the click is relative to the centred playhead.
      onSeek(position + (frac - 0.5) * windowSec);
    }
  };

  return (
    <div
      ref={wrapRef}
      onClick={click}
      className={`relative w-full bg-surface-container ${onSeek ? "cursor-pointer" : ""}`}
      style={{ height }}
      role={onSeek ? "slider" : undefined}
      aria-label={onSeek ? "Seek" : undefined}
      aria-valuemin={onSeek ? 0 : undefined}
      aria-valuemax={onSeek ? Math.round(durationSec) : undefined}
      aria-valuenow={onSeek ? Math.round(position) : undefined}
    >
      <canvas ref={canvasRef} className="block" />
    </div>
  );
}
