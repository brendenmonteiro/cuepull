// DJ_ENV_PATH lets the packaged desktop app keep its .env in a writable
// user-data folder, because a packaged app's cwd is wherever Explorer launched
// it (often system32) and resources/ is not user-editable.
require("dotenv").config(
  process.env.DJ_ENV_PATH ? { path: process.env.DJ_ENV_PATH } : undefined
);
const express = require("express");
const http = require("http");
const path = require("path");
const fs = require("fs");
const { Server } = require("socket.io");
const cors = require("cors");
const { initSocketManager } = require("./socketManager");
const { DOWNLOADS_DIR } = require("./musicHandler");
const { getBinaries } = require("./binaries");

// Desktop mode: Electron sets DJ_DESKTOP=1. The server then also serves the
// statically-exported client, so page and API share one origin, which removes
// the need for CORS entirely and lets us use an OS-assigned port.
const DESKTOP = process.env.DJ_DESKTOP === "1";

// Port 0 asks the OS for any free port, so a packaged app never collides with a
// dev server or Docker on 3001. Dev keeps the fixed default.
const PORT = process.env.PORT ? Number(process.env.PORT) : DESKTOP ? 0 : 3001;
// Desktop binds loopback only; nothing on the LAN can reach the download engine.
const HOST = process.env.HOST || (DESKTOP ? "127.0.0.1" : "0.0.0.0");
const CLIENT_ORIGIN = process.env.CLIENT_ORIGIN || "http://localhost:3000";

// Where the exported client lives (DJ_CLIENT_DIR is set by Electron).
const CLIENT_DIR = process.env.DJ_CLIENT_DIR || path.join(__dirname, "..", "client", "out");

const app = express();
// In desktop mode the page is served from this same origin, so cross-origin
// requests are neither needed nor wanted.
if (!DESKTOP) {
  app.use(cors({ origin: CLIENT_ORIGIN }));
}
app.use(express.json());

//  Health check
app.get("/health", (req, res) => {
  res.json({ status: "ok", timestamp: new Date().toISOString() });
});

// Lets the UI warn about a missing yt-dlp/ffmpeg instead of failing per-track.
app.get("/api/binaries", (req, res) => {
  const { ytDlp, ffmpeg, missing } = getBinaries();
  res.json({ ytDlp, ffmpeg, missing, ok: missing.length === 0 });
});

//  Static downloads
// Serves the dated subfolders too, so a fileName like "27-09-2026/track.mp3"
// resolves straight through.
app.use("/downloads", express.static(DOWNLOADS_DIR));

//  Static client (desktop)
// Serving the exported client over http keeps Next's absolute /_next/... asset
// paths working, which they would not under a file:// origin.
if (DESKTOP && fs.existsSync(CLIENT_DIR)) {
  app.use(express.static(CLIENT_DIR));
  // Anything unmatched falls back to the dashboard (the only real route).
  app.get("*", (req, res, next) => {
    if (req.path.startsWith("/downloads") || req.path.startsWith("/socket.io")) {
      return next();
    }
    res.sendFile(path.join(CLIENT_DIR, "dashboard", "index.html"));
  });
}

//  HTTP server
const httpServer = http.createServer(app);

const io = new Server(httpServer, {
  // Same-origin in desktop mode, so no allowlist is required.
  ...(DESKTOP ? {} : { cors: { origin: CLIENT_ORIGIN, methods: ["GET", "POST"] } }),
  pingTimeout: 60000,
  pingInterval: 25000,
});

initSocketManager(io);

httpServer.listen(PORT, HOST, () => {
  const actualPort = httpServer.address().port;
  const base = `http://${HOST === "0.0.0.0" ? "localhost" : HOST}:${actualPort}`;
  console.log(`\n🎧 DJ Request Server  ${base}`);
  console.log(`   Health:            ${base}/health`);
  console.log(`   Downloads:         ${base}/downloads/`);
  console.log(`   Saving to:         ${DOWNLOADS_DIR}`);
  if (DESKTOP) {
    console.log(`   Serving client:    ${CLIENT_DIR}`);
  } else {
    console.log(`   CORS allowed for:  ${CLIENT_ORIGIN}`);
  }
  const { missing } = getBinaries();
  if (missing.length) {
    console.warn(`   ⚠ MISSING BINARIES: ${missing.join(", ")}`);
  }
  console.log("");

  // Tell the Electron parent which port to load. Waiting on this message is
  // more reliable than polling a guessed port.
  if (process.send) {
    process.send({ type: "listening", port: actualPort, downloadsDir: DOWNLOADS_DIR });
  }
});

function shutdown() {
  httpServer.close(() => process.exit(0));
  // Don't hang forever if a socket refuses to close.
  setTimeout(() => process.exit(0), 3000).unref();
}

// Windows has no real SIGTERM, so the parent asks over the IPC channel instead.
process.on("message", (msg) => {
  if (msg && msg.type === "shutdown") shutdown();
});
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
