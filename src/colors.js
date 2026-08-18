// Auto temperature gradient anchored to the all-time dataset extremes (not the
// visualized range): minimum ever = deep blue, through blue to white at 0 °C,
// then yellow, orange, red, deep red at the maximum ever. Stops are evenly
// spaced per arm and interpolated in OKLab for perceptual smoothness.

const COLD_STOPS = ['#ffffff', '#0000ff', '#00008b'];
const WARM_STOPS = ['#ffffff', '#ffff00', '#ff8c00', '#ff0000', '#8b0000'];

function hexToRgb(h) {
  const n = parseInt(h.slice(1), 16);
  return [(n >> 16 & 255) / 255, (n >> 8 & 255) / 255, (n & 255) / 255];
}

const srgbToLinear = c => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
const linearToSrgb = c => (c <= 0.0031308 ? c * 12.92 : 1.055 * c ** (1 / 2.4) - 0.055);
const clamp01 = c => Math.min(1, Math.max(0, c));

function rgbToOklab([r, g, b]) {
  r = srgbToLinear(r); g = srgbToLinear(g); b = srgbToLinear(b);
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  return [
    0.2104542553 * l + 0.7936177850 * m - 0.0040720468 * s,
    1.9779984951 * l - 2.4285922050 * m + 0.4505937099 * s,
    0.0259040371 * l + 0.7827717662 * m - 0.8086757660 * s,
  ];
}

function oklabToRgb([L, a, b]) {
  const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s = (L - 0.0894841775 * a - 1.2914855480 * b) ** 3;
  return [
    clamp01(linearToSrgb(4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s)),
    clamp01(linearToSrgb(-1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s)),
    clamp01(linearToSrgb(-0.0041960863 * l - 0.7034186147 * m + 1.7076147010 * s)),
  ];
}

const LUT_N = 1024;

// gamma = 1 is linear; gamma > 1 keeps mid-range temperatures near white and
// spends the color resolution on the extremes.
export function makeRamp(cLo, cHi, gamma = 1) {
  const coldLab = COLD_STOPS.map(h => rgbToOklab(hexToRgb(h)));
  const warmLab = WARM_STOPS.map(h => rgbToOklab(hexToRgb(h)));

  const sample = (stops, v) => {
    const pos = v * (stops.length - 1);
    const i = Math.min(stops.length - 2, Math.floor(pos));
    const u = pos - i;
    const a = stops[i], b = stops[i + 1];
    return oklabToRgb([
      a[0] + (b[0] - a[0]) * u,
      a[1] + (b[1] - a[1]) * u,
      a[2] + (b[2] - a[2]) * u,
    ]);
  };

  const colorAt = t => {
    if (t < 0) return sample(coldLab, clamp01(t / cLo) ** gamma);
    return sample(warmLab, clamp01(t / cHi) ** gamma);
  };

  const lut = new Float32Array(LUT_N * 3);
  for (let i = 0; i < LUT_N; i++) {
    const t = cLo + (cHi - cLo) * (i / (LUT_N - 1));
    const [r, g, b] = colorAt(t);
    lut[i * 3] = r; lut[i * 3 + 1] = g; lut[i * 3 + 2] = b;
  }

  const css = (stops = 24) => {
    const parts = [];
    for (let i = 0; i <= stops; i++) {
      const u = i / stops;
      const [r, g, b] = colorAt(cLo + (cHi - cLo) * u);
      parts.push(`rgb(${(r * 255) | 0} ${(g * 255) | 0} ${(b * 255) | 0}) ${(u * 100).toFixed(1)}%`);
    }
    return `linear-gradient(to right, ${parts.join(', ')})`;
  };

  return { cLo, cHi, lut, lutN: LUT_N, colorAt, css };
}
