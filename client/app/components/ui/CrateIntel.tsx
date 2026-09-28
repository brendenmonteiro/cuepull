"use client";

import type { LibraryStats } from "@/types";

// Every figure here comes from tracks actually on disk. Where something has
// not been computed yet, the panel says so rather than showing a zero that
// looks like a real measurement.

function fmtBytes(n: number) {
  if (!n) return "0 MB";
  const gb = n / 1073741824;
  return gb >= 1 ? `${gb.toFixed(2)} GB` : `${Math.round(n / 1048576)} MB`;
}

function fmtDuration(secs: number | null) {
  if (!secs) return "--:--";
  const m = Math.floor(secs / 60);
  const s = secs % 60;
  return `${m}:${String(s).padStart(2, "0")}`;
}

const SOURCE_LABELS: Record<string, { name: string; note: string }> = {
  youtube: { name: "YouTube", note: "Audio rip stream" },
  soundcloud: { name: "SoundCloud", note: "Free DLs & promos" },
  bandcamp: { name: "Bandcamp", note: "Direct purchase / lossless" },
  archive: { name: "Internet Archive", note: "Public domain" },
  fma: { name: "Free Music Archive", note: "Creative Commons" },
  spotify: { name: "Spotify list", note: "Name lookup only" },
  url: { name: "Direct URL", note: "Pasted link" },
  unknown: { name: "Unknown", note: "Added before tracking" },
};

function Bar({ share, muted }: { share: number; muted?: boolean }) {
  return (
    <div className="h-1 bg-surface-container-highest mt-1">
      <div
        className={muted ? "h-full bg-secondary" : "h-full bg-primary"}
        style={{ width: `${Math.max(share, 1)}%` }}
      />
    </div>
  );
}

function Panel({
  title,
  note,
  children,
}: {
  title: string;
  note?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="border border-primary">
      <div className="flex items-baseline justify-between px-gutter py-stack-sm border-b border-primary">
        <h3 className="font-label-caps text-label-caps uppercase">{title}</h3>
        {note && (
          <span className="font-label-mono text-label-mono text-secondary">{note}</span>
        )}
      </div>
      <div className="p-gutter">{children}</div>
    </div>
  );
}

export function CrateIntel({ stats }: { stats: LibraryStats | null }) {
  if (!stats || stats.totals.tracks === 0) {
    return (
      <section className="mt-stack-lg">
        <div className="border-t border-dashed border-outline-variant pt-stack-md">
          <p className="font-label-mono text-label-mono text-secondary">
            // CRATE INTEL
          </p>
          <p className="font-body-sm text-body-sm text-secondary mt-stack-sm">
            Nothing saved yet. Download a track and the breakdown fills in.
          </p>
        </div>
      </section>
    );
  }

  const t = stats.totals;
  const topGenre = stats.genres[0] ?? null;
  const genreCoverage = stats.genreCoverage;

  return (
    <section className="mt-stack-lg">
      <div className="border-t border-dashed border-outline-variant pt-stack-md mb-stack-md">
        <p className="font-label-mono text-label-mono text-secondary">
          // LIBRARY BREAKDOWN (EVERYTHING SAVED TO DISK)
        </p>
        <h2 className="font-label-caps text-label-caps uppercase mt-1">
          Crate Intel // Genre &amp; Key Recap
        </h2>
      </div>

      {/* Headline */}
      <div className="border border-primary p-gutter mb-gutter">
        <div className="flex flex-wrap gap-stack-lg items-start justify-between">
          <div className="min-w-[240px] flex-1">
            {topGenre ? (
              <>
                <div className="flex items-center gap-stack-sm mb-stack-sm">
                  <span className="font-label-caps text-label-caps bg-primary text-on-primary px-2 py-1 uppercase">
                    Top genre
                  </span>
                  <span className="font-label-mono text-label-mono text-secondary">
                    {topGenre.share}% of tagged tracks
                  </span>
                </div>
                <h3 className="font-headline-md text-headline-md uppercase">
                  {topGenre.genre}
                </h3>
                <p className="font-label-mono text-label-mono text-secondary mt-1">
                  Inferred from source tags on {genreCoverage.known} of{" "}
                  {genreCoverage.total} tracks
                </p>
              </>
            ) : (
              <>
                <h3 className="font-headline-md text-headline-md uppercase">
                  No genre data yet
                </h3>
                <p className="font-label-mono text-label-mono text-secondary mt-1">
                  Genre comes from source tags. Tracks added before tracking, or
                  from sources without tags, show nothing here.
                </p>
              </>
            )}
          </div>

          <div className="flex flex-wrap gap-stack-lg font-label-mono text-label-mono">
            <div>
              <div className="text-secondary">BPM SWEET SPOT</div>
              <div className="font-headline-md text-headline-md mt-1">
                {stats.bpm.range
                  ? `${stats.bpm.range.low} - ${stats.bpm.range.high}`
                  : "--"}
              </div>
              <div className="text-secondary mt-1">
                {stats.bpm.median ? `Median ${stats.bpm.median}` : "Not analysed"}
              </div>
            </div>
            <div>
              <div className="text-secondary">LIBRARY</div>
              <div className="font-headline-md text-headline-md mt-1">
                {t.hours} HRS
              </div>
              <div className="text-secondary mt-1">{t.tracks} tracks</div>
            </div>
            <div>
              <div className="text-secondary">LOSSLESS</div>
              <div className="font-headline-md text-headline-md mt-1">
                {t.losslessShare}%
              </div>
              <div className="text-secondary mt-1">FLAC &amp; WAV</div>
            </div>
          </div>
        </div>
      </div>

      {/* Genre distribution */}
      {stats.genres.length > 0 && (
        <div className="border border-primary mb-gutter">
          <div className="flex items-baseline justify-between bg-primary text-on-primary px-gutter py-stack-sm">
            <h3 className="font-label-caps text-label-caps uppercase">
              Genre distribution
            </h3>
            <span className="font-label-mono text-label-mono">
              from source tags
            </span>
          </div>
          <div className="p-gutter flex flex-col gap-stack-md">
            {stats.genres.slice(0, 5).map((g, i) => (
              <div key={g.genre}>
                <div className="flex flex-wrap items-baseline justify-between gap-2 font-label-mono text-label-mono">
                  <span className="uppercase">
                    {String(i + 1).padStart(2, "0")}. {g.genre}
                  </span>
                  <span className="text-secondary">
                    {g.avgBpm ? `${g.avgBpm} BPM  ` : ""}
                    {g.tracks} {g.tracks === 1 ? "track" : "tracks"}{" "}
                    {fmtBytes(g.bytes)}{" "}
                    <strong className="text-primary">{g.share}%</strong>
                  </span>
                </div>
                <Bar share={g.share} muted={i > 0} />
              </div>
            ))}
          </div>
        </div>
      )}

      <div className="grid grid-cols-1 md:grid-cols-2 gap-gutter mb-gutter">
        {/* Most played */}
        <Panel
          title="Most played"
          note={
            stats.playSource === "rekordbox"
              ? "from rekordbox"
              : stats.playSource === "manual"
                ? "marked by hand"
                : "no data"
          }
        >
          {stats.mostPlayed.length ? (
            <div className="flex flex-col gap-stack-md">
              {stats.mostPlayed.map((p, i) => (
                <div key={i} className="flex items-start justify-between gap-2">
                  <div className="min-w-0">
                    <div className="font-label-mono text-label-mono truncate">
                      {String(i + 1).padStart(2, "0")} {p.title}
                    </div>
                    <div className="font-label-mono text-label-mono text-secondary mt-1">
                      {[
                        p.artist,
                        p.bpm ? `${p.bpm} BPM` : null,
                        p.camelot,
                        p.cuePoints != null ? `${p.cuePoints} cues` : null,
                      ]
                        .filter(Boolean)
                        .join("  ")}
                    </div>
                  </div>
                  <span className="font-label-caps text-label-caps border border-primary px-2 py-1 whitespace-nowrap">
                    {p.plays} {p.plays === 1 ? "PLAY" : "PLAYS"}
                  </span>
                </div>
              ))}
            </div>
          ) : (
            <p className="font-body-sm text-body-sm text-secondary">
              Cuepull does not play audio, so it cannot count plays on its own.
              Mark tracks played here, or import a rekordbox collection to pull
              in real counts and cue points.
            </p>
          )}
        </Panel>

        {/* Format */}
        <Panel title="Format breakdown" note="lossless vs compressed">
          <div className="flex flex-col gap-stack-md">
            {stats.formats.map((f, i) => (
              <div key={f.format}>
                <div className="flex items-baseline justify-between font-label-mono text-label-mono">
                  <span className="uppercase">{f.format}</span>
                  <span className="text-secondary">
                    <strong className="text-primary">{f.share}%</strong> (
                    {f.tracks} {f.tracks === 1 ? "track" : "tracks"})
                  </span>
                </div>
                <Bar share={f.share} muted={i > 0} />
              </div>
            ))}
            <div className="flex items-baseline justify-between font-label-mono text-label-mono pt-stack-sm border-t border-outline-variant">
              <span className="text-secondary">TOTAL STORAGE</span>
              <span>{fmtBytes(t.bytes)}</span>
            </div>
          </div>
        </Panel>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-gutter">
        {/* Keys */}
        <Panel title="Speed &amp; key profile" note="camelot wheel">
          {stats.keys.length ? (
            <>
              <div className="grid grid-cols-3 gap-stack-sm">
                {stats.keys.slice(0, 3).map((k, i) => (
                  <div
                    key={k.camelot}
                    className="border border-primary p-stack-sm text-center"
                  >
                    <div className="font-label-mono text-label-mono text-secondary">
                      TOP KEY #{i + 1}
                    </div>
                    <div className="font-headline-md text-headline-md mt-1">
                      {k.camelot}
                    </div>
                    <div className="font-label-mono text-label-mono text-secondary mt-1">
                      {k.name} ({k.share}%)
                    </div>
                  </div>
                ))}
              </div>
              <div className="flex flex-wrap justify-between gap-2 font-label-mono text-label-mono mt-stack-md pt-stack-sm border-t border-outline-variant">
                <span className="text-secondary">
                  AVG TRACK{" "}
                  <strong className="text-primary">
                    {fmtDuration(t.avgDurationSec)}
                  </strong>
                </span>
                <span className="text-secondary">
                  ANALYSED{" "}
                  <strong className="text-primary">
                    {stats.keyCoverage.known}/{stats.keyCoverage.total}
                  </strong>
                </span>
              </div>
            </>
          ) : (
            <p className="font-body-sm text-body-sm text-secondary">
              {t.pendingAnalysis > 0
                ? `Analysing ${t.pendingAnalysis} tracks for BPM and key.`
                : "No key data yet."}
            </p>
          )}
        </Panel>

        {/* Sources */}
        <Panel title="Source pipeline" note="where tracks came from">
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-stack-sm">
            {stats.sources.slice(0, 4).map((s) => {
              const label = SOURCE_LABELS[s.source] ?? {
                name: s.source,
                note: "",
              };
              return (
                <div
                  key={s.source}
                  className="border border-primary p-stack-sm flex items-start justify-between gap-2"
                >
                  <div className="min-w-0">
                    <div className="font-label-mono text-label-mono uppercase truncate">
                      {label.name}
                    </div>
                    <div className="font-label-mono text-label-mono text-secondary truncate">
                      {label.note}
                    </div>
                  </div>
                  <span className="font-headline-md text-headline-md">
                    {s.share}%
                  </span>
                </div>
              );
            })}
          </div>
        </Panel>
      </div>
    </section>
  );
}
