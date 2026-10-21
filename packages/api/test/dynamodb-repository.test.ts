import { beforeEach, describe, expect, test, vi } from 'vitest';

const { send } = vi.hoisted(() => ({ send: vi.fn() }));

vi.mock('@aws-sdk/client-dynamodb', () => ({ DynamoDBClient: class {} }));
vi.mock('@aws-sdk/lib-dynamodb', () => {
  class Command { constructor(public input: Record<string, unknown>) {} }
  return {
    DynamoDBDocumentClient: { from: () => ({ send }) },
    GetCommand: Command,
    PutCommand: Command,
    QueryCommand: Command,
    ScanCommand: Command,
    UpdateCommand: Command,
    BatchGetCommand: Command,
  };
});

import { dataAccess } from '../src/repositories/dynamodb';

describe('DynamoDB data repository', () => {
  beforeEach(() => send.mockReset());

  test('unitInScope enforces the tenant client_id and rejects inactive units', async () => {
    send.mockResolvedValueOnce({ Item: { unit_id: 'SB-001', client_id: 7, active: true } });
    expect(await dataAccess.unitInScope('SB-001', { all: false, clientId: 7 })).toBe(true);

    send.mockResolvedValueOnce({ Item: { unit_id: 'SB-001', client_id: 8, active: true } });
    expect(await dataAccess.unitInScope('SB-001', { all: false, clientId: 7 })).toBe(false);

    send.mockResolvedValueOnce({ Item: { unit_id: 'SB-001', client_id: 7, active: false } });
    expect(await dataAccess.unitInScope('SB-001', { all: true })).toBe(false);
  });

  test('listUnits merges the device-config thresholds and nulls the ones the row lacks', async () => {
    send.mockResolvedValueOnce({ Items: [
      { unit_id: 'SB-001', client_id: 1, description: 'Reefer BA-MDQ', active: true },
      { unit_id: 'SB-002', client_id: 1, active: true },
    ] });
    send.mockResolvedValueOnce({ Item: { unit_id: 'SB-001', setpoint_c: '-18', temp_min_c: '-25', temp_max_c: '-15', tolerance_min: '5', signal_timeout_min: '10' } });
    send.mockResolvedValueOnce({}); // SB-002 has no device-config row at all
    await expect(dataAccess.listUnits({ all: true })).resolves.toEqual([
      { unit_id: 'SB-001', description: 'Reefer BA-MDQ', active: true, setpoint_c: -18, temp_min_c: -25, temp_max_c: -15, tolerance_min: 5, signal_timeout_min: 10 },
      { unit_id: 'SB-002', description: null, active: true, setpoint_c: null, temp_min_c: null, temp_max_c: null, tolerance_min: null, signal_timeout_min: null },
    ]);
  });

  test('getConfig reads and normalizes numeric DynamoDB attributes', async () => {
    send.mockResolvedValueOnce({ Item: { unit_id: 'SB-001', setpoint_c: '-18', temp_min_c: '-25', temp_max_c: '-15', tolerance_min: '5' } });
    await expect(dataAccess.getConfig('SB-001')).resolves.toEqual({
      unit_id: 'SB-001', setpoint_c: -18, temp_min_c: -25, temp_max_c: -15, tolerance_min: 5,
    });
    expect(send.mock.calls[0][0].input).toMatchObject({ TableName: 'snowball-device-config', Key: { unit_id: 'SB-001' } });
  });

  test('listUnits carries every remotely configurable field, tolerance_min included', async () => {
    send.mockResolvedValueOnce({ Items: [{ unit_id: 'SB-001', client_id: 1, active: true, description: 'Reefer' }] });
    send.mockResolvedValueOnce({ Item: { unit_id: 'SB-001', setpoint_c: '-18', temp_min_c: '-25', temp_max_c: '-15', tolerance_min: '5' } });
    await expect(dataAccess.listUnits({ all: true })).resolves.toEqual([
      { unit_id: 'SB-001', description: 'Reefer', active: true, setpoint_c: -18, temp_min_c: -25, temp_max_c: -15, tolerance_min: 5, signal_timeout_min: null },
    ]);
  });

  /**
   * The alert processor writes acknowledged_at as an explicit NULL, and DynamoDB
   * treats a NULL-typed attribute as EXISTING. A bare attribute_not_exists() is
   * therefore false for every real alert row, which made every ack come back as
   * 'already acknowledged'. The mocked client never evaluates conditions, so the
   * contract worth asserting here is the expression that goes out.
   */
  test('acknowledgeAlert accepts a row whose acknowledged_at is an explicit NULL', async () => {
    send.mockResolvedValueOnce({ Item: { id: 1, client_id: 7, acknowledged_by: null, acknowledged_at: null } });
    send.mockResolvedValueOnce({ Attributes: { id: 1, client_id: 7, unit_id: 'SB-001', severity: 'no-signal', emitted_at: '2026-10-21T01:38:04.731Z', acknowledged_by: 3, acknowledged_at: '2026-10-21T02:00:00.000Z' } });

    const result = await dataAccess.acknowledgeAlert(1, 3, { all: true, clientId: null });
    expect(result.status).toBe('ok');

    const update = send.mock.calls[1][0].input;
    expect(update.ConditionExpression).toBe('attribute_not_exists(acknowledged_at) OR acknowledged_at = :unset');
    expect(update.ExpressionAttributeValues[':unset']).toBeNull();
  });

  test('acknowledgeAlert refuses a row that was already acknowledged', async () => {
    send.mockResolvedValueOnce({ Item: { id: 1, client_id: 7, acknowledged_by: 3, acknowledged_at: '2026-10-21T02:00:00.000Z' } });
    expect((await dataAccess.acknowledgeAlert(1, 4, { all: true, clientId: null })).status).toBe('already');
    expect(send).toHaveBeenCalledTimes(1); // short-circuits before the update
  });
});
