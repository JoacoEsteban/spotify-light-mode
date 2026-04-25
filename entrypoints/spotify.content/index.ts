import { defineContentScript } from "wxt/utils/define-content-script";
import {
  enabledItem,
  useSystemPrefItem,
  readEnabled,
  readUseSystemPref,
} from "../../lib/storage";
import lightModeCss from "../../assets/spotify-light/index.css?inline";
// import { replaceAll } from "./in-place-color-change";

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
    });
  },
});
