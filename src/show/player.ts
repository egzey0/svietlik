import type { Driver } from './drivers.ts';
import { dark, type Levels } from './patterns.ts';
import type { Show } from './shows.ts';

export interface PlayerOptions {
  /** makes the driver for a show. Leave out to only get onFrame callbacks (preview). */
  driver?: (show: Show) => Driver;
  onFrame?: (levels: Levels) => void;
}

interface Run {
  stopped: boolean;
  wake?: () => void;
}

/**
 * Plays one show at a time. Starting a new show while another runs stops the
 * old one first and waits until its lamps are handed back to the car.
 */
export class Player {
  speed = 1;
  private run: Run | null = null;
  private done: Promise<void> = Promise.resolve();
  private readonly opts: PlayerOptions;

  constructor(opts: PlayerOptions = {}) {
    this.opts = opts;
  }

  get playing(): boolean {
    return this.run !== null && !this.run.stopped;
  }

  /** Resolves when the show ends or is stopped. Rejects if the lamps could not be restored. */
  play(show: Show): Promise<void> {
    const steps = show.steps();
    if (!steps.length || steps.some((s) => !(s.holdMs >= 0)) || (show.loop && steps.every((s) => s.holdMs === 0))) {
      return Promise.reject(new Error(`${show.id}: nothing to play`));
    }

    this.halt();
    const run: Run = { stopped: false };
    this.run = run;
    const previous = this.done.catch(() => {});

    this.done = (async () => {
      await previous;
      if (run.stopped) return;
      const levels: Levels = dark();
      let driver: Driver | undefined;
      try {
        driver = this.opts.driver?.(show);
        this.opts.onFrame?.({ ...levels });
        await driver?.begin();
        do {
          for (const step of steps) {
            if (run.stopped) break;
            const hold = step.holdMs / Math.max(0.25, Math.min(4, this.speed));
            Object.assign(levels, step.levels);
            await driver?.frame(levels, hold);
            this.opts.onFrame?.({ ...levels });
            await this.sleep(run, hold);
          }
        } while (show.loop && !run.stopped);
      } finally {
        if (this.run === run) this.run = null;
        this.opts.onFrame?.(dark());
        await driver?.release();
      }
    })();
    return this.done;
  }

  async stop(): Promise<void> {
    this.halt();
    await this.done;
  }

  private halt(): void {
    if (!this.run) return;
    this.run.stopped = true;
    this.run.wake?.();
  }

  private sleep(run: Run, ms: number): Promise<void> {
    if (run.stopped) return Promise.resolve();
    return new Promise((resolve) => {
      const timer = setTimeout(resolve, ms);
      run.wake = () => {
        clearTimeout(timer);
        resolve();
      };
    });
  }
}
