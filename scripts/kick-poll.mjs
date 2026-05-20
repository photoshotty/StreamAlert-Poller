// Kick Live detection poller.
//
// Calls Kick's unauthenticated public-ish JSON endpoint at
// /api/v2/channels/{slug}. The "livestream" field is null when the
// channel is offline, or an object with is_live, viewer_count,
// session_title, id, created_at, categories when live.
//
// Runs from GitHub Actions, POSTs results to /api/cron/kick-ingest.

const HANDLES = [
  // Expected live at the time of swap-in.
  "eesiii",
  "krischefgaming",
  "dmoneydlv",
  "jazdawgs",
  // Stream sometimes.
  "bootlegdeadpool",
];

const INGEST_URL = process.env.INGEST_URL;
const INGEST_SECRET = process.env.INGEST_SECRET;
if (!INGEST_URL) {
  console.error("INGEST_URL not set");
  process.exit(1);
}
if (!INGEST_SECRET) {
  console.error("INGEST_SECRET not set");
  process.exit(1);
}

// Kick is API-friendly — minimal headers needed, no signing or CAPTCHA.
// A real UA is still polite and avoids accidental WAF flags.
function headers() {
  return {
    "User-Agent":
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
      "(KHTML, like Gecko) Chrome/127.0.0.0 Safari/537.36",
    "Accept": "application/json, text/plain, */*",
    "Accept-Language": "en-US,en;q=0.9",
  };
}

async function checkHandle(handle) {
  const slug = handle.toLowerCase();
  const url = `https://kick.com/api/v2/channels/${encodeURIComponent(slug)}`;
  const startedAt = Date.now();
  const row = {
    handle,
    http_status: null,
    outcome: "error",
    is_live: null,
    title: null,
    viewer_count: null,
    room_id: null,
    error_kind: null,
    error_detail: null,
    duration_ms: 0,
  };

  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 10000);
    const res = await fetch(url, {
      method: "GET",
      headers: headers(),
      redirect: "follow",
      signal: controller.signal,
    });
    clearTimeout(timer);
    row.http_status = res.status;
    const text = await res.text();

    if (res.status === 404) {
      // Channel deleted / never existed — surface explicitly so the
      // dashboard can show the invalidation rather than misclassify.
      row.outcome = "blocked";
      row.error_kind = "channel_not_found";
      row.error_detail = text.slice(0, 200);
    } else if (!res.ok) {
      row.outcome = "blocked";
      row.error_kind =
        res.status === 403
          ? "forbidden"
          : res.status === 429
          ? "rate_limit"
          : res.status >= 500
          ? "kick_5xx"
          : `http_${res.status}`;
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
      // Kick may return a Cloudflare challenge wrapped in 200 — detect by
      // absence of the expected channel shape.
      if (!body || typeof body !== "object" || !("slug" in body)) {
        row.outcome = "blocked";
        row.error_kind = "unexpected_shape";
        row.error_detail = text.slice(0, 200);
      } else {
        const ls = body.livestream;
        if (!ls) {
          row.outcome = "offline";
          row.is_live = false;
        } else {
          row.outcome = "live";
          row.is_live = ls.is_live !== false;
          row.title = typeof ls.session_title === "string" ? ls.session_title : null;
          row.viewer_count =
            typeof ls.viewer_count === "number" ? ls.viewer_count : null;
          row.room_id = ls.id != null ? String(ls.id) : null;
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
  const results = await Promise.all(HANDLES.map(checkHandle));

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
