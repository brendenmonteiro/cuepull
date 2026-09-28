// Lossless sources: Bandcamp, Jamendo, ccMixter, and a rewritten Free Music
// Archive search.
//
// Everything here is either Creative Commons, public domain, or sold directly
// by the artist. Nothing indexes commercial releases from sites that have no
// right to distribute them.

const https = require("https");

// ── shared helpers ──────────────────────────────────────────────────────

function get(url, { timeout = 12000, headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const req = https.get(
      url,
      {
        timeout,
        headers: { "User-Agent": "Cuepull/1.1", ...headers },
        // ccMixter echoes the whole JSON payload back in an X-JSON header,
        // which blows past Node's 16KB default and fails the request.
        maxHeaderSize: 262144,
      },
      (res) => {
        // Follow one redirect; several of these endpoints use them.
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          res.resume();
          return resolve(get(res.headers.location, { timeout, headers }));
        }
        if (res.statusCode !== 200) {
          res.resume();
          return reject(new Error(`HTTP ${res.statusCode}`));
        }
        let body = "";
        res.on("data", (c) => (body += c));
        res.on("end", () => resolve(body));
      }
    );
    req.on("error", reject);
    req.on("timeout", () => {
      req.destroy();
      reject(new Error("timeout"));
    });
  });
}

const norm = (s) =>
  String(s || "")
    .toLowerCase()
    .replace(/[^\w\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();

// A query is usually "Artist - Title". Splitting it lets each half be scored
// against the right field, instead of matching one bag of words against one
// string, which is what made the old Free Music Archive search fail.
function splitQuery(query) {
  const raw = String(query || "").trim();
  const m = raw.split(/\s+[-–—]\s+/);
  if (m.length >= 2) {
    return { artist: m[0].trim(), title: m.slice(1).join(" - ").trim(), split: true };
  }
  return { artist: "", title: raw, split: false };
}

// Fraction of the needle's words present in the haystack.
function coverage(needle, haystack) {
  const words = norm(needle).split(" ").filter((w) => w.length > 2);
  if (!words.length) return 1;
  const hay = norm(haystack);
  return words.filter((w) => hay.includes(w)).length / words.length;
}

// Signals the result is not the track asked for.
const BAD_WORDS = [
  "karaoke", "tribute", "tutorial", "reaction", "ringtone", "type beat",
  "8 bit", "8-bit", "nightcore", "sped up", "slowed",
];
const looksWrong = (text) => {
  const t = norm(text);
  return BAD_WORDS.some((b) => t.includes(norm(b)));
};

// ── Free Music Archive ──────────────────────────────────────────────────
// Rewritten. FMA's search matches within an artist catalogue, so a combined
// "artist title" query returns that artist's other albums and nothing scores.
// Searching the title alone and scoring artist and title separately fixes it.

async function searchFMA(query) {
  const { artist, title } = splitQuery(query);

  // Title first, then the whole query, so a single-word search still works.
  const attempts = [title, query].filter((v, i, a) => v && a.indexOf(v) === i);

  for (const attempt of attempts) {
    let html;
    try {
      html = await get(
        `https://freemusicarchive.org/search?quicksearch=${encodeURIComponent(attempt)}`
      );
    } catch {
      continue;
    }

    const links = [
      ...html.matchAll(/href="(https:\/\/freemusicarchive\.org\/music\/[^"]+)"/g),
    ].map((m) => m[1]);

    let best = null;
    for (const url of links) {
      const slug = decodeURIComponent(url.split("/music/")[1] || "")
        .replace(/[-_/]/g, " ")
        .trim();
      if (!slug || looksWrong(slug)) continue;

      const titleScore = coverage(title, slug);
      // An artist match is a bonus, not a requirement: plenty of FMA slugs
      // carry only the track.
      const artistScore = artist ? coverage(artist, slug) : 0;
      const score = titleScore + artistScore * 0.5;

      // The title has to be essentially present, or it is a different track.
      if (titleScore < 0.8) continue;
      if (!best || score > best.score) {
        best = { url, slug, score };
      }
    }

    if (best) {
      return {
        url: best.url,
        title: best.slug,
        artist: artist || "Free Music Archive",
        duration: "",
        source: "Free Music Archive",
        license: "Creative Commons",
        bpm: null,
        key: null,
      };
    }
  }
  throw new Error("no Free Music Archive match");
}

// ── Jamendo ─────────────────────────────────────────────────────────────
// Around 600k Creative Commons tracks with a real API, and FLAC downloads
// where the artist allowed it. Needs a free client id.

async function searchJamendo(query, clientId) {
  if (!clientId) throw new Error("no Jamendo client id");
  const { artist, title } = splitQuery(query);

  const base = "https://api.jamendo.com/v3.0/tracks/?" +
    new URLSearchParams({
      client_id: clientId,
      format: "json",
      limit: "20",
      // Ask for the lossless download url.
      audiodlformat: "flac",
      include: "musicinfo",
      ...(artist ? { artist_name: artist, namesearch: title } : { search: title }),
    }).toString();

  const body = await get(base);
  const json = JSON.parse(body);
  const rows = json?.results || [];

  let best = null;
  for (const r of rows) {
    // Only offer it if the artist actually permitted downloads.
    if (!r.audiodownload_allowed || !r.audiodownload) continue;
    const hay = `${r.name || ""} ${r.artist_name || ""}`;
    if (looksWrong(hay)) continue;

    const titleScore = coverage(title, r.name || "");
    const artistScore = artist ? coverage(artist, r.artist_name || "") : 1;
    if (titleScore < 0.8) continue;
    const score = titleScore + artistScore;
    if (!best || score > best.score) best = { r, score };
  }
  if (!best) throw new Error("no Jamendo match");

  const r = best.r;
  return {
    // yt-dlp handles a direct audio url fine.
    url: r.audiodownload,
    title: r.name || title,
    artist: r.artist_name || artist || "Jamendo",
    duration: r.duration ? String(r.duration) : "",
    durationSec: r.duration || null,
    source: "Jamendo",
    license: r.license_ccurl ? "Creative Commons" : "Jamendo",
    tags: r.musicinfo?.tags?.genres || [],
    bpm: null,
    key: null,
  };
}

// ── ccMixter ────────────────────────────────────────────────────────────
// Open API, no key. Creative Commons remixes and originals, and a decent
// share of uploads include a FLAC.

async function searchCCMixter(query) {
  const { artist, title } = splitQuery(query);
  const url =
    "https://ccmixter.org/api/query?" +
    new URLSearchParams({
      f: "json",
      limit: "25",
      search: title || query,
    }).toString();

  const body = await get(url);
  const rows = JSON.parse(body);
  if (!Array.isArray(rows)) throw new Error("unexpected ccMixter response");

  let best = null;
  for (const r of rows) {
    const files = r.files || [];
    // Only interested where a genuine lossless file exists.
    const lossless = files.find((f) => /\.(flac|wav|aiff)$/i.test(f.file_name || ""));
    if (!lossless) continue;

    const hay = `${r.upload_name || ""} ${r.user_name || ""}`;
    if (looksWrong(hay)) continue;

    const titleScore = coverage(title, r.upload_name || "");
    const artistScore = artist ? coverage(artist, r.user_name || "") : 1;
    if (titleScore < 0.8) continue;
    const score = titleScore + artistScore;
    if (!best || score > best.score) best = { r, lossless, score };
  }
  if (!best) throw new Error("no ccMixter match");

  const { r, lossless } = best;
  return {
    url: lossless.download_url || r.file_page_url,
    title: r.upload_name || title,
    artist: r.user_real_name || r.user_name || "ccMixter",
    duration: "",
    source: "ccMixter",
    license: r.license_name || "Creative Commons",
    tags: String(r.upload_tags || "").split(/[,\s]+/).filter(Boolean).slice(0, 20),
    bpm: null,
    key: null,
  };
}

// ── Bandcamp ────────────────────────────────────────────────────────────
// Previously only reachable by pasting a url. Bandcamp sells lossless direct
// from the artist, so being able to find a page by name matters. This returns
// the page; whether a track is free or paid is up to the artist, and yt-dlp
// will only fetch what is actually downloadable.

async function searchBandcamp(query) {
  const { artist, title } = splitQuery(query);
  const html = await get(
    `https://bandcamp.com/search?q=${encodeURIComponent(query)}&item_type=t`
  );

  // Result urls sit in the markup as plain artist-subdomain links.
  const urls = [
    ...html.matchAll(/https:\/\/[a-z0-9-]+\.bandcamp\.com\/(track|album)\/[a-z0-9-]+/gi),
  ].map((m) => m[0]);

  const seen = new Set();
  let best = null;
  for (const url of urls) {
    if (seen.has(url)) continue;
    seen.add(url);

    const slug = decodeURIComponent(url.split(/\/(track|album)\//)[2] || "").replace(/-/g, " ");
    const sub = (url.match(/https:\/\/([a-z0-9-]+)\./i) || [])[1] || "";
    if (looksWrong(slug)) continue;

    const titleScore = coverage(title, slug);
    const artistScore = artist ? coverage(artist, sub.replace(/-/g, " ")) : 0;
    if (titleScore < 0.8) continue;
    const score = titleScore + artistScore * 0.5;
    if (!best || score > best.score) best = { url, slug, score };
  }
  if (!best) throw new Error("no Bandcamp match");

  return {
    url: best.url,
    title: best.slug,
    artist: artist || "Bandcamp",
    duration: "",
    source: "Bandcamp",
    license: "Purchased from artist",
    bpm: null,
    key: null,
  };
}

module.exports = {
  searchFMA,
  searchJamendo,
  searchCCMixter,
  searchBandcamp,
  splitQuery,
  coverage,
};
