import { readdir, readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { argv, exit, stderr, stdout } from "node:process";
import { fileURLToPath } from "node:url";

import {
  fetchLatestSpotifyWebPlayerInfo,
  refreshSpotifyCssSnapshot,
} from "./fetch-spotify-css-files";

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
};

function parseOptions(args: string[]): Options {
  let pageUrl = defaultPageUrl;
  let cacheDir = defaultCacheDir;
  let snapshotsRootDir = defaultSnapshotsRootDir;
  let refresh = false;
  let force = false;

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
      stdout.write(
        [
          "Usage: bun scripts/ensure-latest-spotify-light-css.ts [--refresh] [--force]",
          "       bun scripts/ensure-latest-spotify-light-css.ts [--url https://open.spotify.com/] [--cache-dir .cache/spotify-web-player] [--snapshots-dir snapshots]",
          "",
          "Fetches the latest Spotify web-player version. If generated light-mode assets",
          "already target that version, exits without regenerating. Otherwise stores CSS",
          "snapshots for the version and regenerates assets/spotify-light/.",
        ].join("\n") + "\n",
      );
      exit(0);
    }

    throw new Error(`Unexpected argument: ${arg}`);
  }

  return { pageUrl, cacheDir, snapshotsRootDir, refresh, force };
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

  let entries;
  try {
    entries = await readdir(resolve(assetsDir, snapshotVersion), { withFileTypes: true });
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return false;
    }
    throw error;
  }

  return entries.some((entry) => entry.isFile() && entry.name.endsWith(".css"));
}

async function main(): Promise<void> {
  const options = parseOptions(argv.slice(2));
  const latest = await fetchLatestSpotifyWebPlayerInfo(options.pageUrl);
  const generated = await generatedAssetsExistForVersion(
    latest.snapshotVersion,
    defaultAssetsDir,
  );

  stdout.write(`Latest snapshot version: ${latest.snapshotVersion}\n`);

  if (generated && !options.force) {
    stdout.write(`Generated assets already exist in ${defaultAssetsDir}\n`);
    stdout.write("No refresh needed.\n");
    return;
  }

  if (generated && options.force) {
    stdout.write("Generated assets already exist; forcing refresh.\n");
  } else {
    stdout.write("Generated assets missing; refreshing.\n");
  }

  const result = await refreshSpotifyCssSnapshot({
    cacheDir: options.cacheDir,
    snapshotsRootDir: options.snapshotsRootDir,
    refresh: options.refresh,
    generate: true,
    webPlayerInfo: latest,
  });

  stdout.write(`Generated assets in ${defaultAssetsDir}\n`);
  stdout.write(`Snapshot dir: ${result.snapshotDir}\n`);
}

try {
  await main();
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  stderr.write(`${message}\n`);
  exit(1);
}
