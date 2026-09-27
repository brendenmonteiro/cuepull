const { v4: uuidv4 } = require("uuid");
const {
  searchExtendedMix,
  searchOriginal,
  searchLossless,
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

function initSocketManager(io) {
  io.on("connection", (socket) => {
    console.log(`[Socket] Client connected: ${socket.id}`);
    socket.emit("queue:sync", serializeQueue());

    socket.on("dj:join", () => {
      socket.join(DJ_ROOM);
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
      const fmt = ["flac", "wav"].includes(format) ? format : "mp3";
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

    const searchResult = await searchLossless(songName);
    await finishDownloadPipeline(io, socket, trackId, searchResult, isBulk, format);
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
  emitToRequester(socket, trackId, STATUS.READY);
  broadcastToDJ(io, "dj:track-updated", serializeTrack(trackQueue.get(trackId)));
  broadcastToDJ(io, "queue:sync", serializeQueue());
  return fileName;
}

//  Wait for the user's Extended / Original choice

function waitForVersionChoice(socket, trackId, hasExtended, extendedTitle) {
  return new Promise((resolve) => {
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
