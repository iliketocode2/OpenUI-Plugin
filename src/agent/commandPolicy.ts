export interface CommandAssessment {
  segments: string[];
  complex: boolean;
  warnings: string[];
  alwaysPrompt: boolean;
}

const RULES: { re: RegExp; warning: string }[] = [
  { re: /\bgit\s+(?:-c\s+\S+\s+)*(commit|push|tag|merge|rebase|cherry-pick|revert|am)\b/i, warning: 'Changes your Git history or remote. The agent must never do this without your explicit approval.' },
  { re: /\bgit\s+(?:-c\s+\S+\s+)*(reset\s+--hard|clean\s+-[a-z]*f|checkout\s+--\s|restore\s|stash\s+(drop|clear)|branch\s+-D)\b/i, warning: 'Can discard uncommitted work in your repository.' },
  { re: /\b(gh|glab|hub)\s+(pr|release|repo|issue)\b/i, warning: 'Acts on your Git hosting account (pull requests, releases or issues).' },
  { re: /\b(npm|pnpm|yarn)\s+publish\b|\bcargo\s+publish\b|\btwine\s+upload\b|\bvsce\s+publish\b/i, warning: 'Publishes a package to a public registry.' },
  { re: /\bdocker(\s+compose)?\s+(start|run|up|restart)\b|\bdocker\s+desktop\b|\bcolima\s+start\b|\bpodman\s+(machine\s+start|run|start)\b/i, warning: 'Starts containers or a container runtime. If Docker is not running, look for an alternative instead of starting it.' },
  { re: /\b(systemctl|service|launchctl|brew\s+services|net\s+(start|stop)|sc(\.exe)?\s+(start|stop|config)|Start-Service|Stop-Service|Set-Service)\b/i, warning: 'Starts, stops or changes a system service.' },
  { re: /\b(sudo|runas|doas)\b|Start-Process\b.*-Verb\s+RunAs/i, warning: 'Runs with elevated privileges.' },
  { re: /\b(shutdown|reboot|halt|poweroff|Restart-Computer|Stop-Computer)\b/i, warning: 'Shuts down or restarts the computer.' },
  { re: /\brm\s+-[a-z]*r[a-z]*f?[a-z]*\s+(\/|~|\$HOME|\.\.|\*)(\s|$|\/)|\bRemove-Item\b.*-Recurse.*\s(\/|~|C:\\)|\brd\s+\/s\b|\bformat\s+[a-z]:/i, warning: 'Deletes files recursively outside a clearly scoped folder.' },
  { re: /\b(curl|wget|Invoke-WebRequest|iwr|Invoke-RestMethod|irm)\b[^|]*\|\s*(sh|bash|zsh|iex|Invoke-Expression|python)\b/i, warning: 'Downloads and runs a script from the internet.' },
  { re: /\b(setx|reg\s+(add|delete)|Set-ItemProperty\s+.*HK(LM|CU)|chmod\s+-R\s+777|chown\s+-R)\b/i, warning: 'Changes system or user configuration.' },
];

const GUI_LAUNCHERS = new Set(['start', 'explorer', 'open', 'xdg-open', 'gio', 'start-process', 'saps', 'invoke-item', 'ii', 'code', 'code-insiders', 'cursor', 'notepad', 'mspaint', 'calc', 'osascript']);
const GUI_WARNING = 'Launches an application or window on your desktop.';

export function splitSegments(command: string): { segments: string[]; complex: boolean } {
  const segments: string[] = [];
  let cur = '';
  let quote: '"' | "'" | undefined;
  let complex = false;
  for (let i = 0; i < command.length; i++) {
    const c = command[i]!;
    const next = command[i + 1];
    if (quote) {
      if (c === quote) quote = undefined;
      else if (quote === '"' && (c === '$' && next === '(' || c === '`')) complex = true;
      cur += c;
      continue;
    }
    if (c === '"' || c === "'") {
      quote = c;
      cur += c;
      continue;
    }
    if ((c === '$' && next === '(') || c === '`' || (c === '<' && next === '(') || (c === '>' && next === '(')) complex = true;
    if (c === '&' && next === '&') {
      segments.push(cur);
      cur = '';
      i++;
      continue;
    }
    if (c === '|' && next === '|') {
      segments.push(cur);
      cur = '';
      i++;
      continue;
    }
    if (c === '&' && (command[i - 1] === '>' || next === '>')) {
      cur += c;
      continue;
    }
    if (c === ';' || c === '|' || c === '\n' || c === '&') {
      if (c === '&' && cur.trim() === '') {
        cur += c;
        continue;
      }
      segments.push(cur);
      cur = '';
      continue;
    }
    cur += c;
  }
  if (quote) complex = true;
  segments.push(cur);
  return { segments: segments.map((s) => s.trim()).filter(Boolean), complex };
}

export function tokenize(segment: string): string[] {
  const tokens: string[] = [];
  const re = /"((?:[^"\\]|\\.)*)"|'([^']*)'|(\S+)/g;
  for (const m of segment.matchAll(re)) tokens.push(m[1] ?? m[2] ?? m[3] ?? '');
  return tokens;
}

function stripEnvPrefix(tokens: string[]): string[] {
  let i = 0;
  while (i < tokens.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[i]!)) i++;
  return tokens.slice(i);
}

export function matchesEntry(segment: string, entry: string): boolean {
  const seg = stripEnvPrefix(tokenize(segment));
  const pat = tokenize(entry.trim());
  if (!pat.length || seg.length < pat.length) return false;
  const norm = (t: string, i: number) => (i === 0 ? t.replace(/\.(exe|cmd|bat)$/i, '').toLowerCase() : t);
  return pat.every((p, i) => (p === '*' ? true : norm(p, i) === norm(seg[i]!, i)));
}

export function assessCommand(command: string): CommandAssessment {
  const { segments, complex } = splitSegments(command);
  const warnings = RULES.filter((r) => r.re.test(command)).map((r) => r.warning);
  const launchesGui = segments.some((seg) => {
    const first = stripEnvPrefix(tokenize(seg))[0];
    return !!first && GUI_LAUNCHERS.has(first.replace(/\.(exe|cmd|bat)$/i, '').toLowerCase());
  });
  if (launchesGui) warnings.push(GUI_WARNING);
  return { segments, complex, warnings: [...new Set(warnings)], alwaysPrompt: warnings.length > 0 };
}

export function isAllowlisted(command: string, allowlist: string[]): boolean {
  const a = assessCommand(command);
  if (a.alwaysPrompt || a.complex || !a.segments.length) return false;
  if (/(^|[^>&0-9])>{1,2}\s*(?!&)(?!\/dev\/null)\S/.test(command) && !/^\s*\S+\s*>\s*\$null\s*$/.test(command)) return false;
  return a.segments.every((s) => allowlist.some((e) => matchesEntry(s, e)));
}

export function suggestAllowEntry(command: string): string | undefined {
  const a = assessCommand(command);
  if (a.alwaysPrompt || a.complex || a.segments.length !== 1) return undefined;
  const tokens = stripEnvPrefix(tokenize(a.segments[0]!));
  if (!tokens.length) return undefined;
  const [first, second] = tokens;
  const withSub = new Set(['npm', 'pnpm', 'yarn', 'npx', 'git', 'cargo', 'go', 'dotnet', 'pip', 'python', 'python3', 'node', 'deno', 'bun', 'make', 'mvn', 'gradle', 'poetry', 'uv']);
  if (second && withSub.has(first!.toLowerCase()) && !second.startsWith('-')) {
    if (first === 'npm' && second === 'run' && tokens[2]) return `npm run ${tokens[2]}`;
    return `${first} ${second}`;
  }
  return first;
}
