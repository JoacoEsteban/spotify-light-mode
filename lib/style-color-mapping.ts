import chroma from "chroma-js";

import { toCounterpart } from "./chroma";

const colorTokenRegex = /#[0-9a-f]{3,8}\b|rgba?\([^)]*\)|hsla?\([^)]*\)/gi;
const namedColorTokens = new Set(["black", "white"]);
const namedColorTokenRegex = new RegExp(
  `(^|[^A-Za-z0-9_-])(${[...namedColorTokens].join("|")})(?=$|[^A-Za-z0-9_-])`,
  "gi",
);
const PRESERVED_COLORFUL_CHROMA_MIN = 0.12;
const PRESERVED_COLORFUL_CONTRAST_ON_WHITE_MIN = 1.5;
const PRESERVED_COLORFUL_CONTRAST_ON_WHITE_MAX = 3;
const PRESERVED_COLORFUL_CONTRAST_ON_BLACK_MIN = 6;

export function shouldPreserveColor(input: string): boolean {
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

export function formatMappedColor(input: string): string {
  const source = chroma(input);

  if (shouldPreserveColor(input)) {
    return source.hex("auto").toLowerCase();
  }

  const mapped = toCounterpart(source).alpha(source.alpha());
  return mapped.hex("auto").toLowerCase();
}

function hasNamedColorToken(value: string): boolean {
  namedColorTokenRegex.lastIndex = 0;
  return namedColorTokenRegex.test(value);
}

function mapNamedColorsInValue(value: string): string {
  namedColorTokenRegex.lastIndex = 0;
  return value.replace(
    namedColorTokenRegex,
    (_, prefix: string, token: string) => `${prefix}${formatMappedColor(token.toLowerCase())}`,
  );
}

export function hasColorToken(value: string): boolean {
  colorTokenRegex.lastIndex = 0;
  return colorTokenRegex.test(value) || hasNamedColorToken(value);
}

export function mapColorsInValue(value: string): string {
  colorTokenRegex.lastIndex = 0;
  const mapped = value.replace(colorTokenRegex, (token) => {
    if (!chroma.valid(token)) {
      return token;
    }

    return formatMappedColor(token);
  });

  return mapNamedColorsInValue(mapped);
}
