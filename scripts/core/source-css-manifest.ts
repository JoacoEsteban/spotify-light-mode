import { createHash } from "node:crypto";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { basename, dirname, extname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(__dirname, "../..");
const defaultSnapshotsRootDir = resolve(projectRoot, "snapshots");

export const sourceManifestOutputFileName = "source-manifest.json";
export const sourceSnapshotDirName = "spotify-player";

const SourceCssFileFingerprintSchema = z.object({
  fileName: z.string(),
  relativePath: z.string(),
  sha256: z.string(),
  byteLength: z.number(),
});

export type SourceCssFileFingerprint = z.infer<typeof SourceCssFileFingerprintSchema>;

const SourceCssManifestSchema = z.object({
  snapshotVersion: z.string(),
  sourceFingerprint: z.string(),
  targets: z.record(z.string(), z.array(SourceCssFileFingerprintSchema)),
});

export type SourceCssManifest = z.infer<typeof SourceCssManifestSchema>;

type SourceCssFingerprintEntry = SourceCssFileFingerprint & {
  targetName: string;
};

function sha256(input: Buffer | string): string {
  return createHash("sha256").update(input).digest("hex");
}

function sourceTargetName(relativePath: string): string {
  const separatorIndex = relativePath.indexOf("/");
  if (separatorIndex === -1) {
    return ".";
  }

  return relativePath.slice(0, separatorIndex);
}

function compareSourceEntries(a: SourceCssFingerprintEntry, b: SourceCssFingerprintEntry): number {
  return a.targetName.localeCompare(b.targetName) || a.relativePath.localeCompare(b.relativePath);
}

function sourceFingerprint(entries: readonly SourceCssFingerprintEntry[]): string {
  const canonicalEntries = entries
    .map(({ targetName, relativePath, sha256, byteLength }) => ({
      targetName,
      relativePath,
      sha256,
      byteLength,
    }))
    .sort(
      (a, b) =>
        a.targetName.localeCompare(b.targetName) || a.relativePath.localeCompare(b.relativePath),
    );

  return `sha256:${sha256(JSON.stringify(canonicalEntries))}`;
}

export async function findCssFiles(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  const files = await Promise.all(
    entries.map(async (entry) => {
      const entryPath = join(dir, entry.name);
      if (entry.isDirectory()) {
        return findCssFiles(entryPath);
      }
      if (entry.isFile() && extname(entry.name) === ".css") {
        return [entryPath];
      }
      return [];
    }),
  );

  return files.flat().sort((a, b) => a.localeCompare(b));
}

export async function buildSourceCssManifestFromFiles(
  snapshotVersion: string,
  snapshotsDir: string,
  cssFiles: readonly string[],
): Promise<SourceCssManifest> {
  const entries = await Promise.all(
    cssFiles.map(async (absolutePath): Promise<SourceCssFingerprintEntry> => {
      const sourceCss = await readFile(absolutePath);
      const relativePath = relative(snapshotsDir, absolutePath).replaceAll("\\", "/");
      return {
        targetName: sourceTargetName(relativePath),
        fileName: basename(absolutePath),
        relativePath,
        sha256: sha256(sourceCss),
        byteLength: sourceCss.byteLength,
      };
    }),
  );

  entries.sort(compareSourceEntries);

  const targets: Record<string, SourceCssFileFingerprint[]> = {};
  for (const { targetName, ...file } of entries) {
    targets[targetName] ??= [];
    targets[targetName].push(file);
  }

  return {
    snapshotVersion,
    sourceFingerprint: sourceFingerprint(entries),
    targets,
  };
}

export async function buildSourceCssManifest(
  snapshotVersion: string,
  snapshotsRootDir = defaultSnapshotsRootDir,
): Promise<SourceCssManifest> {
  const snapshotsDir = resolve(snapshotsRootDir, sourceSnapshotDirName);
  const cssFiles = await findCssFiles(snapshotsDir);
  if (cssFiles.length === 0) {
    throw new Error(`No CSS files found in ${snapshotsDir}`);
  }

  return await buildSourceCssManifestFromFiles(snapshotVersion, snapshotsDir, cssFiles);
}

export async function readGeneratedSourceManifest(
  assetsDir: string,
): Promise<SourceCssManifest | null> {
  const path = resolve(assetsDir, sourceManifestOutputFileName);
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return null;
    }
    throw error;
  }

  const manifest = SourceCssManifestSchema.safeParse(JSON.parse(text));
  if (!manifest.success) {
    throw new Error(`Invalid source CSS manifest: ${path}\n${manifest.error.message}`);
  }

  return manifest.data;
}

export async function writeGeneratedSourceManifest(
  manifest: SourceCssManifest,
  assetsDir: string,
): Promise<void> {
  await mkdir(assetsDir, { recursive: true });
  await writeFile(
    resolve(assetsDir, sourceManifestOutputFileName),
    `${JSON.stringify(manifest, null, 2)}\n`,
    "utf8",
  );
}
