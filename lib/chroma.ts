import chroma, { Color } from "chroma-js";

const OKLCH_GAMUT_FIT_STEPS = 24;

function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value));
}

function fitOklchToSrgb(
  lightness: number,
  chromaValue: number,
  hue: number,
  alpha: number,
): Color {
  const safeHue = Number.isFinite(hue) ? hue : 0;
  const base = chroma.oklch(lightness, 0, safeHue, alpha);

  if (chromaValue <= 0) {
    return base;
  }

  const direct = chroma.oklch(lightness, chromaValue, safeHue, alpha);
  if (!direct.clipped()) {
    return direct;
  }

  let low = 0;
  let high = chromaValue;
  let best = base;

  for (let step = 0; step < OKLCH_GAMUT_FIT_STEPS; step += 1) {
    const mid = (low + high) / 2;
    const candidate = chroma.oklch(lightness, mid, safeHue, alpha);

    if (candidate.clipped()) {
      high = mid;
      continue;
    }

    low = mid;
    best = candidate;
  }

  return best;
}

export function toCounterpart(color: Color): Color {
  const source = chroma(color);
  const [lightness, chromaValue, hue] = source.oklch();
  const mirroredLightness = clamp01(1 - lightness);

  return fitOklchToSrgb(mirroredLightness, chromaValue, hue, source.alpha());
}
