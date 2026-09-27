// Electron main process: owns the window, runs the Express server as a child,
// and makes sure nothing is left running after the window closes.

const { app, BrowserWindow, Menu, shell, dialog, ipcMain } = require("electron");
const { fork, spawnSync } = require("child_process");
const path = require("path");
const fs = require("fs");

const isPackaged = app.isPackaged;
const DEBUG = process.argv.includes("--debug");

// In a packaged app, server/ and client/out are unpacked next to the asar.
// In dev, they are siblings of electron/.
const ROOT = isPackaged
  ? path.join(process.resourcesPath, "app.asar.unpacked")
  : path.join(__dirname, "..");

const SERVER_ENTRY = path.join(ROOT, "server", "index.js");
const SERVER_DIR = path.join(ROOT, "server");
const CLIENT_DIR = path.join(ROOT, "client", "out");
const BIN_DIR = path.join(process.resourcesPath || ROOT, "bin");

let serverProc = null;
let mainWindow = null;
let serverPort = null;
let downloadsDir = null;
let quitting = false;

// The server's .env has to live somewhere the user can edit and that survives an
// update. resources/ is under Program Files (needs elevation, wiped on update),
// so userData is the right home.
function envPath() {
  return path.join(app.getPath("userData"), ".env");
}

// Seed a default config on first run so DOWNLOADS_DIR is sane for whoever
// installed this, not hardcoded to the developer's home folder.
function ensureEnvFile() {
  const target = envPath();
  if (fs.existsSync(target)) return target;

  // Prefer an existing library from before the rename, so upgrading does not
  // silently point at a new empty folder.
  const legacyDir = path.join(app.getPath("music"), "DJ Core");
  const musicDir = fs.existsSync(legacyDir)
    ? legacyDir
    : path.join(app.getPath("music"), "Cratedigger");
  const body = [
    "# Cratedigger configuration",
    "",
    "# Where finished tracks are saved. Files land in <DOWNLOADS_DIR>/DD-MM-YYYY/",
    `DOWNLOADS_DIR=${musicDir.replace(/\\/g, "/")}`,
    "",
    "# Optional: point at a specific yt-dlp / ffmpeg instead of the bundled ones.",
    "# YTDLP_PATH=",
    "# FFMPEG_PATH=",
    "",
    "# Spotify Web API, required for playlist/album/track links.",
    "# Create an app at https://developer.spotify.com/dashboard",
    "SPOTIFY_CLIENT_ID=",
    "SPOTIFY_CLIENT_SECRET=",
    "",
  ].join("\n");

  try {
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, body, "utf8");
  } catch (err) {
    console.error("[main] could not write .env:", err.message);
  }
  return target;
}

function startServer() {
  return new Promise((resolve, reject) => {
    if (!fs.existsSync(SERVER_ENTRY)) {
      return reject(new Error(`Server not found at ${SERVER_ENTRY}`));
    }

    // fork() reuses process.execPath, this app's own exe, so no system Node is
    // required. ELECTRON_RUN_AS_NODE makes that exe behave as plain Node.
    // cwd matters: dotenv resolves relative paths from it, and a GUI launch
    // starts in system32.
    serverProc = fork(SERVER_ENTRY, [], {
      cwd: SERVER_DIR,
      env: {
        ...process.env,
        ELECTRON_RUN_AS_NODE: "1",
        DJ_DESKTOP: "1",
        DJ_ENV_PATH: ensureEnvFile(),
        DJ_CLIENT_DIR: CLIENT_DIR,
        DJ_BIN_DIR: BIN_DIR,
      },
      stdio: ["ignore", "pipe", "pipe", "ipc"],
    });

    serverProc.stdout?.on("data", (d) => process.stdout.write(`[server] ${d}`));
    serverProc.stderr?.on("data", (d) => process.stderr.write(`[server] ${d}`));

    // Wait for the port the OS actually assigned, rather than polling a guess.
    const timer = setTimeout(
      () => reject(new Error("Server did not start within 20s")),
      20000
    );

    serverProc.on("message", (msg) => {
      if (msg && msg.type === "listening") {
        clearTimeout(timer);
        serverPort = msg.port;
        downloadsDir = msg.downloadsDir || null;
        resolve(msg.port);
      }
    });

    serverProc.on("exit", (code) => {
      clearTimeout(timer);
      serverProc = null;
      if (!quitting) {
        reject(new Error(`Server exited (code ${code})`));
      }
    });

    serverProc.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}

// Windows does not cascade kills, so a running yt-dlp.exe would keep downloading
// after the window closed. Kill the whole process tree.
// Kill the server child and any yt-dlp/ffmpeg grandchildren it spawned.
// Synchronous on Windows: an async kill would race app.quit(), and a live IPC
// channel keeps Electron's event loop alive so the app never actually exits.
function stopServer() {
  const proc = serverProc;
  if (!proc) return;
  serverProc = null;
  const pid = proc.pid;

  // Drop the IPC channel first, while it is open the parent will not exit.
  try {
    proc.disconnect();
  } catch {
    // Already disconnected.
  }

  if (process.platform === "win32" && pid) {
    // /T kills the whole tree, so a running download cannot outlive the app.
    // spawnSync so this completes before we quit.
    try {
      spawnSync("taskkill", ["/pid", String(pid), "/T", "/F"], {
        stdio: "ignore",
        windowsHide: true,
      });
    } catch {
      // Process already gone.
    }
  } else {
    try {
      proc.kill("SIGKILL");
    } catch {
      // Already gone.
    }
  }
}

function buildMenu() {
  const template = [
    {
      label: "File",
      submenu: [
        {
          label: "Open Downloads Folder",
          click: () => {
            // Read the live value so it follows a user edit of .env.
            const envFile = envPath();
            const legacy = path.join(app.getPath("music"), "DJ Core");
            let dir = fs.existsSync(legacy)
              ? legacy
              : path.join(app.getPath("music"), "Cratedigger");
            try {
              const m = fs
                .readFileSync(envFile, "utf8")
                .match(/^DOWNLOADS_DIR\s*=\s*(.+)$/m);
              if (m) dir = m[1].trim();
            } catch {
              // Fall back to the default.
            }
            shell.openPath(path.normalize(dir));
          },
        },
        {
          label: "Edit Configuration",
          click: () => shell.openPath(envPath()),
        },
        { type: "separator" },
        { role: "quit" },
      ],
    },
    {
      label: "View",
      submenu: [
        { role: "reload" },
        { role: "toggleDevTools" },
        { type: "separator" },
        { role: "resetZoom" },
        { role: "zoomIn" },
        { role: "zoomOut" },
        { type: "separator" },
        { role: "togglefullscreen" },
      ],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

function createWindow(port) {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 860,
    minWidth: 820,
    minHeight: 600,
    backgroundColor: "#faf9f7",
    title: "Cratedigger",
    show: false,
    webPreferences: {
      // The page is our own static build and needs no Node access.
      nodeIntegration: false,
      contextIsolation: true,
      // Renderer runs in the OS sandbox. The preload only needs ipcRenderer,
      // which stays available under sandbox.
      sandbox: true,
      webviewTag: false,
      preload: path.join(__dirname, "preload.js"),
    },
  });

  mainWindow.once("ready-to-show", () => mainWindow.show());

  // A blank window is the classic failure here, so surface the reasons.
  mainWindow.webContents.on("did-fail-load", (_e, code, desc, url) => {
    console.error(`[main] did-fail-load ${code} ${desc} ${url}`);
  });
  mainWindow.webContents.on("render-process-gone", (_e, details) => {
    console.error("[main] render-process-gone:", details.reason);
  });
  if (DEBUG) {
    mainWindow.webContents.on("console-message", (_e, level, message) => {
      console.log(`[renderer:${level}] ${message}`);
    });
    mainWindow.webContents.openDevTools({ mode: "detach" });
  }

  // Open external links in the real browser, not inside the app window.
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    // Only real web links go to the browser. Anything else (file:, and any
    // custom protocol registered on the machine) is refused outright.
    try {
      const u = new URL(url);
      if (u.protocol === "http:" || u.protocol === "https:") {
        shell.openExternal(url);
      }
    } catch {
      // Unparseable URL, ignore it.
    }
    return { action: "deny" };
  });

  // The window only ever shows our own local page. Block navigation anywhere
  // else, so a redirect cannot turn the app frame into a browser.
  const allowedOrigin = `http://127.0.0.1:${port}`;
  mainWindow.webContents.on("will-navigate", (e, url) => {
    if (!url.startsWith(allowedOrigin)) {
      e.preventDefault();
      console.warn("[main] blocked navigation to", url);
    }
  });
  mainWindow.webContents.on("will-attach-webview", (e) => e.preventDefault());

  mainWindow.loadURL(`http://127.0.0.1:${port}/dashboard/`);
  mainWindow.on("closed", () => {
    mainWindow = null;
  });
}


//  Save handlers
// The server writes each fetched track into its own downloads dir; these copy
// it wherever the user chooses, which is what the Download buttons do.

function sourcePathFor(fileName) {
  if (!downloadsDir || !fileName) return null;
  // fileName is "DD-MM-YYYY/Track.mp3", relative to the downloads dir.
  const abs = path.join(downloadsDir, ...fileName.split("/"));
  // Never read outside the downloads dir, whatever the server sent.
  const rel = path.relative(downloadsDir, abs);
  if (rel.startsWith("..") || path.isAbsolute(rel)) return null;
  return fs.existsSync(abs) ? abs : null;
}

function registerSaveHandlers() {
  // One track, with a native Save As dialog.
  ipcMain.handle("cratedigger:save-track", async (_e, { fileName, suggestedName }) => {
    const src = sourcePathFor(fileName);
    if (!src) return { saved: false, error: "File not found on disk." };

    const base = suggestedName || path.basename(src);
    const { canceled, filePath } = await dialog.showSaveDialog(mainWindow, {
      title: "Save track",
      defaultPath: path.join(app.getPath("downloads"), base),
      filters: [{ name: "Audio", extensions: [path.extname(base).slice(1) || "mp3"] }],
    });
    if (canceled || !filePath) return { saved: false, canceled: true };

    try {
      await fs.promises.copyFile(src, filePath);
      return { saved: true, path: filePath };
    } catch (err) {
      return { saved: false, error: err.message };
    }
  });

  // Ask once for a destination folder (used by Download All).
  ipcMain.handle("cratedigger:choose-folder", async () => {
    const { canceled, filePaths } = await dialog.showOpenDialog(mainWindow, {
      title: "Choose where to save tracks",
      defaultPath: app.getPath("downloads"),
      properties: ["openDirectory", "createDirectory"],
    });
    if (canceled || !filePaths?.length) return { canceled: true };
    return { canceled: false, dir: filePaths[0] };
  });

  // Write one track into an already-chosen folder, no dialog.
  ipcMain.handle("cratedigger:save-track-to", async (_e, { fileName, dir, suggestedName }) => {
    const src = sourcePathFor(fileName);
    if (!src) return { saved: false, error: "File not found on disk." };
    if (!dir) return { saved: false, error: "No destination folder." };

    let target = path.join(dir, suggestedName || path.basename(src));
    // Don't clobber an existing file. Add " (2)", " (3)", and so on.
    if (fs.existsSync(target)) {
      const ext = path.extname(target);
      const stem = target.slice(0, -ext.length || undefined);
      let n = 2;
      while (fs.existsSync(`${stem} (${n})${ext}`)) n++;
      target = `${stem} (${n})${ext}`;
    }

    try {
      await fs.promises.copyFile(src, target);
      return { saved: true, path: target };
    } catch (err) {
      return { saved: false, error: err.message };
    }
  });

  ipcMain.handle("cratedigger:reveal", async (_e, absPath) => {
    if (absPath && fs.existsSync(absPath)) shell.showItemInFolder(absPath);
    return { ok: true };
  });
}

// Only one instance, so two launches can't fight over the server.
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on("second-instance", () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });

  registerSaveHandlers();

  app.whenReady().then(async () => {
    buildMenu();

    if (!fs.existsSync(CLIENT_DIR)) {
      dialog.showErrorBox(
        "Cratedigger, build missing",
        `The app UI was not found at:\n${CLIENT_DIR}\n\n` +
          `Run the client build first:\n  cd client\n  BUILD_TARGET=desktop npx next build`
      );
      app.quit();
      return;
    }

    try {
      const port = await startServer();
      createWindow(port);
    } catch (err) {
      dialog.showErrorBox("Cratedigger, could not start", String(err.message || err));
      app.quit();
    }
  });

  app.on("window-all-closed", () => {
    quitting = true;
    stopServer();
    app.quit();
  });

  app.on("before-quit", () => {
    quitting = true;
    stopServer();
  });
}
