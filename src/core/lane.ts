/**
 * Delays callbacks by half the simulated latency ± jitter (`simulate`), never reordering them: a
 * socket keeps order, and the server drops a signed frame that arrives after a later one. One
 * queue drained by one timer, since separate timers whose whole-millisecond delays round
 * differently can fire out of order.
 */
export function lane({ latency = 0, jitter = 0 }: { latency?: number; jitter?: number }): (fn: () => void) => void {
  const queue: { at: number; fn: () => void }[] = [];
  let last = 0;
  let timer: ReturnType<typeof setTimeout> | null = null;
  const drain = () => {
    timer = null;
    const now = performance.now();
    while (queue.length > 0 && queue[0]!.at <= now) queue.shift()!.fn();
    if (queue.length > 0) timer = setTimeout(drain, Math.max(0, queue[0]!.at - now));
  };
  return (fn) => {
    const now = performance.now();
    last = Math.max(last, now + latency / 2 + (Math.random() * 2 - 1) * jitter);
    queue.push({ at: last, fn });
    if (timer === null) timer = setTimeout(drain, Math.max(0, last - now));
  };
}
