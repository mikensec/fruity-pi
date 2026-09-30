/**
 * Strict JSONL record splitter for pi RPC mode.
 *
 * Splits only on LF (optionally preceded by CR). Unlike node:readline it does not
 * treat U+2028 / U+2029 as line breaks, which are legal inside JSON strings.
 * Works on raw Buffers so multi-byte UTF-8 sequences split across chunks survive.
 */
export class JsonlSplitter {
  private buf: Buffer = Buffer.alloc(0);

  constructor(private onLine: (line: string) => void) {}

  push(chunk: Buffer) {
    this.buf = this.buf.length ? Buffer.concat([this.buf, chunk]) : chunk;
    let start = 0;
    let idx: number;
    while ((idx = this.buf.indexOf(0x0a, start)) !== -1) {
      let end = idx;
      if (end > start && this.buf[end - 1] === 0x0d) end--;
      const line = this.buf.toString("utf8", start, end);
      start = idx + 1;
      if (line.length) this.onLine(line);
    }
    this.buf = start ? this.buf.subarray(start) : this.buf;
  }

  /** Flush a trailing record without a final newline. */
  end() {
    if (this.buf.length) {
      const line = this.buf.toString("utf8");
      this.buf = Buffer.alloc(0);
      if (line.trim()) this.onLine(line);
    }
  }
}
