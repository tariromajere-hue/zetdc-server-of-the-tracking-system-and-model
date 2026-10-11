# Daily summary server job

Sends the Smart Meter Programme daily summary to the manager every morning at
**06:00 Harare time** (04:00 UTC) by **email** and **WhatsApp**. It covers failed
checks and overdue meters by depot, plus department batches held past the 7-day limit.
The content is the same as the in-app "Daily summary".

```
server-job/
  api/daily-digest.js   the job
  data/                 hes-data.js + tracking-data.js (same data as the app)
  vercel.json           cron schedule: "0 4 * * *"
  package.json
```

## 1. Deploy (about 5 minutes)
1. Create a free GitHub repo and upload the **contents** of this `server-job` folder.
2. On vercel.com, go to **Add New → Project**, import that repo, and click **Deploy**.
3. Open `https://<your-project>.vercel.app/api/daily-digest?preview=1`. You should see
   today's summary text. Nothing has been sent yet.

## 2. Settings (Vercel → Project → Settings → Environment Variables)

| Name | Example | Needed |
|---|---|---|
| `CRON_SECRET` | any long random text | yes. Vercel uses it to call the job |
| `MANAGER_EMAIL` | manager@zesa.co.zw (comma-separate several) | for email |
| `MANAGER_WHATSAPP` | 263771234567 (country code, no +) | for WhatsApp |
| `APP_URL` | your Smart Meter Programme Vercel link | optional, adds an "Open the dashboard" link |

**Email: choose one**
- **Gmail (easiest):** `SMTP_USER` = your Gmail address, `SMTP_PASS` = a Gmail **App
  Password** (Google Account → Security → 2-Step Verification → App passwords).
- **Resend:** `RESEND_API_KEY` (and `RESEND_FROM` once you verify a domain).

**WhatsApp: choose one**
- **CallMeBot (free, personal number):** from the manager's phone, send
  `I allow callmebot to send me messages` on WhatsApp to the number listed on
  callmebot.com. You receive an API key; set `CALLMEBOT_APIKEY`.
- **Twilio (business):** `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_WHATSAPP_FROM`
  (sandbox default `whatsapp:+14155238886`; the manager must first send the sandbox join code).

After adding variables, click **Redeploy**.

## 3. Test it now
Vercel → Project → **Settings → Cron Jobs → Run** (or run the command below from any terminal):
```
curl -H "Authorization: Bearer <CRON_SECRET>" https://<your-project>.vercel.app/api/daily-digest
```
The reply lists what was sent, e.g. `["email sent to … via SMTP", "WhatsApp sent to +263… via CallMeBot"]`.
Logs are under **Vercel → Project → Logs**.

## Change the time
Edit `schedule` in `vercel.json` (UTC, cron format). Harare is UTC+2, so `0 4 * * *` = 06:00.
The free Hobby plan allows one run per day.

## Limits
- The job reads the data files in `data/` **plus** the live activity the app shares (scans, warning-list
  meters, owner fixes and tracker handovers from any phone or PC). The free relay keeps that activity for about 12 hours,
  so the 06:00 summary covers the base data plus what was done since about 18:00 the evening before.
  When the base data changes, replace the two files in `data/` and redeploy.
- All records are simulated test data (TEST identifiers).
