// Minimal constant-frame-rate AVC/HEVC MP4 metadata. Encoded samples are streamed
// into one mdat on the host; only sample sizes/key indices stay in memory.
const ascii = s => new TextEncoder().encode(s);
const zeros = n => new Uint8Array(n);
export const concat = (...xs) => {
  const result = new Uint8Array(xs.reduce((n, x) => n + x.length, 0));
  let at = 0;
  for (const x of xs) { result.set(x, at); at += x.length; }
  return result;
};
const u16 = n => Uint8Array.of(n >>> 8, n & 255);
const u32 = n => Uint8Array.of(n >>> 24, n >>> 16 & 255, n >>> 8 & 255, n & 255);
const u64 = n => { const a = new Uint8Array(8); new DataView(a.buffer).setBigUint64(0, BigInt(n)); return a; };
const box = (name, ...xs) => { const body = concat(...xs); return concat(u32(body.length + 8), ascii(name), body); };
const full = (name, version, flags, ...xs) => box(name, Uint8Array.of(version, flags >>> 16, flags >>> 8 & 255, flags & 255), ...xs);
const matrix = concat(u32(0x10000), u32(0), u32(0), u32(0), u32(0x10000), u32(0), u32(0), u32(0), u32(0x40000000));

export function fileHeader() {
  const ftyp = box('ftyp', ascii('isom'), u32(0x200), ascii('isomiso6mp41'));
  return { bytes: concat(ftyp, u32(1), ascii('mdat'), u64(0)), mdatOffset: ftyp.length };
}

export function movieMetadata({ width, height, fpsNum, fpsDen, sizes, keys, description, codec, colorSpace }) {
  const duration = sizes.length * fpsDen;
  if (!sizes.length || !description?.length) throw Error('Missing encoded samples or decoder configuration');
  const mvhd = full('mvhd', 1, 0, u64(0), u64(0), u32(fpsNum), u64(duration), u32(0x10000), u16(0x100), zeros(10), matrix, zeros(24), u32(2));
  const tkhd = full('tkhd', 1, 7, u64(0), u64(0), u32(1), u32(0), u64(duration), zeros(8), u16(0), u16(0), u16(0), u16(0), matrix, u32(width * 65536), u32(height * 65536));
  const mdhd = full('mdhd', 1, 0, u64(0), u64(0), u32(fpsNum), u64(duration), u16(0x55c4), u16(0));
  const hdlr = full('hdlr', 0, 0, u32(0), ascii('vide'), zeros(12), ascii('webreel\0'));
  const configType = codec === 'hevc' ? 'hvcC' : 'avcC';
  const sampleType = codec === 'hevc' ? 'hvc1' : 'avc1';
  const colorCodes = { bt709: 1, bt470bg: 5, smpte170m: 6, bt2020: 9, 'iec61966-2-1': 13, rgb: 0 };
  const c = colorSpace ?? {};
  const colr = box('colr', ascii('nclx'), u16(colorCodes[c.primaries] ?? 1), u16(colorCodes[c.transfer] ?? 1), u16(colorCodes[c.matrix] ?? 1), Uint8Array.of(c.fullRange ? 128 : 0));
  const sample = box(sampleType, zeros(6), u16(1), zeros(16), u16(width), u16(height), u32(0x480000), u32(0x480000), u32(0), u16(1), zeros(32), u16(24), u16(0xffff), box(configType, description), colr);
  const stsd = full('stsd', 0, 0, u32(1), sample);
  const stts = full('stts', 0, 0, u32(1), u32(sizes.length), u32(fpsDen));
  const stsc = full('stsc', 0, 0, u32(1), u32(1), u32(sizes.length), u32(1));
  const sizeTable = new Uint8Array(sizes.length * 4);
  const sv = new DataView(sizeTable.buffer);
  sizes.forEach((size, i) => sv.setUint32(i * 4, size));
  const stsz = full('stsz', 0, 0, u32(0), u32(sizes.length), sizeTable);
  const co64 = full('co64', 0, 0, u32(1), u64(fileHeader().bytes.length));
  const keyTable = new Uint8Array(keys.length * 4);
  const kv = new DataView(keyTable.buffer);
  keys.forEach((key, i) => kv.setUint32(i * 4, key));
  const stss = full('stss', 0, 0, u32(keys.length), keyTable);
  const stbl = box('stbl', stsd, stts, stsc, stsz, co64, stss);
  const dref = full('dref', 0, 0, u32(1), full('url ', 0, 1));
  const minf = box('minf', full('vmhd', 0, 1, zeros(8)), box('dinf', dref), stbl);
  return box('moov', mvhd, box('trak', tkhd, box('mdia', mdhd, hdlr, minf)));
}
