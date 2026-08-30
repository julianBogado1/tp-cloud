# tp-cloud — Snowball

Backend de **Snowball**, plataforma de monitoreo de cadena de frío en tiempo
real (ITBA Cloud Computing, Entrega 2). Arquitectura: **Variante B revisada**
(`snowball-variante-b.pdf`) — la ingesta MQTT la resuelve **AWS IoT Core** con
reglas hacia DynamoDB y SQS; el cómputo propio evalúa umbrales, notifica y
sirve la lectura al dashboard.

```
INGESTA (máquinas)
simulator (local) ──MQTT/TLS──▶ IoT Core ──regla──▶ DynamoDB (telemetría)
                                          └─regla──▶ SQS ──▶ alert-processor (EC2) ──▶ SNS (mail/SMS)
                                                                    │
                                                              RDS (umbrales, alertas)
LECTURA (humanos)
dashboard (estático, S3) ──HTTP/WS──▶ api (EC2) ──▶ DynamoDB + RDS
```

Las dos rutas no se tocan: la cola es exclusiva del `alert-processor`; la
`api` no consume SQS — lee lo que la ingesta ya guardó, y el feed en vivo
del WebSocket lo resuelve consultando DynamoDB solo por las unidades que los
dashboards conectados están mirando.

## Estructura

| Ruta | Qué es | Dónde corre |
|---|---|---|
| `packages/shared` | Tipos del dominio + nombres de recursos (única fuente de verdad; se _bundlea_ dentro de cada artefacto) | — |
| `packages/simulator` | Unidades de frío simuladas: cliente MQTT con certificado X.509, escenarios de excursión/silencio, Device Shadow | **local** |
| `packages/alert-processor` | Consumidor de SQS: máquina de estados de excursión, umbrales desde RDS, alertas a SNS + RDS. Stateless (estado en DynamoDB) | EC2, artefacto de un solo archivo |
| `packages/api` | REST + WebSocket para el dashboard: unidades/alertas desde RDS, telemetría desde DynamoDB, feed en vivo por polling acotado. Stateless | EC2, artefacto de un solo archivo |
| `packages/dashboard` | Frontend React (Vite): tarjetas por unidad con feed en vivo, historial y alertas. Compila a archivos 100 % estáticos | S3 static website |
| `infra/sql/` | `schema.sql` y `seed.sql` de la base de dominio (RDS PostgreSQL) | — |
| `docs/infra-aws-consola.md` | **Guía paso a paso** para crear toda la infraestructura desde la consola AWS y desplegar cada módulo | — |

## Uso

```bash
npm install
npm test          # unit tests de los cuatro módulos
npm run build

# simulador (local; necesita certs/ — ver la guía de consola, §4.3)
npm run simulator -- --endpoint <xxx-ats.iot.us-east-1.amazonaws.com> \
  --units SB-001,SB-002 --interval 5 --excursion SB-001@60

# procesador de alertas (necesita SQS_QUEUE_URL, SNS_THERMAL_EXCURSION_TOPIC_ARN y PG*)
npm run alert-processor

# API (necesita PG*; opcionales PORT, LIVE_POLL_MS, DDB_TABLE)
npm run api

# dashboard en modo dev (VITE_API_BASE en packages/dashboard/.env, ver .env.example)
npm run dashboard
```

## Despliegue

```bash
npm run bundle    # esbuild → un .js autocontenido por artefacto de EC2
# packages/alert-processor/dist/alert-processor.bundle.js  → scp + node
# packages/api/dist/api.bundle.js                           → scp + node

VITE_API_BASE=http://<api>:3000 npm run build -w @snowball/dashboard
aws s3 sync packages/dashboard/dist/ s3://<bucket>/ --delete
```

El detalle de variables de entorno, seguridad y el checklist de verificación
end-to-end están en `docs/infra-aws-consola.md`.

## Pendiente (fases siguientes)

- JWT en la API + acknowledgement de alertas (escrituras humanas a RDS)
- ALB delante de la API y VPC de tres capas según el PDF (§7)
- Alarma CloudWatch de «sin señal» y alertas de batería baja (`snowball-low-battery`)
