const SPOTIFY_CLIENT_ID = "a30880253f984eea94c30910de910785";

const REDIRECT_URI = window.location.origin + window.location.pathname;

const SCOPES = [
  "user-read-private",
  "user-library-read",
  "user-top-read",
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
    throw new Error("Missing Spotify login verifier. Clear login and try again.");
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

  return items
    .map(item => ({
      addedAt: item.added_at,
      track: item.track
    }))
    .filter(item => item.track && item.track.type === "track" && item.track.id);
}

async function getUserTopTrackScores() {
  const ranges = [
    { key: "short_term", weight: 100 },
    { key: "medium_term", weight: 70 },
    { key: "long_term", weight: 45 }
  ];

  const scoreMap = new Map();

  for (const range of ranges) {
    const data = await spotifyFetch(
      `/me/top/tracks?time_range=${range.key}&limit=50&offset=0`
    );

    data.items.forEach((track, index) => {
      const rankScore = range.weight - index;
      const existing = scoreMap.get(track.id) || {
        score: 0,
        labels: []
      };

      existing.score += Math.max(rankScore, 1);
      existing.labels.push(`${range.key} #${index + 1}`);

      scoreMap.set(track.id, existing);
    });

    setStatus(`Fetched your ${range.key.replace("_", " ")} top tracks...`);
  }

  return scoreMap;
}

function buildScoredTracks(likedItems, topTrackScores) {
  return likedItems.map(item => {
    const track = item.track;
    const topData = topTrackScores.get(track.id);

    const userActivityScore = topData?.score || 0;

    return {
      id: track.id,
      uri: track.uri,
      name: track.name,
      artist: track.artists.map(a => a.name).join(", "),
      album: track.album?.name || "",
      addedAt: item.addedAt,
      trackPopularity: track.popularity ?? 0,

      // 0 = obscure, 100 = basic
      basicnessScore: track.popularity ?? 0,

      // Higher means the user appears to listen to it more.
      userActivityScore,

      userActivityLabel: topData?.labels?.join(", ") || "not in Spotify top tracks",

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

    if (b.userActivityScore !== a.userActivityScore) {
      return b.userActivityScore - a.userActivityScore;
    }

    return new Date(b.addedAt) - new Date(a.addedAt);
  });

  const tiers = [];

  for (let i = 0; i < count; i++) {
    const start = Math.floor((sortedByBasicness.length / count) * i);
    const end = Math.floor((sortedByBasicness.length / count) * (i + 1));
    const bucket = sortedByBasicness.slice(start, end);

    const topFromBucket = [...bucket]
      .sort((a, b) => {
        if (b.userActivityScore !== a.userActivityScore) {
          return b.userActivityScore - a.userActivityScore;
        }

        // If Spotify does not expose enough top-track activity,
        // use most recently liked songs as fallback.
        return new Date(b.addedAt) - new Date(a.addedAt);
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
        tracks: topFromBucket
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
      Each tier is sorted by your Spotify top-track activity first, then recently liked tracks.
    </p>
    ${generatedTiers.map(tier => {
      const trackList = tier.tracks.slice(0, 10).map(track => `
        <li>
          <strong>${escapeHtml(track.artist)}</strong> — ${escapeHtml(track.name)}
          <span class="score">
            popularity ${track.basicnessScore}, activity ${track.userActivityScore}
          </span>
        </li>
      `).join("");

      return `
        <div class="tier">
          <div class="tier-header">
            <strong>${escapeHtml(tier.name)}</strong>
            <span class="score">
              ${tier.percentileStart}-${tier.percentileEnd}% • popularity ${tier.minScore}-${tier.maxScore}
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
    const topTrackScores = await getUserTopTrackScores();

    scoredTracks = buildScoredTracks(likedItems, topTrackScores);
    generatedTiers = buildTiers(scoredTracks);

    renderPreview();

    els.createBtn.disabled = generatedTiers.length === 0;
    els.icebergBtn.disabled = generatedTiers.length === 0;

    setStatus(
      `Done. Scored ${scoredTracks.length} liked songs. ` +
      `Generated ${generatedTiers.length} tiers using Spotify popularity + your top-track activity.`
    );
  } catch (err) {
    setStatus(err.message);
  } finally {
    els.scanBtn.disabled = false;
  }
}

function chunk(array, size) {
  const chunks = [];

  for (let i = 0; i < array.length; i += size) {
    chunks.push(array.slice(i, i + size));
  }

  return chunks;
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
            `Tier ${tier.percentileStart}-${tier.percentileEnd}%. ` +
            `Spotify popularity range ${tier.minScore}-${tier.maxScore}.`
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
    setStatus("Login cleared.");
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
