// A batch of received files as one ZIP download, streamed from the spool. Stored, not compressed:
// photos and videos are compressed already, and storing keeps it fast. Each entry's CRC goes in a
// data descriptor after its bytes, so nothing is read twice. Plain ZIP (no ZIP64): the whole archive
// stays under 4 GiB, and a larger batch downloads file by file instead.

export interface ZipEntry {
  name: string;
  path: string;
  size: number;
}

const LOCAL = 30;
const DESCRIPTOR = 16;
const CENTRAL = 46;
const END = 22;
export const ZIP_MAX = 0xffffffff;

const enc = new TextEncoder();

/**
 * The Info-ZIP Unicode Path field (0x7075): some unzip builds ignore the UTF-8 flag and read the
 * name in a local code page, but take this field's name when it is there.
 */
function unicodePath(name: Uint8Array): Uint8Array {
  const f = new DataView(new ArrayBuffer(9 + name.byteLength));
  f.setUint16(0, 0x7075, true);
  f.setUint16(2, 5 + name.byteLength, true);
  f.setUint8(4, 1);
  f.setUint32(5, Bun.hash.crc32(name), true);
  const out = new Uint8Array(f.buffer);
  out.set(name, 9);
  return out;
}
const extraLen = (nameLen: number) => 9 + nameLen;

/** Names made unique the way a file manager does: "a.jpg", "a (2).jpg". */
export function uniqueNames(names: string[]): string[] {
  const seen = new Map<string, number>();
  return names.map((n) => {
    const key = n.toLowerCase();
    const count = (seen.get(key) ?? 0) + 1;
    seen.set(key, count);
    if (count === 1) return n;
    const dot = n.lastIndexOf(".");
    const [base, ext] = dot > 0 ? [n.slice(0, dot), n.slice(dot)] : [n, ""];
    const alt = `${base} (${count})${ext}`;
    seen.set(alt.toLowerCase(), 1);
    return alt;
  });
}

/** The archive's exact length, or null when it would not fit a plain ZIP. */
export function zipSize(entries: { name: string; size: number }[]): number | null {
  let total = END;
  for (const e of entries) {
    const n = enc.encode(e.name).byteLength;
    total += LOCAL + n + extraLen(n) + e.size + DESCRIPTOR + CENTRAL + n + extraLen(n);
    if (e.size >= ZIP_MAX) return null;
  }
  return total < ZIP_MAX && entries.length < 0xffff ? total : null;
}

function dosTime(d: Date): { time: number; date: number } {
  return {
    time: (d.getHours() << 11) | (d.getMinutes() << 5) | Math.floor(d.getSeconds() / 2),
    date: ((Math.max(1980, d.getFullYear()) - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate(),
  };
}

export function zipStream(entries: ZipEntry[], when = new Date()): ReadableStream<Uint8Array> {
  const { time, date } = dosTime(when);
  const central: Uint8Array[] = [];
  let offset = 0;
  let i = 0;
  return new ReadableStream<Uint8Array>({
    async pull(ctl) {
      if (i < entries.length) {
        const e = entries[i++]!;
        const name = enc.encode(e.name);
        const extra = unicodePath(name);
        const flags = 0x0008 | 0x0800; // data descriptor, UTF-8 names
        const head = new DataView(new ArrayBuffer(LOCAL));
        head.setUint32(0, 0x04034b50, true);
        head.setUint16(4, 20, true);
        head.setUint16(6, flags, true);
        head.setUint16(8, 0, true); // stored
        head.setUint16(10, time, true);
        head.setUint16(12, date, true);
        head.setUint32(14, 0, true); // CRC in the descriptor
        head.setUint32(18, e.size, true);
        head.setUint32(22, e.size, true);
        head.setUint16(26, name.byteLength, true);
        head.setUint16(28, extra.byteLength, true);
        ctl.enqueue(new Uint8Array(head.buffer));
        ctl.enqueue(name);
        ctl.enqueue(extra);
        let crc = 0;
        let read = 0;
        const reader = Bun.file(e.path).stream().getReader();
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          crc = Bun.hash.crc32(value, crc);
          read += value.byteLength;
          ctl.enqueue(value);
        }
        if (read !== e.size) throw new Error(`size changed: ${e.name}`);
        const desc = new DataView(new ArrayBuffer(DESCRIPTOR));
        desc.setUint32(0, 0x08074b50, true);
        desc.setUint32(4, crc, true);
        desc.setUint32(8, e.size, true);
        desc.setUint32(12, e.size, true);
        ctl.enqueue(new Uint8Array(desc.buffer));

        const c = new DataView(new ArrayBuffer(CENTRAL));
        c.setUint32(0, 0x02014b50, true);
        c.setUint16(4, 20, true);
        c.setUint16(6, 20, true);
        c.setUint16(8, flags, true);
        c.setUint16(10, 0, true);
        c.setUint16(12, time, true);
        c.setUint16(14, date, true);
        c.setUint32(16, crc, true);
        c.setUint32(20, e.size, true);
        c.setUint32(24, e.size, true);
        c.setUint16(28, name.byteLength, true);
        c.setUint16(30, extra.byteLength, true);
        c.setUint32(42, offset, true);
        const rec = new Uint8Array(CENTRAL + name.byteLength + extra.byteLength);
        rec.set(new Uint8Array(c.buffer), 0);
        rec.set(name, CENTRAL);
        rec.set(extra, CENTRAL + name.byteLength);
        central.push(rec);
        offset += LOCAL + name.byteLength + extra.byteLength + e.size + DESCRIPTOR;
        return;
      }
      let dirSize = 0;
      for (const rec of central) {
        ctl.enqueue(rec);
        dirSize += rec.byteLength;
      }
      const end = new DataView(new ArrayBuffer(END));
      end.setUint32(0, 0x06054b50, true);
      end.setUint16(8, entries.length, true);
      end.setUint16(10, entries.length, true);
      end.setUint32(12, dirSize, true);
      end.setUint32(16, offset, true);
      ctl.enqueue(new Uint8Array(end.buffer));
      ctl.close();
    },
  });
}
