/**
 * PLAN.MD P2-04: "logs 使用 byte offset，处理 UTF-8 半字符，不重复、不跳字节."
 *
 * Pure byte-buffer arithmetic, no I/O. The remote log reader
 * (src/run/remote-log-reader.ts) fetches `[bufferStart, bufferStart +
 * data.length)` of a remote file -- `data` includes up to 3 extra
 * "overread" bytes past the caller's requested cap so a UTF-8 code point
 * that straddles the cap boundary can be completed instead of being cut in
 * half. This module decides exactly where to cut, so a second call starting
 * at the returned `nextOffset` continues byte-for-byte with no duplication
 * and no drop, for every sequential read. (A caller that jumps to an
 * arbitrary offset that happens to land mid-character is a different,
 * unavoidable case: the leading partial bytes at the very start of that
 * read are dropped because there is no valid character to render for them --
 * matching the same, already-accepted precedent in
 * SSHConnectionManager.readBackgroundOutput for local background-command
 * output.)
 */

function isContinuationByte(byte: number): boolean {
  return (byte & 0xc0) === 0x80;
}

function utf8LeadByteLength(lead: number): number {
  if (lead >= 0xc2 && lead <= 0xdf) return 2;
  if (lead >= 0xe0 && lead <= 0xef) return 3;
  if (lead >= 0xf0 && lead <= 0xf4) return 4;
  return 1;
}

/** Pure. Grows `end` forward over continuation bytes (a character that
 * started before `end` but extends past it), then -- only if that growth
 * ran all the way to the end of the buffer with no room left to verify
 * completion -- rolls back to the start of that character if it turns out
 * to still be incomplete even including every buffered overread byte. */
function extendToCharacterBoundary(data: Buffer, start: number, cappedEnd: number): number {
  let end = cappedEnd;
  while (end < data.length && isContinuationByte(data[end])) {
    end += 1;
  }
  if (end < data.length || end <= start) {
    return end;
  }
  let leadIndex = end - 1;
  while (leadIndex >= start && isContinuationByte(data[leadIndex])) {
    leadIndex -= 1;
  }
  if (leadIndex < start) {
    return end;
  }
  const expectedLength = utf8LeadByteLength(data[leadIndex]);
  return end - leadIndex < expectedLength ? leadIndex : end;
}

/** Pure. Drops any leading continuation bytes (a character whose lead byte
 * lies before `bufferStart`, i.e. before what this read window covers). */
function trimLeadingPartialCharacter(data: Buffer, cappedStart: number): number {
  let start = cappedStart;
  while (start < data.length && isContinuationByte(data[start])) {
    start += 1;
  }
  return start;
}

export interface Utf8WindowSlice {
  text: string;
  /** Absolute byte offset (bufferStart + sliceStart) the returned text
   * actually begins at -- equals bufferStart unless a leading partial
   * character had to be dropped. */
  startOffset: number;
  /** Absolute byte offset the *next* read should start at to continue with
   * no gap and no overlap. */
  nextOffset: number;
}

/**
 * `data`      bytes fetched starting at `bufferStart`, possibly including up
 *             to 3 extra overread bytes past `bufferStart + cap`.
 * `bufferStart` absolute byte offset in the remote file that `data[0]` is.
 * `cap`       the caller's requested window size, NOT counting overread.
 */
export function sliceUtf8Window(data: Buffer, bufferStart: number, cap: number): Utf8WindowSlice {
  const cappedEnd = Math.min(data.length, cap);
  const sliceStart = trimLeadingPartialCharacter(data, 0);
  const sliceEnd = extendToCharacterBoundary(data, sliceStart, Math.max(cappedEnd, sliceStart));
  return {
    text: data.subarray(sliceStart, sliceEnd).toString("utf8"),
    startOffset: bufferStart + sliceStart,
    nextOffset: bufferStart + sliceEnd,
  };
}
