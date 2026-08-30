/**
 * Resource names and environment-variable helpers.
 * Single source of truth so the code and the console guide
 * (docs/infra-aws-consola.md) never disagree on a name.
 */

export const NAMES = {
  telemetryTable: 'snowball-telemetry',
  readingsQueue: 'snowball-readings',
  readingsDlq: 'snowball-readings-dlq',
  thermalExcursionTopic: 'snowball-thermal-excursion',
  lowBatteryTopic: 'snowball-low-battery',
  noSignalTopic: 'snowball-no-signal',
  iotRule: 'snowball_telemetry',
  mqttTopicPrefix: 'snowball',
} as const;

export function telemetryTopic(unitId: string): string {
  return `${NAMES.mqttTopicPrefix}/${unitId}/telemetry`;
}

export function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing environment variable ${name} (see the package README)`);
  }
  return value;
}

export function envAsNumber(name: string, fallback: number): number {
  const value = process.env[name];
  if (!value) return fallback;
  const n = Number(value);
  if (Number.isNaN(n)) throw new Error(`${name} must be numeric, got "${value}"`);
  return n;
}
