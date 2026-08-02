#!/usr/bin/env python3
"""
Vocap — build a single shareable HTML file
==========================================
Takes app/index.html + content/words.json and welds them into ONE file that
runs by double-clicking. No server, no Python, no install for the person you
send it to.

Run from the repo root:
    python content/build_share.py

Produces:
    vocap-share.html      (~800 KB, send this to anyone)

Re-run it whenever you change the game or the words — the shared file is a
snapshot, not a live link.
"""
import json, os, sys, datetime

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
GAME = os.path.join(ROOT, "app", "index.html")
DATA = os.path.join(ROOT, "content", "words.json")
DICT = os.path.join(ROOT, "content", "dictionary.json")
OUT  = os.path.join(ROOT, "vocap-share.html")

def main():
    for path, label in ((GAME, "app/index.html"), (DATA, "content/words.json")):
        if not os.path.exists(path):
            print(f"ERROR: could not find {label}")
            print("       Run this from the repo root: python content/build_share.py")
            sys.exit(1)

    html = open(GAME, encoding="utf-8").read()
    data = json.load(open(DATA, encoding="utf-8"))
    dict_data = json.load(open(DICT, encoding="utf-8")) if os.path.exists(DICT) else None
    if dict_data is None:
        print("NOTE: no dictionary.json found - the shared file will only accept curated words.")
        print("      Run: python content/build_dictionary.py")

    # The dev build fetches its data over HTTP. In the shared file both files
    # are already embedded, so we swap the fetches for immediate resolves.
    needle = """Promise.all([
  fetch('../content/words.json').then(r=>r.json()),
  fetch('../content/dictionary.json').then(r=>r.json()).catch(()=>null)   // optional
])"""
    if needle not in html:
        print("ERROR: couldn't find the data-loading block in index.html.")
        print("       Did the game file change? Tell Claude and it'll update this script.")
        sys.exit(1)
    html = html.replace(needle,
        "Promise.resolve([window.__VOCAP_DATA__, window.__VOCAP_DICT__])")

    stamp = datetime.date.today().isoformat()
    blob = ("<script>window.__VOCAP_DATA__=" +
            json.dumps(data, ensure_ascii=False, separators=(",", ":")) +
            ";window.__VOCAP_DICT__=" +
            json.dumps(dict_data, ensure_ascii=False, separators=(",", ":")) +
            ";</script>\n")

    # Inject the data before the game script so it exists when the game runs.
    html = html.replace("<script>\n/* =====", blob + "<script>\n/* =====", 1)
    html = html.replace("<title>", f"<!-- Vocap shareable build {stamp} -->\n<title>", 1)

    open(OUT, "w", encoding="utf-8").write(html)
    kb = os.path.getsize(OUT) // 1024
    print(f"OK  ->  vocap-share.html   ({kb} KB, {len(data['words'])} words, built {stamp})")
    print("    Send that one file to anyone. They just double-click it.")

if __name__ == "__main__":
    main()
