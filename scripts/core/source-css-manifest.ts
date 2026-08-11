import { createHash } from "node:crypto";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { basename, dirname, extname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(__dirname, "../..");
const defaultSnapshotsRootDir = resolve(projectRoot, "snapshots");

export const cssManifestOutputFileName = "css-manifest.json";
export const sourceSnapshotDirName = "spotify-player";

const CssFileFingerprintSchema = z.object({
  fileName: z.string(),
  relativePath: z.string(),
  sha256: z.string(),
  byteLength: z.number(),
});

export type CssFileFingerprint = z.infer<typeof CssFileFingerprintSchema>;

const SourceCssManifestSectionSchema = z.object({
  fingerprint: z.string(),
  targets: z.record(z.string(), z.array(CssFileFingerprintSchema)),
});

export type SourceCssManifestSection = z.infer<typeof SourceCssManifestSectionSchema>;

const OutputCssManifestSectionSchema = z.object({
  fingerprint: z.string(),
  files: z.array(CssFileFingerprintSchema),
});

export type OutputCssManifestSection = z.infer<typeof OutputCssManifestSectionSchema>;

const CssManifestSchema = z.object({
  snapshotVersion: z.string(),
  source: SourceCssManifestSectionSchema,
  output: OutputCssManifestSectionSchema,
});

export type CssManifest = z.infer<typeof CssManifestSchema>;

type SourceCssFingerprintEntry = CssFileFingerprint & {
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

function compareCssFileFingerprints(a: CssFileFingerprint, b: CssFileFingerprint): number {
  return a.relativePath.localeCompare(b.relativePath);
}

function compareSourceEntries(a: SourceCssFingerprintEntry, b: SourceCssFingerprintEntry): number {
  return a.targetName.localeCompare(b.targetName) || a.relativePath.localeCompare(b.relativePath);
}

function fingerprint(entries: readonly CssFileFingerprint[]): string {
  const canonicalEntries = entries
    .map(({ relativePath, sha256, byteLength }) => ({
      relativePath,
      sha256,
      byteLength,
    }))
    .sort((a, b) => a.relativePath.localeCompare(b.relativePath));

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

async function fingerprintCssFile(
  rootDir: string,
  absolutePath: string,
): Promise<CssFileFingerprint> {
  const css = await readFile(absolutePath);
  const relativePath = relative(rootDir, absolutePath).replaceAll("\\", "/");
  return {
    fileName: basename(absolutePath),
    relativePath,
    sha256: sha256(css),
    byteLength: css.byteLength,
  };
}

export async function buildSourceCssManifestFromFiles(
  snapshotsDir: string,
  cssFiles: readonly string[],
): Promise<SourceCssManifestSection> {
  const entries = await Promise.all(
    cssFiles.map(async (absolutePath): Promise<SourceCssFingerprintEntry> => {
      const file = await fingerprintCssFile(snapshotsDir, absolutePath);
      return {
        targetName: sourceTargetName(file.relativePath),
        ...file,
      };
    }),
  );

  entries.sort(compareSourceEntries);

  const targets: Record<string, CssFileFingerprint[]> = {};
  for (const { targetName, ...file } of entries) {
    targets[targetName] ??= [];
    targets[targetName].push(file);
  }

  return {
    fingerprint: fingerprint(entries),
    targets,
  };
}

export async function buildSourceCssManifest(
  snapshotsRootDir = defaultSnapshotsRootDir,
): Promise<SourceCssManifestSection> {
  const snapshotsDir = resolve(snapshotsRootDir, sourceSnapshotDirName);
  const cssFiles = await findCssFiles(snapshotsDir);
  if (cssFiles.length === 0) {
    throw new Error(`No CSS files found in ${snapshotsDir}`);
  }

  return await buildSourceCssManifestFromFiles(snapshotsDir, cssFiles);
}

export async function buildOutputCssManifestFromFiles(
  assetsDir: string,
  relativePaths: readonly string[],
): Promise<OutputCssManifestSection> {
  const files = await Promise.all(
    relativePaths.map((relativePath) =>
      fingerprintCssFile(assetsDir, resolve(assetsDir, relativePath)),
    ),
  );
  files.sort(compareCssFileFingerprints);

  return {
    fingerprint: fingerprint(files),
    files,
  };
}

export async function readGeneratedCssManifest(assetsDir: string): Promise<CssManifest | null> {
  const path = resolve(assetsDir, cssManifestOutputFileName);
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return null;
    }
    throw error;
  }

  const manifest = CssManifestSchema.safeParse(JSON.parse(text));
  if (!manifest.success) {
    throw new Error(`Invalid CSS manifest: ${path}\n${manifest.error.message}`);
  }

  return manifest.data;
}

export async function writeGeneratedCssManifest(
  manifest: CssManifest,
  assetsDir: string,
): Promise<void> {
  await mkdir(assetsDir, { recursive: true });
  await writeFile(
    resolve(assetsDir, cssManifestOutputFileName),
    `${JSON.stringify(manifest, null, 2)}\n`,
    "utf8",
  );
}
