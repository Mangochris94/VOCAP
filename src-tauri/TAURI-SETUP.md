# Vocap — desktop build

The desktop app is the *same* web app in a native window. There is one
codebase. Nothing in `app/` knows or cares whether it is running in a browser
or in Tauri, so the web version keeps working exactly as it does now.

```
vocap/
├─ app/                 ← the game (browser AND desktop both use this)
│   ├─ index.html
│   ├─ words.json
│   └─ dictionary.json
├─ content/             ← build scripts, source data
└─ src-tauri/           ← native wrapper only
    ├─ tauri.conf.json
    ├─ Cargo.toml
    ├─ build.rs
    ├─ icons/
    └─ src/main.rs
```

## Install once

1. **Rust** — <https://rustup.rs> · run it, accept the defaults
2. **C++ Build Tools** — <https://visualstudio.microsoft.com/visual-cpp-build-tools/>
   · choose *Desktop development with C++* (this is the big download)
3. **WebView2** — already present on Windows 11

Check it worked:

```
rustc --version
cargo --version
```

## Install the Tauri CLI

```
cargo install tauri-cli --version "^2"
```

Takes a few minutes the first time.

## Run it

From the project root (the folder containing both `app/` and `src-tauri/`):

```
cargo tauri dev
```

First run compiles a lot of Rust and is slow. After that it is quick.
A small always-on-top window should appear with Vocap in it.

## Build an installer

```
cargo tauri build
```

Output lands in `src-tauri/target/release/bundle/`.

## What the wrapper does

* **Always on top** — set in config and re-asserted at startup, because some
  window managers ignore the initial flag.
* **Remembers its position and size** between sessions, via the window-state
  plugin. Ambient apps that reset their position every launch are annoying.
* **Starts at 460×620** near the top-left, small enough to sit beside real work.

## Still to do later

* Replace the placeholder icons in `src-tauri/icons/` — they are a plain gold
  circle, deliberately obvious so nobody mistakes them for finished art.
* Tray icon and minimise-to-tray.
* Launch at startup.
* Code signing before public release, or Windows will warn on install.

## The web version

Unaffected. `python -m http.server` still works, and the folder can be
deployed to GitHub Pages as-is when the repo goes public.
