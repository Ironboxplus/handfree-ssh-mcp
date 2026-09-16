/**
 * Error codes specific to the remote-runner core (P2-01/02/03/04/05/06),
 * following the same "explicit, never-silent *_NOT_AVAILABLE" precedent
 * PLAN.MD already established for SYNC_NOT_AVAILABLE (see
 * src/contracts/error.ts's KNOWN_ERROR_CODES doc comment: "not exhaustive of
 * every future code... every code currently named in PLAN.MD's Phase 0-2
 * scope is enumerated"). These are new-in-this-dispatch codes for
 * capabilities explicitly out of scope this round; not added to that
 * enumerated list since that file is frozen for this delivery (imported,
 * not extended) -- errorObjectSchema's code field is a validated
 * SCREAMING_SNAKE_CASE string, not a closed enum, so this is a legal use of
 * the same contract without editing src/contracts/.
 */
export class RunServiceError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly retryable: boolean = false,
  ) {
    super(message);
    this.name = "RunServiceError";
  }
}
