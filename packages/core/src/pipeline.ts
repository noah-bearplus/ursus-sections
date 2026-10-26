import type { Recipe } from './types.ts';
import { Workspace, sha1 } from './workspace.ts';
import { createLogger, type Logger } from './log.ts';

export interface StageContext {
  ws: Workspace;
  recipe: Recipe;
  log: Logger;
  options: PipelineOptions;
}

export interface PipelineOptions {
  /** Shopify theme directory to analyse for conventions. */
  themeDir?: string;
  /** Re-run stages even when their cache key matches. */
  force?: boolean;
  [key: string]: unknown;
}

export interface StageDef {
  name: string;
  dependsOn: string[];
  /** Workspace-relative files that must exist for the cached result to be reused. */
  outputs: string[];
  /** Extra material folded into the cache key (e.g. hashes of external inputs). */
  cacheKey?: (ctx: StageContext) => Promise<string> | string;
  run: (ctx: StageContext) => Promise<void>;
}

interface StageCacheEntry {
  key: string;
  finishedAt: string;
  ms: number;
}

/**
 * Small DAG runner with content-addressed caching.
 * A stage's key = hash(stage name, recipe, its own cacheKey, keys of upstream stages),
 * so editing a recipe or an input invalidates exactly the affected stages.
 */
export class Pipeline {
  private readonly stages = new Map<string, StageDef>();

  constructor(stages: StageDef[]) {
    for (const s of stages) this.stages.set(s.name, s);
    for (const s of stages) {
      for (const d of s.dependsOn) {
        if (!this.stages.has(d)) throw new Error(`Stage "${s.name}" depends on unknown stage "${d}"`);
      }
    }
  }

  names(): string[] {
    return this.order([...this.stages.keys()]);
  }

  /** Topological order of the requested stages plus their dependencies. */
  order(targets: string[]): string[] {
    const out: string[] = [];
    const seen = new Set<string>();
    const visit = (name: string, trail: string[]) => {
      if (seen.has(name)) return;
      if (trail.includes(name)) throw new Error(`Cycle: ${[...trail, name].join(' -> ')}`);
      const s = this.stages.get(name);
      if (!s) throw new Error(`Unknown stage "${name}"`);
      for (const d of s.dependsOn) visit(d, [...trail, name]);
      seen.add(name);
      out.push(name);
    };
    for (const t of targets) visit(t, []);
    return out;
  }

  async run(
    ctx: Omit<StageContext, 'log'> & { log?: Logger },
    targets: string[] = [...this.stages.keys()],
  ): Promise<Record<string, 'ran' | 'cached'>> {
    const log = ctx.log ?? createLogger('pipeline');
    const keys = new Map<string, string>();
    const result: Record<string, 'ran' | 'cached'> = {};

    for (const name of this.order(targets)) {
      const stage = this.stages.get(name)!;
      const stageCtx: StageContext = { ...ctx, log: log.child(name) };
      const extra = stage.cacheKey ? await stage.cacheKey(stageCtx) : '';
      const key = sha1(
        JSON.stringify({
          name,
          recipe: ctx.recipe,
          options: { ...ctx.options, force: undefined },
          extra,
          upstream: stage.dependsOn.map((d) => keys.get(d)),
        }),
      );
      keys.set(name, key);

      const cacheFile = `.cache/${name}.json`;
      let cached: StageCacheEntry | null = null;
      if (!ctx.options.force && (await ctx.ws.exists(cacheFile))) {
        cached = await ctx.ws.readJson<StageCacheEntry>(cacheFile);
      }
      const outputsExist = (await Promise.all(stage.outputs.map((o) => ctx.ws.exists(o)))).every(Boolean);
      if (cached && cached.key === key && outputsExist) {
        stageCtx.log.info(`cached (${cached.ms}ms on ${cached.finishedAt})`);
        result[name] = 'cached';
        continue;
      }

      const t0 = Date.now();
      stageCtx.log.info('start');
      await stage.run(stageCtx);
      const ms = Date.now() - t0;
      await ctx.ws.writeJson(cacheFile, { key, finishedAt: new Date().toISOString(), ms } satisfies StageCacheEntry);
      stageCtx.log.info(`done in ${ms}ms`);
      result[name] = 'ran';
    }
    return result;
  }
}
