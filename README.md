# Client Dossier

A simple private dashboard for keeping a dossier on each of your clients: contact details,
a timeline of notes / follow-ups / calls / meetings, upcoming meetings, and a ledger of
deposits and withdrawals. Clients can be grouped by family. It runs as a single web page
(`index.html`) and stores its data in your own free [Supabase](https://supabase.com) project,
so **your data stays in your account**, not with anyone else.

## What's in this folder

| File | What it is | Do you edit it? |
|---|---|---|
| `index.html` | The whole dashboard | Yes, 3 lines near the top (step 4) |
| `schema.sql` | Creates the database table and locks it down | No, paste it into Supabase once (step 2) |
| `README.md` | These instructions | No |
| `LICENSE` | Terms for reusing this code | No |
| `whatsapp-sync/` | Optional add-on that fills the dashboard from exported WhatsApp chats | See its own README |

## Setup (about 15 minutes, no coding)

### 1. Create a Supabase project
Sign up at supabase.com and create a new project. Pick any name and a region near you.

### 2. Create the database table
In your project: **SQL Editor -> New query**, paste the entire contents of `schema.sql`, click **Run**.
It is safe to run more than once.

### 3. Create your login, and close sign-ups (important)
Anyone who can log in can see **all** clients, so only invite people you trust.
1. **Authentication -> Users -> Add user**, and create an email + password for yourself
   (tick "auto confirm" if offered).
2. **Authentication -> Sign In / Providers -> Email** and **turn off "Allow new users to sign up"**.
   If you skip this, a stranger could register their own account and read your client data.
   (Menu wording changes slightly as Supabase updates its dashboard.)

### 4. Point the dashboard at your project
In Supabase: **Project Settings -> API** and copy:
- the **Project URL**
- the **publishable** key (older projects call it the **anon** key)

Open `index.html` in any text editor (Notepad, TextEdit, VS Code) and fill in the three lines
under `SETUP`:
```js
const SUPABASE_URL = "https://your-project.supabase.co";
const SUPABASE_ANON_KEY = "your-publishable-key";
const BRAND_NAME = "Your Company Name";
```
**Never** paste the `secret` / `service_role` key into `index.html`. That key bypasses all
security and must stay private.

### 5. Try it
Double-click `index.html`. Sign in with the login from step 3. If you see "Setup needed",
step 4 isn't finished.

### 6. Put it online (optional, so you can use it from any device)
Any static host works, and all are free for this. Push the folder to a GitHub repository first
(see "How to upload" below if you haven't), then pick one:

**Vercel**
1. Go to vercel.com and sign up or log in — choose **"Continue with GitHub"** so the two are
   connected.
2. Click **Add New... -> Project** (top right of the dashboard).
3. Find this repository in the list and click **Import**.
4. On the configuration screen, leave **Root Directory** set to `./` (the default). Don't point
   it at `whatsapp-sync` — that folder is the separate sync tool, not the dashboard. Vercel should
   detect the **Framework Preset** as "Other", since this is a plain HTML page with no build step.
5. Click **Deploy**. Within a few seconds you'll get a live link like
   `https://your-project-name.vercel.app` — that's your dashboard, reachable from any device.
6. Any time you push a change to this repository afterward, Vercel redeploys automatically. You
   don't need to repeat these steps.

**GitHub Pages**
Repository **Settings -> Pages -> Deploy from a branch -> main / root**.

**Netlify**
**Add new site -> Import an existing project**, connect GitHub, pick this repository, and deploy
with the default settings (again, leave the base directory as the repository root, not
`whatsapp-sync`).

## Security notes
- The publishable key in `index.html` is meant to be visible in a browser. What actually
  protects your data is the login plus the rules in `schema.sql`. That is why step 3 matters.
- If you keep your filled-in copy on GitHub, make that repository **private**, or at least
  keep sign-ups closed.
- Do not put real client data in a public repository. The data lives in Supabase, not in these files.
- If you use the WhatsApp sync add-on, never upload its `.env`, `sync-state.json`, or anything in its
  `chats/` and `raw-exports/` folders. Keep the copy you run separate from the copy you publish.

## Optional: WhatsApp sync
The `whatsapp-sync/` folder is an add-on (iPhone and Android exports, Windows, Mac and Linux) that reads exported WhatsApp chats with your clients and
writes the important parts into the dashboard: timeline notes, follow-ups, meetings and Ledger
entries, and it can read payment screenshots too. Set up the dashboard first, then follow
`whatsapp-sync/README.md`. It needs Node.js and an Anthropic API key (pay-as-you-go), and it sends
chat text to Anthropic to be read, so make sure that suits your clients before using it on real chats.

## Data format (for developers)
`notes`: `[{id, date, type, title, content}]` with `type` one of `note`, `followup`, `meeting`, `call`.
`meetings`: `[{id, date, title, notes}]`. `transactions`: `[{id, date, amount, type, note}]`
with `type` one of `credit`, `debit`. Dates are `YYYY-MM-DD`.
