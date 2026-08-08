#!/usr/bin/env python3
"""
Build words-th.json — the Thai game's word file.

The Thai game answers Thai words, so the Thai word becomes `word` and `spell`,
the Thai definition becomes the clue, and the English word survives only as the
translation shown on the discovery card.

It is generated from the same CSV for now, but the point of a separate file is
that Thai content can diverge whenever you want it to: rewrite the clues for a
Thai audience, add words that have no English counterpart, drop ones that only
make sense as English vocabulary. Nothing here has to mirror the English game.

    python content/build_thai.py content/Vocap-Word-Database.csv app/words-th.json
"""
import csv, json, sys, unicodedata

# Tone marks and the silent-killer mark: written above a letter, never tiles.
FREE = set('\u0E47\u0E48\u0E49\u0E4A\u0E4B\u0E4C')

MIN_TILES, MAX_TILES = 2, 15


def tiles(word: str) -> int:
    """How many tray tiles a word actually needs."""
    return sum(1 for c in word if c not in FREE and not c.isspace())


def build(csv_path: str, out_path: str) -> None:
    rows = list(csv.DictReader(open(csv_path, encoding="utf-8-sig")))
    words, skipped = [], []

    for r in rows:
        thai = r["Thai"].strip()
        clue = r["Definition (Thai)"].strip()
        if not thai or not clue:
            skipped.append((r["Word"], "no Thai word or clue"))
            continue

        spell = "".join(thai.split())
        n = tiles(spell)
        if not (MIN_TILES <= n <= MAX_TILES):
            skipped.append((r["Word"], f"{n} tiles"))
            continue

        # A clue that contains its own answer is not a clue.
        if spell in clue:
            skipped.append((r["Word"], "clue contains the answer"))
            continue

        words.append({
            "id": "th-" + r["Word"].lower().replace(" ", "-"),
            "word": thai,
            "spell": spell,
            "letters": n,
            "topic": r["Topic"],
            "topic2": r["Topic 2"] or None,
            "sublist": r["Sub-list"],
            "phase": int(r["Phase"]) if r["Phase"].strip().isdigit() else 1,
            "starter": False,
            "rudeness": r["Rudeness"] or None,
            "definition": clue,
            "history": r["Brief history (Thai)"].strip(),
            "sentence": "",
            # the only English left: the translation on the card
            "translations": {"en": {
                "word": r["Word"],
                "definition": r["Definition"].strip(),
                "history": "",
            }},
            "thai": thai,
        })

    json.dump({"schema": 1, "game": "th", "count": len(words), "words": words},
              open(out_path, "w", encoding="utf-8"),
              ensure_ascii=False, separators=(",", ":"))

    print(f"OK  ->  {out_path}   ({len(words)} words)")
    by_len = {}
    for w in words:
        by_len[w["letters"]] = by_len.get(w["letters"], 0) + 1
    print("   tiles needed: " + ", ".join(
        f"{k}:{by_len[k]}" for k in sorted(by_len)))
    if skipped:
        print(f"   skipped {len(skipped)}:")
        reasons = {}
        for _, why in skipped:
            reasons[why] = reasons.get(why, 0) + 1
        for why, n in sorted(reasons.items(), key=lambda x: -x[1])[:6]:
            print(f"     {n:>4}  {why}")


if __name__ == "__main__":
    a = sys.argv[1:] or ["content/Vocap-Word-Database.csv", "app/words-th.json"]
    build(a[0], a[1])
