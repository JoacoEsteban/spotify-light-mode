# Agent Handoff: spotify-light-mode

## What this project is

A browser extension (Manifest V3, Chrome + Firefox) that forces the Spotify web player (`open.spotify.com`) into light mode by overriding its CSS design tokens. Built with WXT + Bun + React + TypeScript strict + Zod.

## Current status

**Fully scaffolded and building.** `bun run build` produces a clean `.output/chrome-mv3/` artifact with no TypeScript errors. The extension has not been manually tested in a browser yet — that's the next step.

## Tech stack decisions and why

| Choice | Reason |
|---|---|
| **WXT 0.20.25** | Extension framework — handles manifest generation, entrypoint discovery, HMR dev mode |
| **Bun** | Package manager and dev runner (`bun run dev`) |
| **React** | Popup UI via `@wxt-dev/module-react` (sets up JSX + fast refresh automatically) |
| **TypeScript 5.8** (pinned, not latest 6.x) | TS 6.0.3 was installed initially but had to be downgraded — WXT's internal tooling (`jiti`) and some deps don't support TS 6 yet |
| **Zod** | Runtime validation on storage reads. Typia was the original choice but its Vite plugin (`@ryoppippi/unplugin-typia`) has a broken import path for `typia/lib/transform.js` vs `typia/lib/transform` in typia@12's exports map — not worth fighting |
| **`wxt/utils/storage`** | Correct import path (NOT `wxt/storage` — that path doesn't exist in WXT 0.20.25 exports) |
| **`cssInjectionMode: 'manual'`** | Lets the content script dynamically append/remove the `<style>` tag. `'manifest'` mode injects unconditionally and can't be toggled without re-registering the content script |
| **`.gitignore`** | jj reads `.gitignore` natively — no `.jjignore` needed |
| **Storage as message bus** | Popup writes to `browser.storage.local`; content script reacts via `WxtStorageItem.watch()`. No `browser.runtime.sendMessage` needed, works across all open Spotify tabs simultaneously |

## File map

```
/
├── wxt.config.ts                         WXT config + manifest overrides
├── tsconfig.json                         Extends .wxt/tsconfig.json, adds strict flags
├── package.json                          Scripts + pinned deps
├── .gitignore                            node_modules/, .output/, .wxt/, *.zip
├── lib/
│   └── storage.ts                        Storage keys + Zod-validated read helpers
├── assets/
│   └── spotify-light.css                 All CSS overrides (Encore token vars + structural selectors)
└── entrypoints/
    ├── spotify.content/index.ts          Content script: injects/removes <style>, reacts to storage + OS theme
    └── popup/
        ├── index.html                    Popup HTML shell
        ├── main.tsx                      React root mount
        ├── App.tsx                       Two-toggle settings UI
        └── App.css                       CSS-only toggle switch, 280px popup
```

Generated (do not edit, in `.gitignore`):
- `.wxt/` — type definitions, generated tsconfig. Recreated by `bun run postinstall` / `wxt prepare`
- `.output/` — build artifacts

## Spotify page snapshot

`snapshots/open.spotify.com_snapshot-2025-04-25.html` is a full browser-saved snapshot of the Spotify web player taken 2025-04-25. The companion `snapshots/open.spotify.com_snapshot-2025-04-25_files/` directory contains all assets it references (CSS, JS bundles, images).

**Why it exists:** lets you audit the real CSS token values and DOM structure without needing a live Spotify session. Key files to grep when refining overrides:

| File | What's in it |
|---|---|
| `web-player.86a99def.css` | Main web player stylesheet — where the dark base token defaults live (e.g. `--background-base:#121212`) and all per-context theme overrides (album art dynamic colors etc.) |
| `encore~web-player.58609446.js` | Encore design system JS bundle — sets tokens inline; this is why `!important` is required in overrides |
| `styles__ltr.css` | Global layout and typography styles |
| `dwp-top-bar.0ec3bbd9.css`, `dwp-now-playing-bar.41972fd4.css`, etc. | Per-component DWP (Dynamic Web Player) stylesheets — useful when a specific region isn't responding to token overrides |

**Key findings from the snapshot:**
- Default dark base: `--background-base: #121212`, `--background-elevated-base: #1b1b1b`, `--background-elevated-highlight: #2a2a2a`
- Spotify sets many contextual overrides (per album art palette) as inline styles via JS — `!important` in `assets/spotify-light.css` is mandatory, not optional
- Token namespaces confirmed: `--background-*`, `--text-*`, `--essential-*`, `--decorative-*`

**`.gitignore` note:** `snapshots/open.spotify.com_snapshot-2025-04-25_files/ab676*` is gitignored (album art images with that prefix). Everything else in `snapshots/` is tracked.

## Settings logic

```
enabled=false          → always OFF
enabled=true, useSystemPref=false       → always ON
enabled=true, useSystemPref=true, OS=light → ON
enabled=true, useSystemPref=true, OS=dark  → OFF
```

Three reactive sources in the content script keep this in sync without page reload:
1. `enabledItem.watch()` — fires when popup changes the toggle
2. `useSystemPrefItem.watch()` — fires when popup changes the second toggle
3. `window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change')` — fires on OS theme change

All three are cleaned up via `ctx.onInvalidated()`.

## CSS override strategy

Spotify uses the [Encore](https://encore.dev/) design system. All color tokens live on `:root` as CSS custom properties in three namespaces: `--background-*`, `--text-*`, `--essential-*`, `--decorative-*`. The override file (`assets/spotify-light.css`) sets light values on these with `!important` (required because Spotify also sets them via inline JS styles). `color-scheme: light !important` is critical — it forces native browser UI (scrollbars, inputs, selection highlights) into light mode too.

## WXT-specific gotchas encountered

- **`wxt/storage` doesn't exist** — use `wxt/utils/storage`
- **`wxt/utils/define-content-script`** is the correct path for `defineContentScript`
- **`postinstall` runs `wxt prepare`** which requires entrypoints to exist — if you add deps before creating entrypoints it will fail. Use `--ignore-scripts` flag on `bun add` first, create entrypoints, then run `wxt prepare` manually
- **`.wxt/tsconfig.json`** is auto-generated and must exist before TypeScript works — it's created by `wxt prepare`. The root `tsconfig.json` just extends it
- **CSS `?inline` import** — Vite/WXT inlines the CSS file as a string literal in the JS bundle. This is what lets the content script inject it as a `<style>` tag dynamically

## Dev workflow

```sh
bun run dev          # Chrome HMR dev mode; loads extension automatically
bun run dev:firefox  # Firefox variant
bun run build        # Production build → .output/chrome-mv3/
bun run zip          # Zips the build for distribution
```

Load unpacked: Chrome → `chrome://extensions` → "Load unpacked" → select `.output/chrome-mv3-dev/`

## VCS

jj with git colocate (both `.jj/` and `.git/` exist). Use jj commands only — never plain git. The working copy has not been committed yet.

## What hasn't been done yet

- Manual browser test (extension not loaded and verified in a real browser)
- CSS completeness check — grep `snapshots/open.spotify.com_snapshot-2025-04-25_files/web-player.86a99def.css` for any `--background-*`, `--text-*`, `--essential-*`, `--decorative-*` tokens not yet covered in `assets/spotify-light.css`, then verify against a live browser session
- Firefox build test (`bun run build:firefox`)
- Icons — no extension icons provided; browser shows a default puzzle piece. Add PNGs at `public/icon/16.png`, `32.png`, `48.png`, `128.png` and WXT will pick them up automatically
- First jj commit
