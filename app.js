const SPOTIFY_CLIENT_ID = "a30880253f984eea94c30910de910785";
const REDIRECT_URI = window.location.origin + window.location.pathname;
const SCOPES = [
  "user-read-private",
  "user-library-read",
  "playlist-modify-private",
  "playlist-modify-public"
];

let accessToken = localStorage.getItem("btwb_access_token") || "";
let tokenExpiresAt = Number(localStorage.getItem("btwb_token_expires_at") || "0");
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
  summary: document.getElementById("summary"),
  preview: document.getElementById("preview"),
  icebergCanvas: document.getElementById("icebergCanvas"),
  downloadIceberg: document.getElementById("downloadIceberg")
};

function setStatus(message) {
  els.status.textContent = message;
}

function setConnectedState(isConnected) {
  els.scanBtn.disabled = !isConnected;
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
  const verifier = randomString(96);
  const challenge = base64UrlEncode(await sha256(verifier));
  localStorage.setItem("btwb_code_verifier", verifier);

  const params = new URLSearchParams({
    response_type: "code",
    client_id: SPOTIFY_CLIENT_ID,
    scope: SCOPES.join(" "),
    code_challenge_method: "S256",
    code_challenge: challenge,
    redirect_uri: REDIRECT_URI
  });

  window.location.href = `https://accounts.spotify.com/authorize?${params}`;
}

async function handleCallback() {
  const url = new URL(window.location.href);
  const code = url.searchParams.get("code");
  const error = url.searchParams.get("error");

  if (error) throw new Error(`Spotify login failed: ${error}`);
  if (!code) return;

  const verifier = localStorage.getItem("btwb_code_verifier");
  if (!verifier) throw new Error("Missing login verifier. Clear login and try again.");

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

  if (!response.ok) throw new Error(await response.text());

  const data = await response.json();
  accessToken = data.access_token;
  tokenExpiresAt = Date.now() + (data.expires_in * 1000) - 60000;

  localStorage.setItem("btwb_access_token", accessToken);
  localStorage.setItem("btwb_token_expires_at", String(tokenExpiresAt));

  url.searchParams.delete("code");
  url.searchParams.delete("error");
  window.history.replaceState({}, document.title, url.toString());

  await loadProfile();
}

function ensureToken() {
  if (!accessToken) throw new Error("Please log in with Spotify first.");
  if (Date.now() > tokenExpiresAt) {
    logout(false);
    throw new Error("Spotify login expired. Please log in again.");
  }
}

async function spotifyFetch(path, options = {}) {
  ensureToken();
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
    throw new Error("Spotify login expired. Please log in again.");
  }

  if (response.status === 429) {
    throw new Error(`Spotify rate limited this request. Retry after ${response.headers.get("Retry-After") || "a few"} seconds.`);
  }

  if (!response.ok) throw new Error(`Spotify API error ${response.status}: ${await response.text()}`);
  if (response.status === 204) return null;
  return response.json();
}

async function loadProfile() {
  userProfile = await spotifyFetch("/me");
  setConnectedState(true);
  setStatus(`Connected as ${userProfile.display_name || userProfile.id}.`);
}

async function getAllLikedTracks() {
  let url = "/me/tracks?limit=50";
  const items = [];

  while (url) {
    const data = await spotifyFetch(url);
    items.push(...data.items);
    setStatus(`Fetched ${items.length} liked songs...`);
    url = data.next ? data.next.replace("https://api.spotify.com/v1", "") : null;
  }

  return items.map(item => item.track).filter(track => track?.id && track?.uri);
}

function chunk(array, size) {
  const chunks = [];
  for (let i = 0; i < array.length; i += size) chunks.push(array.slice(i, i + size));
  return chunks;
}

async function getArtistMap(tracks) {
  const artistIds = [...new Set(tracks.flatMap(t => t.artists.map(a => a.id).filter(Boolean)))];
  const map = new Map();
  const chunks = chunk(artistIds, 50);

  for (let i = 0; i < chunks.length; i++) {
    const data = await spotifyFetch(`/artists?ids=${chunks[i].join(",")}`);
    for (const artist of data.artists || []) if (artist?.id) map.set(artist.id, artist);
    setStatus(`Fetched artist metadata ${i + 1}/${chunks.length}...`);
  }

  return map;
}

function followerBonus(followers) {
  if (followers < 100) return 100;
  if (followers < 1000) return 90;
  if (followers < 10000) return 75;
  if (followers < 50000) return 55;
  if (followers < 100000) return 40;
  if (followers < 500000) return 20;
  return 0;
}

function scoreTrack(track, artistMap) {
  const primaryArtist = artistMap.get(track.artists[0]?.id);
  const trackPopularity = track.popularity ?? 0;
  const artistPopularity = primaryArtist?.popularity ?? 0;
  const followers = primaryArtist?.followers?.total ?? 0;

  const obscurityScore =
    ((100 - trackPopularity) * 0.65) +
    ((100 - artistPopularity) * 0.25) +
    (followerBonus(followers) * 0.10);

  const basicnessScore = Math.max(0, Math.min(100, Math.round(100 - obscurityScore)));

  return {
    id: track.id,
    uri: track.uri,
    name: track.name,
    artist: track.artists.map(a => a.name).join(", "),
    album: track.album?.name || "",
    image: track.album?.images?.[0]?.url || "",
    trackPopularity,
    artistPopularity,
    followers,
    obscurityScore: Math.round(obscurityScore),
    basicnessScore,
    spotifyUrl: track.external_urls?.spotify || ""
  };
}

function getTierNames(count) {
  const names = els.playlistNames.value.split("\n").map(x => x.trim()).filter(Boolean);
  while (names.length < count) names.push(`Tier ${names.length + 1}`);
  return names.slice(0, count);
}

function buildTiers(scored) {
  const count = Number(els.tierCount.value);
  const tracksPerPlaylist = Number(els.tracksPerPlaylist.value);
  const minTracks = Number(els.minTracksPerTier.value);
  const names = getPlaylistNames(count);

  const sorted = [...scored].sort((a, b) => {
    if (a.basicnessScore !== b.basicnessScore) {
      return a.basicnessScore - b.basicnessScore;
    }
    return a.name.localeCompare(b.name);
  });

  const tiers = [];

  for (let i = 0; i < count; i++) {
    const start = Math.floor((sorted.length / count) * i);
    const end = Math.floor((sorted.length / count) * (i + 1));
    const bucket = sorted.slice(start, end);

    if (bucket.length >= minTracks) {
      tiers.push({
        name: names[i],
        minScore: bucket[0]?.basicnessScore ?? 0,
        maxScore: bucket[bucket.length - 1]?.basicnessScore ?? 0,
        percentileStart: Math.round((i / count) * 100),
        percentileEnd: Math.round(((i + 1) / count) * 100),
        tracks: bucket.slice(0, tracksPerPlaylist)
      });
    }
  }

  return tiers;
}

  return tiers;
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function renderPreview() {
  els.summary.textContent = `Scored ${scoredTracks.length} liked songs and generated ${generatedTiers.length} tiers.`;
  els.preview.innerHTML = generatedTiers.map(tier => `
    <article class="tier">
      <div class="tierTop">
        <h3>${escapeHtml(tier.name)}</h3>
        <span>${tier.minScore}-${tier.maxScore} basicness</span>
      </div>
      <p>${tier.tracks.length} tracks</p>
      <ol>
        ${tier.tracks.slice(0, 10).map(t => `<li><a href="${t.spotifyUrl}" target="_blank" rel="noreferrer">${escapeHtml(t.artist)} — ${escapeHtml(t.name)}</a> <em>${t.basicnessScore}</em></li>`).join("")}
      </ol>
    </article>
  `).join("");
}

async function scanLikedSongs() {
  els.scanBtn.disabled = true;
  els.createBtn.disabled = true;
  els.icebergBtn.disabled = true;

  try {
    const liked = await getAllLikedTracks();

    scoredTracks = liked.map(track => {
      const trackPopularity = track.popularity ?? 0;

      return {
        id: track.id,
        uri: track.uri,
        name: track.name,
        artist: track.artists.map(a => a.name).join(", "),
        album: track.album?.name || "",
        trackPopularity,
        artistPopularity: null,
        followers: null,

        // 0 = obscure, 100 = basic
        basicnessScore: trackPopularity,

        spotifyUrl: track.external_urls?.spotify || ""
      };
    });

    generatedTiers = buildTiers(scoredTracks);
    renderPreview();

    els.createBtn.disabled = generatedTiers.length === 0;
    els.icebergBtn.disabled = generatedTiers.length === 0;

    setStatus(
      `Done. Scored ${scoredTracks.length} liked songs using Spotify track popularity only. ` +
      `Generated ${generatedTiers.length} tiers.`
    );
  } catch (err) {
    setStatus(err.message);
  } finally {
    els.scanBtn.disabled = false;
  }
}

async function addTracksToPlaylist(playlistId, uris) {
  for (const uriChunk of chunk(uris, 100)) {
    await spotifyFetch(`/playlists/${playlistId}/tracks`, {
      method: "POST",
      body: JSON.stringify({ uris: uriChunk })
    });
  }
}

async function createPlaylists() {
  if (!userProfile) await loadProfile();
  const prefix = els.playlistPrefix.value.trim();
  const isPublic = els.visibility.value === "public";
  els.createBtn.disabled = true;

  for (let i = 0; i < generatedTiers.length; i++) {
    const tier = generatedTiers[i];
    const name = prefix ? `${prefix}: ${tier.name}` : tier.name;
    setStatus(`Creating ${i + 1}/${generatedTiers.length}: ${name}`);

    const playlist = await spotifyFetch(`/users/${userProfile.id}/playlists`, {
      method: "POST",
      body: JSON.stringify({
        name,
        public: isPublic,
        description: `Generated by beforetheywerebasic.com. Basicness score ${tier.minScore}-${tier.maxScore}.`
      })
    });

    await addTracksToPlaylist(playlist.id, tier.tracks.map(t => t.uri));
  }

  els.createBtn.disabled = false;
  setStatus(`Created ${generatedTiers.length} playlists.`);
}

function generateIceberg() {
  const canvas = els.icebergCanvas;
  const ctx = canvas.getContext("2d");
  canvas.classList.remove("hidden");

  ctx.clearRect(0, 0, canvas.width, canvas.height);
  const gradient = ctx.createLinearGradient(0, 0, 0, canvas.height);
  gradient.addColorStop(0, "#91d5ff");
  gradient.addColorStop(0.27, "#38bdf8");
  gradient.addColorStop(0.28, "#075985");
  gradient.addColorStop(1, "#020617");
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  ctx.fillStyle = "rgba(255,255,255,.93)";
  ctx.beginPath();
  ctx.moveTo(600, 150);
  ctx.lineTo(310, 520);
  ctx.lineTo(455, 520);
  ctx.lineTo(175, 1430);
  ctx.lineTo(1025, 1430);
  ctx.lineTo(745, 520);
  ctx.lineTo(890, 520);
  ctx.closePath();
  ctx.fill();

  ctx.strokeStyle = "rgba(255,255,255,.98)";
  ctx.lineWidth = 8;
  ctx.beginPath();
  ctx.moveTo(0, 520);
  ctx.lineTo(1200, 520);
  ctx.stroke();

  ctx.textAlign = "center";
  ctx.fillStyle = "#020617";
  ctx.font = "800 62px Arial";
  ctx.fillText("MY MUSIC TASTE ICEBERG", 600, 95);

  const tiers = [...generatedTiers].sort((a, b) => b.minScore - a.minScore);
  const yPositions = [250, 350, 460, 610, 735, 860, 985, 1110, 1240, 1370];

  tiers.forEach((tier, index) => {
    const y = yPositions[index] || 1450;
    const aboveWater = y < 520;
    ctx.fillStyle = aboveWater ? "#020617" : "#e0f2fe";
    ctx.font = "800 34px Arial";
    ctx.fillText(tier.name, 600, y);

    const examples = tier.tracks.slice(0, 3).map(t => `${t.artist} – ${t.name}`).join("  •  ");
    ctx.font = "24px Arial";
    wrapText(ctx, examples, 600, y + 38, 900, 31);
  });

  ctx.fillStyle = "#e0f2fe";
  ctx.font = "22px Arial";
  ctx.fillText("generated by beforetheywerebasic.com", 600, 1550);

  els.downloadIceberg.href = canvas.toDataURL("image/png");
  els.downloadIceberg.classList.remove("hidden");
}

function wrapText(ctx, text, x, y, maxWidth, lineHeight) {
  const words = text.split(" ");
  let line = "";
  for (const word of words) {
    const testLine = `${line}${word} `;
    if (ctx.measureText(testLine).width > maxWidth && line) {
      ctx.fillText(line, x, y);
      line = `${word} `;
      y += lineHeight;
    } else {
      line = testLine;
    }
  }
  ctx.fillText(line, x, y);
}

function logout(showMessage = true) {
  localStorage.removeItem("btwb_access_token");
  localStorage.removeItem("btwb_token_expires_at");
  localStorage.removeItem("btwb_code_verifier");
  accessToken = "";
  tokenExpiresAt = 0;
  userProfile = null;
  scoredTracks = [];
  generatedTiers = [];
  setConnectedState(false);
  els.createBtn.disabled = true;
  els.icebergBtn.disabled = true;
  els.preview.innerHTML = "";
  els.summary.textContent = "Log in, scan your liked songs, then your tiers will appear here.";
  els.downloadIceberg.classList.add("hidden");
  els.icebergCanvas.classList.add("hidden");
  if (showMessage) setStatus("Login cleared.");
}

els.loginBtn.addEventListener("click", () => loginWithSpotify().catch(err => setStatus(err.message)));
els.logoutBtn.addEventListener("click", () => logout(true));
els.scanBtn.addEventListener("click", () => scanLikedSongs().catch(err => { setStatus(err.message); els.scanBtn.disabled = false; }));
els.createBtn.addEventListener("click", () => createPlaylists().catch(err => { setStatus(err.message); els.createBtn.disabled = false; }));
els.icebergBtn.addEventListener("click", generateIceberg);

for (const el of [els.tierCount, els.tracksPerPlaylist, els.minTracksPerTier, els.playlistNames]) {
  el.addEventListener("change", () => {
    if (scoredTracks.length) {
      generatedTiers = buildTiers();
      renderPreview();
      els.createBtn.disabled = generatedTiers.length === 0;
      els.icebergBtn.disabled = generatedTiers.length === 0;
    }
  });
}

handleCallback()
  .then(async () => {
    if (accessToken) await loadProfile();
  })
  .catch(err => setStatus(err.message));
