export interface SseEvent {
  event?: string;
  data: string;
}

export class SseDecoder {
  private buffer = '';
  private dataLines: string[] = [];
  private eventName: string | undefined;

  push(chunk: string): SseEvent[] {
    this.buffer += chunk;
    const events: SseEvent[] = [];
    for (;;) {
      const match = /\r\n|\r|\n/.exec(this.buffer);
      if (!match) break;
      if (match[0] === '\r' && match.index === this.buffer.length - 1) break;
      const line = this.buffer.slice(0, match.index);
      this.buffer = this.buffer.slice(match.index + match[0].length);
      const ev = this.processLine(line);
      if (ev) events.push(ev);
    }
    return events;
  }

  flush(): SseEvent[] {
    const events: SseEvent[] = [];
    if (this.buffer) {
      const ev = this.processLine(this.buffer);
      this.buffer = '';
      if (ev) events.push(ev);
    }
    const last = this.dispatch();
    if (last) events.push(last);
    return events;
  }

  private processLine(line: string): SseEvent | undefined {
    if (line === '') return this.dispatch();
    if (line.startsWith(':')) return undefined;
    const colon = line.indexOf(':');
    const field = colon === -1 ? line : line.slice(0, colon);
    let value = colon === -1 ? '' : line.slice(colon + 1);
    if (value.startsWith(' ')) value = value.slice(1);
    if (field === 'data') this.dataLines.push(value);
    else if (field === 'event') this.eventName = value;
    return undefined;
  }

  private dispatch(): SseEvent | undefined {
    if (!this.dataLines.length) {
      this.eventName = undefined;
      return undefined;
    }
    const ev: SseEvent = { data: this.dataLines.join('\n') };
    if (this.eventName) ev.event = this.eventName;
    this.dataLines = [];
    this.eventName = undefined;
    return ev;
  }
}
