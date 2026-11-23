import { StringDecoder } from 'node:string_decoder';

const ANSI = /\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[@-Z\\-_]/g;

export function stripAnsi(text: string): string {
  return text.replace(ANSI, '');
}

export function normalizeNewlines(text: string): string {
  return text.replace(/\r\n/g, '\n').replace(/^.*\r(?!\n)/gm, (line) => line.slice(line.lastIndexOf('\r') + 1));
}

export function cleanOutput(text: string): string {
  return normalizeNewlines(stripAnsi(text));
}

/** An unfinished line longer than this is passed on anyway, so output without newlines cannot pile up unseen. */
const MAX_PENDING = 64 * 1024;

/** Turns one stream of raw process output into clean text. Chunks can end anywhere: inside a UTF-8 character, between
 * \r and \n, or inside an ANSI code. So it decodes as a stream and cleans whole lines only, holding back the
 * unfinished last line until the rest arrives. */
export class OutputDecoder {
  private readonly decoder = new StringDecoder('utf8');
  private pending = '';

  /** Returns the complete lines this chunk finished, cleaned. */
  push(chunk: Buffer): string {
    this.pending += this.decoder.write(chunk);
    const end = this.pending.lastIndexOf('\n');
    let done = '';
    if (end !== -1) {
      done = this.pending.slice(0, end + 1);
      this.pending = this.pending.slice(end + 1);
    }
    // A progress bar redraws one line with \r; only its latest state matters. A final \r may be half of \r\n.
    const cr = this.pending.lastIndexOf('\r', this.pending.length - 2);
    if (cr !== -1) this.pending = this.pending.slice(cr + 1);
    if (this.pending.length > MAX_PENDING) {
      done += this.pending;
      this.pending = '';
    }
    return done ? cleanOutput(done) : '';
  }

  /** The unfinished last line as it would look now, for live display. */
  get partial(): string {
    return cleanOutput(this.pending);
  }

  /** Returns whatever is left once the stream has ended, and resets. */
  flush(): string {
    const rest = this.pending + this.decoder.end();
    this.pending = '';
    return rest ? cleanOutput(rest) : '';
  }
}

export interface Truncated {
  text: string;
  truncated: boolean;
  omittedChars: number;
}

export function truncateMiddle(text: string, maxChars: number): Truncated {
  if (text.length <= maxChars) return { text, truncated: false, omittedChars: 0 };
  const head = Math.floor(maxChars * 0.4);
  const tail = maxChars - head;
  const omitted = text.length - head - tail;
  const headText = text.slice(0, head);
  const tailText = text.slice(text.length - tail);
  const omittedLines = text.slice(head, text.length - tail).split('\n').length - 1;
  return {
    text: `${headText}\n… [${omitted} characters${omittedLines ? `, ${omittedLines} lines` : ''} omitted] …\n${tailText}`,
    truncated: true,
    omittedChars: omitted,
  };
}

export class OutputBuffer {
  private chunks: string[] = [];
  private size = 0;
  private dropped = 0;
  private readCursor = 0;
  private total = 0;

  constructor(private readonly maxChars: number) {}

  push(text: string): void {
    this.chunks.push(text);
    this.size += text.length;
    this.total += text.length;
    while (this.size > this.maxChars && this.chunks.length > 1) {
      const removed = this.chunks.shift()!;
      this.size -= removed.length;
      this.dropped += removed.length;
    }
  }

  all(): string {
    const text = this.chunks.join('');
    return this.dropped ? `… [${this.dropped} earlier characters dropped] …\n${text}` : text;
  }

  sinceLastRead(): string {
    const start = Math.max(this.readCursor, this.dropped);
    const text = this.chunks.join('').slice(start - this.dropped);
    const skipped = start - this.readCursor;
    this.readCursor = this.total;
    return skipped > 0 ? `… [${skipped} characters dropped before they were read] …\n${text}` : text;
  }

  get length(): number {
    return this.total;
  }
}
