import { readFile, writeFile } from 'node:fs/promises';
import pixelmatch from 'pixelmatch';
import { PNG } from 'pngjs';

export interface DiffResult {
  width: number;
  height: number;
  differentPixels: number;
  /** 0–1, share of pixels that differ beyond the threshold */
  ratio: number;
}

/** Pixel diff of two screenshots (compared over their common area). */
export async function diffPng(a: string, b: string, out?: string, threshold = 0.12): Promise<DiffResult> {
  const pa = PNG.sync.read(await readFile(a));
  const pb = PNG.sync.read(await readFile(b));
  const width = Math.min(pa.width, pb.width);
  const height = Math.min(pa.height, pb.height);
  const crop = (p: PNG) => {
    const o = new PNG({ width, height });
    PNG.bitblt(p, o, 0, 0, width, height, 0, 0);
    return o;
  };
  const ca = crop(pa);
  const cb = crop(pb);
  const diff = new PNG({ width, height });
  const n = pixelmatch(ca.data, cb.data, diff.data, width, height, { threshold, includeAA: false, alpha: 0.2 });
  if (out) await writeFile(out, PNG.sync.write(diff));
  return { width, height, differentPixels: n, ratio: n / (width * height) };
}
