// types/index.ts, Shared types across the app

export type TrackStatus =
  | "pending"
  | "searching"
  | "found"
  | "staged"
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

//  Socket event payloads

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

//  UI state for the mobile view

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

//  Desktop bridge (Electron preload)
// Present only inside the packaged desktop app; undefined in a browser.
export interface SaveResult {
  saved: boolean;
  canceled?: boolean;
  path?: string;
  error?: string;
}

export interface CuepullBridge {
  isDesktop: true;
  saveTrack(p: { fileName: string; suggestedName?: string }): Promise<SaveResult>;
  chooseFolder(): Promise<{ canceled: boolean; dir?: string }>;
  saveTrackTo(p: { fileName: string; dir: string; suggestedName?: string }): Promise<SaveResult>;
  revealFile(absPath: string): Promise<{ ok: boolean }>;
  pickLibraryFolder(): Promise<{ canceled: boolean; path?: string }>;
  pickRekordboxXml(): Promise<{ canceled: boolean; path?: string }>;
  pickRekordboxSave(): Promise<{ canceled: boolean; path?: string }>;
}

declare global {
  interface Window {
    cuepull?: CuepullBridge;
  }
}

// Library stats. Built server side from tracks actually on disk.
export interface FormatRow { format: string; tracks: number; bytes: number; share: number; }
export interface SourceRow { source: string; count: number; share: number; }
export interface GenreRow { genre: string; tracks: number; bytes: number; share: number; avgBpm: number | null; }
export interface KeyRow { camelot: string; name: string; count: number; share: number; }
export interface PlayedRow {
  title: string; artist: string; plays: number;
  cuePoints: number | null; bpm: number | null; camelot: string | null;
  external: boolean;
}

export interface LibraryStats {
  totals: {
    tracks: number; bytes: number; hours: number;
    avgDurationSec: number | null; losslessShare: number;
    analysed: number; pendingAnalysis: number;
  };
  formats: FormatRow[];
  sources: SourceRow[];
  genres: GenreRow[];
  genreCoverage: { known: number; total: number };
  bpm: { range: { low: number; high: number } | null; median: number | null; count: number };
  keys: KeyRow[];
  keyCoverage: { known: number; total: number };
  mostPlayed: PlayedRow[];
  playSource: "rekordbox" | "manual" | null;
}

export interface LibraryTrack {
  fileName: string;
  title: string;
  artist: string;
  bpm: number | null;
  camelot: string | null;
  musicalKey: string | null;
  durationSec: number | null;
}

export interface SetlistTrack {
  fileName: string;
  title: string;
  artist: string;
  bpm: number | null;
  camelot: string | null;
  musicalKey: string | null;
  durationSec: number | null;
  position: number;
  energy: number;
}

export interface SetlistTransition {
  fromFile: string;
  toFile: string;
  keyNote: string;
  bpmNote: string;
  bpmDelta: number | null;
  keyDistance: number;
  tempoDistance: number;
  /** 0 to 1, higher is smoother. Below 0.5 is worth a second look. */
  score: number;
  rough: boolean;
}

export interface SetlistOutlier extends Omit<SetlistTrack, "position" | "energy"> {
  reason: string;
}

export interface Setlist {
  tracks: SetlistTrack[];
  transitions: SetlistTransition[];
  outliers: SetlistOutlier[];
  stats: {
    count: number;
    rough: number;
    averageScore: number | null;
    totalSeconds: number;
    bpmRange: { min: number; max: number } | null;
  } | null;
}

export type FormatMode =
  | "mp3" | "flac" | "wav"
  | "flac-then-mp3" | "wav-then-flac"
  | "wav-flac-mp3" | "flac-wav-mp3";

export interface AppSettings {
  formatMode: FormatMode;
  downloadsDir: string | null;
  dateFolders: boolean;
  askExtended: boolean;
  preferExtended: boolean;
  analyseOnDownload: boolean;
  theme: "system" | "light" | "dark";
  spotifyClientId: string;
  spotifyClientSecret: string;
}
