#!/usr/bin/env python3
"""
Vocap content pipeline — CSV -> words.json
==========================================
The single source of truth is the word database CSV (exported from Notion).
This script validates it and emits `words.json` for the game to load.

Usage:
    python export_words.py [input.csv] [output.json]
    Defaults: Vocap-Word-Database.csv -> words.json

Exit code 0 = clean export. Exit code 1 = validation errors (nothing written).
Run this before every build. Uses only the Python standard library.
"""
import csv, json, re, sys, unicodedata
from collections import Counter, defaultdict

# ---------------------------------------------------------------- constants
REQUIRED_COLUMNS = ["Word", "Topic", "Topic 2", "Sub-list", "Phase", "Letters",
                    "Starter Pack", "Rudeness", "Definition", "Definition (Thai)",
                    "Brief history", "Brief history (Thai)", "Sample sentence", "Thai"]
MIN_LEN, MAX_LEN = 3, 15          # formable word lengths (letters, spaces free)
STARTER_LEN = 2                   # starter-pack gift words (not formable)
ALLOWED_WORD = re.compile(r"^[a-z][a-z' -]*[a-z]$")   # lowercase, spaces/'/- inside
VALID_PHASES = {"1", "2", "3", "4", "5", "6", "7", "8"}   # 5+ = post-launch expansion waves
VALID_RUDENESS = {"", "Mild", "Medium", "Strong"}

def letters_of(word: str) -> int:
    """Count spellable letters: spaces, apostrophes, hyphens are free."""
    return len(re.sub(r"[ '\-]", "", word))

def die(errors):
    print(f"\n❌ {len(errors)} validation error(s) — nothing written:\n")
    for e in errors[:50]:
        print("  •", e)
    if len(errors) > 50:
        print(f"  … and {len(errors) - 50} more")
    sys.exit(1)

# ---------------------------------------------------------------- load
src = sys.argv[1] if len(sys.argv) > 1 else "Vocap-Word-Database.csv"
dst = sys.argv[2] if len(sys.argv) > 2 else "words.json"

with open(src, encoding="utf-8-sig", newline="") as f:
    rows = list(csv.DictReader(f))

errors = []
if not rows:
    die(["CSV is empty"])
missing_cols = [c for c in REQUIRED_COLUMNS if c not in rows[0]]
if missing_cols:
    die([f"Missing column(s): {', '.join(missing_cols)}"])

# ---------------------------------------------------------------- validate
seen = {}
for i, r in enumerate(rows, start=2):          # start=2: row 1 is the header
    w = r["Word"].strip()
    where = f"row {i} ('{w}')"

    # normalize + basic shape
    if not w:
        errors.append(f"row {i}: empty Word"); continue
    if w != w.lower() and not ALLOWED_WORD.match(w.lower()):
        errors.append(f"{where}: unexpected characters")
    wl = w.lower()
    if not ALLOWED_WORD.match(wl):
        errors.append(f"{where}: Word may only contain a-z, spaces, apostrophes, hyphens")

    # duplicates
    if wl in seen:
        errors.append(f"{where}: duplicate of row {seen[wl]}")
    seen[wl] = i

    # length rules
    n = letters_of(wl)
    starter = r["Starter Pack"].strip() == "Yes"
    if starter and n != STARTER_LEN:
        errors.append(f"{where}: Starter Pack words must be exactly {STARTER_LEN} letters (got {n})")
    if not starter and not (MIN_LEN <= n <= MAX_LEN):
        errors.append(f"{where}: {n} letters — formable words must be {MIN_LEN}-{MAX_LEN}")
    if r["Letters"].strip() and r["Letters"].strip() != str(n):
        errors.append(f"{where}: Letters column says {r['Letters']}, actual {n}")

    # enums
    if r["Phase"].strip() not in VALID_PHASES:
        errors.append(f"{where}: Phase '{r['Phase']}' not in 1-8")
    if r["Rudeness"].strip() not in VALID_RUDENESS:
        errors.append(f"{where}: Rudeness '{r['Rudeness']}' invalid")

    # required text fields
    for field in ("Topic", "Sub-list", "Definition", "Brief history", "Sample sentence", "Thai"):
        if not r[field].strip():
            errors.append(f"{where}: empty '{field}'")

    # Thai column should contain Thai script
    thai = r["Thai"].strip()
    if thai and not any("THAI" in unicodedata.name(ch, "") for ch in thai):
        errors.append(f"{where}: Thai field has no Thai characters: '{thai}'")

    # The definition IS the in-game clue, so it must never give the answer
    # away. A plain substring check catches the obvious case (the word
    # spelled out) and the sneaky case (the word hiding inside a longer one,
    # e.g. "ear" inside "hear") - both defeat the clue the same way.
    spell = re.sub(r"[ '\-]", "", wl)
    if spell and len(spell) >= 3:
        definition_letters = re.sub(r"[^a-z]", "", r["Definition"].strip().lower())
        if spell in definition_letters:
            errors.append(f"{where}: Definition contains the answer ('{spell}')")
    if thai and r["Definition (Thai)"].strip() and thai in r["Definition (Thai)"]:
        errors.append(f"{where}: Definition (Thai) contains the Thai answer ('{thai}')")

# Topic 2 must be a real topic and must differ from Topic
all_topics = {r["Topic"].strip() for r in rows}
for i, r in enumerate(rows, start=2):
    t2 = r["Topic 2"].strip()
    if not t2:
        continue
    if t2 == r["Topic"].strip():
        errors.append(f"row {i} ('{r['Word']}'): Topic 2 duplicates Topic")
    elif t2 not in all_topics:
        errors.append(f"row {i} ('{r['Word']}'): Topic 2 '{t2}' is not a known topic")

# sub-list must belong to exactly one topic
sub_topics = defaultdict(set)
for r in rows:
    sub_topics[r["Sub-list"].strip()].add(r["Topic"].strip())
for sub, topics in sub_topics.items():
    if len(topics) > 1:
        errors.append(f"Sub-list '{sub}' appears under multiple topics: {sorted(topics)}")

if errors:
    die(errors)

# ---------------------------------------------------------------- build output
words = []
for r in rows:
    wl = r["Word"].strip().lower()
    words.append({
        "id": re.sub(r"[ '\-]", "_", wl),
        "word": wl,
        "letters": letters_of(wl),
        "spell": re.sub(r"[ '\-]", "", wl),      # what the player's tiles must produce
        "topic": r["Topic"].strip(),
        "topic2": r["Topic 2"].strip() or None,
        "sublist": r["Sub-list"].strip(),
        "phase": int(r["Phase"]),
        "starter": r["Starter Pack"].strip() == "Yes",
        "rudeness": r["Rudeness"].strip() or None,
        "definition": r["Definition"].strip(),
        "history": r["Brief history"].strip(),
        "translations": {
            "th": {
                "word": r["Thai"].strip() or None,
                "definition": r["Definition (Thai)"].strip() or None,
                "history": r["Brief history (Thai)"].strip() or None,
            }
        },
        "sentence": r["Sample sentence"].strip(),
        "thai": r["Thai"].strip(),
    })

topics = []
by_topic = defaultdict(list)
for w in words:
    by_topic[w["topic"]].append(w)
for t, ws in by_topic.items():
    subs = sorted({w["sublist"] for w in ws})
    secondary = [w for w in words if w["topic2"] == t]
    topics.append({"name": t, "phase": ws[0]["phase"], "sublists": subs,
                   "word_count": len(ws), "secondary_count": len(secondary),
                   "total_unlockable": len(ws) + len(secondary)})
topics.sort(key=lambda t: (t["phase"], t["name"]))

out = {
    "schema": 1,
    "counts": {"words": len(words),
               "by_phase": dict(sorted(Counter(w["phase"] for w in words).items()))},
    "topics": topics,
    "words": sorted(words, key=lambda w: (w["phase"], w["topic"], w["sublist"], w["word"])),
}
with open(dst, "w", encoding="utf-8") as f:
    json.dump(out, f, ensure_ascii=False, indent=1)

# ---------------------------------------------------------------- report
print(f"✅ {len(words)} words -> {dst}")
for p, n in out["counts"]["by_phase"].items():
    print(f"   Phase {p}: {n} words")
print(f"   Topics: {len(topics)} | Starter Pack gifts: {sum(w['starter'] for w in words)}"
      f" | Rude words: {sum(1 for w in words if w['rudeness'])}")
dual = sum(1 for w in words if w["topic2"])
print(f"   Cross-listed words (Topic 2): {dual}")
th_done = sum(1 for w in words if w["translations"]["th"]["definition"]
              and w["translations"]["th"]["history"])
print(f"   Languages: en (base) + th | th complete: {th_done}/{len(words)}"
      + ("" if th_done == len(words) else f" ({len(words)-th_done} pending)"))
longest = max(words, key=lambda w: w["letters"])
print(f"   Longest word: '{longest['word']}' ({longest['letters']} letters)")
