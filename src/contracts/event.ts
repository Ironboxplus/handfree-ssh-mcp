import { z } from "zod";

// PLAN.MD §4.3 `job_events` table + §5.3 SSE catch-up. `eventId` is a
// global monotonic cursor across all jobs; `jobSeq` is per-job, starting at
// 1, unique per (jobId, jobSeq) — see §4.3.

export const JOB_EVENT_TYPES = [
  "state_transition",
  "phase_transition",
  "progress",
  "log",
  "recovery",
  "error",
  "cancel_requested",
  "custom",
] as const;

export type JobEventType = (typeof JOB_EVENT_TYPES)[number];
export const jobEventTypeSchema = z.enum(JOB_EVENT_TYPES);

export const jobEventSchema = z.object({
  eventId: z.number().int().positive(),
  jobId: z.string().min(1),
  jobSeq: z.number().int().positive(),
  eventType: jobEventTypeSchema,
  timestamp: z.string(),
  payload: z.record(z.string(), z.unknown()).optional().default({}),
});

export type JobEvent = z.infer<typeof jobEventSchema>;

/** Pure. §4.3: unique constraint is (jobId, jobSeq); this checks a batch of
 * events for real duplicates/gaps within one job's sequence, the invariant
 * P0-05-A1 exercises against a real SQLite-backed EventBus. */
export function findJobSeqAnomalies(events: Pick<JobEvent, "jobId" | "jobSeq">[]): {
  duplicates: number[];
  gaps: number[];
} {
  const byJob = new Map<string, number[]>();
  for (const event of events) {
    const seqs = byJob.get(event.jobId) ?? [];
    seqs.push(event.jobSeq);
    byJob.set(event.jobId, seqs);
  }
  const duplicates: number[] = [];
  const gaps: number[] = [];
  for (const seqs of byJob.values()) {
    const sorted = [...seqs].sort((a, b) => a - b);
    const seen = new Set<number>();
    for (const seq of sorted) {
      if (seen.has(seq)) duplicates.push(seq);
      seen.add(seq);
    }
    for (let i = 1; i < sorted.length; i++) {
      if (sorted[i] === sorted[i - 1]) continue;
      if (sorted[i] !== sorted[i - 1] + 1) gaps.push(sorted[i - 1] + 1);
    }
  }
  return { duplicates, gaps };
}

// §5.3 SSE catch-up / HTTP list pagination.
export const cursorPaginationQuerySchema = z.object({
  cursor: z.string().optional(),
  limit: z.number().int().positive().max(500).optional().default(50),
});

export const sseSubscribeQuerySchema = z.object({
  afterEventId: z.number().int().nonnegative().optional(),
  types: z.array(jobEventTypeSchema).optional(),
});
