# StreamAlert poller

GitHub Actions workers that observe whether the StreamAlert-tracked
streamers are currently live on Twitch / TikTok / YouTube / Kick, and
POST the results to the private StreamAlert deployment for processing.
DB writes and Telegram alerts happen on Vercel, not here.

This repo is intentionally public so that GitHub Actions usage is free
(unlimited minutes on public repos vs. 2,000 min/month on private). The
sensitive bits — ingest URLs, ingest secret, the dashboard, the database —
all live in a separate private repo and are accessed via encrypted
Actions secrets that are not visible to public viewers.

## Workflows

| Workflow | Cadence | Detection method |
| --- | --- | --- |
| `twitch-poll.yml`  | 1 min | Twitch Helix `/streams` batched (OAuth client_credentials) |
| `tiktok-poll.yml`  | 5 min | `tiktok.com/@user/live` HTML scrape, parses `SIGI_STATE` |
| `youtube-poll.yml` | 1 min | `youtube.com/@handle/live` HTML scrape, `"isLive":true` markers |
| `kick-poll.yml`    | 1 min | `api.kick.com/public/v1/channels?slug=…` (OAuth client_credentials) |

Each workflow is triggered externally by cron-job.org hitting the
`workflow_dispatch` REST API. GitHub Actions free-tier scheduled
workflows are too unreliable for these cadences.

## How it runs

1. `cron-job.org` POSTs to a workflow's dispatch endpoint (one cron-job
   entry per platform).
2. GitHub Actions checks out this repo and runs the platform's poll
   script.
3. The script GETs `/api/poll-targets/{platform}` on the StreamAlert
   deployment to learn which handles to observe (the live set of
   streamers tracked by at least one user).
4. The script fetches each handle's source page / API in parallel,
   normalises into `{ outcome, is_live, title, viewer_count, … }`, and
   POSTs the batch to the configured ingest URL.
5. The Vercel ingest route hands the batch to the shared brain
   (`processPollObservations`), which diffs against open sessions,
   sends / edits Telegram alerts, and refreshes the per-user digest.

## Required GitHub Actions secrets

Set under **Settings → Secrets and variables → Actions**:

| Name | Value |
| --- | --- |
| `TWITCH_INGEST_URL`   | `https://your-app.vercel.app/api/cron/twitch-ingest` |
| `INGEST_URL`          | `https://your-app.vercel.app/api/cron/tiktok-ingest` |
| `YOUTUBE_INGEST_URL`  | `https://your-app.vercel.app/api/cron/youtube-ingest` |
| `KICK_INGEST_URL`     | `https://your-app.vercel.app/api/cron/kick-ingest` |
| `INGEST_SECRET`       | bearer token shared across all four workflows; must match `CRON_SECRET` on the StreamAlert deployment |
| `TWITCH_CLIENT_ID`    | Twitch app client id |
| `TWITCH_CLIENT_SECRET`| Twitch app client secret |
| `KICK_CLIENT_ID`      | Kick OAuth client id (from kick.com/settings/developer) |
| `KICK_CLIENT_SECRET`  | Kick OAuth client secret |

## Changing the monitored set

The polled handle list is now driven by the user-tracked streamers on
the StreamAlert deployment. Add or remove streamers via the in-app
"Add streamer" flow; the next dispatch tick picks the change up.
