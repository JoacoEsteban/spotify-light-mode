import chroma from "chroma-js";

import { toCounterpart } from "./chroma";

const colorTokenRegex = /#[0-9a-f]{3,8}\b|rgba?\([^)]*\)|hsla?\([^)]*\)/gi;
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

export function hasColorToken(value: string): boolean {
  colorTokenRegex.lastIndex = 0;
  return colorTokenRegex.test(value);
}

export function mapColorsInValue(value: string): string {
  colorTokenRegex.lastIndex = 0;
  return value.replace(colorTokenRegex, (token) => {
    if (!chroma.valid(token)) {
      return token;
    }

    return formatMappedColor(token);
  });
}
