// A minimal ZIP writer -- no compression, no dependencies.
//
// The export bundle is a handful of small text files, so STORE (method 0) is
// plenty and avoids pulling in a deflate implementation. Browsers prompt when
// a page triggers several downloads in a row, so one archive beats one file
// per art chunk.

const crcTable = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(bytes) {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i += 1) c = crcTable[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

// DOS timestamp: 2-second resolution, epoch 1980
function dosTime(d) {
  const time = ((d.getHours() & 31) << 11) | ((d.getMinutes() & 63) << 5) | ((d.getSeconds() / 2) & 31);
  const date = (((d.getFullYear() - 1980) & 127) << 9) | (((d.getMonth() + 1) & 15) << 5) | (d.getDate() & 31);
  return { time, date };
}

/**
 * @param {{name: string, text: string}[]} files
 * @returns {Blob} a .zip
 */
export function makeZip(files) {
  const enc = new TextEncoder();
  const now = dosTime(new Date());
  const chunks = [];
  const central = [];
  let offset = 0;

  for (const file of files) {
    const nameBytes = enc.encode(file.name);
    const data = enc.encode(file.text);
    const crc = crc32(data);

    const local = new DataView(new ArrayBuffer(30));
    local.setUint32(0, 0x04034b50, true);   // local file header
    local.setUint16(4, 20, true);           // version needed
    local.setUint16(6, 0x0800, true);       // flags: UTF-8 filename
    local.setUint16(8, 0, true);            // method: store
    local.setUint16(10, now.time, true);
    local.setUint16(12, now.date, true);
    local.setUint32(14, crc, true);
    local.setUint32(18, data.length, true);
    local.setUint32(22, data.length, true);
    local.setUint16(26, nameBytes.length, true);
    local.setUint16(28, 0, true);           // extra length

    chunks.push(new Uint8Array(local.buffer), nameBytes, data);

    const dir = new DataView(new ArrayBuffer(46));
    dir.setUint32(0, 0x02014b50, true);     // central directory header
    dir.setUint16(4, 20, true);             // version made by
    dir.setUint16(6, 20, true);             // version needed
    dir.setUint16(8, 0x0800, true);
    dir.setUint16(10, 0, true);
    dir.setUint16(12, now.time, true);
    dir.setUint16(14, now.date, true);
    dir.setUint32(16, crc, true);
    dir.setUint32(20, data.length, true);
    dir.setUint32(24, data.length, true);
    dir.setUint16(28, nameBytes.length, true);
    dir.setUint32(42, offset, true);        // offset of local header

    central.push(new Uint8Array(dir.buffer), nameBytes);
    offset += 30 + nameBytes.length + data.length;
  }

  const centralSize = central.reduce((n, c) => n + c.length, 0);
  const end = new DataView(new ArrayBuffer(22));
  end.setUint32(0, 0x06054b50, true);       // end of central directory
  end.setUint16(8, files.length, true);
  end.setUint16(10, files.length, true);
  end.setUint32(12, centralSize, true);
  end.setUint32(16, offset, true);

  return new Blob([...chunks, ...central, new Uint8Array(end.buffer)],
    { type: 'application/zip' });
}

// --- reading ----------------------------------------------------------------

const EOCD = 0x06054b50;
const CENTRAL = 0x02014b50;

/**
 * Read a zip into { name: text }.
 *
 * Handles STORE (what we write) and DEFLATE (what Finder or `zip` produce if
 * the bundle is unpacked and repacked), the latter via the platform's own
 * DecompressionStream -- so still no dependency.
 */
export async function readZip(buffer) {
  const buf = new Uint8Array(buffer);
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);

  // the end-of-central-directory record lives in the last 64k + 22 bytes
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65558); i -= 1) {
    if (dv.getUint32(i, true) === EOCD) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('not a zip archive');

  const count = dv.getUint16(eocd + 10, true);
  let p = dv.getUint32(eocd + 16, true);
  const dec = new TextDecoder();
  const out = new Map();

  for (let n = 0; n < count; n += 1) {
    if (dv.getUint32(p, true) !== CENTRAL) throw new Error('corrupt central directory');
    const method = dv.getUint16(p + 10, true);
    const compressedSize = dv.getUint32(p + 20, true);
    const nameLen = dv.getUint16(p + 28, true);
    const extraLen = dv.getUint16(p + 30, true);
    const commentLen = dv.getUint16(p + 32, true);
    const localOffset = dv.getUint32(p + 42, true);
    const name = dec.decode(buf.subarray(p + 46, p + 46 + nameLen));

    // the local header repeats the lengths, and they can differ from the
    // central copy -- the local ones are what the data actually follows
    const lNameLen = dv.getUint16(localOffset + 26, true);
    const lExtraLen = dv.getUint16(localOffset + 28, true);
    const start = localOffset + 30 + lNameLen + lExtraLen;
    const data = buf.subarray(start, start + compressedSize);

    if (!name.endsWith('/')) {
      if (method === 0) {
        out.set(name, dec.decode(data));
      } else if (method === 8) {
        const stream = new Blob([data]).stream()
          .pipeThrough(new DecompressionStream('deflate-raw'));
        out.set(name, await new Response(stream).text());
      } else {
        throw new Error(`${name}: unsupported compression method ${method}`);
      }
    }

    p += 46 + nameLen + extraLen + commentLen;
  }

  return out;
}
