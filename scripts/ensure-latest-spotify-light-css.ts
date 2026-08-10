import { readdir, readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { argv, exit } from "node:process";
import { fileURLToPath } from "node:url";

import {
  fetchLatestSpotifyWebPlayerInfo,
  refreshSpotifyCssSnapshot,
} from "./fetch-spotify-css-files";
import { createLogger } from "./logger";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(scriptDir, "..");
const defaultPageUrl = "https://open.spotify.com/";
const defaultCacheDir = resolve(projectRoot, ".cache/spotify-web-player");
const defaultSnapshotsRootDir = resolve(projectRoot, "snapshots");
const defaultAssetsDir = resolve(projectRoot, "assets/spotify-light");

type Options = {
  pageUrl: string;
  cacheDir: string;
  snapshotsRootDir: string;
  refresh: boolean;
  force: boolean;
  verbose: boolean;
};

function parseOptions(args: string[]): Options {
  let pageUrl = defaultPageUrl;
  let cacheDir = defaultCacheDir;
  let snapshotsRootDir = defaultSnapshotsRootDir;
  let refresh = false;
  let force = false;
  let verbose = false;

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]!;

    if (arg === "--refresh") {
      refresh = true;
      continue;
    }

    if (arg === "--force") {
      force = true;
      continue;
    }

    if (arg === "--verbose" || arg === "-v") {
      verbose = true;
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

    if (arg === "--help" || arg === "-h") {
      createLogger().info(
        [
          "Usage: bun scripts/ensure-latest-spotify-light-css.ts [--refresh] [--force] [--verbose]",
          "       bun scripts/ensure-latest-spotify-light-css.ts [--url https://open.spotify.com/] [--cache-dir .cache/spotify-web-player] [--snapshots-dir snapshots]",
          "",
          "Fetches the latest Spotify desktop and mobile player versions. If generated",
          "light-mode assets already target that combined version, exits without regenerating.",
          "Otherwise stores CSS snapshots for the version and regenerates assets/spotify-light/.",
          "--verbose prints per-target versions and generator details.",
        ].join("\n"),
      );
      exit(0);
    }

    throw new Error(`Unexpected argument: ${arg}`);
  }

  return { pageUrl, cacheDir, snapshotsRootDir, refresh, force, verbose };
}

async function containsCssFile(dir: string): Promise<boolean> {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return false;
    }
    throw error;
  }

  for (const entry of entries) {
    if (entry.isFile() && entry.name.endsWith(".css")) {
      return true;
    }

    if (entry.isDirectory() && (await containsCssFile(resolve(dir, entry.name)))) {
      return true;
    }
  }

  return false;
}

async function generatedAssetsExistForVersion(
  snapshotVersion: string,
  assetsDir: string,
): Promise<boolean> {
  const importPrefix = `./${snapshotVersion}/`;

  let indexText: string;
  try {
    indexText = await readFile(resolve(assetsDir, "index.ts"), "utf8");
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return false;
    }
    throw error;
  }

  if (!indexText.includes(importPrefix)) {
    return false;
  }

  return await containsCssFile(resolve(assetsDir, snapshotVersion));
}

async function main(): Promise<void> {
  const options = parseOptions(argv.slice(2));
  const logger = createLogger(options.verbose);
  const latest = await fetchLatestSpotifyWebPlayerInfo(options.pageUrl);
  const generated = await generatedAssetsExistForVersion(
    latest.snapshotVersion,
    defaultAssetsDir,
  );

  logger.info(`Latest snapshot version: ${latest.snapshotVersion}`);
  logger.verboseInfo(
    `Targets: ${latest.targets.map(({ targetName, snapshotVersion }) => `${targetName}=${snapshotVersion}`).join(", ")}`,
  );

  if (generated && !options.force) {
    logger.info("Generated assets already exist.");
    logger.verboseInfo(`Assets dir: ${defaultAssetsDir}`);
    logger.info("No refresh needed.");
    return;
  }

  if (generated && options.force) {
    logger.info("Generated assets already exist; forcing refresh.");
  } else {
    logger.info("Generated assets missing; refreshing.");
  }

  const result = await refreshSpotifyCssSnapshot({
    cacheDir: options.cacheDir,
    snapshotsRootDir: options.snapshotsRootDir,
    refresh: options.refresh,
    generate: true,
    verbose: options.verbose,
    webPlayerInfo: latest,
  });

  logger.info(`Generated assets in ${defaultAssetsDir}`);
  logger.verboseInfo(`Snapshot dir: ${result.snapshotDir}`);
}

try {
  await main();
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  createLogger().error(message);
  exit(1);
}
