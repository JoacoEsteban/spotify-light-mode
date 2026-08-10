import { mkdir, readFile, writeFile } from "node:fs/promises";
import { basename, dirname, resolve } from "node:path";
import { argv, exit, stderr, stdout } from "node:process";
import { fileURLToPath } from "node:url";

import { extractSpotifyCssFilesFromSource } from "./extract-spotify-css-files";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(scriptDir, "..");
const defaultPageUrl = "https://open.spotify.com/";
const defaultCacheDir = resolve(projectRoot, ".cache/spotify-web-player");
const desktopUserAgent = [
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)",
  "AppleWebKit/537.36 (KHTML, like Gecko)",
  "Chrome/126.0.0.0 Safari/537.36",
].join(" ");

type Options = {
  pageUrl: string;
  cacheDir: string;
  refresh: boolean;
  json: boolean;
};

type CachedAsset = {
  url: string;
  fileName: string;
  path: string;
  text: string;
  cacheStatus: "hit" | "miss";
};

function parseOptions(args: string[]): Options {
  let pageUrl = defaultPageUrl;
  let cacheDir = defaultCacheDir;
  let refresh = false;
  let json = false;

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]!;

    if (arg === "--refresh") {
      refresh = true;
      continue;
    }

    if (arg === "--json") {
      json = true;
      continue;
    }

    if (arg === "--cache-dir") {
      const value = args[index + 1];
      if (!value) {
        throw new Error("--cache-dir requires a directory path.");
      }
      cacheDir = resolve(projectRoot, value);
      index += 1;
      continue;
    }

    if (arg === "--url") {
      const value = args[index + 1];
      if (!value) {
        throw new Error("--url requires a Spotify page URL.");
      }
      pageUrl = value;
      index += 1;
      continue;
    }

    if (arg === "--help" || arg === "-h") {
      stdout.write(
        [
          "Usage: bun scripts/fetch-spotify-css-files.ts [--refresh] [--json] [--url https://open.spotify.com/] [--cache-dir .cache/spotify-web-player]",
          "",
          "Fetches Spotify's desktop HTML, caches the current web-player JS bundle,",
          "then extracts CSS chunk filenames through the AST extractor.",
        ].join("\n") + "\n",
      );
      exit(0);
    }

    throw new Error(`Unexpected argument: ${arg}`);
  }

  return { pageUrl, cacheDir, refresh, json };
}

async function fetchText(url: string): Promise<string> {
  const response = await fetch(url, {
    headers: {
      Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      "User-Agent": desktopUserAgent,
    },
  });

  if (!response.ok) {
    throw new Error(`Fetch failed for ${url}: ${response.status} ${response.statusText}`);
  }

  return await response.text();
}

function findWebPlayerAssetUrls(html: string): { scriptUrl: string; stylesheetUrl: string | null } {
  const scriptMatch = html.match(
    /https:\/\/open\.spotifycdn\.com\/cdn\/build\/web-player\/web-player\.[a-f0-9]+\.js/g,
  );
  const stylesheetMatch = html.match(
    /https:\/\/open\.spotifycdn\.com\/cdn\/build\/web-player\/web-player\.[a-f0-9]+\.css/g,
  );

  if (!scriptMatch?.[0]) {
    throw new Error("Could not find a desktop web-player JS bundle URL in Spotify HTML.");
  }

  return {
    scriptUrl: scriptMatch[0],
    stylesheetUrl: stylesheetMatch?.[0] ?? null,
  };
}

async function readCachedAsset(url: string, cacheDir: string, refresh: boolean): Promise<CachedAsset> {
  const fileName = basename(new URL(url).pathname);
  const path = resolve(cacheDir, fileName);

  if (!refresh) {
    try {
      const text = await readFile(path, "utf8");
      return { url, fileName, path, text, cacheStatus: "hit" };
    } catch (error) {
      if (!(error instanceof Error) || !("code" in error) || error.code !== "ENOENT") {
        throw error;
      }
    }
  }

  const text = await fetchText(url);
  await mkdir(cacheDir, { recursive: true });
  await writeFile(path, text, "utf8");

  return { url, fileName, path, text, cacheStatus: "miss" };
}

async function main(): Promise<void> {
  const options = parseOptions(argv.slice(2));
  const html = await fetchText(options.pageUrl);
  const { scriptUrl, stylesheetUrl } = findWebPlayerAssetUrls(html);
  const script = await readCachedAsset(scriptUrl, options.cacheDir, options.refresh);
  const cssAssets = extractSpotifyCssFilesFromSource(script.text, script.path);

  if (options.json) {
    stdout.write(
      `${JSON.stringify(
        {
          pageUrl: options.pageUrl,
          stylesheetUrl,
          scriptUrl,
          cachePath: script.path,
          cacheStatus: script.cacheStatus,
          cssAssets,
        },
        null,
        2,
      )}\n`,
    );
    return;
  }

  stdout.write(`Spotify HTML: ${options.pageUrl}\n`);
  if (stylesheetUrl) {
    stdout.write(`Web player stylesheet: ${basename(new URL(stylesheetUrl).pathname)}\n`);
  }
  stdout.write(`Web player script: ${script.fileName}\n`);
  stdout.write(`Cache ${script.cacheStatus}: ${script.path}\n`);
  stdout.write(`\nCSS files (${cssAssets.length}):\n`);
  stdout.write(`${cssAssets.map(({ fileName, url }) => `${fileName}\t${url}`).join("\n")}\n`);
}

try {
  await main();
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  stderr.write(`${message}\n`);
  exit(1);
}
