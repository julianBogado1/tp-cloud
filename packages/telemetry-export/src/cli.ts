import { parseArgs } from 'node:util';
import { awsDepsFromEnv } from './aws';
import { runExport } from './export';

/**
 * Same export, run from a laptop with local AWS credentials.
 *
 *   ARCHIVE_BUCKET=snowball-archive-<sufijo> npm run export -- --date 2026-09-06
 */
const { values } = parseArgs({ options: { date: { type: 'string' } } });

runExport(awsDepsFromEnv(), new Date(), values.date)
  .then((result) => console.log(JSON.stringify(result)))
  .catch((err: Error) => {
    console.error(err.message);
    process.exit(1);
  });
