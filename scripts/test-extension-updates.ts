import assert from "node:assert/strict";
import { cp, mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import puppeteer, { type Browser, type Page } from "puppeteer-core";
import { match } from "ts-pattern";
import { binding } from "ts-pattern-binding";
import { z } from "zod";

import { ExtensionUpdate } from "../lib/extension-update";

const output = resolve(".cache/update-proof");
const extensionPath = resolve(output, "extension");
const styleSelector =
  "#spotify-light-mode-overrides-base, [data-spotify-light-mode-source-stylesheet]";
const snapshotSchema = z.object({
  documentId: z.string(),
  version: z.string(),
  color: z.string(),
  styleCount: z.number(),
  sources: z.array(z.string()),
  currentTime: z.number(),
  paused: z.boolean(),
  pauses: z.number(),
});

class ExtensionUpdateProof {
  private readonly results: object[] = [];
  private readonly navigations = new Map<Page, number>();
  private readonly pageErrors: string[] = [];

  private constructor(
    private readonly browser: Browser,
    private readonly manager: Page,
    private readonly extensionId: string,
    private readonly contentScript: string,
    private readonly manifest: Record<string, unknown>,
    private readonly pages: readonly Page[],
    private readonly unrelated: Page,
    private readonly sourceStylesheet: { sourceFileName: string; css: string },
  ) {}

  static async run(): Promise<void> {
    const { bind, ref } = binding();
    assert.equal(
      match(undefined)
        .with(ref, () => true)
        .otherwise(() => false),
      false,
    );
    for (const [values, expected] of [
      [[undefined, undefined], true],
      [[NaN, NaN], true],
      [[-0, 0], false],
      [[7, 7], true],
    ] as const) {
      assert.equal(
        match(values)
          .with([bind, ref], () => true)
          .otherwise(() => false),
        expected,
      );
    }

    for (const [previousVersion, currentVersion, expected] of [
      ["1.6.9", "1.6.10", "reinject"],
      ["1.6.0", "1.6.0", "reinject"],
      ["1.6.1", "1.6.0", "reinject"],
      ["1.6.9", "1.7.0", "notify"],
      ["1.9.9", "2.0.0", "notify"],
      ["invalid", "1.6.0", "notify"],
      [undefined, "1.6.0", "notify"],
      ["1.6.0", "invalid", "notify"],
    ] as const) {
      assert.equal(ExtensionUpdate.tabAction({ previousVersion, currentVersion }), expected);
    }

    await mkdir(output, { recursive: true });
    await rm(extensionPath, { recursive: true, force: true });
    await cp(resolve(".output/chrome-mv3"), extensionPath, { recursive: true });
    const contentScript = await readFile(
      resolve(extensionPath, "content-scripts/spotify.js"),
      "utf8",
    );
    const manifest = z
      .record(z.string(), z.unknown())
      .parse(JSON.parse(await readFile(resolve(extensionPath, "manifest.json"), "utf8")));
    await this.writeVersion({ contentScript, manifest, version: "1.6.0", color: "#000000" });
    const sourceStylesheet = await this.sliderStylesheet();
    const profile = resolve(output, "profile");
    await rm(profile, { recursive: true, force: true });

    const browser = await puppeteer.launch({
      executablePath: "/Applications/Chromium.app/Contents/MacOS/Chromium",
      headless: true,
      ignoreDefaultArgs: ["--disable-extensions"],
      protocolTimeout: 10000,
      targetFilter: (target) => target.type() !== "service_worker",
      userDataDir: profile,
      defaultViewport: { width: 960, height: 480 },
      args: [
        `--disable-extensions-except=${extensionPath}`,
        `--load-extension=${extensionPath}`,
        "--no-first-run",
        "--no-default-browser-check",
        "--mute-audio",
        "--autoplay-policy=no-user-gesture-required",
        "--disable-background-timer-throttling",
        "--disable-renderer-backgrounding",
      ],
    });

    await (async () => {
      const manager = await browser.newPage();
      await manager.goto("chrome://extensions");
      await manager.evaluate(
        "chrome.developerPrivate.updateProfileConfiguration({inDeveloperMode:true})",
      );
      const extensions = z
        .array(z.object({ id: z.string(), name: z.string() }))
        .parse(
          await manager.evaluate(
            "new Promise(resolve => chrome.developerPrivate.getExtensionsInfo({}, resolve))",
          ),
        );
      const extension = extensions.find(({ name }) => name === "Spotify Light Mode");
      assert.ok(extension, "Unpacked extension was not loaded");
      const { id: extensionId } = extension;
      const pages = await Promise.all([browser.newPage(), browser.newPage()]);
      const unrelated = await browser.newPage();
      await unrelated.setContent("<h1>Unrelated tab</h1>");
      const proof = new ExtensionUpdateProof(
        browser,
        manager,
        extensionId,
        contentScript,
        manifest,
        pages,
        unrelated,
        sourceStylesheet,
      );
      await proof.verify();
    })().finally(() => browser.close());
  }

  private static async sliderStylesheet(): Promise<{ sourceFileName: string; css: string }> {
    const directory = resolve("snapshots/spotify-player/desktop");
    const files = await readdir(directory);
    const stylesheets = await Promise.all(
      files
        .filter((file) => file.endsWith(".css"))
        .map(async (sourceFileName) => ({
          sourceFileName,
          css: await readFile(resolve(directory, sourceFileName), "utf8"),
        })),
    );
    const stylesheet = stylesheets.find(({ css }) => css.includes(".qlztBvYSudkICUPJU5Lk {"));
    assert.ok(stylesheet, "Current snapshot does not contain the Spotify slider fixture selectors");
    return stylesheet;
  }

  private static async writeVersion({
    contentScript,
    manifest,
    version,
    color,
  }: {
    contentScript: string;
    manifest: Record<string, unknown>;
    version: string;
    color: string;
  }): Promise<void> {
    assert.ok(contentScript.includes("color-scheme: light !important;"));
    assert.ok(contentScript.includes("--fg-color:#000}"));
    const updatedCss = contentScript
      .replace(
        "color-scheme: light !important;",
        `color-scheme: light !important; --extension-update-proof: ${version};`,
      )
      .replaceAll("--fg-color:#000}", `--fg-color:${color}}`);
    await writeFile(resolve(extensionPath, "content-scripts/spotify.js"), updatedCss);
    await writeFile(
      resolve(extensionPath, "manifest.json"),
      JSON.stringify({ ...manifest, version }),
    );
  }

  private static audio(): string {
    const sampleRate = 8000;
    const samples = sampleRate * 90;
    const wav = Buffer.alloc(44 + samples * 2);
    wav.write("RIFF", 0);
    wav.writeUInt32LE(36 + samples * 2, 4);
    wav.write("WAVEfmt ", 8);
    wav.writeUInt32LE(16, 16);
    wav.writeUInt16LE(1, 20);
    wav.writeUInt16LE(1, 22);
    wav.writeUInt32LE(sampleRate, 24);
    wav.writeUInt32LE(sampleRate * 2, 28);
    wav.writeUInt16LE(2, 32);
    wav.writeUInt16LE(16, 34);
    wav.write("data", 36);
    wav.writeUInt32LE(samples * 2, 40);
    for (let index = 0; index < samples; index++) {
      wav.writeInt16LE(
        Math.round(Math.sin((index * 2 * Math.PI * 440) / sampleRate) * 1000),
        44 + index * 2,
      );
    }
    return `data:audio/wav;base64,${wav.toString("base64")}`;
  }

  private static fixture(sourceFileName: string): string {
    return `<!doctype html><html><head><meta charset="utf-8">
      <link rel="stylesheet" href="https://open.spotifycdn.com/cdn/build/web-player/${sourceFileName.replace(".css", ".12345678.css")}">
      <style>body{font:18px system-ui;padding:40px;background:#fff;color:#111}h1{font-size:24px}#slider{position:relative;height:24px;margin:36px 0}audio{width:100%}pre{font-size:14px;line-height:1.6}</style>
      </head><body><h1>Spotify Light Mode — extension update proof</h1>
      <p>Controlled Spotify slider fixture · real Chromium extension lifecycle</p>
      <div class="Cem1QXiCggQeNdbM1G3g ECIY8k2bCFYI4MqX9D3k">
        <div id="slider" class="qlztBvYSudkICUPJU5Lk" style="--progress-bar-transform:65%">
          <div class="H_o1A1RgPB3_6z7nL3_I"><div class="SRfZTwPXaUiVkUEP3uld"><div id="fill" class="TfVTZDI_lRJD2nIOQv3b"></div></div></div>
        </div>
      </div>
      <audio autoplay controls src="${this.audio()}"></audio><pre id="evidence"></pre>
      <script>
        document.documentElement.dataset.documentId = crypto.randomUUID();
        document.documentElement.dataset.pauses = '0';
        const audio = document.querySelector('audio');
        audio.addEventListener('pause', () => document.documentElement.dataset.pauses = String(Number(document.documentElement.dataset.pauses) + 1));
        setInterval(() => document.querySelector('#evidence').textContent = 'CSS version: ' + getComputedStyle(document.documentElement).getPropertyValue('--extension-update-proof').trim() + '\\nDocument: ' + document.documentElement.dataset.documentId + '\\nPlayback: ' + audio.currentTime.toFixed(2) + 's · pauses: ' + document.documentElement.dataset.pauses, 100);
      </script></body></html>`;
  }

  private async snapshot(page: Page) {
    return snapshotSchema.parse(
      await page.evaluate((selector) => {
        const audio = document.querySelector<HTMLAudioElement>("audio");
        const fill = document.querySelector("#fill");
        if (audio === null || fill === null) throw new Error("Fixture is incomplete");
        return {
          documentId: document.documentElement.dataset.documentId,
          version: getComputedStyle(document.documentElement)
            .getPropertyValue("--extension-update-proof")
            .trim(),
          color: getComputedStyle(fill).backgroundColor,
          styleCount: document.querySelectorAll(selector).length,
          sources: Array.from(
            document.querySelectorAll<HTMLElement>("[data-spotify-light-mode-source-stylesheet]"),
          ).map(({ dataset }) => dataset.spotifyLightModeSourceStylesheet),
          currentTime: audio.currentTime,
          paused: audio.paused,
          pauses: Number(document.documentElement.dataset.pauses),
        };
      }, styleSelector),
    );
  }

  private async waitForVersion(page: Page, version: string): Promise<void> {
    await page.bringToFront();
    await page
      .waitForFunction(
        (version) =>
          getComputedStyle(document.documentElement)
            .getPropertyValue("--extension-update-proof")
            .trim() === version &&
          (document.querySelector<HTMLAudioElement>("audio")?.currentTime ?? 0) > 0.5,
        { timeout: 15000, polling: 100 },
        version,
      )
      .catch(async (error: unknown) => {
        await page.screenshot({ path: resolve(output, "failure.png") });
        throw new Error(
          `Version ${version} did not become ready: ${JSON.stringify(await this.snapshot(page))}`,
          { cause: error },
        );
      });
  }

  private async setEnabled(enabled: boolean): Promise<void> {
    const popup = await this.browser.newPage();
    await (async () => {
      await popup.goto(`chrome-extension://${this.extensionId}/popup.html`);
      await popup.evaluate(`chrome.storage.local.set({enabled:${enabled}})`);
    })().finally(() => popup.close());
  }

  private async reloadExtension(version: string, color: string): Promise<void> {
    await ExtensionUpdateProof.writeVersion({
      contentScript: this.contentScript,
      manifest: this.manifest,
      version,
      color,
    });
    // Reloading an unpacked extension fires onInstalled with reason "update" and previousVersion.
    await this.manager.evaluate(
      `new Promise((resolve, reject) => chrome.developerPrivate.reload(${JSON.stringify(this.extensionId)}, {}, () => { const error = chrome.runtime.lastError; if (error) reject(new Error(error.message)); else resolve(); }))`,
    );
  }

  private async verifySettings(
    version: string,
    action: "reinject" | "notify" = "reinject",
  ): Promise<void> {
    const before = await Promise.all(this.pages.map((page) => this.snapshot(page)));
    const [first] = before;
    assert.ok(first);
    await this.setEnabled(false);
    for (const page of this.pages) {
      await page.waitForFunction(
        (selector) => document.querySelectorAll(selector).length === 0,
        { polling: 100 },
        styleSelector,
      );
    }
    await this.reloadExtension(version, first.color);
    await new Promise((resolve) => setTimeout(resolve, 700));
    const disabled = await Promise.all(this.pages.map((page) => this.snapshot(page)));
    for (const [index, off] of disabled.entries()) {
      const previous = before[index];
      const page = this.pages[index];
      assert.ok(previous && page);
      assert.equal(off.styleCount, 0, "Update ignored the disabled setting");
      assert.equal(off.documentId, previous.documentId);
      assert.ok(off.currentTime > previous.currentTime);
      assert.equal(off.pauses, 0);
      assert.equal(
        await page.$$eval("spotify-light-mode-update", (hosts) => hosts.length),
        Number(action === "notify"),
      );
      assert.equal(
        off.color,
        "rgb(255, 255, 255)",
        "Disabled extension did not restore Spotify CSS",
      );
    }
    await this.setEnabled(true);
    for (const [index, page] of this.pages.entries()) {
      await this.waitForVersion(page, version);
      const previous = before[index];
      const current = await this.snapshot(page);
      assert.ok(previous);
      assert.equal(current.styleCount, 2);
      assert.equal(current.documentId, previous.documentId);
      assert.equal(current.pauses, 0);
      assert.ok(current.currentTime > previous.currentTime);
    }
    this.results.push({
      version,
      check:
        "disabled setting survives an update; current styles return on enable without reload or playback interruption",
      before,
      disabled,
      after: await Promise.all(this.pages.map((page) => this.snapshot(page))),
    });
    console.log(
      `PASS ${version}: disabled setting survives update, toggles remain reactive in both tabs`,
    );
    if (action === "notify") await this.verifyToast(version);
  }

  private async update(
    version: string,
    color: string,
    action: "reinject" | "notify",
  ): Promise<void> {
    const before = await Promise.all(this.pages.map((page) => this.snapshot(page)));
    const oldStyles = await Promise.all(
      this.pages.map((page) =>
        page.evaluateHandle(
          (selector) => Array.from(document.querySelectorAll(selector)),
          styleSelector,
        ),
      ),
    );
    const navigationCounts = this.pages.map((page) => this.navigations.get(page));
    const unrelatedNavigations = this.navigations.get(this.unrelated);
    await this.reloadExtension(version, color);
    for (const page of this.pages) await this.waitForVersion(page, version);
    for (const page of this.pages) {
      if (action === "notify") await page.waitForSelector("spotify-light-mode-update");
      assert.equal(
        await page.$$eval("spotify-light-mode-update", (hosts) => hosts.length),
        Number(action === "notify"),
        "Only runtime updates should show a single toast",
      );
    }
    await new Promise((resolve) => setTimeout(resolve, 700));
    const after = await Promise.all(this.pages.map((page) => this.snapshot(page)));
    for (const [index, page] of this.pages.entries()) {
      const previous = before[index];
      const current = after[index];
      assert.ok(previous && current);
      assert.equal(
        current.styleCount,
        2,
        "There must be exactly one base and one declarative override stylesheet",
      );
      assert.deepEqual(current.sources, [this.sourceStylesheet.sourceFileName]);
      assert.equal(current.paused, false);
      assert.equal(current.pauses, 0);
      assert.equal(current.documentId, previous.documentId, "Update replaced the document");
      assert.equal(
        this.navigations.get(page),
        navigationCounts[index],
        "Update navigated the tab without permission",
      );
      assert.ok(current.currentTime > previous.currentTime, "Playback reset or stopped");
      const old = oldStyles[index];
      assert.ok(old);
      assert.equal(
        await old.evaluate((nodes) => nodes.some(({ isConnected }) => isConnected)),
        false,
        "Old stylesheets remain mounted",
      );
      assert.equal(current.color, color);
    }
    assert.equal(
      this.navigations.get(this.unrelated),
      unrelatedNavigations,
      "Unrelated tab was reloaded",
    );
    await Promise.all(oldStyles.map((handle) => handle.dispose()));
    await this.pages[0]?.screenshot({ path: resolve(output, `${version}.png`) });
    if (action === "notify") await this.verifyToast(version);
    this.results.push({
      version,
      action,
      before,
      after,
      navigations: this.pages.map((page) => this.navigations.get(page)),
      unrelatedNavigations,
    });
    console.log(
      `PASS ${version}: ${action}, two Spotify tabs, no duplicate styles, unrelated tab unchanged`,
    );
  }

  private async verifyToast(version: string): Promise<void> {
    const [dismissed, reloaded] = this.pages;
    assert.ok(dismissed && reloaded);
    await dismissed.bringToFront();
    const before = await this.snapshot(dismissed);
    const navigationCount = this.navigations.get(reloaded);
    const previousReloaded = await this.snapshot(reloaded);
    const toast = await dismissed.waitForSelector("spotify-light-mode-update >>> section");
    assert.ok(toast);
    const entrance = await toast.evaluate((element) => {
      const [animation] = element.getAnimations();
      if (!animation || !animation.effect) throw new Error("Toast entrance animation is missing");
      const { duration } = animation.effect.getComputedTiming();
      if (typeof duration !== "number") throw new Error("Toast animation has no duration");
      animation.currentTime = 0;
      const { y, height } = element.getBoundingClientRect();
      const opacity = Number(getComputedStyle(element).opacity);
      animation.currentTime = duration;
      return { y, height, opacity, endY: element.getBoundingClientRect().y };
    });
    assert.ok(entrance.y + entrance.height <= 0, "Toast must enter from outside the screen");
    assert.equal(entrance.opacity, 0);
    assert.ok(entrance.endY >= 0 && entrance.endY < 40);
    const position = await toast.boundingBox();
    const viewport = dismissed.viewport();
    assert.ok(position && viewport);
    assert.ok(position.y >= 0 && position.y < 40, "Toast must appear near the top");
    assert.ok(Math.abs(position.x + position.width / 2 - viewport.width / 2) < 2);
    assert.ok(
      await dismissed.$eval(
        "spotify-light-mode-update >>> .source",
        (element, version) => element.textContent?.includes(version),
        version,
      ),
    );

    await dismissed.setViewport({ width: 320, height: 600 });
    const narrow = await toast.boundingBox();
    assert.ok(narrow && narrow.x >= 0 && narrow.x + narrow.width <= 320);
    await dismissed.emulateMediaFeatures([
      { name: "prefers-color-scheme", value: "dark" },
      { name: "prefers-reduced-motion", value: "reduce" },
    ]);
    assert.equal(
      await toast.evaluate((element) => getComputedStyle(element).animationName),
      "none",
    );
    await dismissed.screenshot({ path: resolve(output, `${version}-mobile.png`) });
    await dismissed.setViewport({ width: 960, height: 480 });
    await dismissed.emulateMediaFeatures([{ name: "prefers-color-scheme", value: "light" }]);
    await toast.evaluate((element) =>
      Promise.all(element.getAnimations().map(({ finished }) => finished)).then(() => undefined),
    );
    await toast.evaluate((element) => {
      element.addEventListener(
        "animationstart",
        () => {
          const [animation] = element.getAnimations();
          if (animation) animation.pause();
        },
        { once: true },
      );
    });
    await dismissed.click("spotify-light-mode-update >>> button.dismiss");
    await dismissed.waitForFunction(
      (element: Element) => element.getAnimations().some(({ playState }) => playState === "paused"),
      { polling: 100 },
      toast,
    );
    const exit = await toast.evaluate((element) => {
      const [animation] = element.getAnimations();
      if (!animation || !animation.effect) throw new Error("Toast exit animation is missing");
      const { duration } = animation.effect.getComputedTiming();
      if (typeof duration !== "number") throw new Error("Toast animation has no duration");
      animation.currentTime = 0;
      const startY = element.getBoundingClientRect().y;
      animation.currentTime = duration / 2;
      const middleY = element.getBoundingClientRect().y;
      const mountedDuringExit = element.isConnected;
      animation.currentTime = duration;
      const { y, height } = element.getBoundingClientRect();
      const opacity = Number(getComputedStyle(element).opacity);
      animation.finish();
      return { startY, middleY, y, height, opacity, mountedDuringExit };
    });
    assert.ok(exit.middleY < exit.startY, "Toast must slide upward on exit");
    assert.ok(exit.y + exit.height <= 0, "Toast must exit beyond the top edge");
    assert.equal(exit.opacity, 0);
    assert.equal(exit.mountedDuringExit, true, "Toast was removed before its animation finished");
    await dismissed.waitForFunction(() => !document.querySelector("spotify-light-mode-update"));
    await new Promise((resolve) => setTimeout(resolve, 400));
    const afterDismiss = await this.snapshot(dismissed);
    assert.equal(afterDismiss.documentId, before.documentId);
    assert.ok(afterDismiss.currentTime > before.currentTime);
    assert.equal(afterDismiss.pauses, 0);
    assert.ok(await reloaded.$("spotify-light-mode-update"), "Dismissing affected another tab");

    await reloaded.bringToFront();
    await reloaded.emulateMediaFeatures([
      { name: "prefers-color-scheme", value: "light" },
      { name: "prefers-reduced-motion", value: "reduce" },
    ]);
    const reload = await reloaded.$("spotify-light-mode-update >>> button:not(.dismiss)");
    assert.ok(reload);
    await reload.focus();
    await Promise.all([
      reloaded.waitForNavigation({ waitUntil: "load" }),
      reloaded.keyboard.press("Enter"),
    ]);
    await this.waitForVersion(reloaded, version);
    assert.notEqual((await this.snapshot(reloaded)).documentId, previousReloaded.documentId);
    assert.equal(this.navigations.get(reloaded), Number(navigationCount) + 1);
    assert.equal(await reloaded.$("spotify-light-mode-update"), null);
    assert.equal((await this.snapshot(dismissed)).documentId, before.documentId);
    this.results.push({
      version,
      check:
        "toast enters and exits beyond the screen; dismiss preserves playback; reduced-motion keyboard reload affects only its own tab",
      entrance,
      exit,
    });
    console.log(`PASS ${version}: toast, dismiss without interruption, explicit reload of one tab`);
  }

  private async verify(): Promise<void> {
    const { sourceFileName, css: sourceCss } = this.sourceStylesheet;
    const fixture = ExtensionUpdateProof.fixture(sourceFileName);
    this.navigations.set(this.unrelated, 0);
    this.unrelated.on("framenavigated", () =>
      this.navigations.set(this.unrelated, Number(this.navigations.get(this.unrelated)) + 1),
    );
    for (const [index, page] of this.pages.entries()) {
      page.on("pageerror", (error: unknown) => this.pageErrors.push(String(error)));
      this.navigations.set(page, 0);
      page.on("framenavigated", (frame) => {
        if (frame === page.mainFrame())
          this.navigations.set(page, Number(this.navigations.get(page)) + 1);
      });
      await page.emulateMediaFeatures([{ name: "prefers-color-scheme", value: "light" }]);
      await page.setRequestInterception(true);
      page.on("request", (request) => {
        if (request.resourceType() === "media") {
          void request.continue();
          return;
        }
        const { pathname } = new URL(request.url());
        if (pathname.endsWith(".css")) {
          void request.respond({ status: 200, contentType: "text/css", body: sourceCss });
          return;
        }
        void request.respond({ status: 200, contentType: "text/html", body: fixture });
      });
      await page.bringToFront();
      await page.goto(`https://open.spotify.com/update-proof-${index}`, { waitUntil: "load" });
      await this.waitForVersion(page, "1.6.0");
      assert.equal(await page.$("spotify-light-mode-update"), null);
    }
    await this.pages[0]?.screenshot({ path: resolve(output, "1.6.0.png") });
    await this.update("1.6.1", "rgb(31, 111, 235)", "reinject");
    await this.update("1.6.2", "rgb(163, 113, 247)", "reinject");
    await this.verifySettings("1.6.3");
    await this.update("1.7.0", "rgb(0, 0, 0)", "notify");
    await this.update("2.0.0", "rgb(0, 0, 0)", "notify");
    await this.update("2.0.1", "rgb(31, 111, 235)", "reinject");
    await this.verifySettings("2.0.2");
    await this.verifySettings("2.1.0", "notify");
    assert.deepEqual(this.pageErrors, [], "Extension updates produced uncaught page errors");
    await writeFile(
      resolve(output, "results.json"),
      JSON.stringify(
        {
          chromium: await this.browser.version(),
          fixture: `Spotify origin, real ${sourceFileName} source CSS and slider selectors, playing HTML audio`,
          policyCases: 8,
          bindingCases: 5,
          pageErrors: this.pageErrors,
          updates: this.results,
        },
        null,
        2,
      ),
    );
    console.log(`Evidence saved to ${output}`);
  }
}

await ExtensionUpdateProof.run();
