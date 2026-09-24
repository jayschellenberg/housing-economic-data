import { describe, it, expect } from 'vitest';
import { withPngDpi, EXPORT_W, EXPORT_H, EXPORT_DPI } from '../src/png-export.js';

// A minimal 1×1 PNG: signature, IHDR, IDAT, IEND.
const PNG_1PX = Uint8Array.from(atob(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8/5+hHgAHggJ/PchI7wAAAABJRU5ErkJggg=='),
  c => c.charCodeAt(0));

function chunks(bytes) {
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const out = [];
  for (let off = 8; off < bytes.length;) {
    const len = v.getUint32(off);
    out.push({ type: String.fromCharCode(...bytes.subarray(off + 4, off + 8)), off, len });
    off += 12 + len;
  }
  return out;
}

describe('export size', () => {
  it('is 1950 × 1050 at 300 DPI (6.5 × 3.5 in)', () => {
    expect([EXPORT_W, EXPORT_H, EXPORT_DPI]).toEqual([1950, 1050, 300]);
  });
});

describe('withPngDpi', () => {
  it('inserts a 300 DPI pHYs chunk straight after IHDR', () => {
    const out = withPngDpi(PNG_1PX, 300);
    const cs = chunks(out);
    expect(cs.map(c => c.type)).toEqual(['IHDR', 'pHYs', 'IDAT', 'IEND']);
    const p = cs[1];
    const v = new DataView(out.buffer, out.byteOffset + p.off + 8, 9);
    expect(v.getUint32(0)).toBe(11811);   // 300 / 0.0254
    expect(v.getUint32(4)).toBe(11811);
    expect(v.getUint8(8)).toBe(1);        // metres
    // CRC over type+data — the value zlib/libpng computes for this chunk.
    const crc = new DataView(out.buffer, out.byteOffset + p.off + 17, 4).getUint32(0);
    expect(crc).toBe(0x78a53f76);
  });

  it('replaces an existing pHYs rather than adding a second', () => {
    const twice = withPngDpi(withPngDpi(PNG_1PX, 96), 300);
    expect(chunks(twice).filter(c => c.type === 'pHYs')).toHaveLength(1);
    expect(twice.length).toBe(PNG_1PX.length + 21);
  });
});
