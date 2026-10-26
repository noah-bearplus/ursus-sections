import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile, cp, rm, stat, readdir } from 'node:fs/promises';
import { dirname, join, relative, resolve } from 'node:path';

/**
 * Artifact store for one project (= one source page).
 *
 * Layout:
 *   <root>/snapshot/   ingest output (page.html, styles/, assets/, snapshot.json, screenshots/)
 *   <root>/design/     tokens.json, tokens.css, styleguide.html
 *   <root>/sections/   <key>/ir.json, preview.html, preview.png
 *   <root>/clone/      full-page HTML clone
 *   <root>/shopify/    <profile>/sections/*.liquid …
 *   <root>/.cache/     stage cache manifests
 *
 * Only this class touches the filesystem layout, so swapping it for an
 * object-store implementation (S3/R2) later is a single seam.
 */
export class Workspace {
  readonly root: string;

  constructor(root: string) {
    this.root = resolve(root);
  }

  static forProject(baseDir: string, projectId: string): Workspace {
    return new Workspace(join(baseDir, 'projects', projectId));
  }

  path(...parts: string[]): string {
    return join(this.root, ...parts);
  }

  rel(abs: string): string {
    return relative(this.root, abs);
  }

  async ensureDir(...parts: string[]): Promise<string> {
    const p = this.path(...parts);
    await mkdir(p, { recursive: true });
    return p;
  }

  async exists(...parts: string[]): Promise<boolean> {
    try {
      await stat(this.path(...parts));
      return true;
    } catch {
      return false;
    }
  }

  async readText(...parts: string[]): Promise<string> {
    return readFile(this.path(...parts), 'utf8');
  }

  async readJson<T>(...parts: string[]): Promise<T> {
    return JSON.parse(await this.readText(...parts)) as T;
  }

  async write(relPath: string, content: string | Buffer): Promise<string> {
    const p = this.path(relPath);
    await mkdir(dirname(p), { recursive: true });
    await writeFile(p, content);
    return p;
  }

  async writeJson(relPath: string, data: unknown): Promise<string> {
    return this.write(relPath, JSON.stringify(data, null, 2) + '\n');
  }

  async copyIn(src: string, relPath: string): Promise<string> {
    const p = this.path(relPath);
    await mkdir(dirname(p), { recursive: true });
    await cp(src, p, { recursive: true });
    return p;
  }

  async clean(...parts: string[]): Promise<void> {
    await rm(this.path(...parts), { recursive: true, force: true });
  }

  async list(...parts: string[]): Promise<string[]> {
    try {
      return await readdir(this.path(...parts));
    } catch {
      return [];
    }
  }
}

export function sha1(data: string | Buffer): string {
  return createHash('sha1').update(data).digest('hex');
}

export function shortHash(data: string | Buffer, len = 8): string {
  return sha1(data).slice(0, len);
}

export async function hashFile(path: string): Promise<string> {
  return sha1(await readFile(path));
}
