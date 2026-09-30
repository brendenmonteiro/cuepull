// Captures the README screenshots.
//
// Run with:  npx electron scripts/screenshots.js
//
// Uses the app's own window and Electron's capturePage, never a full screen
// grab. A screen grab once caught a browser window with personal information
// in it, and these images go into a public repo.
//
// The library folder is pointed at a copy under a neutral path so no real home
// directory appears in the settings panel.

const { app, BrowserWindow } = require("electron");
const { fork } = require("child_process");
const path = require("path");
const fs = require("fs");
const os = require("os");

const ROOT = path.join(__dirname, "..");
const OUT = path.join(ROOT, "docs", "images");

// A throwaway profile, so the captures do not depend on local settings and
// nothing real is shown.
const PROFILE = fs.mkdtempSync(path.join(os.tmpdir(), "cuepull-shots-"));

// The settings panel shows the library folder, and the real one contains a
// user name. SHOTS_LIBRARY points at a neutral path that holds the tracks, so
// the decks play real audio and the screenshot shows no home directory.
// Make one with a junction:
//   mklink /J C:\Music\Cuepull "C:\Users\<you>\Music\DJ Core"
const LIBRARY = process.env.SHOTS_LIBRARY || "C:/Music/Cuepull";

function seedProfile() {
  const realData = process.env.APPDATA
    ? path.join(process.env.APPDATA, "Cuepull")
    : null;

  fs.writeFileSync(
    path.join(PROFILE, "settings.json"),
    JSON.stringify(
      {
        formatMode: "flac-then-mp3",
        downloadsDir: LIBRARY,
        dateFolders: true,
        askExtended: true,
        preferExtended: true,
        analyseOnDownload: true,
        theme: "dark",
        spotifyClientId: "",
        spotifyClientSecret: "",
      },
      null,
      2
    )
  );

  // Take the analysed library but keep only the tracks that actually exist
  // under LIBRARY, so the setlist and decks have real audio to work with.
  if (realData) {
    const src = path.join(realData, "library.json");
    if (fs.existsSync(src)) {
      const db = JSON.parse(fs.readFileSync(src, "utf8"));
      const kept = {};
      for (const [name, t] of Object.entries(db.tracks || {})) {
        const full = path.join(LIBRARY, ...name.split("/"));
        if (fs.existsSync(full)) kept[name] = t;
      }
      fs.writeFileSync(
        path.join(PROFILE, "library.json"),
        JSON.stringify({ ...db, tracks: kept }, null, 2)
      );
      console.log(`  library: ${Object.keys(kept).length} tracks present`);
    }
  }
}

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

function startServer() {
  return new Promise((resolve, reject) => {
    const child = fork(path.join(ROOT, "server", "index.js"), [], {
      cwd: path.join(ROOT, "server"),
      env: {
        ...process.env,
        DJ_DESKTOP: "1",
        ELECTRON_RUN_AS_NODE: "1",
        DJ_DATA_DIR: PROFILE,
        DJ_CLIENT_DIR: path.join(ROOT, "client", "out"),
        DOWNLOADS_DIR: LIBRARY,
      },
      stdio: ["ignore", "pipe", "pipe", "ipc"],
    });
    const timer = setTimeout(() => reject(new Error("server did not start")), 20000);
    child.on("message", (m) => {
      if (m && m.port) {
        clearTimeout(timer);
        resolve({ child, port: m.port });
      }
    });
    child.stderr.on("data", (d) => process.stderr.write(d));
    child.on("error", reject);
  });
}

async function shoot(win, name) {
  const img = await win.capturePage();
  const file = path.join(OUT, name);
  fs.writeFileSync(file, img.toPNG());
  const kb = (fs.statSync(file).size / 1024).toFixed(0);
  console.log(`  ${name}  ${kb} KB`);
}

app.disableHardwareAcceleration();

app.whenReady().then(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  seedProfile();
  const { child, port } = await startServer();

  const win = new BrowserWindow({
    width: 1500,
    height: 1000,
    show: false,
    backgroundColor: "#000000",
    webPreferences: { backgroundThrottling: false },
  });

  await win.loadURL(`http://127.0.0.1:${port}/dashboard/`);
  await wait(4000);

  const run = (js) => win.webContents.executeJavaScript(js);

  console.log("Capturing:");

  // 1. Main window, with a queue that has something in it.
  await shoot(win, "01-main.png");

  // 2. Crate intel. Scroll it into view first.
  await run(`
    (() => {
      const h = [...document.querySelectorAll("p")]
        .find(p => p.textContent.includes("CRATE INTEL"));
      h?.scrollIntoView({ block: "start" });
    })()
  `);
  await wait(900);
  await shoot(win, "02-crate-intel.png");

  // 3. Setlist, built and showing the joins.
  await run(`
    (async () => {
      const b = [...document.querySelectorAll("button")]
        .find(x => x.textContent.trim().includes("BUILD SETLIST"));
      b?.click();
      await new Promise(r => setTimeout(r, 3000));
      const h = [...document.querySelectorAll("p")]
        .find(p => p.textContent.includes("SETLIST"));
      h?.scrollIntoView({ block: "start" });
    })()
  `);
  await wait(2500);
  await shoot(win, "05-setlist.png");

  // 4. Decks, with a track loaded on each side.
  await run(`
    (async () => {
      const plays = [...document.querySelectorAll('ol > li button[aria-label^="Load"]')];
      plays[6]?.click();
      await new Promise(r => setTimeout(r, 7000));
      plays[8]?.click();
      await new Promise(r => setTimeout(r, 8000));
      const h = [...document.querySelectorAll("p")]
        .find(p => p.textContent.includes("DECKS"));
      h?.scrollIntoView({ block: "start" });
      // Back off a little: scrollIntoView puts the heading at the very top
      // and clips the waveforms above the fold.
      await new Promise(r => setTimeout(r, 300));
      window.scrollBy(0, -40);
    })()
  `);
  await wait(17000);
  await shoot(win, "06-decks.png");

  // 5. Settings drawer. Scroll back to the top first, and give the slide in
  // time to finish: catching it mid animation blurs the whole page behind it.
  await run(`window.scrollTo(0, 0)`);
  await wait(600);
  await run(`
    (() => {
      const b = document.querySelector('button[aria-label*="ettings"], button[aria-label*="enu"]');
      b?.click();
    })()
  `);
  await wait(2500);
  await shoot(win, "03-settings.png");

  await run(`document.querySelector("aside")?.scrollTo(0, 99999)`);
  await wait(900);
  await shoot(win, "04-settings-more.png");

  child.disconnect?.();
  child.kill();
  fs.rmSync(PROFILE, { recursive: true, force: true });
  app.exit(0);
});
