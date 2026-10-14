import { execFileSync } from 'node:child_process';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
// @ts-expect-error plain JavaScript module shipped with the example skill
import { contrast, deltaE2000, parseHex, validatePalette } from '../../examples/skills/dataviz/validate_palette.mjs';

const script = path.join(__dirname, '..', '..', 'examples', 'skills', 'dataviz', 'validate_palette.mjs');

describe('example skill: palette validator', () => {
  it('matches the CIEDE2000 reference data from Sharma, Wu and Dalal (2005)', () => {
    const pairs: [number[], number[], number][] = [
      [[50, 2.6772, -79.7751], [50, 0, -82.7485], 2.0425],
      [[50, 0, 0], [50, -1, 2], 2.3669],
      [[50, 2.49, -0.001], [50, -2.49, 0.0009], 7.1792],
      [[60.2574, -34.0099, 36.2677], [60.4626, -34.1751, 39.4387], 1.2644],
      [[2.0776, 0.0795, -1.135], [0.9033, -0.0636, -0.5514], 0.9082],
    ];
    for (const [a, b, want] of pairs) expect(deltaE2000(a, b)).toBeCloseTo(want, 4);
  });

  it('computes WCAG contrast ratios', () => {
    expect(contrast(parseHex('#000'), parseHex('#fff'))).toBeCloseTo(21, 5);
    expect(contrast(parseHex('#777777'), parseHex('#ffffff'))).toBeCloseTo(4.48, 2);
  });

  it('passes the Okabe-Ito example on light and dark backgrounds and fails confusable palettes', () => {
    const okabe = ['#0072B2', '#D55E00', '#009E73', '#CC79A7'];
    expect(validatePalette(okabe, '#ffffff').ok).toBe(true);
    expect(validatePalette(okabe, '#111827').ok).toBe(true);
    const bad = validatePalette(['#2563eb', '#9333ea'], '#ffffff');
    expect(bad.ok).toBe(false);
    expect(bad.issues.join(' ')).toMatch(/deuteranopia/);
  });

  it('runs as a command with exit codes the agent can act on', () => {
    expect(execFileSync(process.execPath, [script, '-b', '#ffffff', '#0072B2', '#D55E00'], { encoding: 'utf8' })).toMatch(/PASS/);
    let status = 0;
    try {
      execFileSync(process.execPath, [script, '#ffff33', '#ffffff'], { encoding: 'utf8', stdio: 'pipe' });
    } catch (e) {
      status = (e as { status: number }).status;
    }
    expect(status).toBe(1);
  });
});
