/**
 * The bounded output tail (2.4): the last `max` bytes of a stream, and
 * whether anything before them was dropped. Memory stays at `max` however
 * much the process writes.
 */

const decoder = new TextDecoder();

export class ByteTail {
  private chunks: Uint8Array[] = [];
  private size = 0;
  private dropped = false;

  constructor(private readonly max: number) {}

  push(chunk: Uint8Array): void {
    if (chunk.byteLength === 0) return;
    if (chunk.byteLength >= this.max) {
      this.dropped ||= chunk.byteLength > this.max || this.size > 0;
      this.chunks = [chunk.slice(chunk.byteLength - this.max)];
      this.size = this.max;
      return;
    }
    this.chunks.push(chunk.slice());
    this.size += chunk.byteLength;
    while (this.size > this.max) {
      const first = this.chunks[0]!;
      const excess = this.size - this.max;
      this.dropped = true;
      if (first.byteLength <= excess) {
        this.chunks.shift();
        this.size -= first.byteLength;
      } else {
        this.chunks[0] = first.subarray(excess);
        this.size -= excess;
      }
    }
  }

  get truncated(): boolean {
    return this.dropped;
  }

  /** The kept bytes as UTF-8; a cut that split a character starts at the next one. */
  text(): string {
    const all = new Uint8Array(this.size);
    let offset = 0;
    for (const chunk of this.chunks) {
      all.set(chunk, offset);
      offset += chunk.byteLength;
    }
    let start = 0;
    if (this.dropped) while (start < all.byteLength && (all[start]! & 0xc0) === 0x80) start++;
    return decoder.decode(all.subarray(start));
  }
}
