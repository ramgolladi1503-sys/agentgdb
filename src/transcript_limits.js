import fs from 'node:fs';

export const DEFAULT_MAX_TRANSCRIPT_BYTES = 64 * 1024 * 1024;
const MIN_CONFIGURED_BYTES = 1024 * 1024;
const MAX_CONFIGURED_BYTES = 1024 * 1024 * 1024;

function configuredLimit(raw = process.env.AGENTGDB_MAX_TRANSCRIPT_BYTES) {
  if (raw === undefined || raw === '') return DEFAULT_MAX_TRANSCRIPT_BYTES;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < MIN_CONFIGURED_BYTES || value > MAX_CONFIGURED_BYTES) {
    throw new Error(`AGENTGDB_MAX_TRANSCRIPT_BYTES must be an integer from ${MIN_CONFIGURED_BYTES} to ${MAX_CONFIGURED_BYTES}`);
  }
  return value;
}

export const MAX_TRANSCRIPT_BYTES = configuredLimit();

export function transcriptTooLargeError(maxBytes = MAX_TRANSCRIPT_BYTES) {
  const error = new Error(`Transcript exceeds the configured ${maxBytes}-byte limit.`);
  error.code = 'TRANSCRIPT_TOO_LARGE';
  return error;
}

/**
 * Consume complete UTF-8 JSONL lines from a file, preserving an incomplete tail
 * for a later append. The cumulative byte limit is enforced while streaming as
 * well as against the caller's initial stat, so concurrent growth fails closed.
 */
export async function consumeJsonlFile(filePath, {
  maxBytes = MAX_TRANSCRIPT_BYTES,
  startOffset = 0,
  pendingBuffer = Buffer.alloc(0),
  onLine = () => {}
} = {}) {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) throw new TypeError('maxBytes must be a positive safe integer');
  if (!Number.isSafeInteger(startOffset) || startOffset < 0 || startOffset > maxBytes) throw new TypeError('startOffset must be within the configured byte limit');
  let offset = startOffset;
  let bufferedChunks = pendingBuffer.length ? [Buffer.from(pendingBuffer)] : [];
  let bufferedLength = pendingBuffer.length;
  const stream = fs.createReadStream(filePath, { start: startOffset });

  for await (const chunk of stream) {
    offset += chunk.length;
    if (offset > maxBytes) {
      stream.destroy();
      throw transcriptTooLargeError(maxBytes);
    }
    let cursor = 0;
    let newlineIndex;
    while ((newlineIndex = chunk.indexOf(0x0a, cursor)) !== -1) {
      const segment = chunk.subarray(cursor, newlineIndex);
      let line = bufferedChunks.length
        ? Buffer.concat([...bufferedChunks, segment], bufferedLength + segment.length)
        : segment;
      if (line.length && line[line.length - 1] === 0x0d) line = line.subarray(0, line.length - 1);
      onLine(line.toString('utf8'));
      bufferedChunks = [];
      bufferedLength = 0;
      cursor = newlineIndex + 1;
    }
    const tail = chunk.subarray(cursor);
    if (tail.length) {
      bufferedChunks.push(tail);
      bufferedLength += tail.length;
    }
  }

  return { offset, pendingBuffer: Buffer.concat(bufferedChunks, bufferedLength) };
}
