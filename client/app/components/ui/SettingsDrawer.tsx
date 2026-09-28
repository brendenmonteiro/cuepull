"use client";

import { useEffect, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import type { AppSettings, FormatMode } from "@/types";

// Order matters: this is how the options read in the menu, simplest first.
const FORMAT_OPTIONS: { value: FormatMode; label: string; note: string }[] = [
  { value: "mp3", label: "MP3 only", note: "320 kbps, always available" },
  { value: "flac", label: "FLAC only", note: "Fails if no lossless source" },
  { value: "wav", label: "WAV only", note: "Fails if no lossless source" },
  { value: "flac-then-mp3", label: "FLAC if available, else MP3", note: "Lossless when it exists" },
  { value: "wav-then-flac", label: "WAV if available, else FLAC", note: "Lossless only" },
  { value: "wav-flac-mp3", label: "Best available: WAV, FLAC, MP3", note: "Never fails" },
  { value: "flac-wav-mp3", label: "Best available: FLAC, WAV, MP3", note: "Never fails" },
];

function Row({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="py-stack-md border-b border-outline-variant last:border-b-0">
      <div className="font-label-caps text-label-caps uppercase mb-1">{label}</div>
      {hint && (
        <p className="font-label-mono text-label-mono text-secondary mb-stack-sm">
          {hint}
        </p>
      )}
      {children}
    </div>
  );
}

function Toggle({
  on,
  onChange,
  label,
}: {
  on: boolean;
  onChange: (v: boolean) => void;
  label: string;
}) {
  return (
    <button
      onClick={() => onChange(!on)}
      role="switch"
      aria-checked={on}
      className={`w-full flex items-center justify-between border border-primary px-3 py-2 font-label-mono text-label-mono transition-none ${
        on ? "bg-primary text-on-primary" : "text-secondary hover:bg-surface-container"
      }`}
    >
      <span>{label}</span>
      <span className="material-symbols-outlined text-[18px]">
        {on ? "toggle_on" : "toggle_off"}
      </span>
    </button>
  );
}

export function SettingsDrawer({
  open,
  onClose,
  settings,
  onSave,
  theme,
  onTheme,
}: {
  open: boolean;
  onClose: () => void;
  settings: AppSettings | null;
  onSave: (patch: Partial<AppSettings>) => void;
  theme: "light" | "dark";
  onTheme: () => void;
}) {
  const [local, setLocal] = useState<AppSettings | null>(settings);
  const [savedNote, setSavedNote] = useState<string | null>(null);

  useEffect(() => setLocal(settings), [settings]);

  // Escape closes, which is what people expect from a drawer.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  if (!local) return null;

  const patch = (p: Partial<AppSettings>) => {
    setLocal({ ...local, ...p });
    onSave(p);
    setSavedNote("Saved");
    setTimeout(() => setSavedNote(null), 1400);
  };

  const chooseFolder = async () => {
    if (!window.cuepull?.isDesktop) return;
    const pick = await window.cuepull.pickLibraryFolder();
    if (pick.canceled || !pick.path) return;
    patch({ downloadsDir: pick.path });
  };

  return (
    <AnimatePresence>
      {open && (
        <>
          <motion.div
            key="scrim"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.15 }}
            className="fixed inset-0 z-50 bg-background/80 backdrop-blur-sm"
            onClick={onClose}
          />
          <motion.aside
            key="drawer"
            initial={{ x: "100%" }}
            animate={{ x: 0 }}
            exit={{ x: "100%" }}
            transition={{ duration: 0.2, ease: "easeOut" }}
            className="fixed right-0 top-0 bottom-0 z-50 w-full max-w-md bg-background border-l border-primary overflow-y-auto no-scrollbar"
          >
            <div className="sticky top-0 bg-background border-b border-primary px-gutter py-stack-md flex items-center justify-between">
              <h2 className="font-label-caps text-label-caps uppercase">Settings</h2>
              <div className="flex items-center gap-stack-md">
                {savedNote && (
                  <span className="font-label-mono text-label-mono text-secondary">
                    {savedNote}
                  </span>
                )}
                <button
                  onClick={onClose}
                  className="material-symbols-outlined text-[20px] text-secondary hover:text-primary transition-none"
                  aria-label="Close settings"
                >
                  close
                </button>
              </div>
            </div>

            <div className="px-gutter pb-stack-lg">
              <Row
                label="Format preference"
                hint="Used when you have not picked a format for a search. Lossless comes from the Internet Archive, Free Music Archive and Bandcamp, so it does not exist for every track."
              >
                <div className="flex flex-col gap-1">
                  {FORMAT_OPTIONS.map((o) => (
                    <button
                      key={o.value}
                      onClick={() => patch({ formatMode: o.value })}
                      className={`text-left border border-primary px-3 py-2 transition-none ${
                        local.formatMode === o.value
                          ? "bg-primary text-on-primary"
                          : "hover:bg-surface-container"
                      }`}
                    >
                      <div className="font-label-mono text-label-mono">{o.label}</div>
                      <div
                        className={`font-label-mono text-label-mono ${
                          local.formatMode === o.value
                            ? "text-on-primary-container"
                            : "text-secondary"
                        }`}
                      >
                        {o.note}
                      </div>
                    </button>
                  ))}
                </div>
              </Row>

              <Row label="Library folder" hint="Where finished tracks are saved.">
                <div className="flex items-stretch gap-stack-sm">
                  <div className="flex-1 min-w-0 border border-primary px-3 py-2 font-label-mono text-label-mono break-all">
                    {local.downloadsDir || "(default)"}
                  </div>
                  <button
                    onClick={chooseFolder}
                    className="font-label-caps text-label-caps border border-primary px-4 hover:bg-primary hover:text-on-primary transition-none whitespace-nowrap"
                  >
                    CHANGE
                  </button>
                </div>
                <div className="mt-stack-sm">
                  <Toggle
                    on={local.dateFolders}
                    onChange={(v) => patch({ dateFolders: v })}
                    label="Group into folders by date"
                  />
                </div>
              </Row>

              <Row label="Search behaviour">
                <div className="flex flex-col gap-stack-sm">
                  <Toggle
                    on={local.askExtended}
                    onChange={(v) => patch({ askExtended: v })}
                    label="Ask Extended Mix or Original"
                  />
                  <Toggle
                    on={local.preferExtended}
                    onChange={(v) => patch({ preferExtended: v })}
                    label="Prefer Extended Mix in playlists"
                  />
                </div>
              </Row>

              <Row
                label="Analysis"
                hint="BPM and key are detected on your machine after a download. Two to three seconds per track, nothing is uploaded."
              >
                <Toggle
                  on={local.analyseOnDownload}
                  onChange={(v) => patch({ analyseOnDownload: v })}
                  label="Detect BPM and key automatically"
                />
              </Row>

              <Row label="Appearance">
                <Toggle
                  on={theme === "dark"}
                  onChange={onTheme}
                  label={theme === "dark" ? "Dark theme" : "Light theme"}
                />
              </Row>

              <Row
                label="Spotify"
                hint="Only needed for Spotify playlist links. Free to create at developer.spotify.com. Stored on this machine and only ever sent to Spotify."
              >
                <div className="flex flex-col gap-stack-sm">
                  <input
                    id="spotify-id"
                    type="text"
                    value={local.spotifyClientId}
                    onChange={(e) => setLocal({ ...local, spotifyClientId: e.target.value })}
                    onBlur={() => onSave({ spotifyClientId: local.spotifyClientId })}
                    placeholder="Client ID"
                    className="border border-primary bg-background px-3 py-2 font-label-mono text-label-mono outline-none focus:border-primary"
                  />
                  <input
                    id="spotify-secret"
                    type="password"
                    value={local.spotifyClientSecret}
                    onChange={(e) =>
                      setLocal({ ...local, spotifyClientSecret: e.target.value })
                    }
                    onBlur={() => onSave({ spotifyClientSecret: local.spotifyClientSecret })}
                    placeholder="Client secret"
                    className="border border-primary bg-background px-3 py-2 font-label-mono text-label-mono outline-none focus:border-primary"
                  />
                </div>
              </Row>
            </div>
          </motion.aside>
        </>
      )}
    </AnimatePresence>
  );
}
