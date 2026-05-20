// YouTube Live detection poller.
//
// Scrapes the /@handle/live page for each handle. When the channel is live,
// YouTube serves the live watch page directly and the HTML contains
// "isLive":true / "isLiveContent":true markers inside ytInitialPlayerResponse
// (and a sibling ytInitialData blob). When offline, the URL redirects to the
// channel home page and those markers are absent.
//
// Per-platform rig — runs from GitHub Actions, POSTs results to the
// /api/cron/youtube-ingest endpoint on Vercel.

const HANDLES = [
  // Expected live at the time of swap-in.
  "Oatleyfn",
  "Smackojacko_",
  "RealBatdude",
  "R3HAN",
  // Stream sometimes.
  "HeyKyle",
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

// YouTube serves an HTML page where the live state lives in two embedded
// JSON blobs (ytInitialPlayerResponse and ytInitialData). We pull the
// indicator fields directly with regex rather than parsing the whole JSON,
// because the page is ~1MB and the structure varies.
function parseLiveState(html) {
  // Hard live indicators. Both have to be there to count as a live page;
  // the channel-home redirect doesn't include either.
  const isLive = /"isLive":\s*true/.test(html);
  const isLiveContent = /"isLiveContent":\s*true/.test(html);
  if (!isLive && !isLiveContent) {
    return { live: false };
  }

  // videoId of the current live broadcast — first occurrence is the
  // currently-playing video on the page.
  const vid = html.match(/"videoId":"([a-zA-Z0-9_-]{11})"/);
  const videoId = vid ? vid[1] : null;

  // Title — most reliable from the <title> tag, which YouTube sets to the
  // live stream's title (channel-home pages use "Channel Name - YouTube").
  let title = null;
  const titleTag = html.match(/<title>([^<]+)<\/title>/);
  if (titleTag) {
    let t = titleTag[1].trim();
    // Trim trailing " - YouTube" suffix.
    t = t.replace(/\s+-\s+YouTube\s*$/i, "");
    title = decodeEntities(t) || null;
  }
  // Fallback: shortDescription / videoDetails.title fields.
  if (!title) {
    const td = html.match(/"title":"((?:[^"\]|\.){1,150})"/);
    if (td) title = unescapeJsonString(td[1]);
  }

  // Concurrent viewers — gaming streams expose "concurrentViewers" as a
  // stringified number. Music/passive streams sometimes hide it entirely.
  let viewers = null;
  const cv = html.match(/"concurrentViewers":"(\d+)"/);
  if (cv) viewers = parseInt(cv[1], 10);
  if (viewers === null) {
    // Some pages render the count as JSON viewCount.runs.text "1,234 watching"
    const vc = html.match(/"viewCount":\{"runs":\[\{"text":"([\d,]+)"\}/);
    if (vc) viewers = parseInt(vc[1].replace(/,/g, ""), 10);
  }

  return {
    live: true,
    title,
    viewer_count: Number.isFinite(viewers) ? viewers : null,
    video_id: videoId,
  };
}

function decodeEntities(s) {
  return s
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}

function unescapeJsonString(s) {
  try {
    return JSON.parse(`"${s}"`);
  } catch {
    return s;
  }
}

// Recognise YouTube's bot-block / consent-wall patterns. CAPTCHA-class
// pages don't contain ytInitialPlayerResponse at all.
function looksBlocked(text) {
  if (/consent\.youtube\.com/i.test(text)) return "consent_wall";
  if (!/ytInitialPlayerResponse|ytInitialData/.test(text)) {
    return "no_yt_initial";
  }
  return null;
}

async function checkHandle(handle) {
  const url = `https://www.youtube.com/@${encodeURIComponent(handle)}/live`;
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

    if (!res.ok) {
      row.outcome = "blocked";
      row.error_kind =
        res.status === 403
          ? "forbidden"
          : res.status === 429
          ? "rate_limit"
          : res.status >= 500
          ? "youtube_5xx"
          : `http_${res.status}`;
      row.error_detail = text.slice(0, 200);
    } else {
      const blocked = looksBlocked(text);
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
          row.room_id = state.video_id;
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
