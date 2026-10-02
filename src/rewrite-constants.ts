/** Shared truncation guards (rewriter + restageFile). */
export const TRUNCATION_LINE_RATIO = 0.75;
export const TRUNCATION_MIN_LINES = 12;
/**
 * A clean `finish_reason` (the model stopped of its own accord) plus balanced
 * brackets is strong evidence the rewrite is *complete*, not cut off. In that
 * case a large shrink is legitimate compression: the humanizer removes
 * narration comments and terse docblocks, so a slop-heavy file can plausibly
 * halve in size. We only reject a "clean" rewrite when the collapse is severe
 * (below this ratio), which is the rare case of a cutoff landing exactly on a
 * statement boundary. Kept below `TRUNCATION_LINE_RATIO` on purpose.
 */
export const COMPRESSION_LINE_RATIO = 0.4;
/** Chunk mode allows slightly more shrink (reformatting across chunks). */
export const CHUNK_ASSEMBLY_LINE_RATIO = 0.9;
