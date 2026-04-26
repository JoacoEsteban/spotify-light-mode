import {
  mkdir,
  readdir,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { dirname, extname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import chroma from "chroma-js";

import { toCounterpart } from "../lib/chroma";

type Declaration = {
  property: string;
  original: string;
  mapped: string;
  kind: "custom-property" | "hardcoded-color";
};

type Block = {
  selector: string;
  declarations: Declaration[];
};

type SourceStylesheet = {
  absolutePath: string;
  relativePath: string;
  outputFileName: string;
};

type StaticRuleMap = Record<string, Record<string, string>>;

const __dirname = dirname(fileURLToPath(import.meta.url));
const snapshotsDir = resolve(__dirname, "../snapshots");
const outputDir = resolve(__dirname, "../assets/spotify-light");
const outputIndexPath = resolve(outputDir, "index.css");
const staticRulesOutputFileName = "static-rules.css";
const staticRulesOutputPath = resolve(outputDir, staticRulesOutputFileName);

const staticRules: StaticRuleMap = {
  ".DTD2wBL5oiABNB41, .ldCmP3kZajc6aBTg": {
    filter: "invert(1) contrast(1.1)",
  },
};

const blockRegex = /([^{}]+)\{([^{}]*)\}/g;
const colorTokenRegex =
  /#[0-9a-f]{3,8}\b|rgba?\([^)]*\)|hsla?\([^)]*\)/gi;
const PRESERVED_COLORFUL_CHROMA_MIN = 0.12;
const PRESERVED_COLORFUL_CONTRAST_ON_WHITE_MIN = 1.5;
const PRESERVED_COLORFUL_CONTRAST_ON_WHITE_MAX = 3;
const PRESERVED_COLORFUL_CONTRAST_ON_BLACK_MIN = 6;

function shouldPreserveColor(input: string): boolean {
  const color = chroma(input);
  const [lightness, chromaValue] = color.oklch();

  if (chromaValue < PRESERVED_COLORFUL_CHROMA_MIN) {
    return false;
  }

  const contrastOnWhite = chroma.contrast(color, "white");
  const contrastOnBlack = chroma.contrast(color, "black");

  return (
    lightness > 0 &&
    contrastOnWhite >= PRESERVED_COLORFUL_CONTRAST_ON_WHITE_MIN &&
    contrastOnWhite <= PRESERVED_COLORFUL_CONTRAST_ON_WHITE_MAX &&
    contrastOnBlack >= PRESERVED_COLORFUL_CONTRAST_ON_BLACK_MIN
  );
}

function formatColor(input: string): string {
  const source = chroma(input);

  if (shouldPreserveColor(input)) {
    return source.hex("auto").toLowerCase();
  }

  const mapped = toCounterpart(source).alpha(source.alpha());
  return mapped.hex("auto").toLowerCase();
}

function hasColorToken(value: string): boolean {
  colorTokenRegex.lastIndex = 0;
  return colorTokenRegex.test(value);
}

function mapColorsInValue(value: string): string {
  colorTokenRegex.lastIndex = 0;
  return value.replace(colorTokenRegex, (token) => {
    if (!chroma.valid(token)) {
      return token;
    }

    return formatColor(token);
  });
}

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

function splitDeclaration(declaration: string): { property: string; value: string } | null {
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
      const value = declaration.slice(index + 1).trim().replace(/\s*!important\s*$/i, "");
      if (!property || !value) {
        return null;
      }
      return { property, value };
    }
  }

  return null;
}

function parseDeclarations(body: string): Array<{ property: string; value: string }> {
  return splitTopLevel(body, ";")
    .map((declaration) => splitDeclaration(declaration))
    .filter((declaration): declaration is { property: string; value: string } => declaration !== null);
}

function isIgnorableSelector(selector: string): boolean {
  if (selector.startsWith("@")) {
    return true;
  }

  const selectorParts = selector.split(",").map((part) => part.trim()).filter(Boolean);
  if (selectorParts.length === 0) {
    return true;
  }

  return selectorParts.every((part) => /^(from|to|\d+(?:\.\d+)?%)$/i.test(part));
}

function parseCustomPropertyBlocks(sourceCss: string): Block[] {
  const blocks: Block[] = [];

  for (const match of sourceCss.matchAll(blockRegex)) {
    const selector = match[1]?.trim();
    const body = match[2] ?? "";

    if (!selector || isIgnorableSelector(selector)) {
      continue;
    }

    const declarations = parseDeclarations(body)
      .filter(
        ({ property, value }) =>
          property.startsWith("--") && hasColorToken(value) && chroma.valid(value),
      )
      .map(({ property, value }) => ({
        property,
        original: value,
        mapped: formatColor(value),
        kind: "custom-property" as const,
      }))
      .filter(({ original, mapped }) => original !== mapped);

    if (declarations.length === 0) {
      continue;
    }

    blocks.push({ selector, declarations });
  }

  return blocks;
}

function parseHardcodedColorBlocks(sourceCss: string): Block[] {
  const blocks: Block[] = [];

  for (const match of sourceCss.matchAll(blockRegex)) {
    const selector = match[1]?.trim();
    const body = match[2] ?? "";

    if (!selector || isIgnorableSelector(selector)) {
      continue;
    }

    const declarations = parseDeclarations(body)
      .filter(({ property, value }) => !property.startsWith("--") && hasColorToken(value))
      .map(({ property, value }) => ({
        property,
        original: value,
        mapped: mapColorsInValue(value),
        kind: "hardcoded-color" as const,
      }))
      .filter(({ original, mapped }) => original !== mapped);

    if (declarations.length === 0) {
      continue;
    }

    blocks.push({ selector, declarations });
  }

  return blocks;
}

function renderBlock({ selector, declarations }: Block): string {
  const renderedDeclarations = declarations
    .map(
      ({ property, original, mapped, kind }) =>
        `  ${property}: ${mapped} !important; /* ${kind}: ${original} → ${mapped} */`,
    )
    .join("\n");

  return `${selector} {\n${renderedDeclarations}\n}`;
}

function renderStylesheet(
  relativePath: string,
  customPropertyBlocks: Block[],
  hardcodedColorBlocks: Block[],
): string {
  const sections: string[] = [
    "/*",
    " * Spotify Light Mode Overrides",
    " * AUTO-GENERATED by scripts/generate-spotify-light-css.ts",
    ` * Source: ${relativePath}`,
    " * Pass 1: map custom properties with literal color values through lib/chroma.ts::toCounterpart().",
    " * Pass 2: map hardcoded color literals inside normal declarations while preserving each rule selector.",
    " */",
  ];

  if (customPropertyBlocks.length > 0) {
    sections.push(
      "",
      "/* Custom property overrides */",
      ...customPropertyBlocks.map(renderBlock),
    );
  }

  if (hardcodedColorBlocks.length > 0) {
    sections.push(
      "",
      "/* Hardcoded color overrides */",
      ...hardcodedColorBlocks.map(renderBlock),
    );
  }

  return `${sections.join("\n\n")}\n`;
}

function renderStaticRules(rules: StaticRuleMap): string {
  const selectors = Object.keys(rules).sort((a, b) => a.localeCompare(b));
  const sections: string[] = [
    "/*",
    " * Spotify Light Mode Overrides",
    " * AUTO-GENERATED by scripts/generate-spotify-light-css.ts",
    " * Static rules that are not derived from snapshot CSS color mapping.",
    " */",
  ];

  if (selectors.length > 0) {
    sections.push("", "/* Static overrides */");
  }

  for (const selector of selectors) {
    const declarations = Object.entries(rules[selector]!)
      .map(([property, value]) => `  ${property}: ${value} !important;`)
      .join("\n");

    sections.push("", `${selector} {\n${declarations}\n}`);
  }

  return `${sections.join("\n")}
`;
}

function renderIndex(stylesheets: SourceStylesheet[]): string {
  const imports = [
    ...stylesheets.map(({ outputFileName }) => `@import "./${outputFileName}";`),
    `@import "./${staticRulesOutputFileName}";`,
  ].join("\n");

  return `/*
 * Spotify Light Mode Overrides
 * AUTO-GENERATED by scripts/generate-spotify-light-css.ts
 * Source directory: snapshots/
 * One generated stylesheet per snapshot CSS file, plus static overrides imported below.
 */

${imports}

:root,
html {
  /* Force native browser UI (scrollbars, inputs, selection) to light mode */
  color-scheme: light !important;
}
`;
}

function sanitizeOutputFileName(relativePath: string): string {
  return relativePath.replaceAll(/[\\/]/g, "__");
}

async function findCssFiles(dir: string): Promise<string[]> {
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

function printReport(title: string, blocks: Block[]): void {
  console.log(`\n=== ${title} ===`);

  for (const { selector, declarations } of blocks) {
    console.log(`\n${selector}`);
    for (const { property, original, mapped } of declarations) {
      console.log(`${property} = ${original} -> ${mapped}`);
    }
  }

  const declarationCount = blocks.reduce(
    (sum, block) => sum + block.declarations.length,
    0,
  );
  console.log(`\n${title}: ${declarationCount} declarations across ${blocks.length} selectors.`);
}

async function main(): Promise<void> {
  const cssFiles = await findCssFiles(snapshotsDir);
  const stylesheets: SourceStylesheet[] = cssFiles.map((absolutePath) => {
    const relativePath = relative(resolve(__dirname, ".."), absolutePath).replaceAll("\\", "/");
    return {
      absolutePath,
      relativePath,
      outputFileName: sanitizeOutputFileName(relativePath),
    };
  });

  await rm(outputDir, { recursive: true, force: true });
  await mkdir(outputDir, { recursive: true });

  for (const stylesheet of stylesheets) {
    const sourceCss = await readFile(stylesheet.absolutePath, "utf8");
    const customPropertyBlocks = parseCustomPropertyBlocks(sourceCss);
    const hardcodedColorBlocks = parseHardcodedColorBlocks(sourceCss);
    const css = renderStylesheet(
      stylesheet.relativePath,
      customPropertyBlocks,
      hardcodedColorBlocks,
    );

    await writeFile(resolve(outputDir, stylesheet.outputFileName), css, "utf8");

    console.log(`\n=== ${stylesheet.relativePath} ===`);
    console.log(
      `Generated ${stylesheet.outputFileName} with ${customPropertyBlocks.length} custom-property selectors and ${hardcodedColorBlocks.length} hardcoded-color selectors.`,
    );

    if (customPropertyBlocks.length > 0) {
      printReport("Custom property overrides", customPropertyBlocks);
    }
    if (hardcodedColorBlocks.length > 0) {
      printReport("Hardcoded color overrides", hardcodedColorBlocks);
    }
  }

  await writeFile(staticRulesOutputPath, renderStaticRules(staticRules), "utf8");
  await writeFile(outputIndexPath, renderIndex(stylesheets), "utf8");

  console.log(`\nWrote ${stylesheets.length} generated stylesheets to ${outputDir}`);
  console.log(`Wrote static rules: ${staticRulesOutputPath}`);
  console.log(`Wrote index: ${outputIndexPath}`);
}

await main();
