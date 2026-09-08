import { gunzipSync, gzipSync } from 'node:zlib';

/**
 * Newline-delimited JSON, gzip-compressed: one document per line, trailing
 * newline. Readable by `zcat file | jq`, Athena/Glue and any log tool.
 */

export function toNdjsonGz(rows: readonly unknown[]): Buffer {
  const text = rows.length === 0 ? '' : rows.map((row) => JSON.stringify(row)).join('\n') + '\n';
  return gzipSync(Buffer.from(text, 'utf8'));
}

export function fromNdjsonGz<T = unknown>(buf: Buffer): T[] {
  return gunzipSync(buf)
    .toString('utf8')
    .split('\n')
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as T);
}
