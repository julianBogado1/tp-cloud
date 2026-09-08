import { describe, expect, test } from 'vitest';
import { QueryCommand, ScanCommand } from '@aws-sdk/lib-dynamodb';
import { PutObjectCommand } from '@aws-sdk/client-s3';
import { awsDeps, type AwsClients } from '../src/aws';

const config = { bucket: 'snowball-archive-test', table: 'snowball-telemetry', stateTable: 'snowball-unit-state' };

function clients(pages: Array<{ Items?: Record<string, unknown>[]; LastEvaluatedKey?: Record<string, unknown> }>) {
  const ddbCalls: Array<ScanCommand | QueryCommand> = [];
  const s3Calls: PutObjectCommand[] = [];
  let i = 0;
  const c: AwsClients = {
    ddbSend: async (cmd) => {
      ddbCalls.push(cmd);
      return pages[i++] ?? {};
    },
    s3Send: async (cmd) => {
      s3Calls.push(cmd);
      return {};
    },
  };
  return { c, ddbCalls, s3Calls };
}

describe('awsDeps — real DynamoDB/S3 calls behind ExportDeps', () => {
  test('listUnits scans the state table with a projection, follows LastEvaluatedKey and sorts', async () => {
    const { c, ddbCalls } = clients([
      { Items: [{ unit_id: 'SB-002' }], LastEvaluatedKey: { unit_id: 'SB-002' } },
      { Items: [{ unit_id: 'SB-001' }] },
    ]);

    const ids = await awsDeps(config, c).listUnits();

    expect(ids).toEqual(['SB-001', 'SB-002']);
    expect(ddbCalls).toHaveLength(2);
    expect(ddbCalls[0]).toBeInstanceOf(ScanCommand);
    expect(ddbCalls[0].input).toMatchObject({ TableName: 'snowball-unit-state', ProjectionExpression: 'unit_id' });
    expect(ddbCalls[0].input.ExclusiveStartKey).toBeUndefined();
    expect(ddbCalls[1].input.ExclusiveStartKey).toEqual({ unit_id: 'SB-002' });
  });

  test('queryReadings uses BETWEEN on the history table and follows LastEvaluatedKey', async () => {
    const a = { unit_id: 'SB-001', ts: '2026-09-06T00:00:05.000Z' };
    const b = { unit_id: 'SB-001', ts: '2026-09-06T00:00:10.000Z' };
    const { c, ddbCalls } = clients([
      { Items: [a], LastEvaluatedKey: { unit_id: 'SB-001', ts: a.ts } },
      { Items: [b] },
    ]);

    const rows = await awsDeps(config, c).queryReadings('SB-001', '2026-09-06T00:00:00.000Z', '2026-09-07T00:00:00.000Z');

    expect(rows).toEqual([a, b]);
    expect(ddbCalls[0]).toBeInstanceOf(QueryCommand);
    expect(ddbCalls[0].input).toMatchObject({
      TableName: 'snowball-telemetry',
      KeyConditionExpression: 'unit_id = :u AND ts BETWEEN :from AND :to',
      ExpressionAttributeValues: { ':u': 'SB-001', ':from': '2026-09-06T00:00:00.000Z', ':to': '2026-09-07T00:00:00.000Z' },
    });
    expect(ddbCalls[1].input.ExclusiveStartKey).toEqual({ 'unit_id': 'SB-001', 'ts': a.ts });
  });

  test('putObject writes to the bucket with gzip/ndjson metadata', async () => {
    const { c, s3Calls } = clients([]);
    const body = Buffer.from('x');

    await awsDeps(config, c).putObject('telemetry/2026/09/06/SB-001.ndjson.gz', body);

    expect(s3Calls).toHaveLength(1);
    expect(s3Calls[0].input).toMatchObject({
      Bucket: 'snowball-archive-test',
      Key: 'telemetry/2026/09/06/SB-001.ndjson.gz',
      ContentType: 'application/x-ndjson',
      ContentEncoding: 'gzip',
    });
    expect(s3Calls[0].input.Body).toBe(body);
  });
});
