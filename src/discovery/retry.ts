export interface QueueRetryPlan {
  exhausted: boolean;
  attempts: number;
  nextRunAt?: number;
}

export function planQueueRetry(
  attempts: number,
  maxAttempts: number,
  delayMs: number,
  now = Date.now()
): QueueRetryPlan {
  const nextAttempts = Math.max(0, Math.floor(attempts)) + 1;
  if (nextAttempts >= Math.max(1, Math.floor(maxAttempts))) {
    return { exhausted: true, attempts: nextAttempts };
  }
  return {
    exhausted: false,
    attempts: nextAttempts,
    nextRunAt: now + Math.max(0, Math.floor(delayMs)),
  };
}

