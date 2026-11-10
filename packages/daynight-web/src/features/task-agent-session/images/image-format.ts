import type { DisplayMime } from '../../../../../daynight/src/session/protocol';
import { ImageFailure, type ImageSize } from './image-types';

const ascii = (bytes: Uint8Array, offset: number, length: number) => String.fromCharCode(...bytes.subarray(offset, offset + length));
const unsupported = (): never => { throw new ImageFailure('unsupported_format', 'The saved file is not a supported image.'); };
const crcTable = Uint32Array.from({ length: 256 }, (_, value) => { let crc = value; for (let bit = 0; bit < 8; bit++) crc = crc & 1 ? 0xedb88320 ^ crc >>> 1 : crc >>> 1; return crc >>> 0; });
const crc32 = (bytes: Uint8Array, start: number, end: number) => { let crc = 0xffffffff; for (let at = start; at < end; at++) crc = crcTable[(crc ^ bytes[at]!) & 255]! ^ crc >>> 8; return (crc ^ 0xffffffff) >>> 0; };
const corrupt = (): never => { throw new ImageFailure('integrity_failed', 'The saved image failed integrity verification.'); };
const canvasSize = (width: number, height: number): ImageSize => {
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width < 1 || height < 1 || width > 16_384 || height > 16_384 || width * height > 33_554_432) return corrupt();
  return { width, height };
};

/** Checks the complete outer image container before any browser URL is created. Pixel decoding is separate. */
export function verifyImageContainer(bytes: Uint8Array<ArrayBuffer>, mime: DisplayMime): { frameCount: number | null; canvas: ImageSize | null } {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (mime === 'image/png') {
    if (ascii(bytes, 0, 8) !== '\x89PNG\r\n\x1a\n') unsupported();
    let at = 8, header = false, data = false, frames = 1, canvas: ImageSize | null = null;
    while (at + 12 <= bytes.length) {
      const length = view.getUint32(at), type = ascii(bytes, at + 4, 4);
      if (length > bytes.length - at - 12 || crc32(bytes, at + 4, at + 8 + length) !== view.getUint32(at + 8 + length)) corrupt();
      if (!header && (type !== 'IHDR' || length !== 13)) corrupt();
      if (!header) canvas = canvasSize(view.getUint32(at + 8), view.getUint32(at + 12));
      header = true;
      if (type === 'IDAT') data = true;
      if (type === 'acTL') { if (length !== 8) corrupt(); frames = view.getUint32(at + 8); if (frames < 1 || frames > 256) corrupt(); }
      at += length + 12;
      if (type === 'IEND') { if (length !== 0 || !data || at !== bytes.length) corrupt(); return { frameCount: frames, canvas }; }
    }
    corrupt();
  }
  if (mime === 'image/jpeg') {
    if (bytes[0] !== 255 || bytes[1] !== 216 || bytes[2] !== 255) unsupported();
    let at = 2, frame = false, scan = false, canvas: ImageSize | null = null;
    while (at < bytes.length) {
      if (bytes[at++] !== 255) corrupt();
      while (bytes[at] === 255) at++;
      const marker = bytes[at++];
      if (marker === 0xd9) { if (!frame || !scan || at !== bytes.length) corrupt(); return { frameCount: 1, canvas }; }
      if (marker === undefined || marker === 0 || marker === 0xd8 || marker >= 0xd0 && marker <= 0xd7 || at + 2 > bytes.length) corrupt();
      const length = view.getUint16(at);
      if (length < 2 || length > bytes.length - at) corrupt();
      if ([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf].includes(marker!)) {
        if (length < 8) corrupt(); frame = true;
        canvas = canvasSize(Math.max(canvas?.width ?? 0, view.getUint16(at + 5)), Math.max(canvas?.height ?? 0, view.getUint16(at + 3)));
      }
      at += length;
      if (marker === 0xda) {
        if (!frame || length < 6) corrupt(); scan = true;
        while (at < bytes.length) {
          if (bytes[at] !== 255) { at++; continue; }
          let next = at + 1; while (bytes[next] === 255) next++;
          const code = bytes[next];
          if (code === 0 || code !== undefined && code >= 0xd0 && code <= 0xd7) { at = next + 1; continue; }
          break;
        }
      }
    }
    corrupt();
  }
  if (mime === 'image/gif') {
    if (!['GIF87a', 'GIF89a'].includes(ascii(bytes, 0, 6))) unsupported();
    if (bytes.length < 14) corrupt();
    const canvas = canvasSize(view.getUint16(6, true), view.getUint16(8, true));
    let at = 13 + ((bytes[10]! & 128) ? 3 * 2 ** ((bytes[10]! & 7) + 1) : 0), frames = 0;
    const blocks = () => { for (;;) { if (at >= bytes.length) corrupt(); const size = bytes[at++]!; if (!size) return; at += size; if (at > bytes.length) corrupt(); } };
    while (at < bytes.length) {
      const kind = bytes[at++]!;
      if (kind === 0x3b) { if (!frames || frames > 256 || at !== bytes.length) corrupt(); return { frameCount: frames, canvas }; }
      if (kind === 0x21) { at++; blocks(); continue; }
      if (kind !== 0x2c || at + 9 > bytes.length) corrupt();
      const packed = bytes[at + 8]!; at += 9;
      if (packed & 128) at += 3 * 2 ** ((packed & 7) + 1);
      at++; blocks(); frames++;
    }
    corrupt();
  }
  if (mime === 'image/webp') {
    if (ascii(bytes, 0, 4) !== 'RIFF' || ascii(bytes, 8, 4) !== 'WEBP') unsupported();
    if (bytes.length < 20 || view.getUint32(4, true) + 8 !== bytes.length) corrupt();
    let at = 12, image = false, frames = 0, canvas: ImageSize | null = null;
    const uint24 = (offset: number) => bytes[offset]! | bytes[offset + 1]! << 8 | bytes[offset + 2]! << 16;
    while (at + 8 <= bytes.length) {
      const type = ascii(bytes, at, 4), size = view.getUint32(at + 4, true);
      if (size > bytes.length - at - 8) corrupt();
      let found: ImageSize | null = null;
      if (type === 'VP8X') { if (size !== 10) corrupt(); found = canvasSize(uint24(at + 12) + 1, uint24(at + 15) + 1); }
      if (type === 'VP8 ') {
        if (size < 10 || ascii(bytes, at + 11, 3) !== '\x9d\x01\x2a') corrupt();
        found = canvasSize(view.getUint16(at + 14, true) & 0x3fff, view.getUint16(at + 16, true) & 0x3fff);
      }
      if (type === 'VP8L') {
        if (size < 5 || bytes[at + 8] !== 0x2f) corrupt();
        const dimensions = view.getUint32(at + 9, true);
        found = canvasSize((dimensions & 0x3fff) + 1, (dimensions >>> 14 & 0x3fff) + 1);
      }
      if (found) canvas = canvasSize(Math.max(canvas?.width ?? 0, found.width), Math.max(canvas?.height ?? 0, found.height));
      if (['VP8 ', 'VP8L', 'ANMF'].includes(type)) image = true;
      if (type === 'ANMF') frames++;
      at += 8 + size + size % 2;
      if (at > bytes.length) corrupt();
    }
    if (at !== bytes.length || !image || frames > 256) corrupt();
    return { frameCount: frames || 1, canvas };
  }
  if (mime === 'image/avif') {
    if (bytes.length < 16 || ascii(bytes, 4, 4) !== 'ftyp') unsupported();
    const brandSize = view.getUint32(0);
    if (brandSize < 16 || brandSize > bytes.length || brandSize % 4) corrupt();
    let brand = false, animation = false;
    for (let at = 8; at + 4 <= brandSize; at += 4) if (at !== 12 && ['avif', 'avis'].includes(ascii(bytes, at, 4))) { brand = true; if (ascii(bytes, at, 4) === 'avis') animation = true; }
    if (!brand) unsupported();
    let at = 0, data = false, metadata = false, canvas: ImageSize | null = null;
    const properties = (start: number, end: number, parent: 'meta' | 'iprp' | 'ipco') => {
      let child = start;
      while (child + 8 <= end) {
        const size = view.getUint32(child), type = ascii(bytes, child + 4, 4);
        if (size < 8 || size > end - child) corrupt();
        if (parent === 'meta' && type === 'idat') data = true;
        if (parent === 'meta' && type === 'iprp') properties(child + 8, child + size, 'iprp');
        if (parent === 'iprp' && type === 'ipco') properties(child + 8, child + size, 'ipco');
        if (parent === 'ipco' && type === 'ispe') {
          if (size !== 20) corrupt();
          canvas = canvasSize(Math.max(canvas?.width ?? 0, view.getUint32(child + 12)), Math.max(canvas?.height ?? 0, view.getUint32(child + 16)));
        }
        child += size;
      }
      if (child !== end) corrupt();
    };
    while (at + 8 <= bytes.length) {
      let size = view.getUint32(at); const type = ascii(bytes, at + 4, 4);
      if (size === 1) { if (at + 16 > bytes.length) corrupt(); const big = view.getBigUint64(at + 8); if (big > BigInt(bytes.length)) corrupt(); size = Number(big); if (size < 16) corrupt(); }
      if (size === 0) size = bytes.length - at;
      if (size < 8 || size > bytes.length - at) corrupt();
      if (type === 'mdat') data = true;
      if (type === 'meta' || type === 'moov') metadata = true;
      if (type === 'meta') {
        properties(at + 12, at + size, 'meta');
      }
      at += size;
    }
    if (at !== bytes.length || !data || !metadata) corrupt();
    return { frameCount: animation ? null : 1, canvas };
  }
  return unsupported();
}
