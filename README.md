# DJ Core

A desktop app for building a DJ library. Type a track name or paste a link,
pick a format, and it finds a source and pulls down the audio. Nothing is
written to disk until you press download.

Windows desktop app. There is also a browser version if you prefer running it
that way.

![License](https://img.shields.io/badge/license-MIT-blue)

## What it does

**Search by name.** Type `Artist - Song` and it searches YouTube and
SoundCloud. If an Extended Mix turns up, it stops and asks which version you
want before going any further.

**Paste a link.** Spotify playlists, albums and tracks work (public ones), plus
SoundCloud and Bandcamp URLs. A Spotify playlist gets read for its track names,
then every track is searched individually.

**Pick a format.** MP3 at 320 kbps, or FLAC and WAV from genuinely lossless
sources.

**Queue that shows what is happening.** Every track reports its state as it
moves: searching, found, downloading, saved. Progress updates live.

**Downloads happen when you ask.** Searching only finds a source. The track
sits in the queue marked `READY TO GET` until you hit the download button on
that row, or Download All. Then you choose where the file goes.

## Install

Download `DJ Core Setup <version>.exe` from [Releases](../../releases) and run
it. It installs for your user only, so there is no admin prompt, and it ships
its own copies of yt-dlp and ffmpeg. Nothing else to install.

Windows SmartScreen will warn you the first time because the installer is not
code signed. Click More info, then Run anyway. If you would rather not, build
it yourself with the steps below.

## Build it yourself

```bash
git clone https://github.com/brendenmonteiro/dj-core.git
cd dj-core
npm install
npm run dist
```

That writes the installer to `dist/`. The first `npm run dist` also downloads
yt-dlp and ffmpeg into `resources/bin/`, about 117 MB. Those binaries are not
in the repo because they are large and carry their own licenses.

To run it without building an installer:

```bash
npm run build:ui
npm start
```

Add `npm run start:debug` instead of `npm start` if you want DevTools open.

## Using it

Pick a source mode at the top: `SINGLE` for a name, `PLAYLIST` for a Spotify or
SoundCloud playlist, `URL` for a direct link. Pick a format. Type or paste,
then hit enter.

For a single track, a prompt asks whether you want the Extended Mix or the
original. Pick one and the track drops into the queue.

Tracks sit at `READY TO GET` until you download them. Hover a row and click the
download arrow to fetch that one track and choose where to save it, or use
Download All to pick one folder and save everything at once.

Fetched files land in your library folder, sorted into a folder per day like
`27-09-2026`. Change where that is under File, Edit Configuration.

## Settings

File, Edit Configuration opens a plain text config at:

```
%APPDATA%\DJ Core\.env
```

| Setting | What it does |
|---|---|
| `DOWNLOADS_DIR` | Where fetched tracks go. Defaults to `Music\DJ Core`. |
| `SPOTIFY_CLIENT_ID` | Needed for Spotify playlist links. |
| `SPOTIFY_CLIENT_SECRET` | Same. |
| `YTDLP_PATH` | Use a specific yt-dlp instead of the bundled one. |
| `FFMPEG_PATH` | Same, for ffmpeg. |

Spotify credentials are free. Make an app at
[developer.spotify.com/dashboard](https://developer.spotify.com/dashboard) and
paste the ID and secret in. Everything except Spotify playlist links works
without them.

File, Open Downloads Folder jumps straight to your library.

## About formats

MP3 comes from YouTube or SoundCloud at 320 kbps.

FLAC and WAV only come from sources that are actually lossless: the Internet
Archive, the Free Music Archive, or Bandcamp. The app will not hand you a
YouTube rip relabelled as FLAC. If no real lossless source exists for a track,
the search fails and tells you to use MP3 instead.

In practice that means older, live, independent, classical and Creative Commons
music resolves well in lossless. Current chart songs usually will not, because
they are not on those sources. If you want the studio master of a specific
release, paste its Bandcamp URL and you get the exact file the artist uploaded.

For a Spotify playlist left on the default format, each track is tried as FLAC,
then WAV, then MP3, so you end up with lossless where it exists and MP3
everywhere else. Picking FLAC or WAV explicitly is treated as strict, with no
quiet downgrade.

## Running in a browser instead

The desktop app is one process. The browser setup is the older two process
version: a Node backend and a Next.js frontend.

You need [yt-dlp](https://github.com/yt-dlp/yt-dlp) and
[ffmpeg](https://ffmpeg.org/) on your PATH for this. On Windows:

```powershell
winget install yt-dlp.yt-dlp
winget install Gyan.FFmpeg
```

Then run each part in its own terminal:

```bash
cd server && npm install && npm run dev
```

```bash
cd client && npm install && npm run dev
```

Open http://localhost:3000.

With Docker, one command does both:

```bash
docker compose up -d --build
```

Files land in `./downloads/`. Stop it with `docker compose down`.

## Layout

```
dj-core/
├── electron/            Desktop shell
│   ├── main.js          Window, server lifecycle, save dialogs
│   └── preload.js       The only bridge between page and Electron
├── server/              Node, Express, Socket.io
│   ├── index.js         HTTP and WebSocket entry
│   ├── musicHandler.js  yt-dlp search and download
│   ├── socketManager.js Queue state and request pipelines
│   └── binaries.js      Finds yt-dlp and ffmpeg
├── client/              Next.js frontend
│   ├── app/dashboard/   The UI
│   └── lib/socket.ts    Socket.io client
├── scripts/             Build helpers
└── resources/           Icon, and bundled binaries once fetched
```

## If something breaks

**Search finds nothing, or downloads fail with a 403.** yt-dlp is probably out
of date. YouTube changes things and old versions stop working. Run `yt-dlp -U`
if you installed it yourself. The app prefers your own copy over its bundled
one for exactly this reason.

**A Spotify link will not load.** The playlist has to be public. Private and
collaborative playlists cannot be read. Check your credentials are filled in
under File, Edit Configuration.

**FLAC or WAV fails on a chart song.** There is no lossless source for it.
Switch that track to MP3.

**Port 3001 already in use** (browser setup only). An old server is still
running. `npx kill-port 3001` and start again.

**The desktop app window is blank.** Launch with `npm run start:debug` and
check the console. Worth reporting if you hit this.

## Third party tools

This app drives two external programs and bundles them in the Windows
installer without modification:

- [yt-dlp](https://github.com/yt-dlp/yt-dlp), Unlicense. Does the searching and
  downloading.
- [ffmpeg](https://ffmpeg.org/), specifically the
  [gyan.dev](https://www.gyan.dev/ffmpeg/builds/) essentials build, which is
  GPL licensed. Converts audio.

If you redistribute a build of this app you are redistributing those binaries
too, so check you are happy with their licenses, particularly the GPL terms on
ffmpeg.

## License and use

MIT. See [LICENSE](LICENSE).

This is for managing your own library. It downloads from public sources through
yt-dlp. Whether any given download is legal depends on the material and where
you live, and that is your call to make. Do not use it to redistribute music
you do not own.

No account or telemetry. Spotify credentials, if you add them, stay on your
machine and only ever go to Spotify.
