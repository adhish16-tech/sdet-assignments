/** Time is injected so tests can "fast-forward" to trial end or renewal. */
export interface Clock {
  now(): Date;
}

export class SystemClock implements Clock {
  now(): Date {
    return new Date();
  }
}
