import chroma, { Color } from "chroma-js";

const OKLCH_GAMUT_FIT_STEPS = 24;
const ACHROMATIC_THRESHOLD = 0.01;
const EXTREME_LIGHTNESS_THRESHOLD = 0.02;
const COUNTERPART_LIGHTNESS_MIN = 0.12;
const COUNTERPART_LIGHTNESS_MAX = 0.95;
const COUNTERPART_LIGHTNESS_OFFSET = 0.15;
const COUNTERPART_LIGHTNESS_SCALE = 0.8;
const COUNTERPART_LIGHTNESS_EXPONENT = 0.65;
const SHADOW_LIGHTNESS = 0.22;
const SHADOW_ALPHA_SCALE = 0.7;
const FOCUS_NEUTRAL_LIGHTNESS = 0.55;
const BORDER_NEUTRAL_LIGHTNESS_MIN = 0.28;
const BORDER_NEUTRAL_LIGHTNESS_MAX = 0.72;
const BORDER_NEUTRAL_LIGHTNESS_OFFSET = 0.22;
const BORDER_NEUTRAL_LIGHTNESS_SCALE = 0.58;
const OVERLAY_NEUTRAL_LIGHTNESS = 0.22;

function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value));
}

function mapCounterpartLightness(
  lightness: number,
  chromaValue: number,
): number {
  if (chromaValue < ACHROMATIC_THRESHOLD) {
    if (lightness >= 1 - EXTREME_LIGHTNESS_THRESHOLD) {
      return 0;
    }

    if (lightness <= EXTREME_LIGHTNESS_THRESHOLD) {
      return 1;
    }
  }

  const curved =
    COUNTERPART_LIGHTNESS_OFFSET +
    COUNTERPART_LIGHTNESS_SCALE *
      Math.pow(1 - lightness, COUNTERPART_LIGHTNESS_EXPONENT);

  return Math.min(
    COUNTERPART_LIGHTNESS_MAX,
    Math.max(COUNTERPART_LIGHTNESS_MIN, curved),
  );
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
  const mappedLightness = clamp01(
    mapCounterpartLightness(lightness, chromaValue),
  );

  return fitOklchToSrgb(mappedLightness, chromaValue, hue, source.alpha());
}

export function toShadowCounterpart(color: Color): Color {
  const source = chroma(color);
  return chroma.oklch(
    SHADOW_LIGHTNESS,
    0,
    0,
    clamp01(source.alpha() * SHADOW_ALPHA_SCALE),
  );
}

export function toFocusCounterpart(color: Color): Color {
  const source = chroma(color);
  const [lightness, chromaValue] = source.oklch();

  if (chromaValue < ACHROMATIC_THRESHOLD) {
    return chroma.oklch(FOCUS_NEUTRAL_LIGHTNESS, 0, 0, source.alpha());
  }

  return toCounterpart(source);
}

export function toBorderCounterpart(color: Color): Color {
  const source = chroma(color);
  const [lightness, chromaValue] = source.oklch();
  const normalizedLightness = clamp01(lightness);

  if (chromaValue >= ACHROMATIC_THRESHOLD) {
    return toCounterpart(source);
  }

  const mappedLightness = clamp01(
    Math.min(
      BORDER_NEUTRAL_LIGHTNESS_MAX,
      Math.max(
        BORDER_NEUTRAL_LIGHTNESS_MIN,
        BORDER_NEUTRAL_LIGHTNESS_OFFSET +
          BORDER_NEUTRAL_LIGHTNESS_SCALE *
            Math.pow(1 - normalizedLightness, 0.8),
      ),
    ),
  );

  return chroma.oklch(mappedLightness, 0, 0, source.alpha());
}

export function toOverlayCounterpart(color: Color): Color {
  const source = chroma(color);
  const [lightness, chromaValue, hue] = source.oklch();

  if (chromaValue < ACHROMATIC_THRESHOLD) {
    return chroma.oklch(OVERLAY_NEUTRAL_LIGHTNESS, 0, 0, source.alpha());
  }

  return fitOklchToSrgb(
    Math.max(COUNTERPART_LIGHTNESS_MIN, clamp01(lightness)),
    chromaValue,
    hue,
    source.alpha(),
  );
}
