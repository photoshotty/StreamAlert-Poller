// YouTube Live detection poller.
//
// Triggered externally by cron-job.org hitting GitHub Actions
// workflow_dispatch. Fetches the live set of tracked YouTube handles
// from /api/poll-targets/youtube, scrapes /@handle/live for each, and
// POSTs the batch to /api/cron/youtube-ingest where the shared brain
// handles DB + Telegram side-effects.
//
// When the channel is live, YouTube serves the live watch page directly
// and the HTML contains "isLive":true / "isLiveContent":true markers.
// When offline, the URL redirects to the channel home page.

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

function pollTargetsUrl() {
  const u = new URL(INGEST_URL);
  return `${u.origin}/api/poll-targets/youtube`;
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

function parseLiveState(html) {
  // Everything anchors on the player's videoDetails block. /@handle/live
  // can return three shapes:
  //   1) the actual live watch page — videoDetails describes the live
  //      video and "isLive":true sits ~100 chars into the block.
  //   2) the channel home page — no videoDetails block at all, declare
  //      offline immediately.
  //   3) some other watch page (e.g. YouTube routing datacenter IPs to
  //      a popular trending stream) — videoDetails is present but for
  //      a different video. We have no way to know the channel's UC id
  //      from inside the poller, so we accept the videoDetails the page
  //      gives us; the upstream brain will not open the wrong session
  //      provided the channel's not actually live (since the misrouted
  //      page typically lacks isLive:true within the block).
  //
  // We do NOT trust loose "isLive":true / "isLiveNow":true matches.
  // The HTML often carries them in carousels of currently-live
  // recommendations on the channel-home shape, which were the cause of
  // the original false-positives.
  const idx = html.indexOf('"videoDetails":{"videoId":');
  if (idx === -1) return { live: false };
  const block = html.slice(idx, idx + 4000);
  if (!/"isLive":\s*true/.test(block)) return { live: false };
  const vidMatch = block.match(/"videoId":"([a-zA-Z0-9_-]{11})"/);
  if (!vidMatch) return { live: false };
  const videoId = vidMatch[1];

  // Title — from the <title> tag, which YouTube sets to the live stream's
  // title. Channel-home pages use "Channel Name - YouTube".
  let title = null;
  const titleTag = html.match(/<title>([^<]+)<\/title>/);
  if (titleTag) {
    let t = titleTag[1].trim();
    // Strip trailing " - YouTube" suffix. The regex allows zero whitespace
    // before/after the dash so an empty-title channel doesn't leave just
    // the suffix behind.
    t = t.replace(/\s*-\s*YouTube\s*$/i, "").trim();
    title = t || null;
    if (title) title = decodeEntities(title);
  }
  if (!title) {
    // Prefer videoDetails.title since the loose match could pull a
    // recommendation's title from sidebars / suggested videos.
    const td = html.match(
      /"videoDetails":\{[^}]*?"title":"((?:[^"\\]|\\.){1,200})"/
    );
    if (td) title = unescapeJsonString(td[1]);
  }

  let viewers = null;
  const cv = html.match(/"concurrentViewers":"(\d+)"/);
  if (cv) viewers = parseInt(cv[1], 10);
  if (viewers === null) {
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

  const HANDLES = await fetchHandles();
  if (HANDLES.length === 0) {
    console.log("no youtube targets tracked, exiting");
    return;
  }

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
