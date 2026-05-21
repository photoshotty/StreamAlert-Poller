// Twitch Live detection poller.
//
// Calls Helix /streams in 100-id batches for every tracked Twitch source
// returned by /api/poll-targets/twitch on the StreamAlert deployment.
// POSTs the normalised observations[] to /api/cron/twitch-ingest, which
// hands them to the shared poll-processor brain.
//
// Required GitHub Actions secrets:
//   INGEST_URL          - full URL of /api/cron/twitch-ingest
//   INGEST_SECRET       - matches CRON_SECRET on Vercel
//   TWITCH_CLIENT_ID    - Twitch app client id
//   TWITCH_CLIENT_SECRET - Twitch app client secret

const INGEST_URL = process.env.INGEST_URL;
const INGEST_SECRET = process.env.INGEST_SECRET;
const CLIENT_ID = process.env.TWITCH_CLIENT_ID;
const CLIENT_SECRET = process.env.TWITCH_CLIENT_SECRET;
if (!INGEST_URL)    { console.error("INGEST_URL not set");    process.exit(1); }
if (!INGEST_SECRET) { console.error("INGEST_SECRET not set"); process.exit(1); }
if (!CLIENT_ID)     { console.error("TWITCH_CLIENT_ID not set");     process.exit(1); }
if (!CLIENT_SECRET) { console.error("TWITCH_CLIENT_SECRET not set"); process.exit(1); }

const TOKEN_URL = "https://id.twitch.tv/oauth2/token";
const HELIX = "https://api.twitch.tv/helix";

function pollTargetsUrl() {
  const u = new URL(INGEST_URL);
  return `${u.origin}/api/poll-targets/twitch`;
}

async function fetchTargets() {
  const res = await fetch(pollTargetsUrl(), {
    headers: { Authorization: `Bearer ${INGEST_SECRET}` },
  });
  if (!res.ok) {
    throw new Error(
      `poll-targets failed: ${res.status} ${await res.text().catch(() => "")}`
    );
  }
  const json = await res.json();
  return json.targets || [];
}

async function mintAccessToken() {
  const params = new URLSearchParams({
    client_id: CLIENT_ID,
    client_secret: CLIENT_SECRET,
    grant_type: "client_credentials",
  });
  const res = await fetch(`${TOKEN_URL}?${params.toString()}`, { method: "POST" });
  if (!res.ok) {
    throw new Error(`token mint failed: ${res.status} ${await res.text()}`);
  }
  const j = await res.json();
  return j.access_token;
}

async function helix(path, params, token) {
  const res = await fetch(`${HELIX}${path}?${params.toString()}`, {
    headers: {
      "Client-Id": CLIENT_ID,
      Authorization: `Bearer ${token}`,
    },
  });
  if (!res.ok) {
    throw new Error(`Helix ${path} ${res.status}: ${await res.text()}`);
  }
  return res.json();
}

function chunked(arr, size) {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

async function getLiveStreams(userIds, token) {
  const all = [];
  for (const chunk of chunked(userIds, 100)) {
    const params = new URLSearchParams();
    params.set("first", "100");
    for (const id of chunk) params.append("user_id", id);
    const data = await helix("/streams", params, token);
    for (const s of data.data) {
      if (s.type === "live") all.push(s);
    }
  }
  return all;
}

async function main() {
  const startedAt = Date.now();

  const targets = await fetchTargets();
  if (targets.length === 0) {
    console.log("no targets tracked, exiting");
    return;
  }

  const userIds = targets
    .map((t) => t.external_id)
    .filter((id) => typeof id === "string" && id.length > 0);

  if (userIds.length === 0) {
    console.log("no twitch external_ids on tracked sources, exiting");
    return;
  }

  const token = await mintAccessToken();
  const live = await getLiveStreams(userIds, token);
  const liveById = new Map(live.map((s) => [s.user_id, s]));

  // Build one observation per tracked source — live ones with their
  // Helix stream payload, the rest marked offline.
  const observations = targets.map((t) => {
    const stream = liveById.get(t.external_id);
    if (stream) {
      return {
        user_id: stream.user_id,
        user_login: stream.user_login,
        is_live: true,
        stream_id: stream.id,
        title: stream.title || null,
        game_name: stream.game_name || null,
        viewer_count: stream.viewer_count ?? null,
        thumbnail_url: stream.thumbnail_url || null,
        started_at: stream.started_at || null,
      };
    }
    return {
      user_id: t.external_id,
      user_login: t.handle,
      is_live: false,
      stream_id: null,
      title: null,
      game_name: null,
      viewer_count: null,
      thumbnail_url: null,
      started_at: null,
    };
  });

  const payload = {
    source: "github-actions",
    duration_ms: Date.now() - startedAt,
    observations,
  };

  const counts = {
    total: observations.length,
    live: observations.filter((o) => o.is_live).length,
    offline: observations.filter((o) => !o.is_live).length,
  };
  console.log(JSON.stringify({ counts }, null, 2));

  const res = await fetch(INGEST_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${INGEST_SECRET}`,
    },
    body: JSON.stringify(payload),
  });
  if (!res.ok) {
    console.error(`ingest failed: ${res.status} ${await res.text()}`);
    process.exit(1);
  }
  console.log("ingest ok");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
