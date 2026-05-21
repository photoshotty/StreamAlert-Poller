// TikTok Live detection poller.
//
// Triggered externally by cron-job.org hitting GitHub Actions
// workflow_dispatch every ~5 minutes. Fetches the live set of tracked
// TikTok handles from /api/poll-targets/tiktok on the StreamAlert
// deployment, scrapes each handle's /live page, classifies as
// live/offline/blocked/error, and POSTs the run to
// /api/cron/tiktok-ingest where the shared brain handles DB writes and
// Telegram alerts.

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
  return `${u.origin}/api/poll-targets/tiktok`;
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

// Browser-shaped headers. Unauthenticated TikTok requests with a bare
// node-fetch / curl UA get challenge-walled almost immediately.
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

// TikTok hydrates the live page from the <script id="SIGI_STATE"> blob.
// Empirically (May 2026): user.status === 2 means live, === 4 means offline.
function extractSigiState(html) {
  const m = html.match(
    /<script[^>]+id="SIGI_STATE"[^>]*>([\s\S]*?)<\/script>/
  );
  if (!m) return null;
  try {
    return JSON.parse(m[1]);
  } catch {
    return null;
  }
}

function parseLiveState(html) {
  const sigi = extractSigiState(html);
  if (!sigi) return null;
  const u = sigi?.LiveRoom?.liveRoomUserInfo;
  if (!u) return null;
  const status = u?.user?.status ?? u?.liveRoom?.status ?? null;
  if (status === null) return null;
  return {
    live: status === 2,
    status,
    title: u?.liveRoom?.title ?? null,
    viewer_count: u?.liveRoom?.liveRoomStats?.userCount ?? null,
    room_id:
      (u?.user?.roomId != null ? String(u.user.roomId) : null) ??
      (u?.liveRoom?.id != null ? String(u.liveRoom.id) : null),
    // liveRoom.coverUrl is the streamer avatar; the actual live frame
    // snapshot is at liveRoom.squareCoverImg (webcast-oci-tx CDN). It's
    // a square JPEG that TikTok rotates server-side every ~minute.
    // squareCoverImg is "" for PC / LIVE-Studio streams whose snapshot
    // has not been generated server-side yet. Coerce to null so we
    // do not store junk; a later refresh tick will pick up a real URL
    // if TikTok ever produces one.
    thumbnail_url:
      typeof u?.liveRoom?.squareCoverImg === "string" &&
      u.liveRoom.squareCoverImg !== ""
        ? u.liveRoom.squareCoverImg
        : null,
  };
}

function looksLikeChallenge(text) {
  return (
    /captcha-verify-container/i.test(text) ||
    /tt-captcha/i.test(text) ||
    /Please verify to continue/i.test(text) ||
    /<title>[^<]*Verify[^<]*<\/title>/i.test(text)
  );
}

async function checkHandle(handle) {
  const url = `https://www.tiktok.com/@${encodeURIComponent(handle)}/live`;
  const startedAt = Date.now();
  const row = {
    handle,
    http_status: null,
    outcome: "error",
    is_live: null,
    title: null,
    viewer_count: null,
    room_id: null,
    thumbnail_url: null,
    error_kind: null,
    error_detail: null,
    duration_ms: 0,
  };

  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 12000);
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
          ? "tiktok_5xx"
          : `http_${res.status}`;
      row.error_detail = text.slice(0, 200);
    } else if (looksLikeChallenge(text)) {
      row.outcome = "blocked";
      row.error_kind = "captcha";
    } else {
      const state = parseLiveState(text);
      if (!state) {
        row.outcome = "blocked";
        row.error_kind = "no_sigi_state";
        row.error_detail = text.slice(0, 200);
      } else {
        row.is_live = state.live;
        row.outcome = state.live ? "live" : "offline";
        row.title = state.title;
        row.viewer_count = state.viewer_count;
        row.room_id = state.room_id;
        row.thumbnail_url = state.live ? state.thumbnail_url : null;
        if (!state.live && state.status !== 4) {
          row.error_kind = `status_${state.status}`;
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
    console.log("no tiktok targets tracked, exiting");
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
