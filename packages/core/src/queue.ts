/**
 * Job queue seam. The CLI uses the in-process implementation; a worker fleet
 * can implement the same interface on top of BullMQ/SQS/Cloud Tasks without
 * touching stage code (stages only see a Workspace + Recipe).
 */
export interface Job<T = unknown> {
  id: string;
  name: string;
  data: T;
  attempts: number;
}

export interface JobQueue<T = unknown> {
  add(name: string, data: T): Promise<string>;
  process(handler: (job: Job<T>) => Promise<void>): Promise<JobReport[]>;
}

export interface JobReport {
  id: string;
  name: string;
  ok: boolean;
  ms: number;
  attempts: number;
  error?: string;
}

export class LocalQueue<T = unknown> implements JobQueue<T> {
  private readonly jobs: Job<T>[] = [];
  private seq = 0;

  constructor(private readonly opts: { concurrency?: number; retries?: number } = {}) {}

  async add(name: string, data: T): Promise<string> {
    const id = `job_${++this.seq}`;
    this.jobs.push({ id, name, data, attempts: 0 });
    return id;
  }

  async process(handler: (job: Job<T>) => Promise<void>): Promise<JobReport[]> {
    const concurrency = Math.max(1, this.opts.concurrency ?? 2);
    const retries = this.opts.retries ?? 1;
    const reports: JobReport[] = [];
    const pending = [...this.jobs];

    const worker = async () => {
      for (let job = pending.shift(); job; job = pending.shift()) {
        const t0 = Date.now();
        let error: string | undefined;
        for (;;) {
          job.attempts++;
          try {
            await handler(job);
            error = undefined;
            break;
          } catch (e) {
            error = e instanceof Error ? e.stack ?? e.message : String(e);
            if (job.attempts > retries) break;
          }
        }
        reports.push({ id: job.id, name: job.name, ok: !error, ms: Date.now() - t0, attempts: job.attempts, error });
      }
    };
    await Promise.all(Array.from({ length: concurrency }, worker));
    return reports;
  }
}
