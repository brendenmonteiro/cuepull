"use client";

import { motion, AnimatePresence } from "framer-motion";
import { Track } from "@/types";

interface TrackCardProps {
  track: Track;
  index: number;
  onMarkPlayed: (trackId: string) => void;
  onRemove: (trackId: string) => void;
}

type StatusInfo = { label: string; icon: string; inverted: boolean };

const STATUS: Record<string, StatusInfo> = {
  pending:     { label: "PENDING",         icon: "hourglass_empty", inverted: false },
  searching:   { label: "SEARCHING...",    icon: "sync",            inverted: true  },
  found:       { label: "FOUND EXTENDED",  icon: "check_circle",    inverted: true  },
  downloading: { label: "DOWNLOADING...",  icon: "cloud_download",  inverted: true  },
  ready:       { label: "READY",           icon: "check_circle",    inverted: false },
  played:      { label: "PLAYED",          icon: "done_all",        inverted: false },
  error:       { label: "ERROR",           icon: "error",           inverted: false },
};

export function TrackCard({ track, index, onMarkPlayed, onRemove }: TrackCardProps) {
  const sm = STATUS[track.status] ?? STATUS.pending;
  const isActive = sm.inverted;
  const isReady = track.status === "ready";
  const isError = track.status === "error";
  const isPlayed = track.status === "played";

  const numStr = String(index).padStart(2, "0");

  return (
    <motion.div
      layout
      initial={{ opacity: 0 }}
      animate={{ opacity: isPlayed ? 0.4 : 1 }}
      exit={{ opacity: 0, height: 0, overflow: "hidden" }}
      transition={{ duration: 0.18 }}
    >
      {/* Main row */}
      <div
        className={`grid grid-cols-12 px-4 py-4 border-b border-primary items-start group transition-none ${
          isActive
            ? "bg-primary text-on-primary"
            : "bg-background text-primary hover:bg-surface-container"
        }`}
      >
        {/* # */}
        <div className={`col-span-1 font-label-mono text-label-mono pt-0.5 ${isActive ? "text-on-primary-container" : "text-secondary"}`}>
          {numStr}
        </div>

        {/* Title / Artist */}
        <div className="col-span-7">
          <p className="font-headline-md text-headline-md leading-none">
            {track.meta?.title || track.songName}
          </p>
          {track.meta?.artist && (
            <p className={`font-label-mono text-label-mono mt-1 uppercase ${isActive ? "text-on-primary-container" : "text-secondary"}`}>
              {track.meta.artist}
            </p>
          )}
          {track.meta?.duration && (
            <p className={`font-label-mono text-label-mono mt-1 ${isActive ? "text-on-primary-container" : "text-secondary"}`}>
              {track.meta.duration}
            </p>
          )}

          {/* Progress bar */}
          <AnimatePresence>
            {track.status === "downloading" && (
              <motion.div
                initial={{ opacity: 0, height: 0 }}
                animate={{ opacity: 1, height: "auto" }}
                exit={{ opacity: 0, height: 0 }}
                className="mt-2 overflow-hidden"
              >
                <div className="flex justify-between font-label-mono text-label-mono text-on-primary-container mb-unit">
                  <span>
                    {track.meta?.format === "flac" ? "FLAC LOSSLESS"
                      : track.meta?.format === "wav" ? "WAV LOSSLESS"
                      : "MP3 320kbps"}
                  </span>
                  <span>{track.progress}%</span>
                </div>
                <div className="h-px bg-on-primary-container">
                  <motion.div
                    className="h-full bg-on-primary"
                    animate={{ width: `${track.progress}%` }}
                    transition={{ duration: 0.3 }}
                  />
                </div>
              </motion.div>
            )}
          </AnimatePresence>

          {isError && track.error && (
            <p className="font-label-mono text-label-mono text-error mt-1 truncate">{track.error}</p>
          )}
        </div>

        {/* Status + actions */}
        <div className="col-span-4 text-right flex flex-col items-end gap-stack-sm">
          <span className={`inline-flex items-center gap-1 font-label-caps text-label-caps ${
            isError ? "text-error" : isActive ? "text-on-primary" : "text-secondary"
          }`}>
            <span className={`material-symbols-outlined text-[14px] ${track.status === "searching" || track.status === "downloading" ? "animate-spin" : ""}`}>
              {sm.icon}
            </span>
            <span className="hidden sm:inline">{sm.label}</span>
          </span>

          {/* Action buttons — visible on hover */}
          <div className={`flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity ${isActive ? "text-on-primary-container" : "text-secondary"}`}>
            {isReady && (
              <>
                <a
                  href={`${process.env.NEXT_PUBLIC_SERVER_URL}/downloads/${encodeURIComponent(track.meta?.fileName ?? `${track.trackId}.mp3`)}`}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="material-symbols-outlined text-[16px] hover:text-primary transition-none cursor-pointer"
                  title="Download MP3"
                >
                  download
                </a>
                <button
                  onClick={() => onMarkPlayed(track.trackId)}
                  className="material-symbols-outlined text-[16px] hover:text-primary transition-none"
                  title="Mark as played"
                >
                  play_arrow
                </button>
              </>
            )}
            <button
              onClick={() => onRemove(track.trackId)}
              className={`material-symbols-outlined text-[16px] hover:text-error transition-none`}
              title="Remove"
            >
              close
            </button>
          </div>
        </div>
      </div>
    </motion.div>
  );
}
