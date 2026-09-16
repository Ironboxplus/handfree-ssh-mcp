/**
 * PLAN.MD P2-01/P2-03: "working directory、executable、entrypoint、args 和 env
 * 分开建模并逐项 quote；禁止把用户参数拼进未经约束的 shell 模板". This is the single
 * quoting primitive every remote-runner command builder in src/run/ goes
 * through -- no other file in this package should hand-roll shell escaping.
 *
 * Pure function, no I/O. Every dynamic value (workdir, executable,
 * entrypoint, each arg, each env value, run ids, tokens) is quoted
 * individually with this before it is concatenated into a shell script
 * string. This is the classic POSIX single-quote technique: wrap in single
 * quotes, and turn each embedded single quote into `'\''` (close quote,
 * escaped literal quote, reopen quote). It is correct for every byte a
 * JS string can hold, including newlines, backticks, `$(...)`, globs, and
 * embedded NUL-free unicode -- single-quoted shell strings do not perform
 * any expansion at all, so nothing inside them is ever re-interpreted.
 */
export function posixShellQuote(value: string): string {
  if (value === "") return "''";
  return `'${value.split("'").join(`'\\''`)}'`;
}

/** Quote a whole argv array, space-joined, ready to splice into a bash
 * script as literal text (e.g. inside an `ARGS=(...)` array literal, or
 * after a command name). Pure. */
export function posixShellQuoteAll(values: readonly string[]): string {
  return values.map(posixShellQuote).join(" ");
}
