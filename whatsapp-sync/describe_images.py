#!/usr/bin/env python3
"""
describe_images.py
-------------------
Reads a WhatsApp "With Media" export (chat.txt + a media folder) and writes
a new, enriched .txt file where every payment screenshot has Claude's
description of it inserted directly into the text, right after the message
that shared it. That enriched file is then ready to rename and drop into
the WhatsApp Sync project's `chats/` folder as usual.

WHY THIS EXISTS: sync.js only ever reads plain text. Anything that exists
purely as a photo (a payment screenshot, for example) is invisible to it.
This script closes that gap for images specifically, without touching how
sync.js works at all - it just hands sync.js richer text to read.

CURATION IS ON YOU: only images that are referenced by filename in the
chat text get processed. Put ONLY the payment/transfer screenshots you
want summarized into the media folder you point this at - leave out ID
documents, forms, or anything else you don't want sent to Claude. Nothing
outside that folder is ever touched.

(On Windows, type "py" instead of "python3" in the commands below.)

USAGE (single client):
  python3 describe_images.py <chat.txt> <media_folder> <enriched-output.txt>

USAGE (batch - process every client in one run):
  python3 describe_images.py --batch <parent_folder>

  Expects a structure like:
    parent_folder/
      Smith Family/
        chat.txt          (or _chat.txt - any single .txt file in this folder)
        images/           (your curated payment screenshots for this client)
      Jones Family/
        chat.txt
        images/
      ...

  Each subfolder's name is used as-is as the output filename, so name each
  subfolder to exactly match that client's "WhatsApp Group" tag - the same
  convention already used for files dropped into chats/. Output for each
  client is written straight into chats/<subfolder name>.txt, ready for
  npm run sync - no manual renaming needed.

Example (single client):
  python3 describe_images.py "raw-exports/Smith Family/chat.txt" \\
                              "raw-exports/Smith Family/images" \\
                              "chats/Smith Family.txt"

Example (batch):
  python3 describe_images.py --batch raw-exports/

REQUIRES: ANTHROPIC_API_KEY - either already set as an environment
variable, or present in a .env file in the folder you run this from
(the same .env file sync.js already uses works fine).

No pip installs needed - this only uses Python's standard library.
"""
import base64
import json
import mimetypes
import os
import re
import subprocess
import sys
import urllib.request
import urllib.error

# On Windows the console can be set to a legacy code page that cannot print emoji; never crash on that.
for _stream in (sys.stdout, sys.stderr):
    try:
        _stream.reconfigure(errors="replace")
    except Exception:
        pass

# Matches the START of a message line in both phone formats:
#   iPhone :  [28/05/26, 3:12:56 PM] Name: message
#   Android:  28/05/26, 3:12 pm - Name: message      (also 28/05/2026, 15:12 - Name: message)
# Day-first dates, 12- or 24-hour clock, with or without seconds. Group 7 is everything after
# the timestamp ("Name: message"), which is what image file names are matched against.
MSG_RE = re.compile(
    r"^[\u200e\u200f\ufeff]*\[?(\d{1,2})[/.](\d{1,2})[/.](\d{2,4}),?[\s\u00a0\u202f]+"
    r"(\d{1,2}):(\d{2})(?::(\d{2}))?[\s\u00a0\u202f]*(?:[AaPp]\.?[\s\u00a0\u202f]?[Mm]\.?)?[\s\u00a0\u202f]*"
    r"(?:\]|[-\u2013\u2014])[\s\u00a0\u202f]?(.*)"
)
IMAGE_EXTS = (".jpg", ".jpeg", ".png", ".webp", ".gif")


def load_api_key():
    key = os.environ.get("ANTHROPIC_API_KEY")
    if key:
        return key
    env_path = os.path.join(os.getcwd(), ".env")
    if os.path.isfile(env_path):
        with open(env_path, "r", encoding="utf-8-sig") as f:
            for line in f:
                line = line.strip()
                if line.startswith("ANTHROPIC_API_KEY="):
                    return line.split("=", 1)[1].strip()
    return None


def parse_messages(chat_path):
    messages = []
    current = None
    with open(chat_path, "r", encoding="utf-8-sig", errors="ignore") as f:
        for raw_line in f:
            line = raw_line.rstrip("\r\n")
            m = MSG_RE.match(line)
            if m:
                current = {"raw": line, "text": m.group(7)}
                messages.append(current)
            elif current is not None:
                current["raw"] += "\n" + line
                current["text"] += "\n" + line
            else:
                messages.append({"raw": line, "text": line})
    return messages


def index_media(media_dir):
    index = {}
    if not os.path.isdir(media_dir):
        return index
    for name in os.listdir(media_dir):
        ext = os.path.splitext(name)[1].lower()
        if ext in IMAGE_EXTS:
            index[name.lower()] = os.path.join(media_dir, name)
    return index


def describe_image(image_path, context, api_key):
    with open(image_path, "rb") as f:
        img_b64 = base64.b64encode(f.read()).decode()
    mime = mimetypes.guess_type(image_path)[0] or "image/jpeg"

    body = {
        "model": "claude-sonnet-5",
        "max_tokens": 300,
        "messages": [
            {
                "role": "user",
                "content": [
                    {"type": "image", "source": {"type": "base64", "media_type": mime, "data": img_b64}},
                    {
                        "type": "text",
                        "text": (
                            "This is a screenshot shared in an advisor-client WhatsApp chat, likely "
                            "a payment or bank transfer confirmation. Recent chat context:\n---\n"
                            f"{context}\n---\n\n"
                            "In 1-2 sentences, state exactly what this image shows: the amount (if "
                            "visible), whether it's money sent or received, which account or person "
                            "it's for, and the date if visible. Be factual and concise - this will be "
                            "read by another AI step to log it in a ledger, so precision on the amount "
                            "and direction matters more than style.\n\n"
                            "IMPORTANT: also state clearly whether this is a DIGITAL confirmation "
                            "(a typed/printed app or bank-portal screen) or a HANDWRITTEN bank slip "
                            "(a photo of a physical counter slip with handwritten figures, date, and "
                            "a bank stamp - the kind issued for an in-person/manual deposit). If it is "
                            "handwritten, say so explicitly as the first part of your description (e.g. "
                            "'Handwritten bank slip showing...'), since handwritten amounts are less "
                            "certain to read correctly and need to be flagged for manual verification. "
                            "If it is NOT actually a payment-related image, just say what it is in one "
                            "short sentence instead."
                        ),
                    },
                ],
            }
        ],
    }

    req = urllib.request.Request(
        "https://api.anthropic.com/v1/messages",
        data=json.dumps(body).encode("utf-8"),
        headers={
            "Content-Type": "application/json",
            "x-api-key": api_key,
            "anthropic-version": "2023-06-01",
        },
        method="POST",
    )
    with urllib.request.urlopen(req) as resp:
        data = json.loads(resp.read())
    for block in data.get("content", []):
        if block.get("type") == "text":
            return block["text"].strip()
    return "(no description returned)"


def process_one(chat_path, media_dir, output_path):
    if not os.path.isfile(chat_path):
        print(f"  ERROR: chat file not found: {chat_path}")
        return False

    api_key = load_api_key()
    if not api_key:
        print("ERROR: ANTHROPIC_API_KEY not found. Set it as an environment variable, or make sure")
        print("a .env file with ANTHROPIC_API_KEY=... exists in the folder you're running this from.")
        sys.exit(1)

    print(f"  Reading {chat_path}...")
    messages = parse_messages(chat_path)
    print(f"  {len(messages)} lines read.")

    media_index = index_media(media_dir)
    print(f"  {len(media_index)} image file(s) found in '{media_dir}'.")
    if len(media_index) == 0:
        print("  Nothing to describe - writing the chat through unchanged.")

    context_lines = []
    described = 0

    os.makedirs(os.path.dirname(os.path.abspath(output_path)), exist_ok=True)

    with open(output_path, "w", encoding="utf-8") as out:
        for msg in messages:
            text_lower = (msg["text"] or "").lower()
            matched_image = None
            for fname_lower, path in media_index.items():
                if fname_lower in text_lower:
                    matched_image = path
                    break

            out.write(msg["raw"] + "\n")

            if matched_image:
                context = "\n".join(context_lines[-15:])
                print(f"    Describing: {os.path.basename(matched_image)}...")
                try:
                    desc = describe_image(matched_image, context, api_key)
                    out.write(f"[Image description: {desc}]\n")
                    described += 1
                except urllib.error.HTTPError as e:
                    print(f"      ERROR describing {os.path.basename(matched_image)}: {e.read().decode()[:200]}")
                except Exception as e:
                    print(f"      ERROR describing {os.path.basename(matched_image)}: {e}")
            else:
                if msg["text"].strip():
                    context_lines.append(msg["text"])

    print(f"  ✅ {described} image(s) described. Written to: {output_path}")
    return True


def find_chat_txt(folder):
    txts = [f for f in os.listdir(folder) if f.lower().endswith(".txt")]
    if not txts:
        return None
    # Prefer a file literally called chat.txt or _chat.txt if present
    for preferred in ("chat.txt", "_chat.txt"):
        if preferred in [t.lower() for t in txts]:
            return os.path.join(folder, next(t for t in txts if t.lower() == preferred))
    return os.path.join(folder, txts[0])


def find_images_folder(client_folder):
    for name in ("images", "payment-images", "payment_images", "media"):
        candidate = os.path.join(client_folder, name)
        if os.path.isdir(candidate):
            return candidate
    return None


def run_batch(parent_folder):
    if not os.path.isdir(parent_folder):
        print(f"ERROR: folder not found: {parent_folder}")
        sys.exit(1)

    client_folders = sorted(
        d for d in os.listdir(parent_folder) if os.path.isdir(os.path.join(parent_folder, d))
    )
    if not client_folders:
        print(f"No subfolders found in {parent_folder}. Expected one subfolder per client.")
        return

    chats_dir = os.path.join(os.getcwd(), "chats")
    print(f"Found {len(client_folders)} client folder(s). Writing results into: {chats_dir}\n")

    ok, skipped = 0, 0
    for name in client_folders:
        client_folder = os.path.join(parent_folder, name)
        print(f"--- {name} ---")

        chat_txt = find_chat_txt(client_folder)
        if not chat_txt:
            print(f"  ⚠️  No .txt file found in '{client_folder}' — skipping.")
            skipped += 1
            continue

        images_folder = find_images_folder(client_folder)
        if not images_folder:
            print(f"  ℹ️  No 'images' subfolder found — proceeding with text only (no images to describe).")
            images_folder = client_folder  # index_media will just find nothing relevant

        output_path = os.path.join(chats_dir, f"{name}.txt")
        if process_one(chat_txt, images_folder, output_path):
            ok += 1
        else:
            skipped += 1
        print()

    print(f"Batch done. {ok} client(s) processed, {skipped} skipped.")
    run_sync()


def run_sync():
    sync_path = os.path.join(os.getcwd(), "sync.js")
    if not os.path.isfile(sync_path):
        print("\n⚠️  Couldn't find sync.js in the current folder — make sure you're running this")
        print("   from inside the whatsapp-dashboard-sync project folder. Skipping the sync step;")
        print("   run 'npm run sync' manually once you're in the right folder.")
        return

    print("\n=== Now syncing everything in chats/ to your dashboard ===\n")
    try:
        result = subprocess.run(["node", "sync.js"], cwd=os.getcwd())
        if result.returncode != 0:
            print("\n⚠️  sync.js exited with an error — see the output above for details.")
    except FileNotFoundError:
        print("\n⚠️  Couldn't find 'node' — make sure Node.js is installed. The enriched files are")
        print("   already sitting in chats/, so you can run 'npm run sync' manually once that's sorted.")


def main():
    if len(sys.argv) == 3 and sys.argv[1] == "--batch":
        run_batch(sys.argv[2])
        return

    if len(sys.argv) != 4:
        print(__doc__)
        sys.exit(1)

    chat_path, media_dir, output_path = sys.argv[1:4]
    process_one(chat_path, media_dir, output_path)
    run_sync()


if __name__ == "__main__":
    main()
