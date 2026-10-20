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
      { unit_id: 'SB-001', description: 'Reefer', active: true, setpoint_c: -18, temp_min_c: -25, temp_max_c: -15, tolerance_min: 5 },
    ]);
  });
});
