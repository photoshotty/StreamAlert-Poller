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
  // /@handle/live can return three page shapes:
  //   1) Full watch page — has ytInitialPlayerResponse.videoDetails
  //      with isLive:true. This is what residential IPs get.
  //   2) Stripped pre-hydration SSR shell — YouTube serves this to
  //      suspected bot/datacenter IPs (GitHub Actions runners hit it
  //      every time). ytInitialPlayerResponse is reduced to a
  //      LOGIN_REQUIRED stub ("Sign in to confirm you're not a bot")
  //      and the <title> tag is empty, but ytInitialData (the
  //      watch-next response) is fully populated, including
  //      videoPrimaryInfoRenderer with the live title and a
  //      videoViewCountRenderer carrying isLive:true, plus a
  //      currentVideoEndpoint pointing at the loaded video.
  //   3) Channel-home page (offline) — no videoDetails, no
  //      currentVideoEndpoint, no isLive:true anywhere.
  //
  // The required signal across (1) and (2) is "isLive":true somewhere
  // on the page; that field doesn't appear on (3). The reliable
  // videoId anchor across (1) and (2) is currentVideoEndpoint —
  // emitted exactly once per page, points at the loaded video, never
  // appears for recommendations.
  if (!/"isLive":\s*true/.test(html)) {
    return { live: false, reason: "no_islive" };
  }

  // Prefer videoDetails when it's there — it's the canonical anchor
  // on the full page, and we want isLive:true scoped to that block
  // (not just any loose match) before trusting it.
  const vdIdx = html.indexOf('"videoDetails":{"videoId":');
  if (vdIdx !== -1) {
    const block = html.slice(vdIdx, vdIdx + 4000);
    if (/"isLive":\s*true/.test(block)) {
      const m = block.match(/"videoId":"([a-zA-Z0-9_-]{11})"/);
      if (m) return finalizeLiveState(html, m[1]);
    }
    // videoDetails exists but isn't the live broadcast — fall through
    // to the currentVideoEndpoint path. If that also fails we'll
    // declare offline.
  }

  // SSR-shell fallback: currentVideoEndpoint anchors the videoId even
  // when ytInitialPlayerResponse has been stripped to a stub.
  const cve = html.match(
    /"currentVideoEndpoint":[^]{0,500}?"videoId":"([a-zA-Z0-9_-]{11})"/
  );
  if (cve) return finalizeLiveState(html, cve[1]);

  return { live: false, reason: "no_anchor" };
}

function finalizeLiveState(html, videoId) {
  // Title — videoPrimaryInfoRenderer is the SSR-shell-friendly source
  // (works when the <title> tag is empty and videoDetails is absent).
  // Falls back to videoDetails.title, then the <title> tag.
  let title = null;
  const primary = html.match(
    /"videoPrimaryInfoRenderer":\{[^]{0,300}?"title":\{"runs":\[\{"text":"((?:[^"\\]|\\.){1,200})"/
  );
  if (primary) title = unescapeJsonString(primary[1]);
  if (!title) {
    const td = html.match(
      /"videoDetails":\{[^}]*?"title":"((?:[^"\\]|\\.){1,200})"/
    );
    if (td) title = unescapeJsonString(td[1]);
  }
  if (!title) {
    const t = html.match(/<title>([^<]+)<\/title>/);
    if (t) {
      let s = t[1].trim().replace(/\s*-\s*YouTube\s*$/i, "").trim();
      if (s) title = decodeEntities(s);
    }
  }

  // Viewer count — videoViewCountRenderer's first run is the live
  // concurrent count on both page shapes. Falls back to the raw
  // concurrentViewers field on the full page.
  let viewers = null;
  const vcr = html.match(
    /"videoViewCountRenderer":\{[^]{0,200}?"runs":\[\{"text":"([\d,]+)"/
  );
  if (vcr) {
    viewers = parseInt(vcr[1].replace(/,/g, ""), 10);
  } else {
    const cv = html.match(/"concurrentViewers":"(\d+)"/);
    if (cv) viewers = parseInt(cv[1], 10);
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

// Compact one-line dump of the live-state signals on the HTML the poller
// just fetched. Surfaced in row.error_detail when the page parsed as
// "offline" so we can tell whether YouTube served a degraded shape to
// the GitHub Actions IP (no ytInitialPlayerResponse, no videoDetails,
// channel-home title, etc.) without dumping the whole 1MB document.
function diagSummary(html, reason) {
  const titleMatch = html.match(/<title>([^<]+)<\/title>/);
  const title = titleMatch ? titleMatch[1].slice(0, 80) : "(no <title>)";
  const isLiveCount = (html.match(/"isLive":\s*true/g) || []).length;
  const isLiveNowCount = (html.match(/"isLiveNow":\s*true/g) || []).length;

  // Alternative anchors that may exist on the stripped pre-hydration
  // SSR shell YouTube hands datacenter IPs. The full page anchors on
  // "videoDetails":{"videoId":, but the shell doesn't — we expect at
  // least one of these to point at the live videoId.
  let canonical = null;
  const canon = html.match(
    /<link\s+rel="canonical"\s+href="([^"]+)"/i
  );
  if (canon) canonical = canon[1];
  let ogUrl = null;
  const og = html.match(
    /<meta\s+property="og:url"\s+content="([^"]+)"/i
  );
  if (og) ogUrl = og[1];
  // First "videoId":"<11chars>" anywhere on the page — useful only as a
  // sanity check, since which videoId comes first is unreliable.
  let firstVid = null;
  const fv = html.match(/"videoId":"([a-zA-Z0-9_-]{11})"/);
  if (fv) firstVid = fv[1];
  // All videoIds + counts. On the full-shape live page the live videoId
  // wins clearly (21 vs 13 vs 7s on l1wenFN local). If the SSR shell
  // preserves that ranking we have a stable fallback anchor; this probe
  // tells us.
  const allMatches = Array.from(
    html.matchAll(/"videoId":"([a-zA-Z0-9_-]{11})"/g)
  ).map((m) => m[1]);
  const idCounts = new Map();
  for (const id of allMatches) idCounts.set(id, (idCounts.get(id) || 0) + 1);
  const topFreq = Array.from(idCounts.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([id, n]) => `${id}=${n}`)
    .join(",");
  // 200-char window around the lone isLive:true so we can see the
  // surrounding JSON shape and find a stable anchor.
  let isLiveContext = null;
  if (isLiveCount > 0) {
    const idx = html.search(/"isLive":\s*true/);
    if (idx !== -1) {
      isLiveContext = html.slice(
        Math.max(0, idx - 100),
        Math.min(html.length, idx + 100)
      );
    }
  }

  return [
    `reason=${reason}`,
    `len=${html.length}`,
    `vd=${html.includes('"videoDetails":{"videoId":') ? 1 : 0}`,
    `isLive=${isLiveCount}`,
    `isLiveNow=${isLiveNowCount}`,
    `ypr=${html.includes("ytInitialPlayerResponse") ? 1 : 0}`,
    `yid=${html.includes("ytInitialData") ? 1 : 0}`,
    `title=${JSON.stringify(title)}`,
    `canonical=${JSON.stringify(canonical)}`,
    `og_url=${JSON.stringify(ogUrl)}`,
    `first_videoId=${JSON.stringify(firstVid)}`,
    `vid_freq=${topFreq}`,
    `unique_videoIds=${idCounts.size}`,
    `total_videoId_refs=${allMatches.length}`,
    `isLive_ctx=${JSON.stringify(isLiveContext)}`,
  ].join(" ");
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
        } else {
          // Diagnostic only — no behavior change. Helps tell whether
          // YouTube served us a degraded HTML shape that no longer has
          // the expected videoDetails anchor.
          row.error_detail = diagSummary(text, state.reason || "unknown");
          // If the page CARRIED an "isLive":true marker but we still
          // bailed (no videoDetails / no live in block), the page is the
          // stripped pre-hydration SSR shell — dump the whole HTML to
          // the github-actions log so we can inspect it directly and
          // pick a stable fallback anchor. Gated on isLive presence to
          // avoid spamming the log for genuinely-offline channels.
          if (/"isLive":\s*true/.test(text)) {
            console.log(`=== HTML DUMP for handle=${handle} (len=${text.length}) ===`);
            console.log(text);
            console.log(`=== END HTML DUMP for handle=${handle} ===`);
          }
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
