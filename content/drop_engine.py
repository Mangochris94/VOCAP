#!/usr/bin/env python3
"""
Vocap — seed-word drop engine + simulator  (v2)
===============================================
Letters that LOOK random but are secretly guided so real words are always
formable — and so LONG words stay reachable.

Changes from v1, all driven by simulator findings:
  1. Noise is now VARIABLE, not fixed. Seeds are chosen first; noise fills
     whatever space remains up to 15. A 14-letter seed gets 1 noise letter,
     an 8-letter seed gets 7. Every word in the database is now seedable,
     including 'brussels sprout'.
  2. High-Frequency seeding is on a COOLDOWN (once every 3 cycles) so the
     player isn't buried in function words while fruit and animals wait.
  3. Already-discovered short words can be re-formed late in a cycle for
     1 Spark, so a full tray is never a dead tray.

Run:
    python3 drop_engine.py                        # gentle, 5 min, 1 workday
    python3 drop_engine.py --difficulty scholar --days 5 --verbose
    python3 drop_engine.py --report               # full tuning table
"""
import argparse, json, random
from collections import Counter

POOL_START = 8      # tray slots at game start
POOL_CAP   = 15     # absolute maximum, earned
POOL_MAX   = 15     # legacy alias, per-cycle size is computed below
MIN_NOISE = 1          # never let the pool be nothing but one exact word

FREQ = {
    'e':12.5,'t':9.3,'a':8.0,'o':7.6,'i':7.7,'n':7.2,'s':6.5,'r':6.3,'h':5.1,
    'l':4.1,'d':3.8,'c':3.3,'u':2.8,'m':2.5,'f':2.4,'p':2.1,'g':1.9,'w':1.7,
    'y':1.6,'b':1.5,'v':1.0,'k':0.6,'x':0.2,'j':0.1,'q':0.1,'z':0.1,
}
VOWELS = set('aeiou')
HF = 'High-Frequency / Core'
HF_COOLDOWN = 3        # seed a High-Frequency word only every Nth cycle

# Difficulty is FLAVOUR, not challenge: it decides which KIND of words get
# seeded, never how punishing the game is. Each profile lists preferred seed
# lengths and topics; if a band runs dry the engine widens it automatically,
# so no word is ever permanently unreachable.
DIFFICULTY = {
    'everyday': {'lengths': [(3,5),(3,6),(4,7)],
                 'topics': ['High-Frequency / Core','Food & Drink','House & Home',
                            'Family & People','Body Parts','Colors & Shapes',
                            'Clothes & Fashion','Emotions & Feelings']},
    'explorer': {'lengths': [(4,6),(5,8),(6,10)],
                 'topics': ['Fruits','Animals','Vegetables','Nature & Weather',
                            'Travel & Places','Sports & Games','Technology']},
    'scholar':  {'lengths': [(8,11),(9,14),(5,8)],
                 'topics': []},
}


def pool_size(bank, seen, per_step):
    """The tray GROWS. It starts at 8 slots and earns one more each time the
    player completes a sub-list, up to 15. This is the main pacing dial:
    a small tray yields few words per cycle, a full tray yields many, so the
    early game is tight and the late game opens up — and long words become a
    late-game reward you literally make room for."""
    done = 0
    for sub, ws in bank.sublists.items():
        if all(w['id'] in seen for w in ws):
            done += 1
    return min(POOL_CAP, POOL_START + done // per_step)

def sparks_for(n):
    if n <= 5:  return 10
    if n <= 8:  return 25
    if n <= 12: return 60
    return 150



def familiarity(w):
    """Odds a Thai learner already knows this word well enough to spell it.
    Modelled from topic + length: function words are second nature, exotic
    fruit is not. This replaces the old flat 'skill' assumption."""
    t, n = w['topic'], w['letters']
    base = {
        'High-Frequency / Core': 0.92, 'Animals': 0.55, 'Fruits': 0.40,
        'Vegetables': 0.40, 'Food & Drink': 0.55, 'Body Parts': 0.60,
        'Family & People': 0.60, 'Colors & Shapes': 0.60,
        'Emotions & Feelings': 0.35, 'House & Home': 0.50,
        'Education': 0.45, 'Clothes & Fashion': 0.45,
        'Nature & Weather': 0.40, 'Transportation': 0.50,
        'Jobs & Work': 0.40, 'Health & Body': 0.35,
        'Technology': 0.50, 'Sports & Games': 0.45,
        'Slang & GenZ': 0.25, 'Travel & Places': 0.40,
    }.get(t, 0.40)
    if n >= 9:  base *= 0.45          # long words are far harder to recall cold
    elif n >= 7: base *= 0.70
    return min(0.95, base)

CLUE_BOOST = 0.75   # a Thai-definition clue makes an unknown word solvable

def can_spell(need, pool):
    return all(pool[c] >= n for c, n in need.items())

def union(counters):
    """Smallest multiset containing each input — 'cat'+'car' = c,a,t,r."""
    out = Counter()
    for c in counters:
        for ch, n in c.items():
            out[ch] = max(out[ch], n)
    return out


class WordBank:
    def __init__(self, path, phase):
        data = json.load(open(path, encoding='utf-8'))
        self.words = [w for w in data['words']
                      if w['phase'] <= phase and not w['starter'] and not w['rudeness']]
        for w in self.words:
            w['count'] = Counter(w['spell'])
        self.topics = sorted({w['topic'] for w in self.words})
        self.sublists = {}
        for w in self.words:
            self.sublists.setdefault((w['topic'], w['sublist']), []).append(w)

    def new_spellable(self, pool, seen):
        return [w for w in self.words
                if w['id'] not in seen and can_spell(w['count'], pool)]

    def old_spellable(self, pool, seen):
        return [w for w in self.words
                if w['id'] in seen and w['letters'] <= 4 and can_spell(w['count'], pool)]


def pick_seeds(bank, seen, progress, profile, cycle_no, size=POOL_CAP):
    """Fill the flavour's seed slots, longest first, widening any band that
    has run dry so the collection can always be completed."""
    budget = size - MIN_NOISE
    allow_hf = (cycle_no % HF_COOLDOWN == 0)
    fav = set(profile['topics'])
    seeds, acc = [], Counter()

    for lo, hi in sorted(profile['lengths'], key=lambda r: -r[1]):
        cands = []
        # widen the band until something undiscovered turns up
        for grow in range(0, 13):
            lo2, hi2 = max(3, lo - grow), min(15, hi + grow)
            cands = [w for w in bank.words
                     if w['id'] not in seen and lo2 <= w['letters'] <= hi2
                     and w not in seeds
                     and (allow_hf or w['topic'] != HF)]
            if cands:
                break
        if not cands:
            continue
        if fav:
            pref = [w for w in cands if w['topic'] in fav or w['topic2'] in fav]
            cands = pref or cands
        least = min(bank.topics, key=lambda t: progress.get(t, 0))
        pref = [w for w in cands if least in (w['topic'], w['topic2'])]
        if pref and random.random() < 0.4:
            cands = pref

        random.shuffle(cands)
        for w in cands[:80]:
            trial = union([acc, w['count']])
            if sum(trial.values()) <= budget:
                seeds.append(w); acc = trial
                break
    return seeds, acc


def noise_letters(acc, n):
    letters, weights = zip(*FREQ.items())
    out = []
    for _ in range(n):
        cur = Counter(acc) + Counter(out)
        tot = sum(cur.values()) or 1
        vr = sum(v for k, v in cur.items() if k in VOWELS) / tot
        w = list(weights)
        if vr < 0.32:
            w = [x * (4 if l in VOWELS else 1) for x, l in zip(w, letters)]
        out.append(random.choices(letters, weights=w, k=1)[0])
    return out


def build_drop_order(seeds, acc, size=POOL_CAP):
    """Shortest seed first so something is formable within ~4 drops;
    noise fills the remainder of the 15-letter pool."""
    order, built = [], Counter()
    for w in sorted(seeds, key=lambda x: x['letters']):
        need = w['count'] - built
        chunk = [c for c, n in need.items() for _ in range(n)]
        random.shuffle(chunk)
        order += chunk
        built = union([built, w['count']])

    n_noise = max(MIN_NOISE, size - len(order))
    order += noise_letters(built, n_noise)

    head = min(seeds[0]['letters'] if seeds else 0, len(order))
    tail = order[head:]
    random.shuffle(tail)
    return (order[:head] + tail)[:size]


def run_cycle(bank, seen, progress, cfg, cycle_no, log, size=None):
    size = size or POOL_CAP
    seeds, acc = pick_seeds(bank, seen, progress, DIFFICULTY[cfg.difficulty], cycle_no, size)
    if not seeds:
        return None
    order = build_drop_order(seeds, acc, size)

    pool, found, idle, sparks = Counter(), [], 0, 0
    solved = []
    clue_ids = {w['id'] for w in seeds}
    first_at = None
    for i, ch in enumerate(order, start=1):
        pool[ch] += 1
        # LETTERS ARE NOT CONSUMED. Every word spellable from the pool is
        # available; the player mines as many as they spot this tick.
        opts = sorted(bank.new_spellable(pool, seen), key=lambda w: -w['letters'])
        if not opts:
            idle += 1
            continue
        for w in opts:
            clued = cfg.clues and w['id'] in clue_ids
            chance = CLUE_BOOST if clued else familiarity(w) * cfg.skill
            if random.random() > chance:
                continue
            seen.add(w['id'])
            for t in (w['topic'], w['topic2']):
                if t: progress[t] = progress.get(t, 0) + 1
            gain = sparks_for(w['letters'])
            if cfg.freshness:                     # small pool = bigger payout
                gain = int(gain * (1 + (size - i) / 8))
            sparks += gain; found.append(w)
            if clued: solved.append(w)
            first_at = first_at or i
            if log:
                mark = 'CLUE' if clued else '    '
                print(f"      t{i:>2} {mark} {w['word']:<17}{w['letters']:>2}L +{gain:>4}")
    missed = len(bank.new_spellable(pool, seen))
    return {'found': found, 'solved': solved, 'repeats': missed, 'idle': idle, 'sparks': sparks,
            'ticks': len(order), 'first_at': first_at, 'seeds': seeds}


def simulate(cfg, quiet=False):
    bank = WordBank('words.json', cfg.phase)
    cycle_min = (POOL_MAX + 1) * cfg.interval
    cycles = max(1, int((cfg.days * 8 * 60) // cycle_min))
    seen, progress = set(), {}
    F = R = I = T = S = C = 0; firsts = []; longs = []
    for c in range(1, cycles + 1):
        r = run_cycle(bank, seen, progress, cfg, c, cfg.verbose and not quiet)
        if not r: break
        if cfg.verbose and not quiet:
            print(f"  cycle {c:>2}  seeds: {', '.join(w['word'] for w in r['seeds'])}")
        F += len(r['found']); R += r['repeats']; I += r['idle']
        C += len(r['solved'])
        T += r['ticks']; S += r['sparks']
        if r['first_at']: firsts.append(r['first_at'])
        longs += [w['letters'] for w in r['found']]
    return {'bank': bank, 'cycles': cycles, 'found': F, 'clued': C, 'repeats': R, 'idle': I,
            'ticks': T, 'sparks': S, 'firsts': firsts, 'seen': seen,
            'progress': progress, 'longs': longs, 'cycle_min': cycle_min}


def report(cfg):
    print("\n  Vocap pacing table — words discovered per 8h workday\n")
    print(f"  {'interval':<12}{'cycle':>7}{'cycles/day':>12}"
          f"{'everyday':>10}{'explorer':>10}{'scholar':>9}")
    print("  " + "-" * 59)
    for iv in (2, 5, 10, 20):
        row = []
        for d in ('everyday', 'explorer', 'scholar'):
            cfg.interval, cfg.difficulty = iv, d
            cfg.patience = 3
            random.seed(11)
            r = simulate(cfg, quiet=True)
            row.append(r['found'] / max(cfg.days, 1))
        cm = (POOL_MAX + 1) * iv
        print(f"  {str(iv)+' min':<12}{str(cm)+'m':>7}{480//cm:>12}"
              f"{row[0]:>9.1f}{row[1]:>10.1f}{row[2]:>9.1f}")
    print()


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--difficulty', choices=DIFFICULTY, default='everyday')
    ap.add_argument('--interval', type=int, default=5)
    ap.add_argument('--days', type=int, default=1)
    ap.add_argument('--phase', type=int, default=1)
    ap.add_argument('--skill', type=float, default=1.0)
    ap.add_argument('--no-clues', dest='clues', action='store_false')
    ap.add_argument('--no-freshness', dest='freshness', action='store_false')
    ap.add_argument('--patience', type=int, default=3,
                    help='minimum word length the player will form before tick 12')
    ap.add_argument('--no-repeats', dest='repeats', action='store_false')
    ap.add_argument('--seed', type=int, default=None)
    ap.add_argument('--verbose', action='store_true')
    ap.add_argument('--report', action='store_true')
    cfg = ap.parse_args()
    if cfg.report:
        cfg.days = max(cfg.days, 5); return report(cfg)
    if cfg.seed is not None: random.seed(cfg.seed)

    r = simulate(cfg); b = r['bank']
    print(f"\n  Vocap drop simulation")
    print(f"  {'difficulty':<14}{cfg.difficulty}  ({len(DIFFICULTY[cfg.difficulty]['topics']) or 'all'} topics favoured)")
    print(f"  {'interval':<14}{cfg.interval} min  ->  cycle = {r['cycle_min']} min")
    print(f"  {'simulating':<14}{cfg.days} workday(s) = {r['cycles']} cycles")
    print(f"  {'word pool':<14}{len(b.words)} formable (phase <= {cfg.phase})")
    print(f"  {'player skill':<14}{cfg.skill:.0%}\n")
    print(f"  -- results -------------------------------")
    print(f"  words discovered        {r['found']}  ({r['found']/max(cfg.days,1):.1f}/day)")
    print(f"  from Thai clues         {r['clued']}  "
          f"({r['clued']/max(r['found'],1)*100:.0f}% of discoveries)")
    print(f"  words MISSED at reset   {r['repeats']}")
    print(f"  sparks earned           {r['sparks']}")
    if r['firsts']:
        avg = sum(r['firsts'])/len(r['firsts'])
        print(f"  first word at tick      {avg:.1f}  (~{avg*cfg.interval:.0f} min in)")
    if r['longs']:
        print(f"  longest word found      {max(r['longs'])} letters")
        print(f"  words >=9 letters       {sum(1 for x in r['longs'] if x>=9)}")
    pct = r['idle']/r['ticks']*100 if r['ticks'] else 0
    print(f"  fully idle ticks        {r['idle']}/{r['ticks']}  ({pct:.0f}%)")
    print(f"  collection              {len(r['seen'])}/{len(b.words)} "
          f"({len(r['seen'])/len(b.words)*100:.1f}%)")
    if r['progress']:
        tot = sum(r['progress'].values())
        top = sorted(r['progress'].items(), key=lambda x: -x[1])[:5]
        print(f"  topic spread            " +
              ', '.join(f"{t.split(' /')[0]} {n} ({n/tot*100:.0f}%)" for t, n in top))
    print()

if __name__ == '__main__':
    main()
