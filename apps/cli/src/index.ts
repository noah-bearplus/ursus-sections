#!/usr/bin/env -S node --import tsx
import { readdir, readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { Command } from 'commander';
import { createLogger, LocalQueue, Workspace, type Recipe } from '@sf/core';
import { closeBrowser } from '@sf/crawler';
import { buildCatalog } from '@sf/catalog';
import { analyzeTheme } from '@sf/shopify';
import { buildPipeline } from './stages.ts';

const program = new Command();
program.name('sf').description('sectionforge — design → HTML sections → Shopify Liquid').version('0.1.0');

const WORKDIR = resolve(process.env.SF_HOME ?? '.sf');

async function loadRecipe(file: string): Promise<Recipe> {
  const abs = resolve(file);
  const recipe = JSON.parse(await readFile(abs, 'utf8')) as Recipe;
  const base = dirname(abs);
  // Paths inside a recipe are relative to the recipe file.
  if (recipe.source.savedHtml) recipe.source.savedHtml = resolve(base, recipe.source.savedHtml);
  if (recipe.source.savedAssetsDir) recipe.source.savedAssetsDir = resolve(base, recipe.source.savedAssetsDir);
  return recipe;
}

function stageList(v: string): string[] {
  return v.split(',').map((s) => s.trim()).filter(Boolean);
}

program
  .command('run')
  .description('Run the pipeline for one recipe (all stages, or --stages a,b)')
  .argument('<recipe>', 'recipe JSON file')
  .option('--stages <list>', 'comma separated target stages', stageList)
  .option('--theme <dir>', 'Shopify theme directory to match conventions against')
  .option('--force', 're-run stages even if cached', false)
  .action(async (file: string, opts: { stages?: string[]; theme?: string; force?: boolean }) => {
    const recipe = await loadRecipe(file);
    const ws = Workspace.forProject(WORKDIR, recipe.id);
    const pipeline = buildPipeline();
    const log = createLogger(recipe.id);
    try {
      const res = await pipeline.run(
        { ws, recipe, log, options: { themeDir: opts.theme ? resolve(opts.theme) : undefined, force: opts.force } },
        opts.stages,
      );
      log.info(`finished: ${JSON.stringify(res)}`);
      log.info(`workspace: ${ws.root}`);
    } finally {
      await closeBrowser();
    }
  });

program
  .command('batch')
  .description('Run many recipes through a job queue')
  .argument('<recipes...>', 'recipe JSON files')
  .option('--concurrency <n>', 'parallel jobs', '2')
  .option('--theme <dir>', 'Shopify theme directory')
  .action(async (files: string[], opts: { concurrency: string; theme?: string }) => {
    const queue = new LocalQueue<{ file: string }>({ concurrency: Number(opts.concurrency), retries: 1 });
    for (const f of files) await queue.add('recipe', { file: f });
    const pipeline = buildPipeline();
    try {
      const reports = await queue.process(async (job) => {
        const recipe = await loadRecipe(job.data.file);
        const ws = Workspace.forProject(WORKDIR, recipe.id);
        await pipeline.run({ ws, recipe, options: { themeDir: opts.theme ? resolve(opts.theme) : undefined } });
      });
      console.table(reports.map((r) => ({ id: r.id, ok: r.ok, ms: r.ms, attempts: r.attempts, error: r.error?.split('\n')[0] })));
    } finally {
      await closeBrowser();
    }
  });

program
  .command('catalog')
  .description('Build the static section library from every converted project')
  .option('--profile <slug>', 'Shopify profile folder to read Liquid from (e.g. dawn, generic-os-2-0)')
  .option('--out <dir>', 'output directory', join(WORKDIR, 'catalog'))
  .action(async (opts: { profile?: string; out: string }) => {
    const ids = (await readdir(join(WORKDIR, 'projects')).catch(() => [] as string[])).sort();
    const projects = [];
    for (const id of ids) {
      const ws = Workspace.forProject(WORKDIR, id);
      if (!(await ws.exists('sections', 'index.json'))) continue;
      const slugs = await ws.list('shopify');
      const profileSlug = opts.profile && slugs.includes(opts.profile) ? opts.profile : slugs[0];
      if (!profileSlug) continue;
      projects.push({ id, ws, profileSlug });
    }
    const entries = await buildCatalog(new Workspace(opts.out), { projects });
    console.log(`catalog: ${entries.length} sections from ${projects.length} project(s) → ${resolve(opts.out)}/index.html`);
  });

program
  .command('analyze-theme')
  .description('Print the conventions sectionforge detects in a Shopify theme')
  .argument('<dir>', 'theme directory')
  .action(async (dir: string) => {
    const profile = await analyzeTheme(resolve(dir));
    console.log(JSON.stringify({ ...profile, css: { ...profile.css, globals: `${Object.keys(profile.css.globals).length} variables` } }, null, 2));
  });

program
  .command('stages')
  .description('List pipeline stages in execution order')
  .action(() => {
    const p = buildPipeline();
    for (const n of p.names()) console.log(n);
  });

program.parseAsync().catch((e) => {
  console.error(e);
  process.exit(1);
});
