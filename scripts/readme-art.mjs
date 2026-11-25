#!/usr/bin/env node
// Draws the README's banner and diagram, light and dark, in VS Code's Light/Dark Modern colours (the colours the
// chat view itself uses). Usage: node scripts/readme-art.mjs   (writes assets/*.svg)
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const OUT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'assets');
fs.mkdirSync(OUT, { recursive: true });

// From the --vscode-* variables of a VS Code 1.96 webview (Default Light Modern / Default Dark Modern), plus the
// default JSON token colours of each theme.
const THEMES = {
  light: {
    bg: '#f8f8f8', code: '#ffffff', fg: '#1f1f1f', fgSoft: '#3b3b3b', faint: '#767676', line: '#e5e5e5',
    accent: '#005fb8', accentSoft: '#e8f1fb', ok: '#388a34', okSoft: '#ebf4ea', bad: '#c42b1c', badSoft: '#fbeceb',
    prop: '#0451a5', str: '#a31515', com: '#008000', punct: '#3b3b3b', lit: '#0000ff',
  },
  dark: {
    bg: '#181818', code: '#1f1f1f', fg: '#e8e8e8', fgSoft: '#cccccc', faint: '#9d9d9d', line: '#2b2b2b',
    accent: '#4daafc', accentSoft: '#14273a', ok: '#89d185', okSoft: '#1a2a1a', bad: '#f14c4c', badSoft: '#3a1d1d',
    prop: '#9cdcfe', str: '#ce9178', com: '#6a9955', punct: '#cccccc', lit: '#569cd6',
  },
};

const SANS = "ui-sans-serif, -apple-system, 'Segoe UI', Inter, Roboto, Helvetica, Arial, sans-serif";
const MONO = "ui-monospace, 'SF Mono', 'Cascadia Code', Menlo, Consolas, 'Liberation Mono', monospace";
const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** Enough JSON-with-comments highlighting for the card in the banner. */
function highlight(line, t) {
  const re = /(\/\/.*$)|("[^"]*")(\s*:)?|(\b(?:true|false|null)\b)|([{}[\],:])|(\s+)|(.)/g;
  let out = '', m;
  while ((m = re.exec(line))) {
    const [, com, str, colon, lit, punct, space, other] = m;
    if (com) out += `<tspan fill="${t.com}">${esc(com)}</tspan>`;
    else if (str) out += `<tspan fill="${colon ? t.prop : t.str}">${esc(str)}</tspan>${colon ? `<tspan fill="${t.punct}">${esc(colon)}</tspan>` : ''}`;
    else if (lit) out += `<tspan fill="${t.lit}">${lit}</tspan>`;
    else out += `<tspan fill="${t.punct}">${esc(punct ?? space ?? other)}</tspan>`;
  }
  return out;
}

/** The extension's icon (media/icon.svg), drawn at `size` with its top-left corner at x, y. */
function logo(x, y, size, color) {
  const s = size / 24;
  return `<g transform="translate(${x} ${y}) scale(${s})" fill="none" stroke="${color}" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">
    <path d="M12 3l7.5 4.3v8.4L12 20l-7.5-4.3V7.3z"/><path d="M9 10.5l2 2 4-4"/><path d="M8 16h8"/>
  </g>`;
}

function banner(t) {
  const code = [
    '{',
    '  // the only place the extension connects to',
    '  "owuiAgent.baseUrl": "http://localhost:3000",',
    '',
    '  // everything else asks first',
    '  "owuiAgent.commands.allowlist": ["npm test"],',
    '  "owuiAgent.web.enabled": false',
    '}',
  ];
  const cx = 668, cy = 48, cw = 568, ch = 284;
  const lines = code.map((l, i) =>
    `<text x="${cx + 26}" y="${cy + 82 + i * 26}" font-family="${MONO}" font-size="16.5" xml:space="preserve">${highlight(l, t)}</text>`).join('\n  ');
  return `<svg xmlns="http://www.w3.org/2000/svg" width="1280" height="380" viewBox="0 0 1280 380" role="img" aria-label="OWUI Agent: a coding agent for VS Code that talks only to your own Open WebUI server">
  <defs>
    <pattern id="dots" width="22" height="22" patternUnits="userSpaceOnUse">
      <circle cx="2" cy="2" r="1.2" fill="${t.line}"/>
    </pattern>
    <linearGradient id="fade" x1="0" x2="1" y1="0" y2="0">
      <stop offset="0" stop-color="${t.bg}" stop-opacity="1"/>
      <stop offset="0.5" stop-color="${t.bg}" stop-opacity="0.25"/>
      <stop offset="1" stop-color="${t.bg}" stop-opacity="0"/>
    </linearGradient>
  </defs>
  <rect width="1280" height="380" rx="18" fill="${t.bg}"/>
  <rect width="1280" height="380" rx="18" fill="url(#dots)"/>
  <rect width="1280" height="380" rx="18" fill="url(#fade)"/>
  <rect x="0.5" y="0.5" width="1279" height="379" rx="18" fill="none" stroke="${t.line}"/>

  ${logo(64, 74, 92, t.accent)}
  <text x="168" y="150" font-family="${SANS}" font-size="76" font-weight="700" letter-spacing="-2.5" fill="${t.fg}">OWUI Agent</text>
  <text x="72" y="222" font-family="${SANS}" font-size="27" font-weight="600" letter-spacing="-0.4" fill="${t.fg}">A coding agent for VS Code that talks</text>
  <text x="72" y="256" font-family="${SANS}" font-size="27" font-weight="600" letter-spacing="-0.4" fill="${t.fg}">only to your own Open WebUI.</text>
  <text x="72" y="298" font-family="${SANS}" font-size="18" fill="${t.fgSoft}">It plans, edits files, runs your tests and fixes its mistakes,</text>
  <text x="72" y="324" font-family="${SANS}" font-size="18" fill="${t.fgSoft}">and asks you before anything risky.</text>

  <rect x="${cx}" y="${cy}" width="${cw}" height="${ch}" rx="12" fill="${t.code}" stroke="${t.line}"/>
  <path d="M${cx} ${cy + 44}h${cw}" stroke="${t.line}"/>
  <circle cx="${cx + 24}" cy="${cy + 22}" r="6" fill="${t.line}"/>
  <circle cx="${cx + 44}" cy="${cy + 22}" r="6" fill="${t.line}"/>
  <circle cx="${cx + 64}" cy="${cy + 22}" r="6" fill="${t.line}"/>
  <text x="${cx + cw - 24}" y="${cy + 28}" text-anchor="end" font-family="${MONO}" font-size="14" fill="${t.faint}">settings.json</text>
  ${lines}
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

for (const [name, t] of Object.entries(THEMES)) {
  fs.writeFileSync(path.join(OUT, `banner-${name}.svg`), banner(t));
  fs.writeFileSync(path.join(OUT, `how-it-works-${name}.svg`), diagram(t));
}
console.log('wrote', fs.readdirSync(OUT).filter((f) => f.endsWith('.svg')).join(', '));
