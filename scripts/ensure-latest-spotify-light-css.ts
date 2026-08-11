import { readdir, readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { argv, exit } from "node:process";
import { fileURLToPath } from "node:url";

import {
  fetchLatestSpotifyWebPlayerInfo,
  refreshSpotifyCssSnapshot,
} from "./fetch-spotify-css-files";
import {
  buildSourceCssManifest,
  readGeneratedCssManifest,
  writeGeneratedCssManifest,
  type CssManifest,
} from "./core/source-css-manifest";
import { generateSpotifyLightCss } from "./generate-spotify-light-css";
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
      createLogger().plain(
        [
          "Usage: bun scripts/ensure-latest-spotify-light-css.ts [--refresh] [--force] [--verbose]",
          "       bun scripts/ensure-latest-spotify-light-css.ts [--url https://open.spotify.com/] [--cache-dir .cache/spotify-web-player] [--snapshots-dir snapshots]",
          "",
          "Fetches the latest Spotify desktop and mobile player versions.",
          "If generated light-mode assets already target that combined version, exits.",
          "If only Spotify artifact hashes changed, compares formatted source CSS content and skips generation.",
          "Use --force after generator logic changes.",
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

async function fileExists(path: string): Promise<boolean> {
  try {
    await readFile(path, "utf8");
    return true;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return false;
    }
    throw error;
  }
}

async function generatedAssetsExistForManifest(
  manifest: CssManifest,
  assetsDir: string,
): Promise<boolean> {
  let indexText: string;
  try {
    indexText = await readFile(resolve(assetsDir, "index.ts"), "utf8");
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return false;
    }
    throw error;
  }

  if (!(await fileExists(resolve(assetsDir, "static-rules.css")))) {
    return false;
  }

  for (const files of Object.values(manifest.source.targets)) {
    for (const file of files) {
      if (!indexText.includes(`"./${file.relativePath}?inline"`)) {
        return false;
      }

      if (!(await fileExists(resolve(assetsDir, file.relativePath)))) {
        return false;
      }
    }
  }

  for (const file of manifest.output.files) {
    if (!(await fileExists(resolve(assetsDir, file.relativePath)))) {
      return false;
    }
  }
  return true;
}

async function main(): Promise<void> {
  const options = parseOptions(argv.slice(2));
  const logger = createLogger(options.verbose);

  logger.info("Checking latest Spotify web player snapshot...");
  const latest = await fetchLatestSpotifyWebPlayerInfo(options.pageUrl);
  const previousCssManifest = await readGeneratedCssManifest(defaultAssetsDir);
  const previousGenerated = previousCssManifest
    ? await generatedAssetsExistForManifest(previousCssManifest, defaultAssetsDir)
    : false;
  const generated =
    previousGenerated && previousCssManifest?.snapshotVersion === latest.snapshotVersion;
  logger.info(`Latest snapshot: ${latest.snapshotVersion}`);
  logger.verboseInfo(
    `Targets: ${latest.targets.map(({ targetName, snapshotVersion }) => `${targetName}=${snapshotVersion}`).join(", ")}`,
  );

  if (generated && !options.force) {
    logger.success("Generated assets already match the latest snapshot.");
    logger.info("No refresh needed.");
    logger.verboseInfo(`Assets directory: ${defaultAssetsDir}`);
    return;
  }

  if (generated && options.force) {
    logger.warn("Generated assets exist; refreshing because --force was set.");
    logger.info("Refreshing because --force was set.");
  } else {
    logger.info("Generated assets are missing or use an older snapshot; refreshing now.");
  }

  const result = await refreshSpotifyCssSnapshot({
    cacheDir: options.cacheDir,
    snapshotsRootDir: options.snapshotsRootDir,
    refresh: options.refresh,
    generate: false,
    verbose: options.verbose,
    webPlayerInfo: latest,
  });

  const latestSourceManifest = await buildSourceCssManifest(options.snapshotsRootDir);

  if (
    previousCssManifest &&
    previousGenerated &&
    previousCssManifest.source.fingerprint === latestSourceManifest.fingerprint &&
    !options.force
  ) {
    logger.success("Source CSS content is unchanged; generation skipped.");
    await writeGeneratedCssManifest(
      {
        snapshotVersion: latest.snapshotVersion,
        source: latestSourceManifest,
        output: previousCssManifest.output,
      },
      defaultAssetsDir,
    );
    logger.info("Use --force after generator logic changes.");
    logger.verboseInfo(`Generated snapshot: ${previousCssManifest.snapshotVersion}`);
    logger.verboseInfo(`Latest snapshot: ${latest.snapshotVersion}`);
    logger.verboseInfo(`Assets directory: ${defaultAssetsDir}`);
    logger.verboseInfo(`Snapshot directory: ${result.snapshotDir}`);
    return;
  }

  if (options.force) {
    logger.info("Generating because --force was set.");
  } else if (!previousCssManifest) {
    logger.verboseInfo("No CSS manifest found; generating now.");
  } else if (!previousGenerated) {
    logger.verboseInfo("CSS manifest points to missing generated assets; generating now.");
  } else {
    logger.info("Source CSS content changed; generating now.");
  }

  await generateSpotifyLightCss({
    snapshotVersion: latest.snapshotVersion,
    snapshotsRootDir: options.snapshotsRootDir,
    verbose: options.verbose,
  });

  logger.success("Generated light-mode assets refreshed.");
  logger.info(`Assets directory: ${defaultAssetsDir}`);
  logger.verboseInfo(`Snapshot directory: ${result.snapshotDir}`);
}

try {
  await main();
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  createLogger().error(message);
  exit(1);
}
