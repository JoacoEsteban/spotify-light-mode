import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { argv, exit, stdout } from "node:process";
import { fileURLToPath, pathToFileURL } from "node:url";
import * as ts from "typescript";
import { createLogger } from "./logger";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(scriptDir, "..");
const defaultInputPath = resolve(projectRoot, "web-player.js");
const cssFunctionNames: Record<string, true> = {
  miniCssF: true,
  minicssF: true,
};

type ChunkMap = Array<[chunkId: string, value: string]>;

export type SpotifyCssAsset = {
  fileName: string;
  url: string;
};

type MiniCssFunction = ts.ArrowFunction | ts.FunctionExpression;

type MiniCssDeclaration = {
  cssFunction: MiniCssFunction;
  runtimeName: string;
};

type Options = {
  inputPath: string;
  json: boolean;
};

function parseOptions(args: string[]): Options {
  let inputPath = defaultInputPath;
  let json = false;

  for (const arg of args) {
    if (arg === "--json") {
      json = true;
      continue;
    }

    if (arg === "--help" || arg === "-h") {
      createLogger().plain(
        [
          "Usage: bun scripts/extract-spotify-css-files.ts [--json] [web-player.js]",
          "",
          "Extracts Spotify CSS chunk filenames from the Webpack miniCssF runtime declaration.",
        ].join("\n") + "\n",
      );
      exit(0);
    }

    if (inputPath !== defaultInputPath) {
      throw new Error(`Unexpected extra argument: ${arg}`);
    }

    inputPath = resolve(projectRoot, arg);
  }

  return { inputPath, json };
}

function unwrapExpression(expression: ts.Expression): ts.Expression {
  let current = expression;

  while (ts.isParenthesizedExpression(current)) {
    current = current.expression;
  }

  return current;
}

function propertyNameText(name: ts.PropertyName): string | null {
  if (ts.isIdentifier(name) || ts.isStringLiteral(name) || ts.isNumericLiteral(name)) {
    return name.text;
  }

  if (ts.isComputedPropertyName(name)) {
    const expression = unwrapExpression(name.expression);
    if (ts.isStringLiteral(expression) || ts.isNumericLiteral(expression)) {
      return expression.text;
    }
  }

  return null;
}

function stringLiteralText(expression: ts.Expression): string | null {
  const unwrapped = unwrapExpression(expression);

  if (ts.isStringLiteral(unwrapped) || ts.isNoSubstitutionTemplateLiteral(unwrapped)) {
    return unwrapped.text;
  }

  return null;
}

function readStringObjectLiteral(objectLiteral: ts.ObjectLiteralExpression): ChunkMap | null {
  const entries: ChunkMap = [];

  for (const property of objectLiteral.properties) {
    if (!ts.isPropertyAssignment(property)) {
      return null;
    }

    const key = propertyNameText(property.name);
    const value = stringLiteralText(property.initializer);
    if (key === null || value === null) {
      return null;
    }

    entries.push([key, value]);
  }

  return entries;
}

function findMiniCssDeclaration(sourceFile: ts.SourceFile): MiniCssDeclaration | null {
  let result: MiniCssDeclaration | null = null;

  function visit(node: ts.Node): void {
    if (result !== null) {
      return;
    }

    if (
      ts.isBinaryExpression(node) &&
      node.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
      ts.isPropertyAccessExpression(node.left) &&
      ts.isIdentifier(node.left.expression) &&
      cssFunctionNames[node.left.name.text] === true
    ) {
      const right = unwrapExpression(node.right);
      if (ts.isArrowFunction(right) || ts.isFunctionExpression(right)) {
        result = {
          cssFunction: right,
          runtimeName: node.left.expression.text,
        };
        return;
      }
    }

    ts.forEachChild(node, visit);
  }

  visit(sourceFile);
  return result;
}

function findWebpackPublicPath(sourceFile: ts.SourceFile, runtimeName: string): string | null {
  let publicPath: string | null = null;

  function visit(node: ts.Node): void {
    if (
      ts.isBinaryExpression(node) &&
      node.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
      ts.isPropertyAccessExpression(node.left) &&
      ts.isIdentifier(node.left.expression) &&
      node.left.expression.text === runtimeName &&
      node.left.name.text === "p"
    ) {
      const value = stringLiteralText(node.right);
      if (value !== null) {
        publicPath = value;
      }
    }

    ts.forEachChild(node, visit);
  }

  visit(sourceFile);
  return publicPath;
}

function collectChunkMaps(cssFunction: MiniCssFunction): ChunkMap[] {
  const [parameter] = cssFunction.parameters;
  if (!parameter || !ts.isIdentifier(parameter.name)) {
    throw new Error("miniCssF declaration does not use a single identifier parameter.");
  }

  const chunkIdParameterName = parameter.name.text;
  const maps: ChunkMap[] = [];

  function visit(node: ts.Node): void {
    if (!ts.isElementAccessExpression(node) || node.argumentExpression === undefined) {
      ts.forEachChild(node, visit);
      return;
    }

    const argumentExpression = unwrapExpression(node.argumentExpression);
    if (ts.isIdentifier(argumentExpression) && argumentExpression.text === chunkIdParameterName) {
      const expression = unwrapExpression(node.expression);
      if (ts.isObjectLiteralExpression(expression)) {
        const map = readStringObjectLiteral(expression);
        if (map !== null) {
          maps.push(map);
        }
      }
    }

    ts.forEachChild(node, visit);
  }

  visit(cssFunction.body);
  return maps;
}

function buildCssAssets(
  nameMap: ChunkMap,
  hashMap: ChunkMap,
  publicPath: string,
): SpotifyCssAsset[] {
  const namesByChunkId = new Map(nameMap);
  const seen = new Set<string>();
  const cssAssets: SpotifyCssAsset[] = [];

  for (const [chunkId, hash] of hashMap) {
    const baseName = namesByChunkId.get(chunkId) ?? chunkId;
    const fileName = `${baseName}.${hash}.css`;

    if (!seen.has(fileName)) {
      seen.add(fileName);
      cssAssets.push({
        fileName,
        url: new URL(fileName, publicPath).href,
      });
    }
  }

  return cssAssets;
}

export function extractSpotifyCssFilesFromSource(
  sourceText: string,
  sourcePath = "web-player.js",
): SpotifyCssAsset[] {
  const sourceFile = ts.createSourceFile(
    sourcePath,
    sourceText,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.JS,
  );

  const miniCssDeclaration = findMiniCssDeclaration(sourceFile);
  if (miniCssDeclaration === null) {
    throw new Error("Could not find the miniCssF assignment in the input bundle.");
  }

  const publicPath = findWebpackPublicPath(sourceFile, miniCssDeclaration.runtimeName);
  if (publicPath === null) {
    throw new Error(
      `Could not find the Webpack public path assignment for ${miniCssDeclaration.runtimeName}.p.`,
    );
  }

  const maps = collectChunkMaps(miniCssDeclaration.cssFunction);
  if (maps.length < 2) {
    throw new Error(`Expected at least 2 object maps in miniCssF; found ${maps.length}.`);
  }

  const [nameMap, hashMap] = maps;
  return buildCssAssets(nameMap!, hashMap!, publicPath);
}

export async function extractSpotifyCssFilesFromFile(
  inputPath: string,
): Promise<SpotifyCssAsset[]> {
  const sourceText = await readFile(inputPath, "utf8");
  const cssAssets = extractSpotifyCssFilesFromSource(sourceText, inputPath);

  return cssAssets;
}

async function main(): Promise<void> {
  const { inputPath, json } = parseOptions(argv.slice(2));
  const cssAssets = await extractSpotifyCssFilesFromFile(inputPath);

  stdout.write(
    json
      ? `${JSON.stringify(cssAssets, null, 2)}\n`
      : `${cssAssets.map(({ fileName, url }) => `${fileName}\t${url}`).join("\n")}\n`,
  );
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
