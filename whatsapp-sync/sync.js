/**
 * WhatsApp -> Claude -> Supabase sync
 * -------------------------------------------
 * 1. Reads exported WhatsApp .txt chats from ./chats
 * 2. Matches each file to a client (or several, for shared family groups)
 *    by their "WhatsApp Group" tag
 * 3. Skips any message already processed in a previous run (tracked in
 *    sync-state.json), so re-exporting the full chat history every time
 *    doesn't cost more or create duplicate entries
 * 4. On a client's very first run, if there's a large backlog, automatically
 *    splits it into monthly chunks so nothing gets cut off
 * 5. Sends only the new messages to Claude, extracts:
 *      - structured updates -> client's `notes` array (and `meetings`)
 *      - confirmed money movements -> client's `transactions` array (the Ledger)
 *
 * Nothing in this file talks to your website. It talks directly to Supabase
 * using the service role key, so it can write data even without a logged-in
 * browser session.
 */

import "dotenv/config";
import { createClient } from "@supabase/supabase-js";
import fs from "fs";
import path from "path";

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const CHATS_DIR = path.join(process.cwd(), "chats");
const STATE_FILE = path.join(process.cwd(), "sync-state.json");

if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY || !ANTHROPIC_API_KEY) {
  console.error(
    "Missing env vars. Copy .env.example to .env and fill in SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, ANTHROPIC_API_KEY."
  );
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

const uid = () => Math.random().toString(36).slice(2, 10);
const toISODate = (d) => d.toISOString().slice(0, 10);
const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

// ---------- Local state (remembers the last message date processed per group tag) ----------

function loadState() {
  if (!fs.existsSync(STATE_FILE)) return {};
  try {
    return JSON.parse(fs.readFileSync(STATE_FILE, "utf-8"));
  } catch {
    return {};
  }
}

function saveState(state) {
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}

// ---------- Parsing the WhatsApp export into individual dated messages ----------

// Matches the START of a message line in both phone formats:
//   iPhone :  [28/05/26, 3:12:56 PM] Name: message
//   Android:  28/05/26, 3:12 pm - Name: message        (also 28/05/2026, 15:12 - Name: message)
// Dates must be DAY-first (DD/MM/YY or DD/MM/YYYY; dots also work: 28.05.2026).
// The clock can be 12-hour (am/pm, a.m./p.m.) or 24-hour, with or without seconds.
// Some phones put unusual space characters before am/pm, and files re-saved on Windows can
// start with a BOM or use CRLF line endings. All of that is handled here.
const MSG_LINE_RE =
  /^[\u200e\u200f\ufeff]*\[?(\d{1,2})[\/.](\d{1,2})[\/.](\d{2,4}),?[\s\u00a0\u202f]+(\d{1,2}):(\d{2})(?::(\d{2}))?[\s\u00a0\u202f]*(?:([AaPp])\.?[\s\u00a0\u202f]?[Mm]\.?)?[\s\u00a0\u202f]*(?:\]|[-\u2013\u2014])/;

function parseMessages(rawText) {
  const lines = rawText.split(/\r?\n/);
  const messages = [];
  let current = null;
  let monthFirstSuspected = false;

  for (const line of lines) {
    if (line.includes("Messages and calls are end-to-end encrypted")) continue;

    const m = line.match(MSG_LINE_RE);
    if (m) {
      const [, dd, mm, yy, hh, min, ss, meridiem] = m;
      const day = parseInt(dd, 10);
      const month = parseInt(mm, 10);
      if (month > 12) {
        // A "month" above 12 means the phone wrote the date month-first (MM/DD).
        monthFirstSuspected = true;
        continue;
      }
      let year = parseInt(yy, 10);
      if (year < 100) year += 2000;
      let hour = parseInt(hh, 10);
      if (meridiem) {
        hour = hour % 12;
        if (meridiem.toLowerCase() === "p") hour += 12;
      }
      const date = new Date(year, month - 1, day, hour, parseInt(min, 10), ss ? parseInt(ss, 10) : 0);

      current = { date, lines: [line] };
      messages.push(current);
    } else if (current) {
      current.lines.push(line); // continuation of a multi-line message
    }
    // stray lines before any timestamp is seen are ignored
  }

  messages.monthFirstSuspected = monthFirstSuspected;
  return messages;
}

// Groups messages into calendar-month chunks, in chronological order
function chunkByMonth(messages) {
  const buckets = new Map();
  for (const msg of messages) {
    const key = `${msg.date.getFullYear()}-${String(msg.date.getMonth() + 1).padStart(2, "0")}`;
    if (!buckets.has(key)) buckets.set(key, []);
    buckets.get(key).push(msg);
  }
  return [...buckets.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([key, msgs]) => ({ key, messages: msgs }));
}

function messagesToText(messages) {
  return messages.map((m) => m.lines.join("\n")).join("\n");
}

// ---------- Claude extraction ----------

async function extractAll(peopleNames, chatText) {
  const peopleList = peopleNames.join(", ");
  const multiPerson = peopleNames.length > 1;

  const prompt = `You are reading WhatsApp messages between an advisor and ${
    multiPerson ? `a family with these members: ${peopleList}` : `their client "${peopleList}"`
  }.

Respond with a single raw JSON object with two keys: "updates" and "transactions".

1) "updates": the distinct, meaningful non-financial updates from this chat. For each one, output an object with:
   - "date": the actual calendar date this happened, in "YYYY-MM-DD" format, based on the timestamp(s) of the message(s) it comes from. Every message line starts with a date like [28/05/26, 3:12:56 PM] — use that, converting DD/MM/YY to YYYY-MM-DD.
   - "type": one of "note" (general update/info), "followup" (something we owe the client or need to chase), "call" (a call happened or was discussed), "meeting" (a meeting happened or was scheduled)
   - "title": a short 3-8 word headline
   - "content": 1-3 sentences summarizing it, written for someone catching up later
   ${
     multiPerson
       ? `- "person": which family member this specifically concerns, chosen from exactly [${peopleList}]. If it applies to the whole family or you can't tell, use "family".`
       : ""
   }- "meeting_date": if this update is a confirmed, scheduled meeting with a real calendar date, output it as "YYYY-MM-DD". Otherwise null. Do not guess.

   Be selective — only log things that would actually matter to someone reviewing this client's history later. SKIP the following entirely, with NO exceptions and NO "milestone" summaries:
   - The ACCOUNT OPENING / ONBOARDING process in ANY form. This covers all of: documents or details being requested, needed, or shared (Aadhar, PAN, HUF details, forms, nominee forms, signatures, "document omitted"); KYC being asked for, shared, or completed; photo, video, or in-person verification being requested or done; HUF or entity account details being needed; account details, account numbers, bank details for transfers, or login credentials being shared; and the account being opened, activated, or going live. Do NOT log any of these individually, and do NOT log a summary of them either (no "account opened", no "KYC completed", no "documents requested").
   - OTP sharing and verification exchanges, with no exceptions
   - App or portal login/access setup — credentials, OTPs, or account links for things like a portfolio-tracking app (e.g. Gridkey) or any similar tool — this is routine account access, not a client update
   - Bare acknowledgments with no new information ("Ok", "noted", "thanks", "👍", "sure")
   - Routine scheduling chatter that doesn't result in a confirmed date
   If a stretch of chat is only about the items above, return nothing for it.

2) "transactions": any CONFIRMED money movements mentioned — money the client sent/transferred/deposited to us, OR money we sent/paid/refunded to the client. Includes plain text confirmations like "sent 1.5", "funds received, thank you", "transferred 8L" — not just screenshots. For each one, output an object with:
   - "date": the date this transfer happened or was confirmed, "YYYY-MM-DD", from the message timestamp.
   - "amount": a PLAIN NUMBER in rupees (not a string, no symbols). Convert Indian shorthand: "L"/"Lac"/"Lakh" means multiply by 100000 (so "8L" = 800000, "1.5L" = 150000). "Cr"/"Crore" means multiply by 10000000. Strip "₹", "Rs", "INR", and commas.
   - "type": "credit" if this is money the client sent TO us/the firm, "debit" if this is money WE sent/paid/refunded TO the client.
   - "note": a short 3-8 word description of what the transfer was for.
   - "needs_verification": true if the source is a handwritten/manually-filled bank slip (not a typed digital confirmation) — this will usually be stated explicitly in an "[Image description: ...]" block if one is present for this transfer. Otherwise false.
   ${
     multiPerson
       ? `- "person": which family member this concerns, chosen from exactly [${peopleList}], or "family" if unclear/joint.`
       : ""
   }Only include a transaction if there's a clear, confirmed amount and direction. Do not include vague future mentions like "I'll transfer some funds soon" with no number, and do not double-count — if a client says they sent an amount and the team later confirms receipt of the same transfer, that is ONE transaction, not two.

If there's nothing for a category, return an empty array for it. Respond with ONLY the raw JSON object — no markdown fences, no preamble, no explanation.

CHAT:
${chatText}`;

  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: "claude-sonnet-5",
      max_tokens: 128000,
      thinking: { type: "disabled" },
      messages: [{ role: "user", content: prompt }],
    }),
  });

  if (!res.ok) {
    throw new Error(`Claude API error: ${res.status} ${await res.text()}`);
  }

  const data = await res.json();

  if (data.stop_reason === "max_tokens") {
    console.error(
      `    ⚠️  Response was cut off — this chunk generated an extraordinarily large amount of output (over 128,000 tokens for one month). This is very unusual; consider splitting this period into smaller date ranges if it keeps happening.`
    );
    return null; // signal "don't advance state past this chunk"
  }

  const textBlock = data.content.find((b) => b.type === "text");
  let raw = (textBlock?.text || "{}").trim();
  raw = raw.replace(/```json/gi, "").replace(/```/g, "").trim();

  const firstBrace = raw.indexOf("{");
  const lastBrace = raw.lastIndexOf("}");
  if (firstBrace !== -1 && lastBrace !== -1 && lastBrace > firstBrace) {
    raw = raw.slice(firstBrace, lastBrace + 1);
  }

  try {
    const parsed = JSON.parse(raw);
    return {
      updates: Array.isArray(parsed.updates) ? parsed.updates : [],
      transactions: Array.isArray(parsed.transactions) ? parsed.transactions : [],
    };
  } catch (e) {
    console.error(`    Couldn't parse Claude's response:`, raw.slice(0, 500));
    return null;
  }
}


// ---------- Writing extracted updates + transactions into Supabase ----------

function findPrimaryContact(matchedClients) {
  return matchedClients.find((c) => (c.relation || "").trim().toLowerCase() === "primary contact") || null;
}

// Routes each item (update or transaction) to exactly ONE client:
// - a single-client group -> that client, always
// - an item naming a specific family member -> that member's own record
// - anything ambiguous/whole-family -> the group's Primary Contact only
// - ambiguous items with no Primary Contact set -> skipped (counted, not written anywhere)
function routeItems(items, matchedClients, primaryClient) {
  const byClientId = new Map();
  let skippedNoPrimary = 0;

  for (const item of items) {
    let target = null;

    if (matchedClients.length === 1) {
      target = matchedClients[0];
    } else if (item.person && item.person !== "family") {
      target =
        matchedClients.find((c) => c.name.trim().toLowerCase() === item.person.trim().toLowerCase()) || primaryClient;
    } else {
      target = primaryClient;
    }

    if (!target) {
      skippedNoPrimary++;
      continue;
    }

    if (!byClientId.has(target.id)) byClientId.set(target.id, []);
    byClientId.get(target.id).push(item);
  }

  return { byClientId, skippedNoPrimary };
}

async function writeForClients(matchedClients, updates, transactions, fallbackDateISO) {
  const primaryClient = matchedClients.length > 1 ? findPrimaryContact(matchedClients) : null;

  const { byClientId: updatesByClient, skippedNoPrimary: updatesSkipped } = routeItems(updates, matchedClients, primaryClient);
  const { byClientId: txnsByClient, skippedNoPrimary: txnsSkipped } = routeItems(transactions, matchedClients, primaryClient);

  const totalSkipped = updatesSkipped + txnsSkipped;
  if (matchedClients.length > 1 && !primaryClient && totalSkipped > 0) {
    const names = matchedClients.map((c) => c.name).join(", ");
    console.error(
      `    ⚠️  Skipped ${totalSkipped} update(s)/transaction(s) — no one in this family group (${names}) has "Primary Contact" set as their Relation. Set that on the dashboard for whichever of them you primarily deal with, so future ambiguous updates aren't lost.`
    );
  }

  const allClientIds = new Set([...updatesByClient.keys(), ...txnsByClient.keys()]);

  for (const clientId of allClientIds) {
    const client = matchedClients.find((c) => c.id === clientId);
    const relevantUpdates = updatesByClient.get(clientId) || [];
    const relevantTxns = txnsByClient.get(clientId) || [];

    // Re-fetch current data right before writing, since a client could have
    // been touched by an earlier chunk in this same run
    const { data: freshClient } = await supabase
      .from("clients")
      .select("notes, meetings, transactions")
      .eq("id", client.id)
      .single();
    const currentNotes = freshClient?.notes || [];
    const currentMeetings = freshClient?.meetings || [];
    const currentTxns = freshClient?.transactions || [];

    const patch = {};
    let noteCount = 0;
    let meetingCount = 0;
    let txnCount = 0;

    if (relevantUpdates.length > 0) {
      const newEntries = relevantUpdates.map((u) => ({
        id: uid(),
        date: ISO_DATE_RE.test(u.date) ? u.date : fallbackDateISO,
        type: ["note", "followup", "call", "meeting"].includes(u.type) ? u.type : "note",
        title: u.title || "Update",
        content: u.content || "",
      }));
      const sortedEntries = [...newEntries].sort((a, b) => b.date.localeCompare(a.date));
      patch.notes = [...sortedEntries, ...currentNotes];
      noteCount = newEntries.length;

      const meetingUpdates = relevantUpdates.filter((u) => u.meeting_date);
      if (meetingUpdates.length > 0) {
        const newMeetings = meetingUpdates.map((u) => ({
          id: uid(),
          date: u.meeting_date,
          title: u.title || "Meeting",
          notes: u.content || "",
        }));
        patch.meetings = [...currentMeetings, ...newMeetings].sort((a, b) => a.date.localeCompare(b.date));
        meetingCount = meetingUpdates.length;
      }
    }

    if (relevantTxns.length > 0) {
      const validTxns = relevantTxns.filter((t) => {
        const amt = Number(t.amount);
        return Number.isFinite(amt) && amt > 0 && ["credit", "debit"].includes(t.type);
      });
      const skipped = relevantTxns.length - validTxns.length;
      if (skipped > 0) {
        console.error(`    ⚠️  Skipped ${skipped} transaction(s) with an unclear amount/direction for ${client.name}.`);
      }
      const needsVerification = validTxns.filter((t) => t.needs_verification).length;
      if (needsVerification > 0) {
        console.error(
          `    ⚠️  ${needsVerification} transaction(s) from handwritten slips — flagged in the Ledger for manual verification.`
        );
      }
      if (validTxns.length > 0) {
        const newTxns = validTxns.map((t) => ({
          id: uid(),
          date: ISO_DATE_RE.test(t.date) ? t.date : fallbackDateISO,
          amount: Number(t.amount),
          type: t.type,
          note: t.needs_verification ? `⚠️ Handwritten slip, verify amount — ${t.note || ""}`.trim() : t.note || "",
        }));
        patch.transactions = [...currentTxns, ...newTxns];
        txnCount = newTxns.length;
      }
    }

    if (Object.keys(patch).length === 0) continue;

    const { error: updateError } = await supabase.from("clients").update(patch).eq("id", client.id);

    if (updateError) {
      console.error(`    Failed to save for ${client.name}:`, updateError.message);
    } else {
      const parts = [];
      if (noteCount > 0) parts.push(`${noteCount} note${noteCount === 1 ? "" : "s"}`);
      if (meetingCount > 0) parts.push(`${meetingCount} meeting${meetingCount === 1 ? "" : "s"}`);
      if (txnCount > 0) parts.push(`${txnCount} ledger entr${txnCount === 1 ? "y" : "ies"}`);
      console.log(`    ✅ ${parts.join(", ")} -> ${client.name}.`);
    }
  }
}

// ---------- Main ----------

async function main() {
  if (!fs.existsSync(CHATS_DIR)) {
    console.error(`No ./chats folder found. Create one and drop your exported .txt files in it.`);
    process.exit(1);
  }

  const { data: clients, error } = await supabase
    .from("clients")
    .select("id, name, tags, notes, meetings, transactions, relation");
  if (error) {
    console.error("Couldn't load clients from Supabase:", error.message);
    process.exit(1);
  }

  const files = fs.readdirSync(CHATS_DIR).filter((f) => /\.txt$/i.test(f));
  if (files.length === 0) {
    console.log("No .txt files found in ./chats. Nothing to do.");
    return;
  }

  const state = loadState();

  for (const file of files) {
    const groupName = file.replace(/(\.txt)+$/i, "").trim();
    const stateKey = groupName.toLowerCase();

    const matchedClients = clients.filter((c) =>
      (c.tags || []).some((t) => t.trim().toLowerCase() === groupName.toLowerCase())
    );

    if (matchedClients.length === 0) {
      console.log(`⚠️  No client found with WhatsApp Group tag matching "${groupName}" — skipping.`);
      continue;
    }

    const peopleNames = matchedClients.map((c) => c.name);
    console.log(`\nProcessing ${file} -> ${peopleNames.join(", ")}...`);

    const raw = fs.readFileSync(path.join(CHATS_DIR, file), "utf-8").replace(/^\ufeff/, ""); // drop a BOM if the file has one
    const allMessages = parseMessages(raw);

    if (allMessages.monthFirstSuspected) {
      console.error(
        `  ⚠️  This export writes dates month-first (like 12/28/26), but this tool needs day-first (28/12/26). ` +
          `Set your phone's region to a country that writes dates day-first (for example India or the United Kingdom), ` +
          `export the chat again, and re-run. Skipping ${file}.`
      );
      continue;
    }

    if (allMessages.length === 0) {
      console.log(
        `  No dated messages found in "${file}" — skipping. Is it a WhatsApp chat export with day-first dates? See "Known limits" in the README.`
      );
      continue;
    }

    const lastProcessed = state[stateKey] ? new Date(state[stateKey]) : null;
    const newMessages = lastProcessed ? allMessages.filter((m) => m.date > lastProcessed) : allMessages;

    if (newMessages.length === 0) {
      console.log(`  Nothing new since the last run (last processed: ${state[stateKey]}). Skipping.`);
      continue;
    }

    const isFirstRun = !lastProcessed;
    const chunks = chunkByMonth(newMessages);

    if (isFirstRun && chunks.length > 1) {
      console.log(`  First time seeing this client — ${chunks.length} months of history to process, one chunk at a time.`);
    }

    for (const chunk of chunks) {
      console.log(`  Chunk ${chunk.key} (${chunk.messages.length} messages)...`);
      const chatText = messagesToText(chunk.messages);
      const result = await extractAll(peopleNames, chatText);

      if (result === null) {
        console.log(`  Stopping here for ${groupName} — will retry from this point on the next run.`);
        break; // don't advance state past a failed/truncated chunk
      }

      const lastMsgDate = chunk.messages[chunk.messages.length - 1].date;
      const entryDateISO = toISODate(lastMsgDate);

      if (result.updates.length === 0 && result.transactions.length === 0) {
        console.log(`    Nothing substantive in this chunk.`);
      } else {
        await writeForClients(matchedClients, result.updates, result.transactions, entryDateISO);
      }

      // Advance and persist state after EVERY successful chunk, so progress
      // survives even if a later chunk or the whole run fails
      state[stateKey] = lastMsgDate.toISOString();
      saveState(state);
    }
  }

  console.log("\nDone. Move the processed files out of ./chats (or delete them) before next run.");
}

main();
