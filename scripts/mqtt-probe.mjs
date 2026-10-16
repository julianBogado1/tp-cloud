import mqtt from 'mqtt';
import { readFileSync } from 'node:fs';

const [, , endpoint, unit = 'SB-001', ver = '4'] = process.argv;
const c = mqtt.connect(`mqtts://${endpoint}:8883`, {
  clientId: unit,
  protocolVersion: Number(ver),
  reconnectPeriod: 0,
  ca: readFileSync('certs/AmazonRootCA1.pem'),
  cert: readFileSync(`certs/${unit}/certificate.pem.crt`),
  key: readFileSync(`certs/${unit}/private.pem.key`),
});
c.on('connect', (p) => { console.log('CONNECTED', JSON.stringify(p)); c.end(); });
c.on('error', (e) => console.log('ERROR', e.code, e.message));
c.on('disconnect', (p) => console.log('DISCONNECT', JSON.stringify(p)));
c.on('close', () => console.log('CLOSE'));