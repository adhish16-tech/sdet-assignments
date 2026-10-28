import { Clock } from '../../src/service/Clock';

const DAY_MS = 24 * 60 * 60 * 1000;

/** Test double for time. Lets a test jump to "trial ended" without waiting 14 days. */
export class FakeClock implements Clock {
  private current: Date;

  constructor(start = new Date('2026-01-01T00:00:00.000Z')) {
    this.current = new Date(start);
  }

  now(): Date {
    return new Date(this.current);
  }

  advanceDays(days: number): void {
    this.current = new Date(this.current.getTime() + days * DAY_MS);
  }

  advanceMinutes(minutes: number): void {
    this.current = new Date(this.current.getTime() + minutes * 60 * 1000);
  }
}
