const { execFile, spawn } = require("child_process");
const https = require("https");
const fs = require("fs");
const path = require("path");
const { ytDlpPath, ffmpegArgs } = require("./binaries");

// Base library folder. Override with DOWNLOADS_DIR in server/.env to point at
// your real music library; defaults to ./downloads so a fresh clone still works.
const DOWNLOADS_DIR = process.env.DOWNLOADS_DIR
  ? path.resolve(process.env.DOWNLOADS_DIR)
  : path.join(__dirname, "downloads");

if (!fs.existsSync(DOWNLOADS_DIR)) {
  fs.mkdirSync(DOWNLOADS_DIR, { recursive: true });
}

// Tracks are filed under a per-day folder, DD-MM-YYYY in local time, so a set
// downloaded today lands together in e.g. "27-09-2026/".
function todayFolder() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, "0");
  return `${pad(d.getDate())}-${pad(d.getMonth() + 1)}-${d.getFullYear()}`;
}

function isSpotifyUrl(input) {
  return (
    typeof input === "string" &&
    /open\.spotify\.com\/(playlist|album|track)\//.test(input)
  );
}

//  Spotify, scrape the public embed page (no token, no API keys)
// open.spotify.com/embed/{type}/{id} is the publicly-rendered widget Spotify
// serves for website embeds. Its HTML contains a __NEXT_DATA__ JSON blob with
// the full tracklist. No auth required, this is what every embed preview uses.

function fetchHtml(hostname, reqPath, redirectsLeft = 3) {
  return new Promise((resolve, reject) => {
    https.get(
      {
        hostname,
        path: reqPath,
        headers: {
          "User-Agent":
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
          Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
          "Accept-Language": "en-US,en;q=0.9",
        },
      },
      (res) => {
        if (
          (res.statusCode === 301 || res.statusCode === 302 || res.statusCode === 307) &&
          res.headers.location &&
          redirectsLeft > 0
        ) {
          const u = new URL(res.headers.location, `https://${hostname}`);
          res.resume();
          fetchHtml(u.hostname, u.pathname + u.search, redirectsLeft - 1)
            .then(resolve)
            .catch(reject);
          return;
        }
        let data = "";
        res.on("data", (c) => (data += c));
        res.on("end", () => resolve(data));
      }
    ).on("error", reject);
  });
}

// Pull the __NEXT_DATA__ JSON object out of the embed HTML.
function parseNextData(html) {
  const m = html.match(
    /<script id="__NEXT_DATA__" type="application\/json">([\s\S]*?)<\/script>/
  );
  if (!m) return null;
  try {
    return JSON.parse(m[1]);
  } catch {
    return null;
  }
}

// Normalize the various artist shapes the embed payload uses into a string.
function joinArtists(entity) {
  const artists =
    entity?.artists ||
    entity?.subtitle ||
    entity?.otherArtists ||
    [];
  if (Array.isArray(artists)) {
    return artists.map((a) => (typeof a === "string" ? a : a?.name)).filter(Boolean).join(", ");
  }
  if (typeof entity?.subtitle === "string") return entity.subtitle;
  return "";
}

async function getSpotifyTracks(url) {
  const match = url.match(/open\.spotify\.com\/(playlist|album|track)\/([A-Za-z0-9]+)/);
  if (!match) throw new Error("Invalid Spotify URL");
  const [, type, id] = match;

  const html = await fetchHtml("open.spotify.com", `/embed/${type}/${id}`);
  const nextData = parseNextData(html);
  if (!nextData) {
    throw new Error("Could not read the Spotify embed page. The playlist may be private or unavailable.");
  }

  // The entity lives at props.pageProps.state.data.entity (current embed schema).
  const entity =
    nextData?.props?.pageProps?.state?.data?.entity ||
    nextData?.props?.pageProps?.entity ||
    nextData?.props?.pageProps?.data?.entity;

  if (!entity) {
    throw new Error("Spotify embed format not recognised, try copying the link again.");
  }

  if (type === "track") {
    return [{ title: entity.name || entity.title, artist: joinArtists(entity) }];
  }

  // playlist & album both expose a trackList array in the embed payload
  const list = entity.trackList || entity.tracks?.items || entity.tracks || [];
  const tracks = [];
  for (const item of list) {
    const t = item.track || item;
    const title = t.title || t.name;
    if (!title) continue;
    tracks.push({ title, artist: joinArtists(t) });
  }

  if (!tracks.length) {
    throw new Error(`No tracks found in this Spotify ${type}. Make sure it's public.`);
  }
  return tracks;
}

// Search YouTube. requireExtended=true enforces "Extended Mix" in the result title.
async function searchMusicApi(query, requireExtended = true) {
  return new Promise((resolve, reject) => {
    const searchQuery = requireExtended
      ? `ytsearch1:${query} Extended Mix`
      : `ytsearch1:${query}`;
    execFile(
      ytDlpPath(),
      ["--no-download", "--print", "%(id)s\t%(title)s\t%(uploader)s\t%(duration_string)s", searchQuery],
      { timeout: 30000 },
      (err, stdout) => {
        if (err) return reject(new Error(`yt-dlp search failed: ${err.message}`));
        const line = stdout.trim();
        if (!line) return reject(new Error(`No results found for "${query}"`));
        const [id, title, uploader, duration] = line.split("\t");
        if (requireExtended && !/extended\s+mix/i.test(title)) {
          return reject(new Error(`No Extended Mix found for "${query}", top result was "${title}"`));
        }
        resolve({
          title: title || query,
          artist: uploader || "Unknown Artist",
          url: `https://www.youtube.com/watch?v=${id}`,
          duration: duration || "",
          bpm: null,
          key: null,
        });
      }
    );
  });
}

// Search SoundCloud as a fallback.
async function searchSoundCloudMix(query, requireExtended = true) {
  return new Promise((resolve, reject) => {
    const searchQuery = requireExtended
      ? `scsearch1:${query} Extended Mix`
      : `scsearch1:${query}`;
    execFile(
      ytDlpPath(),
      ["--no-download", "--print", "%(webpage_url)s\t%(title)s\t%(uploader)s\t%(duration_string)s", searchQuery],
      { timeout: 30000 },
      (err, stdout) => {
        if (err) return reject(new Error(`SoundCloud search failed`));
        const line = stdout.trim();
        if (!line) return reject(new Error(`No SoundCloud results for "${query}"`));
        const [url, title, uploader, duration] = line.split("\t");
        if (requireExtended && !/extended\s+mix/i.test(title)) {
          return reject(new Error(`No Extended Mix on SoundCloud for "${query}"`));
        }
        resolve({
          title: title || query,
          artist: uploader || "Unknown Artist",
          url: url || "",
          duration: duration || "",
          bpm: null,
          key: null,
        });
      }
    );
  });
}

// Try YouTube then SoundCloud for an Extended Mix. Returns result or throws.
async function searchExtendedMix(query) {
  try { return await searchMusicApi(query, true); } catch {}
  try { return await searchSoundCloudMix(query, true); } catch {}
  throw new Error(`No Extended Mix found for "${query}" on YouTube or SoundCloud`);
}

// Find the best plain match (no Extended Mix requirement).
async function searchOriginal(query) {
  try { return await searchMusicApi(query, false); } catch {}
  try { return await searchSoundCloudMix(query, false); } catch {}
  throw new Error(`Could not find "${query}" on YouTube or SoundCloud`);
}

//  Lossless sources (Bandcamp, Internet Archive, Free Music Archive)
// These are legitimate sources that distribute WAV/FLAC. yt-dlp resolves each
// via its own extractor / a generic search. We grab the top match's page URL,
// then downloadTrack() pulls the best available audio in the requested format.

// Each source resolves a query to a real page URL yt-dlp can extract audio from.

// Internet Archive, advanced-search JSON API, preferring items that actually
// carry a lossless format and ranking by popularity so we get real releases.
function searchInternetArchive(query) {
  return new Promise((resolve, reject) => {
    const q = `(${query}) AND mediatype:audio`;
    const path =
      `/advancedsearch.php?q=${encodeURIComponent(q)}` +
      `&fl[]=identifier&fl[]=title&fl[]=creator&fl[]=format` +
      `&sort[]=downloads+desc&rows=10&output=json`;
    https.get(
      { hostname: "archive.org", path, headers: { "User-Agent": "Mozilla/5.0" } },
      (res) => {
        let data = "";
        res.on("data", (c) => (data += c));
        res.on("end", () => {
          try {
            const json = JSON.parse(data);
            const docs = json?.response?.docs || [];
            // Prefer items advertising FLAC/WAV; fall back to the top hit.
            const hasLossless = (d) => {
              const f = Array.isArray(d.format) ? d.format.join(" ") : String(d.format || "");
              return /flac|wav|aiff/i.test(f);
            };
            const doc = docs.find(hasLossless) || docs[0];
            if (!doc) return reject(new Error("No Internet Archive result"));
            resolve({
              url: `https://archive.org/details/${doc.identifier}`,
              title: doc.title || query,
              artist: Array.isArray(doc.creator) ? doc.creator[0] : doc.creator || "Unknown Artist",
              duration: "",
              bpm: null,
              key: null,
            });
          } catch {
            reject(new Error("Internet Archive search failed"));
          }
        });
      }
    ).on("error", reject);
  });
}

// Free Music Archive, scrape the search results for a track whose link slug
// actually matches the query. FMA shows "featured" tracks even when there are no
// real results, so we must verify the match instead of grabbing the first link
// (otherwise we'd return an unrelated song with a faked title).
function searchFMA(query) {
  return new Promise((resolve, reject) => {
    https.get(
      {
        hostname: "freemusicarchive.org",
        path: `/search?quicksearch=${encodeURIComponent(query)}`,
        headers: { "User-Agent": "Mozilla/5.0" },
      },
      (res) => {
        let data = "";
        res.on("data", (c) => (data += c));
        res.on("end", () => {
          const queryWords = query
            .toLowerCase()
            .replace(/[^\w\s]/g, " ")
            .split(/\s+/)
            .filter((w) => w.length > 2);

          // Collect candidate /music/ links and test each slug against the query.
          const links = [...data.matchAll(/href="(https:\/\/freemusicarchive\.org\/music\/[^"]+)"/g)]
            .map((m) => m[1]);

          for (const url of links) {
            // The slug (after /music/) contains artist + track, dash-separated.
            const slug = decodeURIComponent(url.split("/music/")[1] || "").toLowerCase().replace(/[-_/]/g, " ");
            const matched = queryWords.filter((w) => slug.includes(w)).length;
            // Require most query words present in the slug to count as a real hit.
            if (matched >= Math.ceil(queryWords.length * 0.7)) {
              // Build a readable title from the slug rather than echoing the query.
              const title = slug.replace(/\s+/g, " ").trim();
              return resolve({
                url,
                title: title || query,
                artist: "Free Music Archive",
                duration: "",
                bpm: null,
                key: null,
              });
            }
          }
          reject(new Error("No matching Free Music Archive result"));
        });
      }
    ).on("error", reject);
  });
}

// Lossless search resolves the EXACT track from a GENUINELY lossless source.
//
// Order matters: real lossless sources (Internet Archive, Free Music Archive)
// come first. YouTube is only used as a last resort when allowYouTubeFallback is
// true, because YouTube audio is ~256 kbps AAC, so converting it to FLAC/WAV
// gives a lossless *container* with lossy audio inside (not a true master).
//
// - When the user explicitly picks FLAC/WAV → allowYouTubeFallback = false, so we
//   only ever return a genuinely lossless source (or fail, rather than fake it).
// - For the playlist auto-priority path → allowYouTubeFallback = true, because
//   there YouTube MP3 is the intended bottom tier anyway.
async function searchLossless(query, allowYouTubeFallback = false) {
  // 1) Internet Archive, genuine lossless (FLAC/WAV/AIFF). Strict title match.
  try {
    const ia = await searchInternetArchiveSingleTrack(query);
    if (ia?.url) return { ...ia, source: "Internet Archive" };
  } catch {}

  // 2) Free Music Archive, genuine lossless / high-quality originals.
  try {
    const fma = await searchFMA(query);
    if (fma?.url) return { ...fma, source: "Free Music Archive" };
  } catch {}

  // 3) YouTube, ONLY if explicitly allowed (lossy source; container-lossless).
  if (allowYouTubeFallback) {
    try {
      const yt = await searchMusicApi(query, false);
      if (yt?.url) return { ...yt, source: "YouTube" };
    } catch {}
  }

  throw new Error(
    allowYouTubeFallback
      ? `No source found for "${query}".`
      : `No genuine lossless source (Internet Archive / Free Music Archive / Bandcamp) found for "${query}". ` +
        `Try MP3, or paste a Bandcamp URL for studio-master lossless.`
  );
}

// Resolve an Internet Archive item that genuinely matches the query AND actually
// carries a lossless file. We require nearly all query words to appear in the
// item's title+creator, and reject obvious bootlegs/mashups/remixes, so we don't
// hand back unrelated uploads that merely share a word or two.
function searchInternetArchiveSingleTrack(query) {
  return new Promise((resolve, reject) => {
    const q = `(${query}) AND mediatype:audio AND (format:FLAC OR format:WAV OR format:AIFF)`;
    const path =
      `/advancedsearch.php?q=${encodeURIComponent(q)}` +
      `&fl[]=identifier&fl[]=title&fl[]=creator&fl[]=format` +
      `&sort[]=downloads+desc&rows=15&output=json`;
    https.get(
      { hostname: "archive.org", path, headers: { "User-Agent": "Mozilla/5.0" } },
      (res) => {
        let data = "";
        res.on("data", (c) => (data += c));
        res.on("end", () => {
          try {
            const json = JSON.parse(data);
            const docs = json?.response?.docs || [];

            const queryWords = query
              .toLowerCase()
              .replace(/[^\w\s]/g, " ")
              .split(/\s+/)
              .filter((w) => w.length > 2);

            // Words that signal the item is NOT the original studio track.
            const badWords = ["bootleg", "mashup", "mash up", "vs", "vs.", "remix",
              "cover", "karaoke", "tribute", "live", "8 bit", "8-bit", "instrumental",
              "type beat", "ringtone", "tutorial", "reaction"];

            const hasLossless = (d) => {
              const f = Array.isArray(d.format) ? d.format.join(" ") : String(d.format || "");
              return /flac|wav|aiff/i.test(f);
            };

            for (const doc of docs) {
              if (!hasLossless(doc)) continue;

              const haystack = `${doc.title || ""} ${
                Array.isArray(doc.creator) ? doc.creator.join(" ") : doc.creator || ""
              }`.toLowerCase();

              // Reject mashups/bootlegs/covers etc.
              if (badWords.some((bw) => haystack.includes(bw))) continue;

              // Require (almost) every query word to be present, strict match.
              const matched = queryWords.filter((w) => haystack.includes(w)).length;
              const needed = Math.max(queryWords.length - 1, Math.ceil(queryWords.length * 0.8));
              if (matched < needed) continue;

              resolve({
                url: `https://archive.org/details/${doc.identifier}`,
                title: doc.title || query,
                artist: Array.isArray(doc.creator) ? doc.creator[0] : doc.creator || "Unknown Artist",
                duration: "",
                bpm: null,
                key: null,
              });
              return;
            }
            reject(new Error("No close lossless match on Internet Archive"));
          } catch {
            reject(new Error("Internet Archive search failed"));
          }
        });
      }
    ).on("error", reject);
  });
}

function isBandcampUrl(input) {
  return typeof input === "string" && /bandcamp\.com\//.test(input);
}

// Titles come from remote metadata, so treat them as hostile. Strips path
// separators and anything Windows rejects, plus control characters (a NUL can
// truncate a path in lower-level calls) and the reserved device names.
function sanitizeFilename(name) {
  let out = String(name)
    .replace(/[\u0000-\u001f\u007f]/g, "")
    .replace(/[/\:*?"<>|]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    // Windows silently drops a trailing dot or space, changing the name.
    .replace(/[. ]+$/, "")
    .slice(0, 200);

  if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i.test(out)) out = "_" + out;
  return out || "track";
}

// format: "mp3" (default, 320kbps) | "flac" | "wav", lossless formats ask
// yt-dlp for the best available audio and convert without re-compressing.
async function downloadTrack(url, trackId, title, onProgress, format = "mp3") {
  return new Promise((resolve, reject) => {
    const fmt = ["flac", "wav"].includes(format) ? format : "mp3";
    const safeTitle = sanitizeFilename(title || trackId);
    const dateFolder = todayFolder();
    const dayDir = path.join(DOWNLOADS_DIR, dateFolder);
    if (!fs.existsSync(dayDir)) {
      fs.mkdirSync(dayDir, { recursive: true });
    }
    // fileName is relative to DOWNLOADS_DIR (always "/" separated) because it
    // is handed to the client and appended to the /downloads/ static route.
    const fileName = `${dateFolder}/${safeTitle}.${fmt}`;
    const outputPath = path.join(dayDir, `${safeTitle}.${fmt}`);

    const args = [
      // Point yt-dlp at our resolved ffmpeg rather than trusting PATH, the
      // audio conversion below cannot run without it.
      ...ffmpegArgs(),
      "--extract-audio",
      "--audio-format",
      fmt,
      // 320K only applies to lossy; lossless formats use best quality (0)
      "--audio-quality",
      fmt === "mp3" ? "320K" : "0",
      // Only ever grab ONE item, never expand a playlist/album into many files.
      "--no-playlist",
      "--playlist-items",
      "1",
      "--output",
      outputPath,
      "--newline",
      url,
    ];

    const proc = spawn(ytDlpPath(), args);

    proc.stdout.on("data", (data) => {
      const text = data.toString();
      const match = text.match(/\[download\]\s+([\d.]+)%/);
      if (match) {
        const pct = Math.round(parseFloat(match[1]));
        onProgress(pct);
      }
    });

    // Keep the last stderr lines so a failure reports *why* (e.g. a YouTube 403
    // from a stale yt-dlp) instead of a bare exit code.
    let errTail = "";
    proc.stderr.on("data", (data) => {
      errTail = (errTail + data.toString()).slice(-2000);
    });

    proc.on("close", (code) => {
      if (code === 0) {
        resolve({ filePath: outputPath, fileName });
      } else {
        const detail = errTail
          .split(/\r?\n/)
          .map((l) => l.trim())
          .filter((l) => l.startsWith("ERROR:") || /^WARNING:.*(update|older)/i.test(l))
          .slice(-2)
          .join(" | ");
        reject(
          new Error(
            detail
              ? `yt-dlp download failed: ${detail}`
              : `yt-dlp download failed (exit code ${code})`
          )
        );
      }
    });

    proc.on("error", (err) => {
      reject(new Error(`Failed to spawn yt-dlp: ${err.message}`));
    });
  });
}

function isSoundCloudUrl(input) {
  return (
    typeof input === "string" && /soundcloud\.com\//.test(input)
  );
}

async function getSoundCloudTracks(url) {
  return new Promise((resolve, reject) => {
    execFile(
      ytDlpPath(),
      [
        "--flat-playlist",
        "--no-download",
        "--print",
        "%(title)s\t%(uploader)s\t%(duration_string)s\t%(webpage_url)s",
        url,
      ],
      { timeout: 60000 },
      (err, stdout) => {
        if (err) {
          return reject(
            new Error(`Failed to extract SoundCloud tracks: ${err.message}`)
          );
        }
        const lines = stdout.trim().split("\n").filter(Boolean);
        if (!lines.length) {
          return reject(new Error("No tracks found at this SoundCloud URL"));
        }
        const tracks = lines
          .map((line) => {
            const [title, artist, duration, trackUrl] = line.split("\t");
            const resolvedUrl =
              trackUrl && trackUrl.trim() && trackUrl.trim() !== "NA"
                ? trackUrl.trim()
                : url;
            return {
              title: (title || "").trim(),
              artist: (artist || "").trim(),
              duration: (duration || "").trim(),
              url: resolvedUrl,
            };
          })
          .filter((t) => t.title && t.title !== "NA");
        if (!tracks.length) {
          return reject(
            new Error("Could not extract track info from this SoundCloud URL")
          );
        }
        resolve(tracks);
      }
    );
  });
}

module.exports = {
  DOWNLOADS_DIR,
  searchMusicApi,
  searchExtendedMix,
  searchOriginal,
  searchLossless,
  isBandcampUrl,
  downloadTrack,
  isSpotifyUrl,
  getSpotifyTracks,
  isSoundCloudUrl,
  getSoundCloudTracks,
};
