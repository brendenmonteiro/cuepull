require("dotenv").config();
const express = require("express");
const http = require("http");
const path = require("path");
const { Server } = require("socket.io");
const cors = require("cors");
const { initSocketManager } = require("./socketManager");

const PORT = process.env.PORT || 3001;
const CLIENT_ORIGIN = process.env.CLIENT_ORIGIN || "http://localhost:3000";

const app = express();
app.use(cors({ origin: CLIENT_ORIGIN }));
app.use(express.json());

// ── Health check ─────────────────────────────────────────────────────────────
app.get("/health", (req, res) => {
  res.json({ status: "ok", timestamp: new Date().toISOString() });
});

// ── Static downloads ─────────────────────────────────────────────────────────
app.use("/downloads", express.static(path.join(__dirname, "downloads")));

// ── HTTP server ───────────────────────────────────────────────────────────────
const httpServer = http.createServer(app);

const io = new Server(httpServer, {
  cors: { origin: CLIENT_ORIGIN, methods: ["GET", "POST"] },
  pingTimeout: 60000,
  pingInterval: 25000,
});

initSocketManager(io);

httpServer.listen(PORT, () => {
  console.log(`\n🎧 DJ Request Server  http://localhost:${PORT}`);
  console.log(`   Health:            http://localhost:${PORT}/health`);
  console.log(`   Downloads:         http://localhost:${PORT}/downloads/`);
  console.log(`   CORS allowed for:  ${CLIENT_ORIGIN}\n`);
});

process.on("SIGTERM", () => {
  httpServer.close(() => process.exit(0));
});
