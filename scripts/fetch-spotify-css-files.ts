import { mkdir, readFile, writeFile } from "node:fs/promises";
import { basename, dirname, resolve } from "node:path";
import { argv, exit, stdout } from "node:process";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  extractSpotifyCssFilesFromSource,
  type SpotifyCssAsset,
} from "./extract-spotify-css-files";
import { generateSpotifyLightCss } from "./generate-spotify-light-css";
import { createLogger, type Logger } from "./logger";

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
const mobileUserAgent = [
  "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X)",
  "AppleWebKit/605.1.15 (KHTML, like Gecko)",
  "Version/17.5 Mobile/15E148 Safari/604.1",
].join(" ");

export type SpotifyPlayerTargetName = "desktop" | "mobile";

type SpotifyPlayerTarget = {
  name: SpotifyPlayerTargetName;
  bundleDir: "web-player" | "mobile-web-player";
  bundleName: "web-player" | "mobile-web-player";
  userAgent: string;
};

const playerTargets = [
  {
    name: "desktop",
    bundleDir: "web-player",
    bundleName: "web-player",
    userAgent: desktopUserAgent,
  },
  {
    name: "mobile",
    bundleDir: "mobile-web-player",
    bundleName: "mobile-web-player",
    userAgent: mobileUserAgent,
  },
] as const satisfies readonly SpotifyPlayerTarget[];
const defaultTargetNames = playerTargets.map(({ name }) => name);

const playerTargetsByName = new Map<SpotifyPlayerTargetName, SpotifyPlayerTarget>(
  playerTargets.map((target) => [target.name, target]),
);

type Options = {
  pageUrl: string;
  cacheDir: string;
  snapshotsRootDir: string;
  refresh: boolean;
  generate: boolean;
  json: boolean;
  verbose: boolean;
  targetNames: SpotifyPlayerTargetName[];
};

type StoredTextAsset = {
  url: string;
  fileName: string;
  path: string;
  text: string;
  cacheStatus: "hit" | "miss";
};

export type StoredCssAsset = SpotifyCssAsset & {
  targetName: SpotifyPlayerTargetName;
  path: string;
  cacheStatus: "hit" | "miss";
};

export type SpotifyPlayerAssetInfo = {
  targetName: SpotifyPlayerTargetName;
  pageUrl: string;
  snapshotVersion: string;
  scriptUrl: string;
  stylesheetUrl: string | null;
};

export type SpotifyWebPlayerInfo = {
  pageUrl: string;
  snapshotVersion: string;
  targets: SpotifyPlayerAssetInfo[];
};

export type RefreshSpotifyCssSnapshotOptions = {
  pageUrl?: string;
  cacheDir?: string;
  snapshotsRootDir?: string;
  refresh?: boolean;
  generate?: boolean;
  verbose?: boolean;
  targetNames?: SpotifyPlayerTargetName[];
  webPlayerInfo?: SpotifyWebPlayerInfo;
};

export type StoredSpotifyPlayerTargetResult = SpotifyPlayerAssetInfo & {
  scriptCachePath: string;
  scriptCacheStatus: "hit" | "miss";
  cssAssets: SpotifyCssAsset[];
  storedCssAssets: StoredCssAsset[];
};

export type RefreshSpotifyCssSnapshotResult = SpotifyWebPlayerInfo & {
  snapshotDir: string;
  targets: StoredSpotifyPlayerTargetResult[];
  cssAssets: SpotifyCssAsset[];
  storedCssAssets: StoredCssAsset[];
  generated: boolean;
};

function parseTargetName(value: string): SpotifyPlayerTargetName {
  if (value === "desktop" || value === "mobile") {
    return value;
  }

  throw new Error(`Unknown target: ${value}. Expected desktop, mobile, or all.`);
}

function normalizeTargetNames(
  targetNames: readonly SpotifyPlayerTargetName[],
): SpotifyPlayerTargetName[] {
  const selected = new Set(targetNames);
  return defaultTargetNames.filter((name) => selected.has(name));
}

function parseOptions(args: string[]): Options {
  let pageUrl = defaultPageUrl;
  let cacheDir = defaultCacheDir;
  let snapshotsRootDir = defaultSnapshotsRootDir;
  let refresh = false;
  let generate = false;
  let json = false;
  let verbose = false;
  const targetNames = new Set<SpotifyPlayerTargetName>();

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

    if (arg === "--verbose" || arg === "-v") {
      verbose = true;
      continue;
    }

    if (arg === "--target") {
      const value = args[index + 1];
      if (!value) {
        throw new Error("--target requires desktop, mobile, or all.");
      }
      if (value === "all") {
        for (const name of defaultTargetNames) {
          targetNames.add(name);
        }
      } else {
        targetNames.add(parseTargetName(value));
      }
      index += 1;
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
      createLogger().plain(
        [
          "Usage: bun scripts/fetch-spotify-css-files.ts [--refresh] [--generate] [--json] [--verbose] [--target all|desktop|mobile]",
          "       bun scripts/fetch-spotify-css-files.ts [--url https://open.spotify.com/] [--cache-dir .cache/spotify-web-player] [--snapshots-dir snapshots]",
          "",
          "Fetches Spotify's desktop and mobile HTML, caches current player JS bundles,",
          "stores linked and chunk CSS files under snapshots/<combined-version>/<target>/,",
          "then optionally runs scripts/generate-spotify-light-css.ts for that combined version.",
          "--verbose prints per-target cache paths and every stored CSS file.",
        ].join("\n"),
      );
      exit(0);
    }

    throw new Error(`Unexpected argument: ${arg}`);
  }

  if (json && generate) {
    throw new Error(
      "--json cannot be combined with --generate because generated CSS writes human logs.",
    );
  }

  return {
    pageUrl,
    cacheDir,
    snapshotsRootDir,
    refresh,
    generate,
    json,
    verbose,
    targetNames: normalizeTargetNames(targetNames.size > 0 ? [...targetNames] : defaultTargetNames),
  };
}

async function fetchText(url: string, userAgent: string): Promise<string> {
  const response = await fetch(url, {
    headers: {
      Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,text/css,*/*;q=0.8",
      "User-Agent": userAgent,
    },
  });

  if (!response.ok) {
    throw new Error(`Fetch failed for ${url}: ${response.status} ${response.statusText}`);
  }

  return await response.text();
}

function escapeRegExp(input: string): string {
  return input.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function findPlayerAssetUrls(
  html: string,
  target: SpotifyPlayerTarget,
): { scriptUrl: string; stylesheetUrl: string | null } {
  const buildDir = escapeRegExp(target.bundleDir);
  const bundleName = escapeRegExp(target.bundleName);
  const scriptPattern = new RegExp(
    `https://open\\.spotifycdn\\.com/cdn/build/${buildDir}/${bundleName}\\.[a-f0-9]+\\.js`,
    "g",
  );
  const stylesheetPattern = new RegExp(
    `https://open\\.spotifycdn\\.com/cdn/build/${buildDir}/${bundleName}\\.[a-f0-9]+\\.css`,
    "g",
  );
  const scriptMatch = html.match(scriptPattern);
  const stylesheetMatch = html.match(stylesheetPattern);

  if (!scriptMatch?.[0]) {
    throw new Error(
      `Could not find a ${target.name} ${target.bundleName} JS bundle URL in Spotify HTML.`,
    );
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

  const text = await fetchText(url, desktopUserAgent);
  await mkdir(storageDir, { recursive: true });
  await writeFile(path, text, "utf8");

  return { url, fileName, path, text, cacheStatus: "miss" };
}

function webPlayerVersionFromScriptUrl(scriptUrl: string): string {
  const fileName = basename(new URL(scriptUrl).pathname);
  if (!fileName.endsWith(".js")) {
    throw new Error(`Player script URL does not end with .js: ${scriptUrl}`);
  }

  return fileName.slice(0, -".js".length);
}

function combinedSnapshotVersion(targets: readonly SpotifyPlayerAssetInfo[]): string {
  return `spotify-player.${targets.map(({ snapshotVersion }) => snapshotVersion).join("__")}`;
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
  targetName: SpotifyPlayerTargetName,
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
        targetName,
        path: storedAsset.path,
        cacheStatus: storedAsset.cacheStatus,
      };
    }),
  );

  return stored;
}

export async function fetchLatestSpotifyWebPlayerInfo(
  pageUrl = defaultPageUrl,
  targetNames: readonly SpotifyPlayerTargetName[] = defaultTargetNames,
): Promise<SpotifyWebPlayerInfo> {
  const targets = await Promise.all(
    normalizeTargetNames(targetNames).map(async (targetName) => {
      const target = playerTargetsByName.get(targetName);
      if (!target) {
        throw new Error(`Unknown target: ${targetName}`);
      }

      const html = await fetchText(pageUrl, target.userAgent);
      const { scriptUrl, stylesheetUrl } = findPlayerAssetUrls(html, target);

      return {
        targetName,
        pageUrl,
        snapshotVersion: webPlayerVersionFromScriptUrl(scriptUrl),
        scriptUrl,
        stylesheetUrl,
      };
    }),
  );

  if (targets.length === 0) {
    throw new Error("At least one Spotify player target is required.");
  }

  return {
    pageUrl,
    snapshotVersion: combinedSnapshotVersion(targets),
    targets,
  };
}

export async function refreshSpotifyCssSnapshot({
  pageUrl = defaultPageUrl,
  cacheDir = defaultCacheDir,
  snapshotsRootDir = defaultSnapshotsRootDir,
  refresh = false,
  generate = false,
  verbose = false,
  targetNames = defaultTargetNames,
  webPlayerInfo,
}: RefreshSpotifyCssSnapshotOptions = {}): Promise<RefreshSpotifyCssSnapshotResult> {
  const latest = webPlayerInfo ?? (await fetchLatestSpotifyWebPlayerInfo(pageUrl, targetNames));
  const snapshotDir = resolve(snapshotsRootDir, latest.snapshotVersion);
  const targetResults = await Promise.all(
    latest.targets.map(async (targetInfo) => {
      const targetCacheDir = resolve(cacheDir, targetInfo.targetName);
      const targetSnapshotDir = resolve(snapshotDir, targetInfo.targetName);
      const script = await readStoredTextAsset(targetInfo.scriptUrl, targetCacheDir, refresh);
      const cssAssets = extractSpotifyCssFilesFromSource(script.text, script.path);
      const allCssAssets = dedupeCssAssets([
        ...(targetInfo.stylesheetUrl
          ? [
              {
                fileName: basename(new URL(targetInfo.stylesheetUrl).pathname),
                url: targetInfo.stylesheetUrl,
              },
            ]
          : []),
        ...cssAssets,
      ]);
      const storedCssAssets = await storeCssAssets(
        targetInfo.targetName,
        allCssAssets,
        targetSnapshotDir,
        refresh,
      );

      return {
        ...targetInfo,
        scriptCachePath: script.path,
        scriptCacheStatus: script.cacheStatus,
        cssAssets: allCssAssets,
        storedCssAssets,
      };
    }),
  );
  const cssAssets = targetResults.flatMap((target) => target.cssAssets);
  const storedCssAssets = targetResults.flatMap((target) => target.storedCssAssets);

  if (generate) {
    await generateSpotifyLightCss({
      snapshotVersion: latest.snapshotVersion,
      snapshotsRootDir,
      verbose,
    });
  }

  return {
    ...latest,
    snapshotDir,
    targets: targetResults,
    cssAssets,
    storedCssAssets,
    generated: generate,
  };
}

function printResult(result: RefreshSpotifyCssSnapshotResult, logger: Logger): void {
  const cssHitCount = result.storedCssAssets.filter(
    ({ cacheStatus }) => cacheStatus === "hit",
  ).length;
  const cssMissCount = result.storedCssAssets.length - cssHitCount;

  logger.success("Spotify CSS snapshot ready.");
  logger.info(`Snapshot: ${result.snapshotVersion}`);
  logger.info(`Directory: ${result.snapshotDir}`);
  logger.info(
    `CSS files: ${result.storedCssAssets.length} total, ${cssHitCount} cached, ${cssMissCount} fetched`,
  );
  logger.info(`Generated light-mode overrides: ${result.generated ? "yes" : "no"}`);

  if (!logger.verbose) {
    return;
  }

  logger.verboseInfo(`Spotify HTML: ${result.pageUrl}`);
  for (const target of result.targets) {
    const targetCssHitCount = target.storedCssAssets.filter(
      ({ cacheStatus }) => cacheStatus === "hit",
    ).length;
    const targetCssMissCount = target.storedCssAssets.length - targetCssHitCount;
    logger.verboseInfo();
    logger.verboseInfo(`${target.targetName} target:`);
    if (target.stylesheetUrl) {
      logger.verboseInfo(`Player stylesheet: ${basename(new URL(target.stylesheetUrl).pathname)}`);
    }
    logger.verboseInfo(`Player script: ${basename(new URL(target.scriptUrl).pathname)}`);
    logger.verboseInfo(`Script cache ${target.scriptCacheStatus}: ${target.scriptCachePath}`);
    logger.verboseInfo(
      `Stored CSS files: ${target.storedCssAssets.length} (${targetCssHitCount} hit, ${targetCssMissCount} fetched)`,
    );
  }
  logger.verboseInfo();
  logger.verboseInfo("CSS files:");
  logger.verboseInfo(
    result.storedCssAssets
      .map(({ targetName, fileName, url, path }) => `${targetName}\t${fileName}\t${url}\t${path}`)
      .join("\n"),
  );
}

async function main(): Promise<void> {
  const options = parseOptions(argv.slice(2));
  const result = await refreshSpotifyCssSnapshot(options);

  if (options.json) {
    stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return;
  }

  printResult(result, createLogger(options.verbose));
}

const entrypointPath = argv[1] ? pathToFileURL(argv[1]).href : "";
if (import.meta.url === entrypointPath) {
  try {
    await main();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    createLogger().error(message);
    exit(1);
  }
}
