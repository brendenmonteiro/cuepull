// types/index.ts — Shared types across the app

export type TrackStatus =
  | "pending"
  | "searching"
  | "found"
  | "downloading"
  | "ready"
  | "played"
  | "error";

export interface TrackMeta {
  title: string;
  artist: string;
  url: string;
  duration: string;
  bpm?: number;
  key?: string;
  fileName?: string;
  format?: "mp3" | "flac" | "wav";
}

export interface Track {
  trackId: string;
  songName: string;
  requestedBy: string;
  status: TrackStatus;
  progress: number;        // 0–100
  requestedAt: string;     // ISO date string
  meta: TrackMeta | null;
  error: string | null;
}

// ── Socket event payloads ─────────────────────────────────────────────────────

export interface RequestReceivedPayload {
  trackId: string;
}

export interface RequestUpdatePayload {
  trackId: string;
  status: TrackStatus;
  meta?: TrackMeta;
}

export interface RequestErrorPayload {
  trackId?: string;
  message: string;
}

export interface DJProgressPayload {
  trackId: string;
  progress: number;
}

// ── UI state for the mobile view ──────────────────────────────────────────────

export type MobileRequestState =
  | { phase: "idle" }
  | { phase: "requesting"; trackId?: string }
  | { phase: "searching"; trackId: string }
  | { phase: "choice"; trackId: string; hasExtended: boolean; extendedTitle: string | null }
  | { phase: "found"; trackId: string; meta?: TrackMeta }
  | { phase: "downloading"; trackId: string; progress: number; meta?: TrackMeta }
  | { phase: "ready"; trackId: string; meta?: TrackMeta }
  | { phase: "bulk"; count: number }
  | { phase: "error"; message: string };
