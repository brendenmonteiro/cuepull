"use client";
import { motion } from "framer-motion";
import { TrackMeta } from "@/types";

interface FoundStateProps {
  songName: string;
  meta?: TrackMeta;
  isDownloading?: boolean;
  downloadProgress?: number;
}

export function FoundState({ songName, meta, isDownloading, downloadProgress = 0 }: FoundStateProps) {
  return (
    <div className="border border-primary">
      <div className="bg-primary text-on-primary px-gutter py-stack-sm">
        <span className="font-label-mono text-label-mono text-on-primary-container">
          {isDownloading ? "DOWNLOADING // 320kbps" : "SEARCHING..."}
        </span>
      </div>
      {meta && (
        <div className="px-gutter py-stack-md">
          <h2 className="font-display-lg-mobile text-display-lg-mobile leading-none">{meta.title}</h2>
          <p className="font-label-mono text-label-mono text-secondary mt-2 uppercase">{meta.artist}</p>
          {meta.duration && <p className="font-label-mono text-label-mono text-secondary mt-unit">{meta.duration}</p>}
        </div>
      )}
      {isDownloading && (
        <div className="px-gutter pb-stack-md">
          <div className="flex justify-between font-label-mono text-label-mono text-secondary mb-unit">
            <span>MP3 320kbps</span><span>{downloadProgress}%</span>
          </div>
          <div className="h-px bg-surface-container w-full">
            <motion.div className="h-full bg-primary" animate={{ width: `${downloadProgress}%` }} transition={{ duration: 0.3 }} />
          </div>
        </div>
      )}
    </div>
  );
}
