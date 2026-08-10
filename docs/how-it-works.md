# How the extension works

This document explains the CSS asset flow and the runtime behavior of Spotify Light Mode.

## Overview

Spotify Light Mode changes the Spotify web player with generated CSS.
The extension does not fetch CSS while a user browses Spotify.
All Spotify CSS snapshots and generated light-mode CSS are committed to the repository.

The flow has three parts:

1. The refresh scripts find and store Spotify CSS assets.
2. The generator creates light-mode CSS from those stored assets.
3. The content script injects the generated CSS at runtime.

## Asset fetching

The main command is:

```sh
bun run ensure:spotify-light-css
```

This command runs `scripts/ensure-latest-spotify-light-css.ts`.
It fetches `https://open.spotify.com/` with desktop and mobile user agents.
Spotify returns different player bundles for those user agents.

The script finds these assets for each target:

- The main player JavaScript bundle.
- The main player CSS stylesheet, when Spotify includes it in the HTML.
- The lazy CSS chunk files that the JavaScript bundle declares through Webpack.

The JavaScript bundle is large, so the extractor does not use broad text parsing.
`scripts/extract-spotify-css-files.ts` parses the bundle with the TypeScript compiler API.
It finds the Webpack `miniCssF` assignment and reads the object maps inside it.
One map gives chunk names, and one map gives CSS hashes.
The extractor combines them as `<name>.<hash>.css`.
Then it resolves each file name against the Webpack public path.

The fetch script stores the files under this directory:

```text
snapshots/<combined-version>/<target>/
```

For example:

```text
snapshots/spotify-player.web-player.91c889e0__mobile-web-player.435c86e5/desktop/web-player.9addd7cc.css
snapshots/spotify-player.web-player.91c889e0__mobile-web-player.435c86e5/mobile/mobile-web-player.95a293f3.css
```

The combined version includes the desktop bundle hash and the mobile bundle hash.
As a result, either bundle can cause a refresh.

The script also caches JavaScript bundles under `.cache/spotify-web-player/<target>/`.
The cache prevents repeated downloads during local development.
Use `--refresh` to fetch the JavaScript bundles again.

## Style generation

The main command is:

```sh
bun run generate:spotify-light-css -- --version spotify-player.web-player.91c889e0__mobile-web-player.435c86e5
```

The refresh command can also run the generator:

```sh
bun run refresh:spotify-light-css
```

`scripts/generate-spotify-light-css.ts` reads all CSS files in the selected snapshot directory.
It reads the `desktop/` and `mobile/` subdirectories.
It finds CSS declarations that contain colors.
It maps dark colors to light counterparts with `lib/style-color-mapping.ts`.
Colorful accent colors are preserved when they have acceptable contrast on white.

The generator writes the output under this directory:

```text
assets/spotify-light/<combined-version>/
```

It also writes two shared files:

```text
assets/spotify-light/static-rules.css
assets/spotify-light/index.ts
```

`static-rules.css` contains hand-written rules that do not come from Spotify CSS tokens.
`index.ts` imports every generated CSS file with Vite `?inline` imports.
As a result, WXT bundles the CSS as strings in the content script.

The generated index exports one string.
This string contains all generated CSS, the static rules, and a `color-scheme: light` rule.
The `color-scheme` rule makes native browser UI use light controls.


## Runtime behavior

The content script is `entrypoints/spotify.content/index.ts`.
WXT runs it on `https://open.spotify.com/*` at `document_start`.
The content script uses `cssInjectionMode: "manual"`.
This mode lets the script add and remove its `<style>` element without a page reload.

At startup, the content script reads two values from extension storage:

- `local:enabled`
- `local:useSystemPref`

The runtime decision is:

| State | Result |
|---|---|
| `enabled=false` | Light mode is off. |
| `enabled=true`, `useSystemPref=false` | Light mode is on. |
| `enabled=true`, `useSystemPref=true`, OS light mode | Light mode is on. |
| `enabled=true`, `useSystemPref=true`, OS dark mode | Light mode is off. |

When light mode is on, the script appends this element to `document.head`:

```html
<style id="spotify-light-mode-overrides">...</style>
```

When light mode is off, the script removes that element.
The script also starts or stops the inline style observer at the same time.

The script reacts to three changes without a page reload:

- The user changes `local:enabled` in the popup.
- The user changes `local:useSystemPref` in the popup.
- The operating system color scheme changes.

WXT calls the cleanup handlers when the content script is invalidated.
The cleanup removes the color-scheme listener and stops the inline style observer.

## Inline style observer

Spotify also writes colors outside normal stylesheet files.
For example, Spotify can set inline style attributes and `data-styled` style sheets.
The generated CSS cannot cover those values by selector alone.

`entrypoints/spotify.content/inline-style-observer.ts` handles those dynamic colors.
It maps these values while light mode is active:

- Inline `background-image` values.
- Inline `background-color` values.
- Inline custom properties that start with `--`.
- Rules inserted into `data-styled` style sheets.

The observer stores the original values before it writes replacements.
When light mode turns off, it restores those original values.
This restoration makes the Spotify page return to its normal dark theme.

The observer patches `CSSStyleSheet.prototype.insertRule` while it runs.
This patch lets it process new rules that styled-components inserts after page load.
The observer removes the patch when light mode turns off.

## Popup and storage

The popup UI writes settings to `browser.storage.local` through `wxt/utils/storage`.
The content script watches the same storage items.
This storage-based design updates all open Spotify tabs at the same time.
It does not need `browser.runtime.sendMessage`.

The extension requests only the `storage` permission.
It does not request Spotify account data.
It does not make runtime network requests from the content script.