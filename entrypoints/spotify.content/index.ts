import { defineContentScript } from "wxt/utils/define-content-script";
import {
  enabledItem,
  useSystemPrefItem,
  readEnabled,
  readUseSystemPref,
} from "../../lib/storage";
import lightModeCss from "../../assets/spotify-light/index.css?inline";
import { createInlineStyleObserver } from "./inline-style-observer";

export default defineContentScript({
  matches: ["https://open.spotify.com/*"],
  runAt: "document_start",
  cssInjectionMode: "manual",

  async main(ctx) {
    const styleEl = document.createElement("style");
    styleEl.id = "spotify-light-mode-overrides";
    styleEl.textContent = lightModeCss;

    let currentEnabled: boolean = enabledItem.fallback;
    let currentUseSystemPref: boolean = useSystemPrefItem.fallback;
    const darkQuery = window.matchMedia("(prefers-color-scheme: dark)");
    const inlineStyleObserver = createInlineStyleObserver();

    function shouldApply(): boolean {
      if (!currentEnabled) return false;
      if (currentUseSystemPref) return !darkQuery.matches;
      return true;
    }

    function sync(): void {
      const active = shouldApply();
      if (active && !document.head.contains(styleEl)) {
        document.head.appendChild(styleEl);
      } else if (!active && document.head.contains(styleEl)) {
        document.head.removeChild(styleEl);
      }

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
    });
  },
});
