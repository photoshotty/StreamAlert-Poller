// Kick Live detection poller (OAuth client-credentials flow).
//
// Triggered externally by cron-job.org hitting GitHub Actions
// workflow_dispatch. Fetches the live set of tracked Kick slugs from
// /api/poll-targets/kick, looks each up via the official
// api.kick.com/public/v1 endpoint, and POSTs the batch to
// /api/cron/kick-ingest.
//
// Cloudflare WAF blocks unauthenticated requests to /api/v2 and the
// HTML /{slug} route from GitHub Actions IPs (verified 2026-05-20: HTTP
// 403, ref 9e4db7e3). The official OAuth API is the only path that
// works from datacenter IPs.

const INGEST_URL = process.env.INGEST_URL;
const INGEST_SECRET = process.env.INGEST_SECRET;
const CLIENT_ID = process.env.KICK_CLIENT_ID;
const CLIENT_SECRET = process.env.KICK_CLIENT_SECRET;
if (!INGEST_URL)    { console.error("INGEST_URL not set");    process.exit(1); }
if (!INGEST_SECRET) { console.error("INGEST_SECRET not set"); process.exit(1); }
if (!CLIENT_ID)     { console.error("KICK_CLIENT_ID not set");     process.exit(1); }
if (!CLIENT_SECRET) { console.error("KICK_CLIENT_SECRET not set"); process.exit(1); }

const TOKEN_URL = "https://id.kick.com/oauth/token";
const API_BASE = "https://api.kick.com/public/v1";

function pollTargetsUrl() {
  const u = new URL(INGEST_URL);
  return `${u.origin}/api/poll-targets/kick`;
}

async function fetchHandles() {
  const res = await fetch(pollTargetsUrl(), {
    headers: { Authorization: `Bearer ${INGEST_SECRET}` },
  });
  if (!res.ok) {
    throw new Error(
      `poll-targets failed: ${res.status} ${await res.text().catch(() => "")}`
    );
  }
  const json = await res.json();
  return (json.targets || []).map((t) => t.handle).filter(Boolean);
}

async function mintAccessToken() {
  const body = new URLSearchParams({
    grant_type: "client_credentials",
    client_id: CLIENT_ID,
    client_secret: CLIENT_SECRET,
  });
  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: body.toString(),
  });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`token mint failed: ${res.status} ${text.slice(0, 200)}`);
  }
  const json = JSON.parse(text);
  if (!json.access_token) {
    throw new Error(`token response missing access_token: ${text.slice(0, 200)}`);
  }
  return json.access_token;
}

async function checkHandle(handle, token) {
  const slug = handle.toLowerCase();
  const url = `${API_BASE}/channels?slug=${encodeURIComponent(slug)}`;
  const startedAt = Date.now();
  const row = {
    handle,
    http_status: null,
    outcome: "error",
    is_live: null,
    title: null,
    viewer_count: null,
    room_id: null,
    category_name: null,
    thumbnail_url: null,
    error_kind: null,
    error_detail: null,
    duration_ms: 0,
  };

  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 10000);
    const res = await fetch(url, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/json",
      },
      signal: controller.signal,
    });
    clearTimeout(timer);
    row.http_status = res.status;
    const text = await res.text();

    if (res.status === 401 || res.status === 403) {
      row.outcome = "blocked";
      row.error_kind = res.status === 401 ? "unauthorized" : "forbidden";
      row.error_detail = text.slice(0, 200);
    } else if (res.status === 404) {
      row.outcome = "blocked";
      row.error_kind = "channel_not_found";
      row.error_detail = text.slice(0, 200);
    } else if (res.status === 429) {
      row.outcome = "blocked";
      row.error_kind = "rate_limit";
      row.error_detail = text.slice(0, 200);
    } else if (!res.ok) {
      row.outcome = "blocked";
      row.error_kind = res.status >= 500 ? "kick_5xx" : `http_${res.status}`;
      row.error_detail = text.slice(0, 200);
    } else {
      let body;
      try {
        body = JSON.parse(text);
      } catch {
        row.outcome = "blocked";
        row.error_kind = "non_json";
        row.error_detail = text.slice(0, 200);
        row.duration_ms = Date.now() - startedAt;
        return row;
      }
      const channel = Array.isArray(body?.data) ? body.data[0] : null;
      if (!channel) {
        row.outcome = "blocked";
        row.error_kind = "empty_data";
        row.error_detail = text.slice(0, 200);
      } else {
        const stream = channel.stream;
        const liveFlag =
          stream && typeof stream === "object" && stream.is_live === true;
        row.is_live = !!liveFlag;
        row.outcome = liveFlag ? "live" : "offline";
        if (liveFlag) {
          row.title =
            (typeof channel.stream_title === "string" && channel.stream_title) ||
            (typeof stream.title === "string" && stream.title) ||
            null;
          // category.name is Kick's equivalent of Twitch's game_name —
          // surface it so the brain can write it to live_sessions and
          // /s analytics can show "most-streamed-on" / game stats.
          row.category_name =
            (channel.category &&
              typeof channel.category === "object" &&
              typeof channel.category.name === "string" &&
              channel.category.name) ||
            null;
          row.viewer_count =
            typeof stream.viewer_count === "number" ? stream.viewer_count : null;
          // stream.thumbnail was added to the public v1 channels response
          // on 2025-04-07. Bare-URL on the stream object — not nested.
          row.thumbnail_url =
            (typeof stream.thumbnail === "string" && stream.thumbnail) || null;
          row.room_id =
            (stream.id != null && String(stream.id)) ||
            (stream.url != null && String(stream.url)) ||
            (channel.broadcaster_user_id != null
              ? String(channel.broadcaster_user_id)
              : null);
        }
      }
    }
  } catch (err) {
    row.outcome = "error";
    row.error_kind = err?.name === "AbortError" ? "timeout" : "network";
    row.error_detail = String(err?.message || err).slice(0, 300);
  }

  row.duration_ms = Date.now() - startedAt;
  return row;
}

async function main() {
  const startedAt = Date.now();

  const HANDLES = await fetchHandles();
  if (HANDLES.length === 0) {
    console.log("no kick targets tracked, exiting");
    return;
  }

  let token;
  try {
    token = await mintAccessToken();
  } catch (err) {
    const detail = String(err?.message || err).slice(0, 300);
    const results = HANDLES.map((handle) => ({
      handle,
      http_status: null,
      outcome: "error",
      is_live: null,
      title: null,
      viewer_count: null,
      room_id: null,
      thumbnail_url: null,
      error_kind: "token_mint_failed",
      error_detail: detail,
      duration_ms: 0,
    }));
    const counts = {
      total: results.length,
      ok: 0,
      live: 0,
      offline: 0,
      blocked: 0,
      error: results.length,
    };
    const payload = {
      source: "github-actions",
      duration_ms: Date.now() - startedAt,
      counts,
      results,
    };
    console.log(JSON.stringify({ counts, error: detail }, null, 2));
    const ingestRes = await fetch(INGEST_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${INGEST_SECRET}`,
      },
      body: JSON.stringify(payload),
    });
    if (!ingestRes.ok) {
      console.error(
        `Ingest failed: ${ingestRes.status} ${await ingestRes.text()}`
      );
    }
    process.exit(1);
  }

  const results = await Promise.all(HANDLES.map((h) => checkHandle(h, token)));

  const counts = results.reduce(
    (acc, r) => {
      acc.total++;
      if (r.outcome === "live") acc.live++;
      else if (r.outcome === "offline") acc.offline++;
      else if (r.outcome === "blocked") acc.blocked++;
      else acc.error++;
      if (r.outcome === "live" || r.outcome === "offline") acc.ok++;
      return acc;
    },
    { total: 0, ok: 0, live: 0, offline: 0, blocked: 0, error: 0 }
  );

  const payload = {
    source: "github-actions",
    duration_ms: Date.now() - startedAt,
    counts,
    results,
  };

  console.log(JSON.stringify({ counts, results }, null, 2));

  const ingestRes = await fetch(INGEST_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${INGEST_SECRET}`,
    },
    body: JSON.stringify(payload),
  });
  if (!ingestRes.ok) {
    console.error(
      `Ingest failed: ${ingestRes.status} ${await ingestRes.text()}`
    );
    process.exit(1);
  }
  console.log("ingest ok");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
