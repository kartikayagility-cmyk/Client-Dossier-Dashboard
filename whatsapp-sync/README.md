# WhatsApp Sync (add-on for Client Dossier)

Reads exported WhatsApp chats with your clients, uses Claude to pick out what actually matters,
and writes it into your Client Dossier dashboard:

- **Notes, follow-ups, calls and meetings** go into each client's timeline, with the real date
  each thing happened.
- **Confirmed money movements** ("sent 1.5L", "funds received, thank you") go into the Ledger.
- **Scheduled meetings** with a real date go into Upcoming Meetings.
- Optionally, **payment screenshots** are read too, so a transfer that only exists as a photo
  still reaches the Ledger.

**Works with exports from iPhone and Android, and runs on Windows, Mac and Linux.**
It only ever adds entries. It never edits or deletes anything already on your dashboard.

> This is an add-on. Set up the dashboard first (see the README one folder up), including
> running `schema.sql`. This tool needs that table.

## Where everything goes

```
whatsapp-sync/                  <- open your terminal in THIS folder for every command below
  sync.js                        <- the main script (no need to edit)
  describe_images.py             <- optional: reads payment screenshots (no need to edit)
  test-connection.js             <- optional: checks your keys work (see Troubleshooting)
  package.json                   <- lists the two libraries to install
  .env.example                   <- template; you copy it to .env (step 4 of setup)
  .env                           <- YOU create this. Your private keys. Never upload it.
  sync-state.json                <- created automatically on the first run. Don't delete it.

  chats/                         <- PUT plain text exports here (no screenshots this week)
    Smith Family.txt               file name = that client's "WhatsApp Group" on the dashboard

  raw-exports/                   <- PUT "with media" exports here, only for chats with screenshots
    Smith Family/                  one folder per client, named like their WhatsApp Group
      WhatsApp Chat with ....txt   the exported chat, straight in this folder (any name works)
      images/                      ONLY the payment screenshots. Never ID documents or forms.
```

**Two ways to run it:**
- No screenshots this week: put the `.txt` in `chats/`, then run `npm run sync`.
- Screenshots this week: build the `raw-exports/` layout above, then run the screenshot command
  (`python3 describe_images.py --batch raw-exports` on Mac/Linux, `py describe_images.py --batch raw-exports`
  on Windows). It syncs by itself at the end.

## What you need

- **Node.js 18 or newer** from nodejs.org (the LTS version)
- **Python 3**, only if you want the screenshot step. Nothing extra to install for it.
- A **Supabase project** with the dashboard's `schema.sql` already run
- An **Anthropic API key** from console.anthropic.com. This is separate from a Claude.ai
  subscription and is pay-as-you-go, so add a small amount of credit first.

## Commands: Mac/Linux vs Windows

Every command in this README is written for Mac/Linux. On Windows, use **Command Prompt** (see
"Troubleshooting" if PowerShell gives you trouble) and these equivalents:

| What you want | Mac / Linux | Windows |
|---|---|---|
| Open a terminal in the folder | Type `cd ` in Terminal, drag the folder onto the window, press Enter | Open the folder in File Explorer, click the address bar, type `cmd`, press Enter |
| Go to a folder by typing | `cd "/Users/you/Desktop/whatsapp-sync"` | `cd "C:\Users\you\Desktop\whatsapp-sync"` (on another drive: `cd /d "D:\whatsapp-sync"`) |
| List the files here | `ls` | `dir` |
| Copy the key template | `cp .env.example .env` | `copy .env.example .env` |
| Edit your keys | Open `.env` in TextEdit or VS Code | `notepad .env` |
| Install the libraries | `npm install` | `npm install` |
| Run the sync | `npm run sync` | `npm run sync` |
| Run the screenshot step | `python3 describe_images.py --batch raw-exports` | `py describe_images.py --batch raw-exports` (or `python`) |
| Check your keys work | `node test-connection.js` | `node test-connection.js` |

Always put a path in quotes if it contains spaces.

## One-time setup

1. **Install Node.js** (and Python if you'll use screenshots). On Windows, install Python from
   python.org and tick **"Add python.exe to PATH"** on the first installer screen. After installing
   anything, **close your terminal and open a new one**, or the new commands won't be found.
2. **Open a terminal inside this `whatsapp-sync` folder** (first row of the table above).
   Check you're in the right place with `ls` (Mac/Linux) or `dir` (Windows). You should see `sync.js`.
3. **Install the two libraries:** `npm install`
4. **Create your `.env` file** (keys table above), then fill in three values:
   - `SUPABASE_URL`: Supabase -> Project Settings -> API -> Project URL
   - `SUPABASE_SERVICE_ROLE_KEY`: on the same page, the **secret** key, not the publishable one.
     The legacy `service_role` key (starts with `eyJ`) is the one this was tested with.
   - `ANTHROPIC_API_KEY`: console.anthropic.com -> API Keys

   Save the file. **Windows:** `notepad .env` opens the file you just copied, and pressing
   Ctrl+S keeps its name. Don't create it through Notepad's "Save As", which tends to add `.txt`
   and gives you `.env.txt`. **Mac:** files starting with a dot are hidden in Finder;
   press `Cmd + Shift + .` to show them.
5. **On the dashboard, fill in each client's "WhatsApp Group" field** with the name of their
   WhatsApp chat. This is how an exported file finds the right client. Use letters, numbers and
   spaces. Names containing `/ \ : * ? " < > |` can't be used in file names, so for a group like
   that, type a simplified name in this field and use the same simplified name for the file.
6. **For families that share one group, mark one person as the Primary Contact:** set their
   **Relation** field to exactly `Primary Contact` (see "Families" below).

## Getting a chat out of WhatsApp

Do this on your phone. WhatsApp's export only exists in the phone apps.

**Android**
1. Open the chat -> tap the three dots -> **More** -> **Export chat**.
2. Choose **Without media** (a single `.txt`) or **Include media** (the `.txt` plus recent photos
   and files).
3. In the share sheet pick somewhere you can reach from your computer: Gmail (send it to
   yourself), Google Drive, or Quick Share.
4. The text file is usually called `WhatsApp Chat with <name>.txt`. With media, some phones send
   the files separately and others bundle them into one `.zip`. Unzip it if so.

**iPhone**
1. Open the chat -> tap the contact or group name at the top -> **Export Chat**.
2. Choose **Without Media** or **Attach Media**.
3. In the share sheet pick Mail (send it to yourself), AirDrop (Mac), or Save to Files/iCloud Drive.
4. It arrives as a **`.zip`** containing **`_chat.txt`**, even without media. Unzip it
   (Windows: right-click the zip -> **Extract All**) and use `_chat.txt`.

**Two things WhatsApp does to every export**
- It only includes roughly the **latest 40,000 messages without media, or 10,000 with media**.
  Older messages are left out. For the first import of a very long chat, export **Without
  media** to reach further back. After that, weekly exports are far shorter than these limits.
- The file is **plain, unencrypted text** of your client's messages. Delete it from your email,
  cloud drive and phone once you've used it.

**Check the date format.** Open the `.txt` and look at the first line. This tool needs
**day-first** dates:

| You'll see | Phone | Works? |
|---|---|---|
| `[28/05/26, 3:12:56 PM] Name: hello` | iPhone | Yes |
| `[28/05/2026, 15:12:56] Name: hello` | iPhone, 24-hour clock | Yes |
| `28/05/26, 3:12 pm - Name: hello` | Android | Yes |
| `28/05/2026, 15:12 - Name: hello` | Android, 24-hour clock | Yes |
| `28.05.2026, 15:12 - Name: hello` | Android, dotted dates | Yes |
| `05/28/26, 3:12 PM - Name: hello` | Month-first (US region) | No: the tool tells you and skips it |
| `2026/05/28, 10:04 pm - Name: hello` | Year-first | No |

The export follows your phone's regional settings, so if yours is month-first, set the phone's
region to a country that writes dates day-first (for example India or the United Kingdom), then
export again. That usually fixes it. (Settings, then search for "Region".)

## Weekly routine

**Chats without screenshots**
1. Export the chat **without media** (see above) and get the `.txt` onto your computer.
2. Rename it to exactly match the client's WhatsApp Group, for example `Smith Family.txt`, and put
   it in `chats/`.
3. Run `npm run sync`. The terminal lists who was updated and warns about any file that didn't
   match a client.

**On Windows, turn on file extensions first.** In File Explorer: **View -> Show -> File name
extensions**. Otherwise Windows hides `.txt`, and renaming "Smith Family.txt" quietly gives you
`Smith Family.txt.txt`. (The tool copes with that double extension and with `.TXT`, but seeing
real file names avoids confusion.)

**Chats with payment screenshots**
1. Export the chat **with media** and unzip it if it came as a zip.
2. Make a folder inside `raw-exports/` named exactly like the client's WhatsApp Group. Put the
   chat `.txt` directly inside it, whatever it's called (`_chat.txt`, `WhatsApp Chat with ....txt`).
   Create an `images` folder next to it.
3. Copy **only the payment screenshots** into `images/`. Keep WhatsApp's own file names (`IMG-...`
   on Android, `...PHOTO-....jpg` on iPhone). Never rename them: the chat text refers to each
   image by its name.
4. Run the screenshot command from the table above. It describes each screenshot, writes the
   result into `chats/`, and then runs the sync for everything in `chats/`.

You can mix both in one week: put the plain `.txt` files in `chats/` first, then run the
screenshot command. It syncs everything in `chats/`.

Every export contains the client's *whole* history (up to WhatsApp's limit), and that is fine.
See "It only reads what's new" below.

## How it behaves

**It only reads what's new.** `sync-state.json` remembers the date of the last message processed
for each client. Each run sends only newer messages to Claude, so cost stays flat as chats grow
and nothing is added twice. If you delete that file, every client is treated as brand new and
their whole history is processed again.

**A first run on a long history is split into months** and processed one month at a time, saving
progress after each. If it's interrupted, run it again and it resumes where it stopped.

**Families.** If several clients share one WhatsApp Group, an update that names one person goes
to that person only. Anything general or unclear goes to the one client whose Relation is
`Primary Contact`, so it isn't copied to everyone. If nobody in that family is marked, those
updates are skipped and the terminal names the family so nothing disappears silently.

**Ledger.** Only confirmed amounts with a clear direction are added. Typed confirmations count,
and so does a plain message like "sent 1.5". A "sent" message and a later "received" message about
the same transfer become one entry. A vague "I'll transfer some soon" is ignored.

**Handwritten bank slips are flagged, not trusted.** If a screenshot looks like a handwritten
counter slip, the ledger entry gets `⚠️ Handwritten slip, verify amount` at the start of its note.

**Languages.** Chats can be in English, Hindi written in Roman letters, or a mix. Notes are
always written back in English.

**What gets left out on purpose**, to keep the timeline useful:
- The account-opening / onboarding process: documents or details requested or shared, KYC,
  photo or video verification, account details or logins shared, and the account being opened
- OTP exchanges
- Logins and links for portfolio-tracking apps
- Bare acknowledgments ("ok", "thanks", "👍")
- Scheduling chatter that never reaches a confirmed date

## Making it fit your business

The skip list above was written for one advisory firm, so yours may differ. Open `sync.js`, find
the paragraph that starts **"Be selective"**, and edit the bullet list in plain English. It is
an instruction to Claude, not code, so there is nothing to compile. The paragraph also mentions
one specific portfolio app by name; swap in whatever you use.
Changes only affect messages processed from then on.

## Cost and privacy

- **Cost:** you pay Anthropic per use. For plain-text chats it is typically cents per client per
  week. Screenshots cost a fraction of a cent each. Check current pricing on
  anthropic.com/pricing and watch your balance in the Anthropic console.
- **Privacy:** the text of each new chat is sent to Anthropic's API to be read, and so is every
  screenshot you put in an `images` folder. Nothing else is sent. Make sure your clients and your
  local rules are fine with that before you use it on real conversations.
- **Screenshots:** only images you place in `images/` are ever read. Keep ID documents, forms
  and statements out of that folder.
- **Your data stays yours:** entries are written to your own Supabase project.

## Known limits

- **Dates must be day-first**, in the layouts listed above. Month-first and year-first exports
  aren't read. Layouts with month names (`28-May-26`) aren't supported either.
- **Currency.** Amounts are read as rupees, and shorthand like `8L`/`1.5 Lakh`/`Cr` is converted
  to plain numbers. For another currency, edit the `"amount"` instruction inside `sync.js`.
- **Only images are read**, not PDFs, voice notes or videos. On Android, media that wasn't
  included shows as `<Media omitted>`, and on iPhone as `image omitted`. Either way, a screenshot
  can only be read if you exported with media.
- **How well this is tested.** The tool has been used on real iPhone exports. Every Android and
  Windows layout in the table above was tested by converting real chats into that layout, including
  Windows line endings, a leading BOM and the unusual space characters newer phones put before
  am/pm, and the full sync was run end to end against a simulated database. It has **not** yet
  been run against an export taken from a real Android phone or on a real Windows PC. If your
  export isn't read, please report the first line of the file (with the names removed).

## Troubleshooting

- **`No dated messages found`:** the file isn't in one of the layouts above. Check the first
  line against the date-format table.
- **The tool says the export is month-first:** see "Check the date format" above.
- **Windows: `running scripts is disabled on this system`** when you type `npm`. This is
  PowerShell's security setting. Use **Command Prompt** instead (File Explorer address bar,
  type `cmd`), which doesn't have this restriction.
- **`'node' / 'npm' / 'py' is not recognized`:** the program isn't installed, or you haven't
  opened a **new** terminal since installing it. On Windows, if `py` isn't found try `python`. If
  typing `python` opens the Microsoft Store, install Python from python.org instead.
- **Windows: `.env.txt` instead of `.env`:** the file got a hidden `.txt` on the end. Use
  `copy .env.example .env` and edit it with `notepad .env`, or turn on File name extensions
  and rename it.
- **`Missing env vars`:** `.env` is missing, misnamed, or one of the three values is empty.
- **`permission denied for table clients`:** Supabase hasn't given the sync tool's role access
  to the table. Re-run the dashboard's `schema.sql` (its last lines grant this). Also make sure
  the URL and the secret key in `.env` belong to the same project.
- **Not sure whether your keys work:** run `node test-connection.js`. It prints the URL and the
  first characters of your key, then asks Supabase for one client. `Status: 200` means it works.
- **`No ./chats folder found`:** create an empty folder named `chats` next to `sync.js`.
- **A file was skipped with "No client found":** its name doesn't match any client's WhatsApp
  Group. Capital letters and `.txt`/`.TXT` don't matter, but the rest must match.
- **Mac: `SSL: CERTIFICATE_VERIFY_FAILED` when reading screenshots:** Python from python.org
  doesn't ship with trusted certificates. Open the `Python 3.x` folder inside Applications and
  double-click **Install Certificates.command**, then run again. If the sync still ran after
  screenshots failed, those transfers were not read, and re-running won't pick them up, because
  the messages are already marked done. Remove that client's line from `sync-state.json`, delete
  the entries just added on the dashboard, and run again.
- **An entry landed on the wrong person or was missed:** you can edit or delete anything on the
  dashboard by hand. Then tighten the "Be selective" wording or the Relation/Primary Contact setup.

## Keep private

Never upload `.env`, `sync-state.json` (it contains your clients' group names), or anything inside
`chats/` and `raw-exports/`. The repository's `.gitignore` blocks these when you use git, but
dragging files into GitHub's web page ignores `.gitignore`, so only upload a clean copy of this
folder, never the one you actually run.
