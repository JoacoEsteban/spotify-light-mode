import assert from "node:assert/strict";
import { cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import puppeteer from "puppeteer-core";
import inc from "semver/functions/inc";
import { z } from "zod";

class ExtensionUpdateDemo {
  static async run(): Promise<void> {
    const headless = process.argv.includes("--headless");
    const output = resolve(".cache/update-demo");
    const extensionPath = resolve(output, "extension");
    await mkdir(output, { recursive: true });
    await rm(extensionPath, { recursive: true, force: true });
    await cp(resolve(".output/chrome-mv3"), extensionPath, { recursive: true });
    const manifestPath = resolve(extensionPath, "manifest.json");
    const manifest = z
      .object({ version: z.string() })
      .passthrough()
      .parse(JSON.parse(await readFile(manifestPath, "utf8")));
    const { version } = manifest;
    const nextVersion = z.string().parse(inc(version, "minor"));
    const browser = await puppeteer.launch({
      executablePath: "/Applications/Chromium.app/Contents/MacOS/Chromium",
      headless,
      ignoreDefaultArgs: ["--disable-extensions"],
      targetFilter: (target) => target.type() !== "service_worker",
      userDataDir: resolve(output, "profile"),
      defaultViewport: null,
      args: [
        `--disable-extensions-except=${extensionPath}`,
        `--load-extension=${extensionPath}`,
        "--no-first-run",
        "--no-default-browser-check",
        "--window-size=1280,900",
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
      assert.ok(extension);
      const { id } = extension;
      const page = await browser.newPage();
      await page.emulateMediaFeatures([{ name: "prefers-color-scheme", value: "light" }]);
      await page.goto("https://open.spotify.com/", { waitUntil: "networkidle2", timeout: 60000 });
      await page.waitForSelector("#spotify-light-mode-overrides-base");
      const before = await page.evaluate(() => performance.timeOrigin);
      await writeFile(manifestPath, JSON.stringify({ ...manifest, version: nextVersion }));
      await manager.evaluate(
        `new Promise((resolve, reject) => chrome.developerPrivate.reload(${JSON.stringify(id)}, {}, () => { const error = chrome.runtime.lastError; if (error) reject(new Error(error.message)); else resolve(); }))`,
      );
      await page.waitForSelector("spotify-light-mode-update >>> button");
      assert.equal(await page.evaluate(() => performance.timeOrigin), before);
      await manager.close();
      const pages = await browser.pages();
      for (const empty of pages) {
        if (empty !== page && empty.url() === "about:blank") await empty.close();
      }
      await page.bringToFront();
      await page.$eval("spotify-light-mode-update >>> section", (element) =>
        Promise.all(element.getAnimations().map(({ finished }) => finished)).then(() => undefined),
      );
      await page.screenshot({ path: resolve(output, "spotify-toast.png") });
      console.log(`Spotify update demo ready: ${version} → ${nextVersion}. No tab reload.`);
      console.log(
        "Try Reload or Dismiss. Close the Chromium window before running the demo again.",
      );
      if (!headless) await new Promise<void>((resolve) => browser.once("disconnected", resolve));
    })().finally(() => browser.close());
  }
}

await ExtensionUpdateDemo.run();
