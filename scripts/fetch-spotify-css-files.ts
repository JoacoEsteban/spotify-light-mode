import { mkdir, readFile, writeFile } from "node:fs/promises";
import { basename, dirname, resolve } from "node:path";
import { argv, exit, stderr, stdout } from "node:process";
import { fileURLToPath, pathToFileURL } from "node:url";

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

export type StoredCssAsset = SpotifyCssAsset & {
  path: string;
  cacheStatus: "hit" | "miss";
};

export type SpotifyWebPlayerInfo = {
  pageUrl: string;
  snapshotVersion: string;
  scriptUrl: string;
  stylesheetUrl: string | null;
};

export type RefreshSpotifyCssSnapshotOptions = {
  pageUrl?: string;
  cacheDir?: string;
  snapshotsRootDir?: string;
  refresh?: boolean;
  generate?: boolean;
  webPlayerInfo?: SpotifyWebPlayerInfo;
};

export type RefreshSpotifyCssSnapshotResult = SpotifyWebPlayerInfo & {
  snapshotDir: string;
  scriptCachePath: string;
  scriptCacheStatus: "hit" | "miss";
  cssAssets: SpotifyCssAsset[];
  storedCssAssets: StoredCssAsset[];
  generated: boolean;
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

export async function fetchLatestSpotifyWebPlayerInfo(
  pageUrl = defaultPageUrl,
): Promise<SpotifyWebPlayerInfo> {
  const html = await fetchText(pageUrl);
  const { scriptUrl, stylesheetUrl } = findWebPlayerAssetUrls(html);

  return {
    pageUrl,
    snapshotVersion: webPlayerVersionFromScriptUrl(scriptUrl),
    scriptUrl,
    stylesheetUrl,
  };
}

export async function refreshSpotifyCssSnapshot({
  pageUrl = defaultPageUrl,
  cacheDir = defaultCacheDir,
  snapshotsRootDir = defaultSnapshotsRootDir,
  refresh = false,
  generate = false,
  webPlayerInfo,
}: RefreshSpotifyCssSnapshotOptions = {}): Promise<RefreshSpotifyCssSnapshotResult> {
  const latest = webPlayerInfo ?? (await fetchLatestSpotifyWebPlayerInfo(pageUrl));
  const snapshotDir = resolve(snapshotsRootDir, latest.snapshotVersion);
  const script = await readStoredTextAsset(latest.scriptUrl, cacheDir, refresh);
  const cssAssets = extractSpotifyCssFilesFromSource(script.text, script.path);
  const allCssAssets = dedupeCssAssets([
    ...(latest.stylesheetUrl
      ? [
          {
            fileName: basename(new URL(latest.stylesheetUrl).pathname),
            url: latest.stylesheetUrl,
          },
        ]
      : []),
    ...cssAssets,
  ]);
  const storedCssAssets = await storeCssAssets(
    allCssAssets,
    snapshotDir,
    refresh,
  );

  if (generate) {
    await generateSpotifyLightCss({
      snapshotVersion: latest.snapshotVersion,
      snapshotsRootDir,
    });
  }

  return {
    ...latest,
    snapshotDir,
    scriptCachePath: script.path,
    scriptCacheStatus: script.cacheStatus,
    cssAssets: allCssAssets,
    storedCssAssets,
    generated: generate,
  };
}

function printResult(result: RefreshSpotifyCssSnapshotResult): void {
  const cssHitCount = result.storedCssAssets.filter(({ cacheStatus }) => cacheStatus === "hit").length;
  const cssMissCount = result.storedCssAssets.length - cssHitCount;

  stdout.write(`Spotify HTML: ${result.pageUrl}\n`);
  stdout.write(`Snapshot version: ${result.snapshotVersion}\n`);
  stdout.write(`Snapshot dir: ${result.snapshotDir}\n`);
  if (result.stylesheetUrl) {
    stdout.write(`Web player stylesheet: ${basename(new URL(result.stylesheetUrl).pathname)}\n`);
  }
  stdout.write(`Web player script: ${basename(new URL(result.scriptUrl).pathname)}\n`);
  stdout.write(`Script cache ${result.scriptCacheStatus}: ${result.scriptCachePath}\n`);
  stdout.write(`Stored CSS files: ${result.storedCssAssets.length} (${cssHitCount} hit, ${cssMissCount} fetched)\n`);
  stdout.write(`Generated overrides: ${result.generated ? "yes" : "no"}\n`);
  stdout.write(`\nCSS files:\n`);
  stdout.write(
    `${result.storedCssAssets
      .map(({ fileName, url, path }) => `${fileName}\t${url}\t${path}`)
      .join("\n")}\n`,
  );
}

async function main(): Promise<void> {
  const options = parseOptions(argv.slice(2));
  const result = await refreshSpotifyCssSnapshot(options);

  if (options.json) {
    stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return;
  }

  printResult(result);
}

const entrypointPath = argv[1] ? pathToFileURL(argv[1]).href : "";
if (import.meta.url === entrypointPath) {
  try {
    await main();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    stderr.write(`${message}\n`);
    exit(1);
  }
}
