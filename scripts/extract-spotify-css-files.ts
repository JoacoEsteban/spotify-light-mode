import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { argv, exit, stderr, stdout } from "node:process";
import { fileURLToPath } from "node:url";
import * as ts from "typescript";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(scriptDir, "..");
const defaultInputPath = resolve(projectRoot, "web-player.js");
const cssFunctionNames: Record<string, true> = {
  miniCssF: true,
  minicssF: true,
};

type ChunkMap = Array<[chunkId: string, value: string]>;

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
      stdout.write(
        [
          "Usage: bun scripts/extract-spotify-css-files.ts [--json] [web-player.js]",
          "",
          "Extracts Spotify CSS chunk filenames from the Webpack miniCssF runtime declaration.",
        ].join("\n") + "\n",
      );
      exit(0);
    }

    if (inputPath !== defaultInputPath) {
      fail(`Unexpected extra argument: ${arg}`);
    }

    inputPath = resolve(projectRoot, arg);
  }

  return { inputPath, json };
}

function fail(message: string): never {
  stderr.write(`${message}\n`);
  exit(1);
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

function findMiniCssArrowFunction(sourceFile: ts.SourceFile): ts.ArrowFunction | null {
  let result: ts.ArrowFunction | null = null;

  function visit(node: ts.Node): void {
    if (result !== null) {
      return;
    }

    if (
      ts.isBinaryExpression(node) &&
      node.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
      ts.isPropertyAccessExpression(node.left) &&
      cssFunctionNames[node.left.name.text] === true
    ) {
      const right = unwrapExpression(node.right);
      if (ts.isArrowFunction(right)) {
        result = right;
        return;
      }
    }

    ts.forEachChild(node, visit);
  }

  visit(sourceFile);
  return result;
}

function collectChunkMaps(arrowFunction: ts.ArrowFunction): ChunkMap[] {
  const [parameter] = arrowFunction.parameters;
  if (!parameter || !ts.isIdentifier(parameter.name)) {
    fail("miniCssF declaration does not use a single identifier parameter.");
  }

  const chunkIdParameterName = parameter.name.text;
  const maps: ChunkMap[] = [];

  function visit(node: ts.Node): void {
    if (!ts.isElementAccessExpression(node) || node.argumentExpression === undefined) {
      ts.forEachChild(node, visit);
      return;
    }

    const argumentExpression = unwrapExpression(node.argumentExpression);
    if (
      ts.isIdentifier(argumentExpression) &&
      argumentExpression.text === chunkIdParameterName
    ) {
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

  visit(arrowFunction.body);
  return maps;
}

function buildCssFileNames(nameMap: ChunkMap, hashMap: ChunkMap): string[] {
  const namesByChunkId = new Map(nameMap);
  const seen = new Set<string>();
  const cssFiles: string[] = [];

  for (const [chunkId, hash] of hashMap) {
    const baseName = namesByChunkId.get(chunkId) ?? chunkId;
    const cssFile = `${baseName}.${hash}.css`;

    if (!seen.has(cssFile)) {
      seen.add(cssFile);
      cssFiles.push(cssFile);
    }
  }

  return cssFiles;
}

async function main(): Promise<void> {
  const { inputPath, json } = parseOptions(argv.slice(2));
  const sourceText = await readFile(inputPath, "utf8");
  const sourceFile = ts.createSourceFile(
    inputPath,
    sourceText,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.JS,
  );

  const miniCssFunction = findMiniCssArrowFunction(sourceFile);
  if (miniCssFunction === null) {
    fail("Could not find the miniCssF assignment in the input bundle.");
  }

  const maps = collectChunkMaps(miniCssFunction);
  if (maps.length < 2) {
    fail(`Expected at least 2 object maps in miniCssF; found ${maps.length}.`);
  }

  const [nameMap, hashMap] = maps;
  const cssFiles = buildCssFileNames(nameMap!, hashMap!);

  stdout.write(json ? `${JSON.stringify(cssFiles, null, 2)}\n` : `${cssFiles.join("\n")}\n`);
}

await main();
