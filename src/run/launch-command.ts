/**
 * PLAN.MD P2-01/P2-03: transport for the generated wrapper script (see
 * wrapper-script.ts) over a single ssh2 `client.exec(cmdString)` call.
 *
 * The script text can be arbitrarily long and contains shell metacharacters
 * by construction (it IS shell code). Re-quoting an entire multi-KB shell
 * script to survive being embedded as one more shell command string would
 * be fragile and is exactly the kind of "arguments spliced into an
 * unconstrained template" risk the plan calls out. Instead: base64-encode
 * the whole script and ship it through a quoted heredoc whose body is pure
 * base64 (alphabet `A-Za-z0-9+/=`, no shell metacharacters at all), so the
 * OUTER exec command string this function returns never contains any
 * caller-controlled byte -- only a fixed heredoc delimiter and the base64
 * alphabet.
 *
 * The heredoc delimiter is quoted (`<<'...'`) so the shell does not attempt
 * parameter/command substitution inside the body -- irrelevant for base64
 * text, but correct defense in depth. The delimiter contains `_`, which
 * never appears in standard base64 output, so a body line can never
 * collide with it.
 */
const HEREDOC_DELIMITER = "HANDFREE_WRAPPER_SCRIPT_EOF";

export function buildLaunchExecCommand(script: string): string {
  const base64 = Buffer.from(script, "utf8").toString("base64");
  return [
    `base64 -d <<'${HEREDOC_DELIMITER}' | bash -s`,
    base64,
    HEREDOC_DELIMITER,
    "",
  ].join("\n");
}

/** Same transport technique, for the (much shorter) cancel/probe scripts in
 * src/run/run-service.ts. Kept as a separate export so those call sites read
 * as "this goes through the same safe-transport boundary as launch", not a
 * hand-rolled one-off. */
export const buildRemoteScriptExecCommand = buildLaunchExecCommand;
