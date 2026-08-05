#!/usr/bin/env python3
"""
Vocap — build the bundled dictionary
====================================
Turns a raw word list (ENABLE) into the list the game ships with.

This list is PLAYER-FACING: every word in it can be revealed in the
Dictionary, so it is filtered for display quality, not just validity.
Scrabble debris like "aa", "xu" and "zzz" is technically valid but reads
like a bug when it inks a page.

Run from the repo root:
    python content/build_dictionary.py

Reads   content/enable.txt     — validity  (is it a real English word?)
        content/freq.txt       — frequency (is it a word people actually use?)
        content/wordnet/       — definitions (optional but recommended)
Writes  content/dictionary.json — bundled with the game

A word must appear in BOTH to be kept. ENABLE alone is a Scrabble list: it
contains 'aalii' and 'zabaione', which are valid but read as nonsense to a
learner and make the Dictionary feel like noise. The frequency list alone
contains typos and proper nouns. The intersection is the sweet spot.

Download these once:
  enable.txt  https://raw.githubusercontent.com/dolph/dictionary/master/enable1.txt
  freq.txt    https://raw.githubusercontent.com/hermitdave/FrequencyWords/master/content/2018/en/en_50k.txt
  wordnet.zip https://raw.githubusercontent.com/nltk/nltk_data/gh-pages/packages/corpora/wordnet.zip
              (unzip it into content/, giving you content/wordnet/)

WordNet gives every revealed word a short definition. It is deliberately
plainer than the curated 966 - those have hand-written definitions, Thai
translations and fun facts. The Dictionary is a log; the collection is the
gift. Keeping that gap is the point.
"""
import json, os, sys, re

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SRC  = os.path.join(ROOT, "content", "enable.txt")
WNDIR= os.path.join(ROOT, "content", "wordnet")
FREQ = os.path.join(ROOT, "content", "freq.txt")
OUT  = os.path.join(ROOT, "content", "dictionary.json")
WORDS = os.path.join(ROOT, "content", "words.json")

# Words that are valid in Scrabble but look like typos to a learner.
# These are obscure two/three-letter entries with no everyday use.
JUNK = {
 # Two-letter Scrabble entries that no learner would recognise as words.
 # Three-letter words are NOT filtered here: the frequency gate below already
 # removes anything nobody actually writes, and an over-eager list here was
 # silently deleting ordinary words like "cue", "bus" and "cut".
 "aa","ab","ad","ae","ag","ai","al","ar","aw","ay","ba","bi","bo","br",
 "de","ed","ef","el","em","en","er","es","et","fa","fe","gi","gu",
 "hm","io","jo","ka","ki","la","li","lo","ma","mi","mm","mo",
 "mu","na","ne","nu","od","oe","oi","om","op","os","ou","ow",
 "oy","pe","pi","po","qi","re","sh","si","ta","ti","ur",
 "ut","wo","xi","xu","ya","za","zo",
}

def keep(w: str) -> bool:
    if not re.fullmatch(r"[a-z]+", w):        # no punctuation, no capitals
        return False
    if len(w) < 3 or len(w) > 15:             # matches the game's word length rule
        return False
    if w in JUNK:
        return False
    # kill obvious abbreviation-shaped debris: no vowels at all
    if not any(c in "aeiouy" for c in w):
        return False
    return True

def main():
    if not os.path.exists(SRC):
        print("ERROR: content/enable.txt not found.")
        print("Download it once from:")
        print("  https://raw.githubusercontent.com/dolph/dictionary/master/enable1.txt")
        print("and save it as content/enable.txt")
        sys.exit(1)

    raw = [l.strip().lower() for l in open(SRC, encoding="utf-8") if l.strip()]
    valid = {w for w in raw if keep(w)}

    # frequency gate: keep only words people actually use
    if os.path.exists(FREQ):
        # Take the top N most frequent words. The list is already ordered by
        # usage, so this is a clean "how obscure will we allow" dial.
        FREQ_LIMIT = 95000
        common = set()
        for i, line in enumerate(open(FREQ, encoding="utf-8", errors="ignore")):
            if i >= FREQ_LIMIT:
                break
            parts = line.split()
            if parts:
                common.add(parts[0].strip().lower())
        words = sorted(valid & common)
        gate = f"frequency-gated against top {len(common):,} words by usage"
    else:
        words = sorted(valid)
        gate = "NO frequency list found - keeping all valid words (noisy!)"
    print(f"    {gate}")

    # Never let a curated word be treated as "just a dictionary word".
    curated = set()
    if os.path.exists(WORDS):
        data = json.load(open(WORDS, encoding="utf-8"))
        curated = {w["spell"] for w in data["words"]}
    words = [w for w in words if w not in curated]

    # ---- WordNet definitions, most-common senses first ----
    # WordNet's index.* files list each word's synsets in order of how often
    # that sense actually occurs in tagged text. Parsing the index rather than
    # the data file means sense 1 is the everyday meaning, not an archaic one.
    glosses = {}
    wnroot = None
    for base, dirs, files in os.walk(os.path.join(ROOT, "content")):
        if "data.noun" in files and "index.noun" in files:
            wnroot = base
            break
    if wnroot:
        print(f"    wordnet found at: {os.path.relpath(wnroot, ROOT)}")
        # Curated words are excluded from the shelves, but we still need their
        # glosses so that inflected forms ("dating" from "date") can inherit.
        want = set(words) | curated

        # Lexnames tell us what kind of thing a sense is. Proper nouns
        # (people, places, groups) rank high for short words and are useless
        # as definitions - "sweet" should not be a Victorian phonetician.
        SKIP_LEX = {"noun.person", "noun.location", "noun.group"}
        lexnames = {}
        lp = os.path.join(wnroot, "lexnames")
        if os.path.exists(lp):
            for line in open(lp, encoding="utf-8", errors="ignore"):
                bits = line.split()
                if len(bits) >= 2:
                    lexnames[bits[0].lstrip("0") or "0"] = bits[1]

        def clean_gloss(g):
            """WordNet glosses often open with scaffolding rather than meaning.
            Drop those clauses and keep the part that actually defines."""
            parts = [c.strip() for c in g.split(";") if c.strip()]
            JUNK_START = ("used of", "used to", "used for", "used in", "used as",
                          "of or ", "relating to", "characteristic of", "(used")
            keep = [c for c in parts if not c.lower().startswith(JUNK_START)]
            # If every clause was scaffolding, fall back to the most substantial
            # one rather than blindly taking the first.
            if not keep:
                keep = sorted(parts, key=len, reverse=True)
            out = keep[0]
            # a stray opening bracket usually means a domain label
            out = re.sub(r"^\([^)]*\)\s*", "", out).strip()
            return out

        cap = {}          # offset -> is this synset a proper noun?

        def load_data(pos):
            """offset -> (gloss, lexname)"""
            out = {}
            fp = os.path.join(wnroot, f"data.{pos}")
            if not os.path.exists(fp):
                return out
            for line in open(fp, encoding="utf-8", errors="ignore"):
                if line.startswith("  ") or "|" not in line:
                    continue
                head, gloss = line.split("|", 1)
                gloss = re.split(r'; "', gloss.strip())[0].strip()
                gloss = clean_gloss(gloss)
                if len(gloss) > 100:
                    gloss = gloss[:100].rsplit(" ", 1)[0] + "\u2026"
                if gloss:
                    gloss = gloss[0].upper() + gloss[1:]
                bits = head.split()
                lex = lexnames.get(bits[1].lstrip("0") or "0", "")
                # a capitalised headword means a name, not a common word
                try:
                    n = int(bits[3], 16)
                    proper = any(bits[4 + 2 * i][0].isupper() for i in range(n))
                except (ValueError, IndexError):
                    proper = False
                out[bits[0]] = (gloss, lex)
                cap[bits[0]] = proper
            return out

        ranked = {}          # word -> [(rank, gloss)] across all parts of speech
        for pos in ("noun", "verb", "adj", "adv"):
            data = load_data(pos)
            fp = os.path.join(wnroot, f"index.{pos}")
            if not os.path.exists(fp):
                continue
            for line in open(fp, encoding="utf-8", errors="ignore"):
                if line.startswith("  "):
                    continue
                parts = line.split()
                if len(parts) < 6:
                    continue
                word = parts[0].lower().replace("_", " ")
                if word not in want:
                    continue
                # offsets sit at the end, already ordered by sense frequency
                try:
                    n_syn = int(parts[2])
                    offsets = parts[-n_syn:]
                except (ValueError, IndexError):
                    continue
                rank = 0
                for off in offsets:
                    got = data.get(off)
                    if not got:
                        continue
                    g, lex = got
                    if lex in SKIP_LEX:          # skip people, places, groups
                        continue
                    if cap.get(off):             # synset word is capitalised
                        continue
                    if len(g) < 8:               # too short to be a definition
                        continue
                    # Vague filler glosses are worse than nothing.
                    if g.lower() in ("extended meanings", "of the highest quality"):
                        continue
                    ranked.setdefault(word, []).append((rank, g))
                    rank += 1

        # Merge across parts of speech by sense rank, so the first adjective
        # sense competes with the first noun sense rather than queueing behind
        # every noun. Without this, "cold" leads with the illness.
        for w, pairs in ranked.items():
            pairs.sort(key=lambda x: x[0])
            out = []
            for _, g in pairs:
                if g not in out:
                    out.append(g)
                if len(out) == 3:
                    break
            glosses[w] = out

        direct = len(glosses)
        # Inflected forms (zapped, macaroons) borrow their base word's senses.
        def bases(w):
            out = []
            if w.endswith("ies") and len(w) > 4: out.append(w[:-3] + "y")
            if w.endswith("es")  and len(w) > 3: out += [w[:-2], w[:-1]]
            if w.endswith("s")   and len(w) > 3: out.append(w[:-1])
            if w.endswith("ing") and len(w) > 5: out += [w[:-3], w[:-3] + "e", w[:-4]]
            if w.endswith("ed")  and len(w) > 4: out += [w[:-2], w[:-1], w[:-3]]
            if w.endswith("er")  and len(w) > 4: out += [w[:-2], w[:-1]]
            if w.endswith("est") and len(w) > 5: out += [w[:-3], w[:-2]]
            if w.endswith("ly")  and len(w) > 4: out.append(w[:-2])
            return out
        # Inflected forms often have a thin or oddly specialised entry of their
        # own - "dating" only carries the geology sense, while the everyday
        # meanings sit under "date". So we top up from the base word whenever
        # a form has fewer than three senses, not only when it has none.
        added = topped = 0
        for w in words:
            have = glosses.get(w, [])
            if len(have) >= 3:
                continue
            for b in bases(w):
                if b not in glosses or b == w:
                    continue
                merged = list(have)
                for g in glosses[b]:
                    if g not in merged:
                        merged.append(g)
                    if len(merged) == 3:
                        break
                if merged != have:
                    if not have:
                        added += 1
                    else:
                        topped += 1
                    glosses[w] = merged
                break
        two = sum(1 for v in glosses.values() if len(v) > 1)
        print(f"    definitions: {len(glosses):,} of {len(words):,} words "
              f"({len(glosses)/max(len(words),1)*100:.0f}%)  "
              f"[{direct:,} direct + {added:,} from base word + {topped:,} topped up]")
        print(f"    with two senses: {two:,}")
    else:
        print("    no wordnet index files found under content/ - no definitions")

    # Group by first letter — this is how the Dictionary page displays shelves,
    # and it keeps lookups small.
    shelves = {}
    for w in words:
        shelves.setdefault(w[0], []).append(w)

    # drop helper-only entries before writing
    glosses = {w: g for w, g in glosses.items() if w in set(words)}
    out = {"schema": 3, "source": "ENABLE x frequency, WordNet glosses",
           "count": len(words), "shelves": shelves, "defs": glosses}
    with open(OUT, "w", encoding="utf-8") as f:
        json.dump(out, f, separators=(",", ":"))

    kb = os.path.getsize(OUT) // 1024
    print(f"OK  ->  content/dictionary.json   ({kb} KB)")
    print(f"    {len(raw):,} raw  ->  {len(words):,} kept "
          f"({len(raw)-len(words):,} filtered out)")
    print(f"    excluded {len(curated)} curated words (they live in words.json)")

if __name__ == "__main__":
    main()
