# StreamAlert poller

GitHub Actions workers that observe whether the configured streamers are
currently live on TikTok / YouTube / Kick, and POST the results to the
private StreamAlert deployment for processing (DB writes + Telegram
alerts happen on Vercel, not here).

This repo is intentionally public so that GitHub Actions usage is free
(unlimited minutes on public repos vs. 2,000 min/month on private). The
sensitive bits — ingest URLs, ingest secret, the dashboard, the database —
all live in a separate private repo and are accessed via encrypted
Actions secrets that are not visible to public viewers.

## Workflows

| Workflow | Source | Detection method |
| --- | --- | --- |
| `tiktok-poll.yml` | `tiktok.com/@user/live` | HTML scrape, parses `SIGI_STATE.LiveRoom.liveRoomUserInfo.user.status` |
| `youtube-poll.yml` | `youtube.com/@handle/live` | HTML scrape, looks for `"isLive":true` in `ytInitialPlayerResponse` |
| `kick-poll.yml` | `kick.com/api/v2/channels/{slug}` | Unauthenticated JSON API, reads `livestream` field |

Each workflow is triggered externally by cron-job.org hitting the
`workflow_dispatch` REST API at roughly 5-minute cadence.

## How it runs

1. `cron-job.org` POSTs to a workflow's dispatch endpoint (one cron-job
   entry per platform).
2. GitHub Actions checks out this repo, runs the platform's poll script.
3. The script fetches each handle's source page in parallel, normalises
   the result into `{ outcome, is_live, title, viewer_count, room_id, ... }`,
   and POSTs the batch to the configured ingest URL.

## Required GitHub Actions secrets

Set under **Settings → Secrets and variables → Actions**:

| Name | Value |
| --- | --- |
| `INGEST_URL` | TikTok ingest URL: `https://your-app.vercel.app/api/cron/tiktok-ingest` |
| `YOUTUBE_INGEST_URL` | YouTube ingest URL: `https://your-app.vercel.app/api/cron/youtube-ingest` |
| `KICK_INGEST_URL` | Kick ingest URL: `https://your-app.vercel.app/api/cron/kick-ingest` |
| `INGEST_SECRET` | bearer token shared across all three workflows; must match `CRON_SECRET` on the StreamAlert deployment |

## Changing the monitored handles

Edit the `HANDLES` array at the top of the relevant
[`scripts/*.mjs`](scripts/) file and push. The next dispatch tick picks
it up — no rebuild needed.
