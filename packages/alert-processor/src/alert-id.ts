import { createHash } from 'node:crypto';

/**
 * Deterministic alert id for one excursion of one unit.
 *
 * The alerts table hash key `id` is a DynamoDB Number, so the id stays an
 * integer: the first 13 hex chars (52 bits) of sha256(`unit_id|since`), plus 1
 * so it is never 0 (the API rejects ids < 1). The maximum, 2^52, is below
 * Number.MAX_SAFE_INTEGER (2^53 - 1), so it round-trips through JSON and the
 * DynamoDB Number type without loss.
 *
 * A retry of the same excursion yields the same id, so the conditional put
 * cannot write a second row; two units alerting in the same millisecond no
 * longer collide (as they could with `Date.now()`).
 *
 * `seed` separates alert kinds that can share a `since`: a unit that deviates
 * on the reading at T and then falls silent with that same last reading would
 * otherwise hash both alerts to one id, and the conditional put would drop the
 * second silently. Omitting it keeps the original input, so existing thermal
 * alert ids do not change.
 */
export function alertId(unitId: string, since: string, seed?: string): number {
  const input = seed === undefined ? `${unitId}|${since}` : `${seed}|${unitId}|${since}`;
  const hex = createHash('sha256').update(input).digest('hex').slice(0, 13);
  return Number.parseInt(hex, 16) + 1;
}
