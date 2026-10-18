# tp-cloud — Snowball

Backend de **Snowball**, plataforma de monitoreo de cadena de frío en tiempo
real (ITBA Cloud Computing). Esta es la **Entrega 3**: la arquitectura de la
Entrega 2 desplegada con **Infraestructura como Código (Terraform)** en el AWS
Learner Lab, con las correcciones pedidas en la devolución de la entrega
anterior: **una sola base de datos, DynamoDB** (se eliminó RDS), el **procesador
de alertas en Lambda** en lugar de EC2 y el diagrama, que se está rehaciendo
(ver [Cambios respecto de la segunda entrega](#cambios-respecto-de-la-segunda-entrega)).

La ingesta MQTT la resuelve **AWS IoT Core** con reglas hacia DynamoDB y SQS;
el procesador de alertas corre en **Lambda** (consumidor de SQS) y la API en
**EC2** detrás de un ALB, sirviendo la lectura al dashboard.

```
INGESTA (máquinas)
simulator (local) ──MQTT/TLS──▶ IoT Core · regla snowball_telemetry
                                  ├─▶ DynamoDB snowball-telemetry (histórico, TTL 30 d)
                                  ├─▶ DynamoDB snowball-unit-state (última lectura por unidad)
                                  ├─▶ SQS snowball-readings ──(tras 5 recepciones)──▶ DLQ
                                  │      │ event source mapping (lotes de 10, concurrencia máx. 2)
                                  │      ▼
                                  │   Lambda snowball-alert-processor ──▶ SNS snowball-thermal-excursion ──▶ mail
                                  │      └──▶ DynamoDB (device-config, units, alerts, estado de excursión)
                                  └─▶ solo si falla una acción (error_action): CloudWatch Logs /aws/iot/snowball-iot-errors
MONITOREO
CloudWatch alarm (la cola no recibe nada en 15 min) ──▶ SNS snowball-no-signal
ARCHIVO
EventBridge Scheduler (diario 00:15 UTC) ──▶ Lambda snowball-telemetry-export ──▶ S3 snowball-archive
                                              (telemetry/aaaa/mm/dd/*.ndjson.gz ──▶ Glacier a los 90 d)
LECTURA (humanos)
dashboard (S3 snowball-dashboard) ──HTTP+JWT / WebSocket /live──▶ ALB ──▶ api (EC2, Auto Scaling Group) ──▶ DynamoDB + Device Shadow
```

Las dos rutas no se tocan: la cola es exclusiva de la Lambda
`snowball-alert-processor`; la `api` no consume SQS — lee lo que la ingesta ya
guardó, y el feed en vivo del WebSocket lo resuelve consultando DynamoDB solo
por las unidades que los dashboards conectados están mirando. La última lectura
sale de `snowball-unit-state` y el historial de `snowball-telemetry`.

## Documentación

| Documento | Para qué |
|---|---|
| [`docs/infra-terraform.md`](docs/infra-terraform.md) | **Guía vigente**: levantar todo con Terraform en el Learner Lab, paso a paso, con verificación, pipeline, destroy y troubleshooting |
| [`docs/dynamodb-model.md`](docs/dynamodb-model.md) | Modelo de tablas DynamoDB: claves, GSIs y qué consulta cubre cada uno |
| [`docs/terraform-buckets-learner-lab.md`](docs/terraform-buckets-learner-lab.md) | Por qué los buckets se crean por script y no por Terraform |
| [`docs/infra-aws-consola.md`](docs/infra-aws-consola.md) | Guía histórica de la Entrega 2 (todo a mano desde la consola, todavía con RDS y con el alert-processor en EC2). Solo se le agregó un aviso al comienzo |

## Estructura

| Ruta | Qué es | Dónde corre |
|---|---|---|
| `packages/shared` | Tipos del dominio + nombres de recursos (`NAMES`, única fuente de verdad del código; se _bundlea_ dentro de cada artefacto) | — |
| `packages/simulator` | Unidades de frío simuladas: cliente MQTT con certificado X.509, escenarios de excursión/silencio, Device Shadow | **local** |
| `packages/alert-processor` | Consumidor de SQS: máquina de estados de excursión, umbrales y alertas en DynamoDB, notificaciones SNS. Stateless (el estado de excursión vive en DynamoDB). `src/handler.ts` es el handler de Lambda; `src/index.ts` es el loop de long-polling para correrlo local (`npm run alert-processor`); ambos comparten `src/process.ts` | Lambda (event source mapping de SQS), ZIP de un solo archivo |
| `packages/api` | REST + WebSocket (`/live`) para el dashboard: login con JWT propio (`/auth`), roles operador/supervisor/admin con alcance por cliente, lectura de unidades/alertas/telemetría, acknowledgement de alertas, configuración remota vía Device Shadow y ABM de usuarios. Acceso a datos por repositorios DynamoDB. Stateless | EC2 (Auto Scaling Group), artefacto de un solo archivo |
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

# 2. Variables propias (bucket_suffix tiene que coincidir con el <sufijo> del paso 1;
#    el bucket de state NO es una variable: solo se pasa al init del paso 4)
cp terraform/terraform.tfvars.example terraform/terraform.tfvars   # y completarlo

# 3. Artefactos: bundle de la API (Terraform lo sube a S3) y ZIPs de las dos Lambdas
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
└── modules/
    ├── network/              # VPC, subredes, NAT, rutas, endpoints, security groups
    ├── data/                 # tablas DynamoDB + seed
    ├── messaging/            # SQS + DLQ, SNS, alarma «sin señal» (módulo externo)
    ├── iot-ingest/           # IoT Core: policy, things, certificados, regla + error action
    ├── compute/              # bundle de la API en S3, ALB, launch template, ASG, bastión opcional
    └── lambda-function/      # Lambda genérica + log group (se instancia 2 veces con for_each)
```

No hay directorio `terraform/bootstrap/`: los buckets (incluido el del state)
los crea `scripts/bootstrap-buckets.sh` antes del `init` (ver abajo por qué).

### Módulos

**Módulos propios** (`terraform/modules/`):

| Módulo | Responsabilidad |
|---|---|
| `network` | VPC `10.0.0.0/16`; 2 subredes públicas y 2 de aplicación (en `us-east-1a`/`us-east-1b`) derivadas con `cidrsubnet`; Internet Gateway; un NAT Gateway; tablas de ruteo; gateway endpoints de S3 y DynamoDB; security groups `sg-alb` → `sg-app` ← `sg-bastion` encadenados por referencia (ninguno abre un rango de IPs cuando puede referenciar otro grupo) |
| `data` | Las 7 tablas DynamoDB (`telemetry`, `unit-state`, `users`, `clients`, `units`, `alerts`, `device-config`) a partir de un único mapa de definiciones, con GSIs y TTL en bloques `dynamic`, y la carga de datos demo desde `scripts/seed-data.json` |
| `messaging` | Cola `snowball-readings` (visibilidad 180 s) con DLQ (5 recepciones), tópicos SNS (térmico, sin señal y batería —reservado, sin publicador—), suscripción por mail y alarma de «sin señal» |
| `iot-ingest` | Policy `snowball-device-policy` (cada dispositivo solo ve sus tópicos), thing + certificado X.509 por unidad y regla `snowball_telemetry` con acciones a DynamoDB (×2) y SQS, más `error_action` a CloudWatch Logs |
| `compute` | Subida del bundle de la API a S3, target group, ALB, launch template con user data (`templatefile`) y `tag_specifications`, Auto Scaling Group (2–4 `t3.small` por defecto, en subredes privadas) con *instance refresh* automático, y bastión opcional. Las EC2 corren **solo la API** |
| `lambda-function` | Lambda genérica (ZIP, `nodejs22.x`, `LabRole`, fuera de la VPC) con su log group. La raíz la instancia con `for_each` sobre `local.lambdas`: `telemetry-export` y `alert-processor` |

**Módulo externo** (Terraform Registry): `terraform-aws-modules/cloudwatch/aws//modules/metric-alarm`
(`~> 5.0`), usado en `messaging` para la alarma que se dispara si la cola de
lecturas no recibe mensajes durante 15 minutos.

La raíz (`main.tf`) además administra:

- como recursos *standalone* sobre los buckets ya creados, el versionado,
  cifrado, Public Access Block, lifecycle a Glacier (`archive_glacier_days`,
  90 días por defecto), website y policy pública del dashboard;
- el schedule diario `aws_scheduler_schedule.telemetry_export` (EventBridge
  Scheduler → Lambda `snowball-telemetry-export`);
- el `aws_lambda_event_source_mapping.alert_processor` (SQS
  `snowball-readings` → Lambda `snowball-alert-processor`, lotes de 10,
  `ReportBatchItemFailures`, `maximum_concurrency = 2`);
- bloques `moved` que migran el state del antiguo `module.export` a
  `module.lambda["telemetry-export"]` y al schedule de la raíz, para que un
  `apply` sobre un despliegue anterior no destruya y recree la Lambda.

> **Sin `aws_s3_bucket`.** El SCP del Learner Lab deniega
> `s3:GetBucketObjectLockConfiguration`, que el provider lee tras crear cualquier
> bucket. Por eso los cuatro buckets (state, dashboard, artifacts, archive) los
> crea `scripts/bootstrap-buckets.sh` y Terraform solo gestiona sus
> configuraciones. Detalle en `docs/terraform-buckets-learner-lab.md`.

### Variables y outputs

La referencia completa (tipo, default, descripción) está en la sección 16 de
[`docs/infra-terraform.md`](docs/infra-terraform.md). Todas las variables tienen
`description`; `vpc_cidr`, `sns_subscription_email` y `archive_glacier_days`
tienen además `validation`. Cambios de esta entrega:

- **Nuevas variables:** `cors_origin` (default `*`, para que la cátedra pueda
  usar el dashboard desde localhost u otro origen), `archive_glacier_days`
  (default `90`, mínimo `30`), `asg_min_size` / `asg_max_size` /
  `asg_desired_capacity` (defaults `2` / `4` / `2`) y `alert_lambda_zip_path`
  (ZIP de la Lambda del procesador).
- **Eliminadas:** `state_bucket_name` (el bucket de state solo se usa en
  `terraform init -backend-config`; en el CI sigue existiendo
  `TF_VAR_state_bucket_name` para el script y el `init`, pero no es una
  variable de Terraform) y `alert_bundle_path` (el procesador ya no corre en
  EC2). También se quitó el provider `random`, que no se usaba.
- **Nuevos outputs:** `dlq_url`, `sns_topic_arns`, `lambda_function_names`,
  `lambda_function_arns` y `telemetry_export_schedule_arn` (además de los que ya
  estaban: `vpc_id`, `alb_dns_name`, buckets, `iot_endpoint`, certificados,
  `table_names`, `queue_url`).

### Funciones de Terraform utilizadas

(Archivo y línea relativos a `terraform/`, verificados contra el código de esta
entrega.)

| Función | Dónde | Para qué |
|---|---|---|
| `cidrsubnet` | `modules/network/main.tf:3-6` | Deriva los CIDR de las 4 subredes a partir del CIDR de la VPC |
| `toset` | `locals.tf:22`, `main.tf:35`, `modules/network/main.tf:47,63` | Convierte listas en conjuntos para usarlas con `for_each` (unidades, buckets privados, asociaciones de subredes) |
| `jsonencode` | `main.tf:94`, `modules/iot-ingest/main.tf:8`, `modules/messaging/main.tf:9`, `modules/data/main.tf:74` | Arma la policy del bucket del dashboard, la policy de IoT, la redrive policy de SQS y los ítems del seed |
| `file` + `jsondecode` | `modules/data/main.tf:11` | Lee y parsea `scripts/seed-data.json` |
| `merge` | `modules/data/main.tf:12`, `modules/compute/main.tf:80,84` | Une los ítems del seed de distintas entidades en un único mapa; agrega `Name` a los tags comunes de instancias y volúmenes del ASG |
| `lookup` | `modules/data/main.tf:73` | Obtiene la clave de rango de una tabla solo si está definida |
| `try` | `modules/data/main.tf:44,55`, `modules/compute/outputs.tf:4` | Tolera GSIs sin rango y el bastión ausente |
| `templatefile` + `base64encode` | `modules/compute/main.tf:62` | Renderiza el user data de las EC2 con nombres de tablas, endpoint de IoT, origen CORS y secretos |
| `filemd5` | `modules/compute/main.tf:21,65` | Detecta cambios en el bundle de la API: vuelve a subirlo a S3 y, al renderizarse en el user data, genera una versión nueva del launch template que dispara el *instance refresh* |
| `filebase64sha256` | `modules/lambda-function/main.tf:10` | Detecta cambios en el ZIP de cada Lambda |
| `format` | `modules/messaging/main.tf:30` | Arma el nombre de la alarma |
| `can` + `cidrhost` | `variables.tf:30` | Validación de `vpc_cidr` (tiene que ser un CIDR IPv4 válido) |
| `can` + `regex` | `variables.tf:61` | Validación de `sns_subscription_email` |

### Meta-argumentos utilizados

| Meta-argumento | Dónde | Para qué |
|---|---|---|
| `for_each` | `main.tf:35,149`; `modules/data/main.tf:20,70`; `modules/iot-ingest/main.tf:38,42,46,51`; `modules/network/main.tf:16,47,52,57,63,69`; `modules/messaging/main.tf:13` | Una instancia por bucket privado, por Lambda (`module "lambda"` sobre `local.lambdas`), por tabla y por ítem del seed, por unidad IoT (thing + certificado + attachments), por subred, por ruta, por endpoint y por tópico SNS, sin repetir código |
| `count` | `modules/compute/main.tf:113`, `modules/messaging/main.tf:17` | Bastión opcional (`enable_bastion`) y suscripción de mail opcional |
| `depends_on` | `main.tf:103`; `modules/network/main.tf:34`; `modules/data/main.tf:75`; `modules/compute/main.tf:89`; `modules/lambda-function/main.tf:21` | Orden explícito donde Terraform no lo infiere: policy tras el website, NAT tras el IGW, seed tras las tablas, launch template tras el bundle, Lambda tras su log group (si no, una invocación temprana crearía el grupo sin retención) |
| `lifecycle` | `modules/compute/main.tf:86-88` | `create_before_destroy` en el launch template, para que su reemplazo no deje al ASG sin plantilla |

Además se usan bloques `dynamic` (`modules/data/main.tf:29-65`) para generar
atributos, GSIs y TTL a partir de datos, y bloques `moved` (`main.tf:184-195`)
para la migración de `module.export` a `module.lambda`.

A propósito **no** hay `depends_on` a nivel de módulo (por ejemplo en
`module "compute"`): difiere los `data` sources de adentro del módulo
(`aws_ami`, `aws_region`, `aws_iot_endpoint`) hasta el apply, y el launch
template cambiaría en cada plan. Las dependencias son implícitas, por los
outputs que se pasan (`module.data.table_names`, `module.iot_ingest.iot_endpoint`,
`module.messaging.queue_url`).

### Módulo externo

`terraform-aws-modules/cloudwatch/aws//modules/metric-alarm` (`~> 5.0`) en
`modules/messaging/main.tf:26-42` (fuente en la línea 27).

### DRY y convenciones

- **Una sola fuente de nombres:** `locals.tf` define los nombres de recursos y
  se pasa a los módulos; en el código TypeScript es `packages/shared/src/config.ts`
  (`NAMES`).
- **Mapas + `for_each`** en lugar de recursos copiados: las 7 tablas, las
  unidades IoT, la red y las dos Lambdas (un único módulo `lambda-function`)
  salen de estructuras de datos.
- **Tags comunes** por `default_tags` del provider (`locals.common_tags`).
- **Sin valores hardcodeados**: sufijo de buckets, mail, IP del bastión, JWT,
  origen CORS, rutas de bundles y ZIPs, unidades, tipo de instancia, tamaño del
  ASG, días hasta Glacier y cron del export son variables.
- **Nomenclatura:** recursos AWS `snowball-*`; módulos y archivos con una
  responsabilidad cada uno (`main.tf`, `variables.tf`, `outputs.tf`).

## Pipeline de GitHub Actions

`.github/workflows/terraform.yml` cubre **init, validate, plan, apply y destroy**.

### Jobs y disparadores

| Job | Corre en | Qué hace |
|---|---|---|
| `validate` | `pull_request` y `workflow_dispatch` (sin credenciales, también en forks) | `terraform fmt -check -recursive`, `init -backend=false` y `validate` sobre `terraform/` |
| `app` | `pull_request` y `workflow_dispatch` | `npm ci`, `npm run build` y `npm test` |
| `plan` | solo `pull_request` (después de `validate`) | `terraform plan` contra el state remoto, comentado (y actualizado) en el PR. **Sin efectos secundarios:** no crea buckets ni nada en AWS |
| `deploy` | solo `workflow_dispatch` (*Run workflow*, después de `validate` y `app`; `environment: learner-lab`) | Según el input `action`: `plan`; `apply` (plan → apply → compila el dashboard con la URL del ALB y lo publica en su bucket); o `destroy` (exige escribir `DESTROY` en `confirm`) |

La composite action `.github/actions/terraform-setup` verifica secrets,
variables y credenciales, genera los artefactos (`npm run bundle`: bundle de la
API y ZIPs de las dos Lambdas), crea los buckets con
`scripts/bootstrap-buckets.sh` (**solo** en `workflow_dispatch`) e inicializa
el backend remoto. `concurrency` evita dos ejecuciones simultáneas sobre el
mismo state.

### Qué pasa en cada situación

| Situación | `plan` del PR | `deploy` manual |
|---|---|---|
| Faltan secrets o variables (por ejemplo, un fork) | Warning y plan omitido: el PR queda **verde** | Falla con error |
| Credenciales del Learner Lab vencidas | Warning y plan omitido (verde) | Falla con error |
| No existe el bucket de state | Warning y plan omitido (en un PR no se crea nada) | El script lo crea (idempotente) |
| Todo en orden | Plan comentado en el PR | Ejecuta `plan` / `apply` / `destroy` |

`validate` y `app` corren siempre y son los que pueden poner un PR en rojo
(código sin formatear, Terraform inválido, tests rotos).

### Por qué el `apply` es manual

El `apply` no se dispara solo con un `push` a `main`: las credenciales del
Learner Lab son temporales y vencen a las ~4 h, así que un apply automático
fallaría casi siempre. Por eso se ejecuta a mano, justo después de cargar
credenciales frescas. (La restricción de `apply`/`destroy` a la rama `main`
quedó preparada como comentario `TODO` en el workflow, para activarla después
de verificar el apply desde la rama.)

### Cómo correrlo (cátedra)

1. En **Settings → Secrets and variables → Actions** cargar:
   - *Secrets:* `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`,
     `AWS_SESSION_TOKEN` (del bloque *AWS Details → AWS CLI* del Learner Lab;
     **vencen**, hay que pegarlos de nuevo en cada sesión) y `JWT_SECRET`.
   - *Variables:* `BUCKET_SUFFIX`, `STATE_BUCKET_NAME`, `KEY_NAME`,
     `BASTION_ALLOWED_CIDR`, `SNS_SUBSCRIPTION_EMAIL`.
2. **Actions → Terraform → Run workflow**, elegir la rama y `action: apply`.
3. El resumen del run muestra la URL de la API, la del dashboard y el endpoint
   de IoT. Confirmar la suscripción de SNS desde el mail.
4. Para destruir: `action: destroy` y `confirm: DESTROY` (los buckets se borran
   aparte con `scripts/delete-buckets.sh`).

Detalle completo en la sección 13 de
[`docs/infra-terraform.md`](docs/infra-terraform.md).

## Cambios respecto de la segunda entrega

### Respuesta a la devolución

**(a) Diagrama.** El diagrama de arquitectura se está rehaciendo en Lucid
([enlace](https://lucid.app/lucidchart/fe523039-49a4-409d-9f44-310532b4100b/edit))
siguiendo estos criterios (todavía no está actualizado).

*Criterios del diagrama actualizado:*

- **Flechas reordenadas:** solo ortogonales, un color por flujo (el mismo de la
  leyenda) y sin cruces; los flujos de IoT y de las Lambdas van por un lado y
  los de la VPC por el otro, con las etiquetas separadas de las líneas.
- **Buckets separados:** S3 aparecerá como tres buckets con sus propias flechas:
  `snowball-dashboard` (sitio estático, lectura pública: de ahí el navegador
  baja el frontend), `snowball-artifacts` (privado, versionado: las EC2 bajan el
  bundle por `vpce-s3`) y `snowball-archive` (privado, versionado, Glacier a
  los 90 días: lo escribe la Lambda de exportación).
- **Tablas de ruteo fuera del diagrama:** se quitan las cajas `rt-public`,
  `rt-app-a` y `rt-app-b` (y `rt-data`, que ya no existe). El ruteo se explica
  en [`docs/infra-terraform.md`](docs/infra-terraform.md) y está en
  `terraform/modules/network/main.tf`.
- Reflejará además los cambios de esta entrega: sin RDS ni capa de datos en la
  VPC, la Lambda `snowball-alert-processor` fuera de la VPC
  (SQS → Lambda → SNS + DynamoDB), EventBridge Scheduler → Lambda
  `snowball-telemetry-export` → S3, la *error action* de IoT a CloudWatch, la
  alarma «sin señal» y el bastión marcado como opcional.

<!-- TODO: exportar el diagrama de Lucid a docs/architecture.png y embeberlo acá:
![Arquitectura de Snowball](docs/architecture.png)
-->

**(b) ¿Hacen falta dos bases de datos? No: una sola, DynamoDB.** La Entrega 2
usaba RDS PostgreSQL para el dominio y DynamoDB para la telemetría. Con la
ingesta resuelta por IoT Core (que escribe directo a DynamoDB) y cómputo sin
estado, la segunda base agregaba costo (Multi-AZ, subredes de datos, bastión
para el esquema) sin beneficio. Los datos «relacionales» (clientes, unidades,
usuarios, alertas, configuración de dispositivos) encajan en DynamoDB porque el
dominio es chico y tiene **pocos patrones de acceso, todos conocidos**: cada uno
se resuelve con la clave primaria o con un GSI (`email-index` para el login,
`client_id-index` para las unidades de un cliente, `client_id-emitted_at-index`
para las alertas de un cliente por fecha). No hay *joins*: el `client_id` se
denormaliza en unidades y alertas, y el acknowledgement usa un update
condicional (el primer supervisor gana). Las 7 tablas se crean con un único
`for_each` en `modules/data`. Detalle de claves e índices en
[`docs/dynamodb-model.md`](docs/dynamodb-model.md).

**(c) ¿Se puede reemplazar EC2 por Lambda? En parte: el procesador de alertas
pasó a Lambda; la API sigue en EC2.**

*Por qué el alert-processor encaja en Lambda:*

- Es un consumidor puro de SQS: no atiende pedidos ni mantiene conexiones.
- Su estado (fase de excursión por unidad) y los umbrales ya vivían en
  DynamoDB, así que no pierde nada al ser efímero.
- El *event source mapping* de SQS reemplaza el loop de long-polling escrito a
  mano y trae reintentos, respuestas parciales de lote
  (`ReportBatchItemFailures`) y la DLQ (`maxReceiveCount = 5`).
- Corrige un bug real: con `min_size = 2`, las dos instancias del ASG
  consumían la cola, cada una con su propia caché en memoria del estado de
  excursión, y podían actuar sobre un estado viejo escrito por la otra. Ahora
  no hay caché: cada lectura va a DynamoDB.

*Cómo quedó:* handler `index.handler`, runtime `nodejs22.x`, ZIP
`packages/alert-processor/dist/alert-processor.zip` (lo genera
`npm run bundle`), fuera de la VPC con `LabRole`, timeout 30 s y visibilidad de
la cola 180 s (≥ 6× el timeout, como recomienda AWS). Cada lote se agrupa por
`unit_id` y se procesa en orden de `ts`; si un mensaje de una unidad falla, se
devuelven como fallidos ese y los siguientes de la misma unidad (los de otras
unidades no se ven afectados), y los mensajes que no se pueden parsear también
fallan y terminan en la DLQ. El camino de una alerta es: buscar la unidad →
`insertAlert` idempotente (id numérico determinístico, derivado de
`sha256(unit_id|since)`) → publicar en SNS → guardar el estado. SNS es
*at-least-once*: un reintento puede reenviar el mail, pero una alerta nunca se
pierde ni se duplica su fila. En el camino se corrigió otro bug: antes el
estado se guardaba **antes** de publicar, así que si SNS fallaba la alerta se
perdía, y el id `Date.now()` duplicaba filas en cada reintento.

*Por qué la API sigue en EC2:* `/live` es un servidor WebSocket que mantiene
conexiones abiertas y consulta DynamoDB periódicamente por cada cliente
conectado. Una Lambda no puede sostener una conexión. Evaluamos la alternativa
serverless — API Gateway WebSocket API + una tabla de conexiones + una Lambda de
*fan-out* disparada por DynamoDB Streams — y la descartamos: implica reescribir
`live.ts` y el cliente del dashboard sin ninguna ganancia funcional visible.

*Limitación que queda:* con `maximum_concurrency = 2` (el mínimo que permite el
*event source mapping*) y una cola SQS estándar, dos lotes con lecturas de la
misma unidad pueden procesarse a la vez y competir por el ítem `_state` de esa
unidad. La inserción de alertas es idempotente, pero las transiciones de estado
no: una invocación puede pisar el estado escrito por la otra. No se puede evitar
del todo:
la acción SQS de IoT Core no admite colas FIFO (que darían orden por unidad) y
el Learner Lab limita la concurrencia de la cuenta a ~10, lo que impide reservar
concurrencia 1. Lo mitiga el orden por `ts` dentro de cada lote y la inserción
idempotente de alertas (una carrera no duplica filas de alerta).

### Otras correcciones de esta entrega

- La regla de IoT usa CloudWatch Logs como **`error_action`** (antes era una
  acción más, que logueaba cada lectura).
- `IOT_ENDPOINT` y `CORS_ORIGIN` ahora llegan a la API por el user data (antes
  `IOT_ENDPOINT` quedaba fuera del archivo de entorno y las rutas de Device
  Shadow respondían `503`).
- Transición a Glacier a los **90 días** (antes 30), parametrizable con
  `archive_glacier_days`.
- El ASG hace *instance refresh* automático (Rolling, 50 % sanas, 120 s de
  warmup) cuando cambia el bundle de la API o el user data; el launch template
  etiqueta instancias y volúmenes (`tag_specifications`).
- Se eliminó `terraform/bootstrap/` (no creaba recursos y no podía hacerlo: el
  SCP del Lab deniega `GetBucketObjectLockConfiguration`); los buckets los crea
  `scripts/bootstrap-buckets.sh`.
- El `plan` de un PR ya no crea buckets, y no queda en rojo por credenciales
  vencidas o secrets ausentes.

### Resumen de lo eliminado, agregado y sin cambios

**Eliminado**

- RDS PostgreSQL Multi-AZ, su DB subnet group y su configuración
  (usuario/contraseña de master, túnel SSH por bastión para aplicar el esquema).
- La capa de datos de la red: subredes `snowball-data-a/b`, tabla de ruteo
  `rt-data`, `sg-db` y la NACL `nacl-data`. La VPC pasa de tres capas a **dos**
  (pública y de aplicación); la capa de datos ahora es DynamoDB, un servicio
  gestionado fuera de la VPC al que se llega por *gateway endpoint*.
- El alert-processor en EC2 (su unidad systemd, su bundle en S3 y las
  variables `SQS_QUEUE_URL` / `SNS_THERMAL_EXCURSION_TOPIC_ARN` del entorno de
  las instancias).
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
- Lambda `snowball-alert-processor` con *event source mapping* desde SQS.
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

IoT Core con regla a DynamoDB ×2 y SQS, cola SQS + DLQ, tópicos SNS, API en EC2
detrás de un ALB con Auto Scaling Group, Lambda + schedule de archivo a
S3/Glacier, dashboard estático en S3, gateway endpoints de S3 y DynamoDB, y un
único NAT Gateway zonal.

## Uso de la aplicación (local)

```bash
npm install
npm test          # unit tests de los módulos
npm run build

# simulador (local; necesita certs/ — se generan con scripts/export-certs.sh)
npm run simulator -- --endpoint <xxx-ats.iot.us-east-1.amazonaws.com> \
  --units SB-001,SB-002 --interval 5 --excursion SB-001@60

# procesador de alertas, versión local con long-polling de SQS (en AWS corre como Lambda;
# necesita SQS_QUEUE_URL, SNS_THERMAL_EXCURSION_TOPIC_ARN y DDB_*)
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

- Alertas de batería baja (`snowball-low-battery`): el tópico existe y queda
  **reservado**, pero ningún componente publica en él todavía.
- Suscriptores para el tópico `snowball-no-signal` (la alarma se dispara y se
  ve en CloudWatch, pero no notifica a nadie).
- HTTPS de punta a punta (requiere dominio y certificado ACM).
