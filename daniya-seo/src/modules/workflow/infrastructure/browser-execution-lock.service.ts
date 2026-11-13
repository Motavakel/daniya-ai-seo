import { Injectable } from '@nestjs/common';

/** Process-local mutual exclusion shared by the Lighthouse and Network processors. */
@Injectable()
export class BrowserExecutionLockService {
  private tail: Promise<void> = Promise.resolve();

  async runExclusive<T>(task: () => Promise<T>): Promise<T> {
    const previous = this.tail;
    let release!: () => void;
    this.tail = new Promise<void>((resolve) => {
      release = resolve;
    });

    await previous;
    try {
      return await task();
    } finally {
      release();
    }
  }
}
