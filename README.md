# tp-cloud — Snowball

Backend de **Snowball**, plataforma de monitoreo de cadena de frío en tiempo
real (ITBA Cloud Computing). Esta es la **Entrega 3**: la arquitectura de la
Entrega 2 desplegada con **Infraestructura como Código (Terraform)** en el AWS
Learner Lab, y con la corrección pedida en la entrega anterior: **una sola base
de datos, DynamoDB** (se eliminó RDS).

La ingesta MQTT la resuelve **AWS IoT Core** con reglas hacia DynamoDB y SQS;
el cómputo propio evalúa umbrales, notifica y sirve la lectura al dashboard.

```
INGESTA (máquinas)
simulator (local) ──MQTT/TLS──▶ IoT Core ──regla──▶ DynamoDB snowball-telemetry (histórico, TTL 30 d)
                                          ├─regla──▶ DynamoDB snowball-unit-state (última lectura por unidad)
                                          └─regla──▶ SQS ──▶ alert-processor (EC2) ──▶ SNS (mail)
                                                                  │
                                                       DynamoDB (users, clients, units, device-config, alerts)
ARCHIVO
EventBridge Scheduler (diario 00:15 UTC) ──▶ telemetry-export (Lambda) ──▶ S3 telemetry/aaaa/mm/dd/*.ndjson.gz ──▶ Glacier
LECTURA (humanos)
dashboard (estático, S3) ──HTTP+JWT/WS──▶ ALB ──▶ api (EC2, Auto Scaling Group) ──▶ DynamoDB + Device Shadow
```

Las dos rutas no se tocan: la cola es exclusiva del `alert-processor`; la
`api` no consume SQS — lee lo que la ingesta ya guardó, y el feed en vivo del
WebSocket lo resuelve consultando DynamoDB solo por las unidades que los
dashboards conectados están mirando. La última lectura sale de
`snowball-unit-state` y el historial de `snowball-telemetry`.

## Documentación

| Documento | Para qué |
|---|---|
| [`docs/infra-terraform.md`](docs/infra-terraform.md) | **Guía vigente**: levantar todo con Terraform en el Learner Lab, paso a paso, con verificación, pipeline, destroy y troubleshooting |
| [`docs/dynamodb-model.md`](docs/dynamodb-model.md) | Modelo de tablas DynamoDB: claves, GSIs y qué consulta cubre cada uno |
| [`docs/terraform-buckets-learner-lab.md`](docs/terraform-buckets-learner-lab.md) | Por qué los buckets se crean por script y no por Terraform |
| [`docs/infra-aws-consola.md`](docs/infra-aws-consola.md) | Guía histórica de la Entrega 2 (todo a mano desde la consola, todavía con RDS). No se modificó |

## Estructura

| Ruta | Qué es | Dónde corre |
|---|---|---|
| `packages/shared` | Tipos del dominio + nombres de recursos (`NAMES`, única fuente de verdad del código; se _bundlea_ dentro de cada artefacto) | — |
| `packages/simulator` | Unidades de frío simuladas: cliente MQTT con certificado X.509, escenarios de excursión/silencio, Device Shadow | **local** |
| `packages/alert-processor` | Consumidor de SQS: máquina de estados de excursión, umbrales y alertas en DynamoDB, notificaciones SNS. Stateless | EC2, artefacto de un solo archivo |
| `packages/api` | REST + WebSocket para el dashboard: login con JWT propio (`/auth`), roles operador/supervisor/admin con alcance por cliente, lectura de unidades/alertas/telemetría, acknowledgement de alertas, configuración remota vía Device Shadow y ABM de usuarios. Acceso a datos por repositorios DynamoDB. Stateless | EC2, artefacto de un solo archivo |
| `packages/telemetry-export` | Lambda diaria: copia el histórico del día anterior de DynamoDB a S3 (`.ndjson.gz` por unidad) para el archivo en Glacier. También corre local (`npm run export`) | Lambda (EventBridge Scheduler) |
| `packages/dashboard` | Frontend React (Vite): tarjetas por unidad con feed en vivo, historial y alertas. Compila a archivos 100 % estáticos | S3 static website |
| `terraform/` | Toda la infraestructura como código (módulos propios, un módulo externo, backend S3) | — |
| `scripts/` | `bootstrap-buckets.sh` (crea los buckets), `delete-buckets.sh` (los borra), `export-certs.sh` (baja los certificados IoT), `seed-data.json` (datos demo de DynamoDB), `mqtt-probe.mjs` (diagnóstico de conexión MQTT) | local |
| `.github/` | Pipeline de GitHub Actions (`workflows/terraform.yml`) y composite action de preparación | GitHub |
| `infra/sql/` | SQL histórico de la Entrega 2, conservado solo como referencia; la ejecución actual usa `scripts/seed-data.json` | — |

## Despliegue con Terraform (resumen)

La guía completa, sin saltear nada, está en
[`docs/infra-terraform.md`](docs/infra-terraform.md). Resumen de los pasos, con
el Lab iniciado y las credenciales de **AWS Details → AWS CLI** pegadas en
`~/.aws/credentials`:

```bash
npm ci

# 1. Buckets (los crea la CLI, no Terraform: el SCP del Lab bloquea la lectura de Object Lock)
bash scripts/bootstrap-buckets.sh <sufijo> <bucket-de-state>

# 2. Variables propias (el sufijo y el state tienen que coincidir con el paso 1)
cp terraform/terraform.tfvars.example terraform/terraform.tfvars   # y completarlo

# 3. Artefactos que Terraform sube a S3
npm run bundle

# 4. Terraform
terraform -chdir=terraform init \
  -backend-config="bucket=<bucket-de-state>" \
  -backend-config="key=snowball/terraform.tfstate" \
  -backend-config="region=us-east-1"
terraform -chdir=terraform validate
terraform -chdir=terraform plan
terraform -chdir=terraform apply

# 5. Dashboard (necesita el DNS del ALB, que solo existe después del apply)
ALB=$(terraform -chdir=terraform output -raw alb_dns_name)
BUCKET=$(terraform -chdir=terraform output -raw dashboard_bucket)
VITE_API_BASE="http://${ALB}" npm run build -w @snowball/dashboard
aws s3 sync packages/dashboard/dist/ "s3://${BUCKET}/" --delete

# 6. Certificados IoT y simulador
bash scripts/export-certs.sh
npm run simulator -- --endpoint "$(terraform -chdir=terraform output -raw iot_endpoint)" \
  --units SB-001,SB-002,SB-003 --interval 5 --excursion SB-001@60

# 7. Al terminar la sesión
terraform -chdir=terraform destroy
bash scripts/delete-buckets.sh <sufijo> <bucket-de-state>
```

Después del `apply` hay que **confirmar la suscripción de SNS** desde el mail que
llega a `sns_subscription_email`. El backend usa el **bloqueo nativo de S3**
(`use_lockfile = true`, Terraform ≥ 1.10), el equivalente moderno del clásico
«S3 + tabla DynamoDB para el lock», sin la tabla extra. Los secretos
(`jwt_secret`, credenciales) nunca se commitean: van en `terraform.tfvars`
(ignorado por git) o en secrets de GitHub.

### Estructura del código Terraform

```
terraform/
├── versions.tf  providers.tf  backend.tf  variables.tf  locals.tf  main.tf  outputs.tf
├── terraform.tfvars.example
├── bootstrap/                # documentación del paso de buckets (no crea recursos)
└── modules/
    ├── network/              # VPC, subredes, NAT, rutas, endpoints, security groups
    ├── data/                 # tablas DynamoDB + seed
    ├── messaging/            # SQS + DLQ, SNS, alarma «sin señal» (módulo externo)
    ├── iot-ingest/           # IoT Core: policy, things, certificados, regla
    ├── compute/              # bundles en S3, ALB, launch template, ASG, bastión opcional
    └── export/               # Lambda de exportación + schedule diario
```

### Módulos

**Módulos propios** (`terraform/modules/`):

| Módulo | Responsabilidad |
|---|---|
| `network` | VPC `10.0.0.0/16`; 2 subredes públicas y 2 de aplicación (en `us-east-1a`/`us-east-1b`) derivadas con `cidrsubnet`; Internet Gateway; un NAT Gateway; tablas de ruteo; gateway endpoints de S3 y DynamoDB; security groups `sg-alb` → `sg-app` ← `sg-bastion` encadenados por referencia (ninguno abre un rango de IPs cuando puede referenciar otro grupo) |
| `data` | Las 7 tablas DynamoDB (`telemetry`, `unit-state`, `users`, `clients`, `units`, `alerts`, `device-config`) a partir de un único mapa de definiciones, con GSIs y TTL en bloques `dynamic`, y la carga de datos demo desde `scripts/seed-data.json` |
| `messaging` | Cola `snowball-readings` con DLQ (3 reintentos), tópicos SNS (térmico, batería, sin señal), suscripción por mail y alarma de «sin señal» |
| `iot-ingest` | Policy `snowball-device-policy` (cada dispositivo solo ve sus tópicos), thing + certificado X.509 por unidad y regla `snowball_telemetry` con acciones a DynamoDB (×2) y SQS |
| `compute` | Subida de bundles a S3, target group, ALB, launch template con user data (`templatefile`), Auto Scaling Group 2–4 `t3.small` en subredes privadas y bastión opcional |
| `export` | Lambda `snowball-telemetry-export` (Node 22) y schedule diario en EventBridge Scheduler |

**Módulo externo** (Terraform Registry): `terraform-aws-modules/cloudwatch/aws//modules/metric-alarm`
(`~> 5.0`), usado en `messaging` para la alarma que se dispara si la cola de
lecturas no recibe mensajes durante 15 minutos.

La raíz (`main.tf`) además administra, como recursos *standalone* sobre los
buckets ya creados, el versionado, cifrado, Public Access Block, lifecycle a
Glacier, website y policy pública del dashboard.

> **Sin `aws_s3_bucket`.** El SCP del Learner Lab deniega
> `s3:GetBucketObjectLockConfiguration`, que el provider lee tras crear cualquier
> bucket. Por eso los cuatro buckets (state, dashboard, artifacts, archive) los
> crea `scripts/bootstrap-buckets.sh` y Terraform solo gestiona sus
> configuraciones. Detalle en `docs/terraform-buckets-learner-lab.md`.

Variables, valores por defecto y outputs: ver la sección 16 de
[`docs/infra-terraform.md`](docs/infra-terraform.md).

### Funciones de Terraform utilizadas

(Archivo y línea relativos a `terraform/`, al momento de esta entrega.)

| Función | Dónde | Para qué |
|---|---|---|
| `cidrsubnet` | `modules/network/main.tf:3-6` | Deriva los CIDR de las 4 subredes a partir del CIDR de la VPC |
| `toset` | `locals.tf:22`, `main.tf:35`, `modules/network/main.tf:47,63` | Convierte listas en conjuntos para usarlas con `for_each` (unidades, buckets, subredes) |
| `jsonencode` | `modules/messaging/main.tf:9`, `modules/data/main.tf:74`, `modules/iot-ingest/main.tf:8`, `main.tf:94` | Arma la redrive policy de SQS, los ítems del seed, la policy de IoT y la policy del bucket |
| `file` + `jsondecode` | `modules/data/main.tf:11` | Lee y parsea `scripts/seed-data.json` |
| `merge` | `modules/data/main.tf:12` | Une los ítems del seed de distintas entidades en un único mapa |
| `lookup` | `modules/data/main.tf:73` | Obtiene la clave de rango de una tabla solo si está definida |
| `try` | `modules/data/main.tf:44,55`, `modules/compute/outputs.tf:4` | Tolera GSIs sin rango y el bastión ausente |
| `templatefile` + `base64encode` | `modules/compute/main.tf:67` | Renderiza el user data de las EC2 con nombres de tablas, cola, tópico y secretos |
| `filemd5` | `modules/compute/main.tf:21,28` | Detecta cambios en los bundles de la API y del procesador para volver a subirlos |
| `filebase64sha256` | `modules/export/main.tf:8` | Detecta cambios en el ZIP de la Lambda |
| `format` | `modules/messaging/main.tf:29` | Arma el nombre de la alarma |

### Meta-argumentos utilizados

| Meta-argumento | Dónde | Para qué |
|---|---|---|
| `for_each` | `modules/data/main.tf:20,70`; `modules/iot-ingest/main.tf:38,42,46,51`; `modules/network/main.tf:16,47,52,57,63,69`; `modules/messaging/main.tf:12`; `main.tf:35` | Una instancia por tabla, por unidad IoT (thing + certificado + attachments), por subred, por ruta, por endpoint, por tópico SNS y por bucket privado, sin repetir código |
| `count` | `modules/compute/main.tf:100`, `modules/messaging/main.tf:16` | Bastión opcional (`enable_bastion`) y suscripción de mail opcional |
| `depends_on` | `modules/network/main.tf:34`; `modules/data/main.tf:75`; `modules/compute/main.tf:84`; `main.tf:103,138,150` | Orden explícito donde Terraform no lo infiere (NAT tras el IGW, seed tras las tablas, launch template tras los bundles, policy tras el website, cómputo tras datos y mensajería) |
| `lifecycle` | `modules/compute/main.tf:81-83` | `create_before_destroy` en el launch template, para que su reemplazo no deje al ASG sin plantilla |

Además se usan bloques `dynamic` (`modules/data/main.tf:29-65`) para generar
atributos, GSIs y TTL a partir de datos.

### DRY y convenciones

- **Una sola fuente de nombres:** `locals.tf` define los nombres de recursos y
  se pasa a los módulos; en el código TypeScript es `packages/shared/src/config.ts`
  (`NAMES`).
- **Mapas + `for_each`** en lugar de recursos copiados: las 7 tablas, las
  unidades IoT y la red salen de estructuras de datos.
- **Tags comunes** por `default_tags` del provider (`locals.common_tags`).
- **Sin valores hardcodeados**: sufijo de buckets, mail, IP del bastión, JWT,
  rutas de bundles, unidades, tipo de instancia y cron del export son variables.
- **Nomenclatura:** recursos AWS `snowball-*`; módulos y archivos con una
  responsabilidad cada uno (`main.tf`, `variables.tf`, `outputs.tf`).

## Pipeline de GitHub Actions

`.github/workflows/terraform.yml` cubre **init, validate, plan, apply y destroy**:

| Disparador | Qué corre |
|---|---|
| `pull_request` | `validate` (fmt, init sin backend, validate), `app` (tests y build) y `plan` comentado en el PR |
| `workflow_dispatch` (*Run workflow*) | `deploy` con el input `action`: `plan`, `apply` (incluye compilar y publicar el dashboard) o `destroy` (exige escribir `DESTROY`) |

La composite action `.github/actions/terraform-setup` verifica secrets y
credenciales, genera los bundles, crea los buckets (idempotente) e inicializa
el backend remoto.

**Hay que cargar** (Settings → Secrets and variables → Actions):

- *Secrets:* `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, `AWS_SESSION_TOKEN`
  (del bloque *AWS CLI* del Learner Lab; **vencen** y hay que renovarlos en
  cada sesión) y `JWT_SECRET`.
- *Variables:* `BUCKET_SUFFIX`, `STATE_BUCKET_NAME`, `KEY_NAME`,
  `BASTION_ALLOWED_CIDR`, `SNS_SUBSCRIPTION_EMAIL`.

Si faltan, el `plan` del PR se omite con un warning (no falla) y `validate` y
`app` siguen corriendo sin credenciales. Detalle completo en la sección 13 de
[`docs/infra-terraform.md`](docs/infra-terraform.md).

## Cambios respecto a la Entrega 2

**Corrección aplicada: una sola base de datos.** La Entrega 2 usaba RDS
PostgreSQL (dominio) y DynamoDB (telemetría). Con la ingesta resuelta por IoT
Core (que escribe directo a DynamoDB) y cómputo sin estado, mantener dos bases
agregaba costo y complejidad sin beneficio: el dominio es chico, con pocos
patrones de acceso, y se resuelve con claves e índices secundarios.

**Eliminado**

- RDS PostgreSQL Multi-AZ, su DB subnet group y su configuración
  (usuario/contraseña de master, túnel SSH por bastión para aplicar el esquema).
- La capa de datos de la red: subredes `snowball-data-a/b`, tabla de ruteo
  `rt-data`, `sg-db` y la NACL `nacl-data`. La VPC pasa de tres capas a **dos**
  (pública y de aplicación); la capa de datos ahora es DynamoDB, un servicio
  gestionado fuera de la VPC al que se llega por *gateway endpoint*.
- La dependencia `pg` y las variables `PG*` en la API y el alert-processor.
- `infra/sql/schema.sql` y `seed.sql` como mecanismo de carga (se conservan como
  referencia histórica).

**Agregado**

- 5 tablas DynamoDB nuevas — `snowball-users`, `snowball-clients`,
  `snowball-units`, `snowball-alerts`, `snowball-device-config` — con GSIs para
  login por email, unidades por cliente y alertas por cliente y fecha
  (`docs/dynamodb-model.md`), y datos demo cargados por Terraform desde
  `scripts/seed-data.json`.
- Capa de repositorios DynamoDB en la API (`packages/api/src/repositories/dynamodb.ts`)
  y en el alert-processor (`thresholds.ts`). El reconocimiento de alertas usa un
  update condicional (el primer supervisor gana).
- Toda la infraestructura como código en `terraform/` (6 módulos propios + 1
  externo), con backend remoto en S3 y bloqueo nativo.
- Pipeline de GitHub Actions (init, validate, plan, apply, destroy).
- Alarma CloudWatch de «sin señal» (pendiente en la Entrega 2) sobre la cola de
  lecturas.
- Scripts para el Learner Lab: creación y borrado de buckets y exportación de
  certificados IoT.
- Bastión **opcional** (`enable_bastion`, apagado por defecto): ya no hace falta
  para aplicar un esquema SQL; queda solo para diagnóstico por SSH.

**Sin cambios**

IoT Core con regla a DynamoDB ×2 y SQS, cola SQS + DLQ, tópicos SNS,
alert-processor y API en EC2 detrás de un ALB con Auto Scaling Group, Lambda +
schedule de archivo a S3/Glacier, dashboard estático en S3, gateway endpoints de
S3 y DynamoDB, y un único NAT Gateway zonal.

## Uso de la aplicación (local)

```bash
npm install
npm test          # unit tests de los módulos
npm run build

# simulador (local; necesita certs/ — se generan con scripts/export-certs.sh)
npm run simulator -- --endpoint <xxx-ats.iot.us-east-1.amazonaws.com> \
  --units SB-001,SB-002 --interval 5 --excursion SB-001@60

# procesador de alertas (necesita SQS_QUEUE_URL, SNS_THERMAL_EXCURSION_TOPIC_ARN y DDB_*)
npm run alert-processor

# API (necesita JWT_SECRET y DDB_*; opcionales IOT_ENDPOINT, CORS_ORIGIN, PORT, LIVE_POLL_MS — ver packages/api/.env.example)
npm run api

# exportación a S3 a mano (necesita ARCHIVE_BUCKET; --date opcional, default ayer UTC)
npm run export -- --date 2026-09-06

# dashboard en modo dev (VITE_API_BASE en packages/dashboard/.env, ver .env.example)
npm run dashboard
```

Para agregar una unidad: sumar su id a `unit_ids` (Terraform crea el *thing* y
el certificado), agregar sus entradas en `scripts/seed-data.json` (`units` y
`device-config`) y volver a correr `terraform apply`.

## Autenticación

- **Máquinas**: cada unidad es un *thing* de IoT Core con certificado X.509 propio
  (mTLS) y la política `snowball-device-policy`, que con `${iot:Connection.Thing.ThingName}`
  la limita a sus tópicos. Terraform los crea (módulo `iot-ingest`) y
  `scripts/export-certs.sh` baja los certificados.
- **Personas**: `POST /auth/login` con email + contraseña (bcrypt en DynamoDB) devuelve un JWT
  HS256 de 8 h. Roles `operator < supervisor < admin`; los no-admin solo ven las unidades
  de su `client_id`. Usuarios demo en `scripts/seed-data.json`
  (`operator123` / `supervisor123` / `admin123`); nuevo hash con
  `npx tsx scripts/hash-password.ts <pass>`.
- El JWT no es revocable: desactivar un usuario desde el panel de administración no lo
  desloguea, sigue con acceso completo hasta que el token expire (hasta 8 h). Además, el
  feed en vivo (`/live`) fija el conjunto de unidades permitidas al conectar el WebSocket,
  así que mover una unidad de cliente o desactivar al usuario no corta una conexión ya
  abierta hasta que se cierre.

## Pendiente (fases siguientes)

- Alertas de batería baja (`snowball-low-battery`): el tópico existe, pero ningún
  componente publica en él todavía.
- Suscriptores para el tópico `snowball-no-signal` (la alarma se dispara y se
  ve en CloudWatch, pero no notifica a nadie).
- HTTPS de punta a punta (requiere dominio y certificado ACM).
