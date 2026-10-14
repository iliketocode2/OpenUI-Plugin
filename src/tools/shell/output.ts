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
