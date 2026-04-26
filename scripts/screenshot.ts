import puppeteer, { type Page } from "puppeteer-core";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { mkdir } from "node:fs/promises";
import { execSync } from "node:child_process";

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

const skipBuild = process.argv.includes("--skip-build");
const loginMode = process.argv.includes("--login");

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
  await mkdir(OUT_DIR, { recursive: true });
  await mkdir(PROFILE_DIR, { recursive: true });

  if (loginMode) {
    const browser = await launch();
    const pages = await browser.pages();
    const page = pages[0] ?? (await browser.newPage());
    await page.goto("https://open.spotify.com/login", { waitUntil: "networkidle2" });
    console.log("Log in to Spotify, then press Enter here to save and exit.");
    await new Promise<void>((r) => process.stdin.once("data", () => r()));
    await browser.close();
    console.log("Session saved. Run `bun run screenshot:fast` to capture.");
    return;
  }

  if (!skipBuild) {
    console.log("Building extension...");
    execSync("bun run build", { cwd: ROOT, stdio: "inherit" });
  }

  const browser = await launch();
  const pages = await browser.pages();
  const page = pages[0] ?? (await browser.newPage());

  for (const { name, url, waitMs = 2000 } of SHOTS) {
    console.log(`  capturing ${name}...`);
    await page.goto(url, { waitUntil: "networkidle2", timeout: 30_000 });
    await new Promise((r) => setTimeout(r, waitMs));
    await dismissCookieBanner(page);
    const outPath = resolve(OUT_DIR, `${name}.jpg`);
    await page.screenshot({ path: outPath, type: "jpeg", quality: 95 });
    console.log(`  → ${outPath}`);
  }

  await browser.close();
  console.log(`\nDone. Screenshots saved to ${OUT_DIR}`);
}

main().catch((e: unknown) => {
  console.error(e);
  process.exit(1);
});
