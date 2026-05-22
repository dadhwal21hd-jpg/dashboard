# KK Design Intelligence — Web App

Full-stack Next.js port of the original Python/HTML dashboard.

- **Auth:** Sign in with Google + email whitelist
- **Data:** Live read from a Google Sheet via service account
- **Dashboard:** byte-identical to the original `dashboard_template.html` (data injected server-side)
- **Caching:** 5-minute server-side cache + manual refresh
- **Deploy target:** Vercel

---

## Local development

```bash
npm install
cp .env.example .env.local
# edit .env.local with your secrets (see SETUP.md)
npm run dev
```

Open http://localhost:3000

---

## Project layout

```
src/
├── app/
│   ├── api/
│   │   ├── auth/[...nextauth]/route.ts   NextAuth handler
│   │   ├── dashboard/route.ts            Sheet fetch + processor + HTML inject
│   │   └── health/route.ts               uptime check
│   ├── dashboard/page.tsx                protected viewer (iframe + controls)
│   ├── login/page.tsx                    Google sign-in
│   ├── denied/page.tsx                   shown when email not whitelisted
│   ├── layout.tsx
│   ├── page.tsx                          redirects to /dashboard or /login
│   └── providers.tsx                     <SessionProvider>
├── lib/
│   ├── auth.ts                           NextAuth options (Google + whitelist)
│   ├── sheets.ts                         Google Sheets fetcher + cache
│   ├── processor.ts                      TS port of process_csv.py (verified identical)
│   └── types.ts                          shared types
└── middleware.ts                         edge-level /dashboard auth gate
public/
└── dashboard_template.html               original template, byte-identical
```

---

## Env vars

| Variable | What it is |
|---|---|
| NEXTAUTH_SECRET | Random string for signing session cookies. `openssl rand -base64 32` |
| NEXTAUTH_URL | Base URL. Vercel sets this automatically in production. |
| GOOGLE_CLIENT_ID | OAuth client ID from Google Cloud Console |
| GOOGLE_CLIENT_SECRET | OAuth client secret |
| ALLOWED_EMAILS | Comma-separated allow-list |
| GOOGLE_SERVICE_ACCOUNT_EMAIL | Service account email |
| GOOGLE_SERVICE_ACCOUNT_KEY | Private key from the JSON keyfile |
| GOOGLE_SHEET_ID | Long ID in your sheet's URL |
| GOOGLE_SHEET_RANGE | *(optional)* Tab name or A1 range. Default: Sheet1 |

See **SETUP.md** for step-by-step instructions.

---

## Required Sheet columns

Auto-detected, case-insensitive:

| Column | Alternate names |
|---|---|
| Style Number | style_number, style no, style |
| Sub Cut Style | sub_cut_style, subcut, cut style, sub cut |
| Qty | quantity, units |
| Order Sent To | customer, order_sent_to, party |
| Price | mrp, rate |
| Customer Dispatch Date | dispatch date, date, dispatch_date |

Date formats accepted: DD/MM/YYYY, DD-MM-YYYY, YYYY-MM-DD.
Extra columns are ignored.

---

## Routes

| Route | Purpose | Auth required |
|---|---|---|
| / | Redirects based on session | — |
| /login | Google sign-in | — |
| /denied | Non-whitelisted users | — |
| /dashboard | The actual dashboard | ✓ |
| /api/dashboard | HTML with injected data. `?refresh=1` bypasses cache | ✓ |
| /api/health | Uptime check | — |
| /api/auth/* | NextAuth handlers | — |

---

## Production build

```bash
npm run build
npm run start
```

Same command Vercel runs.
