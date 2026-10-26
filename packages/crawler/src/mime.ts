/** Detects a file type from magic bytes (saved pages often drop extensions, e.g. favicons). */
export function sniffMime(buf: Buffer): string | null {
  const b = buf;
  const ascii = (start: number, len: number) => b.subarray(start, start + len).toString('latin1');
  if (b.length >= 8 && b[0] === 0x89 && ascii(1, 3) === 'PNG') return 'image/png';
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg';
  if (b.length >= 12 && ascii(0, 4) === 'RIFF' && ascii(8, 4) === 'WEBP') return 'image/webp';
  if (ascii(0, 4) === 'GIF8') return 'image/gif';
  if (b.length >= 4 && b[0] === 0 && b[1] === 0 && b[2] === 1 && b[3] === 0) return 'image/x-icon';
  if (b.length >= 12 && ascii(4, 4) === 'ftyp') {
    const brand = ascii(8, 4);
    if (brand.startsWith('avif') || brand.startsWith('avis')) return 'image/avif';
    return 'video/mp4';
  }
  if (ascii(0, 4) === 'wOF2') return 'font/woff2';
  if (ascii(0, 4) === 'wOFF') return 'font/woff';
  if (b.length >= 4 && b[0] === 0x1a && b[1] === 0x45 && b[2] === 0xdf && b[3] === 0xa3) return 'video/webm';
  const head = ascii(0, 512).trimStart().toLowerCase();
  if (head.startsWith('<svg') || (head.startsWith('<?xml') && head.includes('<svg'))) return 'image/svg+xml';
  if (head.startsWith('<!doctype html') || head.startsWith('<html')) return 'text/html';
  return null;
}

const EXT: Record<string, string> = {
  'image/png': '.png',
  'image/jpeg': '.jpg',
  'image/webp': '.webp',
  'image/gif': '.gif',
  'image/avif': '.avif',
  'image/x-icon': '.ico',
  'image/svg+xml': '.svg',
  'font/woff2': '.woff2',
  'font/woff': '.woff',
  'video/mp4': '.mp4',
  'video/webm': '.webm',
};

export function extForMime(mime: string): string | null {
  return EXT[mime] ?? null;
}
