export interface CommandAssessment {
  segments: string[];
  complex: boolean;
  warnings: string[];
  alwaysPrompt: boolean;
}

// Git options that may appear before the subcommand; the ones in GIT_OPTS_WITH_VALUE take a separate argument.
const GIT_OPTS_WITH_VALUE = new Set(['-c', '-C', '--git-dir', '--work-tree', '--namespace', '--config-env', '--exec-path', '--super-prefix']);

const RULES: { re: RegExp; warning: string }[] = [
  { re: /\bgit(?:\.exe)?\s+(commit|push|tag|merge|rebase|cherry-pick|revert|am|pull|filter-branch|update-ref|replace)\b/i, warning: 'Changes your Git history or remote. The agent must never do this without your explicit approval.' },
  { re: /\bgit(?:\.exe)?\s+(reset\s+--hard|clean\s+-[a-z]*f|checkout\s+--\s|restore\s|stash\s+(drop|clear)|branch\s+-D)\b/i, warning: 'Can discard uncommitted work in your repository.' },
  { re: /\bgit(?:\.exe)?\s+config\b(?!\s+(--get|--get-all|--list|-l)\b)/i, warning: 'Changes Git configuration, which can make Git run other programs.' },
  { re: /\b(gh|glab|hub)\s+(pr|release|repo|issue)\b/i, warning: 'Acts on your Git hosting account (pull requests, releases or issues).' },
  { re: /\b(npm|pnpm|yarn)\s+publish\b|\bcargo\s+publish\b|\btwine\s+upload\b|\bvsce\s+publish\b/i, warning: 'Publishes a package to a public registry.' },
  { re: /\bdocker(\s+compose)?\s+(start|run|up|restart)\b|\bdocker\s+desktop\b|\bcolima\s+start\b|\bpodman\s+(machine\s+start|run|start)\b/i, warning: 'Starts containers or a container runtime. If Docker is not running, look for an alternative instead of starting it.' },
  { re: /\b(systemctl|service|launchctl|brew\s+services|net\s+(start|stop)|sc\s+(start|stop|config)|Start-Service|Stop-Service|Set-Service)\b/i, warning: 'Starts, stops or changes a system service.' },
  { re: /\b(sudo|runas|doas|su)\b|Start-Process\b.*-Verb\s+RunAs/i, warning: 'Runs with elevated privileges.' },
  { re: /\b(shutdown|reboot|halt|poweroff|Restart-Computer|Stop-Computer)\b/i, warning: 'Shuts down or restarts the computer.' },
  { re: /\brm\s+-[a-z]*r[a-z]*f?[a-z]*\s+(\/|~|\$HOME|\.\.|\*)(\s|$|\/)|\bRemove-Item\b.*-Recurse.*\s(\/|~|C:\\)|\brd\s+\/s\b|\bformat\s+[a-z]:/i, warning: 'Deletes files recursively outside a clearly scoped folder.' },
  { re: /\b(curl|wget|Invoke-WebRequest|iwr|Invoke-RestMethod|irm)\b[^|]*\|\s*(sh|bash|zsh|iex|Invoke-Expression|python)\b/i, warning: 'Downloads and runs a script from the internet.' },
  { re: /\b(setx|reg\s+(add|delete)|Set-ItemProperty\s+.*HK(LM|CU)|chmod\s+-R\s+777|chown\s+-R)\b/i, warning: 'Changes system or user configuration.' },
];

const GUI_LAUNCHERS = new Set([
  'start', 'explorer', 'open', 'xdg-open', 'gio', 'start-process', 'saps', 'invoke-item', 'ii', 'code', 'code-insiders', 'cursor',
  'notepad', 'mspaint', 'calc', 'osascript', 'rundll32', 'mshta', 'wscript', 'cscript', 'msiexec', 'regsvr32',
]);
const GUI_WARNING = 'Launches an application or window on your desktop.';
const ENCODED_WARNING = 'Runs an encoded PowerShell command whose content cannot be checked.';

const SHELLS = new Set(['bash', 'sh', 'zsh', 'dash', 'fish', 'ksh', 'cmd', 'powershell', 'pwsh']);
// Never suggested for "Always allow": each one runs arbitrary code, reads or sends arbitrary data, or runs another command.
const NEVER_SUGGEST = new Set([
  ...SHELLS, 'python', 'python3', 'py', 'node', 'deno', 'bun', 'ruby', 'perl', 'php', 'lua', 'npx', 'pnpx', 'bunx', 'env', 'xargs', 'find',
  'sed', 'awk', 'gawk', 'tar', 'rsync', 'ssh', 'scp', 'curl', 'wget', 'nc', 'ncat', 'socat', 'sudo', 'doas', 'su', 'runas', 'git',
  'iex', 'invoke-expression', 'invoke-command', 'icm',
]);
const WITH_SUBCOMMAND = new Set(['npm', 'pnpm', 'yarn', 'npx', 'git', 'cargo', 'go', 'dotnet', 'pip', 'make', 'mvn', 'gradle', 'poetry', 'uv']);
// Subcommands that download and run third-party code.
const INSTALLS = new Set(['install', 'i', 'add', 'ci', 'exec', 'x', 'dlx', 'get']);
// Environment assignments that cannot change which program runs or what it loads.
const SAFE_ENV = new Set(['CI', 'NODE_ENV', 'FORCE_COLOR', 'NO_COLOR', 'DEBUG', 'TZ', 'LANG', 'LC_ALL']);
// Flags that make an allow-listed tool load or run other code, or write somewhere else.
const RISKY_FLAGS = [
  '--script-shell', '--node-options', '--require', '--import', '--loader', '--experimental-loader', '--eval', '--exec', '--upload-pack',
  '--receive-pack', '--ext-diff', '--output', '--config', '--userconfig', '--globalconfig', '--prefix',
];

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
    if (c === '(' || c === ')' || c === '{' || c === '}' || c === '\r' || c === '\0') complex = true;
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
  if (/[^\x20-\x7e\t\n]/.test(command)) complex = true;
  segments.push(cur);
  return { segments: segments.map((s) => s.trim()).filter(Boolean), complex };
}

export function tokenize(segment: string): string[] {
  const tokens: string[] = [];
  const re = /"((?:[^"\\]|\\.)*)"|'([^']*)'|(\S+)/g;
  for (const m of segment.matchAll(re)) tokens.push(m[1] ?? m[2] ?? m[3] ?? '');
  return tokens;
}

/** Splits a segment the way a POSIX shell would for word boundaries, joining adjacent quoted parts (g''it → git). */
function shellWords(segment: string): string[] {
  const words: string[] = [];
  let cur = '';
  let started = false;
  let quote: '"' | "'" | undefined;
  for (const c of segment) {
    if (quote) {
      if (c === quote) quote = undefined;
      else cur += c;
      continue;
    }
    if (c === '"' || c === "'") {
      quote = c;
      started = true;
      continue;
    }
    if (/\s/.test(c)) {
      if (started) words.push(cur);
      cur = '';
      started = false;
      continue;
    }
    cur += c;
    started = true;
  }
  if (started) words.push(cur);
  return words;
}

function programName(word: string): string {
  const base = word.split(/[\\/]/).pop() ?? word;
  return base.replace(/\.(exe|cmd|bat|com|ps1)$/i, '').toLowerCase();
}

function isEnvAssignment(word: string): boolean {
  return /^[A-Za-z_][A-Za-z0-9_]*=/.test(word);
}

function stripEnvPrefix(tokens: string[]): string[] {
  let i = 0;
  while (i < tokens.length && isEnvAssignment(tokens[i]!)) i++;
  return tokens.slice(i);
}

/** The segment as the program will see it: env prefix removed, program name normalised, Git global options dropped. */
function normalizedWords(segment: string): string[] {
  const words = stripEnvPrefix(shellWords(segment));
  if (!words.length) return words;
  const program = programName(words[0]!);
  const rest = words.slice(1);
  if (program === 'git') {
    let i = 0;
    while (i < rest.length && rest[i]!.startsWith('-')) i += GIT_OPTS_WITH_VALUE.has(rest[i]!) ? 2 : 1;
    return [program, ...rest.slice(i)];
  }
  return [program, ...rest];
}

/** For `bash -c "…"`, `cmd /c …` or `powershell -Command …`, the nested command; 'encoded' for -EncodedCommand. */
function nestedCommand(words: string[]): string | 'encoded' | undefined {
  const [program, ...rest] = words;
  if (!program || !SHELLS.has(program)) return undefined;
  for (let i = 0; i < rest.length; i++) {
    const w = rest[i]!.toLowerCase();
    if (program === 'cmd' && (w === '/c' || w === '/k' || w === '/r')) return rest.slice(i + 1).join(' ');
    if (program === 'powershell' || program === 'pwsh') {
      if (/^-(e|ec|en|enc|encodedcommand)$/.test(w)) return 'encoded';
      if (/^-(c|command|f|file)$/.test(w)) return rest.slice(i + 1).join(' ');
    } else if (/^-[a-z]*c[a-z]*$/.test(w)) return rest[i + 1] ?? '';
  }
  return undefined;
}

export function matchesEntry(segment: string, entry: string): boolean {
  const seg = stripEnvPrefix(tokenize(segment));
  const pat = tokenize(entry.trim());
  if (!pat.length || pat[0] === '*' || seg.length < pat.length) return false;
  const norm = (t: string, i: number) => (i === 0 ? t.replace(/\.(exe|cmd|bat)$/i, '').toLowerCase() : t);
  return pat.every((p, i) => (p === '*' ? true : norm(p, i) === norm(seg[i]!, i)));
}

export function assessCommand(command: string, depth = 0): CommandAssessment {
  const split = splitSegments(command);
  let complex = split.complex;
  const normalized = split.segments.map(normalizedWords);
  const unescaped = split.segments.map((seg) => normalizedWords(seg.replace(/\\/g, '')));
  const texts = [command, ...[...normalized, ...unescaped].map((w) => w.join(' '))];
  const warnings = RULES.filter((r) => texts.some((t) => r.re.test(t))).map((r) => r.warning);
  if (normalized.some((w) => !!w[0] && GUI_LAUNCHERS.has(w[0]))) warnings.push(GUI_WARNING);
  for (const words of normalized) {
    const nested = nestedCommand(words);
    if (nested === undefined) continue;
    complex = true;
    if (nested === 'encoded') warnings.push(ENCODED_WARNING);
    else if (depth < 3) warnings.push(...assessCommand(nested, depth + 1).warnings);
  }
  return { segments: split.segments, complex, warnings: [...new Set(warnings)], alwaysPrompt: warnings.length > 0 };
}

/** Removes redirections that only merge or discard output. */
function withoutHarmlessRedirects(command: string): string {
  return command.replace(/(^|\s)(?:[12]?>&[12]|[12]?>\s*(?:\/dev\/null|\$null|nul)(?=\s|$))/gi, '$1');
}

function leavesWorkspace(arg: string): boolean {
  if (/^\/[A-Za-z?]{1,2}(:\S*)?$/.test(arg)) return false; // a cmd.exe switch such as /b or /T:x
  const value = arg.includes('=') ? arg.slice(arg.indexOf('=') + 1) : arg;
  return /^([/\\~]|[A-Za-z]:)/.test(value) || /(^|[/\\])\.\.([/\\]|$)/.test(value);
}

/** Whether a command is simple enough that matching it against allowlist prefixes is meaningful. */
function canAutoApprove(command: string): boolean {
  const a = assessCommand(command);
  if (a.alwaysPrompt || a.complex || !a.segments.length) return false;
  const rest = withoutHarmlessRedirects(command);
  // Quotes must not hide metacharacters: cmd.exe does not treat single quotes as quoting at all.
  for (const m of rest.matchAll(/"([^"]*)"|'([^']*)'/g)) if (/[&|;<>^%$`(){}!\n]/.test(m[1] ?? m[2] ?? '')) return false;
  const unquoted = rest.replace(/"[^"]*"|'[^']*'/g, '""');
  if (/[<>^%$`!]/.test(unquoted)) return false;
  for (const seg of a.segments) {
    const words = shellWords(withoutHarmlessRedirects(seg));
    let i = 0;
    for (; i < words.length && isEnvAssignment(words[i]!); i++) {
      const [name, value] = [words[i]!.slice(0, words[i]!.indexOf('=')), words[i]!.slice(words[i]!.indexOf('=') + 1)];
      if (!SAFE_ENV.has(name) || !/^[\w.,:-]*$/.test(value)) return false;
    }
    for (const arg of words.slice(i + 1)) {
      if (leavesWorkspace(arg)) return false;
      if (RISKY_FLAGS.some((f) => arg === f || arg.startsWith(`${f}=`))) return false;
    }
  }
  return true;
}

export function isAllowlisted(command: string, allowlist: string[]): boolean {
  if (!canAutoApprove(command)) return false;
  const segments = splitSegments(withoutHarmlessRedirects(command)).segments;
  return segments.every((s) => allowlist.some((e) => matchesEntry(s, e)));
}

export function suggestAllowEntry(command: string): string | undefined {
  if (!canAutoApprove(command)) return undefined;
  const segments = splitSegments(withoutHarmlessRedirects(command)).segments;
  if (segments.length !== 1) return undefined;
  const tokens = stripEnvPrefix(tokenize(segments[0]!));
  const [first, second, third] = tokens;
  if (!first || /[\\/]/.test(first)) return undefined;
  const program = programName(first);
  const plainWord = (w: string | undefined) => !!w && /^[A-Za-z][\w:.-]*$/.test(w);
  if (WITH_SUBCOMMAND.has(program)) {
    if (!plainWord(second)) return undefined;
    if (program === 'npm' && second === 'run') return plainWord(third) ? `npm run ${third}` : undefined;
    if (INSTALLS.has(second!.toLowerCase())) return undefined;
    if (program === 'npx' && NEVER_SUGGEST.has(second!.toLowerCase())) return undefined;
    return `${first} ${second}`;
  }
  if (NEVER_SUGGEST.has(program)) return undefined;
  return first;
}
