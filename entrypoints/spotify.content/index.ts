import { defineContentScript } from "wxt/utils/define-content-script";
import { enabledItem, useSystemPrefItem, readEnabled, readUseSystemPref } from "../../lib/storage";
import { baseLightModeCss, lightModeStylesheetOverrides } from "../../assets/spotify-light/index";
import { InlineStyleObserver } from "./inline-style-observer";
import { StylesheetOverrideMount } from "./stylesheet-override-mount";

export default defineContentScript({
  matches: ["https://open.spotify.com/*"],
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

    ctx.onInvalidated(
      enabledItem.watch((v) => {
        currentEnabled = v;
        sync();
      }),
    );

    ctx.onInvalidated(
      useSystemPrefItem.watch((v) => {
        currentUseSystemPref = v;
        sync();
      }),
    );

    const onSchemeChange = (): void => sync();
    darkQuery.addEventListener("change", onSchemeChange);
    ctx.onInvalidated(() => {
      darkQuery.removeEventListener("change", onSchemeChange);
      inlineStyleObserver.stop();
      stylesheetOverrideMount.disconnect();
    });
  },
});
