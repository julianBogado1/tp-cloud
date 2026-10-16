# Snowball — Guía de despliegue con Terraform (AWS Learner Lab)

Esta guía levanta **toda** la infraestructura de Snowball con Terraform en el
AWS Learner Lab, de punta a punta: desde instalar las herramientas hasta
destruir todo al terminar la sesión. Está pensada para que cualquier persona
(incluida la cátedra) pueda reproducir el entorno sin conocer el proyecto.

> **Relación con la otra guía.** `docs/infra-aws-consola.md` es la guía
> **histórica de la Entrega 2**: crea todo a mano desde la consola y todavía
> incluye RDS. No se modificó. Esta guía es la vigente: reemplaza los clics
> por Terraform y elimina RDS (toda la persistencia vive en DynamoDB).

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
simulator (local) ──MQTT/TLS──▶ IoT Core ──regla──▶ DynamoDB snowball-telemetry (histórico, TTL 30 d)
                                          ├─regla──▶ DynamoDB snowball-unit-state (última lectura)
                                          └─regla──▶ SQS ──▶ alert-processor (EC2) ──▶ SNS (mail)
                                                                  │
                                                       DynamoDB (umbrales, alertas, dominio)
ARCHIVO
EventBridge Scheduler (diario 00:15 UTC) ──▶ Lambda telemetry-export ──▶ S3 archive (telemetry/aaaa/mm/dd/*.ndjson.gz ──▶ Glacier a los 30 d)

LECTURA (humanos)
dashboard (S3 website) ──HTTP+JWT/WebSocket──▶ ALB ──▶ api (EC2, ASG) ──▶ DynamoDB + Device Shadow
```

Recursos que crea Terraform (resumen; el detalle por módulo está en la
[sección 16](#16-referencia-módulos-variables-y-outputs)):

- **Red:** VPC `10.0.0.0/16`, 2 subredes públicas y 2 de aplicación en
  `us-east-1a`/`us-east-1b`, Internet Gateway, NAT Gateway (uno solo, zonal),
  tablas de ruteo, gateway endpoints de S3 y DynamoDB, security groups
  encadenados (`sg-alb`, `sg-app`, `sg-bastion`).
- **Datos:** 7 tablas DynamoDB (`telemetry`, `unit-state`, `users`, `clients`,
  `units`, `alerts`, `device-config`) con sus GSIs y los datos demo (seed).
- **Mensajería:** cola SQS + DLQ, 3 tópicos SNS, suscripción por mail al de
  excursión térmica, alarma CloudWatch de «sin señal».
- **IoT Core:** policy de dispositivos, un *thing* + certificado por unidad y
  la regla `snowball_telemetry` (3 acciones + log de errores).
- **Cómputo:** ALB, target group, launch template y Auto Scaling Group (2–4
  `t3.small` en subredes privadas). Bastión opcional.
- **Archivo:** Lambda `snowball-telemetry-export` + schedule diario.
- **S3:** configuración de los buckets de dashboard, artifacts y archive, y
  subida de los bundles.

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

El directorio `terraform/bootstrap/` es solo documentación de este paso (no
crea recursos). El bucket de state **se reutiliza entre sesiones**: se crea una
vez y no se borra al destruir.

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
| `state_bucket_name` | El bucket de state del paso 5 | — |
| `key_name` | `vockey` | Key pair que trae el Lab |
| `bastion_allowed_cidr` | Tu IP pública con `/32` | `curl ifconfig.me` → ej. `190.1.2.3/32`. **Es obligatoria aunque el bastión esté apagado** (se usa en una regla del security group) |
| `sns_subscription_email` | Tu mail real | Te llega un correo de confirmación |
| `jwt_secret` | Clave aleatoria larga (≥ 32 caracteres) | `openssl rand -base64 32` |

Ejemplo completo:

```hcl
region                 = "us-east-1"
bucket_suffix          = "grupo-01"
state_bucket_name      = "snowball-tfstate-grupo-01"
bastion_allowed_cidr   = "190.1.2.3/32"
key_name               = "vockey"
jwt_secret             = "<salida de openssl rand -base64 32>"
sns_subscription_email = "tu-mail@itba.edu.ar"
# enable_bastion = true        # descomentá para crear el bastión
# ami_id = "ami-xxxxxxxx"      # por defecto usa la última Amazon Linux 2023
```

Todas las variables, incluidas las opcionales, están en la
[sección 16](#16-referencia-módulos-variables-y-outputs).

> **El sufijo y el nombre del state del paso 5 tienen que ser idénticos a los de
> `terraform.tfvars`.** Si no coinciden, el script crea unos buckets y
> Terraform configura otros que no existen.

---

## 7. Generar los bundles

Las EC2 y la Lambda no compilan nada: reciben **artefactos ya construidos** que
Terraform sube a S3 (`aws_s3_object`) y que el *user data* de cada instancia
descarga al arrancar. Hay que generarlos **antes** de `plan`/`apply`:

```bash
npm run bundle
```

Verificá que existan los tres archivos:

```bash
ls -l packages/api/dist/api.bundle.js \
      packages/alert-processor/dist/alert-processor.bundle.js \
      packages/telemetry-export/dist/telemetry-export.zip
```

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

`.terraform.lock.hcl` fija las versiones de los providers (`aws` 6.x y
`random` 3.x) y **sí se commitea**. Si Terraform pide actualizarlo, corré el
`init` con `-upgrade`.

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

VITE_API_BASE="http://${ALB}" npm run build -w @snowball/dashboard
aws s3 sync packages/dashboard/dist/ "s3://${BUCKET}/" --delete

echo "Dashboard: http://${BUCKET}.s3-website-us-east-1.amazonaws.com"
```

Hasta que hagas esto, la URL del sitio responde `404 NoSuchKey` (`index.html`):
el bucket existe pero está vacío.

### 10.3 Esperar a que la API esté sana

Las instancias instalan Node y descargan los bundles al arrancar; tarda unos
minutos. Verificá que el target group tenga **2 objetivos `healthy`**:

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
  hasta salir de rango. `--silence SB-002@120`: a los 2 min deja de reportar.
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
- [ ] La cola drena y la DLQ queda vacía:
  ```bash
  Q=$(terraform -chdir=terraform output -raw queue_url)
  aws sqs get-queue-attributes --queue-url "$Q" \
    --attribute-names ApproximateNumberOfMessages ApproximateNumberOfMessagesNotVisible
  DLQ=$(aws sqs get-queue-url --queue-name snowball-readings-dlq --query QueueUrl --output text)
  aws sqs get-queue-attributes --queue-url "$DLQ" --attribute-names ApproximateNumberOfMessages
  ```
  La DLQ debe valer `0` (si tiene mensajes, un payload rompió el parseo).
- [ ] Errores de la regla de IoT, si los hubo: CloudWatch Logs, grupo
  `/aws/iot/snowball-iot-errors`.

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

- [ ] Abrí `http://<dashboard_bucket>.s3-website-us-east-1.amazonaws.com`, iniciá
  sesión y verificá que aparecen las tarjetas de las tres unidades actualizándose
  en vivo (WebSocket) y el historial.
- [ ] Panel de configuración (setpoint remoto vía Device Shadow): al cambiarlo, la
  unidad lo aplica a los pocos segundos y el simulador lo imprime.

**Alertas**

- [ ] A los ~60 s la unidad SB-001 sale de rango. Pasada la tolerancia configurada
  (`tolerance_min` en `snowball-device-config`) llega **un solo mail** por
  excursión al correo suscripto, y la alerta aparece en el dashboard y en
  `snowball-alerts` (DynamoDB).
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

**Alarma «sin señal»**

- [ ] `aws cloudwatch describe-alarms --alarm-names snowball-no-signal-alarm`
  existe. Con el simulador corriendo pasa a `OK`; si dejás 15 minutos sin
  mensajes pasa a `ALARM` (también arranca en `ALARM`/`INSUFFICIENT_DATA`
  recién creada y sin tráfico). Publica al tópico `snowball-no-signal`, que
  **no tiene suscriptores**: se ve en CloudWatch, no llega por mail.

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
sudo journalctl -u snowball-alert-processor -f
```

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
| `pull_request` | `validate`, `app`, `plan` | Verifican formato y sintaxis, corren tests y build, y calculan el plan contra el state real, **comentándolo en el PR** |
| `workflow_dispatch` (botón *Run workflow*) | `validate`, `app`, `deploy` | `deploy` ejecuta lo elegido en el input `action`: `plan`, `apply` o `destroy` |

Detalle de cada job:

- **`validate`** (sin credenciales, corre siempre, incluso en forks):
  `terraform fmt -check -recursive` e `init -backend=false` + `validate` sobre
  `terraform/` y `terraform/bootstrap/`.
- **`app`**: `npm ci`, `npm test`, `npm run build`.
- **`plan`** (solo en PR): usa la composite action y corre
  `terraform plan`; publica o actualiza un comentario con el resultado. Si
  faltan secrets o variables, **omite el plan con un warning** en lugar de
  fallar (el PR no queda en rojo por falta de credenciales).
- **`deploy`** (solo manual, `environment: learner-lab`): usa la composite
  action en modo estricto (falla si falta algo) y ejecuta:
  - `plan`: `terraform plan`.
  - `apply`: `plan` → `apply` del plan guardado → compila el dashboard con la
    URL del ALB y lo sincroniza a su bucket → deja las URLs en el resumen del
    run.
  - `destroy`: exige escribir `DESTROY` en el input `confirm` y ejecuta
    `terraform destroy -auto-approve`.

La composite action hace, en orden: verificar secrets/variables → verificar
credenciales (`aws sts get-caller-identity`) → instalar Node → `npm ci` +
`npm run bundle` → instalar Terraform → **crear los buckets**
(`scripts/bootstrap-buckets.sh`, idempotente) → `terraform init` con el backend
remoto. El workflow define `concurrency` para que nunca corran dos ejecuciones
a la vez sobre el mismo state.

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

(cada comando pide el valor por entrada estándar). Si están vencidos, el job
falla con el mensaje «Las credenciales del Learner Lab vencieron».

### Ejecutar un despliegue desde GitHub

1. Cargá secrets y variables (arriba) con credenciales **frescas**.
2. **Actions → Terraform → Run workflow**, elegí la rama, `action: apply`.
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
- Mientras el Lab no esté corriendo o los secrets estén vencidos, el `plan` falla
  o se omite, pero `validate` y `app` siguen verificando el código.

---

## 14. Redesplegar cambios

**Cambió el código de la API o del alert-processor.**

```bash
npm run bundle
terraform -chdir=terraform apply        # sube los bundles nuevos (filemd5 detecta el cambio)
```

`apply` solo reemplaza los objetos de S3: **las instancias que ya están
corriendo siguen con el bundle viejo**, porque descargan los artefactos solo
cuando arrancan. Para que tomen la versión nueva, reemplazalas gradualmente:

```bash
aws autoscaling start-instance-refresh \
  --auto-scaling-group-name snowball-app-asg \
  --preferences '{"MinHealthyPercentage":50}'
```

Esperá a que el target group vuelva a mostrar 2 `healthy` y validá `/health` y
el login. (Cambiar las *variables* que entran en el user data, como los nombres
de tablas o el JWT, sí genera una versión nueva del launch template, pero igual
requiere el instance refresh para aplicarse a las instancias existentes.)

**Cambió el código de la Lambda.** `npm run bundle` + `terraform apply`:
`source_code_hash` detecta el nuevo `.zip` y actualiza la función.

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
├── versions.tf          # Terraform >= 1.10; providers aws ~> 6.46 y random ~> 3.6
├── providers.tf         # provider aws (default_tags) + data de LabRole / LabInstanceProfile
├── backend.tf           # backend s3 con use_lockfile (bucket/key/region por -backend-config)
├── variables.tf         # entradas parametrizables
├── locals.tf            # tags comunes, nombres de recursos, nombres de buckets, unidades
├── main.tf              # módulos + configuración standalone de buckets
├── outputs.tf           # salidas
├── terraform.tfvars.example
├── bootstrap/           # solo documentación del paso de buckets (no crea recursos)
└── modules/
    ├── network/         # VPC, subredes, NAT, rutas, endpoints, security groups
    ├── data/            # tablas DynamoDB + seed
    ├── messaging/       # SQS, SNS, alarma (módulo externo)
    ├── iot-ingest/      # IoT: policy, things, certificados, regla
    ├── compute/         # bundles, ALB, launch template, ASG, bastión
    └── export/          # Lambda de exportación + schedule
```

### Módulos propios

| Módulo | Qué crea | Entradas principales | Salidas |
|---|---|---|---|
| `network` | VPC, 4 subredes (2 públicas, 2 de aplicación) con `cidrsubnet`, IGW, EIP + NAT, tablas de ruteo, gateway endpoints S3/DynamoDB, security groups `sg-alb`/`sg-app`/`sg-bastion` encadenados por referencia | `vpc_cidr`, `availability_zones`, `bastion_allowed_cidr` | `vpc_id`, `public_subnet_ids`, `app_subnet_ids`, `*_security_group_id` |
| `data` | Las 7 tablas DynamoDB (definiciones en un mapa → `for_each`, GSIs/TTL en bloques `dynamic`) y los ítems de seed desde `scripts/seed-data.json` | `table_names`, `seed_path` | `table_names`, `table_arns`, `table_ids` |
| `messaging` | Cola `snowball-readings` + DLQ (3 reintentos), tópicos SNS (térmico, batería, sin señal), suscripción por mail (`count`), alarma «sin señal» | `names`, `subscription_email` | `queue_url`, `queue_arn`, `dlq_arn`, `thermal_topic_arn`, `topic_arns`, `no_signal_alarm_arn` |
| `iot-ingest` | Policy `snowball-device-policy` (acota cada dispositivo a sus tópicos con `${iot:Connection.Thing.ThingName}`), un thing + certificado + 2 attachments por unidad (`for_each`), regla `snowball_telemetry` (DynamoDB ×2, SQS, log de errores) | `names`, `units`, `lab_role_arn`, `queue_url` | `iot_endpoint`, `certificates`*, `private_keys`*, `certificate_arns`* |
| `compute` | Subida de bundles a S3, target group, ALB + listener HTTP:80, launch template (user data con `templatefile`), ASG 2–4, bastión opcional (`count`) | subredes, security groups, bucket de artifacts, rutas de bundles, nombres de tablas, `jwt_secret`* | `alb_dns_name`, `target_group_arn`, `launch_template_id`, `bastion_instance_id` |
| `export` | Lambda `snowball-telemetry-export` (Node 22), log group, schedule diario en EventBridge Scheduler | `lambda_zip_path`, `archive_bucket`, tablas, `schedule_expression` | `lambda_arn`, `schedule_arn` |

\* sensibles.

### Módulo externo

`messaging` usa **`terraform-aws-modules/cloudwatch/aws//modules/metric-alarm`**
(versión `~> 5.0`, del Terraform Registry) para la alarma de «sin señal»: si la
cola `snowball-readings` no recibe mensajes durante 15 minutos (3 períodos de 5
min, datos faltantes tratados como incumplimiento), publica en el tópico
`snowball-no-signal`.

### Configuración en la raíz (`main.tf`)

Recursos *standalone* sobre los buckets creados por script: versionado
(artifacts, archive), cifrado SSE-S3 (los tres, con `for_each` para los
privados), Public Access Block (privado para artifacts/archive, abierto para
dashboard), lifecycle `telemetry-to-glacier` (transición a Glacier a los 30 días
sobre el prefijo `telemetry/`), website del dashboard y su policy de lectura
pública (con `depends_on` de la configuración website).

### Variables de entrada

| Variable | Tipo | Default | Descripción |
|---|---|---|---|
| `region` | string | `us-east-1` | Región AWS |
| `project` | string | `snowball` | Prefijo/tag de proyecto |
| `bucket_suffix` | string | **obligatoria** | Sufijo único global para los buckets |
| `state_bucket_name` | string | **obligatoria** | Bucket de state (el backend lo recibe por `-backend-config`; se declara para que `terraform.tfvars` y el CI usen un único lugar) |
| `lab_role_name` | string | `LabRole` | Rol del Lab que asumen Lambda, IoT y el Scheduler |
| `lab_instance_profile_name` | string | `LabInstanceProfile` | Instance profile de las EC2 |
| `vpc_cidr` | string | `10.0.0.0/16` | CIDR de la VPC (las subredes se derivan con `cidrsubnet`) |
| `availability_zones` | list(string) | `["us-east-1a","us-east-1b"]` | Las dos AZ |
| `enable_bastion` | bool | `false` | Crea el bastión (`count`) |
| `bastion_allowed_cidr` | string | **obligatoria** | CIDR autorizado a SSH al bastión |
| `key_name` | string | **obligatoria** | Key pair existente (`vockey`) |
| `jwt_secret` | string (sensible) | **obligatoria** | Clave de firma de los JWT |
| `sns_subscription_email` | string | **obligatoria** | Mail que recibe las alertas |
| `instance_type` | string | `t3.small` | Tipo de las instancias del ASG |
| `ami_id` | string | `null` | AMI; si es `null` usa la última Amazon Linux 2023 |
| `api_bundle_path` | string | `../packages/api/dist/api.bundle.js` | Bundle de la API |
| `alert_bundle_path` | string | `../packages/alert-processor/dist/alert-processor.bundle.js` | Bundle del procesador |
| `lambda_zip_path` | string | `../packages/telemetry-export/dist/telemetry-export.zip` | ZIP de la Lambda |
| `seed_data_path` | string | `../scripts/seed-data.json` | Datos demo de DynamoDB |
| `schedule_expression` | string | `cron(15 0 * * ? *)` | Cron del export diario (UTC) |
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
- **La alarma «sin señal» no notifica a nadie.** Publica en un tópico SNS sin
  suscriptores; solo se ve en CloudWatch.
- **Los buckets no los borra `terraform destroy`** (limitación del SCP, sección 5);
  para eso está `scripts/delete-buckets.sh`.
- **Instance refresh manual** tras cambiar los bundles (sección 14).
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
Las instancias todavía están arrancando o no pasan el health check de
`/health` (puerto 3000). Esperá unos minutos y mirá el estado del target group
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
exista en `snowball-alerts` y que la cola y la DLQ estén sanas.

**`GET /api/units` devuelve `last_reading: null`**
Normal hasta que llega la próxima lectura después del primer despliegue.

**La configuración remota del setpoint o `GET /api/units/:id/shadow` responde `503`**
La API no recibió `IOT_ENDPOINT` (el log de arranque dice `IOT_ENDPOINT not
set`). Verificá que el user data del launch template lo incluya y, si lo
agregaste después de desplegar, reemplazá las instancias con el instance
refresh (sección 14).

**`terraform fmt -check` falla en el pipeline**
Corré `terraform fmt -recursive` localmente y commiteá el resultado.

**Cualquier otro `AccessDenied ... explicit deny`**
Es el mismo patrón del SCP del Lab sobre otra acción. Pegá el error completo:
el recurso suele crearse y falla la lectura posterior; la salida depende del
servicio.
