import { mkdir, readFile, writeFile } from "node:fs/promises";
import { basename, dirname, resolve } from "node:path";
import { argv, exit, stderr, stdout } from "node:process";
import { fileURLToPath } from "node:url";

import { extractSpotifyCssFilesFromSource, type SpotifyCssAsset } from "./extract-spotify-css-files";
import { generateSpotifyLightCss } from "./generate-spotify-light-css";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(scriptDir, "..");
const defaultPageUrl = "https://open.spotify.com/";
const defaultCacheDir = resolve(projectRoot, ".cache/spotify-web-player");
const defaultSnapshotsRootDir = resolve(projectRoot, "snapshots");
const desktopUserAgent = [
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)",
  "AppleWebKit/537.36 (KHTML, like Gecko)",
  "Chrome/126.0.0.0 Safari/537.36",
].join(" ");

type Options = {
  pageUrl: string;
  cacheDir: string;
  snapshotsRootDir: string;
  refresh: boolean;
  generate: boolean;
  json: boolean;
};

type StoredTextAsset = {
  url: string;
  fileName: string;
  path: string;
  text: string;
  cacheStatus: "hit" | "miss";
};

type StoredCssAsset = SpotifyCssAsset & {
  path: string;
  cacheStatus: "hit" | "miss";
};

function parseOptions(args: string[]): Options {
  let pageUrl = defaultPageUrl;
  let cacheDir = defaultCacheDir;
  let snapshotsRootDir = defaultSnapshotsRootDir;
  let refresh = false;
  let generate = false;
  let json = false;

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]!;

    if (arg === "--refresh") {
      refresh = true;
      continue;
    }

    if (arg === "--generate") {
      generate = true;
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

    if (arg === "--snapshots-dir") {
      const value = args[index + 1];
      if (!value) {
        throw new Error("--snapshots-dir requires a directory path.");
      }
      snapshotsRootDir = resolve(projectRoot, value);
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
          "Usage: bun scripts/fetch-spotify-css-files.ts [--refresh] [--generate] [--json]",
          "       bun scripts/fetch-spotify-css-files.ts [--url https://open.spotify.com/] [--cache-dir .cache/spotify-web-player] [--snapshots-dir snapshots]",
          "",
          "Fetches Spotify's desktop HTML, caches the current web-player JS bundle,",
          "stores the linked and chunk CSS files under snapshots/<web-player-version>/,",
          "then optionally runs scripts/generate-spotify-light-css.ts for that version.",
        ].join("\n") + "\n",
      );
      exit(0);
    }

    throw new Error(`Unexpected argument: ${arg}`);
  }

  if (json && generate) {
    throw new Error("--json cannot be combined with --generate because the generator writes logs.");
  }

  return { pageUrl, cacheDir, snapshotsRootDir, refresh, generate, json };
}

async function fetchText(url: string): Promise<string> {
  const response = await fetch(url, {
    headers: {
      Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,text/css,*/*;q=0.8",
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

async function readStoredTextAsset(
  url: string,
  storageDir: string,
  refresh: boolean,
): Promise<StoredTextAsset> {
  const fileName = basename(new URL(url).pathname);
  const path = resolve(storageDir, fileName);

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
  await mkdir(storageDir, { recursive: true });
  await writeFile(path, text, "utf8");

  return { url, fileName, path, text, cacheStatus: "miss" };
}

function webPlayerVersionFromScriptUrl(scriptUrl: string): string {
  const fileName = basename(new URL(scriptUrl).pathname);
  if (!fileName.endsWith(".js")) {
    throw new Error(`Web player script URL does not end with .js: ${scriptUrl}`);
  }

  return fileName.slice(0, -".js".length);
}

function dedupeCssAssets(assets: SpotifyCssAsset[]): SpotifyCssAsset[] {
  const seen = new Set<string>();
  const deduped: SpotifyCssAsset[] = [];

  for (const asset of assets) {
    if (!seen.has(asset.url)) {
      seen.add(asset.url);
      deduped.push(asset);
    }
  }

  return deduped;
}

async function storeCssAssets(
  assets: SpotifyCssAsset[],
  snapshotDir: string,
  refresh: boolean,
): Promise<StoredCssAsset[]> {
  const stored = await Promise.all(
    assets.map(async (asset) => {
      const storedAsset = await readStoredTextAsset(asset.url, snapshotDir, refresh);
      return {
        fileName: asset.fileName,
        url: asset.url,
        path: storedAsset.path,
        cacheStatus: storedAsset.cacheStatus,
      };
    }),
  );

  return stored;
}

async function main(): Promise<void> {
  const options = parseOptions(argv.slice(2));
  const html = await fetchText(options.pageUrl);
  const { scriptUrl, stylesheetUrl } = findWebPlayerAssetUrls(html);
  const snapshotVersion = webPlayerVersionFromScriptUrl(scriptUrl);
  const snapshotDir = resolve(options.snapshotsRootDir, snapshotVersion);
  const script = await readStoredTextAsset(scriptUrl, options.cacheDir, options.refresh);
  const cssAssets = extractSpotifyCssFilesFromSource(script.text, script.path);
  const allCssAssets = dedupeCssAssets([
    ...(stylesheetUrl
      ? [
          {
            fileName: basename(new URL(stylesheetUrl).pathname),
            url: stylesheetUrl,
          },
        ]
      : []),
    ...cssAssets,
  ]);
  const storedCssAssets = await storeCssAssets(
    allCssAssets,
    snapshotDir,
    options.refresh,
  );

  if (options.generate) {
    await generateSpotifyLightCss({
      snapshotVersion,
      snapshotsRootDir: options.snapshotsRootDir,
    });
  }

  if (options.json) {
    stdout.write(
      `${JSON.stringify(
        {
          pageUrl: options.pageUrl,
          snapshotVersion,
          snapshotDir,
          stylesheetUrl,
          scriptUrl,
          scriptCachePath: script.path,
          scriptCacheStatus: script.cacheStatus,
          cssAssets: allCssAssets,
          storedCssAssets,
          generated: options.generate,
        },
        null,
        2,
      )}\n`,
    );
    return;
  }

  const cssHitCount = storedCssAssets.filter(({ cacheStatus }) => cacheStatus === "hit").length;
  const cssMissCount = storedCssAssets.length - cssHitCount;

  stdout.write(`Spotify HTML: ${options.pageUrl}\n`);
  stdout.write(`Snapshot version: ${snapshotVersion}\n`);
  stdout.write(`Snapshot dir: ${snapshotDir}\n`);
  if (stylesheetUrl) {
    stdout.write(`Web player stylesheet: ${basename(new URL(stylesheetUrl).pathname)}\n`);
  }
  stdout.write(`Web player script: ${script.fileName}\n`);
  stdout.write(`Script cache ${script.cacheStatus}: ${script.path}\n`);
  stdout.write(`Stored CSS files: ${storedCssAssets.length} (${cssHitCount} hit, ${cssMissCount} fetched)\n`);
  stdout.write(`Generated overrides: ${options.generate ? "yes" : "no"}\n`);
  stdout.write(`\nCSS files:\n`);
  stdout.write(
    `${storedCssAssets
      .map(({ fileName, url, path }) => `${fileName}\t${url}\t${path}`)
      .join("\n")}\n`,
  );
}

try {
  await main();
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  stderr.write(`${message}\n`);
  exit(1);
}
