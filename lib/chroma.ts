import chroma, { Color } from "chroma-js";

export function toCounterpart(color: Color): Color {
  return chroma(color).luminance(1 - color.luminance());
}
