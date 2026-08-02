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
 "aa","ab","ad","ae","ag","ai","al","ar","aw","ax","ay","ba","bi","bo","br",
 "de","ed","ef","eh","el","em","en","er","es","et","ex","fa","fe","gi","gu",
 "hm","ho","id","io","jo","ka","kaes","ki","la","li","lo","ma","mi","mm","mo",
 "mu","na","ne","nu","od","oe","of","oh","oi","om","op","os","ou","ow","ox",
 "oy","pa","pe","pi","po","qi","re","sh","si","ta","ti","uh","um","un","ur",
 "ut","we","wo","xi","xu","ya","ye","yo","za","zo",
 "aal","aas","aba","abo","abs","aby","ach","ads","adz","aff","aft","aga","ags",
 "aha","ahi","ahs","ais","ait","aka","als","alt","ama","ami","amp","amu","ana",
 "ane","ani","ans","ant","any","apo","app","apt","arb","arc","are","arf","ars",
 "aua","auk","ava","ave","avo","awa","awe","awl","awn","axe","aye","ays","azo",
 "baa","bal","bam","bap","bas","bat","bed","bel","ben","bes","bet","bey","bio",
 "bis","bit","biz","boa","bod","bos","bot","bow","box","bra","bro","brr","bub",
 "bud","bum","bun","bur","bus","but","buy","bye","bys","cad","cam","can","cap",
 "caw","cay","cee","cel","cep","chi","cig","cis","cob","cod","cog","col","con",
 "coo","cop","cor","cos","cot","cow","cox","coy","coz","cru","cud","cue","cum",
 "cup","cur","cut","cwm","dab","dag","dah","dak","dal","dam","dap","daw","deb",
 "dee","def","dei","del","den","dev","dew","dex","dey","dib","did","die","dif",
 "dig","dim","din","dip","dis","dit","div","doc","doe","dol","dom","don","dor",
 "dos","dot","dow","dry","dub","dud","due","dug","duh","dui","dun","duo","dup",
 "dye","ean","ear","eat","eau","ebb","ecu","edh","eds","eek","eel","eff","efs",
 "eft","egg","ego","eke","eld","elf","elk","ell","elm","els","eme","emo","ems",
 "emu","end","eng","ens","eon","era","ere","erg","ern","err","ers","ess","eta",
 "eth","eve","ewe","eye","fab","fad","fag","fan","far","fas","fat","fax","fay",
 "fed","fee","feh","fem","fen","fer","fes","fet","feu","few","fey","fez","fib",
 "fid","fie","fig","fil","fin","fir","fit","fix","fiz","flu","fly","fob","foe",
 "fog","foh","fon","fop","for","fou","fox","foy","fro","fry","fub","fud","fug",
 "fun","fur",
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
        common = set()
        for line in open(FREQ, encoding="utf-8", errors="ignore"):
            parts = line.split()
            if parts:
                common.add(parts[0].strip().lower())
        words = sorted(valid & common)
        gate = f"frequency-gated against {len(common):,} common words"
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

    # ---- WordNet definitions (optional) ----
    glosses = {}
    # find data.noun anywhere under content/ - unzipping often nests a folder
    wnroot = None
    for base, dirs, files in os.walk(os.path.join(ROOT, "content")):
        if "data.noun" in files:
            wnroot = base
            break
    if wnroot:
        print(f"    wordnet found at: {os.path.relpath(wnroot, ROOT)}")
        want = set(words)
        for pos in ("noun", "verb", "adj", "adv"):
            fp = os.path.join(wnroot, f"data.{pos}")
            if not os.path.exists(fp):
                continue
            for line in open(fp, encoding="utf-8", errors="ignore"):
                if line.startswith("  ") or "|" not in line:
                    continue
                head, gloss = line.split("|", 1)
                gloss = re.split(r'; "', gloss.strip())[0].strip().rstrip(";").strip()
                if len(gloss) > 110:
                    gloss = gloss[:110].rsplit(" ", 1)[0] + "\u2026"
                if gloss:
                    gloss = gloss[0].upper() + gloss[1:]
                parts = head.split()
                try:
                    n = int(parts[3], 16)
                except ValueError:
                    continue
                for i in range(n):
                    w = parts[4 + 2 * i].lower().replace("_", " ")
                    if w in want and w not in glosses:
                        glosses[w] = gloss
        print(f"    definitions: {len(glosses):,} of {len(words):,} words "
              f"({len(glosses)/max(len(words),1)*100:.0f}%)")
    else:
        print("    no data.noun found under content/ - revealed words will have no definition")
        print("    (unzip wordnet.zip into content/ so content/wordnet/data.noun exists)")

    # Group by first letter — this is how the Dictionary page displays shelves,
    # and it keeps lookups small.
    shelves = {}
    for w in words:
        shelves.setdefault(w[0], []).append(w)

    out = {"schema": 2, "source": "ENABLE x frequency, WordNet glosses",
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
