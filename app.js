const SPOTIFY_CLIENT_ID = "a30880253f984eea94c30910de910785";

const REDIRECT_URI = window.location.origin + window.location.pathname;

const SCOPES = [
  "user-read-private",
  "user-library-read",
  "user-top-read",
  "user-read-recently-played",
  "playlist-modify-private",
  "playlist-modify-public"
];

let accessToken = localStorage.getItem("spotify_access_token") || "";
let userProfile = null;
let scoredTracks = [];
let generatedTiers = [];

const els = {
  loginBtn: document.getElementById("loginBtn"),
  logoutBtn: document.getElementById("logoutBtn"),
  scanBtn: document.getElementById("scanBtn"),
  createBtn: document.getElementById("createBtn"),
  icebergBtn: document.getElementById("icebergBtn"),
  tierCount: document.getElementById("tierCount"),
  tracksPerPlaylist: document.getElementById("tracksPerPlaylist"),
  visibility: document.getElementById("visibility"),
  minTracksPerTier: document.getElementById("minTracksPerTier"),
  playlistPrefix: document.getElementById("playlistPrefix"),
  playlistNames: document.getElementById("playlistNames"),
  status: document.getElementById("status"),
  preview: document.getElementById("preview"),
  icebergCanvas: document.getElementById("icebergCanvas")
};

function setStatus(message) {
  els.status.textContent = message;
}

function randomString(length) {
  const possible = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  const values = crypto.getRandomValues(new Uint8Array(length));
  return values.reduce((acc, x) => acc + possible[x % possible.length], "");
}

async function sha256(plain) {
  return crypto.subtle.digest("SHA-256", new TextEncoder().encode(plain));
}

function base64UrlEncode(buffer) {
  return btoa(String.fromCharCode(...new Uint8Array(buffer)))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

async function loginWithSpotify() {
  const verifier = randomString(64);
  const challenge = base64UrlEncode(await sha256(verifier));

  localStorage.setItem("spotify_code_verifier", verifier);

  const params = new URLSearchParams({
    response_type: "code",
    client_id: SPOTIFY_CLIENT_ID,
    scope: SCOPES.join(" "),
    code_challenge_method: "S256",
    code_challenge: challenge,
    redirect_uri: REDIRECT_URI
  });

  window.location = `https://accounts.spotify.com/authorize?${params.toString()}`;
}

async function handleOAuthCallback() {
  const url = new URL(window.location.href);
  const code = url.searchParams.get("code");

  if (!code) return;

  const verifier = localStorage.getItem("spotify_code_verifier");

  if (!verifier) {
    throw new Error("Missing Spotify login verifier. Log out and try again.");
  }

  setStatus("Finishing Spotify login...");

  const body = new URLSearchParams({
    client_id: SPOTIFY_CLIENT_ID,
    grant_type: "authorization_code",
    code,
    redirect_uri: REDIRECT_URI,
    code_verifier: verifier
  });

  const response = await fetch("https://accounts.spotify.com/api/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Spotify token error ${response.status}: ${text}`);
  }

  const data = await response.json();

  accessToken = data.access_token;
  localStorage.setItem("spotify_access_token", accessToken);

  url.searchParams.delete("code");
  window.history.replaceState({}, document.title, url.toString());

  await loadProfile();
}

async function spotifyFetch(path, options = {}) {
  const response = await fetch(`https://api.spotify.com/v1${path}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
      ...(options.headers || {})
    }
  });

  if (response.status === 401) {
    logout(false);
    throw new Error("Spotify login expired. Log in again.");
  }

  if (response.status === 429) {
    const retryAfter = response.headers.get("Retry-After") || "a few";
    throw new Error(`Spotify rate limit hit. Try again after ${retryAfter} seconds.`);
  }

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Spotify API error ${response.status} on ${path}: ${text}`);
  }

  return response.json();
}

async function loadProfile() {
  userProfile = await spotifyFetch("/me");
  els.scanBtn.disabled = false;
  setStatus(`Connected as ${userProfile.display_name || userProfile.id}.`);
}

function chunk(array, size) {
  const chunks = [];

  for (let i = 0; i < array.length; i += size) {
    chunks.push(array.slice(i, i + size));
  }

  return chunks;
}

function normalizeText(value) {
  return String(value || "")
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9а-яё一-龯ぁ-んァ-ン가-힣]+/gi, " ")
    .trim();
}

function trackIdentity(item) {
  return `${normalizeText(item.artist)}::${normalizeText(item.name)}`;
}

function artistKeyFromTrack(track) {
  return normalizeText(track.artists?.[0]?.name || "");
}

function albumKeyFromTrack(track) {
  return normalizeText(track.album?.name || "");
}

function trackKeyFromTrack(track) {
  const artist = track.artists?.[0]?.name || "";
  return `${normalizeText(artist)}::${normalizeText(track.name)}`;
}

async function getAllLikedTracks() {
  let url = "/me/tracks?limit=50";
  const items = [];

  while (url) {
    const data = await spotifyFetch(url);

    items.push(...data.items);
    setStatus(`Fetched ${items.length} liked songs...`);

    url = data.next
      ? data.next.replace("https://api.spotify.com/v1", "")
      : null;
  }

  const deduped = [];
  const seen = new Set();

  for (const item of items) {
    const track = item.track;

    if (!track || track.type !== "track" || !track.id) continue;

    const identity = trackKeyFromTrack(track);

    if (seen.has(identity)) continue;

    seen.add(identity);

    deduped.push({
      addedAt: item.added_at,
      track
    });
  }

  return deduped;
}

async function getUserTopTrackScores() {
  const ranges = [
    { key: "short_term", weight: 120 },
    { key: "medium_term", weight: 80 },
    { key: "long_term", weight: 50 }
  ];

  const scoreByTrackKey = new Map();

  for (const range of ranges) {
    try {
      const data = await spotifyFetch(
        `/me/top/tracks?time_range=${range.key}&limit=50&offset=0`
      );

      data.items.forEach((track, index) => {
        const key = trackKeyFromTrack(track);
        const rankScore = Math.max(range.weight - index, 1);
        const existing = scoreByTrackKey.get(key) || 0;

        scoreByTrackKey.set(key, existing + rankScore);
      });

      setStatus(`Fetched your ${range.key.replace("_", " ")} top tracks...`);
    } catch (err) {
      console.warn("Top tracks failed:", err);
      setStatus(`Could not fetch ${range.key} top tracks. Continuing...`);
    }
  }

  return scoreByTrackKey;
}

async function getRecentlyPlayedScores() {
  const scoreByTrackKey = new Map();

  try {
    const data = await spotifyFetch("/me/player/recently-played?limit=50");

    data.items.forEach((item, index) => {
      const track = item.track;
      if (!track || !track.id) return;

      const key = trackKeyFromTrack(track);
      const score = Math.max(60 - index, 1);
      const existing = scoreByTrackKey.get(key) || 0;

      scoreByTrackKey.set(key, existing + score);
    });

    setStatus("Fetched your recently played tracks...");
  } catch (err) {
    console.warn("Recently played failed:", err);
    setStatus("Could not fetch recently played tracks. Continuing...");
  }

  return scoreByTrackKey;
}

function percentileRank(value, min, max) {
  if (max <= min) return 50;
  return Math.round(((value - min) / (max - min)) * 100);
}

function buildFrequencyMaps(likedItems) {
  const artistCounts = new Map();
  const albumCounts = new Map();

  for (const item of likedItems) {
    const artistKey = artistKeyFromTrack(item.track);
    const albumKey = albumKeyFromTrack(item.track);

    artistCounts.set(artistKey, (artistCounts.get(artistKey) || 0) + 1);

    if (albumKey) {
      albumCounts.set(albumKey, (albumCounts.get(albumKey) || 0) + 1);
    }
  }

  return { artistCounts, albumCounts };
}

function buildScoredTracks(likedItems, topScores, recentScores) {
  const { artistCounts, albumCounts } = buildFrequencyMaps(likedItems);

  const addedTimes = likedItems
    .map(item => new Date(item.addedAt).getTime())
    .filter(Number.isFinite);

  const oldest = Math.min(...addedTimes);
  const newest = Math.max(...addedTimes);

  const artistCountValues = [...artistCounts.values()];
  const albumCountValues = [...albumCounts.values()];

  const maxArtistCount = Math.max(...artistCountValues, 1);
  const maxAlbumCount = Math.max(...albumCountValues, 1);

  return likedItems.map(item => {
    const track = item.track;

    const artist = track.artists?.map(a => a.name).join(", ") || "";
    const primaryArtistKey = artistKeyFromTrack(track);
    const albumKey = albumKeyFromTrack(track);
    const key = trackKeyFromTrack(track);

    const artistCount = artistCounts.get(primaryArtistKey) || 1;
    const albumCount = albumCounts.get(albumKey) || 1;

    const addedTime = new Date(item.addedAt).getTime();

    /*
      Newer saved songs feel more surface-level.
      Older saved songs feel deeper in your personal library.
    */
    const recencyScore = percentileRank(addedTime, oldest, newest);

    /*
      Artists/albums that appear many times in your liked songs are more
      familiar/basic within YOUR library. One-off artists are deeper cuts.
    */
    const artistFamiliarity = Math.round((artistCount / maxArtistCount) * 100);
    const albumFamiliarity = Math.round((albumCount / maxAlbumCount) * 100);

    /*
      Top/recent activity is a surface-level signal. It should influence the
      ranking, but not dominate the whole app.
    */
    const topScore = topScores.get(key) || 0;
    const recentScore = recentScores.get(key) || 0;
    const activityRaw = topScore + recentScore;
    const activityScore = Math.min(100, Math.round(activityRaw / 3));

    /*
      Final score:
      0 = deep personal-library cut
      100 = surface-level / basic within user's own listening world
    */
    const libraryBasicnessScore = Math.round(
      recencyScore * 0.35 +
      artistFamiliarity * 0.30 +
      albumFamiliarity * 0.15 +
      activityScore * 0.20
    );

    return {
      id: track.id,
      uri: track.uri,
      name: track.name,
      artist,
      primaryArtist: track.artists?.[0]?.name || "",
      album: track.album?.name || "",
      addedAt: item.addedAt,

      basicnessScore: libraryBasicnessScore,
      scoreSource: "personal library score",

      recencyScore,
      artistFamiliarity,
      albumFamiliarity,
      activityScore,
      userActivityScore: activityRaw,

      artistCount,
      albumCount,

      spotifyUrl: track.external_urls?.spotify || ""
    };
  });
}

function getPlaylistNames(count) {
  const names = els.playlistNames.value
    .split("\n")
    .map(x => x.trim())
    .filter(Boolean);

  const defaults = [
    "I Knew Them Before They Were Big",
    "Basement Show Energy",
    "Your Friend’s Band",
    "Deep Cut Certified",
    "Indie Sleaze Adjacent",
    "Pitchfork Cousin",
    "College Radio Core",
    "Cool But Searchable",
    "Algorithm Enjoyer",
    "Basic Bitch"
  ];

  const source = names.length ? names : defaults;

  while (source.length < count) {
    source.push(`Tier ${source.length + 1}`);
  }

  return source.slice(0, count);
}

function buildTiers(scored) {
  const count = Number(els.tierCount.value);
  const tracksPerPlaylist = Number(els.tracksPerPlaylist.value);
  const minTracks = Number(els.minTracksPerTier.value);
  const names = getPlaylistNames(count);

  const sortedByBasicness = [...scored].sort((a, b) => {
    if (a.basicnessScore !== b.basicnessScore) {
      return a.basicnessScore - b.basicnessScore;
    }

    return a.name.localeCompare(b.name);
  });

  const tiers = [];

  for (let i = 0; i < count; i++) {
    const start = Math.floor((sortedByBasicness.length / count) * i);
    const end = Math.floor((sortedByBasicness.length / count) * (i + 1));
    const bucket = sortedByBasicness.slice(start, end);

    /*
      Pick the best examples of that tier, not just the first 50.
      For deep tiers, prefer rarer artists/albums and older saves.
      For surface tiers, prefer familiar/recent/active tracks.
    */
    const isDeepTier = i < count / 2;

    const selected = [...bucket]
      .sort((a, b) => {
        if (isDeepTier) {
          const aDeep =
            (100 - a.artistFamiliarity) * 0.4 +
            (100 - a.albumFamiliarity) * 0.2 +
            (100 - a.recencyScore) * 0.3 +
            a.activityScore * 0.1;

          const bDeep =
            (100 - b.artistFamiliarity) * 0.4 +
            (100 - b.albumFamiliarity) * 0.2 +
            (100 - b.recencyScore) * 0.3 +
            b.activityScore * 0.1;

          return bDeep - aDeep;
        }

        const aSurface =
          a.artistFamiliarity * 0.3 +
          a.albumFamiliarity * 0.15 +
          a.recencyScore * 0.25 +
          a.activityScore * 0.3;

        const bSurface =
          b.artistFamiliarity * 0.3 +
          b.albumFamiliarity * 0.15 +
          b.recencyScore * 0.25 +
          b.activityScore * 0.3;

        return bSurface - aSurface;
      })
      .slice(0, tracksPerPlaylist);

    if (bucket.length >= minTracks) {
      tiers.push({
        name: names[i],
        minScore: bucket[0]?.basicnessScore ?? 0,
        maxScore: bucket[bucket.length - 1]?.basicnessScore ?? 0,
        percentileStart: Math.round((i / count) * 100),
        percentileEnd: Math.round(((i + 1) / count) * 100),
        totalInTier: bucket.length,
        scoreSource: "personal library score",
        tracks: selected
      });
    }
  }

  return tiers;
}

function renderPreview() {
  if (!generatedTiers.length) {
    els.preview.innerHTML = "<p>No tiers generated. Try lowering the minimum tracks per tier.</p>";
    return;
  }

  els.preview.innerHTML = `
    <p>
      Scored ${scoredTracks.length} liked songs and generated ${generatedTiers.length} tiers.
      Spotify popularity is ignored in this version. Tiers are based on your own library:
      liked-date age, artist frequency, album frequency, and top/recent listening.
    </p>

    ${generatedTiers.map(tier => {
      const trackList = tier.tracks.slice(0, 10).map(track => `
        <li>
          <strong>${escapeHtml(track.artist)}</strong> — ${escapeHtml(track.name)}
          <span class="score">
            score ${track.basicnessScore},
            artist x${track.artistCount},
            album x${track.albumCount},
            activity ${track.userActivityScore}
          </span>
        </li>
      `).join("");

      return `
        <div class="tier">
          <div class="tier-header">
            <strong>${escapeHtml(tier.name)}</strong>
            <span class="score">
              ${tier.percentileStart}-${tier.percentileEnd}% • library score ${tier.minScore}-${tier.maxScore}
            </span>
          </div>
          <p class="small">
            ${tier.tracks.length} selected from ${tier.totalInTier} liked songs in this tier.
          </p>
          <ol class="tracks">${trackList}</ol>
        </div>
      `;
    }).join("")}
  `;
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

async function scanLikedSongs() {
  els.scanBtn.disabled = true;
  els.createBtn.disabled = true;
  els.icebergBtn.disabled = true;

  try {
    const likedItems = await getAllLikedTracks();
    const topScores = await getUserTopTrackScores();
    const recentScores = await getRecentlyPlayedScores();

    scoredTracks = buildScoredTracks(likedItems, topScores, recentScores);
    generatedTiers = buildTiers(scoredTracks);

    renderPreview();

    els.createBtn.disabled = generatedTiers.length === 0;
    els.icebergBtn.disabled = generatedTiers.length === 0;

    setStatus(
      `Done. Scored ${scoredTracks.length} liked songs. ` +
      `Generated ${generatedTiers.length} tiers using personal library scoring.`
    );
  } catch (err) {
    setStatus(err.message);
  } finally {
    els.scanBtn.disabled = false;
  }
}

async function addTracksToPlaylist(playlistId, uris) {
  const uriChunks = chunk(uris, 100);

  for (const uriChunk of uriChunks) {
    await spotifyFetch(`/playlists/${playlistId}/tracks`, {
      method: "POST",
      body: JSON.stringify({ uris: uriChunk })
    });
  }
}

async function createPlaylists() {
  if (!userProfile) {
    await loadProfile();
  }

  const isPublic = els.visibility.value === "public";
  const prefix = els.playlistPrefix.value.trim() || "Before They Were Basic";

  els.createBtn.disabled = true;

  try {
    for (let i = 0; i < generatedTiers.length; i++) {
      const tier = generatedTiers[i];
      const playlistName = `${prefix}: ${tier.name}`;

      setStatus(`Creating playlist ${i + 1}/${generatedTiers.length}: ${playlistName}`);

      const playlist = await spotifyFetch(`/users/${userProfile.id}/playlists`, {
        method: "POST",
        body: JSON.stringify({
          name: playlistName,
          public: isPublic,
          description:
            `Generated by Before They Were Basic. ` +
            `Personal library tier ${tier.percentileStart}-${tier.percentileEnd}%. ` +
            `Library score ${tier.minScore}-${tier.maxScore}.`
        })
      });

      await addTracksToPlaylist(playlist.id, tier.tracks.map(t => t.uri));
    }

    setStatus(`Created ${generatedTiers.length} Spotify playlists.`);
  } catch (err) {
    setStatus(err.message);
  } finally {
    els.createBtn.disabled = false;
  }
}

function generateIcebergMeme() {
  if (!generatedTiers.length) {
    setStatus("Scan liked songs first.");
    return;
  }

  const canvas = els.icebergCanvas;
  const ctx = canvas.getContext("2d");

  canvas.width = 1000;
  canvas.height = 1400;
  canvas.style.display = "block";

  ctx.clearRect(0, 0, canvas.width, canvas.height);

  const gradient = ctx.createLinearGradient(0, 0, 0, canvas.height);
  gradient.addColorStop(0, "#89d8ff");
  gradient.addColorStop(0.29, "#3b82f6");
  gradient.addColorStop(0.31, "#082f49");
  gradient.addColorStop(1, "#020617");

  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  ctx.fillStyle = "rgba(255,255,255,.92)";
  ctx.beginPath();
  ctx.moveTo(500, 130);
  ctx.lineTo(255, 430);
  ctx.lineTo(370, 430);
  ctx.lineTo(140, 1240);
  ctx.lineTo(860, 1240);
  ctx.lineTo(630, 430);
  ctx.lineTo(745, 430);
  ctx.closePath();
  ctx.fill();

  ctx.strokeStyle = "rgba(255,255,255,.95)";
  ctx.lineWidth = 6;
  ctx.beginPath();
  ctx.moveTo(0, 430);
  ctx.lineTo(1000, 430);
  ctx.stroke();

  ctx.textAlign = "center";
  ctx.fillStyle = "#020617";
  ctx.font = "bold 52px system-ui";
  ctx.fillText("MY MUSIC TASTE ICEBERG", 500, 78);

  const tiersForIceberg = [...generatedTiers].reverse();

  const yPositions = [
    230, 315, 400,
    535, 650,
    770, 890,
    1010, 1130, 1245
  ];

  tiersForIceberg.forEach((tier, index) => {
    const y = yPositions[index] || 1260;
    const aboveWater = y < 430;

    ctx.fillStyle = aboveWater ? "#020617" : "#e0f2fe";
    ctx.font = "bold 27px system-ui";
    ctx.fillText(tier.name, 500, y);

    const examples = tier.tracks
      .slice(0, 2)
      .map(t => `${t.artist} — ${t.name}`)
      .join(" • ");

    ctx.font = "19px system-ui";
    wrapText(ctx, examples, 500, y + 32, 760, 24);
  });

  const link = document.createElement("a");
  link.download = "before-they-were-basic-iceberg.png";
  link.href = canvas.toDataURL("image/png");
  link.click();

  setStatus("Generated iceberg meme.");
}

function wrapText(ctx, text, x, y, maxWidth, lineHeight) {
  const words = text.split(" ");
  let line = "";

  for (const word of words) {
    const testLine = line + word + " ";
    const metrics = ctx.measureText(testLine);

    if (metrics.width > maxWidth && line !== "") {
      ctx.fillText(line, x, y);
      line = word + " ";
      y += lineHeight;
    } else {
      line = testLine;
    }
  }

  ctx.fillText(line, x, y);
}

function logout(updateStatus = true) {
  localStorage.removeItem("spotify_access_token");
  localStorage.removeItem("spotify_code_verifier");

  accessToken = "";
  userProfile = null;
  scoredTracks = [];
  generatedTiers = [];

  els.scanBtn.disabled = true;
  els.createBtn.disabled = true;
  els.icebergBtn.disabled = true;

  els.preview.innerHTML = "<p>Log in, scan your liked songs, then your tiers will appear here.</p>";

  if (els.icebergCanvas) {
    els.icebergCanvas.style.display = "none";
  }

  if (updateStatus) {
    setStatus("Logged out.");
  }
}

els.loginBtn.addEventListener("click", () => {
  loginWithSpotify().catch(err => setStatus(err.message));
});

els.logoutBtn.addEventListener("click", () => logout(true));

els.scanBtn.addEventListener("click", () => {
  scanLikedSongs().catch(err => setStatus(err.message));
});

els.createBtn.addEventListener("click", () => {
  createPlaylists().catch(err => setStatus(err.message));
});

els.icebergBtn.addEventListener("click", generateIcebergMeme);

handleOAuthCallback()
  .then(async () => {
    if (accessToken && !userProfile) {
      await loadProfile();
    }
  })
  .catch(err => setStatus(err.message));
