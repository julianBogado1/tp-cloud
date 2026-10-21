# Snowball — Infraestructura como código

Snowball es un sistema de monitoreo de cadena de frío: unidades refrigeradas que
publican telemetría por MQTT, un pipeline que detecta excursiones térmicas y
silencios, y un dashboard web. Toda su infraestructura en AWS está declarada en
`terraform/`.

Este documento cubre los cuatro puntos de documentación de la entrega: módulos,
funciones y meta-argumentos, guía de ejecución y pipeline de GitHub Actions.

## Arquitectura

La arquitectura son tres flujos independientes sobre una VPC de dos zonas de
disponibilidad.

1. **Ingesta.** El simulador publica por MQTT con certificado X.509 contra IoT
   Core. Una regla SQL escribe la lectura en DynamoDB (`telemetry` y
   `unit-state`) y la encola en SQS. La Lambda `alert-processor` consume la cola,
   evalúa umbrales con una máquina de estados y publica en SNS.
2. **Monitoreo agendado.** EventBridge Scheduler dispara `no-signal-monitor`
   cada minuto (detecta unidades en silencio) y `telemetry-export` una vez por
   día (vuelca el histórico a S3, con transición a Glacier).
3. **Plano web.** El navegador baja el frontend estático de S3 y pega contra la
   API, que corre en un Auto Scaling Group detrás de un ALB.

El color de cada flecha identifica el flujo: gris los datos de la aplicación,
verde las reglas de IoT Core, naranja las invocaciones de Lambda, rosa las
alertas, violeta punteado la salida a Internet por el NAT y magenta punteado la
réplica del sitio estático.

![Arquitectura de Snowball](docs/Snowball%20Arquitectura.png)

## Módulos

Un módulo es un directorio de configuración de Terraform que se invoca con un
bloque `module` y se parametriza con variables. El repo tiene seis módulos
propios y uno externo del Registry.

| Módulo | Qué crea |
|---|---|
| `network` | VPC `10.0.0.0/16`, 2 subredes públicas y 2 de aplicación derivadas con `cidrsubnet`, IGW, un NAT Gateway, tablas de ruteo, gateway endpoints de S3 y DynamoDB, y los security groups `sg-alb` → `sg-app` ← `sg-bastion` encadenados por referencia entre grupos |
| `data` | Las 7 tablas DynamoDB a partir de un único mapa de definiciones, con atributos, GSIs y TTL generados en bloques `dynamic`, más la carga de datos demo |
| `messaging` | Cola `snowball-readings` (visibilidad 180 s) con DLQ a las 5 recepciones, tres tópicos SNS, suscripción por mail a los dos tópicos con publicador y la alarma de flota «sin señal» |
| `iot-ingest` | Policy por dispositivo (cada thing solo accede a sus tópicos), thing y certificado por unidad, y la regla `snowball_telemetry` con tres acciones y `error_action` a CloudWatch Logs |
| `compute` | Subida del bundle de la API a S3, target group, ALB, launch template con user data renderizado, Auto Scaling Group (2–4 `t3.small` en subredes privadas) y bastión opcional |
| `lambda-function` | Lambda genérica (ZIP, `nodejs22.x`, `LabRole`, fuera de la VPC) con su log group. El root la instancia tres veces con `for_each` sobre `local.lambdas` |

`lambda-function` es el módulo reutilizable: una sola definición cubre
`telemetry-export`, `alert-processor` y `no-signal-monitor`, que difieren solo en
handler, ZIP, timeout y environment (`terraform/main.tf:207`).

El root (`terraform/main.tf`) no crea recursos de red ni de datos. Compone los
módulos y administra lo que es transversal: las configuraciones de los buckets,
los dos schedules de EventBridge y el event source mapping de SQS a Lambda.

### Módulo externo

El módulo externo es `terraform-aws-modules/cloudwatch/aws//modules/metric-alarm`,
pinneado a `~> 5.0`. Se invoca desde `terraform/modules/messaging/main.tf:36-52`
para la alarma que se dispara si la cola de lecturas no recibe mensajes durante
15 minutos. La restricción `>= 5.81.0` que aporta quedó registrada en
`terraform/.terraform.lock.hcl`, con los hashes de las dos plataformas.

## Variables y outputs

Las variables son la entrada del root module y los outputs su salida. Hay 29
variables en `terraform/variables.tf` y 21 outputs en `terraform/outputs.tf`.

Cinco variables no tienen default y son obligatorias:

| Variable | Qué poner |
|---|---|
| `bucket_suffix` | Sufijo único global de los buckets; tiene que coincidir con el que se le pasa a `bootstrap-buckets.sh` |
| `key_name` | Key pair de EC2 existente (en el Learner Lab, `vockey`) |
| `jwt_secret` | Secreto de firma de los JWT de la API (`openssl rand -base64 32`); declarado `sensitive` |
| `sns_subscription_email` | Mail de las alertas; la suscripción hay que confirmarla desde ese mail |
| `bastion_allowed_cidr` | CIDR autorizado a SSH. Es obligatoria aun con `enable_bastion = false`: el security group se crea igual |

Si falta alguna, `plan` la pide por prompt en vez de fallar.

Cinco variables tienen `validation`, que corta el plan con un mensaje explícito
en vez de dejar que falle la API de AWS: `dashboard_replica_region`
(`variables.tf:10`, el Lab solo habilita dos regiones), `vpc_cidr` (`:38`),
`sns_subscription_email` (`:69`), `no_signal_timeout_min` (`:144`, mínimo 1) y
`archive_glacier_days` (`:153`, mínimo 30).

Los outputs no son decorativos: la guía de ejecución los consume. El paso 5 lee
`alb_dns_name`, `dashboard_bucket`, `dashboard_replica_bucket` y las dos URLs
del sitio; el paso 6 lee `iot_endpoint`. El bucket del state no es una variable:
se pasa al `init` por `-backend-config`.

## Funciones

Las funciones son expresiones integradas de HCL que transforman valores en
tiempo de plan. Se usan 19 distintas. Archivo y línea relativos a `terraform/`.

| Función | Dónde | Para qué |
|---|---|---|
| `cidrsubnet` | `modules/network/main.tf:3-6` | Deriva los CIDR de las 4 subredes del CIDR de la VPC |
| `toset` | `locals.tf:22`, `main.tf:35`, `modules/messaging/main.tf:20`, `modules/network/main.tf:47,63` | Convierte listas en conjuntos para `for_each`, para que la clave sea el valor y no el índice |
| `jsonencode` | `main.tf:94,151`, `modules/iot-ingest/main.tf:8`, `modules/messaging/main.tf:9`, `modules/data/main.tf:74` | Policies de los dos buckets del dashboard, policy de IoT, redrive policy de SQS e ítems del seed |
| `file` + `jsondecode` | `modules/data/main.tf:11` | Lee y parsea `scripts/seed-data.json` |
| `merge` | `modules/data/main.tf:12`, `modules/compute/main.tf:80,84` | Une los ítems del seed en un mapa único; agrega `Name` a los tags del ASG |
| `lookup` | `modules/data/main.tf:73` | Toma la clave de rango de una tabla solo si está definida |
| `try` | `modules/data/main.tf:44,55`, `modules/compute/outputs.tf:4` | Tolera GSIs sin rango y el bastión ausente |
| `templatefile` + `base64encode` | `modules/compute/main.tf:62` | Renderiza el user data con nombres de tablas, endpoint de IoT, origen CORS y secretos |
| `filemd5` | `modules/compute/main.tf:21,65` | Detecta el cambio del bundle: lo vuelve a subir y genera una versión nueva del launch template |
| `filebase64sha256` | `modules/lambda-function/main.tf:10` | Detecta el cambio del ZIP de cada Lambda |
| `format` | `modules/messaging/main.tf:40` | Arma el nombre de la alarma |
| `tostring` | `locals.tf:70` | Pasa un número al environment de la Lambda, que solo acepta strings |
| `join` + `for` | `outputs.tf:35` | Devuelve `""` cuando la réplica está apagada, sin indexar `[0]` sobre una lista vacía |
| `can` + `cidrhost` | `variables.tf:39` | Valida que `vpc_cidr` sea un CIDR IPv4 usable |
| `can` + `regex` | `variables.tf:70` | Valida el formato del mail de SNS |
| `contains` | `variables.tf:11` | Valida la región de la réplica contra la lista habilitada |

`floor()` y `timestamp()` aparecen en `modules/iot-ingest/main.tf:62`, pero son
SQL de IoT Core dentro de un string: no son funciones de Terraform.

## Meta-argumentos

Los meta-argumentos son argumentos que Terraform interpreta sobre cualquier
recurso o módulo, sin pasarlos al provider. Se usan los cuatro.

| Meta-argumento | Dónde | Para qué |
|---|---|---|
| `for_each` | `main.tf:35,209`; `modules/data/main.tf:20,70`; `modules/iot-ingest/main.tf:38,42,46,51`; `modules/network/main.tf:16,47,52,57,63,69`; `modules/messaging/main.tf:14,20` | Una instancia por bucket privado, por Lambda, por tabla y por ítem del seed, por unidad IoT, por subred, por ruta, por endpoint, por tópico y por suscripción |
| `count` | `main.tf:120,131,141,148`; `modules/compute/main.tf:111` | Interruptor de la réplica del dashboard (las 4 configuraciones quedan en 0 con `dashboard_replica_region = ""`) y bastión opcional |
| `depends_on` | `main.tf:105,160`; `modules/network/main.tf:34`; `modules/data/main.tf:75`; `modules/compute/main.tf:89`; `modules/lambda-function/main.tf:21` | Orden que Terraform no infiere: policies tras el website y el Public Access Block, NAT tras el IGW, seed tras las tablas, launch template tras el bundle, y Lambda tras su log group (si no, una invocación temprana lo crearía sin retención) |
| `lifecycle` | `modules/compute/main.tf:86-88` | `create_before_destroy` en el launch template, para que su reemplazo no deje al ASG sin plantilla |

A propósito no hay `depends_on` a nivel de módulo. Puesto sobre
`module "compute"` diferiría los `data` sources de adentro (`aws_ami`,
`aws_region`, `aws_iot_endpoint`) hasta el apply, y el launch template
aparecería como modificado en cada plan. Las dependencias entre módulos son
implícitas, por los outputs que se pasan: `module.data.table_names`,
`module.iot_ingest.iot_endpoint`, `module.messaging.queue_url`.

También hay bloques `dynamic` (`modules/data/main.tf:29-65`) para generar
atributos, GSIs y TTL desde datos, y bloques `moved` (`main.tf:260-271`,
`modules/messaging/main.tf:28-31`) para que un apply sobre un despliegue
anterior migre el state en vez de destruir y recrear.

## DRY

Las convenciones que evitan la duplicación son cuatro.

- **Nombres en un solo lugar.** `terraform/locals.tf` define los nombres de
  recursos y los pasa a los módulos. El código TypeScript tiene su equivalente
  en `packages/shared/src/config.ts` (`NAMES`).
- **Mapas más `for_each`** en lugar de recursos copiados: las 7 tablas, las
  unidades IoT, la red y las 3 Lambdas salen de estructuras de datos.
- **Tags comunes** por `default_tags` del provider, desde `local.common_tags`.
- **Un archivo por responsabilidad** en cada módulo: `main.tf`, `variables.tf`,
  `outputs.tf`. Recursos AWS con prefijo `snowball-`.

## Ejecución paso a paso

El orden importa en dos puntos: los buckets existen antes del `init` (el backend
es uno de ellos) y los artefactos existen antes del `plan` (`filemd5` y
`filebase64sha256` fallan si el archivo no está). Con el Lab iniciado y las
credenciales de **AWS Details → AWS CLI** en `~/.aws/credentials`:

```bash
npm ci

# 1. Buckets. Los crea la CLI, no Terraform (ver Limitaciones).
#    DASHBOARD_REPLICA_REGION tiene que coincidir con dashboard_replica_region del paso 2.
DASHBOARD_REPLICA_REGION=us-west-2 bash scripts/bootstrap-buckets.sh <sufijo> <bucket-de-state>

# 2. Variables. bucket_suffix tiene que coincidir con el <sufijo> del paso 1.
cp terraform/terraform.tfvars.example terraform/terraform.tfvars   # y completar las 5 obligatorias

# 3. Artefactos: bundle de la API y ZIPs de las tres Lambdas.
npm run bundle

# 4. Terraform.
terraform -chdir=terraform init \
  -backend-config="bucket=<bucket-de-state>" \
  -backend-config="key=snowball/terraform.tfstate" \
  -backend-config="region=us-east-1"
terraform -chdir=terraform validate
terraform -chdir=terraform plan
terraform -chdir=terraform apply

# 5. Dashboard. Necesita el DNS del ALB, que existe solo después del apply.
ALB=$(terraform -chdir=terraform output -raw alb_dns_name)
BUCKET=$(terraform -chdir=terraform output -raw dashboard_bucket)
REPLICA=$(terraform -chdir=terraform output -raw dashboard_replica_bucket)
VITE_API_BASE="http://${ALB}" npm run build -w @snowball/dashboard
aws s3 sync packages/dashboard/dist/ "s3://${BUCKET}/" --delete --region us-east-1
[ -n "${REPLICA}" ] && aws s3 sync packages/dashboard/dist/ "s3://${REPLICA}/" --delete \
  --region "$(terraform -chdir=terraform output -raw dashboard_replica_region)"
terraform -chdir=terraform output -raw dashboard_url; echo
terraform -chdir=terraform output -raw dashboard_replica_url; echo

# 6. Device Shadows: copia setpoint y umbrales al desired de cada unidad. Idempotente.
npx tsx scripts/sync-shadows.ts --endpoint "$(terraform -chdir=terraform output -raw iot_endpoint)"

# 7. Certificados y simulador.
bash scripts/export-certs.sh
npm run simulator -- --endpoint "$(terraform -chdir=terraform output -raw iot_endpoint)" \
  --units SB-001,SB-002,SB-003 --interval 5 --excursion SB-001@60

# 8. Al terminar la sesión.
terraform -chdir=terraform destroy
DASHBOARD_REPLICA_REGION=us-west-2 bash scripts/delete-buckets.sh <sufijo> <bucket-de-state>
```

Dos cosas quedan fuera del `apply` y hay que hacerlas a mano: confirmar la
suscripción de SNS desde el mail, y correr `delete-buckets.sh` **con**
`DASHBOARD_REPLICA_REGION` en el paso 8. Sin esa variable el bucket réplica
queda huérfano y, como los nombres de bucket son globales, el nombre queda
tomado para la próxima sesión del Lab.

El backend usa el bloqueo nativo de S3 (`use_lockfile = true`, Terraform ≥ 1.10),
que reemplaza a la tabla DynamoDB del patrón clásico. Versión mínima declarada:
1.10.0.

La guía larga, con la salida esperada de cada comando y los errores conocidos,
está en [`docs/infra-terraform.md`](docs/infra-terraform.md).

## Pipeline de GitHub Actions

El pipeline es `.github/workflows/terraform.yml` y cubre los cuatro comandos
pedidos: `init`, `validate`, `plan` y `apply` (más `destroy`).

| Job | Dispara en | Qué corre |
|---|---|---|
| `validate` | `pull_request`, `workflow_dispatch` | `fmt -check -recursive -diff` (`:73`), `init -backend=false` y `validate` (`:77-78`). Sin credenciales, así que también corre en forks |
| `app` | `pull_request`, `workflow_dispatch` | `npm ci`, `npm run build`, `npm test` |
| `plan` | `pull_request` | `terraform plan` contra el state remoto (`:115`) y comentario idempotente en el PR. No crea nada en AWS |
| `deploy` | `workflow_dispatch` | Según el input `action`: `plan`, `apply` (`:168-171`) o `destroy` (`:210`, exige escribir `DESTROY`). Tras el apply compila el dashboard con la URL del ALB y lo publica en los dos buckets |

El `init` contra el backend real vive en la composite action
`.github/actions/terraform-setup` (`:97-105`), que además verifica secrets y
credenciales, corre `npm run bundle` y crea los buckets con
`bootstrap-buckets.sh` — esto último solo en `workflow_dispatch`. Terraform está
pinneado a 1.10.5. `concurrency` (`:23-25`) evita dos ejecuciones simultáneas
sobre el mismo state. Los permisos del token son `contents: read`, con
`pull-requests: write` solo en el job que comenta el plan.

### Cómo correrlo

1. En **Settings → Secrets and variables → Actions** cargar los secrets
   `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, `AWS_SESSION_TOKEN` y
   `JWT_SECRET`, y las variables `BUCKET_SUFFIX`, `STATE_BUCKET_NAME`,
   `KEY_NAME`, `BASTION_ALLOWED_CIDR`, `SNS_SUBSCRIPTION_EMAIL`. Las tres
   credenciales vencen con la sesión del Lab y hay que volver a pegarlas.
2. **Actions → Terraform → Run workflow**, elegir rama y `action: apply`.
3. El resumen del run deja la URL de la API, las dos del dashboard y el endpoint
   de IoT. Confirmar la suscripción de SNS.
4. Para destruir: `action: destroy` con `confirm: DESTROY`, y después
   `delete-buckets.sh` como en el paso 8 de la guía.

### Por qué el apply es manual

No hay trigger en `push`: las credenciales del Learner Lab vencen a las ~4 h, así
que un apply automático en merge fallaría casi siempre. Se dispara a mano justo
después de cargar credenciales frescas. La restricción de `apply` y `destroy` a
`main` está escrita como comentario en `terraform.yml:145`, pendiente de
activar.

### Un PR verde no significa que el plan corrió

El job `plan` sale en verde en dos casos distintos y hay que mirar los steps para
distinguirlos. Si el step *terraform plan* corrió, hay un comentario con el plan
en el PR. Si figura como `skipped`, el resumen del run tiene un `::warning` con
el motivo: faltan secrets o variables, las credenciales vencieron, o el bucket
de state todavía no existe. El gate está en
`.github/actions/terraform-setup/action.yml:25-65` y hace `exit 0` a propósito:
un PR no debería quedar en rojo por credenciales temporales ni por correr en un
fork, donde GitHub no entrega secrets.

La consecuencia práctica es el orden: el primer plan de PR se ejecuta de verdad
solo después de un `workflow_dispatch` con `action: apply`, que es el que crea
el bucket de state.

## Limitaciones impuestas por el Learner Lab

Tres decisiones del código no son preferencias de diseño: son restricciones del
entorno.

**No existe ningún `aws_s3_bucket`.** El SCP del Lab deniega
`s3:GetBucketObjectLockConfiguration`, que el provider lee después de crear
cualquier bucket, así que el recurso falla aunque el bucket quede creado. Los
cinco buckets los crea `scripts/bootstrap-buckets.sh` y Terraform gestiona sus
configuraciones (versionado, cifrado, Public Access Block, lifecycle a Glacier,
website, policy) como recursos standalone. Los defaults del script coinciden con
los de Terraform, así que los nombres no se desalinean. Detalle en
[`docs/terraform-buckets-learner-lab.md`](docs/terraform-buckets-learner-lab.md).

**El ASG no tiene `instance_refresh`.** El SCP deniega
`autoscaling:StartInstanceRefresh` y el provider llama a esa acción en cada
cambio del grupo, así que con el bloque presente todo `apply` terminaba en
`AccessDenied` (`terraform/modules/compute/main.tf:103-108`). Un bundle nuevo no
llega solo a las instancias en ejecución: el `apply` sube el artefacto y crea la
versión nueva del launch template, y hay que terminar las instancias de a una
para que el grupo las reponga, esperando que cada una quede `healthy` en el
target group antes de seguir. El procedimiento, con los comandos, está en la
sección 14 de [`docs/infra-terraform.md`](docs/infra-terraform.md#14-redesplegar-cambios).
Las Lambdas no tienen este problema: `filebase64sha256` sobre el ZIP hace que el
`apply` publique el código nuevo.

**Sin OIDC.** El Lab no permite crear el rol de confianza, así que el pipeline
autentica con `AWS_SESSION_TOKEN` cargado en secrets.
