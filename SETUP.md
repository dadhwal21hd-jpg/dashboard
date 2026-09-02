# Setup guide

Follow these in order. Roughly 30–45 minutes the first time.

---

## 1. Prepare your Google Sheet

You said you'll create a sheet that uses `IMPORTRANGE` to pull from the master sheet. Here's what it needs:

1. Create a new Google Sheet (any Google account).
2. Name the first tab whatever you like — `Dispatch` or `Data` is fine. You can keep `Sheet1` too.
3. In row 1, set these header names exactly (or any of the accepted alternates from README.md):
   ```
   Style Number | Sub Cut Style | Qty | Order Sent To | Price | Customer Dispatch Date
   ```
4. In `A2`, paste your `IMPORTRANGE` formula. Example:
   ```
   =IMPORTRANGE("master-sheet-url-or-id", "MasterTab!A2:F")
   ```
5. Click the blue **Allow access** prompt that appears the first time.
6. Verify the data populates correctly.
7. Copy the sheet's ID from its URL. It's the long string between `/d/` and `/edit`:
   ```
   docs.google.com/spreadsheets/d/THIS_IS_THE_SHEET_ID/edit#gid=0
   ```
   Save it — you'll need it for `GOOGLE_SHEET_ID`.

---

## 2. Create a Google Cloud project

1. Go to <https://console.cloud.google.com>.
2. Top bar → project dropdown → **New project**.
3. Name it `kk-dashboard` (or anything). Click **Create**. Wait for it to provision.
4. Make sure the new project is selected in the dropdown.

---

## 3. Enable the Google Sheets API

1. In the Cloud Console, search bar → "Google Sheets API" → click the result.
2. Click **Enable**. Wait for confirmation.

---

## 4. Create a service account (for reading the sheet)

1. Left menu → **IAM & Admin** → **Service accounts**.
2. Click **+ Create service account** at the top.
3. **Service account name:** `kk-dashboard-reader`. Click **Create and continue**.
4. **Grant access** step: skip (click Continue with no role selected). Click **Done**.
5. You'll see your new service account in the list. Copy its email (looks like `kk-dashboard-reader@your-project.iam.gserviceaccount.com`). Save it — that's `GOOGLE_SERVICE_ACCOUNT_EMAIL`.
6. Click the service account row → **Keys** tab → **Add key** → **Create new key** → **JSON** → **Create**.
7. A JSON file downloads. Open it in a text editor.
8. Find the `"private_key"` field. The value (between the quotes, including `-----BEGIN PRIVATE KEY-----` and `-----END PRIVATE KEY-----\n`) is your `GOOGLE_SERVICE_ACCOUNT_KEY`.

**Important:** keep this JSON file safe. Anyone with it can read any sheet shared with the service account.

---

## 5. Share your sheet with the service account

1. Back in your Google Sheet (the one from step 1).
2. Click **Share** (top right).
3. Paste the service account email (from step 4.5).
4. Set permission to **Viewer**. Uncheck "Notify people".
5. Click **Share**.

The sheet is now readable by the service account.

---

## 6. Create OAuth credentials (for Sign in with Google)

1. Cloud Console → **APIs & Services** → **OAuth consent screen**.
2. **User Type:** **External**. Click **Create**.
3. Fill in:
   - **App name:** KK Dashboard
   - **User support email:** your email
   - **Developer contact:** your email
4. Click **Save and continue**.
5. **Scopes** step: just click **Save and continue**.
6. **Test users** step: click **+ Add users**. Add every email that will sign in (you, your boss, designers — same list as `ALLOWED_EMAILS`). Click **Save and continue**.
7. Now → **Credentials** in the left menu → **+ Create credentials** → **OAuth client ID**.
8. **Application type:** Web application.
9. **Name:** KK Dashboard.
10. **Authorised JavaScript origins:**
    - `http://localhost:3000` (for local dev)
    - `https://YOUR-VERCEL-DOMAIN.vercel.app` (add this after step 8 below)
11. **Authorised redirect URIs:**
    - `http://localhost:3000/api/auth/callback/google`
    - `https://YOUR-VERCEL-DOMAIN.vercel.app/api/auth/callback/google` (add later)
12. Click **Create**.
13. A dialog shows your **Client ID** and **Client secret**. Copy both:
    - `GOOGLE_CLIENT_ID` = the client ID
    - `GOOGLE_CLIENT_SECRET` = the client secret

---

## 7. Generate NEXTAUTH_SECRET

In a terminal:
```bash
openssl rand -base64 32
```

Copy the output. That's your `NEXTAUTH_SECRET`.

---

## 8. Run locally to verify

In the project folder:

```bash
npm install
cp .env.example .env.local
```

Open `.env.local` and fill in every value:

- `NEXTAUTH_SECRET` — from step 7
- `NEXTAUTH_URL` — leave as `http://localhost:3000`
- `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` — from step 6
- `ALLOWED_EMAILS` — comma-separated list of who can sign in
- `GOOGLE_SERVICE_ACCOUNT_EMAIL` — from step 4
- `GOOGLE_SERVICE_ACCOUNT_KEY` — paste the full private key value. **Keep the surrounding double quotes**, and keep the `\n` literal as-is.
- `GOOGLE_SHEET_ID` — from step 1
- `GOOGLE_SHEET_RANGE` — tab name (e.g. `Dispatch`) or leave as `Sheet1`

Then:

```bash
npm run dev
```

Visit <http://localhost:3000>. You should be redirected to `/login`. Sign in with Google. If your email is on the whitelist, you'll see the dashboard.

**Troubleshooting:**

- *"Access blocked: this app is not verified"* → click **Advanced** → **Go to KK Dashboard (unsafe)**. This is normal for unpublished OAuth apps. To remove the warning later, submit the app for verification — but for internal use, it's fine.
- *"Sheet is empty or range returned no values"* → check the sheet has data rows (not just headers), and the range is correct.
- *"Cannot find column for 'qty'"* → your sheet column names don't match. Check README.md for accepted alternates.
- *"unauthorized_client" or 401 from Sheets API* → the service account doesn't have access to the sheet. Re-share it (step 5).
- Private key errors → make sure you kept the `\n` characters literal (not turned into real line breaks) when pasting into `.env.local`.

---

## 9. Push to GitHub

From the project folder:

```bash
git init
git add .
git commit -m "Initial commit: KK Dashboard web app"
```

Create a private repo on GitHub, then:

```bash
git remote add origin git@github.com:YOUR-USERNAME/kk-dashboard.git
git branch -M main
git push -u origin main
```

---

## 10. Deploy to Vercel

1. Go to <https://vercel.com/new>.
2. Import the GitHub repo you just pushed.
3. **Framework Preset:** Next.js (auto-detected).
4. **Root directory:** leave as default (the repo root).
5. Expand **Environment Variables** and add every variable from `.env.local`:

   | Name | Value |
   |---|---|
   | `NEXTAUTH_SECRET` | (same value as local) |
   | `GOOGLE_CLIENT_ID` | (same) |
   | `GOOGLE_CLIENT_SECRET` | (same) |
   | `ALLOWED_EMAILS` | (same) |
   | `GOOGLE_SERVICE_ACCOUNT_EMAIL` | (same) |
   | `GOOGLE_SERVICE_ACCOUNT_KEY` | (same — keep `\n` as `\n`, no real line breaks) |
   | `GOOGLE_SHEET_ID` | (same) |
   | `GOOGLE_SHEET_RANGE` | (same, if you set one) |

   Do **NOT** set `NEXTAUTH_URL` — Vercel handles that automatically.

6. Click **Deploy**. Wait ~2 minutes.
7. You'll get a URL like `https://kk-dashboard-abc123.vercel.app`.

---

## 11. Add the Vercel URL to OAuth credentials

You set this up in step 6 but couldn't add the production URL yet.

1. Cloud Console → **APIs & Services** → **Credentials** → click your OAuth client.
2. Under **Authorised JavaScript origins**, add: `https://your-vercel-url.vercel.app`
3. Under **Authorised redirect URIs**, add: `https://your-vercel-url.vercel.app/api/auth/callback/google`
4. **Save**.

Now visit your Vercel URL, sign in, and the live dashboard loads.

---

## Design thumbnails (optional)

Shows the design image next to each style number, in the Style Numbers tab and
in the customer drill-downs. Clicking one opens a full-size viewer that browses
every image in that style's Drive folder.

Skip this section and everything works exactly as before — thumbnails simply
don't render.

### a. The mapping sheet

A spreadsheet (separate from the orders sheet) with one row per style:

| Style Number | Drive Folder Link |
|--------------|-------------------|
| 1234 | https://drive.google.com/drive/folders/1AbC… |
| 1235 | 1XyZ… |

- Header names are matched loosely — `Style No.`, `Folder`, `Drive Link`, `URL`
  and similar all work. If the headers aren't recognised, the first column is
  taken as the style and the first column that looks like a Drive link as the
  folder.
- The link cell accepts a full folder URL (`/folders/<id>`, `?id=<id>`) or a
  bare folder ID.
- Style numbers must match the orders sheet exactly (trimmed).

**Share this spreadsheet with the service-account email as Viewer**, same as in
step 5.

### b. Give the service account access to the designs

1. In Google Cloud Console → **APIs & Services → Library** → search
   **Google Drive API** → **Enable**. (Same project as the Sheets API.)
2. In Drive, right-click the **parent folder** that holds all the design
   folders → **Share** → paste the service-account email → **Viewer** → Send.
   Sharing the parent cascades to every subfolder, so you only do this once.

No sharing settings need to be loosened — the folders stay private. Images are
fetched server-side by the service account and streamed through
`/api/design`, which is gated by a signed, expiring token.

### c. Env vars

| Variable | Value |
|---|---|
| `GOOGLE_DESIGNS_SHEET_ID` | the mapping spreadsheet's ID (the long string between `/d/` and `/edit`) |
| `GOOGLE_DESIGNS_RANGE` | optional; tab name, defaults to `Sheet1` |

Add them to `.env.local` and to Vercel → Settings → Environment Variables, then
redeploy.

**If you're using a new service account for this**, it needs access to *both*
sheets and the design folders — either replace `GOOGLE_SERVICE_ACCOUNT_EMAIL` /
`GOOGLE_SERVICE_ACCOUNT_KEY` and re-share the orders sheet with it, or keep the
existing one and share the new material with that.

### d. Checking it works

Sign in, open the Style Numbers tab, expand a sub cut group. Styles present in
the mapping sheet show a thumbnail; unmapped ones show a hatched placeholder.
If every thumbnail is a placeholder, the usual causes are, in order:

1. `GOOGLE_DESIGNS_SHEET_ID` not set (or not redeployed) — no mapping at all.
2. Mapping sheet not shared with the service account.
3. Drive API not enabled, or the design folders not shared with it.
4. Style numbers formatted differently in the two sheets (e.g. `1234` vs `1234 `
   or `#1234`).

Vercel's function logs name the failing step — `Design map fetch failed` for
1–2, `Drive list failed for folder …` for 3.

---

## Adding or removing users later

Just update the `ALLOWED_EMAILS` env var:

- **Locally:** edit `.env.local` and restart `npm run dev`
- **On Vercel:** Settings → Environment Variables → edit `ALLOWED_EMAILS` → Save → Redeploy (Deployments tab → latest → Redeploy)

If the user has never signed in before, you also need to add their email under **OAuth consent screen → Test users** in Google Cloud (until you publish the app).

---

## Changing the cache TTL

In `src/lib/sheets.ts`, find:

```ts
const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes
```

Change to taste, commit, push — Vercel auto-redeploys.

---

## Monitoring

`https://your-app.vercel.app/api/health` returns `{ "status": "ok", "timestamp": "..." }`. Hook into UptimeRobot or similar.
