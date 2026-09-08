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

/**
 * Network topology. Nothing in the runtime reads these — the API and the alert
 * processor only ever see endpoints and queue URLs through the environment.
 * They live here so the console guide, the architecture diagram and this file
 * cannot drift apart on a name, a CIDR or an availability zone.
 *
 * Three subnet layers times two zones. Two zones is not a preference: RDS
 * Multi-AZ needs a DB subnet group spanning at least two, and an ALB needs at
 * least two public subnets in different ones. The third-octet jump between
 * layers (1-2, 11-12, 21-22) makes a subnet's role readable at a glance in any
 * route table or flow log.
 */
export const NETWORK = {
  region: 'us-east-1',
  azA: 'us-east-1a',
  azB: 'us-east-1b',

  vpc: 'snowball-vpc',
  vpcCidr: '10.0.0.0/16',

  subnets: {
    publicA: { name: 'snowball-public-a', cidr: '10.0.1.0/24', az: 'us-east-1a' },
    publicB: { name: 'snowball-public-b', cidr: '10.0.2.0/24', az: 'us-east-1b' },
    appA: { name: 'snowball-app-a', cidr: '10.0.11.0/24', az: 'us-east-1a' },
    appB: { name: 'snowball-app-b', cidr: '10.0.12.0/24', az: 'us-east-1b' },
    dataA: { name: 'snowball-data-a', cidr: '10.0.21.0/24', az: 'us-east-1a' },
    dataB: { name: 'snowball-data-b', cidr: '10.0.22.0/24', az: 'us-east-1b' },
  },

  igw: 'igw-snowball',
  /** Zonal, lives in publicA. If that zone falls, egress falls with it. */
  nat: 'nat-snowball-a',

  routeTables: {
    public: 'rt-public',
    /** app-a and app-b are kept separate so adding a second NAT is one line. */
    appA: 'rt-app-a',
    appB: 'rt-app-b',
    /** One entry only: 10.0.0.0/16 local. No default route of any kind. */
    data: 'rt-data',
  },

  /** Gateway endpoints: no ENI, no IP, no security group — route entries. */
  endpoints: {
    s3: 'vpce-s3',
    dynamodb: 'vpce-ddb',
  },

  securityGroups: {
    alb: 'sg-alb',
    app: 'sg-app',
    db: 'sg-db',
    bastion: 'sg-bastion',
  },
  /** Stateless, on the data subnets only. Default NACL elsewhere, on purpose. */
  naclData: 'nacl-data',

  alb: 'snowball-alb',
  albTargetGroup: 'snowball-app-tg',
  launchTemplate: 'snowball-app-lt',
  asg: 'snowball-app-asg',
  instanceType: 't3.small',
  bastion: 'snowball-bastion',

  rdsInstance: 'snowball-db',
  dbSubnetGroup: 'snowball-db-subnets',
  database: 'snowball',
  dbUser: 'snowball',
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
