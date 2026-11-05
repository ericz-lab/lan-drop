// Where uploaded bytes wait for the receiver: one file per transfer file under the data directory.
import { mkdir, rm, statfs } from "node:fs/promises";
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
   * Writes a request body to the transfer file. Rejects when the body is longer or shorter than
   * `size`, removing what was written. `onProgress` gets the byte count as it grows.
   */
  async write(
    transferId: string,
    idx: number,
    body: ReadableStream<Uint8Array> | null,
    size: number,
    onProgress: (received: number) => void,
  ): Promise<void> {
    const path = this.path(transferId, idx);
    const writer = Bun.file(path).writer({ highWaterMark: 1024 * 1024 });
    let received = 0;
    try {
      if (body) {
        const reader = body.getReader();
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          received += value.byteLength;
          if (received > size) {
            await reader.cancel().catch(() => {});
            throw new Error("too_long");
          }
          writer.write(value);
          await writer.flush();
          onProgress(received);
        }
      }
      await writer.end();
      if (received !== size) throw new Error("incomplete");
    } catch (e) {
      try {
        await writer.end();
      } catch {}
      await rm(path, { force: true });
      throw e;
    }
  }

  async remove(transferId: string, count: number): Promise<void> {
    for (let i = 0; i < count; i++) await rm(this.path(transferId, i), { force: true });
  }
}
