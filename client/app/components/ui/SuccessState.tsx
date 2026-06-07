"use client";
import { TrackMeta } from "@/types";

interface SuccessStateProps {
  songName: string;
  meta?: TrackMeta;
  onRequestAnother: () => void;
}

export function SuccessState({ songName, meta, onRequestAnother }: SuccessStateProps) {
  return (
    <div className="border border-primary">
      <div className="bg-primary text-on-primary px-gutter py-stack-sm flex items-center gap-1">
        <span className="material-symbols-outlined text-[14px] text-on-primary-container">check_circle</span>
        <span className="font-label-mono text-label-mono text-on-primary-container">READY // ADDED TO QUEUE</span>
      </div>
      <div className="px-gutter py-stack-md">
        <h2 className="font-display-lg-mobile text-display-lg-mobile leading-none">{meta?.title || songName}</h2>
        {meta?.artist && <p className="font-label-mono text-label-mono text-secondary mt-2 uppercase">{meta.artist}</p>}
        {meta?.duration && <p className="font-label-mono text-label-mono text-secondary mt-unit">{meta.duration}</p>}
      </div>
      <div className="px-gutter pb-stack-md">
        <button
          onClick={onRequestAnother}
          className="font-label-caps text-label-caps border border-primary px-6 py-stack-sm hover:bg-primary hover:text-on-primary transition-none"
        >
          NEW REQUEST
        </button>
      </div>
    </div>
  );
}
