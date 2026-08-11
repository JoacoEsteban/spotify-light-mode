import { mkdir, readdir, readFile, rmdir, unlink, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { argv, exit } from "node:process";
import { fileURLToPath, pathToFileURL } from "node:url";
import chroma from "chroma-js";
import {
  buildOutputCssManifestFromFiles,
  buildSourceCssManifestFromFiles,
  cssManifestOutputFileName,
  findCssFiles,
  sourceSnapshotDirName,
  writeGeneratedCssManifest,
} from "./core/source-css-manifest";

import { formatMappedColor, hasColorToken, mapColorsInValue } from "../lib/style-color-mapping";
import { createLogger, type Logger } from "./logger";

type DeclarationKind =
  | "custom-property"
  | "hardcoded-color"
  | "css-var"
  | "transparent-color"
  | "derived-static-rule";

type Declaration = {
  property: string;
  original: string;
  mapped: string;
  important: boolean;
  kind: DeclarationKind;
};

type Block = {
  selector: string;
  declarations: Declaration[];
  layers: string[];
};

type SourceStylesheet = {
  absolutePath: string;
  relativePath: string;
  outputFileName: string;
};

type ParsedDeclaration = {
  property: string;
  value: string;
  important: boolean;
};

type DeclarationMatcher = {
  property: string;
  value: string;
};

type StaticRuleDeclaration = {
  property: string;
  value: string;
};

type StaticRuleDerivation = {
  name: string;
  match: DeclarationMatcher;
  declarations: StaticRuleDeclaration[];
};

const staticRuleDerivations = [
  {
    name: "placeholder-image-background",
    match: {
      property: "background-image",
      value: "var(--placeholder-image)",
    },
    declarations: [
      {
        property: "filter",
        value: "invert(1) contrast(1.1)",
      },
    ],
  },
] satisfies StaticRuleDerivation[];

export type GenerateSpotifyLightCssOptions = {
  snapshotVersion: string;
  snapshotsRootDir?: string;
  verbose?: boolean;
};

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(__dirname, "..");
const defaultSnapshotsRootDir = resolve(projectRoot, "snapshots");
const outputDir = resolve(projectRoot, "assets/spotify-light");
const outputIndexPath = resolve(outputDir, "index.ts");
const staticRulesOutputFileName = "static-rules.css";

const staticRulesOutputPath = resolve(outputDir, staticRulesOutputFileName);
const cssManifestOutputPath = resolve(outputDir, cssManifestOutputFileName);

function splitTopLevel(input: string, delimiter: string): string[] {
  const parts: string[] = [];
  let current = "";
  let quote: '"' | "'" | null = null;
  let parenDepth = 0;

  for (let index = 0; index < input.length; index += 1) {
    const char = input[index];
    const previous = index > 0 ? input[index - 1] : "";

    if (quote) {
      current += char;
      if (char === quote && previous !== "\\") {
        quote = null;
      }
      continue;
    }

    if (char === '"' || char === "'") {
      quote = char;
      current += char;
      continue;
    }

    if (char === "(") {
      parenDepth += 1;
      current += char;
      continue;
    }

    if (char === ")") {
      parenDepth = Math.max(0, parenDepth - 1);
      current += char;
      continue;
    }

    if (char === delimiter && parenDepth === 0) {
      parts.push(current);
      current = "";
      continue;
    }

    current += char;
  }

  if (current.trim().length > 0) {
    parts.push(current);
  }

  return parts;
}

function splitDeclaration(declaration: string): ParsedDeclaration | null {
  let quote: '"' | "'" | null = null;
  let parenDepth = 0;

  for (let index = 0; index < declaration.length; index += 1) {
    const char = declaration[index];
    const previous = index > 0 ? declaration[index - 1] : "";

    if (quote) {
      if (char === quote && previous !== "\\") {
        quote = null;
      }
      continue;
    }

    if (char === '"' || char === "'") {
      quote = char;
      continue;
    }

    if (char === "(") {
      parenDepth += 1;
      continue;
    }

    if (char === ")") {
      parenDepth = Math.max(0, parenDepth - 1);
      continue;
    }

    if (char === ":" && parenDepth === 0) {
      const property = declaration.slice(0, index).trim();
      const rawValue = declaration.slice(index + 1).trim();
      const important = /\s*!important\s*$/i.test(rawValue);
      const value = rawValue.replace(/\s*!important\s*$/i, "");
      if (!property || !value) {
        return null;
      }
      return { property, value, important };
    }
  }

  return null;
}

function parseDeclarations(body: string): ParsedDeclaration[] {
  return splitTopLevel(body, ";")
    .map((declaration) => splitDeclaration(declaration))
    .filter((declaration): declaration is ParsedDeclaration => declaration !== null);
}

function hasDeclaration(declarations: ParsedDeclaration[], matcher: DeclarationMatcher): boolean {
  return declarations.some(
    ({ property, value }) => property === matcher.property && value === matcher.value,
  );
}

function isIgnorableSelector(selector: string): boolean {
  if (selector.startsWith("@")) {
    return true;
  }

  const selectorParts = selector
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean);
  if (selectorParts.length === 0) {
    return true;
  }

  return selectorParts.every((part) => /^(from|to|\d+(?:\.\d+)?%)$/i.test(part));
}

function findMatchingBrace(input: string, openBraceIndex: number): number {
  let depth = 0;
  let quote: '"' | "'" | null = null;

  for (let index = openBraceIndex; index < input.length; index += 1) {
    const char = input[index];
    const previous = index > 0 ? input[index - 1] : "";

    if (quote) {
      if (char === quote && previous !== "\\") {
        quote = null;
      }
      continue;
    }

    if (char === '"' || char === "'") {
      quote = char;
      continue;
    }

    if (char === "{") {
      depth += 1;
      continue;
    }

    if (char === "}") {
      depth -= 1;
      if (depth === 0) {
        return index;
      }
    }
  }

  return -1;
}

function collectBlocks(
  sourceCss: string,
  collectDeclarations: (body: string) => Declaration[],
): Block[] {
  const blocks: Block[] = [];

  function walk(input: string, layers: string[]): void {
    let cursor = 0;

    while (cursor < input.length) {
      const openBraceIndex = input.indexOf("{", cursor);
      if (openBraceIndex === -1) {
        return;
      }

      const header = input.slice(cursor, openBraceIndex).trim();
      const closeBraceIndex = findMatchingBrace(input, openBraceIndex);
      if (closeBraceIndex === -1) {
        return;
      }

      const body = input.slice(openBraceIndex + 1, closeBraceIndex);

      if (header.startsWith("@layer")) {
        walk(body, [...layers, header]);
      } else if (header.startsWith("@")) {
        walk(body, layers);
      } else if (!isIgnorableSelector(header)) {
        const declarations = collectDeclarations(body);
        if (declarations.length > 0) {
          blocks.push({ selector: header, declarations, layers });
        }
      }

      cursor = closeBraceIndex + 1;
    }
  }

  walk(sourceCss, []);
  return blocks;
}

function isColorProperty(property: string): boolean {
  return (
    property === "color" ||
    property === "fill" ||
    property === "stroke" ||
    property.endsWith("-color")
  );
}

function parseColorBlocks(sourceCss: string): Block[] {
  return collectBlocks(sourceCss, (body) => {
    const declarations: Declaration[] = [];
    for (const { property, value, important } of parseDeclarations(body)) {
      if (value === "transparent") {
        declarations.push({
          property,
          original: value,
          mapped: value,
          important,
          kind: "transparent-color",
        });
        continue;
      }

      if (property.startsWith("--")) {
        if (hasColorToken(value) && chroma.valid(value)) {
          const mapped = formatMappedColor(value);
          if (mapped !== value) {
            declarations.push({
              property,
              original: value,
              mapped,
              important,
              kind: "custom-property",
            });
          }
        }
      } else if (hasColorToken(value)) {
        const mapped = mapColorsInValue(value);
        if (mapped !== value) {
          declarations.push({
            property,
            original: value,
            mapped,
            important,
            kind: "hardcoded-color",
          });
        }
      } else if (isColorProperty(property) && value.includes("var(--")) {
        declarations.push({
          property,
          original: value,
          mapped: value,
          important,
          kind: "css-var",
        });
      }
    }
    return declarations;
  });
}

function deriveStaticRuleDeclarations(declarations: ParsedDeclaration[]): Declaration[] {
  return staticRuleDerivations.flatMap((derivation) => {
    if (!hasDeclaration(declarations, derivation.match)) {
      return [];
    }

    return derivation.declarations.map(({ property, value }) => ({
      property,
      original: derivation.name,
      mapped: value,
      important: true,
      kind: "derived-static-rule",
    }));
  });
}

function parseStaticRuleBlocks(sourceCss: string): Block[] {
  return collectBlocks(sourceCss, (body) => deriveStaticRuleDeclarations(parseDeclarations(body)));
}

function increaseSelectorSpecificity(selector: string): string {
  const selectorParts = splitTopLevel(selector, ",")
    .map((part) => part.trim())
    .filter(Boolean);

  return selectorParts
    .map((part) => {
      const specificityBump = ":not(#spotify-light-mode-specificity-bump)";
      const trailingPseudoElementRegex =
        /(::[a-z-]+(?:\([^)]*\))?|:(?:before|after|first-line|first-letter))(?![\w-])/i;
      const pseudoElementMatch = trailingPseudoElementRegex.exec(part);

      if (!pseudoElementMatch) {
        return `${part}${specificityBump}`;
      }

      const pseudoElementIndex = pseudoElementMatch.index;
      const beforePseudoElement = part.slice(0, pseudoElementIndex);
      const pseudoElement = part.slice(pseudoElementIndex);
      return `${beforePseudoElement}${specificityBump}${pseudoElement}`;
    })
    .join(", ");
}

function indentBlock(input: string, prefix = "  "): string {
  return input
    .split("\n")
    .map((line) => `${prefix}${line}`)
    .join("\n");
}

function renderBlock({ selector, declarations, layers }: Block): string {
  const renderedDeclarations = declarations
    .map(({ property, original, mapped, important, kind }) => {
      const importantSuffix = important ? " !important" : "";
      const comment =
        kind === "css-var" || kind === "transparent-color"
          ? `/* ${kind}: ${original} */`
          : `/* ${kind}: ${original} → ${mapped} */`;
      return `  ${property}: ${mapped}${importantSuffix}; ${comment}`;
    })
    .join("\n");

  let rendered = `${increaseSelectorSpecificity(selector)} {\n${renderedDeclarations}\n}`;

  for (const layer of [...layers].reverse()) {
    rendered = `${layer} {\n${indentBlock(rendered)}\n}`;
  }

  return rendered;
}

function renderStylesheet(relativePath: string, blocks: Block[]): string {
  const sections: string[] = [
    "/*",
    " * Spotify Light Mode Overrides",
    " * AUTO-GENERATED by scripts/generate-spotify-light-css.ts",
    ` * Source: ${relativePath}`,
    " */",
  ];

  if (blocks.length > 0) {
    sections.push("", ...blocks.map(renderBlock));
  }

  return `${sections.join("\n\n")}\n`;
}

function renderStaticRules(blocks: Block[]): string {
  const sections: string[] = [
    [
      "/*",
      " * Spotify Light Mode Overrides",
      " * AUTO-GENERATED by scripts/generate-spotify-light-css.ts",
      " * Static rules that are not derived from snapshot CSS color mapping.",
      " */",
    ].join("\n"),
  ];

  if (blocks.length > 0) {
    sections.push("/* Static overrides */", ...blocks.map(renderBlock));
  }

  return `${sections.join("\n\n")}\n`;
}

function renderIndex(stylesheets: SourceStylesheet[]): string {
  const imports = [
    ...stylesheets.map(
      ({ outputFileName }, i) => `import _${i} from "./${outputFileName}?inline";`,
    ),
    `import _staticRules from "./${staticRulesOutputFileName}?inline";`,
  ].join("\n");

  const registryEntries = stylesheets
    .map(({ outputFileName }, i) => {
      const sourceFileName = outputFileName.slice(outputFileName.lastIndexOf("/") + 1);
      return `  { sourceFileName: ${JSON.stringify(sourceFileName)}, css: _${i} },`;
    })
    .join("\n");

  return `// AUTO-GENERATED by scripts/generate-spotify-light-css.ts
${imports}

export type LightModeStylesheetOverride = {
  sourceFileName: string;
  css: string;
};

export const lightModeStylesheetOverrides = [
${registryEntries}
] satisfies readonly LightModeStylesheetOverride[];

const _colorScheme = \`:root,
html {
  /* Force native browser UI (scrollbars, inputs, selection) to light mode */
  color-scheme: light !important;
}
\`;

export const baseLightModeCss = [_staticRules, _colorScheme].join("\\n");
`;
}

async function pruneEmptyDirectories(dir: string, logger: Logger): Promise<boolean> {
  const entries = await readdir(dir, { withFileTypes: true });
  let isEmpty = true;

  for (const entry of entries) {
    const entryPath = join(dir, entry.name);
    if (entry.isDirectory()) {
      const childIsEmpty = await pruneEmptyDirectories(entryPath, logger);
      if (childIsEmpty) {
        await rmdir(entryPath);
        logger.verboseInfo(`Deleted stale output directory: ${relative(outputDir, entryPath)}`);
      } else {
        isEmpty = false;
      }
    } else {
      isEmpty = false;
    }
  }

  return isEmpty;
}

function printReport(title: string, blocks: Block[], logger: Logger): void {
  logger.verboseInfo();
  logger.verboseInfo(`=== ${title} ===`);

  for (const { selector, declarations } of blocks) {
    logger.verboseInfo();
    logger.verboseInfo(selector);
    for (const { property, original, mapped } of declarations) {
      logger.verboseInfo(`${property} = ${original} -> ${mapped}`);
    }
  }

  const declarationCount = blocks.reduce((sum, block) => sum + block.declarations.length, 0);
  logger.verboseInfo();
  logger.verboseInfo(
    `${title}: ${declarationCount} declarations across ${blocks.length} selectors.`,
  );
}

function parseOptions(args: string[]): GenerateSpotifyLightCssOptions {
  let snapshotVersion: string | undefined;
  let snapshotsRootDir = defaultSnapshotsRootDir;
  let verbose = false;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]!;

    if (arg === "--verbose" || arg === "-v") {
      verbose = true;
      continue;
    }

    if (arg === "--version") {
      const value = args[index + 1];
      if (!value) {
        throw new Error("--version requires a web-player version.");
      }
      snapshotVersion = value;
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
          "Usage: bun scripts/generate-spotify-light-css.ts <snapshot-version> [--verbose]",
          "       bun scripts/generate-spotify-light-css.ts --version spotify-player.web-player.c1348e22 [--snapshots-dir snapshots] [--verbose]",
          "",
          "Generates light-mode overrides from <snapshots-dir>/spotify-player/.",
          "A snapshot version is required for css-manifest metadata.",
          "--verbose prints per-selector color mappings and stale-file cleanup.",
        ].join("\n"),
      );
      exit(0);
    }

    if (snapshotVersion !== undefined) {
      throw new Error(`Unexpected extra argument: ${arg}`);
    }

    snapshotVersion = arg;
  }

  if (snapshotVersion === undefined) {
    throw new Error("Snapshot version is required.");
  }

  return { snapshotVersion, snapshotsRootDir, verbose };
}

export async function generateSpotifyLightCss({
  snapshotVersion,
  snapshotsRootDir = defaultSnapshotsRootDir,
  verbose = false,
}: GenerateSpotifyLightCssOptions): Promise<void> {
  const logger = createLogger(verbose);
  const snapshotsDir = resolve(snapshotsRootDir, sourceSnapshotDirName);
  const cssFiles = await findCssFiles(snapshotsDir);
  if (cssFiles.length === 0) {
    throw new Error(`No CSS files found in ${snapshotsDir}`);
  }

  const stylesheets: SourceStylesheet[] = cssFiles.map((absolutePath) => {
    const snapshotRelativePath = relative(snapshotsDir, absolutePath).replaceAll("\\", "/");
    const relativePath = relative(projectRoot, absolutePath).replaceAll("\\", "/");
    return {
      absolutePath,
      relativePath,
      outputFileName: snapshotRelativePath,
    };
  });

  await mkdir(outputDir, { recursive: true });

  const expectedOutputFileNames = new Set([
    ...stylesheets.map((s) => s.outputFileName),
    staticRulesOutputFileName,
    cssManifestOutputFileName,
    "index.ts",
  ]);

  const existingOutputFiles = [
    ...(await findCssFiles(outputDir)),
    ...(await readdir(outputDir, { withFileTypes: true }))
      .filter((e) => e.isFile() && (e.name.endsWith(".ts") || e.name.endsWith(".json")))
      .map((e) => resolve(outputDir, e.name)),
  ];
  for (const existingFile of existingOutputFiles) {
    const name = existingFile.slice(outputDir.length + 1);
    if (!expectedOutputFileNames.has(name)) {
      await unlink(existingFile);
      logger.verboseInfo(`Deleted stale output file: ${name}`);
    }
  }
  await pruneEmptyDirectories(outputDir, logger);

  const sourceManifest = await buildSourceCssManifestFromFiles(snapshotsDir, cssFiles);
  const staticRuleBlocks: Block[] = [];

  for (const stylesheet of stylesheets) {
    const sourceCss = await readFile(stylesheet.absolutePath, "utf8");
    const blocks = parseColorBlocks(sourceCss);
    staticRuleBlocks.push(...parseStaticRuleBlocks(sourceCss));
    const css = renderStylesheet(stylesheet.relativePath, blocks);

    const outputPath = resolve(outputDir, stylesheet.outputFileName);
    await mkdir(dirname(outputPath), { recursive: true });
    await writeFile(outputPath, css, "utf8");

    const declarationCount = blocks.reduce((n, b) => n + b.declarations.length, 0);
    logger.verboseInfo();
    logger.verboseInfo(`=== ${stylesheet.relativePath} ===`);
    logger.verboseInfo(
      `Generated ${stylesheet.outputFileName} with ${blocks.length} selectors and ${declarationCount} declarations.`,
    );

    if (blocks.length > 0) {
      printReport("Color overrides", blocks, logger);
    }
  }

  await writeFile(staticRulesOutputPath, renderStaticRules(staticRuleBlocks), "utf8");
  await writeFile(outputIndexPath, renderIndex(stylesheets), "utf8");
  const outputManifest = await buildOutputCssManifestFromFiles(outputDir, [
    ...stylesheets.map((stylesheet) => stylesheet.outputFileName),
    staticRulesOutputFileName,
  ]);
  await writeGeneratedCssManifest(
    {
      snapshotVersion,
      source: sourceManifest,
      output: outputManifest,
    },
    outputDir,
  );

  logger.success(`Generated ${stylesheets.length} light-mode stylesheets.`);
  logger.info(`Snapshot: ${snapshotVersion}`);
  logger.info(`Output directory: ${outputDir}`);
  logger.verboseInfo(`Static rules: ${staticRulesOutputPath}`);
  logger.verboseInfo(`Index: ${outputIndexPath}`);
  logger.verboseInfo(`CSS manifest: ${cssManifestOutputPath}`);
}

const entrypointPath = argv[1] ? pathToFileURL(argv[1]).href : "";
if (import.meta.url === entrypointPath) {
  try {
    await generateSpotifyLightCss(parseOptions(argv.slice(2)));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    createLogger().error(message);
    exit(1);
  }
}
