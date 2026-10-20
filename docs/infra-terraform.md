# Snowball — Guía de despliegue con Terraform (AWS Learner Lab)

Esta guía levanta **toda** la infraestructura de Snowball con Terraform en el
AWS Learner Lab, de punta a punta: desde instalar las herramientas hasta
destruir todo al terminar la sesión. Está pensada para que cualquier persona
(incluida la cátedra) pueda reproducir el entorno sin conocer el proyecto.

> **Relación con la otra guía.** `docs/infra-aws-consola.md` es la guía
> **histórica de la Entrega 2**: crea todo a mano desde la consola y todavía
> incluye RDS y el alert-processor en EC2 (solo se le agregó un aviso al
> comienzo). Esta guía es la vigente: reemplaza los clics por Terraform,
> elimina RDS (toda la persistencia vive en DynamoDB) y corre el procesador de
> alertas en Lambda.

## Índice

1. [Qué se construye](#1-qué-se-construye)
2. [Prerrequisitos](#2-prerrequisitos)
3. [Credenciales del Learner Lab](#3-credenciales-del-learner-lab)
4. [Preparar el repositorio](#4-preparar-el-repositorio)
5. [Crear los buckets (paso previo a Terraform)](#5-crear-los-buckets-paso-previo-a-terraform)
6. [Configurar `terraform.tfvars`](#6-configurar-terraformtfvars)
7. [Generar los bundles](#7-generar-los-bundles)
8. [`init`, `validate` y `plan`](#8-init-validate-y-plan)
9. [`apply`](#9-apply)
10. [Después del apply](#10-después-del-apply)
11. [Certificados y simulador](#11-certificados-y-simulador)
12. [Verificación end-to-end](#12-verificación-end-to-end)
13. [Pipeline de GitHub Actions](#13-pipeline-de-github-actions)
14. [Redesplegar cambios](#14-redesplegar-cambios)
15. [Destruir todo y costos](#15-destruir-todo-y-costos)
16. [Referencia: módulos, variables y outputs](#16-referencia-módulos-variables-y-outputs)
17. [Limitaciones conocidas](#17-limitaciones-conocidas)
18. [Troubleshooting](#18-troubleshooting)

---

## 1. Qué se construye

Dos rutas que no se tocan:

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
EventBridge Scheduler (rate(1 minute)) ──▶ Lambda snowball-no-signal-monitor (barrido por unidad)
                                             ├─▶ DynamoDB (units, unit-state, device-config, alerts, ítem _signal)
                                             └─▶ SNS snowball-no-signal ──▶ mail
CloudWatch alarm (la cola no recibe nada en 15 min) ──▶ SNS snowball-no-signal ──▶ mail

ARCHIVO
EventBridge Scheduler (diario 00:15 UTC) ──▶ Lambda snowball-telemetry-export ──▶ S3 snowball-archive
                                              (telemetry/aaaa/mm/dd/*.ndjson.gz ──▶ Glacier a los 90 d)

LECTURA (humanos)
dashboard (S3 snowball-dashboard) ──HTTP+JWT / WebSocket /live──▶ ALB ──▶ api (EC2, ASG) ──▶ DynamoDB + Device Shadow
```

Dónde corre cada cosa respecto de la VPC:

```
VPC 10.0.0.0/16 (us-east-1a / us-east-1b)
├── subredes públicas   snowball-public-a/b : ALB, NAT Gateway (solo en -a), bastión opcional
└── subredes privadas   snowball-app-a/b    : EC2 del ASG (solo la API: REST + WebSocket /live)
        ├── vpce-s3  (gateway) ──▶ S3 snowball-artifacts (bundle de la API)
        ├── vpce-ddb (gateway) ──▶ DynamoDB
        └── NAT ──▶ IoT Core (Device Shadow) y resto de Internet

Fuera de la VPC (servicios gestionados, endpoints públicos, LabRole)
IoT Core · SQS + DLQ · SNS · DynamoDB · S3 · EventBridge Scheduler
Lambda snowball-alert-processor · Lambda snowball-telemetry-export
Lambda snowball-no-signal-monitor
```

Las tablas de ruteo no se dibujan en el diagrama de arquitectura; quedan
documentadas acá: `rt-public` (subredes públicas, `0.0.0.0/0` → Internet
Gateway) y `rt-app-a` / `rt-app-b` (subredes privadas, `0.0.0.0/0` → NAT
Gateway, más las rutas que agregan los gateway endpoints de S3 y DynamoDB).

### Una sola base de datos

Toda la persistencia vive en **DynamoDB** (la Entrega 2 tenía además RDS
PostgreSQL). Los datos de dominio —clientes, unidades, usuarios, alertas y
configuración de dispositivos— son pocos y con patrones de acceso conocidos,
así que cada consulta se resuelve con la clave primaria o un GSI
(`email-index`, `client_id-index`, `client_id-emitted_at-index`), sin *joins*:
el `client_id` se denormaliza en unidades y alertas. El modelo completo está en
[`docs/dynamodb-model.md`](dynamodb-model.md).

### EC2 o Lambda

- **Procesador de alertas → Lambda** (`snowball-alert-processor`). Es un
  consumidor puro de SQS, su estado ya vive en DynamoDB, y el *event source
  mapping* le da reintentos, respuestas parciales de lote y la DLQ. Además
  elimina la carrera que había con dos instancias del ASG consumiendo la cola,
  cada una con su caché en memoria del estado de excursión.
- **Monitor de «sin señal» → Lambda agendada** (`snowball-no-signal-monitor`).
  Todo el pipeline de alertas es *event-driven* por lectura entrante, y la
  ausencia de datos, por definición, no genera ningún evento: hace falta algo
  que se despierte por tiempo. La alternativa —una alarma de CloudWatch por
  unidad— exigiría publicar una métrica custom con dimensión `unit_id` en cada
  lectura y declarar N alarmas con `for_each = var.unit_ids`, lo que rompe el
  requisito de escalar de 10 a 1.000 dispositivos sin rediseño (1.000 alarmas y
  1.000 métricas custom) y es caro en cuota del Lab. Se descartó a propósito.
- **API → EC2** (ASG detrás del ALB). `/live` es un servidor WebSocket que
  mantiene conexiones abiertas y consulta DynamoDB por cada cliente conectado;
  una Lambda no puede sostenerlas. La alternativa serverless (API Gateway
  WebSocket API + tabla de conexiones + Lambda de *fan-out* por DynamoDB
  Streams) se evaluó y se descartó: es una reescritura sin ganancia funcional.

El razonamiento completo, y la limitación de concurrencia que queda, están en
el `README.md` (sección *Cambios respecto de la segunda entrega*) y en las
[limitaciones](#17-limitaciones-conocidas).

Recursos que crea Terraform (resumen; el detalle por módulo está en la
[sección 16](#16-referencia-módulos-variables-y-outputs)):

- **Red:** VPC `10.0.0.0/16`, 2 subredes públicas y 2 de aplicación en
  `us-east-1a`/`us-east-1b`, Internet Gateway, NAT Gateway (uno solo, zonal),
  tablas de ruteo, gateway endpoints de S3 y DynamoDB, security groups
  encadenados (`sg-alb`, `sg-app`, `sg-bastion`).
- **Datos:** 7 tablas DynamoDB (`telemetry`, `unit-state`, `users`, `clients`,
  `units`, `alerts`, `device-config`) con sus GSIs y los datos demo (seed).
- **Mensajería:** cola SQS + DLQ, 3 tópicos SNS (térmico, sin señal y batería,
  este último reservado y sin publicador), suscripción por mail a los dos
  tópicos que tienen publicador (excursión térmica y sin señal), alarma
  CloudWatch de flota de «sin señal».
- **IoT Core:** policy de dispositivos, un *thing* + certificado por unidad y
  la regla `snowball_telemetry` (3 acciones + `error_action` a CloudWatch Logs).
- **Cómputo:** ALB, target group, launch template y Auto Scaling Group (2–4
  `t3.small` por defecto, en subredes privadas, con *instance refresh*). Las
  instancias corren solo la API. Bastión opcional.
- **Lambdas:** `snowball-alert-processor` (con *event source mapping* desde
  SQS), `snowball-telemetry-export` (con schedule diario en EventBridge
  Scheduler) y `snowball-no-signal-monitor` (con schedule cada minuto en
  EventBridge Scheduler), las tres del módulo genérico `lambda-function`.
- **S3:** configuración de los buckets de dashboard, artifacts y archive, y
  subida del bundle de la API.

**Lo que NO crea Terraform:** los cuatro buckets en sí (state, dashboard,
artifacts, archive). Los crea un script de AWS CLI, por una restricción del
Learner Lab (ver [sección 5](#5-crear-los-buckets-paso-previo-a-terraform)).
Tampoco se crean roles IAM: el Lab no lo permite, y Terraform usa `LabRole` y
`LabInstanceProfile` (los busca con `data` sources).

---

## 2. Prerrequisitos

| Herramienta | Versión | Para qué | Verificar |
|---|---|---|---|
| Terraform | **>= 1.10** (el pipeline usa 1.10.5) | Necesario por `use_lockfile` del backend S3 | `terraform version` |
| Node.js | **22** | Tests, build y bundles (el pipeline usa 22) | `node -v` |
| npm | el que trae Node | Instalar dependencias | `npm -v` |
| AWS CLI | v2 | Scripts de buckets y verificaciones | `aws --version` |
| Bash | Git Bash en Windows; cualquier bash en Linux/Mac | Scripts de `scripts/` | `bash --version` |
| Git | cualquiera | Clonar el repo | `git --version` |

Notas:

- **En Windows usá siempre Git Bash** para los comandos de esta guía (no
  PowerShell ni CMD). Los scripts son bash y las rutas se resuelven distinto.
- **No hace falta `jq`.** Los scripts usan Node para procesar JSON.
- Necesitás acceso al **AWS Learner Lab** (AWS Academy) y que el key pair
  **`vockey`** exista (viene por defecto en el Lab).

---

## 3. Credenciales del Learner Lab

El Lab entrega credenciales **temporales** con tres valores: access key, secret
key y **session token**. Terraform y la AWS CLI las leen de
`~/.aws/credentials`.

1. En AWS Academy abrí el curso → **Learner Lab** → **Start Lab**. Esperá a que
   el círculo junto a «AWS» se ponga **verde**.
2. Tocá **AWS Details** → junto a «AWS CLI» tocá **Show**. Aparece un bloque que
   empieza con `[default]`.
3. Copialo **entero** y pegalo como contenido del archivo de credenciales,
   reemplazando lo que hubiera:
   - Linux/Mac/Git Bash: `~/.aws/credentials`
   - Windows: `C:\Users\<tu-usuario>\.aws\credentials`

   Si la carpeta `.aws` o el archivo no existen, crealos (el archivo se llama
   exactamente `credentials`, sin extensión). Desde VS Code:
   ```bash
   mkdir -p ~/.aws
   code ~/.aws/credentials
   ```
4. Verificá:
   ```bash
   aws sts get-caller-identity
   ```
   Debe devolver un ARN con `assumed-role/voclabs/...`. Si dice
   `ExpiredToken` o `InvalidClientTokenId`, repetí el paso 2.

**Cada vez que hagas Start Lab, las credenciales cambian** y hay que volver a
pegarlas. Duran unas horas: si se vencen en medio de un `apply`, el comando
falla; renová las credenciales y volvé a correrlo (Terraform retoma donde
quedó).

Alternativa sin archivo: exportar `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY` y
`AWS_SESSION_TOKEN` en la terminal. Nunca van en ningún archivo del repo.

---

## 4. Preparar el repositorio

```bash
git clone <url-del-repo> tp-cloud
cd tp-cloud
git checkout <branch>        # la rama que se esté evaluando
npm ci                       # instala dependencias de todos los paquetes
```

Si querés confirmar que la aplicación está sana antes de desplegar:

```bash
npm test
npm run build
```

---

## 5. Crear los buckets (paso previo a Terraform)

### Por qué un script y no Terraform

El Learner Lab aplica una política de organización (SCP) que **deniega**
`s3:GetBucketObjectLockConfiguration`. El recurso `aws_s3_bucket` de Terraform
crea el bucket y *después lo lee* para completar el state, y esa lectura incluye
Object Lock: falla con `explicit deny in a service control policy`, deja el
bucket creado pero el recurso en error, y vuelve a fallar en cada `plan`.
Por eso **Terraform nunca declara el recurso `aws_s3_bucket`**: los buckets se
crean por CLI (que no consulta Object Lock) y Terraform administra solamente
las configuraciones *standalone* encima de ellos.

### Quién es dueño de qué

| Bucket | Lo crea | Lo configura |
|---|---|---|
| `snowball-tfstate-<sufijo>` (state remoto) | el script | **el script**: versionado, cifrado SSE-S3 y Public Access Block total |
| `snowball-dashboard-<sufijo>` (sitio estático) | el script | **Terraform**: cifrado, Public Access Block abierto, website, policy pública de lectura |
| `snowball-artifacts-<sufijo>` (bundles de despliegue) | el script | **Terraform**: versionado, cifrado, Public Access Block total |
| `snowball-archive-<sufijo>` (archivo histórico) | el script | **Terraform**: versionado, cifrado, Public Access Block total, lifecycle a Glacier |

Cada configuración tiene un solo dueño para que no se pisen.

### Elegir el sufijo

Los nombres de bucket son **globales en todo AWS**. Elegí un sufijo propio
(`grupo-01` es solo un ejemplo; si alguien ya lo usó, el script falla con
`BucketAlreadyExists`). Reglas de S3: minúsculas, números y guiones, 3–63
caracteres, sin guiones bajos. Anotá dos valores, los vas a usar varias veces:

- **sufijo** → ej. `grupo-01`
- **nombre del bucket de state** → ej. `snowball-tfstate-grupo-01`

### Correr el script

Desde la raíz del repo:

```bash
bash scripts/bootstrap-buckets.sh grupo-01 snowball-tfstate-grupo-01
aws s3 ls
```

Debe imprimir `Creating bucket: ...` por cada uno (o `Bucket already exists`
si ya existían; el script es idempotente) y `aws s3 ls` debe listar los cuatro.
Para confirmar que el bucket de state quedó bien configurado:

```bash
aws s3api get-bucket-versioning --bucket snowball-tfstate-grupo-01   # "Status": "Enabled"
aws s3api get-bucket-encryption --bucket snowball-tfstate-grupo-01   # SSEAlgorithm: AES256
```

No hay un stack de Terraform para este paso (en entregas anteriores existía
`terraform/bootstrap/`, pero no creaba recursos ni podía hacerlo por el mismo
SCP; se eliminó). El bucket de state **se reutiliza entre sesiones**: se crea
una vez y no se borra al destruir.

---

## 6. Configurar `terraform.tfvars`

`terraform.tfvars.example` es una plantilla **commiteada** con valores de
relleno; `terraform.tfvars` es tu copia con valores reales y está en
`.gitignore` (nunca se sube).

```bash
cp terraform/terraform.tfvars.example terraform/terraform.tfvars
```

Abrí `terraform/terraform.tfvars` y completá:

| Variable | Qué poner | Cómo obtenerlo |
|---|---|---|
| `bucket_suffix` | El sufijo del paso 5 | — |
| `key_name` | `vockey` | Key pair que trae el Lab |
| `bastion_allowed_cidr` | Tu IP pública con `/32` | `curl ifconfig.me` → ej. `190.1.2.3/32`. **Es obligatoria aunque el bastión esté apagado** (se usa en una regla del security group) |
| `sns_subscription_email` | Tu mail real | Te llega un correo de confirmación |
| `jwt_secret` | Clave aleatoria larga (≥ 32 caracteres) | `openssl rand -base64 32` |

Ejemplo completo:

```hcl
region                 = "us-east-1"
bucket_suffix          = "grupo-01"
bastion_allowed_cidr   = "190.1.2.3/32"
key_name               = "vockey"
jwt_secret             = "<salida de openssl rand -base64 32>"
sns_subscription_email = "tu-mail@itba.edu.ar"
# cors_origin = "http://localhost:5173"   # por defecto "*"
# enable_bastion = true        # descomentá para crear el bastión
# ami_id = "ami-xxxxxxxx"      # por defecto usa la última Amazon Linux 2023
```

El **bucket de state no es una variable de Terraform**: solo se usa en el
`terraform init -backend-config="bucket=..."` (sección 8.1).

Todas las variables, incluidas las opcionales, están en la
[sección 16](#16-referencia-módulos-variables-y-outputs).

> **El sufijo del paso 5 tiene que ser idéntico al `bucket_suffix` de
> `terraform.tfvars`, y el nombre del state al que pases en el `init`.** Si no
> coinciden, el script crea unos buckets y Terraform configura otros que no
> existen.

---

## 7. Generar los bundles

Ni las EC2 ni las Lambdas compilan nada: reciben **artefactos ya
construidos**. El bundle de la API lo sube Terraform a S3 (`aws_s3_object`) y
el *user data* de cada instancia lo descarga al arrancar; los ZIPs de las tres
Lambdas los sube Terraform directamente al crear o actualizar cada función.
Hay que generarlos **antes** de `plan`/`apply`:

```bash
npm run bundle
```

(Para armar los ZIPs usa `zip` y, si no está instalado, `python -m zipfile`.)
Verificá que existan los cuatro archivos:

```bash
ls -l packages/api/dist/api.bundle.js \
      packages/alert-processor/dist/alert-processor.zip \
      packages/alert-processor/dist/no-signal-monitor.zip \
      packages/telemetry-export/dist/telemetry-export.zip
```

`packages/alert-processor` produce **dos** ZIPs: el consumidor de SQS y el
monitor de «sin señal» (`src/no-signal-handler.ts`), que comparten
`thresholds.ts` y `alert-id.ts` y se empaquetan por separado.

Si falta alguno, `terraform plan` falla con `no file exists at ...` (los lee
con `filemd5()`/`filebase64sha256()`).

---

## 8. `init`, `validate` y `plan`

### 8.1 `init` con backend remoto

El state se guarda en S3 (en el bucket del paso 5), así lo comparten tu
máquina y el pipeline. `terraform/backend.tf` solo declara `use_lockfile =
true`; el bucket, la key y la región se pasan por línea de comandos para no
hardcodear nada:

```bash
terraform -chdir=terraform init \
  -backend-config="bucket=snowball-tfstate-grupo-01" \
  -backend-config="key=snowball/terraform.tfstate" \
  -backend-config="region=us-east-1"
```

> `use_lockfile = true` es el **bloqueo nativo de S3** (Terraform ≥ 1.10): crea
> un objeto `.tflock` junto al state mientras alguien aplica, así dos
> ejecuciones simultáneas no se pisan. Reemplaza al esquema clásico «S3 +
> tabla DynamoDB para el lock», que ya está deprecado, y evita crear (y pagar y
> destruir) una tabla extra.

`.terraform.lock.hcl` fija la versión del provider `aws` (6.x, el único que se
usa) con los hashes para `linux_amd64`, `darwin_arm64` y `darwin_amd64`, y
**sí se commitea**. Si Terraform pide actualizarlo, corré el `init` con
`-upgrade`; para regenerarlo con las tres plataformas:
`terraform -chdir=terraform providers lock -platform=linux_amd64 -platform=darwin_arm64 -platform=darwin_amd64`.

### 8.2 `validate`

```bash
terraform -chdir=terraform fmt -check -recursive
terraform -chdir=terraform validate
```

`fmt -check` falla si hay archivos sin formatear (corregí con
`terraform fmt -recursive`). `validate` revisa sintaxis y consistencia sin
tocar AWS.

### 8.3 `plan`

```bash
terraform -chdir=terraform plan
```

Terraform carga `terraform/terraform.tfvars` automáticamente. Revisá el plan:

- Termina con `Plan: N to add, 0 to change, 0 to destroy.` En un entorno
  limpio son decenas de recursos y **nada para destruir**.
- No debe aparecer RDS ni ningún `aws_s3_bucket`.
- Si el state viene de un despliegue anterior (con el viejo `module.export`),
  el plan muestra las Lambdas y el schedule como **movidos** (`has moved to`),
  no como destruidos y recreados: lo resuelven los bloques `moved` de
  `main.tf`.
- Los valores sensibles (`jwt_secret`, claves privadas) aparecen como
  `(sensitive value)`.

---

## 9. `apply`

```bash
terraform -chdir=terraform apply
```

Revisá la lista, escribí `yes` y esperá. Tarda varios minutos: el NAT Gateway,
el ALB y el arranque de las dos EC2 son lo más lento. Si algo falla a mitad de
camino (credenciales vencidas, un permiso), no pasa nada: Terraform guarda lo
que ya creó; corregí el problema y volvé a correr `apply`.

Al terminar imprime los *outputs*. Podés volver a verlos cuando quieras:

```bash
terraform -chdir=terraform output                       # todos (los sensibles salen ocultos)
terraform -chdir=terraform output -raw alb_dns_name     # un valor puntual, sin comillas
```

> **Opcional, primera vez:** si querés que cualquier problema de permisos del
> Lab aparezca antes de crear lo que factura por hora (NAT, ALB, EC2), podés
> aplicar primero solo lo barato y después el resto:
> ```bash
> terraform -chdir=terraform apply -target=module.data -target=module.messaging -target=module.iot_ingest
> terraform -chdir=terraform apply
> ```
> Es solo una precaución de la primera vez; el segundo comando (sin `-target`)
> es el despliegue completo y el único que se usa de ahí en adelante.

---

## 10. Después del apply

### 10.1 Confirmar la suscripción de SNS

AWS manda un correo («AWS Notification - Subscription Confirmation») a
`sns_subscription_email`. **Hacé clic en *Confirm subscription*.** Sin
confirmar no llega ninguna alerta. (Revisá spam.)

### 10.2 Compilar y publicar el dashboard

Terraform no puede construir el dashboard antes de crear el ALB: la URL de la
API (el DNS del ALB) se «hornea» dentro del build de Vite. Por eso es un paso
posterior al `apply` (el pipeline lo hace solo):

```bash
ALB=$(terraform -chdir=terraform output -raw alb_dns_name)
BUCKET=$(terraform -chdir=terraform output -raw dashboard_bucket)

REPLICA=$(terraform -chdir=terraform output -raw dashboard_replica_bucket)
VITE_API_BASE="http://${ALB}" npm run build -w @snowball/dashboard
aws s3 sync packages/dashboard/dist/ "s3://${BUCKET}/" --delete --region us-east-1
# El mismo build va al bucket replicado (vacío si la réplica está apagada)
[ -n "${REPLICA}" ] && aws s3 sync packages/dashboard/dist/ "s3://${REPLICA}/" --delete   --region "$(terraform -chdir=terraform output -raw dashboard_replica_region)"

# Las dos URLs salen de los outputs: el host de S3 Website cambia de formato según la región
terraform -chdir=terraform output -raw dashboard_url; echo
terraform -chdir=terraform output -raw dashboard_replica_url; echo
```

Hasta que hagas esto, la URL del sitio responde `404 NoSuchKey` (`index.html`):
el bucket existe pero está vacío.

### 10.3 Esperar a que la API esté sana

Las instancias instalan Node y descargan el bundle de la API al arrancar;
tarda unos minutos. Verificá que el target group tenga **2 objetivos `healthy`**:

```bash
TG=$(aws elbv2 describe-target-groups --names snowball-app-tg \
     --query 'TargetGroups[0].TargetGroupArn' --output text)
aws elbv2 describe-target-health --target-group-arn "$TG" \
     --query 'TargetHealthDescriptions[].TargetHealth.State'
```

Hasta entonces el ALB responde `502`/`503`.

---

## 11. Certificados y simulador

Cada unidad es un *thing* de IoT Core con su certificado X.509. Terraform genera
los certificados y las claves privadas y los expone como outputs **sensibles**.
Para bajarlos a `certs/` (que está en `.gitignore`):

```bash
bash scripts/export-certs.sh
ls certs certs/SB-001
```

Debe imprimir `Exported SB-001`, `SB-002` y `SB-003`, y dejar
`certs/AmazonRootCA1.pem` más, por unidad, `certificate.pem.crt` y
`private.pem.key`. Las claves privadas quedan también en el state remoto
(ver [limitaciones](#17-limitaciones-conocidas)).

Levantar el simulador (en una sola línea, o con `\` al final de cada línea):

```bash
npm run simulator -- \
  --endpoint "$(terraform -chdir=terraform output -raw iot_endpoint)" \
  --units SB-001,SB-002,SB-003 --interval 5 --excursion SB-001@60
```

- `--excursion SB-001@60`: a los 60 s la unidad SB-001 empieza a calentarse
  hasta salir de rango. `--silence SB-002@120`: a los 2 min deja de reportar
  (es el escenario con el que se prueba el monitor de «sin señal»).
- Cada unidad debe imprimir `[SB-001] connected to IoT Core` y después una
  lectura cada 5 s. **Ojo:** el simulador imprime cada lectura apenas la genera,
  aunque no haya logrado conectarse. Si no ves `connected to IoT Core`, el
  problema es la conexión: ver [troubleshooting](#18-troubleshooting).
- Frenarlo: `Ctrl+C`.

---

## 12. Verificación end-to-end

Con el simulador corriendo, recorré el camino de los datos de punta a punta.
(Adaptado del checklist de la guía de la Entrega 2, sin RDS.)

**Red y aislamiento**

- [ ] Las instancias del ASG **no tienen IP pública**:
  ```bash
  aws ec2 describe-instances \
    --filters Name=tag:aws:autoscaling:groupName,Values=snowball-app-asg Name=instance-state-name,Values=running \
    --query 'Reservations[].Instances[].[InstanceId,PublicIpAddress,PrivateIpAddress]' --output table
  ```
  La columna de IP pública debe decir `None`.
- [ ] En la consola (EC2 → Security Groups), `sg-app` solo acepta el `3000` desde
  `sg-alb` y el `22` desde `sg-bastion`; no hay `sg-db` ni NACL de datos.

**Ingesta**

- [ ] **IoT Core → MQTT test client**, suscripto a `snowball/+/telemetry`: llegan
  mensajes de las tres unidades.
- [ ] **DynamoDB → Explore items**: `snowball-telemetry` acumula ítems con
  `expires_at`; `snowball-unit-state` tiene **una fila por unidad** con el `ts`
  más reciente.
- [ ] El *event source mapping* de la Lambda está habilitado:
  ```bash
  aws lambda list-event-source-mappings --function-name snowball-alert-processor \
    --query 'EventSourceMappings[].[State,BatchSize,ScalingConfig.MaximumConcurrency]'
  ```
  Debe decir `Enabled`, `10` y `2`.
- [ ] La cola drena y la DLQ queda vacía:
  ```bash
  Q=$(terraform -chdir=terraform output -raw queue_url)
  aws sqs get-queue-attributes --queue-url "$Q" \
    --attribute-names ApproximateNumberOfMessages ApproximateNumberOfMessagesNotVisible
  DLQ=$(terraform -chdir=terraform output -raw dlq_url)
  aws sqs get-queue-attributes --queue-url "$DLQ" --attribute-names ApproximateNumberOfMessages
  ```
  La DLQ debe valer `0`. Un mensaje llega ahí después de fallar 5 veces: un
  payload que no se puede parsear, o un error repetido al procesarlo (ver los
  logs de la Lambda).
- [ ] Logs del procesador de alertas:
  ```bash
  aws logs tail /aws/lambda/snowball-alert-processor --since 10m
  ```
- [ ] Errores de la regla de IoT, si los hubo: CloudWatch Logs, grupo
  `/aws/iot/snowball-iot-errors`. Es la `error_action` de la regla: solo
  recibe algo cuando falla una acción, así que en funcionamiento normal está
  vacío.

**API**

- [ ] Salud, login y token:
  ```bash
  ALB=$(terraform -chdir=terraform output -raw alb_dns_name)
  curl "http://${ALB}/health"                            # {"ok":true}
  curl -i -X POST "http://${ALB}/auth/login" \
    -H 'Content-Type: application/json' \
    -d '{"email":"admin@snowball.example","password":"admin123"}'   # 200 + JWT
  curl -i "http://${ALB}/auth/me" -H "Authorization: Bearer <JWT>"   # datos del admin
  curl -i "http://${ALB}/auth/me"                                    # 401 sin token
  ```
- [ ] `GET /api/units` con el token devuelve las unidades con su última lectura:
  ```bash
  curl -s "http://${ALB}/api/units" -H "Authorization: Bearer <JWT>"
  ```
  Usuarios demo (cargados desde `scripts/seed-data.json`):

  | Email | Contraseña | Rol | Cliente |
  |---|---|---|---|
  | `operator@snowball.example` | `operator123` | operator | 1 |
  | `supervisor@snowball.example` | `supervisor123` | supervisor | 1 |
  | `admin@snowball.example` | `admin123` | admin | — (ve todo) |

  Un operador/supervisor del cliente 1 no ve la unidad `SB-003` (cliente 2):
  responde `404` para no revelar su existencia.

**Dashboard**

- [ ] Abrí la URL de `terraform -chdir=terraform output -raw dashboard_url`, iniciá
  sesión y verificá que aparecen las tarjetas de las tres unidades actualizándose
  en vivo (WebSocket), el historial y el **mapa** con un marcador por unidad
  coloreado según su estado.
- [ ] Abrí la URL de `dashboard_replica_url` (la réplica de `us-west-2`) y repetí
  la verificación: tiene que funcionar igual, porque apunta al mismo ALB. En
  DevTools no debe haber errores de CORS (`cors_origin` tiene que seguir en `*`).
- [ ] Panel de configuración (setpoint remoto vía Device Shadow): al cambiarlo, la
  unidad lo aplica a los pocos segundos y el simulador lo imprime.

**Alertas**

- [ ] A los ~60 s la unidad SB-001 sale de rango. Pasada la tolerancia configurada
  (`tolerance_min` en `snowball-device-config`) llega **un mail** por excursión
  al correo suscripto, y la alerta aparece **una sola vez** en el dashboard y en
  `snowball-alerts` (DynamoDB). (SNS es *at-least-once*: si la Lambda se
  reintenta después de publicar, el mail puede repetirse, pero la fila no se
  duplica porque el id de la alerta es determinístico.)
- [ ] Acknowledgement: con supervisor o admin, reconocer la alerta desde el
  dashboard.

**Archivo**

- [ ] Ejecutar la Lambda a mano para el día de hoy (UTC) y verificar S3:
  ```bash
  ARCHIVE=$(terraform -chdir=terraform output -raw archive_bucket)
  aws lambda invoke --function-name snowball-telemetry-export \
    --cli-binary-format raw-in-base64-out \
    --payload "{\"date\":\"$(date -u +%F)\"}" out.json && cat out.json
  aws s3 ls "s3://${ARCHIVE}/telemetry/" --recursive
  ```
  La respuesta debe contener `"failed":[]` y debe haber un `.ndjson.gz` por
  unidad que haya reportado. (El schedule diario corre a las 00:15 UTC y exporta
  el día anterior.)

**«Sin señal» por unidad**

El tópico `snowball-no-signal` ahora tiene suscripción por mail (el mismo
`sns_subscription_email` del tópico térmico): **hay que confirmarla** desde el
mail de AWS, igual que la de excursión, o no llega nada.

- [ ] La Lambda y su schedule existen:
  ```bash
  aws lambda get-function --function-name snowball-no-signal-monitor \
    --query 'Configuration.[Timeout,MemorySize,Environment.Variables.NO_SIGNAL_TIMEOUT_MIN]'
  aws scheduler get-schedule --name snowball-no-signal-monitor \
    --query '[ScheduleExpression,State]'
  ```
  Tiene que devolver `60` (timeout de la Lambda, en segundos), `256` (MB de
  memoria), `"10"` (el fallback `NO_SIGNAL_TIMEOUT_MIN`, en minutos),
  `rate(1 minute)` y `ENABLED`.
- [ ] Silenciá una unidad agregando `--silence SB-002@120` al comando del
  simulador (sección 11), o apagalo del todo. Pasados los minutos de
  `signal_timeout_min` de esa unidad (`snowball-device-config`, 10 por defecto)
  llega **un mail** por «sin señal» y aparece **una sola fila** con
  `severity = no-signal` en `snowball-alerts` y en el dashboard, aunque el
  barrido corra cada minuto: el ítem `_signal` de la unidad queda en fase
  `silent` y los barridos siguientes no vuelven a alertar.
- [ ] Al volver a publicar, la unidad pasa a `ok` y llega un **aviso de
  recuperación** por el mismo tópico. Ese aviso **no** escribe fila en
  `snowball-alerts`: no es una alerta.
- [ ] Evidencia para la defensa: el delta entre el `ts` de la última lectura y
  el `emitted_at` de la alerta es la latencia de detección real (acotada por
  abajo por la granularidad de un minuto del scheduler).
- [ ] Logs del barrido, si algo no sale:
  ```bash
  aws logs tail /aws/lambda/snowball-no-signal-monitor --since 10m
  ```

**Alarma de flota «sin señal»**

Es un segundo nivel, no una redundancia: detecta la caída del *pipeline* (la
cola no recibe nada de nadie), que es un modo de falla distinto de «esta unidad
se calló».

- [ ] `aws cloudwatch describe-alarms --alarm-names snowball-no-signal-alarm`
  existe. Con el simulador corriendo pasa a `OK`; si dejás 15 minutos sin
  mensajes pasa a `ALARM` (también arranca en `ALARM`/`INSUFFICIENT_DATA`
  recién creada y sin tráfico). Publica al mismo tópico `snowball-no-signal`,
  así que con la suscripción confirmada también llega por mail.

**Resiliencia**

- [ ] Terminá una instancia del ASG a mano
  (`aws ec2 terminate-instances --instance-ids <id>`): el ASG levanta otra y el
  target group vuelve a mostrar 2 `healthy` sin intervención.

**Diagnóstico por dentro (opcional)**

Con `enable_bastion = true` en `terraform.tfvars` (y un `apply`), podés entrar a
una instancia privada pasando por el bastión:

```bash
BASTION_IP=$(aws ec2 describe-instances \
  --filters Name=tag:Name,Values=snowball-bastion Name=instance-state-name,Values=running \
  --query 'Reservations[].Instances[].PublicIpAddress' --output text)
ssh -i labsuser.pem -J ec2-user@${BASTION_IP} ec2-user@<IP-PRIVADA-INSTANCIA>
sudo journalctl -u snowball-api -f
```

(En las instancias corre solo la API; el procesador de alertas es una Lambda y
sus logs están en CloudWatch, `/aws/lambda/snowball-alert-processor`.)

(`labsuser.pem` se descarga desde **AWS Details → Download PEM**. La IP privada
de una instancia sale de la consulta del primer punto de este checklist.)

---

## 13. Pipeline de GitHub Actions

El workflow `.github/workflows/terraform.yml` cubre `init`, `validate`, `plan`,
`apply` y `destroy`. Se apoya en una *composite action*
(`.github/actions/terraform-setup/action.yml`) que prepara el entorno.

### Disparadores y jobs

| Disparador | Jobs que corren | Qué hacen |
|---|---|---|
| `pull_request` | `validate`, `app`, `plan` | Verifican formato y sintaxis, corren build y tests, y calculan el plan contra el state real, **comentándolo en el PR**. Sin efectos secundarios en AWS |
| `workflow_dispatch` (botón *Run workflow*) | `validate`, `app`, `deploy` | `deploy` ejecuta lo elegido en el input `action`: `plan`, `apply` o `destroy` |

No hay disparador en `push`: ver [por qué el apply es manual](#por-qué-el-apply-es-manual).

Detalle de cada job:

- **`validate`** (sin credenciales, corre siempre, incluso en forks):
  `terraform fmt -check -recursive` e `init -backend=false` + `validate` sobre
  `terraform/`.
- **`app`**: `npm ci`, `npm run build` (antes de los tests, para que
  `@snowball/shared` esté compilado) y `npm test`.
- **`plan`** (solo en PR, después de `validate`): usa la composite action en
  modo no estricto y corre `terraform plan`; publica o actualiza un comentario
  con el resultado. **No crea nada**: si falta el bucket de state no lo crea.
  Si algo impide el plan, lo **omite con un warning** en lugar de fallar (ver
  la tabla de abajo).
- **`deploy`** (solo manual, después de `validate` y `app`,
  `environment: learner-lab`): usa la composite action en modo estricto (falla
  si falta algo) y ejecuta:
  - `plan`: `terraform plan`.
  - `apply`: `plan` → `apply` del plan guardado → compila el dashboard con la
    URL del ALB y lo sincroniza a su bucket → deja las URLs en el resumen del
    run.
  - `destroy`: exige escribir `DESTROY` en el input `confirm` y ejecuta
    `terraform destroy -auto-approve`.

La composite action hace, en orden: verificar secrets/variables → verificar
credenciales (`aws sts get-caller-identity`) → en PR, verificar que exista el
bucket de state → instalar Node → `npm ci` + `npm run bundle` (bundle de la
API y ZIPs de las tres Lambdas) → instalar Terraform → **crear los buckets**
(`scripts/bootstrap-buckets.sh`, idempotente; **solo en `workflow_dispatch`**)
→ `terraform init` con el backend remoto. El workflow define `concurrency`
para que nunca corran dos ejecuciones a la vez sobre el mismo state.

### Comportamiento según la situación

| Situación | `plan` del PR | `deploy` manual |
|---|---|---|
| Faltan secrets o variables (por ejemplo, un PR desde un fork) | `::warning::` y plan omitido: el PR queda **verde** | Falla con error |
| Credenciales del Learner Lab vencidas | `::warning::` y plan omitido (verde) | Falla con error («Las credenciales del Learner Lab vencieron») |
| No existe el bucket de state | `::warning::` y plan omitido (un PR no crea recursos) | El script lo crea |
| Todo en orden | Plan comentado en el PR | Ejecuta `plan` / `apply` / `destroy` |

`validate` y `app` corren en todos los casos y son los que pueden dejar el PR
en rojo. Para que el PR evaluado muestre un plan real y no uno omitido, hay que
refrescar los secrets de AWS justo antes del último push.

### Por qué el apply es manual

La consigna pide init, validate, plan y apply en el pipeline. `init`,
`validate` y `plan` corren en cada PR; el `apply` está en el mismo workflow
pero se dispara a mano (`workflow_dispatch`) **a propósito**: las credenciales
del Learner Lab vencen a las ~4 h, así que un apply automático en cada `push`
a `main` fallaría casi siempre. Se corre justo después de pegar credenciales
frescas. La restricción de `apply`/`destroy` a la rama `main`
(`github.ref == 'refs/heads/main'`) quedó escrita como comentario `TODO` en el
job `deploy`, para activarla después de verificar el apply desde la rama.

### Qué hay que cargar en GitHub

**Settings → Secrets and variables → Actions**

*Secrets* (pestaña Secrets):

| Secret | Valor |
|---|---|
| `AWS_ACCESS_KEY_ID` | del bloque *AWS CLI* del Lab |
| `AWS_SECRET_ACCESS_KEY` | del bloque *AWS CLI* del Lab |
| `AWS_SESSION_TOKEN` | del bloque *AWS CLI* del Lab |
| `JWT_SECRET` | la clave de firma (la misma lógica que `jwt_secret`) |

*Variables* (pestaña Variables):

| Variable | Valor |
|---|---|
| `BUCKET_SUFFIX` | el sufijo de buckets |
| `STATE_BUCKET_NAME` | el bucket de state |
| `KEY_NAME` | `vockey` |
| `BASTION_ALLOWED_CIDR` | tu IP con `/32` (o cualquier CIDR válido; es obligatoria aunque el bastión esté apagado) |
| `SNS_SUBSCRIPTION_EMAIL` | mail que recibe las alertas |

El workflow las traduce a `TF_VAR_*`, así que **no hay `terraform.tfvars` en el
CI**. El entorno `learner-lab` (usado por `deploy`) se crea solo la primera vez
que corre; en **Settings → Environments** podés agregarle revisores requeridos
para aprobar los `apply`/`destroy`.

### Credenciales que vencen

Los tres secrets de AWS son los mismos valores temporales del Lab y **se
vencen**. Antes de cada ejecución que los necesite (el `plan` de un PR, o un
`apply`/`destroy`): Start Lab → copiar el bloque *AWS CLI* → actualizar los tres
secrets. Con GitHub CLI (`gh`) es rápido:

```bash
gh secret set AWS_ACCESS_KEY_ID
gh secret set AWS_SECRET_ACCESS_KEY
gh secret set AWS_SESSION_TOKEN
```

(cada comando pide el valor por entrada estándar). Si están vencidos, el
`deploy` falla con el mensaje «Las credenciales del Learner Lab vencieron» y el
`plan` de un PR se omite con ese mismo aviso como warning.

### Ejecutar un despliegue desde GitHub (cátedra)

1. Cargá secrets y variables (arriba) con credenciales **frescas**: Start Lab →
   **AWS Details → AWS CLI** → pegar `AWS_ACCESS_KEY_ID`,
   `AWS_SECRET_ACCESS_KEY` y `AWS_SESSION_TOKEN` como secrets.
2. **Actions → Terraform → Run workflow**, elegí la rama, `action: apply`. No
   hace falta crear los buckets antes: el job los crea.
3. Al terminar, el resumen del run muestra la URL de la API, del dashboard y el
   endpoint de IoT. Los **certificados** no salen del pipeline: bajalos en tu
   máquina con `bash scripts/export-certs.sh` (lee los outputs del state remoto,
   así que necesitás haber hecho `terraform init` con el mismo backend).
4. Para destruir: `action: destroy` y `confirm: DESTROY`. El destroy **no borra
   los buckets**: después corré localmente `scripts/delete-buckets.sh` (ver
   [sección 15](#15-destruir-todo-y-costos)).

Notas sobre PRs:

- Los PRs desde **forks** no reciben secrets (regla de GitHub): `validate` y
  `app` corren igual; `plan` se omite con warning.
- El `plan` de un PR contra una infraestructura aún no desplegada muestra todo
  «para crear»; es lo esperado.
- Mientras el Lab no esté corriendo o los secrets estén vencidos, el `plan` se
  omite con un warning, pero `validate` y `app` siguen verificando el código.
- Si todavía no se corrió ningún `apply` (no existe el bucket de state), el
  `plan` del PR también se omite: el PR no crea buckets.

---

## 14. Redesplegar cambios

**Cambió el código de la API.**

```bash
npm run bundle
terraform -chdir=terraform apply
```

`filemd5` detecta el bundle nuevo y Terraform lo vuelve a subir a S3. Como el
hash también se renderiza (como comentario) en el user data, el launch template
recibe una versión nueva y el ASG, que usa `latest_version`, lanza solo un
**instance refresh** (Rolling, con al menos 50 % de instancias sanas y 120 s de
warmup): las instancias se reemplazan de a una y las nuevas bajan el bundle
nuevo. Lo mismo pasa si cambian las variables que entran en el user data
(nombres de tablas, JWT, `cors_origin`).

`apply` **no espera** a que termine el refresh. Seguilo en la consola (EC2 →
Auto Scaling Groups → `snowball-app-asg` → *Instance refresh*) o con:

```bash
aws autoscaling describe-instance-refreshes --auto-scaling-group-name snowball-app-asg \
  --query 'InstanceRefreshes[0].[Status,PercentageComplete]'
```

y al terminar validá que el target group muestre 2 `healthy`, `/health` y el
login.

**Cambió el código de una Lambda (alert-processor, no-signal-monitor o telemetry-export).**
`npm run bundle` + `terraform apply`: `source_code_hash` (`filebase64sha256`
del ZIP) detecta el cambio y actualiza la función. No hay instancias que
reemplazar.

**Cambió el dashboard.** Repetí el paso [10.2](#102-compilar-y-publicar-el-dashboard).

**Cambió el DNS del ALB** (por ejemplo, después de un `destroy` + `apply`):
recompilá el dashboard (10.2), porque la URL está horneada en el build.

---

## 15. Destruir todo y costos

### Destruir

Al terminar cada sesión de pruebas, destruí todo. Lo que factura por hora es,
en orden de peso, el **NAT Gateway**, el **ALB** y las **dos EC2** (más el
bastión si lo activaste). Según la guía de la Entrega 2, el NAT ronda los USD
32/mes y el ALB los USD 16/mes si quedan encendidos; DynamoDB (on-demand), SQS,
SNS, IoT Core, S3 y Lambda cuestan centavos a escala de demo.

```bash
terraform -chdir=terraform destroy
```

Revisá la lista, escribí `yes`. Tarda unos minutos (el NAT y el ALB son
lentos de borrar).

**`destroy` no borra los buckets**, porque Terraform no es dueño de ellos
(sección 5). Quedan los cuatro. Para limpiarlos:

```bash
# borra dashboard, artifacts y archive (vacía incluso las versiones); conserva el state
bash scripts/delete-buckets.sh grupo-01 snowball-tfstate-grupo-01

# borra también el bucket de state (solo si no vas a volver a desplegar)
bash scripts/delete-buckets.sh grupo-01 snowball-tfstate-grupo-01 --include-state
```

Pide que escribas `DELETE` (o usá `--yes` para saltear la confirmación).
Recomendación: **conservá el bucket de state** entre sesiones; cuesta
centavos y evita repetir el paso 5.

> El archivo del bucket `archive` es el historial de telemetría exportado. Si
> querés conservarlo, no ejecutes `delete-buckets.sh` (o copiá lo que
> necesites antes).

### Checklist final en la consola

Antes de **End Lab**, confirmá que no quedó nada cobrando:

- **EC2:** instancias, **Elastic IPs** (una sin asociar cobra) y balanceadores.
- **VPC:** NAT Gateways.
- **S3:** buckets que no quieras conservar.
- Presupuesto en la pantalla del curso.

### Reset del Lab

No hagas **Reset** del Lab con infraestructura levantada: los recursos
desaparecen de AWS pero el state remoto sigue creyendo que existen. Hacé
siempre `destroy` antes. (Si ya pasó, ver troubleshooting.)

---

## 16. Referencia: módulos, variables y outputs

### Estructura

```
terraform/
├── versions.tf          # Terraform >= 1.10; provider aws ~> 6.46
├── providers.tf         # provider aws (default_tags) + data de LabRole / LabInstanceProfile
├── backend.tf           # backend s3 con use_lockfile (bucket/key/region por -backend-config)
├── variables.tf         # entradas parametrizables
├── locals.tf            # tags comunes, nombres de recursos, buckets, unidades y mapa de Lambdas
├── main.tf              # módulos, configuración standalone de buckets, schedule, event source mapping, moved
├── outputs.tf           # salidas
├── terraform.tfvars.example
└── modules/
    ├── network/         # VPC, subredes, NAT, rutas, endpoints, security groups
    ├── data/            # tablas DynamoDB + seed
    ├── messaging/       # SQS + DLQ, SNS, suscripciones, alarma (módulo externo)
    ├── iot-ingest/      # IoT: policy, things, certificados, regla + error action
    ├── compute/         # bundle de la API, ALB, launch template, ASG, bastión
    └── lambda-function/ # Lambda genérica + log group (instanciada 3 veces con for_each)
```

### Módulos propios

| Módulo | Qué crea | Entradas principales | Salidas |
|---|---|---|---|
| `network` | VPC, 4 subredes (2 públicas, 2 de aplicación) con `cidrsubnet`, IGW, EIP + NAT, tablas de ruteo, gateway endpoints S3/DynamoDB, security groups `sg-alb`/`sg-app`/`sg-bastion` encadenados por referencia | `vpc_cidr`, `availability_zones`, `bastion_allowed_cidr` | `vpc_id`, `public_subnet_ids`, `app_subnet_ids`, `*_security_group_id` |
| `data` | Las 7 tablas DynamoDB (definiciones en un mapa → `for_each`, GSIs/TTL en bloques `dynamic`) y los ítems de seed desde `scripts/seed-data.json` (las tres filas de `device-config` incluyen `signal_timeout_min`) | `table_names`, `seed_path` | `table_names`, `table_arns`, `table_ids` |
| `messaging` | Cola `snowball-readings` (visibilidad 180 s, long polling 20 s) + DLQ (`maxReceiveCount = 5`, retención 14 días), tópicos SNS (térmico, sin señal, y batería —reservado, sin publicador—), suscripción por mail con `for_each` sobre los dos tópicos con publicador (térmico y sin señal) más un bloque `moved` desde el `count` anterior, alarma de flota «sin señal» | `names`, `subscription_email` | `queue_url`, `queue_arn`, `dlq_url`, `dlq_arn`, `thermal_topic_arn`, `no_signal_topic_arn`, `topic_arns`, `no_signal_alarm_arn` |
| `iot-ingest` | Policy `snowball-device-policy` (acota cada dispositivo a sus tópicos con `${iot:Connection.Thing.ThingName}`), un thing + certificado + 2 attachments por unidad (`for_each`), regla `snowball_telemetry` (DynamoDB ×2, SQS, y `error_action` a CloudWatch Logs) | `names`, `units`, `lab_role_arn`, `telemetry_table_name`, `state_table_name` (de `module.data`), `queue_url` | `iot_endpoint`, `certificates`*, `private_keys`*, `certificate_arns`* |
| `compute` | Subida del bundle de la API a S3, target group, ALB + listener HTTP:80, launch template (user data con `templatefile`, `tag_specifications`, `create_before_destroy`), ASG con `instance_refresh` y `latest_version`, bastión opcional (`count`) | subredes, security groups, bucket de artifacts, `api_bundle_path`, nombres de tablas, `iot_endpoint`, `cors_origin`, `jwt_secret`*, `asg_*`, `tags` | `alb_dns_name`, `target_group_arn`, `launch_template_id`, `bastion_instance_id` |
| `lambda-function` | Una Lambda (ZIP, `LabRole`, fuera de la VPC) y su log group `/aws/lambda/<nombre>` (retención 14 días). La raíz lo instancia con `for_each` sobre `local.lambdas`: `telemetry-export` (timeout 300 s, 512 MB), `alert-processor` (timeout 30 s, 256 MB) y `no-signal-monitor` (timeout 60 s, 256 MB) | `function_name`, `zip_path`, `handler` (default `index.handler`), `runtime` (default `nodejs22.x`), `timeout`, `memory_size`, `environment`, `lab_role_arn`, `log_retention_days` | `function_name`, `arn`, `log_group_name` |

\* sensibles.

### Módulo externo

`messaging` usa **`terraform-aws-modules/cloudwatch/aws//modules/metric-alarm`**
(versión `~> 5.0`, del Terraform Registry) para la alarma de flota de «sin
señal»: si la cola `snowball-readings` no recibe mensajes durante 15 minutos (3
períodos de 5 min, datos faltantes tratados como incumplimiento), publica en el
tópico `snowball-no-signal`. Es la caída del pipeline completo; el silencio de
**una** unidad lo detecta la Lambda `snowball-no-signal-monitor`, que publica en
el mismo tópico.

### Configuración en la raíz (`main.tf`)

- Recursos *standalone* sobre los buckets creados por script: versionado
  (artifacts, archive), cifrado SSE-S3 (los tres, con `for_each` para los
  privados), Public Access Block (privado para artifacts/archive, abierto para
  dashboard), lifecycle `telemetry-to-glacier` (transición a Glacier a los
  `archive_glacier_days` días, 90 por defecto, sobre el prefijo `telemetry/`),
  website del dashboard y su policy de lectura pública (con `depends_on` de la
  configuración website).
- `module "lambda"` (`for_each = local.lambdas`): las tres Lambdas.
- `aws_scheduler_schedule.telemetry_export`: EventBridge Scheduler
  (`schedule_expression`, por defecto todos los días a las 00:15 UTC) →
  Lambda `snowball-telemetry-export`, con `LabRole`.
- `aws_scheduler_schedule.no_signal_monitor` (`main.tf:176-187`): EventBridge
  Scheduler (`no_signal_schedule_expression`, por defecto `rate(1 minute)`) →
  Lambda `snowball-no-signal-monitor`, con `LabRole`, `input = "{}"` y
  `flexible_time_window { mode = "OFF" }`, copiado del schedule de exportación.
  Tampoco lleva `aws_lambda_permission`: el Scheduler invoca asumiendo
  `LabRole`, y el Lab no permite crear recursos de IAM. La granularidad del
  schedule **es** el error de detección, así que un minuto es lo que mantiene la
  latencia dentro del requisito de <60 s.
- `aws_lambda_event_source_mapping.alert_processor`: SQS `snowball-readings` →
  Lambda `snowball-alert-processor`, `batch_size = 10`,
  `function_response_types = ["ReportBatchItemFailures"]` y
  `scaling_config { maximum_concurrency = 2 }`.
- Bloques `moved` (`main.tf:184-195`): `module.export.aws_lambda_function.this`
  y su log group → `module.lambda["telemetry-export"]`, y
  `module.export.aws_scheduler_schedule.daily` →
  `aws_scheduler_schedule.telemetry_export`. Así un state de una versión
  anterior se migra sin destruir la Lambda.

Las funciones y los meta-argumentos de Terraform usados, con archivo y línea,
están en el `README.md` (secciones *Funciones de Terraform utilizadas* y
*Meta-argumentos utilizados*).

### Variables de entrada

| Variable | Tipo | Default | Descripción |
|---|---|---|---|
| `region` | string | `us-east-1` | Región AWS |
| `project` | string | `snowball` | Prefijo/tag de proyecto |
| `bucket_suffix` | string | **obligatoria** | Sufijo único global para los buckets |
| `lab_role_name` | string | `LabRole` | Rol del Lab que asumen Lambda, IoT y el Scheduler |
| `lab_instance_profile_name` | string | `LabInstanceProfile` | Instance profile de las EC2 |
| `vpc_cidr` | string | `10.0.0.0/16` | CIDR de la VPC (las subredes se derivan con `cidrsubnet`); validado con `can(cidrhost(...))` |
| `availability_zones` | list(string) | `["us-east-1a","us-east-1b"]` | Las dos AZ |
| `enable_bastion` | bool | `false` | Crea el bastión (`count`) |
| `bastion_allowed_cidr` | string | **obligatoria** | CIDR autorizado a SSH al bastión |
| `key_name` | string | **obligatoria** | Key pair existente (`vockey`) |
| `jwt_secret` | string (sensible) | **obligatoria** | Clave de firma de los JWT |
| `sns_subscription_email` | string | **obligatoria** | Mail que recibe las alertas; validado con `can(regex(...))` |
| `cors_origin` | string | `*` | Origen permitido por CORS en la API (`CORS_ORIGIN`); `*` deja usar el dashboard desde localhost u otro origen |
| `instance_type` | string | `t3.small` | Tipo de las instancias del ASG |
| `asg_min_size` / `asg_max_size` / `asg_desired_capacity` | number | `2` / `4` / `2` | Tamaño del Auto Scaling Group de la API |
| `ami_id` | string | `null` | AMI; si es `null` usa la última Amazon Linux 2023 |
| `api_bundle_path` | string | `../packages/api/dist/api.bundle.js` | Bundle de la API |
| `alert_lambda_zip_path` | string | `../packages/alert-processor/dist/alert-processor.zip` | ZIP de la Lambda del procesador de alertas |
| `no_signal_lambda_zip_path` | string | `../packages/alert-processor/dist/no-signal-monitor.zip` | ZIP de la Lambda del monitor de «sin señal» (segundo bundle del mismo paquete) |
| `lambda_zip_path` | string | `../packages/telemetry-export/dist/telemetry-export.zip` | ZIP de la Lambda de exportación |
| `seed_data_path` | string | `../scripts/seed-data.json` | Datos demo de DynamoDB |
| `schedule_expression` | string | `cron(15 0 * * ? *)` | Cron del export diario (UTC) |
| `no_signal_schedule_expression` | string | `rate(1 minute)` | Cadencia del barrido de «sin señal»; es el error de detección |
| `no_signal_timeout_min` | number | `10` | Minutos de silencio por defecto antes de reportar una unidad; validado `>= 1`. Lo sobreescribe por unidad `signal_timeout_min` en `snowball-device-config` |
| `archive_glacier_days` | number | `90` | Días hasta la transición a Glacier del archivo; validado `>= 30` |
| `unit_ids` | list(string) | `["SB-001","SB-002","SB-003"]` | Unidades a aprovisionar (things + certificados) |

### Outputs

| Output | Descripción |
|---|---|
| `vpc_id` | ID de la VPC |
| `alb_dns_name` | DNS del balanceador: URL de la API y `VITE_API_BASE` del dashboard |
| `artifact_bucket` / `dashboard_bucket` / `archive_bucket` | Nombres de los buckets |
| `iot_endpoint` | Endpoint `-ats` de IoT Core (para el simulador) |
| `iot_certificates`, `iot_private_keys`, `iot_certificate_arns` | **Sensibles.** Certificados, claves y ARNs; `scripts/export-certs.sh` los baja a `certs/` |
| `table_names` | Nombres de las tablas DynamoDB |
| `queue_url` | URL de la cola de lecturas |
| `dlq_url` | URL de la DLQ |
| `sns_topic_arns` | Mapa de ARNs de los tópicos SNS: `thermal` (alert-processor), `signal` (monitor de «sin señal» por unidad + alarma de flota), `battery` (reservado, sin publicador) |
| `lambda_function_names` / `lambda_function_arns` | Mapas `telemetry-export` / `alert-processor` / `no-signal-monitor` → nombre y ARN de cada Lambda |
| `telemetry_export_schedule_arn` | ARN del schedule diario de EventBridge Scheduler |
| `no_signal_schedule_arn` | ARN del schedule del barrido de «sin señal» |

El modelo de datos de las tablas (claves y GSIs) está en
`docs/dynamodb-model.md`.

---

## 17. Limitaciones conocidas

Son decisiones de alcance para el Learner Lab; conviene saberlas para la
defensa.

- **HTTP de punta a punta.** Sin dominio no hay certificado público de ACM. El
  listener del ALB y el sitio de S3 son HTTP; en producción serían HTTPS (ACM +
  CloudFront).
- **Un solo NAT Gateway (zonal).** Si cae `us-east-1a`, las instancias privadas
  pierden salida a Internet hasta que vuelva. Un segundo NAT en `us-east-1b`
  costaría unos USD 32/mes más.
- **Secretos en el user data.** `JWT_SECRET` viaja en el user data del launch
  template (visible para quien tenga acceso a EC2/metadata de la cuenta). En
  producción iría en Secrets Manager o SSM Parameter Store, con roles propios
  (no disponibles en el Lab).
- **Claves privadas de los certificados IoT en el state.** `aws_iot_certificate`
  guarda la clave privada en el state remoto (que está en un bucket privado,
  cifrado y versionado). Aceptable para el Lab; en producción se aprovisionan
  claves por fuera o con CSR.
- **JWT no revocable** hasta que expira (8 h), y el feed en vivo fija las unidades
  permitidas al abrir el WebSocket (ver `README.md`).
- **La detección de «sin señal» tiene dos niveles y una ventana de error de un
  minuto.** La Lambda `snowball-no-signal-monitor` detecta la unidad que se
  calló y la alarma de CloudWatch `snowball-no-signal-alarm` la caída del
  pipeline entero; las dos notifican por mail. Lo que queda como limitación es
  la resolución: el barrido corre cada minuto (`no_signal_schedule_expression`),
  así que la alerta puede salir hasta ~1 minuto después de cruzado el umbral. El
  tópico `snowball-low-battery` sí sigue reservado: existe, pero nadie publica
  en él todavía.
- **Carrera residual en el procesador de alertas.** Con
  `maximum_concurrency = 2` (el mínimo del *event source mapping*) y una cola
  estándar, dos lotes con lecturas de la misma unidad pueden procesarse a la
  vez y competir por el ítem `_state` de esa unidad. La inserción de alertas es
  idempotente, pero las transiciones de estado no: una invocación puede pisar
  el estado de excursión escrito por la otra. La acción SQS de IoT Core no admite colas FIFO (que
  ordenarían por unidad) y el Learner Lab limita la concurrencia de la cuenta a
  ~10, así que no se puede reservar concurrencia 1. Lo mitigan el orden por
  `ts` dentro de cada lote y la inserción idempotente de alertas.
- **SNS es *at-least-once*.** Si la Lambda se reintenta después de publicar, el
  mail de una alerta puede llegar dos veces; la alerta nunca se pierde ni se
  duplica en `snowball-alerts`.
- **Los buckets no los borra `terraform destroy`** (limitación del SCP, sección 5);
  para eso está `scripts/delete-buckets.sh`.
- **El `apply` no espera al instance refresh** del ASG tras un cambio del bundle
  de la API (sección 14): hay que seguirlo en la consola.
- **Una sola región** (`us-east-1`) y dos zonas de disponibilidad.

---

## 18. Troubleshooting

**`ExpiredToken` / `InvalidClientTokenId` / `The security token included in the request is expired`**
Las credenciales del Lab vencieron. Start Lab (si estaba apagado), volvé a
copiar el bloque *AWS CLI* al archivo `~/.aws/credentials` y reintentá. En el
pipeline, actualizá los tres secrets de AWS.

**`explicit deny in a service control policy` sobre `s3:GetBucketObjectLockConfiguration`**
Significa que algún recurso `aws_s3_bucket` volvió a aparecer en el código (o
estás usando un módulo que lo crea). Los buckets deben crearse con
`scripts/bootstrap-buckets.sh` y Terraform solo debe usar recursos standalone
(sección 5). Si un bucket quedó a medias de un intento anterior, borralo con
`aws s3 rb s3://<bucket>` y limpiá el state local.

**`BucketAlreadyExists` en `bootstrap-buckets.sh`**
El nombre ya lo tiene otra cuenta (los nombres son globales). Elegí otro
sufijo y actualizalo también en `terraform.tfvars` (o en la variable
`BUCKET_SUFFIX` del pipeline).

**`Error: Failed to get existing workspaces` o `NoSuchBucket` en `init`**
El bucket de state no existe todavía o el nombre no coincide. Corré el paso 5 y
revisá que `-backend-config="bucket=..."` use el mismo nombre.

**`Error acquiring the state lock`**
Otra ejecución (tu terminal o el pipeline) está usando el state, o una
ejecución anterior murió sin liberar el lock. Esperá unos minutos; si estás
seguro de que no hay nadie más, `terraform -chdir=terraform force-unlock <LOCK_ID>`
(el ID aparece en el mensaje de error). El lock es un objeto
`snowball/terraform.tfstate.tflock` en el bucket de state.

**`Error: Invalid value for "path" parameter: no file exists at ...` (`filemd5`/`filebase64sha256`)**
Faltan los bundles. Corré `npm run bundle` (sección 7) antes de `plan`/`apply`.

**`couldn't find resource` / `no matching IAM Role found` para `LabRole`**
El Lab no está iniciado o estás en otra cuenta/región. Verificá
`aws sts get-caller-identity` y que la región sea `us-east-1`.

**El `apply` crea todo, pero el Lab fue reseteado y el state quedó desactualizado**
Terraform cree que existen recursos que ya no están. Lo más simple: si no queda
nada en AWS, borrá el state remoto (`aws s3 rm s3://<state-bucket>/snowball/terraform.tfstate`)
y volvé a hacer `init` + `apply`. Si quedaron recursos sueltos (NAT, ALB, EIPs),
borralos a mano desde la consola antes, para no pagar por huérfanos.

**El dashboard muestra `404 NoSuchKey: index.html`**
Falta publicar el build (sección 10.2): el bucket existe pero está vacío.

**El dashboard abre pero el login falla en el navegador (y con `curl` anda)**
Probablemente CORS o una URL de API equivocada. Abrí la consola del navegador
(F12). Si cambió el DNS del ALB, recompilá el dashboard (10.2).

**Acentos rotos (`Ã±`) en el dashboard**
Subí los archivos con charset explícito:
```bash
BUCKET=$(terraform -chdir=terraform output -raw dashboard_bucket)
aws s3 cp packages/dashboard/dist/index.html "s3://${BUCKET}/index.html" --content-type 'text/html; charset=utf-8'
for f in packages/dashboard/dist/assets/*.js;  do aws s3 cp "$f" "s3://${BUCKET}/assets/$(basename "$f")" --content-type 'text/javascript; charset=utf-8'; done
for f in packages/dashboard/dist/assets/*.css; do aws s3 cp "$f" "s3://${BUCKET}/assets/$(basename "$f")" --content-type 'text/css; charset=utf-8'; done
```

**El ALB responde `502`/`503`**
Las instancias todavía están arrancando (también durante un *instance
refresh*) o no pasan el health check de `/health` (puerto 3000). Esperá unos minutos y mirá el estado del target group
(10.3). Si siguen `unhealthy`, entrá por el bastión y revisá
`sudo journalctl -u snowball-api -n 100`.

**El simulador imprime lecturas pero nunca `connected to IoT Core`, o la consola de IoT no recibe nada**
La conexión MQTT se rechaza en silencio. Probá una sola unidad con la sonda:
```bash
node scripts/mqtt-probe.mjs "$(terraform -chdir=terraform output -raw iot_endpoint)" SB-001
```
Debe imprimir `CONNECTED`. Revisá, en orden: (1) que el endpoint sea el de esta
cuenta/región (`aws iot describe-endpoint --endpoint-type iot:Data-ATS`); (2) que
el puerto 8883 no esté bloqueado en tu red (`Test-NetConnection <endpoint> -Port 8883`
en PowerShell; probá con datos del celular); (3) que `certs/SB-001/` tenga
archivos reales (arrancan con `-----BEGIN`) volviendo a correr
`scripts/export-certs.sh`; (4) que el certificado de la unidad esté **Active** y
con `snowball-device-policy` y el thing asociados (IoT Core → Security →
Certificates). Para ver el motivo exacto, activá los logs de IoT en **IoT Core →
Settings → Logs** (nivel Debug, rol `LabRole`) y mirá el grupo `AWSIotLogsV2` en
CloudWatch.

**Las lecturas llegan a IoT pero no aparecen en DynamoDB**
Revisá el log group `/aws/iot/snowball-iot-errors` (la regla vuelca ahí los
errores de sus acciones) y que la regla `snowball_telemetry` esté habilitada.

**No llega el mail de alerta**
Confirmá la suscripción de SNS (10.1; revisá spam). Verificá que la alerta
exista en `snowball-alerts` y que la cola y la DLQ estén sanas. Mirá los logs
de la Lambda (`aws logs tail /aws/lambda/snowball-alert-processor --since 30m`)
y que el *event source mapping* esté `Enabled` (sección 12). Un mensaje de una
unidad sin `device_config` se descarta con un warning en el log; uno de una
unidad que no está en `snowball-units` falla y, tras 5 intentos, va a la DLQ.

**La Lambda o el schedule fallan por permisos (`AccessDenied` con `LabRole`)**
Ambas Lambdas, el *event source mapping* y EventBridge Scheduler usan
`LabRole`. Si en una cuenta del Lab el rol no permitiera alguno de estos
servicios, el error aparece en el `apply` o en los logs de la función; pegá el
mensaje completo, el patrón es el mismo que el de los SCP de abajo.

**`GET /api/units` devuelve `last_reading: null`**
Normal hasta que llega la próxima lectura después del primer despliegue.

**La configuración remota del setpoint o `GET /api/units/:id/shadow` responde `503`**
La API no recibió `IOT_ENDPOINT` (el log de arranque dice `IOT_ENDPOINT not
set`). Verificá que `/etc/snowball.env` lo incluya (lo escribe el user data) y
que el *instance refresh* haya terminado después del último `apply`
(sección 14).

**`terraform fmt -check` falla en el pipeline**
Corré `terraform fmt -recursive` localmente y commiteá el resultado.

**Cualquier otro `AccessDenied ... explicit deny`**
Es el mismo patrón del SCP del Lab sobre otra acción. Pegá el error completo:
el recurso suele crearse y falla la lectura posterior; la salida depende del
servicio.
