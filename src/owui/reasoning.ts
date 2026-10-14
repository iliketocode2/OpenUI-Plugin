export interface SplitPiece {
  kind: 'content' | 'reasoning';
  text: string;
}

const OPEN = '<think>';
const CLOSE = '</think>';

function partialSuffix(text: string, tag: string): number {
  const max = Math.min(text.length, tag.length - 1);
  for (let n = max; n > 0; n--) {
    if (tag.startsWith(text.slice(text.length - n))) return n;
  }
  return 0;
}

export class ThinkTagSplitter {
  private inThink = false;
  private pending = '';

  push(text: string): SplitPiece[] {
    const out: SplitPiece[] = [];
    let buf = this.pending + text;
    this.pending = '';
    while (buf) {
      const tag = this.inThink ? CLOSE : OPEN;
      const idx = buf.indexOf(tag);
      if (idx !== -1) {
        if (idx > 0) out.push({ kind: this.inThink ? 'reasoning' : 'content', text: buf.slice(0, idx) });
        buf = buf.slice(idx + tag.length);
        this.inThink = !this.inThink;
        continue;
      }
      const hold = partialSuffix(buf, tag);
      const emit = buf.slice(0, buf.length - hold);
      if (emit) out.push({ kind: this.inThink ? 'reasoning' : 'content', text: emit });
      this.pending = buf.slice(buf.length - hold);
      break;
    }
    return merge(out);
  }

  flush(): SplitPiece[] {
    const rest = this.pending;
    this.pending = '';
    return rest ? [{ kind: this.inThink ? 'reasoning' : 'content', text: rest }] : [];
  }
}

function merge(pieces: SplitPiece[]): SplitPiece[] {
  const out: SplitPiece[] = [];
  for (const p of pieces) {
    const last = out[out.length - 1];
    if (last && last.kind === p.kind) last.text += p.text;
    else out.push({ ...p });
  }
  return out;
}

export function stripThinkTags(text: string): string {
  return text.replace(/<think>[\s\S]*?(?:<\/think>|$)/g, '').replace(/^\s+/, '');
}
