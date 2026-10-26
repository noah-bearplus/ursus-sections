import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LocalQueue, Pipeline, Workspace, type Recipe } from '../src/index.ts';

const recipe: Recipe = { id: 't', name: 'T', prefix: 't', source: {} };
process.env.SF_QUIET = '1';

test('pipeline runs dependencies in order and caches by key', async () => {
  const ws = new Workspace(await mkdtemp(join(tmpdir(), 'sf-')));
  const calls: string[] = [];
  const p = new Pipeline([
    { name: 'b', dependsOn: ['a'], outputs: ['b.txt'], run: async () => void (calls.push('b'), await ws.write('b.txt', 'b')) },
    { name: 'a', dependsOn: [], outputs: ['a.txt'], run: async () => void (calls.push('a'), await ws.write('a.txt', 'a')) },
  ]);
  assert.deepEqual(await p.run({ ws, recipe, options: {} }, ['b']), { a: 'ran', b: 'ran' });
  assert.deepEqual(await p.run({ ws, recipe, options: {} }, ['b']), { a: 'cached', b: 'cached' });
  assert.deepEqual(await p.run({ ws, recipe: { ...recipe, name: 'changed' }, options: {} }, ['b']), { a: 'ran', b: 'ran' });
  assert.deepEqual(calls, ['a', 'b', 'a', 'b']);
  // Options only invalidate the stages that declare them.
  const q = new Pipeline([
    { name: 'a', dependsOn: [], outputs: ['a.txt'], run: async () => void calls.push('a') },
    { name: 'c', dependsOn: ['a'], outputs: [], options: ['themeDir'], run: async () => void calls.push('c') },
  ]);
  calls.length = 0;
  await q.run({ ws, recipe, options: { themeDir: 'x' } });
  assert.deepEqual(await q.run({ ws, recipe, options: { themeDir: 'y' } }), { a: 'cached', c: 'ran' });
});

test('local queue retries and reports', async () => {
  const q = new LocalQueue<number>({ concurrency: 2, retries: 1 });
  for (const n of [1, 2, 3]) await q.add('n', n);
  let flaky = 0;
  const reports = await q.process(async (job) => {
    if (job.data === 2 && flaky++ === 0) throw new Error('flaky');
    if (job.data === 3) throw new Error('always');
  });
  const byData = Object.fromEntries(reports.map((r) => [r.id, r]));
  assert.equal(byData.job_1.ok, true);
  assert.equal(byData.job_2.ok, true);
  assert.equal(byData.job_2.attempts, 2);
  assert.equal(byData.job_3.ok, false);
});
