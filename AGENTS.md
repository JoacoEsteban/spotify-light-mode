# Agent Handoff: spotify-light-mode

## Project

Spotify Light Mode is a browser extension for `https://open.spotify.com/*`.
It maps Spotify CSS colors to light counterparts and updates dynamic colors at runtime.
WXT builds the extension for Chrome, Firefox, and Edge.

The repository contains generated CSS, icons, store copy, and automated refresh and publication workflows.
Use the source files and `package.json` for current implementation details and dependency versions.

## Investigate color regressions before changing code

Spotify changes stylesheet hashes, numbered chunk names, and selectors between releases.
A stale snapshot can leave a component without its light-mode overrides.

1. Reproduce the color error with the current extension in a headless browser.
2. Compare live stylesheet filenames with `assets/spotify-light/css-manifest.json` and the mounted override elements.
3. If the snapshot is stale, run `bun run ensure:spotify-light-css` before changing the generator or runtime code.
4. Rebuild the extension with `bun run build`.
5. Reload the extension before the next browser test.
6. Examine the normal, hover, and keyboard focus states.
7. Examine the component after each extension toggle.
8. If the error remains with current assets, make the smallest code change that corrects it.

Do not add static overrides only to compensate for renamed CSS chunks before you try a snapshot refresh.
`bun run regenerate` uses the existing snapshot. It does not fetch current Spotify CSS.

A reproduced playback regression illustrates this distinction.
Spotify moved the slider stylesheet from numbered chunk `1617` to `3406`, while the slider selectors stayed the same.
The extension still had overrides for `1617.css`, so the track and fill stayed white.
The native green hover color still worked.
Refreshing the snapshot can restore the missing overrides without a generator change.

## CSS asset pipeline

| Path | Purpose |
| --- | --- |
| `scripts/ensure-latest-spotify-light-css.ts` | Compare current Spotify bundles and source fingerprints with the generated manifest. |
| `scripts/fetch-spotify-css-files.ts` | Fetch desktop and mobile HTML, bundles, and linked or lazy CSS assets. |
| `scripts/extract-spotify-css-files.ts` | Extract Webpack CSS chunk maps with the TypeScript compiler API. |
| `scripts/generate-spotify-light-css.ts` | Generate stylesheet overrides and derived static rules from stored CSS. |
| `scripts/core/source-css-manifest.ts` | Read and write source and output fingerprints. |
| `snapshots/spotify-player/desktop/` | Store formatted desktop source CSS with artifact hashes removed from filenames. |
| `snapshots/spotify-player/mobile/` | Store formatted mobile source CSS with artifact hashes removed from filenames. |
| `assets/spotify-light/desktop/` | Store generated desktop overrides. |
| `assets/spotify-light/mobile/` | Store generated mobile overrides. |
| `assets/spotify-light/static-rules.css` | Store derived rules outside ordinary color mapping. |
| `assets/spotify-light/index.ts` | Import CSS strings and export the stylesheet registry and base CSS. |
| `assets/spotify-light/css-manifest.json` | Record the combined snapshot version and source and output fingerprints. |
| `lib/style-color-mapping.ts` | Map CSS color values and preserve suitable accent colors. |
| `lib/chroma.ts` | Calculate light counterparts with OKLCH color mapping. |

The ensure script compares the combined desktop and mobile bundle version first.
If that version matches and generated files exist, the script skips the refresh.
If the version changes, the script fetches source CSS and compares formatted source fingerprints.
If only artifact hashes change, the script updates manifest metadata without regenerating CSS.
The source fingerprint includes filenames, so renamed chunks also change that fingerprint.

After a generator change, run `bun run ensure:spotify-light-css -- --force` or `bun run regenerate`.
Use `--refresh` to bypass cached downloads during a refresh.

Do not edit generated files under `assets/spotify-light/` directly.
Change the generator or color mapping.
Then regenerate those files.
The repository tracks snapshot CSS and generated overrides.
The repository ignores other snapshot artifacts and `.cache/`.

## Runtime

`entrypoints/spotify.content/index.ts` runs at `document_start` with manual CSS injection.

`StylesheetOverrideMount` mounts an override only when Spotify loads the corresponding source stylesheet.
It removes the eight-character artifact hash from the live filename before matching the registry.
It observes stylesheet changes and load events as Spotify navigates between routes.
The base CSS always includes static rules and `color-scheme: light` while light mode is active.
Generated selectors include a specificity increase.
Declarations preserve source importance, while dynamic mapped values use `!important`.

`InlineStyleObserver` maps inline backgrounds, gradients, color custom properties, and rules in `data-styled` stylesheets.
It batches changes with animation frames and patches `CSSStyleSheet.prototype.insertRule` while active.
It stores original values and restores them when light mode stops.

`entrypoints/background.ts` injects the content script into existing Spotify tabs on each background start.
This activation covers installation, updates, extension activation, and browser startup.
WXT invalidation handlers remove obsolete styles and listeners.
`lib/spotify.ts` supplies the shared URL match pattern.

## Settings and popup

`lib/storage.ts` defines storage items through `wxt/utils/storage` and uses Zod for reads.

| State | Result |
| --- | --- |
| `enabled=false` | Light mode is off. |
| `enabled=true`, `useSystemPref=false` | Light mode is on. |
| `enabled=true`, `useSystemPref=true`, OS light | Light mode is on. |
| `enabled=true`, `useSystemPref=true`, OS dark | Light mode is off. |

The popup writes to local extension storage.
Content scripts observe storage changes and the OS color scheme without a page reload.
All open Spotify tabs receive the same settings.
The popup also contains a review widget with persistent dismissal state.

## Commands and browser tests

| Command | Purpose |
| --- | --- |
| `bun install` | Install dependencies and run `wxt prepare`. |
| `bun run dev` | Run Chrome development mode with HMR. |
| `bun run dev:firefox` | Run Firefox development mode. |
| `bun run dev:edge` | Run Edge development mode. |
| `bun run build` | Build `.output/chrome-mv3/`. |
| `bun run build:firefox` | Build the Firefox extension. |
| `bun run build:edge` | Build the Edge extension. |
| `bun node_modules/typescript/bin/tsc --noEmit` | Run the TypeScript check. |
| `bun run ensure:spotify-light-css` | Fetch and regenerate assets if the current snapshot differs. |
| `bun run refresh:spotify-light-css` | Fetch current source CSS and regenerate overrides. |
| `bun run regenerate` | Regenerate overrides from the stored source snapshot. |
| `bun run zip` | Package the Chrome extension. |
| `bun run screenshot` | Build and capture store screenshots in Chromium. |
| `bun run screenshot:fast` | Capture store screenshots without a build. |
| `bun run screenshot:login` | Save a Spotify session in the project Chromium profile. |

`mise.toml` provides tasks for CSS generation, refresh checks, icon processing, screenshots, and packaging.

Prefer headless browser tests during investigation.
Use the installed `puppeteer-core` and `/Applications/Chromium.app/Contents/MacOS/Chromium` for extension tests.
`scripts/screenshot.ts` uses `.chrome-profile/` and opens visible Chromium windows.
Do not run the screenshot script for background tests.
Do not alter personal Chrome windows or profiles.
If the user requests a manual test, open Chromium with the rebuilt extension after the headless tests pass.

Load the production extension from `.output/chrome-mv3/` through `chrome://extensions`.
The development artifact is `.output/chrome-mv3-dev/`.

If the local Node installation fails on a missing library, run `bun --bun run build`.

## Automation

`.github/workflows/refresh-spotify-css.yml` runs daily at 04:17 UTC and supports manual runs.
It runs the ensure script, commits asset changes, and compares the generated output fingerprint.
If the output changes, it bumps the patch version, creates a release tag, and triggers the publish workflow.
Metadata changes alone do not create a release.

`.github/workflows/publish.yml` supports release tags and manual runs.
It packages Chrome, Firefox, and Edge artifacts and submits them to the browser stores.
A refresh workflow run can therefore lead to a published extension update.

## Tooling and repository rules

Use Bun for dependencies and WXT commands.
TypeScript uses version 5.8 with strict mode and `noUncheckedIndexedAccess`.
The repository has no lint configuration that rejects explicit `any`, ternaries, or `try/catch`.
Apply the personal agent instructions even where tooling does not enforce them.

Use `wxt/utils/storage`, `wxt/utils/define-content-script`, and `wxt/utils/define-background` for WXT imports.
`.wxt/` and `.output/` are generated and ignored.
`wxt prepare` recreates the generated TypeScript configuration under `.wxt/`.
Extension icons are in `public/icon-16.png` through `public/icon-128.png`, including a 96px icon.

This project uses jj with a colocated Git repository.
Use jj commands for repository operations.
Do not change revision descriptions, bookmarks, or history without a user request.
