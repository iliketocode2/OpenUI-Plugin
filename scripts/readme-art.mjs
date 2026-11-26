#!/usr/bin/env node
// Draws the README's logo and diagram, light and dark, in VS Code's Light/Dark Modern colours (the colours the
// chat view itself uses). Usage: node scripts/readme-art.mjs   (writes assets/*.svg)
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const OUT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'assets');
fs.mkdirSync(OUT, { recursive: true });

// From the --vscode-* variables of a VS Code 1.96 webview (Default Light Modern / Default Dark Modern).
const THEMES = {
  light: {
    bg: '#f8f8f8', code: '#ffffff', fg: '#1f1f1f', fgSoft: '#3b3b3b', faint: '#767676', line: '#e5e5e5',
    accent: '#005fb8', accentSoft: '#e8f1fb', ok: '#388a34', okSoft: '#ebf4ea', bad: '#c42b1c', badSoft: '#fbeceb',
  },
  dark: {
    bg: '#181818', code: '#1f1f1f', fg: '#e8e8e8', fgSoft: '#cccccc', faint: '#9d9d9d', line: '#2b2b2b',
    accent: '#4daafc', accentSoft: '#14273a', ok: '#89d185', okSoft: '#1a2a1a', bad: '#f14c4c', badSoft: '#3a1d1d',
  },
};

const SANS = "ui-sans-serif, -apple-system, 'Segoe UI', Inter, Roboto, Helvetica, Arial, sans-serif";
const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** The extension's icon (media/icon.svg), drawn at `size` with its top-left corner at x, y. */
function logo(x, y, size, color) {
  const s = size / 24;
  return `<g transform="translate(${x} ${y}) scale(${s})" fill="none" stroke="${color}" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">
    <path d="M12 3l7.5 4.3v8.4L12 20l-7.5-4.3V7.3z"/><path d="M9 10.5l2 2 4-4"/><path d="M8 16h8"/>
  </g>`;
}

/** The logo at the top of the README: the extension's icon and its name in white on a solid VS Code blue plate.
 * One version for every theme: a light/dark pair follows the operating system's colour scheme, not GitHub's theme
 * setting, so a transparent logo could show dark text on GitHub's dark page. */
function logoMark() {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="760" height="200" viewBox="0 0 760 200" role="img" aria-label="OWUI Agent">
  <defs>
    <linearGradient id="plate" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="#0a84e0"/>
      <stop offset="1" stop-color="#005fb8"/>
    </linearGradient>
  </defs>
  <rect width="760" height="200" rx="36" fill="url(#plate)"/>
  ${logo(40, 34, 132, '#ffffff')}
  <text x="194" y="128" font-family="${SANS}" font-size="92" font-weight="700" letter-spacing="-3" fill="#ffffff">OWUI Agent</text>
</svg>
`;
}

function diagram(t) {
  const box = (x, y, w, h, title, sub, { fill = t.code, stroke = t.line, color = t.fg } = {}) => `
  <rect x="${x}" y="${y}" width="${w}" height="${h}" rx="12" fill="${fill}" stroke="${stroke}"/>
  <text x="${x + 20}" y="${y + 36}" font-family="${SANS}" font-size="20" font-weight="650" fill="${color}">${esc(title)}</text>
  ${sub.map((s, i) => `<text x="${x + 20}" y="${y + 62 + i * 22}" font-family="${SANS}" font-size="15.5" fill="${t.fgSoft}">${esc(s)}</text>`).join('\n  ')}`;
  const arrow = (x1, y1, x2, y2, color = t.faint, dash = false) => {
    const a = Math.atan2(y2 - y1, x2 - x1), L = 9;
    const p = (s) => `${x2 - L * Math.cos(a + s)},${y2 - L * Math.sin(a + s)}`;
    return `<path d="M${x1} ${y1} L${x2} ${y2}" stroke="${color}" stroke-width="1.8" fill="none"${dash ? ' stroke-dasharray="6 5"' : ''}/>
  <path d="M${x2} ${y2} L${p(0.45)} L${p(-0.45)} Z" fill="${color}"/>`;
  };
  const W = 1280, H = 452, top = 40, h = 150, midY = top + h / 2;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" role="img" aria-label="How OWUI Agent connects: the agent in VS Code sends every request through one egress guard, which allows only your Open WebUI server; Open WebUI serves your model and, if you enable it, web search through your SearXNG. Requests to any other host are refused. The optional browser tool opens only localhost pages in your own Chrome or Edge. Commands you approve run in your own shell, outside the guard.">
  <rect width="${W}" height="${H}" rx="18" fill="${t.bg}"/>
  <rect x="0.5" y="0.5" width="${W - 1}" height="${H - 1}" rx="18" fill="none" stroke="${t.line}"/>
  ${box(32, top, 288, h, 'VS Code: OWUI Agent', ['agent loop and tools', 'asks before edits and commands', 'checkpoints for rewind'])}
  ${arrow(320, midY, 362, midY)}
  ${box(366, top, 268, h, 'Egress guard', ['one destination:', 'your Open WebUI server', 'redirects checked again'], { fill: t.accentSoft, stroke: t.accent })}
  ${arrow(634, midY, 676, midY)}
  ${box(680, top, 270, h, 'Your Open WebUI', ['models and chat completions', 'optional web search', 'through your SearXNG'], { fill: t.okSoft, stroke: t.ok })}
  ${arrow(950, midY, 992, midY)}
  ${box(996, top, 252, h, 'Your model', ['served by Open WebUI,', 'for example Ollama on', 'your own hardware'])}

  ${arrow(500, top + h, 500, 268, t.bad)}
  <rect x="366" y="272" width="268" height="140" rx="12" fill="${t.badSoft}" stroke="${t.bad}"/>
  <text x="386" y="308" font-family="${SANS}" font-size="20" font-weight="650" fill="${t.bad}">Any other host: refused</text>
  <text x="386" y="334" font-family="${SANS}" font-size="15.5" fill="${t.fgSoft}">no telemetry, analytics,</text>
  <text x="386" y="356" font-family="${SANS}" font-size="15.5" fill="${t.fgSoft}">update checks, CDNs</text>
  <text x="386" y="378" font-family="${SANS}" font-size="15.5" fill="${t.fgSoft}">or font downloads</text>

  ${arrow(176, top + h, 176, 268, t.faint, true)}
  ${box(32, 272, 288, 140, 'Browser tool (opt-in)', ['your Chrome or Edge,', 'localhost pages only;', 'other hosts go to a refusing proxy'])}

  <rect x="680" y="272" width="568" height="140" rx="12" fill="none" stroke="${t.faint}" stroke-dasharray="6 5"/>
  <text x="700" y="308" font-family="${SANS}" font-size="20" font-weight="650" fill="${t.fg}">Outside the guard: commands you approve</text>
  <text x="700" y="334" font-family="${SANS}" font-size="15.5" fill="${t.fgSoft}">They run in your shell with your privileges and can reach the</text>
  <text x="700" y="356" font-family="${SANS}" font-size="15.5" fill="${t.fgSoft}">internet like any program you run (npm install, git push).</text>
  <text x="700" y="378" font-family="${SANS}" font-size="15.5" fill="${t.fgSoft}">The extension also cannot tell where a model really runs.</text>
</svg>
`;
}

fs.writeFileSync(path.join(OUT, 'logo.svg'), logoMark());
for (const [name, t] of Object.entries(THEMES)) {
  fs.writeFileSync(path.join(OUT, `how-it-works-${name}.svg`), diagram(t));
}
console.log('wrote', fs.readdirSync(OUT).filter((f) => f.endsWith('.svg')).join(', '));
