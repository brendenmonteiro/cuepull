const { v4: uuidv4 } = require("uuid");
const fs = require("fs");
const path = require("path");
const library = require("./library");
const stats = require("./stats");
const { analyseFile } = require("./analyser");
const rekordbox = require("./rekordbox");
const settings = require("./settings");
const { DOWNLOADS_DIR } = require("./musicHandler");
const {
  searchExtendedMix,
  searchOriginal,
  searchLossless,
  searchMusicApi,
  isBandcampUrl,
  downloadTrack,
  isSpotifyUrl,
  getSpotifyTracks,
  isSoundCloudUrl,
  getSoundCloudTracks,
} = require("./musicHandler");

const trackQueue = new Map();
// Holds { resolve, timeout } for tracks awaiting a user version choice
const pendingChoices = new Map();

const DJ_ROOM = "dj-dashboard";

const STATUS = {
  PENDING: "pending",
  SEARCHING: "searching",
  FOUND: "found",
  // Search finished and a source is known, but nothing has been fetched yet.
  // The user commits the download explicitly (per-track or Download All).
  STAGED: "staged",
  DOWNLOADING: "downloading",
  READY: "ready",
  PLAYED: "played",
  ERROR: "error",
};

// Input hardening. Every payload below arrives over a socket, so none of it
// can be trusted to be the right shape. A destructure of null used to throw
// straight out of the handler and take the whole process down with it.

// Track ids are uuids we generated. Anything else is rejected outright, which
// keeps unexpected types from reaching the queue or the filesystem.
const TRACK_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const isTrackId = (v) => typeof v === "string" && TRACK_ID_RE.test(v);

// A search box should never receive a novel-length string.
const MAX_QUERY = 500;

// Wraps a handler so a bad payload or an unexpected throw is logged and
// answered, never fatal. `ack` is called when the client passed a callback.
function safeHandler(name, fn) {
  return async (payload, ack) => {
    try {
      await fn(payload && typeof payload === "object" ? payload : {}, ack);
    } catch (err) {
      console.error(`[Socket] ${name} failed:`, err.message);
      if (typeof ack === "function") {
        ack({ ok: false, error: "Request failed." });
      }
    }
  };
}

// Background BPM and key analysis. Serialised on purpose: each pass spawns
// ffmpeg and runs a wasm module, and doing several at once would compete with
// an in-flight download for CPU.
const analysisQueue = [];
let analysing = false;

function queueAnalysis(io, fileName, absPath) {
  analysisQueue.push({ fileName, absPath });
  drainAnalysis(io);
}

async function drainAnalysis(io) {
  if (analysing) return;
  analysing = true;
  while (analysisQueue.length) {
    const { fileName, absPath } = analysisQueue.shift();
    try {
      const result = await analyseFile(absPath);
      library.setAnalysis(fileName, result);
      broadcastToDJ(io, "stats:update", stats.build());
    } catch (err) {
      console.warn(`[analyser] ${fileName}: ${err.message}`);
    }
  }
  analysing = false;
}

function initSocketManager(io) {
  io.on("connection", (socket) => {
    console.log(`[Socket] Client connected: ${socket.id}`);
    socket.emit("queue:sync", serializeQueue());

    socket.on("dj:join", () => {
      socket.join(DJ_ROOM);
      socket.emit("stats:update", stats.build());
      socket.emit("settings:update", settings.load());
      console.log(`[Socket] DJ dashboard joined: ${socket.id}`);
      socket.emit("queue:sync", serializeQueue());
    });

    //  User chooses Extended Mix or Original
    socket.on("request:version-choice", safeHandler("version-choice", ({ trackId, version }) => {
      if (!isTrackId(trackId)) return;
      if (version !== "extended" && version !== "original" && version !== "skip") return;
      const pending = pendingChoices.get(trackId);
      if (!pending) return;
      clearTimeout(pending.timeout);
      pendingChoices.delete(trackId);
      pending.resolve(version);
    }));

    //  New track request
    // format: "mp3" (default) | "flac" | "wav". Lossless formats route to the
    // legitimate lossless sources (Bandcamp / Internet Archive / FMA).
    socket.on("request:submit", safeHandler("submit", async ({ songName, format }) => {
      if (!songName || typeof songName !== "string" || !songName.trim()) {
        socket.emit("request:error", { message: "Please enter a song name." });
        return;
      }
      if (songName.length > MAX_QUERY) {
        socket.emit("request:error", { message: "That search is too long." });
        return;
      }

      const trimmed = songName.trim();
      // An explicit pick in the UI wins; otherwise fall back to the stored
      // preference, whose first entry is the format to try first.
      const fmt = ["flac", "wav", "mp3"].includes(format)
        ? format
        : settings.formatChain()[0];
      const lossless = fmt !== "mp3";

      //  Spotify playlist / album / track
      if (isSpotifyUrl(trimmed)) {
        let tracks;
        try {
          tracks = await getSpotifyTracks(trimmed);
        } catch (err) {
          socket.emit("request:error", { message: err.message });
          return;
        }
        socket.emit("request:bulk-received", { count: tracks.length });
        for (const { title, artist } of tracks) {
          const query = artist ? `${title} ${artist}` : title;
          const trackId = uuidv4();
          const track = makeTrack(trackId, query, socket.id);
          trackQueue.set(trackId, track);
          broadcastToDJ(io, "dj:track-added", serializeTrack(track));
          if (lossless) {
            // User explicitly chose FLAC or WAV, honor it strictly.
            processLosslessPipeline(io, socket, trackId, query, true, fmt);
          } else {
            // Default: auto-prioritize quality per track → FLAC → WAV → MP3.
            processPlaylistPriorityPipeline(io, socket, trackId, query, true);
          }
        }
        broadcastToDJ(io, "queue:sync", serializeQueue());
        return;
      }

      //  SoundCloud URL
      if (isSoundCloudUrl(trimmed)) {
        let tracks;
        try {
          tracks = await getSoundCloudTracks(trimmed);
        } catch (err) {
          socket.emit("request:error", { message: err.message });
          return;
        }
        if (tracks.length === 1) {
          const trackId = uuidv4();
          const track = makeTrack(trackId, tracks[0].title || trimmed, socket.id);
          trackQueue.set(trackId, track);
          socket.emit("request:received", { trackId });
          broadcastToDJ(io, "dj:track-added", serializeTrack(track));
          broadcastToDJ(io, "queue:sync", serializeQueue());
          processSoundCloudPipeline(io, socket, trackId, tracks[0], false, fmt);
        } else {
          socket.emit("request:bulk-received", { count: tracks.length });
          for (const trackMeta of tracks) {
            const trackId = uuidv4();
            const track = makeTrack(trackId, trackMeta.title || trimmed, socket.id);
            trackQueue.set(trackId, track);
            broadcastToDJ(io, "dj:track-added", serializeTrack(track));
            processSoundCloudPipeline(io, socket, trackId, trackMeta, true, fmt);
          }
          broadcastToDJ(io, "queue:sync", serializeQueue());
        }
        return;
      }

      //  Bandcamp URL, direct lossless download via yt-dlp
      if (isBandcampUrl(trimmed)) {
        const trackId = uuidv4();
        const track = makeTrack(trackId, trimmed, socket.id);
        trackQueue.set(trackId, track);
        socket.emit("request:received", { trackId });
        broadcastToDJ(io, "dj:track-added", serializeTrack(track));
        broadcastToDJ(io, "queue:sync", serializeQueue());
        // Use the URL directly; default to flac for Bandcamp unless mp3 was picked.
        processSoundCloudPipeline(
          io, socket, trackId,
          { title: trimmed, artist: "", url: trimmed, duration: "" },
          false,
          fmt
        );
        return;
      }

      //  Single song search, interactive Extended/Original prompt
      // Works for every format: we search for an extended mix, ask the user,
      // then download the chosen version in the requested format (mp3/flac/wav).
      const trackId = uuidv4();
      const track = makeTrack(trackId, trimmed, socket.id);
      trackQueue.set(trackId, track);
      socket.emit("request:received", { trackId });
      broadcastToDJ(io, "dj:track-added", serializeTrack(track));
      broadcastToDJ(io, "queue:sync", serializeQueue());
      processSongWithChoicePipeline(io, socket, trackId, trimmed, fmt);
    }));

    //  Commit a staged track (per-track Download button)
    socket.on("dj:download", safeHandler("download", async ({ trackId }, ack) => {
      if (!isTrackId(trackId)) {
        if (typeof ack === "function") ack({ ok: false, error: "Unknown track." });
        return;
      }
      try {
        const fileName = await commitDownload(io, socket, trackId);
        if (typeof ack === "function") ack({ ok: true, trackId, fileName });
      } catch (err) {
        pipelineError(io, socket, trackId, err.message);
        if (typeof ack === "function") ack({ ok: false, trackId, error: err.message });
      }
    }));

    //  Commit every staged track (Download All)
    // Sequential on purpose: parallel yt-dlp processes compete for bandwidth
    // and make the per-track progress bars meaningless.
    socket.on("dj:download-all", safeHandler("download-all", async (_payload, ack) => {
      const pending = Array.from(trackQueue.values())
        .filter((t) => t.status === STATUS.STAGED)
        .map((t) => t.trackId);

      const results = [];
      for (const id of pending) {
        try {
          const fileName = await commitDownload(io, socket, id);
          results.push({ trackId: id, ok: true, fileName });
        } catch (err) {
          pipelineError(io, socket, id, err.message);
          results.push({ trackId: id, ok: false, error: err.message });
        }
      }
      if (typeof ack === "function") ack({ ok: true, results });
    }));

    socket.on("dj:mark-played", safeHandler("mark-played", ({ trackId }) => {
      if (!isTrackId(trackId) || !trackQueue.has(trackId)) return;
      const fn = trackQueue.get(trackId)?.meta?.fileName;
      if (fn) {
        library.markPlayed(fn);
        broadcastToDJ(io, "stats:update", stats.build());
      }
      updateTrack(trackId, { status: STATUS.PLAYED });
      broadcastToDJ(io, "queue:sync", serializeQueue());
    }));

    socket.on("dj:clear-queue", safeHandler("clear-queue", () => {
      trackQueue.clear();
      broadcastToDJ(io, "queue:sync", []);
    }));

    socket.on("dj:remove-track", safeHandler("remove-track", ({ trackId }) => {
      if (!isTrackId(trackId)) return;
      trackQueue.delete(trackId);
      broadcastToDJ(io, "queue:sync", serializeQueue());
    }));

    // Stats panel can ask for a refresh at any time.
    socket.on("stats:request", safeHandler("stats", (_p, ack) => {
      const payload = stats.build();
      socket.emit("stats:update", payload);
      if (typeof ack === "function") ack({ ok: true, stats: payload });
    }));

    // Re-run BPM and key for everything still missing it. Useful after
    // importing a library that predates analysis.
    socket.on("stats:analyse-pending", safeHandler("analyse-pending", (_p, ack) => {
      const pending = library.pendingAnalysis();
      for (const t of pending) {
        queueAnalysis(io, t.fileName, path.join(DOWNLOADS_DIR, ...t.fileName.split("/")));
      }
      if (typeof ack === "function") ack({ ok: true, queued: pending.length });
    }));

    // Write a rekordbox collection with BPM and key already filled in, so
    // tracks import pre-analysed instead of needing a rekordbox pass.
    socket.on("rekordbox:export", safeHandler("rb-export", ({ outPath }, ack) => {
      if (typeof ack !== "function") return;
      if (typeof outPath !== "string" || !outPath.trim()) {
        return ack({ ok: false, error: "No destination given." });
      }
      try {
        const res = rekordbox.writeCollection(outPath, library.allTracks(), DOWNLOADS_DIR);
        ack({ ok: true, ...res });
      } catch (err) {
        ack({ ok: false, error: err.message });
      }
    }));

    // Read a rekordbox export for the things this app cannot know: real play
    // counts and cue points.
    socket.on("rekordbox:import", safeHandler("rb-import", ({ xmlPath }, ack) => {
      if (typeof ack !== "function") return;
      if (typeof xmlPath !== "string" || !xmlPath.trim()) {
        return ack({ ok: false, error: "No file given." });
      }
      try {
        const rows = rekordbox.parseCollection(xmlPath);
        const matched = library.mergeExternalPlays(rows);
        broadcastToDJ(io, "stats:update", stats.build());
        ack({ ok: true, parsed: rows.length, matched });
      } catch (err) {
        ack({ ok: false, error: err.message });
      }
    }));

    socket.on("settings:get", safeHandler("settings-get", (_p, ack) => {
      const cur = settings.load();
      socket.emit("settings:update", cur);
      if (typeof ack === "function") {
        ack({ ok: true, settings: cur, formatModes: settings.FORMAT_MODES });
      }
    }));

    socket.on("settings:save", safeHandler("settings-save", (patch, ack) => {
      const next = settings.save(patch || {});
      // Everyone sees the change, not just the window that made it.
      broadcastToDJ(io, "settings:update", next);
      if (typeof ack === "function") ack({ ok: true, settings: next });
    }));

    socket.on("disconnect", () => {
      console.log(`[Socket] Client disconnected: ${socket.id}`);
    });
  });
}

//  Single song: search → ask user Extended or Original → download

async function processSongWithChoicePipeline(io, socket, trackId, songName, format = "mp3") {
  try {
    updateTrack(trackId, { status: STATUS.SEARCHING, progress: 0 });
    emitToRequester(socket, trackId, STATUS.SEARCHING);
    broadcastToDJ(io, "dj:track-updated", serializeTrack(trackQueue.get(trackId)));

    // Search YouTube + SoundCloud for Extended Mix
    let extendedResult = null;
    try { extendedResult = await searchExtendedMix(songName); } catch {}

    const hasExtended = extendedResult !== null;

    // Pause pipeline and ask the client what to do
    const version = await waitForVersionChoice(socket, trackId, hasExtended, extendedResult?.title ?? null);

    if (version === "skip") {
      trackQueue.delete(trackId);
      broadcastToDJ(io, "queue:sync", serializeQueue());
      return;
    }

    let searchResult;
    if (version === "extended" && hasExtended) {
      searchResult = extendedResult;
    } else {
      // Find the plain original across YouTube + SoundCloud
      searchResult = await searchOriginal(songName);
    }

    await finishDownloadPipeline(io, socket, trackId, searchResult, false, format);
  } catch (err) {
    pipelineError(io, socket, trackId, err.message);
  }
}

//  Playlist auto pipeline: Extended if found, Original otherwise

async function processAutoPipeline(io, socket, trackId, songName, isBulk) {
  try {
    updateTrack(trackId, { status: STATUS.SEARCHING, progress: 0 });
    if (!isBulk) emitToRequester(socket, trackId, STATUS.SEARCHING);
    broadcastToDJ(io, "dj:track-updated", serializeTrack(trackQueue.get(trackId)));

    let searchResult;
    try {
      searchResult = await searchExtendedMix(songName);
    } catch {
      searchResult = await searchOriginal(songName);
    }

    await finishDownloadPipeline(io, socket, trackId, searchResult, isBulk);
  } catch (err) {
    pipelineError(io, socket, trackId, err.message);
    if (!isBulk) socket.emit("request:error", { trackId, message: err.message });
  }
}

//  Playlist quality-priority pipeline: FLAC → WAV → MP3
// For each playlist track we try to land the highest-quality format available:
//   1. A GENUINE lossless source (Internet Archive / FMA) → download as FLAC
//   2. Same source → download as WAV
//   3. No genuine lossless source → fall back to MP3 from YouTube/SoundCloud
async function processPlaylistPriorityPipeline(io, socket, trackId, songName, isBulk) {
  try {
    updateTrack(trackId, { status: STATUS.SEARCHING, progress: 0 });
    if (!isBulk) emitToRequester(socket, trackId, STATUS.SEARCHING);
    broadcastToDJ(io, "dj:track-updated", serializeTrack(trackQueue.get(trackId)));

    // 1 & 2: try a GENUINE lossless source only (no YouTube, that's the MP3 tier).
    let losslessResult = null;
    try {
      losslessResult = await searchLossless(songName, false);
    } catch {
      losslessResult = null;
    }

    if (losslessResult) {
      for (const fmt of ["flac", "wav"]) {
        try {
          await finishDownloadPipeline(io, socket, trackId, losslessResult, isBulk, fmt);
          return; // success at this quality tier
        } catch {
          // try the next format down
        }
      }
    }

    // 3: fall back to MP3 from the normal extended-mix / original search.
    let mp3Result;
    try {
      mp3Result = await searchExtendedMix(songName);
    } catch {
      mp3Result = await searchOriginal(songName);
    }
    await finishDownloadPipeline(io, socket, trackId, mp3Result, isBulk, "mp3");
  } catch (err) {
    pipelineError(io, socket, trackId, err.message);
    if (!isBulk) socket.emit("request:error", { trackId, message: err.message });
  }
}

//  SoundCloud direct download

async function processSoundCloudPipeline(io, socket, trackId, preMeta, isBulk, format = "mp3") {
  try {
    const meta = {
      title: preMeta.title,
      artist: preMeta.artist,
      url: preMeta.url,
      duration: preMeta.duration || "",
      bpm: null,
      key: null,
    };

    updateTrack(trackId, { status: STATUS.SEARCHING, progress: 0 });
    if (!isBulk) emitToRequester(socket, trackId, STATUS.SEARCHING);
    broadcastToDJ(io, "dj:track-updated", serializeTrack(trackQueue.get(trackId)));

    await finishDownloadPipeline(io, socket, trackId, meta, isBulk, format);
  } catch (err) {
    pipelineError(io, socket, trackId, err.message);
    if (!isBulk) socket.emit("request:error", { trackId, message: err.message });
  }
}

//  Lossless pipeline: search Bandcamp / Internet Archive / FMA → WAV/FLAC

async function processLosslessPipeline(io, socket, trackId, songName, isBulk, format) {
  try {
    updateTrack(trackId, { status: STATUS.SEARCHING, progress: 0 });
    if (!isBulk) emitToRequester(socket, trackId, STATUS.SEARCHING);
    broadcastToDJ(io, "dj:track-updated", serializeTrack(trackQueue.get(trackId)));

    let searchResult;
    let actualFormat = format;

    try {
      searchResult = await searchLossless(songName);
    } catch (err) {
      // Most commercial music has no lossless source, so failing outright is
      // a dead end. If the user's format preference allows a lossy fallback,
      // take it and say so rather than making them search again by hand.
      const chain = settings.formatChain();
      const fallback = chain.find((f) => f !== format && f === "mp3");
      if (err.code !== "NO_LOSSLESS_SOURCE" || !fallback) throw err;

      searchResult = await searchMusicApi(songName, false);
      actualFormat = fallback;
      // Tell the requester why they got MP3 when they asked for lossless.
      if (!isBulk) {
        socket.emit("request:notice", {
          trackId,
          message:
            `No lossless source for "${songName}", so this one is MP3. ` +
            `Paste a Bandcamp link if the artist sells a lossless copy.`,
        });
      }
    }

    await finishDownloadPipeline(io, socket, trackId, searchResult, isBulk, actualFormat);
  } catch (err) {
    pipelineError(io, socket, trackId, err.message);
    if (!isBulk) socket.emit("request:error", { trackId, message: err.message });
  }
}

//  Shared: FOUND → DOWNLOADING → READY

async function finishDownloadPipeline(io, socket, trackId, searchResult, isBulk, format = "mp3") {
  // Tag the format onto meta from the start so the UI shows the right label
  // (FLAC/WAV/MP3) during the download, not just at the end.
  const metaWithFormat = { ...searchResult, format };
  updateTrack(trackId, { status: STATUS.FOUND, progress: 30, meta: metaWithFormat });
  if (!isBulk) emitToRequester(socket, trackId, STATUS.FOUND, { meta: metaWithFormat });
  broadcastToDJ(io, "dj:track-updated", serializeTrack(trackQueue.get(trackId)));

  // Stop here. Nothing is fetched until the user asks for it, so the queue is a
  // list of candidates rather than files already written to disk.
  updateTrack(trackId, { status: STATUS.STAGED, progress: 100, meta: metaWithFormat });
  if (!isBulk) emitToRequester(socket, trackId, STATUS.STAGED, { meta: metaWithFormat });
  broadcastToDJ(io, "dj:track-updated", serializeTrack(trackQueue.get(trackId)));
  broadcastToDJ(io, "queue:sync", serializeQueue());
}

//  Commit: actually fetch a staged track
// Runs only when the user presses Download (or Download All).

async function commitDownload(io, socket, trackId) {
  const track = trackQueue.get(trackId);
  if (!track) throw new Error("Track is no longer in the queue.");
  if (!track.meta || !track.meta.url) throw new Error("No source for this track.");
  // Already fetched, nothing to do.
  if (track.status === STATUS.READY && track.meta.fileName) return track.meta.fileName;

  const format = track.meta.format || "mp3";
  updateTrack(trackId, { status: STATUS.DOWNLOADING, progress: 0 });
  emitToRequester(socket, trackId, STATUS.DOWNLOADING);
  broadcastToDJ(io, "dj:track-updated", serializeTrack(trackQueue.get(trackId)));

  const { fileName } = await downloadTrack(
    track.meta.url,
    trackId,
    track.meta.title,
    (pct) => {
      updateTrack(trackId, { progress: pct });
      broadcastToDJ(io, "dj:progress", { trackId, progress: pct });
    },
    format
  );

  const updatedMeta = { ...trackQueue.get(trackId).meta, fileName, format };
  updateTrack(trackId, { status: STATUS.READY, progress: 100, meta: updatedMeta });

  // Record it in the persistent library so the stats survive a restart.
  let bytes = null;
  const absPath = path.join(DOWNLOADS_DIR, ...fileName.split("/"));
  try {
    bytes = fs.statSync(absPath).size;
  } catch {
    // File vanished between write and stat; leave size unknown.
  }
  library.recordDownload({
    fileName,
    title: track.meta?.title,
    artist: track.meta?.artist,
    format,
    source: track.meta?.source || "unknown",
    durationSec: track.meta?.durationSec ?? null,
    tags: track.meta?.tags || [],
    bytes,
  });

  // Analysis takes a couple of seconds, so never make the download wait on it.
  if (settings.load().analyseOnDownload !== false) {
    queueAnalysis(io, fileName, absPath);
  }
  emitToRequester(socket, trackId, STATUS.READY);
  broadcastToDJ(io, "dj:track-updated", serializeTrack(trackQueue.get(trackId)));
  broadcastToDJ(io, "queue:sync", serializeQueue());
  return fileName;
}

//  Wait for the user's Extended / Original choice

function waitForVersionChoice(socket, trackId, hasExtended, extendedTitle) {
  return new Promise((resolve) => {
    // With the prompt turned off, decide from the stored preference rather
    // than interrupting every single search.
    if (settings.load().askExtended === false) {
      const preferExt = settings.load().preferExtended !== false;
      return resolve(hasExtended && preferExt ? "extended" : "original");
    }

    const timeout = setTimeout(() => {
      if (pendingChoices.has(trackId)) {
        pendingChoices.delete(trackId);
        resolve(hasExtended ? "extended" : "original");
      }
    }, 120_000);

    pendingChoices.set(trackId, { resolve, timeout });
    socket.emit("request:extended-result", { trackId, hasExtended, extendedTitle });
  });
}

//  Helpers

function pipelineError(io, socket, trackId, message) {
  console.error(`[Pipeline] Error for ${trackId}:`, message);
  updateTrack(trackId, { status: STATUS.ERROR, error: message, progress: 0 });
  socket.emit("request:error", { trackId, message });
  broadcastToDJ(io, "dj:track-updated", serializeTrack(trackQueue.get(trackId)));
}

function makeTrack(trackId, songName, requestedBy) {
  return {
    trackId,
    songName,
    requestedBy,
    status: STATUS.PENDING,
    progress: 0,
    requestedAt: new Date().toISOString(),
    meta: null,
    error: null,
  };
}

function updateTrack(trackId, updates) {
  const track = trackQueue.get(trackId);
  if (!track) return;
  trackQueue.set(trackId, { ...track, ...updates });
}

function emitToRequester(socket, trackId, status, extra = {}) {
  socket.emit("request:update", { trackId, status, ...extra });
}

function broadcastToDJ(io, event, data) {
  io.to(DJ_ROOM).emit(event, data);
}

function serializeTrack(track) { return { ...track }; }

function serializeQueue() {
  return Array.from(trackQueue.values())
    .sort((a, b) => new Date(a.requestedAt) - new Date(b.requestedAt))
    .map(serializeTrack);
}

module.exports = { initSocketManager, STATUS };
