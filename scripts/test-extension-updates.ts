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
      ["1.6.9", "1.7.0", "reload"],
      ["1.9.9", "2.0.0", "reload"],
      ["invalid", "1.6.0", "reload"],
      [undefined, "1.6.0", "reload"],
      ["1.6.0", "invalid", "reload"],
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

  private async verifySettings(version: string): Promise<void> {
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
    for (const off of disabled) {
      assert.equal(off.styleCount, 0, "Patch update ignored the disabled setting");
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
        "disabled setting survives a patch update; current styles return on enable without reload or playback interruption",
      before,
      disabled,
      after: await Promise.all(this.pages.map((page) => this.snapshot(page))),
    });
    console.log(
      `PASS ${version}: disabled setting survives update, toggles remain reactive in both tabs`,
    );
  }

  private async update(
    version: string,
    color: string,
    action: "reinject" | "reload",
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
      if (action === "reinject") {
        assert.equal(current.documentId, previous.documentId, "Patch update replaced the document");
        assert.equal(
          this.navigations.get(page),
          navigationCounts[index],
          "Patch update navigated the tab",
        );
        assert.ok(current.currentTime > previous.currentTime, "Playback reset or stopped");
        const old = oldStyles[index];
        assert.ok(old);
        assert.equal(
          await old.evaluate((nodes) => nodes.some(({ isConnected }) => isConnected)),
          false,
          "Old stylesheets remain mounted",
        );
      } else {
        assert.notEqual(
          current.documentId,
          previous.documentId,
          "Runtime update failed to replace the document",
        );
        assert.equal(
          this.navigations.get(page),
          Number(navigationCounts[index]) + 1,
          "Runtime update must reload exactly once",
        );
      }
      assert.equal(current.color, color);
    }
    assert.equal(
      this.navigations.get(this.unrelated),
      unrelatedNavigations,
      "Unrelated tab was reloaded",
    );
    await Promise.all(oldStyles.map((handle) => handle.dispose()));
    await this.pages[0]?.screenshot({ path: resolve(output, `${version}.png`) });
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
    }
    await this.pages[0]?.screenshot({ path: resolve(output, "1.6.0.png") });
    await this.update("1.6.1", "rgb(31, 111, 235)", "reinject");
    await this.update("1.6.2", "rgb(163, 113, 247)", "reinject");
    await this.verifySettings("1.6.3");
    await this.update("1.7.0", "rgb(0, 0, 0)", "reload");
    await this.update("2.0.0", "rgb(0, 0, 0)", "reload");
    await this.update("2.0.1", "rgb(31, 111, 235)", "reinject");
    await this.verifySettings("2.0.2");
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
