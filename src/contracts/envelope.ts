import { z } from "zod";
import { errorObjectSchema } from "./error.js";
import { jobStateSchema } from "./job.js";

// PLAN.MD §5.2: unified response envelope. Applies ONLY to new/background
// tools and to the extended `transfer` tool when called with
// `background:true`. Existing 1.x upload/download/transfer/execute-command/
// etc. calls (without background:true) keep returning their old text
// result verbatim — see src/contracts/legacy-tools.ts for that frozen
// characterization contract. §5.2 is explicit that the old tools must never
// be silently switched to this envelope.

export const successEnvelopeSchema = z.object({
  ok: z.literal(true),
  jobId: z.string().min(1),
  state: jobStateSchema,
  message: z.string(),
  // Example in §5.2 always includes `next`, but a terminal state (e.g.
  // `completed`) has nothing further to poll — treating it as optional is a
  // deliberate reading, not a literal transcription of the example.
  next: z.string().optional(),
  details: z.record(z.string(), z.unknown()).optional().default({}),
});

export const errorEnvelopeSchema = z.object({
  ok: z.literal(false),
  error: errorObjectSchema,
});

export const envelopeSchema = z.discriminatedUnion("ok", [successEnvelopeSchema, errorEnvelopeSchema]);

export type Envelope = z.infer<typeof envelopeSchema>;
export type SuccessEnvelope = z.infer<typeof successEnvelopeSchema>;
export type ErrorEnvelope = z.infer<typeof errorEnvelopeSchema>;
