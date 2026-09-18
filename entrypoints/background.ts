import { match, P } from "ts-pattern";
import { browser } from "wxt/browser";
import { defineBackground } from "wxt/utils/define-background";

import { SPOTIFY_MATCHES } from "../lib/spotify";

const CONTENT_SCRIPT_FILES = ["/content-scripts/spotify.js"] as const;
const SHOULD_LOG_INJECTIONS = import.meta.env.DEV;

function logFailedInjection(tabId: number, error: unknown): void {
  if (!SHOULD_LOG_INJECTIONS) return;

  console.debug(
    "%c[spotify-light-mode]%c existing tab %cnot injected",
    "color: #000; background: #1ed760; border-radius: 3px; padding: 1px 4px; font-weight: 700;",
    "color: inherit;",
    "color: #ff6b6b; font-weight: 700;",
    { tabId, error },
  );
}

/**
 * A statically declared content script only runs when a matching page loads, so
 * tabs already open have no script in them: the popup writes to storage and
 * nothing is listening. Injecting them directly closes that gap.
 *
 * Some of those tabs hold an orphan instead of nothing. A disable or an update
 * leaves the previous content script running in a context whose extension APIs
 * are severed — its stylesheets stay mounted but its storage listeners are
 * dead, so light mode is stuck on and the popup toggle does nothing. Starting
 * a fresh script invalidates that orphan, which tears its own stylesheets down
 * before this instance mounts the current ones.
 */
async function injectIntoOpenTabs(): Promise<void> {
  const tabs = await browser.tabs.query({ url: [...SPOTIFY_MATCHES] });

  await Promise.all(
    tabs.map((tab) =>
      match(tab.id)
        .with(P.number, (tabId) =>
          browser.scripting
            .executeScript({ target: { tabId }, files: [...CONTENT_SCRIPT_FILES] })
            .then(() => undefined)
            // A tab can navigate or close mid-flight, and Firefox may not have
            // been granted the host permission. Neither is fatal: the declared
            // script still covers every subsequent page load.
            .catch((error: unknown) => logFailedInjection(tabId, error)),
        )
        .otherwise(() => Promise.resolve()),
    ),
  );
}

export default defineBackground(() => {
  // This runs on every background start: install, update, enable, and browser
  // start. Each of those leaves open Spotify tabs with no script or with an
  // orphan, and `runtime.onInstalled` covers only two of them — it has no
  // reason for an extension being enabled, and there is no `onEnabled` event.
  void injectIntoOpenTabs();
});
