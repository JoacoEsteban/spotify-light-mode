import { match, P } from "ts-pattern";
import { browser } from "wxt/browser";
import { defineBackground } from "wxt/utils/define-background";

import { SPOTIFY_MATCHES } from "../lib/spotify";
import { ExtensionUpdate } from "../lib/extension-update";

const CONTENT_SCRIPT_FILES = ["/content-scripts/spotify.js"] as const;
const SHOULD_LOG_TAB_UPDATES = import.meta.env.DEV;

function logFailedTabUpdate(tabId: number, error: unknown): void {
  if (!SHOULD_LOG_TAB_UPDATES) return;

  console.debug(
    "%c[spotify-light-mode]%c existing tab %cupdate failed",
    "color: #000; background: #1ed760; border-radius: 3px; padding: 1px 4px; font-weight: 700;",
    "color: inherit;",
    "color: #ff6b6b; font-weight: 700;",
    { tabId, error },
  );
}

// A disable or an update leaves the previous content script running in a
// context whose extension APIs are severed.
async function updateOpenTabs(action: "reinject" | "reload"): Promise<void> {
  const tabs = await browser.tabs.query({ url: [...SPOTIFY_MATCHES] });

  await Promise.all(
    tabs.map(({ id }) =>
      match(id)
        .with(P.number, (tabId) =>
          match(action)
            .with("reinject", () =>
              browser.scripting.executeScript({
                target: { tabId },
                files: [...CONTENT_SCRIPT_FILES],
              }),
            )
            .with("reload", () => browser.tabs.reload(tabId))
            .exhaustive()
            .then(() => undefined)
            // A tab can navigate or close mid-flight, and Firefox may not have
            // been granted the host permission. Neither is fatal: the declared
            // script still covers every subsequent page load.
            .catch((error: unknown) => logFailedTabUpdate(tabId, error)),
        )
        .otherwise(() => Promise.resolve()),
    ),
  );
}

export default defineBackground(() => {
  browser.runtime.onInstalled.addListener(({ reason, previousVersion }) => {
    const { version: currentVersion } = browser.runtime.getManifest();
    const action = ExtensionUpdate.tabAction({ previousVersion, currentVersion });

    match({ reason, action })
      .with({ reason: "update", action: "reload" }, () => void updateOpenTabs("reload"))
      .otherwise(() => undefined);
  });

  // `runtime.onInstalled` has no reason for an extension being enabled, and
  // there is no `onEnabled` event.
  void updateOpenTabs("reinject");
});
