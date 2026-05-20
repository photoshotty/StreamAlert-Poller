# tiktok-poller

GitHub Actions worker that scrapes TikTok `/@user/live` pages from rotating
Azure runner IPs and POSTs results to a private StreamAlert deployment.

This repo is intentionally public so that GitHub Actions usage is free
(unlimited minutes on public repos vs. 2,000 min/month on private). The
sensitive bits — ingest URL, ingest secret, the dashboard, the database —
all live in a separate private repo and are accessed via encrypted
Actions secrets that are not visible to public viewers.

## How it runs

1. `cron-job.org` POSTs to the GitHub `workflow_dispatch` REST API every
   ~5 minutes.
2. GitHub Actions checks out this repo, runs `node scripts/tiktok-test-poll.mjs`.
3. The script fetches each handle's `/live` page in parallel, parses
   `SIGI_STATE` for live status / title / viewer count, classifies the
   outcome (`live` / `offline` / `blocked` / `error`), and POSTs the
   batch to the configured ingest URL.

## Required GitHub Actions secrets

Set under **Settings → Secrets and variables → Actions**:

| Name | Value |
| --- | --- |
| `INGEST_URL` | full URL of the StreamAlert ingest endpoint, e.g. `https://your-app.vercel.app/api/cron/tiktok-test-ingest` |
| `INGEST_SECRET` | bearer token; must match `CRON_SECRET` on the StreamAlert deployment |

## Changing the monitored handles

Edit the `HANDLES` array at the top of
[`scripts/tiktok-test-poll.mjs`](scripts/tiktok-test-poll.mjs) and push.
The next dispatch tick picks it up — no rebuild needed.
