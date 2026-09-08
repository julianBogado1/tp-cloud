import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, QueryCommand, ScanCommand } from '@aws-sdk/lib-dynamodb';
import { PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import type { IngestedReading } from '@snowball/shared';
import { NAMES, requireEnv } from '@snowball/shared';
import type { ExportDeps } from './export';

/**
 * ExportDeps over the real tables and bucket. Clients are injected so the
 * pagination and request shapes are unit-tested; `awsDepsFromEnv` wires the
 * SDK clients for the Lambda and the CLI.
 */

export interface AwsConfig {
  bucket: string;
  table: string;
  stateTable: string;
}

type Page = { Items?: Record<string, unknown>[]; LastEvaluatedKey?: Record<string, unknown> };

export interface AwsClients {
  ddbSend(cmd: ScanCommand | QueryCommand): Promise<Page>;
  s3Send(cmd: PutObjectCommand): Promise<unknown>;
}

export function awsDeps(config: AwsConfig, clients: AwsClients): ExportDeps {
  return {
    async listUnits() {
      const ids: string[] = [];
      let ExclusiveStartKey: Record<string, unknown> | undefined;
      do {
        const page = await clients.ddbSend(
          new ScanCommand({ TableName: config.stateTable, ProjectionExpression: 'unit_id', ExclusiveStartKey }),
        );
        for (const item of page.Items ?? []) ids.push(item.unit_id as string);
        ExclusiveStartKey = page.LastEvaluatedKey;
      } while (ExclusiveStartKey);
      return ids.sort();
    },

    async queryReadings(unitId, from, to) {
      const rows: IngestedReading[] = [];
      let ExclusiveStartKey: Record<string, unknown> | undefined;
      do {
        const page = await clients.ddbSend(
          new QueryCommand({
            TableName: config.table,
            KeyConditionExpression: 'unit_id = :u AND ts BETWEEN :from AND :to',
            ExpressionAttributeValues: { ':u': unitId, ':from': from, ':to': to },
            ExclusiveStartKey,
          }),
        );
        rows.push(...((page.Items ?? []) as unknown as IngestedReading[]));
        ExclusiveStartKey = page.LastEvaluatedKey;
      } while (ExclusiveStartKey);
      return rows;
    },

    async putObject(key, body) {
      await clients.s3Send(
        new PutObjectCommand({
          Bucket: config.bucket,
          Key: key,
          Body: body,
          ContentType: 'application/x-ndjson',
          ContentEncoding: 'gzip',
        }),
      );
    },

    log: (message) => console.log(message),
  };
}

export function awsDepsFromEnv(): ExportDeps {
  const config: AwsConfig = {
    bucket: requireEnv('ARCHIVE_BUCKET'),
    table: process.env.DDB_TABLE ?? NAMES.telemetryTable,
    stateTable: process.env.DDB_STATE_TABLE ?? NAMES.unitStateTable,
  };
  const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}));
  const s3 = new S3Client({});
  return awsDeps(config, {
    ddbSend: (cmd) => ddb.send(cmd as QueryCommand) as Promise<Page>,
    s3Send: (cmd) => s3.send(cmd),
  });
}
