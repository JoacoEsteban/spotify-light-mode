import { defineContentScript } from "wxt/utils/define-content-script";
import { browser } from "wxt/browser";
import { match, P } from "ts-pattern";
import { enabledItem, useSystemPrefItem, readEnabled, readUseSystemPref } from "../../lib/storage";
import { SPOTIFY_MATCHES } from "../../lib/spotify";
import { baseLightModeCss, lightModeStylesheetOverrides } from "../../assets/spotify-light/index";
import { InlineStyleObserver } from "./inline-style-observer";
import { StylesheetOverrideMount } from "./stylesheet-override-mount";

export default defineContentScript({
  matches: [...SPOTIFY_MATCHES],
  runAt: "document_start",
  cssInjectionMode: "manual",

  async main(ctx) {
    const stylesheetOverrideMount = new StylesheetOverrideMount({
      baseCss: baseLightModeCss,
      overrides: lightModeStylesheetOverrides,
    });
    let currentEnabled: boolean = enabledItem.fallback;
    let currentUseSystemPref: boolean = useSystemPrefItem.fallback;
    const darkQuery = window.matchMedia("(prefers-color-scheme: dark)");
    const inlineStyleObserver = new InlineStyleObserver();

    function shouldApply(): boolean {
      if (!currentEnabled) return false;
      if (currentUseSystemPref) return !darkQuery.matches;
      return true;
    }

    function sync(): void {
      const active = shouldApply();
      stylesheetOverrideMount.setActive(active);

      if (active) {
        inlineStyleObserver.start();
      } else {
        inlineStyleObserver.stop();
      }
    }

    [currentEnabled, currentUseSystemPref] = await Promise.all([
      readEnabled(),
      readUseSystemPref(),
    ]);
    sync();

    const unwatchEnabled = enabledItem.watch((v) => {
      currentEnabled = v;
      sync();
    });
    const unwatchSystemPref = useSystemPrefItem.watch((v) => {
      currentUseSystemPref = v;
      sync();
    });

    const onSchemeChange = (): void => sync();
    darkQuery.addEventListener("change", onSchemeChange);
    ctx.onInvalidated(() => {
      // Chromium severs extension APIs before an updated script invalidates its predecessor.
      match(browser.runtime.id)
        .with(P.string, () => {
          unwatchEnabled();
          unwatchSystemPref();
        })
        .otherwise(() => undefined);
      darkQuery.removeEventListener("change", onSchemeChange);
      inlineStyleObserver.stop();
      stylesheetOverrideMount.disconnect();
    });
  },
});
