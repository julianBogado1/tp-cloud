import {
  GetThingShadowCommand,
  IoTDataPlaneClient,
  ResourceNotFoundException,
  UpdateThingShadowCommand,
} from '@aws-sdk/client-iot-data-plane';
import type { DeviceConfig, DeviceShadowState } from '@snowball/shared';

/**
 * Classic (unnamed) Device Shadow access. The interface is what the routes
 * depend on; tests inject a fake. The EC2 instance authenticates through
 * LabInstanceProfile — verify once with
 * `aws iot-data get-thing-shadow --thing-name SB-001 /dev/stdout`.
 */

export type ShadowState = DeviceShadowState;

export interface ShadowClient {
  /** undefined when the thing has no shadow yet (device never reported). */
  get(thingName: string): Promise<ShadowState | undefined>;
  /** Merges `desired` into the shadow's desired state (keys not sent are preserved). */
  updateDesired(thingName: string, desired: Partial<DeviceConfig>): Promise<void>;
}

export function createIotShadowClient(endpoint: string): ShadowClient {
  const client = new IoTDataPlaneClient({ endpoint: `https://${endpoint}` });
  const decoder = new TextDecoder();
  return {
    async get(thingName) {
      try {
        const out = await client.send(new GetThingShadowCommand({ thingName }));
        if (!out.payload) return undefined;
        const doc = JSON.parse(decoder.decode(out.payload)) as { state?: Partial<ShadowState> };
        return { desired: doc.state?.desired ?? {}, reported: doc.state?.reported ?? {} };
      } catch (err) {
        if (err instanceof ResourceNotFoundException) return undefined;
        throw err;
      }
    },
    async updateDesired(thingName, desired) {
      await client.send(
        new UpdateThingShadowCommand({
          thingName,
          payload: Buffer.from(JSON.stringify({ state: { desired } })),
        }),
      );
    },
  };
}
