#!/usr/bin/env node
// Validates a categorical colour palette for contrast and colour-vision-deficiency safety. No dependencies.
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const MIN_CONTRAST = 3;
const MIN_DE_NORMAL = 15;
const MIN_DE_CVD = 8;

const CVD = {
  protanopia: [0.152286, 1.052583, -0.204868, 0.114503, 0.786281, 0.099216, -0.003882, -0.048116, 1.051998],
  deuteranopia: [0.367322, 0.860646, -0.227968, 0.280085, 0.672501, 0.047413, -0.01182, 0.04294, 0.968881],
  tritanopia: [1.255528, -0.076749, -0.178779, -0.078411, 0.930809, 0.147602, 0.004733, 0.691367, 0.3039],
};

export function parseHex(hex) {
  const m = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) throw new Error(`"${hex}" is not a hex colour like #1f77b4`);
  const h = m[1].length === 3 ? [...m[1]].map((c) => c + c).join('') : m[1];
  return [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16) / 255);
}

const toLinear = (c) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
const clamp = (v) => Math.min(1, Math.max(0, v));

export function luminance(rgb) {
  const [r, g, b] = rgb.map(toLinear);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

export function contrast(a, b) {
  const [l1, l2] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (l1 + 0.05) / (l2 + 0.05);
}

function linearToLab(lin) {
  const [r, g, b] = lin;
  const x = (0.4124564 * r + 0.3575761 * g + 0.1804375 * b) / 0.95047;
  const y = 0.2126729 * r + 0.7151522 * g + 0.072175 * b;
  const z = (0.0193339 * r + 0.119192 * g + 0.9503041 * b) / 1.08883;
  const f = (t) => (t > 216 / 24389 ? Math.cbrt(t) : (24389 / 27 * t + 16) / 116);
  const [fx, fy, fz] = [f(x), f(y), f(z)];
  return [116 * fy - 16, 500 * (fx - fy), 200 * (fy - fz)];
}

export function simulate(rgb, kind) {
  const m = CVD[kind];
  const lin = rgb.map(toLinear);
  return [0, 1, 2].map((i) => clamp(m[i * 3] * lin[0] + m[i * 3 + 1] * lin[1] + m[i * 3 + 2] * lin[2]));
}

export function deltaE2000(lab1, lab2) {
  const [L1, a1, b1] = lab1;
  const [L2, a2, b2] = lab2;
  const rad = Math.PI / 180;
  const C1 = Math.hypot(a1, b1);
  const C2 = Math.hypot(a2, b2);
  const Cbar = (C1 + C2) / 2;
  const G = 0.5 * (1 - Math.sqrt(Cbar ** 7 / (Cbar ** 7 + 25 ** 7)));
  const a1p = (1 + G) * a1;
  const a2p = (1 + G) * a2;
  const C1p = Math.hypot(a1p, b1);
  const C2p = Math.hypot(a2p, b2);
  const h = (a, b) => {
    if (a === 0 && b === 0) return 0;
    const v = Math.atan2(b, a) / rad;
    return v < 0 ? v + 360 : v;
  };
  const h1p = h(a1p, b1);
  const h2p = h(a2p, b2);
  const dLp = L2 - L1;
  const dCp = C2p - C1p;
  let dhp = 0;
  if (C1p * C2p !== 0) {
    dhp = h2p - h1p;
    if (dhp > 180) dhp -= 360;
    else if (dhp < -180) dhp += 360;
  }
  const dHp = 2 * Math.sqrt(C1p * C2p) * Math.sin((dhp / 2) * rad);
  const Lbarp = (L1 + L2) / 2;
  const Cbarp = (C1p + C2p) / 2;
  let hbarp = h1p + h2p;
  if (C1p * C2p !== 0) {
    if (Math.abs(h1p - h2p) <= 180) hbarp = (h1p + h2p) / 2;
    else hbarp = h1p + h2p < 360 ? (h1p + h2p + 360) / 2 : (h1p + h2p - 360) / 2;
  }
  const T = 1 - 0.17 * Math.cos((hbarp - 30) * rad) + 0.24 * Math.cos(2 * hbarp * rad) + 0.32 * Math.cos((3 * hbarp + 6) * rad) - 0.2 * Math.cos((4 * hbarp - 63) * rad);
  const dTheta = 30 * Math.exp(-(((hbarp - 275) / 25) ** 2));
  const Rc = 2 * Math.sqrt(Cbarp ** 7 / (Cbarp ** 7 + 25 ** 7));
  const Sl = 1 + (0.015 * (Lbarp - 50) ** 2) / Math.sqrt(20 + (Lbarp - 50) ** 2);
  const Sc = 1 + 0.045 * Cbarp;
  const Sh = 1 + 0.015 * Cbarp * T;
  const Rt = -Math.sin(2 * dTheta * rad) * Rc;
  return Math.sqrt((dLp / Sl) ** 2 + (dCp / Sc) ** 2 + (dHp / Sh) ** 2 + Rt * (dCp / Sc) * (dHp / Sh));
}

export function validatePalette(colors, background = '#ffffff') {
  const bg = parseHex(background);
  const parsed = colors.map((c) => ({ hex: c, rgb: parseHex(c) }));
  const issues = [];
  const contrasts = parsed.map((c) => {
    const ratio = contrast(c.rgb, bg);
    if (ratio < MIN_CONTRAST) issues.push(`${c.hex} has ${ratio.toFixed(2)}:1 contrast against ${background} (needs ${MIN_CONTRAST}:1)`);
    return { color: c.hex, ratio: Number(ratio.toFixed(2)) };
  });
  const visions = { normal: (rgb) => rgb.map(toLinear), ...Object.fromEntries(Object.keys(CVD).map((k) => [k, (rgb) => simulate(rgb, k)])) };
  const pairs = [];
  for (const [vision, transform] of Object.entries(visions)) {
    const min = vision === 'normal' ? MIN_DE_NORMAL : MIN_DE_CVD;
    const labs = parsed.map((c) => linearToLab(transform(c.rgb)));
    for (let i = 0; i < parsed.length; i++) {
      for (let j = i + 1; j < parsed.length; j++) {
        const de = deltaE2000(labs[i], labs[j]);
        if (de < min) {
          issues.push(`${parsed[i].hex} and ${parsed[j].hex} are too similar for ${vision} vision (ΔE ${de.toFixed(1)}, needs ${min})`);
          pairs.push({ vision, a: parsed[i].hex, b: parsed[j].hex, deltaE: Number(de.toFixed(1)) });
        }
      }
    }
  }
  return { ok: issues.length === 0, background, contrasts, failingPairs: pairs, issues };
}

function main(argv) {
  const args = [...argv];
  let background = '#ffffff';
  let json = false;
  const colors = [];
  while (args.length) {
    const a = args.shift();
    if (a === '--background' || a === '-b') background = args.shift() ?? background;
    else if (a === '--json') json = true;
    else if (a === '--help' || a === '-h') {
      process.stdout.write('Usage: node validate_palette.mjs [--background "#ffffff"] [--json] "#color1" "#color2" ...\n');
      return 0;
    } else colors.push(...a.split(/[\s,]+/).filter(Boolean));
  }
  if (colors.length < 2) {
    process.stderr.write('Give at least two colours, e.g. node validate_palette.mjs "#2563eb" "#ea580c"\n');
    return 2;
  }
  let result;
  try {
    result = validatePalette(colors, background);
  } catch (e) {
    process.stderr.write(`${e.message}\n`);
    return 2;
  }
  if (json) process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  else {
    process.stdout.write(`Background ${background}\n`);
    for (const c of result.contrasts) process.stdout.write(`  ${c.color}  contrast ${c.ratio}:1 ${c.ratio >= MIN_CONTRAST ? 'ok' : 'FAIL'}\n`);
    process.stdout.write(result.ok ? 'PASS: palette is distinguishable and has enough contrast.\n' : `FAIL:\n${result.issues.map((i) => `  - ${i}`).join('\n')}\n`);
  }
  return result.ok ? 0 : 1;
}

const invokedDirectly = !!process.argv[1] && import.meta.url.toLowerCase() === pathToFileURL(resolve(process.argv[1])).href.toLowerCase();
if (invokedDirectly) process.exitCode = main(process.argv.slice(2));
