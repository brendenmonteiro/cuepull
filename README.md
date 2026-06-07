# 🎧 DJ_CORE — Personal Track Downloader

A personal tool for searching and downloading tracks for DJ sets. Search by song
name or paste a Spotify / SoundCloud / Bandcamp link, pick a format (MP3 / FLAC /
WAV), and the app finds the best source and downloads it — with a live queue
showing progress in real time.

> **Personal use only.** This is a tool for managing your own library. It pulls
> from YouTube, SoundCloud, Bandcamp, the Internet Archive, and the Free Music
> Archive via `yt-dlp`. Don't use it to redistribute copyrighted music.

---

## What it does

- **Single track search** — type `Artist - Song`, it searches YouTube + SoundCloud.
  If an **Extended Mix** exists, it asks whether you want the Extended or the
  Original version before downloading.
- **Spotify playlists** — paste a public playlist/album/track link. It reads every
  track name and queues them all. By default it grabs the **best format available
  per track**: FLAC → WAV → MP3.
- **SoundCloud** — paste a track or playlist URL for a direct download.
- **Bandcamp** — paste a track/album URL for a true lossless download.
- **Format choice** — MP3 (320 kbps), FLAC, or WAV. Lossless formats search
  legitimate lossless sources (Internet Archive / Free Music Archive / Bandcamp).
- **Live queue** — every download shows status (searching → found → downloading →
  ready) and a progress bar, updated live over WebSockets.

---

## Before you start — install these two things

The app shells out to two command-line tools. **It will not work without them.**

### 1. yt-dlp (does the searching + downloading)

**Windows:**
```powershell
winget install yt-dlp.yt-dlp
```

**macOS:**
```bash
brew install yt-dlp
```

**Linux:**
```bash
sudo curl -L https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp -o /usr/local/bin/yt-dlp
sudo chmod a+rx /usr/local/bin/yt-dlp
```

### 2. ffmpeg (converts audio to MP3 / FLAC / WAV)

**Windows:**
```powershell
winget install Gyan.FFmpeg
```

**macOS:**
```bash
brew install ffmpeg
```

**Linux:**
```bash
sudo apt install ffmpeg
```

### Verify both are installed

Open a **new** terminal and run:
```bash
yt-dlp --version
ffmpeg -version
```
If both print version numbers, you're good. If you get "command not found,"
restart your terminal (or reboot) so the PATH updates, then try again.

You'll also need **Node.js 18+** — get it from [nodejs.org](https://nodejs.org).

---

## Running the app (the normal way)

The app has two parts that run at the same time, so you need **two terminals**.

### Terminal 1 — the backend server
```bash
cd server
npm install      # first time only
npm run dev
```
You should see: `🎧 DJ Request Server  http://localhost:3001`

### Terminal 2 — the frontend
```bash
cd client
npm install      # first time only
npm run dev
```
You should see: `ready - started server on http://localhost:3000`

### Open it
Go to **http://localhost:3000** in your browser. It opens the DJ console — search,
format selector, and live queue, all on one page.

> Leave **both** terminals running while you use the app. Closing either one stops
> it. To shut down, press `Ctrl+C` in each terminal.

---

## How to use it

1. **Pick a source** (top of the page): `SINGLE`, `PLAYLIST`, or `URL`.
2. **Pick a format:** `MP3`, `FLAC`, or `WAV`.
3. **Type or paste** into the search box and hit Enter (or the button).
4. For a **single song**, a popup asks **Extended Mix vs Original** — choose one.
5. Watch the **queue** below fill in. When a track says **READY**, hover the row
   and click the **download arrow** to open/save the file, or **play** to mark it
   played.

Downloaded files are saved to the **`server/downloads/`** folder, named after the
track. You can also open any finished file directly at:
```
http://localhost:3001/downloads/<filename>
```

---

## Format priority for playlists

When you share a **Spotify playlist** with the format left on the default, each
track is fetched at the best quality available, trying in order:

1. **FLAC** (from a lossless source, if one exists)
2. **WAV** (same source, if FLAC conversion fails)
3. **MP3 320 kbps** (fallback — from YouTube/SoundCloud)

So a playlist becomes a mix of lossless-where-available and MP3-everywhere-else.
If you explicitly pick FLAC or WAV in the UI, that choice is honored strictly
(no silent downgrade).

> **Reality check:** lossless sources (Internet Archive / Free Music Archive) are
> mostly older, independent, or Creative-Commons music. For a playlist of current
> chart hits, most tracks will land as MP3 simply because no legitimate lossless
> source exists for them. The app grabs FLAC whenever one genuinely exists — it
> can't manufacture lossless that isn't out there.

---

## Project layout

```
dj-request-app/
├── server/                 # Node + Express + Socket.io backend
│   ├── index.js            # Server entry, HTTP + WebSocket + /downloads route
│   ├── musicHandler.js     # yt-dlp search/download, Spotify/SoundCloud/lossless
│   ├── socketManager.js    # Request pipelines + live queue state
│   ├── downloads/          # Where finished files are saved
│   └── package.json
│
├── client/                 # Next.js 14 frontend (the single-page console)
│   ├── app/
│   │   ├── dashboard/      # The main UI (search + format + queue + modal)
│   │   ├── components/ui/  # TrackCard and shared bits
│   │   └── page.tsx        # Redirects "/" → "/dashboard"
│   ├── lib/socket.ts       # Socket.io client singleton
│   ├── types/index.ts      # Shared TypeScript types
│   └── package.json
│
├── docker-compose.yml      # Run the whole thing with one command (optional)
└── README.md
```

---

## Running with Docker (optional, advanced)

If you have Docker Desktop installed, you can run everything with one command —
no need to install Node, yt-dlp, or ffmpeg separately (they're baked into the
image):

```bash
docker compose up -d --build
```

Then open **http://localhost:3000**. Downloads land in `./downloads/` on your
machine. To stop:
```bash
docker compose down
```

---

## Troubleshooting

| Problem | Fix |
|---|---|
| **"command not found: yt-dlp / ffmpeg"** | They're not installed or not on PATH. Re-do the install step, then open a **new** terminal. |
| **"address already in use :::3001"** | An old server is still running. Run `npx kill-port 3001` then start again. |
| **Search finds nothing** | yt-dlp may be outdated. Update it: `yt-dlp -U` (or re-run the install). |
| **Spotify playlist won't load** | The playlist must be **public**. Private/collaborative ones can't be read. |
| **Page loads but downloads never start** | Make sure the **backend** terminal is running too — the frontend needs it. |
| **FLAC/WAV download fails on a chart song** | No legitimate lossless source exists for it; switch that track to MP3. |
| **Browser shows "can't connect"** | Check both terminals are running and you're on `http://localhost:3000`. |

---

## Notes on quality

- **MP3** is always 320 kbps (from YouTube / SoundCloud).
- **FLAC / WAV** come **only from genuinely lossless sources** — Internet Archive,
  the Free Music Archive, or Bandcamp. The app will **never** quietly hand you a
  YouTube rip dressed up as FLAC. If no real lossless source exists for a track,
  the FLAC/WAV search **fails on purpose** and tells you to use MP3 instead.
- **What this means in practice:** lossless sources are deep in older, live,
  independent, classical, and Creative-Commons music — so those resolve well.
  Current commercial chart songs usually **won't** be found in lossless (they're
  not on those sources), and the app will say so rather than fake it.
- **For true studio-master lossless of a specific release**, paste its **Bandcamp**
  URL directly — that downloads the exact lossless file the artist uploaded.
