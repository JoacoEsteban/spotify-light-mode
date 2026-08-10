import puppeteer, { type Page } from "puppeteer-core";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { mkdir } from "node:fs/promises";
import { execSync } from "node:child_process";
import { createLogger } from "./logger";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");
const EXTENSION_PATH = resolve(ROOT, ".output/chrome-mv3");
const OUT_DIR = resolve(ROOT, "copy/screenshots");
const PROFILE_DIR = resolve(ROOT, ".chrome-profile");
const CHROMIUM = "/Applications/Chromium.app/Contents/MacOS/Chromium";
const W = 1280;
const H = 800;

const SHOTS: Array<{ name: string; url: string; waitMs?: number }> = [
  { name: "01-home", url: "https://open.spotify.com/", waitMs: 3000 },
  { name: "02-search", url: "https://open.spotify.com/search", waitMs: 2000 },
  // Daft Punk artist page
  {
    name: "03-artist",
    url: "https://open.spotify.com/artist/4tZwfgrHOc3mvqYlEYSvVi",
    waitMs: 3000,
  },
  // Random Access Memories
  {
    name: "04-album",
    url: "https://open.spotify.com/album/4m2880jivSbbyEGAKfITCa",
    waitMs: 3000,
  },
];

const args = process.argv.slice(2);
const skipBuild = args.includes("--skip-build");
const loginMode = args.includes("--login");
const logger = createLogger(args.includes("--verbose") || args.includes("-v"));

function launch() {
  return puppeteer.launch({
    executablePath: CHROMIUM,
    headless: false,
    userDataDir: PROFILE_DIR,
    args: [
      `--disable-extensions-except=${EXTENSION_PATH}`,
      `--load-extension=${EXTENSION_PATH}`,
      `--window-size=${W},${H}`,
      "--no-default-browser-check",
      "--no-first-run",
    ],
    defaultViewport: { width: W, height: H },
  });
}

async function dismissCookieBanner(page: Page): Promise<void> {
  try {
    await page.waitForSelector("#onetrust-consent-sdk button[aria-label='Close']", {
      timeout: 3000,
    });
    await page.click("#onetrust-consent-sdk button[aria-label='Close']");
    await new Promise((r) => setTimeout(r, 500));
  } catch {
    // banner not present, continue
  }
}

async function main(): Promise<void> {
  if (args.includes("--help") || args.includes("-h")) {
    logger.info(
      [
        "Usage: bun scripts/screenshot.ts [--skip-build] [--login] [--verbose]",
        "",
        "Captures Spotify screenshots with the built extension loaded.",
        "--verbose prints each captured route and exposes build output.",
      ].join("\n"),
    );
    return;
  }

  await mkdir(OUT_DIR, { recursive: true });
  await mkdir(PROFILE_DIR, { recursive: true });

  if (loginMode) {
    const browser = await launch();
    const pages = await browser.pages();
    const page = pages[0] ?? (await browser.newPage());
    await page.goto("https://open.spotify.com/login", { waitUntil: "networkidle2" });
    logger.info("Log in to Spotify, then press Enter here to save and exit.");
    await new Promise<void>((r) => process.stdin.once("data", () => r()));
    await browser.close();
    logger.info("Session saved. Run `bun run screenshot:fast` to capture.");
    return;
  }

  if (!skipBuild) {
    logger.info("Building extension...");
    execSync("bun run build", { cwd: ROOT, stdio: logger.verbose ? "inherit" : "pipe" });
  }

  const browser = await launch();
  const pages = await browser.pages();
  const page = pages[0] ?? (await browser.newPage());

  for (const { name, url, waitMs = 2000 } of SHOTS) {
    logger.verboseInfo(`Capturing ${name}...`);
    await page.goto(url, { waitUntil: "networkidle2", timeout: 30_000 });
    await new Promise((r) => setTimeout(r, waitMs));
    await dismissCookieBanner(page);
    const outPath = resolve(OUT_DIR, `${name}.jpg`);
    await page.screenshot({ path: outPath, type: "jpeg", quality: 95 });
    logger.verboseInfo(`Wrote ${outPath}`);
  }

  await browser.close();
  logger.info(`Done. Screenshots saved to ${OUT_DIR}`);
}

main().catch((e: unknown) => {
  const message = e instanceof Error ? e.message : String(e);
  logger.error(message);
  process.exit(1);
});
