export type StylesheetOverride = {
  sourceFileName: string;
  css: string;
};

type MountedStylesheetOverride = {
  sourceFileName: string;
  styleEl: HTMLStyleElement;
};

type StylesheetOverrideMountOptions = {
  baseCss: string;
  overrides: readonly StylesheetOverride[];
};

const STYLE_ID_PREFIX = "spotify-light-mode-overrides";
const SHOULD_LOG_STYLESHEET_MOUNTS = import.meta.env.DEV;

function logStylesheetMount(action: "mounted" | "unmounted", sourceFileName: string): void {
  if (!SHOULD_LOG_STYLESHEET_MOUNTS) return;

  const color = action === "mounted" ? "#1ed760" : "#ff6b6b";
  console.debug(
    `%c[spotify-light-mode]%c stylesheet override %c${action}`,
    "color: #000; background: #1ed760; border-radius: 3px; padding: 1px 4px; font-weight: 700;",
    "color: inherit;",
    `color: ${color}; font-weight: 700;`,
    { sourceFileName },
  );
}


function rawStylesheetFileName(href: string): string | null {
  const url = new URL(href, document.location.href);
  const fileName = url.pathname.slice(url.pathname.lastIndexOf("/") + 1);
  return fileName.endsWith(".css") ? fileName : null;
}

function sourceStylesheetFileName(href: string): string | null {
  return rawStylesheetFileName(href)?.replace(/\.[0-9a-f]{8}\.css$/i, ".css") ?? null;
}

function mountedStylesheetFileNames(): Set<string> {
  const fileNames = new Set<string>();

  for (const stylesheet of Array.from(document.styleSheets)) {
    if (stylesheet.disabled || stylesheet.href === null) continue;

    const fileName = sourceStylesheetFileName(stylesheet.href);
    if (fileName !== null) {
      fileNames.add(fileName);
    }
  }

  return fileNames;
}

export class StylesheetOverrideMount {
  private readonly baseStyleEl: HTMLStyleElement;
  private readonly observer: MutationObserver;
  private readonly overrideStyleEls: MountedStylesheetOverride[];

  private active = false;
  private observing = false;
  private syncFrameId: number | null = null;

  constructor({ baseCss, overrides }: StylesheetOverrideMountOptions) {
    this.baseStyleEl = document.createElement("style");
    this.baseStyleEl.id = `${STYLE_ID_PREFIX}-base`;
    this.baseStyleEl.textContent = baseCss;

    this.overrideStyleEls = overrides.map(({ sourceFileName, css }) => {
      const styleEl = document.createElement("style");
      styleEl.dataset.spotifyLightModeSourceStylesheet = sourceFileName;
      styleEl.textContent = css;
      return { sourceFileName, styleEl };
    });

    this.observer = new MutationObserver(this.scheduleSync);
  }

  setActive(nextActive: boolean): void {
    if (this.active === nextActive) {
      this.sync();
      return;
    }

    this.active = nextActive;
    this.sync();
  }

  sync(): void {
    this.cancelScheduledSync();

    if (!this.active) {
      this.stopObserving();
      this.unmountAll();
      return;
    }

    const head = document.head;
    if (head === null) {
      this.startObserving();
      return;
    }

    const mountedFileNames = mountedStylesheetFileNames();

    this.stopObserving();
    try {
      for (const { sourceFileName, styleEl } of this.overrideStyleEls) {
        if (mountedFileNames.has(sourceFileName)) {
          if (!styleEl.isConnected) {
            logStylesheetMount("mounted", sourceFileName);
          }
          head.appendChild(styleEl);
        } else {
          if (styleEl.isConnected) {
            logStylesheetMount("unmounted", sourceFileName);
          }
          styleEl.remove();
        }
      }

      head.appendChild(this.baseStyleEl);
    } finally {
      if (this.active) {
        this.startObserving();
      }
    }
  }

  disconnect(): void {
    this.active = false;
    this.cancelScheduledSync();
    this.stopObserving();
    this.unmountAll();
  }

  private stopObserving(): void {
    if (!this.observing) return;

    this.observer.disconnect();
    document.removeEventListener("load", this.onStylesheetLoad, true);
    this.observing = false;
  }

  private startObserving(): void {
    if (this.observing) return;

    const head = document.head;
    const target = head ?? document.documentElement;
    if (target !== null) {
      const options: MutationObserverInit =
        head === null
          ? { childList: true }
          : {
              attributes: true,
              attributeFilter: ["disabled", "href", "media", "rel"],
              childList: true,
              subtree: true,
            };
      this.observer.observe(target, options);
    }
    document.addEventListener("load", this.onStylesheetLoad, true);
    this.observing = true;
  }

  private unmountAll(): void {
    this.baseStyleEl.remove();
    for (const { sourceFileName, styleEl } of this.overrideStyleEls) {
      if (styleEl.isConnected) {
        logStylesheetMount("unmounted", sourceFileName);
      }
      styleEl.remove();
    }
  }

  private readonly onStylesheetLoad = (event: Event): void => {
    if (!(event.target instanceof HTMLLinkElement)) return;
    if (!event.target.relList.contains("stylesheet")) return;

    this.scheduleSync();
  };

  private cancelScheduledSync(): void {
    if (this.syncFrameId === null) return;

    cancelAnimationFrame(this.syncFrameId);
    this.syncFrameId = null;
  }

  private readonly scheduleSync = (): void => {
    if (!this.active || this.syncFrameId !== null) return;

    this.syncFrameId = requestAnimationFrame(() => {
      this.syncFrameId = null;
      this.sync();
    });
  };
}
