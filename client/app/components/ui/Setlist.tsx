"use client";

import { useState } from "react";
import type { Setlist as SetlistData, SetlistTransition } from "@/types";

// The ordered set, with the reason for every join shown between the rows.
// A transition you disagree with is more useful than a number you cannot
// argue with, so each one says what it did: "one step on the wheel, +1.1 bpm".

function fmtClock(secs: number) {
  const h = Math.floor(secs / 3600);
  const m = Math.round((secs % 3600) / 60);
  return h ? `${h}h ${m}m` : `${m}m`;
}

function fmtDuration(secs: number | null) {
  if (!secs) return "--:--";
  const m = Math.floor(secs / 60);
  const s = Math.round(secs % 60);
  return `${m}:${String(s).padStart(2, "0")}`;
}

// Running time at the start of each track, assuming tracks play end to end.
// Real sets overlap, so this is an upper bound, which is the useful direction
// when you are checking a set fits a slot.
function cueTimes(durations: (number | null)[]) {
  const out: number[] = [];
  let t = 0;
  for (const d of durations) {
    out.push(t);
    t += d || 0;
  }
  return out;
}

function Join({ t }: { t: SetlistTransition }) {
  // Colour carries the same information as the text, never on its own.
  const tone = t.rough
    ? "text-error border-error"
    : t.score >= 0.85
      ? "text-primary border-outline-variant"
      : "text-secondary border-outline-variant";

  return (
    <div className="flex items-center gap-stack-sm pl-[2.75rem] py-1">
      <span className={`material-symbols-outlined text-[14px] ${tone.split(" ")[0]}`}>
        {t.rough ? "warning" : "arrow_downward"}
      </span>
      <span className={`font-label-mono text-label-mono ${tone.split(" ")[0]}`}>
        {t.keyNote}, {t.bpmNote}
      </span>
      {t.rough && (
        <span className="font-label-mono text-label-mono text-error">
          [rough]
        </span>
      )}
    </div>
  );
}

export function Setlist({
  setlist,
  loading,
  onBuild,
  onPlay,
}: {
  setlist: SetlistData | null;
  loading: boolean;
  onBuild: () => void;
  onPlay?: (fileName: string) => void;
}) {
  const [showJoins, setShowJoins] = useState(true);

  const header = (
    <div className="flex items-baseline justify-between mb-stack-md">
      <p className="font-label-mono text-label-mono text-secondary">// SETLIST</p>
      <div className="flex items-center gap-stack-md">
        {setlist && setlist.tracks.length > 0 && (
          <button
            onClick={() => setShowJoins((v) => !v)}
            className="font-label-mono text-label-mono text-secondary hover:text-primary transition-none"
          >
            {showJoins ? "hide joins" : "show joins"}
          </button>
        )}
        <button
          onClick={onBuild}
          disabled={loading}
          className="font-label-caps text-label-caps border border-primary px-4 py-1 hover:bg-primary hover:text-on-primary transition-none disabled:opacity-40"
        >
          {loading ? "ORDERING" : setlist ? "REBUILD" : "BUILD SETLIST"}
        </button>
      </div>
    </div>
  );

  if (!setlist || !setlist.stats || setlist.tracks.length === 0) {
    return (
      <section className="mt-stack-lg border-t border-dashed border-outline-variant pt-stack-md">
        {header}
        <p className="font-body-sm text-body-sm text-secondary">
          {loading
            ? "Working out an order."
            : "Orders your library by key, tempo and energy into something you could play front to back."}
        </p>
      </section>
    );
  }

  const { tracks, transitions, outliers, stats } = setlist;
  const starts = cueTimes(tracks.map((t) => t.durationSec));

  return (
    <section className="mt-stack-lg border-t border-dashed border-outline-variant pt-stack-md">
      {header}

      <div className="flex flex-wrap gap-x-stack-lg gap-y-1 mb-stack-md font-label-mono text-label-mono text-secondary">
        <span>{stats.count} tracks</span>
        <span>{fmtClock(stats.totalSeconds)}</span>
        {stats.bpmRange && (
          <span>
            {stats.bpmRange.min} to {stats.bpmRange.max} bpm
          </span>
        )}
        <span>
          {stats.averageScore != null ? stats.averageScore.toFixed(2) : "--"} avg
        </span>
        <span className={stats.rough ? "text-error" : undefined}>
          {stats.rough} rough {stats.rough === 1 ? "join" : "joins"}
        </span>
      </div>

      <ol className="border border-primary">
        {tracks.map((t, i) => (
          <li key={t.fileName}>
            <div
              className={`flex items-center gap-stack-sm px-3 py-2 ${
                i > 0 ? "border-t border-outline-variant" : ""
              } ${onPlay ? "hover:bg-surface-container" : ""}`}
            >
              <span className="font-label-mono text-label-mono text-secondary w-6 shrink-0 text-right">
                {t.position}
              </span>

              <span className="font-label-caps text-label-caps w-10 shrink-0">
                {t.camelot || "--"}
              </span>

              <span className="font-label-mono text-label-mono w-14 shrink-0 text-right">
                {t.bpm != null ? t.bpm.toFixed(1) : "--"}
              </span>

              <span className="font-body-sm text-body-sm flex-1 min-w-0 truncate">
                {t.artist ? (
                  <>
                    <span className="text-secondary">{t.artist}</span>
                    {"  "}
                    {t.title}
                  </>
                ) : (
                  t.title || t.fileName
                )}
              </span>

              <span className="font-label-mono text-label-mono text-secondary shrink-0">
                {fmtDuration(t.durationSec)}
              </span>

              <span
                className="font-label-mono text-label-mono text-secondary shrink-0 w-12 text-right"
                title="Running time at this point if tracks play end to end"
              >
                {fmtClock(starts[i])}
              </span>

              {onPlay && (
                <button
                  onClick={() => onPlay(t.fileName)}
                  className="material-symbols-outlined text-[18px] text-secondary hover:text-primary transition-none shrink-0"
                  aria-label={`Load ${t.title || t.fileName} into a deck`}
                >
                  play_circle
                </button>
              )}
            </div>

            {showJoins && i < transitions.length && (
              <div className="border-t border-dashed border-outline-variant bg-surface-container/40">
                <Join t={transitions[i]} />
              </div>
            )}
          </li>
        ))}
      </ol>

      {outliers.length > 0 && (
        <div className="mt-stack-md border border-dashed border-outline-variant p-gutter">
          <p className="font-label-caps text-label-caps uppercase mb-1">
            Left out ({outliers.length})
          </p>
          <p className="font-label-mono text-label-mono text-secondary mb-stack-sm">
            Nothing else in the crate is near these tempos, so they would break
            the set wherever they went.
          </p>
          <ul className="flex flex-col gap-1">
            {outliers.map((o) => (
              <li
                key={o.fileName}
                className="flex items-center gap-stack-sm font-label-mono text-label-mono"
              >
                <span className="w-10 shrink-0">{o.camelot || "--"}</span>
                <span className="w-14 shrink-0 text-right">
                  {o.bpm != null ? o.bpm.toFixed(1) : "--"}
                </span>
                <span className="truncate text-secondary">
                  {o.artist ? `${o.artist}  ` : ""}
                  {o.title || o.fileName}
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </section>
  );
}
