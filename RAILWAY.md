# Deploy on Railway

This app runs as a **long-running worker**: `npm start` launches `scheduler.js`, which triggers **Daily Call Report** + **Daily Lead Report** on a cron schedule (default **3:00 AM** in `TIMEZONE`).

## 1. Push the repo to GitHub

Ensure `.env` is **not** committed (it is listed in `.gitignore`).

## 2. Create a Railway project

1. [railway.app](https://railway.app) → **New Project** → **Deploy from GitHub repo** → select this repository.
2. Railway will detect Node via Nixpacks and use `railway.toml` / `npm start`.

## 3. Configure environment variables

In the service → **Variables**, add every key from your local `.env` (copy from `.env.example` as a checklist):

- Quo, OpenAI, email SMTP, Slack, Google Sheets OAuth, `GOOGLE_SHEETS_ID`, range/columns, etc.

**Scheduler (3 AM nightly):**

| Variable         | Example           | Meaning                                      |
|------------------|-------------------|----------------------------------------------|
| `CRON_SCHEDULE`  | `0 3 * * *`       | Minute hour — **03:00** each day             |
| `TIMEZONE`       | `America/Chicago` | “Yesterday” + when 3 AM fires                |

Cron uses **five fields**: `minute hour day-of-month month day-of-week`.  
`0 3 * * *` = 03:00 every day in `TIMEZONE`.

To run 3 AM **UTC** instead, set `TIMEZONE=UTC` (and adjust `CRON_SCHEDULE` if you still want local-firm “yesterday” — usually keep firm timezone for `TIMEZONE`).

## 4. Deploy

Trigger a deploy (or push to the connected branch). Watch **Deployments → Logs**:

- You should see `Quo Daily Report Scheduler`, schedule `0 3 * * *`, and hourly `Heartbeat — scheduler alive.`
- After 3 AM (in your `TIMEZONE`), logs should show the `[1/8]` … `[8/8]` report steps.

## 5. Costs & behavior

- The process stays **up 24/7** so `node-cron` can fire at 3 AM. Use a Railway plan that allows always-on workers.
- No public URL is required; this is not a web server.

## 6. One-off test

To run the report once without waiting for cron, use **Railway shell** or a one-off command:

```bash
node report.js
```

(Run with the same env vars as production.)

## 7. Google OAuth refresh token

`GOOGLE_REFRESH_TOKEN` must be generated once (e.g. `node setup-sheets-auth.js` on your machine) and pasted into Railway variables. It does not need to be regenerated on each deploy if unchanged.
