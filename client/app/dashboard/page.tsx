"use client";

import { useState, useEffect, useRef, useCallback } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { connectSocket } from "@/lib/socket";
import { Track, TrackMeta } from "@/types";
import { TrackCard } from "@/app/components/ui/TrackCard";

type Filter = "all" | "active" | "staged" | "ready" | "played";
type Format = "mp3" | "flac" | "wav";
type Mode = "song" | "playlist" | "soundcloud";

const ACTIVE = new Set(["pending", "searching", "found", "downloading"]);
// Found a source but not fetched yet, waiting on the user to press Download.
const STAGED = "staged";

// Extended-mix choice modal state
type ChoiceState =
  | { open: false }
  | { open: true; trackId: string; hasExtended: boolean; extendedTitle: string | null };

export default function DashboardPage() {
  const [queue, setQueue] = useState<Track[]>([]);
  const [connected, setConnected] = useState(false);
  const [filter, setFilter] = useState<Filter>("all");
  const [queueId, setQueueId] = useState("----");
  const [theme, setTheme] = useState<"light" | "dark">("light");

  // Search controls
  const [input, setInput] = useState("");
  const [mode, setMode] = useState<Mode>("song");
  const [format, setFormat] = useState<Format>("mp3");
  const [choice, setChoice] = useState<ChoiceState>({ open: false });

  const socketRef = useRef(connectSocket());
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    setQueueId(Math.floor(Math.random() * 0xffff).toString(16).toUpperCase().padStart(4, "0"));
    // Pick up whatever the pre-paint script in layout.tsx already applied.
    const active = document.documentElement.getAttribute("data-theme");
    if (active === "dark" || active === "light") {
      setTheme(active);
    } else {
      setTheme(window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light");
    }
  }, []);

  const toggleTheme = () => {
    const next = theme === "dark" ? "light" : "dark";
    setTheme(next);
    document.documentElement.setAttribute("data-theme", next);
    try {
      localStorage.setItem("cratedigger-theme", next);
    } catch {
      // Private window or blocked storage. The choice just will not persist.
    }
  };

  useEffect(() => {
    const socket = socketRef.current;
    socket.on("connect", () => { setConnected(true); socket.emit("dj:join"); });
    socket.on("disconnect", () => setConnected(false));
    socket.on("queue:sync", (q: Track[]) => setQueue(q));
    socket.on("dj:track-added", (track: Track) => {
      setQueue((prev) => prev.find((t) => t.trackId === track.trackId) ? prev : [...prev, track]);
    });
    socket.on("dj:track-updated", (updated: Track) => {
      setQueue((prev) => prev.map((t) => t.trackId === updated.trackId ? updated : t));
    });
    socket.on("dj:progress", ({ trackId, progress }: { trackId: string; progress: number }) => {
      setQueue((prev) => prev.map((t) => t.trackId === trackId ? { ...t, progress } : t));
    });
    // Extended-mix prompt for single-song searches
    socket.on("request:extended-result", ({ trackId, hasExtended, extendedTitle }: {
      trackId: string; hasExtended: boolean; extendedTitle: string | null;
    }) => {
      setChoice({ open: true, trackId, hasExtended, extendedTitle });
    });
    return () => {
      ["connect","disconnect","queue:sync","dj:track-added","dj:track-updated","dj:progress","request:extended-result"]
        .forEach((e) => socket.off(e));
    };
  }, []);

  const submit = useCallback(() => {
    const songName = input.trim();
    if (!songName) return;
    socketRef.current.emit("request:submit", { songName, format });
    setInput("");
    setTimeout(() => inputRef.current?.focus(), 50);
  }, [input, format]);

  const resolveChoice = useCallback((version: "extended" | "original" | "skip") => {
    if (!choice.open) return;
    socketRef.current.emit("request:version-choice", { trackId: choice.trackId, version });
    setChoice({ open: false });
  }, [choice]);

  const markPlayed = (trackId: string) => {
    socketRef.current.emit("dj:mark-played", { trackId });
    setQueue((prev) => prev.map((t) => t.trackId === trackId ? { ...t, status: "played" } : t));
  };
  const removeTrack = (trackId: string) => {
    socketRef.current.emit("dj:remove-track", { trackId });
    setQueue((prev) => prev.filter((t) => t.trackId !== trackId));
  };
  const clearQueue = () => {
    socketRef.current.emit("dj:clear-queue");
    setQueue([]);
    // Reset the view filter too, otherwise a clear done while viewing
    // "ready"/"played" hides every newly added track (they arrive "pending").
    setFilter("all");
  };

  // Nothing is fetched until one of these runs, the queue holds candidates,
  // not files. "Fetch" pulls the audio via the server; "save" then copies it
  // wherever the user chooses.
  const [busyIds, setBusyIds] = useState<Set<string>>(new Set());
  const [notice, setNotice] = useState<string | null>(null);

  const markBusy = (id: string, on: boolean) =>
    setBusyIds((prev) => {
      const next = new Set(prev);
      on ? next.add(id) : next.delete(id);
      return next;
    });

  const fetchTrack = (trackId: string): Promise<{ ok: boolean; fileName?: string; error?: string }> =>
    new Promise((resolve) => {
      socketRef.current.emit("dj:download", { trackId }, resolve);
    });

  const suggestedName = (t: Track) =>
    t.meta?.fileName?.split("/").pop() ?? `${t.songName}.${t.meta?.format ?? "mp3"}`;

  // One track: fetch if needed, then a native Save As dialog.
  const downloadOne = useCallback(async (trackId: string) => {
    const track = queue.find((t) => t.trackId === trackId);
    if (!track) return;
    markBusy(trackId, true);
    setNotice(null);
    try {
      let fileName = track.meta?.fileName;
      if (!fileName) {
        const res = await fetchTrack(trackId);
        if (!res.ok) {
          setNotice(res.error ?? "Download failed.");
          return;
        }
        fileName = res.fileName;
      }
      if (!fileName) return;

      if (window.cratedigger?.isDesktop) {
        const out = await window.cratedigger.saveTrack({
          fileName,
          suggestedName: fileName.split("/").pop(),
        });
        if (out.saved) setNotice(`Saved to ${out.path}`);
        else if (out.error) setNotice(out.error);
      } else {
        // Browser fallback: plain link download.
        const rel = fileName.split("/").map(encodeURIComponent).join("/");
        const a = document.createElement("a");
        a.href = `${process.env.NEXT_PUBLIC_SERVER_URL}/downloads/${rel}`;
        a.download = fileName.split("/").pop() ?? "";
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
      }
    } finally {
      markBusy(trackId, false);
    }
  }, [queue]);

  // Every staged track: ask once for a folder, then fetch and write each one.
  const downloadAll = useCallback(async () => {
    const targets = queue.filter(
      (t) => t.status === STAGED || (t.status === "ready" && t.meta?.fileName)
    );
    if (!targets.length) return;
    setNotice(null);

    let dir: string | undefined;
    if (window.cratedigger?.isDesktop) {
      const pick = await window.cratedigger.chooseFolder();
      if (pick.canceled || !pick.dir) return;
      dir = pick.dir;
    }

    let saved = 0;
    const failures: string[] = [];

    for (const t of targets) {
      markBusy(t.trackId, true);
      try {
        let fileName = t.meta?.fileName;
        if (!fileName) {
          const res = await fetchTrack(t.trackId);
          if (!res.ok) {
            failures.push(t.songName);
            continue;
          }
          fileName = res.fileName;
        }
        if (!fileName) continue;

        if (dir && window.cratedigger?.isDesktop) {
          const out = await window.cratedigger.saveTrackTo({
            fileName,
            dir,
            suggestedName: fileName.split("/").pop(),
          });
          if (out.saved) saved++;
          else failures.push(t.songName);
        } else {
          const rel = fileName.split("/").map(encodeURIComponent).join("/");
          const a = document.createElement("a");
          a.href = `${process.env.NEXT_PUBLIC_SERVER_URL}/downloads/${rel}`;
          a.download = fileName.split("/").pop() ?? "";
          document.body.appendChild(a);
          a.click();
          document.body.removeChild(a);
          saved++;
          await new Promise((r) => setTimeout(r, 400));
        }
      } finally {
        markBusy(t.trackId, false);
      }
    }

    setNotice(
      failures.length
        ? `Saved ${saved}. Failed: ${failures.join(", ")}`
        : `Saved ${saved} track${saved === 1 ? "" : "s"}${dir ? ` to ${dir}` : ""}`
    );
  }, [queue]);

  const stats = {
    total: queue.length,
    staged: queue.filter((t) => t.status === STAGED).length,
    active: queue.filter((t) => ACTIVE.has(t.status)).length,
    ready: queue.filter((t) => t.status === "ready").length,
    played: queue.filter((t) => t.status === "played").length,
  };

  const filtered = queue.filter((t) => {
    if (filter === "active") return ACTIVE.has(t.status);
    if (filter === "staged") return t.status === STAGED;
    if (filter === "ready") return t.status === "ready";
    if (filter === "played") return t.status === "played";
    return true;
  });

  const MODES: Record<Mode, { placeholder: string; button: string; icon: string }> = {
    song:       { placeholder: "Track or artist name",                 button: "SEARCH",   icon: "search" },
    playlist:   { placeholder: "Spotify or SoundCloud playlist URL",   button: "EXTRACT",  icon: "link" },
    soundcloud: { placeholder: "SoundCloud or Bandcamp track URL",     button: "DOWNLOAD", icon: "link" },
  };

  return (
    <div className="min-h-screen bg-background flex flex-col">

      {/* Top App Bar */}
      <header className="bg-background border-b border-primary flex items-center justify-between px-gutter h-16 sticky top-0 z-40">
        <div className="flex items-center gap-unit">
          <span className="material-symbols-outlined text-primary">graphic_eq</span>
          <h1 className="font-label-mono text-label-mono tracking-widest text-primary uppercase">CRATEDIGGER</h1>
        </div>
        <div className="flex items-center gap-stack-md">
          <span className="font-label-mono text-label-mono text-secondary hidden sm:block">
            {connected ? `LIVE // ${stats.active} ACTIVE` : "OFFLINE"}
          </span>
          <span className={`material-symbols-outlined text-[18px] ${connected ? "text-primary" : "text-secondary"}`}>sensors</span>
          <button
            onClick={toggleTheme}
            className="material-symbols-outlined text-[18px] text-secondary hover:text-primary transition-none"
            title={theme === "dark" ? "Switch to light" : "Switch to dark"}
            aria-label={theme === "dark" ? "Switch to light theme" : "Switch to dark theme"}
          >
            {theme === "dark" ? "light_mode" : "dark_mode"}
          </button>
        </div>
      </header>

      <main className="max-w-5xl mx-auto w-full px-gutter py-stack-md md:py-stack-lg flex-1">

        {/*  Search / download console  */}
        <section className="mb-stack-lg border border-primary">
          {/* Input row */}
          <div className="flex items-center border-b border-primary">
            <span className="material-symbols-outlined px-gutter text-primary text-[22px]">{MODES[mode].icon}</span>
            <input
              ref={inputRef}
              type="text"
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && submit()}
              placeholder={MODES[mode].placeholder}
              className="flex-1 bg-transparent border-none focus:ring-0 font-headline-md text-headline-md py-stack-md placeholder:text-surface-container-highest outline-none"
              autoComplete="off"
              autoCorrect="off"
              spellCheck={false}
            />
            <button
              onClick={submit}
              disabled={!input.trim()}
              className="self-stretch bg-primary text-on-primary font-label-caps text-label-caps px-8 hover:bg-primary-container disabled:opacity-30 disabled:cursor-not-allowed transition-none whitespace-nowrap"
            >
              {MODES[mode].button}
            </button>
          </div>

          {/* Controls row */}
          <div className="flex flex-wrap items-center justify-between gap-stack-md px-gutter py-stack-sm">
            {/* Mode */}
            <div className="flex items-center gap-stack-md">
              <span className="font-label-caps text-label-caps uppercase text-secondary">Source</span>
              {(["song", "playlist", "soundcloud"] as Mode[]).map((m) => (
                <button
                  key={m}
                  onClick={() => setMode(m)}
                  className={`font-label-mono text-label-mono uppercase transition-none ${
                    mode === m ? "text-primary" : "text-secondary hover:text-on-surface"
                  }`}
                >
                  {m === "song" ? "SINGLE" : m === "playlist" ? "PLAYLIST" : "URL"}
                </button>
              ))}
            </div>

            {/* Format */}
            <div className="flex items-center gap-stack-md">
              <span className="font-label-caps text-label-caps uppercase text-secondary">Format</span>
              <div className="flex">
                {(["mp3", "flac", "wav"] as Format[]).map((f) => (
                  <button
                    key={f}
                    onClick={() => setFormat(f)}
                    className={`font-label-mono text-label-mono uppercase px-3 h-7 border border-primary -ml-px first:ml-0 transition-none ${
                      format === f ? "bg-primary text-on-primary" : "bg-background text-secondary hover:text-primary"
                    }`}
                  >
                    {f}
                  </button>
                ))}
              </div>
            </div>
          </div>

          {/* Hint */}
          <div className="px-gutter pb-stack-sm">
            <span className="font-label-mono text-label-mono text-secondary">
              {mode === "song"
                ? "SINGLE // asks Extended Mix or Original, then waits for you to download"
                : mode === "playlist"
                ? "PLAYLIST // auto-prefers Extended Mix, falls back to Original"
                : "URL // pulls the track straight from the link you paste"}
              {format !== "mp3" && " · LOSSLESS"}
            </span>
          </div>
        </section>

        {/*  Queue  */}
        <section>
          <div className="flex justify-between items-end mb-unit">
            <h2 className="font-label-caps text-label-caps uppercase text-secondary">
              Queue ({stats.total} Tracks)
            </h2>
            <div className="flex items-center gap-stack-md">
              <div className="flex gap-stack-md">
                {(["all","active","staged","ready","played"] as Filter[]).map((f) => (
                  <button
                    key={f}
                    onClick={() => setFilter(f)}
                    className={`font-label-mono text-label-mono uppercase transition-none ${
                      filter === f ? "text-primary" : "text-secondary hover:text-on-surface"
                    }`}
                  >
                    {f}{f === "active" && stats.active > 0 ? `(${stats.active})` : f === "staged" && stats.staged > 0 ? `(${stats.staged})` : f === "ready" && stats.ready > 0 ? `(${stats.ready})` : ""}
                  </button>
                ))}
              </div>
              <span className="font-label-mono text-label-mono text-secondary">ID: 0x{queueId}</span>
            </div>
          </div>

          <div className="border border-primary overflow-hidden">
            <div className="grid grid-cols-12 bg-primary text-on-primary px-4 py-3 font-label-caps text-label-caps border-b border-primary">
              <div className="col-span-1">#</div>
              <div className="col-span-7">Track / Artist</div>
              <div className="col-span-4 text-right">Status</div>
            </div>

            <div className="flex flex-col no-scrollbar" style={{ maxHeight: "60vh", overflowY: "auto" }}>
              <AnimatePresence mode="popLayout">
                {filtered.length === 0 ? (
                  <motion.div key="empty" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} className="px-4 py-stack-lg text-center">
                    <p className="font-label-mono text-label-mono text-secondary">
                      {filter === "all" ? "QUEUE EMPTY // SEARCH TO ADD TRACKS" : `NO ${filter.toUpperCase()} TRACKS`}
                    </p>
                  </motion.div>
                ) : (
                  filtered.map((track, i) => (
                    <TrackCard
                      key={track.trackId}
                      track={track}
                      index={i + 1}
                      onMarkPlayed={markPlayed}
                      onRemove={removeTrack}
                      onDownload={downloadOne}
                      busy={busyIds.has(track.trackId)}
                    />
                  ))
                )}
              </AnimatePresence>
            </div>
          </div>

          {notice && (
            <p className="mt-stack-md font-label-mono text-label-mono text-secondary text-right break-all">
              {notice}
            </p>
          )}

          {queue.length > 0 && (
            <div className="mt-stack-md flex justify-end gap-stack-md">
              {stats.staged + stats.ready > 0 && (
                <button
                  onClick={downloadAll}
                  disabled={busyIds.size > 0}
                  className="font-label-caps text-label-caps border border-primary px-6 py-3 bg-primary text-on-primary hover:bg-transparent hover:text-primary transition-none disabled:opacity-50"
                >
                  DOWNLOAD ALL ({stats.staged + stats.ready})
                </button>
              )}
              <button
                onClick={clearQueue}
                className="font-label-caps text-label-caps text-secondary border border-primary px-6 py-3 hover:bg-primary hover:text-on-primary transition-none"
              >
                CLEAR LIST
              </button>
            </div>
          )}
        </section>

        {/* Stats footer */}
        <section className="mt-stack-lg grid grid-cols-1 md:grid-cols-3 gap-gutter">
          <div className="md:col-span-2 border border-primary p-gutter bg-surface-container flex flex-col justify-between h-32">
            <span className="font-label-mono text-label-mono text-secondary">Storage Node</span>
            <div className="flex gap-stack-lg font-label-mono text-label-mono">
              <span>TOTAL <strong className="text-primary">{stats.total}</strong></span>
              <span>ACTIVE <strong className="text-primary">{stats.active}</strong></span>
              <span>TO GET <strong className="text-primary">{stats.staged}</strong></span>
              <span>SAVED <strong className="text-primary">{stats.ready}</strong></span>
              <span>PLAYED <strong className="text-primary">{stats.played}</strong></span>
            </div>
          </div>
          <div className="border border-primary p-gutter flex flex-col justify-between h-32">
            <span className="font-label-mono text-label-mono text-secondary">V.1.05</span>
            <div>
              <h3 className="font-label-caps text-label-caps uppercase mb-unit">MP3 · FLAC · WAV</h3>
              <p className="font-body-sm text-body-sm text-secondary">YouTube + SoundCloud + lossless search with extended-mix prompt.</p>
            </div>
          </div>
        </section>
      </main>

      {/*  Extended / Original prompt modal  */}
      <AnimatePresence>
        {choice.open && (
          <motion.div
            key="modal"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="fixed inset-0 z-50 flex items-center justify-center px-gutter"
          >
            <div className="absolute inset-0 bg-background/80 backdrop-blur-sm" onClick={() => resolveChoice("skip")} />
            <motion.div
              initial={{ opacity: 0, y: 8 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: 8 }}
              transition={{ duration: 0.15 }}
              className="relative w-full max-w-md border border-primary bg-background p-stack-md flex flex-col gap-stack-md"
            >
              <div className="flex items-start justify-between">
                <div>
                  <span className="font-label-mono text-label-mono text-secondary mb-unit block">INTELLIGENT_PROMPT // v1.2</span>
                  <h4 className="font-headline-md text-headline-md text-on-surface">
                    {choice.hasExtended
                      ? "Extended mix available. Download Extended or Original?"
                      : `Extended mix not found. Download original ${format.toUpperCase()}?`}
                  </h4>
                  {choice.hasExtended && choice.extendedTitle && (
                    <p className="font-label-mono text-label-mono text-secondary mt-stack-sm">{choice.extendedTitle}</p>
                  )}
                </div>
                <button
                  onClick={() => resolveChoice("skip")}
                  className="material-symbols-outlined text-secondary hover:bg-primary hover:text-on-primary p-1 transition-none text-[20px]"
                >
                  close
                </button>
              </div>

              {choice.hasExtended ? (
                <div className="grid grid-cols-2 gap-gutter">
                  <button onClick={() => resolveChoice("original")} className="border border-primary py-stack-md font-label-caps text-label-caps uppercase hover:bg-primary hover:text-on-primary transition-none">
                    DOWNLOAD ORIGINAL
                  </button>
                  <button onClick={() => resolveChoice("extended")} className="bg-primary text-on-primary border border-primary py-stack-md font-label-caps text-label-caps uppercase hover:bg-primary-container transition-none">
                    DOWNLOAD EXTENDED
                  </button>
                </div>
              ) : (
                <div className="grid grid-cols-2 gap-gutter">
                  <button onClick={() => resolveChoice("skip")} className="border border-primary py-stack-md font-label-caps text-label-caps uppercase hover:bg-primary hover:text-on-primary transition-none">
                    CANCEL
                  </button>
                  <button onClick={() => resolveChoice("original")} className="bg-primary text-on-primary border border-primary py-stack-md font-label-caps text-label-caps uppercase hover:bg-primary-container transition-none">
                    DOWNLOAD ORIGINAL
                  </button>
                </div>
              )}

              <div className="flex items-center gap-unit">
                <span className="material-symbols-outlined text-[14px] text-secondary">info</span>
                <span className="font-label-mono text-label-mono text-secondary">
                  Format: {format.toUpperCase()} · Extended mixes prioritized for library sync.
                </span>
              </div>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
