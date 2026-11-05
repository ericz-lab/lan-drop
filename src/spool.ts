// Where uploaded bytes wait for the receiver: one file per transfer file under the data directory.
import { mkdir, open, rm, stat, statfs } from "node:fs/promises";
import { join } from "node:path";

export class Spool {
  constructor(
    readonly dir: string,
    /** Space to leave free on the disk, in bytes. */
    readonly reserveBytes = 2 * 1024 ** 3,
  ) {}

  async init(): Promise<void> {
    // Files left by a previous run belong to transfers nobody can see any more.
    await rm(this.dir, { recursive: true, force: true });
    await mkdir(this.dir, { recursive: true });
  }

  path(transferId: string, idx: number): string {
    return join(this.dir, `${transferId}-${idx}`);
  }

  async freeBytes(): Promise<number> {
    const s = await statfs(this.dir);
    return Number(s.bavail) * Number(s.bsize);
  }

  async hasRoomFor(bytes: number): Promise<boolean> {
    return (await this.freeBytes()) - this.reserveBytes >= bytes;
  }

  /**
   * Writes one piece of a file: the request body goes at byte `offset` of the transfer file, which
   * must already hold exactly `offset` bytes (0 starts the file over). Rejects a body that would make
   * the file longer than `size`, and on any failure cuts the file back to `offset`, so the sender can
   * send the same piece again. `onProgress` gets the file's length as it grows. Returns the length.
   */
  async write(
    transferId: string,
    idx: number,
    body: ReadableStream<Uint8Array> | null,
    size: number,
    onProgress: (received: number) => void,
    offset = 0,
  ): Promise<number> {
    const path = this.path(transferId, idx);
    if (offset > 0) {
      const have = await stat(path).then((s) => s.size, () => -1);
      if (have !== offset) throw new Error("bad_offset");
    }
    const fh = await open(path, offset === 0 ? "w" : "r+");
    let pos = offset;
    try {
      if (body) {
        const reader = body.getReader();
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          if (pos + value.byteLength > size) {
            await reader.cancel().catch(() => {});
            throw new Error("too_long");
          }
          let w = 0;
          while (w < value.byteLength) w += (await fh.write(value, w, value.byteLength - w, pos + w)).bytesWritten;
          pos += value.byteLength;
          onProgress(pos);
        }
      }
      return pos;
    } catch (e) {
      await fh.truncate(offset).catch(() => {});
      throw e;
    } finally {
      await fh.close();
    }
  }

  async remove(transferId: string, count: number): Promise<void> {
    for (let i = 0; i < count; i++) await rm(this.path(transferId, i), { force: true });
  }
}
