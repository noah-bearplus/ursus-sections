import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { serveDir } from '../src/server.ts';

test('static server serves files, directory index and byte ranges', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'sf-serve-'));
  await writeFile(join(dir, 'index.html'), '<h1>hub</h1>');
  await writeFile(join(dir, 'clip.mp4'), '0123456789');
  await writeFile(join(dir, 'x.liquid'), '{{ section.id }}');
  const server = await serveDir(dir);
  try {
    const index = await fetch(server.url);
    assert.equal(await index.text(), '<h1>hub</h1>');

    const liquid = await fetch(`${server.url}x.liquid`);
    assert.match(liquid.headers.get('content-type') ?? '', /^text\/plain/);

    const part = await fetch(`${server.url}clip.mp4`, { headers: { range: 'bytes=2-5' } });
    assert.equal(part.status, 206);
    assert.equal(part.headers.get('content-range'), 'bytes 2-5/10');
    assert.equal(await part.text(), '2345');

    const tail = await fetch(`${server.url}clip.mp4`, { headers: { range: 'bytes=-3' } });
    assert.equal(await tail.text(), '789');

    const beyond = await fetch(`${server.url}clip.mp4`, { headers: { range: 'bytes=20-' } });
    assert.equal(beyond.status, 416);

    assert.equal((await fetch(`${server.url}missing.html`)).status, 404);
  } finally {
    await server.close();
  }
});
