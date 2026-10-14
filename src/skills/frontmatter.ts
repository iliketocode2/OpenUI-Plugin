export interface Frontmatter {
  data: Record<string, string>;
  body: string;
}

export function parseFrontmatter(text: string): Frontmatter {
  const src = text.replace(/^﻿/, '');
  const m = /^---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/.exec(src);
  if (!m) return { data: {}, body: src };
  const data: Record<string, string> = {};
  const lines = m[1]!.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const kv = /^([A-Za-z_][\w-]*)\s*:\s*(.*)$/.exec(line);
    if (!kv) continue;
    const key = kv[1]!;
    let value = kv[2]!.trim();
    if (value === '|' || value === '>' || value === '|-' || value === '>-') {
      const block: string[] = [];
      while (i + 1 < lines.length && (/^\s+\S/.test(lines[i + 1]!) || lines[i + 1] === '')) block.push(lines[++i]!.trim());
      value = value.startsWith('|') ? block.join('\n').trim() : block.filter(Boolean).join(' ');
    } else {
      value = unquote(value.replace(/\s+#.*$/, ''));
    }
    data[key] = value;
  }
  return { data, body: src.slice(m[0].length) };
}

function unquote(v: string): string {
  if (v.length >= 2 && ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'")))) {
    const inner = v.slice(1, -1);
    return v.startsWith('"') ? inner.replace(/\\"/g, '"').replace(/\\n/g, '\n') : inner.replace(/''/g, "'");
  }
  return v;
}
