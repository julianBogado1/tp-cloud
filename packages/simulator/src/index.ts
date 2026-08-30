import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import mqtt, { type MqttClient } from 'mqtt';
import { telemetryTopic } from '@snowball/shared';
import { createUnit, generateReading, type UnitState } from './telemetry';

/**
 * Cold-chain unit simulator. Each unit is an MQTT client against IoT Core,
 * authenticated with its X.509 certificate (mTLS), publishing telemetry every
 * N seconds and serving its Device Shadow.
 *
 * Usage:
 *   npm run simulator -- --endpoint xxxx-ats.iot.us-east-1.amazonaws.com \
 *     --units SB-001,SB-002 --interval 5 \
 *     --excursion SB-001@60 --silence SB-002@120
 *
 * Expected certificates (generated in the console, see docs/infra-aws-consola.md):
 *   certs/AmazonRootCA1.pem
 *   certs/<unit>/certificate.pem.crt
 *   certs/<unit>/private.pem.key
 */

interface Scenario {
  /** seconds until the thermal excursion starts, per unit */
  excursionAfter?: number;
  /** seconds until it stops publishing (the "no signal" test), per unit */
  silenceAfter?: number;
}

const { values } = parseArgs({
  options: {
    endpoint: { type: 'string' },
    units: { type: 'string', default: 'SB-001' },
    interval: { type: 'string', default: '5' },
    setpoint: { type: 'string', default: '-18' },
    certs: { type: 'string', default: 'certs' },
    excursion: { type: 'string', multiple: true, default: [] },
    silence: { type: 'string', multiple: true, default: [] },
  },
});

const endpoint = values.endpoint ?? process.env.IOT_ENDPOINT;
if (!endpoint) {
  console.error('Missing --endpoint or IOT_ENDPOINT (IoT Core console → Settings → Device data endpoint)');
  process.exit(1);
}

const intervalMs = Number(values.interval) * 1000;
const setpoint = Number(values.setpoint);
const certsDir = values.certs!;

function parseScenarios(entries: string[]): Map<string, number> {
  const map = new Map<string, number>();
  for (const entry of entries) {
    const [unit, seconds] = entry.split('@');
    if (!unit || Number.isNaN(Number(seconds))) {
      console.error(`Invalid scenario "${entry}" — expected format UNIT@SECONDS`);
      process.exit(1);
    }
    map.set(unit, Number(seconds));
  }
  return map;
}

const excursions = parseScenarios(values.excursion as string[]);
const silences = parseScenarios(values.silence as string[]);

function connectUnit(unitId: string): MqttClient {
  return mqtt.connect(`mqtts://${endpoint}:8883`, {
    clientId: unitId,
    ca: readFileSync(join(certsDir, 'AmazonRootCA1.pem')),
    cert: readFileSync(join(certsDir, unitId, 'certificate.pem.crt')),
    key: readFileSync(join(certsDir, unitId, 'private.pem.key')),
    protocolVersion: 5,
    reconnectPeriod: 2000,
  });
}

function shadowDeltaTopic(unitId: string): string {
  return `$aws/things/${unitId}/shadow/update/delta`;
}

function shadowUpdateTopic(unitId: string): string {
  return `$aws/things/${unitId}/shadow/update`;
}

function startUnit(unitId: string, scenario: Scenario): void {
  let unit: UnitState = createUnit(unitId, setpoint);
  const client = connectUnit(unitId);

  client.on('connect', () => {
    console.log(`[${unitId}] connected to IoT Core`);
    client.subscribe(shadowDeltaTopic(unitId));
    // publish the currently applied state to initialize the shadow
    client.publish(
      shadowUpdateTopic(unitId),
      JSON.stringify({ state: { reported: { setpoint_c: unit.setpoint_c } } }),
    );
  });

  client.on('message', (topic, payload) => {
    if (topic !== shadowDeltaTopic(unitId)) return;
    const delta = JSON.parse(payload.toString());
    const desired = delta?.state?.setpoint_c;
    if (typeof desired !== 'number') return;
    console.log(`[${unitId}] desired setpoint ${desired}°C — applying in 3s`);
    setTimeout(() => {
      unit = { ...unit, setpoint_c: desired };
      client.publish(
        shadowUpdateTopic(unitId),
        JSON.stringify({ state: { reported: { setpoint_c: desired } } }),
      );
      console.log(`[${unitId}] setpoint applied and reported: ${desired}°C`);
    }, 3000);
  });

  client.on('error', (err) => console.error(`[${unitId}] MQTT error:`, err.message));

  if (scenario.excursionAfter !== undefined) {
    setTimeout(() => {
      unit = { ...unit, inExcursion: true };
      console.log(`[${unitId}] *** thermal excursion starts ***`);
    }, scenario.excursionAfter * 1000);
  }

  const timer = setInterval(() => {
    const result = generateReading(unit, new Date(), Math.random);
    unit = result.unit;
    client.publish(telemetryTopic(unitId), JSON.stringify(result.reading), { qos: 1 });
    console.log(`[${unitId}] ${result.reading.ts} ${result.reading.temp_c}°C bat ${result.reading.battery}%`);
  }, intervalMs);

  if (scenario.silenceAfter !== undefined) {
    setTimeout(() => {
      clearInterval(timer);
      client.end();
      console.log(`[${unitId}] *** silenced ("no signal" test) ***`);
    }, scenario.silenceAfter * 1000);
  }
}

const units = values.units!.split(',').map((u) => u.trim());
console.log(`Simulating ${units.length} unit(s) against ${endpoint} every ${intervalMs / 1000}s`);
for (const unitId of units) {
  startUnit(unitId, {
    excursionAfter: excursions.get(unitId),
    silenceAfter: silences.get(unitId),
  });
}
