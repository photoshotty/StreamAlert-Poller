// Kick Live detection poller.
//
// Was originally calling Kick's unauthenticated /api/v2/channels/{slug}
// endpoint, which works fine from residential IPs but gets HTTP 403
// "Request blocked by security policy" from GitHub Actions datacenter
// IPs (Cloudflare WAF). The user-facing HTML page at /{slug} is not
// gated the same way, so we scrape that instead.
//
// Live channels emit "is_live":true and "session_title":"..." in the
// streamed RSC payload. Offline channels render the page but don't
// emit the livestream object — no "is_live" token anywhere.

const HANDLES = [
  "eesiii",
  "krischefgaming",
  "dmoneydlv",
  "jazdawgs",
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

function browserHeaders() {
  return {
    "User-Agent":
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
      "(KHTML, like Gecko) Chrome/127.0.0.0 Safari/537.36",
    "Accept":
      "text/html,application/xhtml+xml,application/xml;q=0.9," +
      "image/avif,image/webp,*/*;q=0.8",
    "Accept-Language": "en-US,en;q=0.9",
    "Accept-Encoding": "gzip, deflate, br",
    "Cache-Control": "no-cache",
    "Pragma": "no-cache",
    "Sec-Ch-Ua": '"Chromium";v="127", "Not)A;Brand";v="99"',
    "Sec-Ch-Ua-Mobile": "?0",
    "Sec-Ch-Ua-Platform": '"Windows"',
    "Sec-Fetch-Dest": "document",
    "Sec-Fetch-Mode": "navigate",
    "Sec-Fetch-Site": "none",
    "Sec-Fetch-User": "?1",
    "Upgrade-Insecure-Requests": "1",
  };
}

// The HTML page contains Next.js RSC streaming chunks. The livestream
// object surfaces as escaped JSON within those chunks. We extract by
// regex rather than full-JSON parse because the document is ~700KB and
// the wrapper format varies.
function parseLiveState(html) {
  const isLiveTrue = /"is_live":\s*true/.test(html);
  const isLiveFalse = /"is_live":\s*false/.test(html);
  // Absent means: channel rendered but no livestream object — i.e. offline.
  if (!isLiveTrue && !isLiveFalse) {
    return { live: false };
  }
  if (!isLiveTrue) {
    return { live: false };
  }

  // session_title comes immediately before is_live in the livestream blob.
  let title = null;
  const t = html.match(/"session_title":"((?:[^"]|\\")*?)","is_live":\s*true/);
  if (t) title = unescapeJsonString(t[1]);

  let viewers = null;
  const v = html.match(/"is_live":\s*true[^}]{0,500}"viewer_count":\s*(\d+)/);
  if (v) viewers = parseInt(v[1], 10);

  let roomId = null;
  const r = html.match(/"id":\s*(\d+)[^}]{0,500}"is_live":\s*true/);
  if (r) roomId = r[1];

  return {
    live: true,
    title,
    viewer_count: Number.isFinite(viewers) ? viewers : null,
    room_id: roomId,
  };
}

function unescapeJsonString(s) {
  return s.replace(/\\"/g, '"').replace(/\\/g, "\\");
}

// Recognise Cloudflare/WAF blocks even when status code is 200 (the WAF
// sometimes returns a challenge page with 200 instead of 403).
function looksBlocked(text, status) {
  if (status === 403 || status === 429) return null; // handled by status check
  if (/Request blocked by security policy/i.test(text)) return "waf_block";
  if (/cf-mitigated|cf_chl_opt|__cf_chl_jschl_tk/i.test(text)) return "cf_challenge";
  return null;
}

async function checkHandle(handle) {
  const slug = handle.toLowerCase();
  const url = `https://kick.com/${encodeURIComponent(slug)}`;
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
    const timer = setTimeout(() => controller.abort(), 15000);
    const res = await fetch(url, {
      method: "GET",
      headers: browserHeaders(),
      redirect: "follow",
      signal: controller.signal,
    });
    clearTimeout(timer);
    row.http_status = res.status;
    const text = await res.text();

    if (res.status === 404) {
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
      const blocked = looksBlocked(text, res.status);
      if (blocked) {
        row.outcome = "blocked";
        row.error_kind = blocked;
        row.error_detail = text.slice(0, 200);
      } else {
        const state = parseLiveState(text);
        row.is_live = state.live;
        row.outcome = state.live ? "live" : "offline";
        if (state.live) {
          row.title = state.title;
          row.viewer_count = state.viewer_count;
          row.room_id = state.room_id;
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
