#!/usr/bin/env python3
"""
Vocap — build the Thai dictionary
==================================
Mirrors build_dictionary.py's approach (curated words stay curated,
dictionary is the everything-else layer) but for Thai: the source is a
word list with real definitions instead of an English validity list plus
WordNet, since Thai has no equivalent frequency/WordNet pairing available.

Source: PyThaiNLP's thai_dictionary.csv, itself collected from Thai
Wiktionary (word, meaning) pairs - meaning is a Python-dict-literal string
keyed by part of speech. CC BY-SA 4.0 (PyThaiNLP / Thai Wiktionary
contributors) - keep the attribution in `source` below if this is ever
regenerated from a newer copy.

English equivalents: the game always wants a way to practise English, even
on the Thai side, so a dictionary word that also has a known English
translation gets a second speak button for it (see dictCardHTML/bindCard
in engine.js). The source for that join is veer66/thaidix's tha-eng.dix
(Apertium bilingual dictionary, itself also sourced from Thai Wiktionary,
CC BY-SA 3.0) - it only overlaps a small slice of the word list (a few
percent), so this is "as many as we actually have", not full coverage.
Words without a match simply get no English button, same as words
without a definition get "(no definition available)".

Download once:
  https://github.com/PyThaiNLP/pythainlp-corpus/releases/download/thai_dict-v1.0/thai_dictionary.csv
  save as content/thai_dictionary.csv
  https://raw.githubusercontent.com/veer66/thaidix/master/tha-eng.dix
  save as content/tha-eng.dix   (optional - English equivalents are skipped without it)

Run from the repo root:
    python content/build_dictionary_th.py
"""
import ast, csv, json, os, re, sys
import xml.etree.ElementTree as ET

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SRC  = os.path.join(ROOT, "content", "thai_dictionary.csv")
DIX  = os.path.join(ROOT, "content", "tha-eng.dix")
WORDS = os.path.join(ROOT, "app", "words-th.json")
OUT  = os.path.join(ROOT, "content", "dictionary-th.json")

# Tone marks and the silent-killer mark: written above a letter, never their
# own tray tile - same set build_thai.py and engine.js's FREE_MARKS use, so
# tile counts here agree with what the tray actually shows.
FREE = set('็่้๊๋์')
MIN_TILES, MAX_TILES = 2, 15
THAI_ONLY = re.compile(r'^[ก-์]+$')


def tiles(word: str) -> int:
    return sum(1 for c in word if c not in FREE)


def keep(word: str) -> bool:
    if not THAI_ONLY.match(word):          # no Latin, digits, punctuation
        return False
    n = tiles(word)
    return MIN_TILES <= n <= MAX_TILES


def defs_for(meaning_field: str) -> list:
    """Flatten every part-of-speech's senses into one ranked list, same
    3-sense cap the English side uses, so a card never reads like a wall
    of text."""
    try:
        parsed = ast.literal_eval(meaning_field)
    except (ValueError, SyntaxError):
        return []
    if not isinstance(parsed, dict):
        return []
    out = []
    for senses in parsed.values():
        if not isinstance(senses, list):
            continue
        for s in senses:
            s = s.strip()
            if not s or s in out:
                continue
            out.append(s)
            if len(out) == 3:
                return out
    return out


def elem_text(el):
    """Reconstruct an Apertium <l>/<r> element's text: <b/> becomes a
    space (word boundary within a phrase), <s .../> (part-of-speech tag)
    contributes nothing, <g> groups are walked recursively."""
    parts = [el.text or ""]
    for child in el:
        if child.tag == "b":
            parts.append(" ")
        elif child.tag == "g":
            parts.append(elem_text(child))
        # <s> (part-of-speech) has no text of its own - skip
        if child.tail:
            parts.append(child.tail)
    return "".join(parts)


def load_translations():
    """thai word -> [english translations], from the Apertium dix if
    present. Returns {} rather than failing when it's missing, since the
    English-equivalent button is a bonus, not a requirement to build."""
    if not os.path.exists(DIX):
        return {}
    root = ET.parse(DIX).getroot()
    out = {}
    for e in root.iter("e"):
        p = e.find("p")
        if p is None:
            continue
        l, r = p.find("l"), p.find("r")
        if l is None or r is None:
            continue
        thai = re.sub(r"\s+", " ", elem_text(l)).strip()
        eng = re.sub(r"\s+", " ", elem_text(r)).strip()
        if not thai or not eng:
            continue
        out.setdefault(thai, [])
        if eng not in out[thai]:
            out[thai].append(eng)
    return out


def main():
    if not os.path.exists(SRC):
        print("ERROR: content/thai_dictionary.csv not found.")
        print("Download it once from:")
        print("  https://github.com/PyThaiNLP/pythainlp-corpus/releases/download/thai_dict-v1.0/thai_dictionary.csv")
        print("and save it as content/thai_dictionary.csv")
        sys.exit(1)

    rows = list(csv.DictReader(open(SRC, encoding="utf-8")))

    curated = set()
    if os.path.exists(WORDS):
        data = json.load(open(WORDS, encoding="utf-8"))
        curated = {w["spell"] for w in data["words"]}

    words, glosses, skipped_dupe, skipped_bad = [], {}, 0, 0
    seen = set()
    for r in rows:
        w = (r.get("word") or "").strip()
        if not w or not keep(w):
            skipped_bad += 1
            continue
        if w in curated:
            continue                         # curated words live in words-th.json
        if w in seen:
            skipped_dupe += 1
            continue
        seen.add(w)
        words.append(w)
        g = defs_for(r.get("meaning") or "")
        if g:
            glosses[w] = g

    words.sort()
    shelves = {}
    for w in words:
        shelves.setdefault(w[0], []).append(w)

    # English equivalents: prefer the shortest candidate (fewest spaces,
    # then fewest characters) as the one worth a play button - the clean
    # single-word translations this source has plenty of, rather than a
    # longer descriptive phrase when a word has several candidates.
    translations = load_translations()
    en = {}
    for w in words:
        cands = translations.get(w)
        if cands:
            en[w] = min(cands, key=lambda s: (s.count(" "), len(s)))

    out = {"schema": 4,
           "source": "Thai Wiktionary via PyThaiNLP thai_dictionary.csv (CC BY-SA 4.0); "
                      "English equivalents via veer66/thaidix (CC BY-SA 3.0)",
           "count": len(words), "shelves": shelves, "defs": glosses, "en": en}
    with open(OUT, "w", encoding="utf-8") as f:
        json.dump(out, f, ensure_ascii=False, separators=(",", ":"))

    kb = os.path.getsize(OUT) // 1024
    print(f"OK  ->  content/dictionary-th.json   ({kb} KB)")
    print(f"    {len(rows):,} raw rows -> {len(words):,} kept "
          f"({skipped_bad:,} filtered, {skipped_dupe:,} duplicate, "
          f"{len(curated)} excluded as curated)")
    print(f"    definitions: {len(glosses):,} of {len(words):,} words "
          f"({len(glosses)/max(len(words),1)*100:.0f}%)")
    print(f"    English equivalents: {len(en):,} of {len(words):,} words "
          f"({len(en)/max(len(words),1)*100:.0f}%)"
          + ("" if os.path.exists(DIX) else "  [content/tha-eng.dix not found - skipped]"))


if __name__ == "__main__":
    main()
