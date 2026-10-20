# Plan: restricciones, verificación y orden de implementación de la Feature 5

**Feature:** #5 de la propuesta formal (dashboard en tiempo real) — las tres piezas que faltan.
**Alcance de este documento:** transversal. No diseña ninguna de las tres piezas; define **cómo se verifica** lo que se construya, **qué riesgos** corre el CI, **en qué orden** se implementa sin que dos agentes escriban el mismo archivo, y **qué se puede afirmar** en el README al terminar.
**Fecha:** 2026-10-20

Los tres planes de las piezas viven aparte y este documento no depende de ellos:

| Pieza | Plan | Qué toca, en una línea |
|---|---|---|
| F5-A | [`plan-mapa-unidades.md`](plan-mapa-unidades.md) | Mapa de unidades por estado en el dashboard React |
| F5-B | [`plan-replica-dashboard.md`](plan-replica-dashboard.md) | Segundo S3 Website en `us-west-2` |
| F5-C | [`plan-mqtt-websockets.md`](plan-mqtt-websockets.md) | Suscripción MQTT sobre WSS a IoT Core (con spike de permisos bloqueante) |

---

## 1. Inventario de verificación: qué se puede probar sin credenciales de AWS

Cuando se escribió este documento **no había credenciales de AWS en la sesión** (después aparecieron: ver la nota al final de esta sección), y las del Learner Lab vencen a las ~4 h (`.github/workflows/terraform.yml:3-6`). Nadie puede hacer `terraform apply` ni verificar nada contra la API de AWS. Todo lo que sigue separa lo que es verificable ahora de lo que queda pendiente de una sesión del Lab.

### 1.1 Baseline medido en esta sesión

| Comando | Resultado |
|---|---|
| `npm run build` | OK |
| `npm test` | **179 tests en 27 archivos**, todos verdes — este era el baseline **previo** a la Feature 5. Al cierre del trabajo son **201 en 28** (mapa +20, simulador +2) |
| `terraform -chdir=terraform fmt -check -recursive -diff` | verde (exit 0) |
| `terraform -chdir=terraform validate -no-color` | `Success! The configuration is valid.` |

Desglose del `npm test`, en el orden en que los corre `npm run test --workspaces --if-present` (`package.json:11`), que es el orden de `packages/*`:

| Workspace | Archivos | Tests |
|---|---|---|
| `@snowball/alert-processor` | 6 | 59 |
| `@snowball/api` | 12 | 74 |
| `@snowball/dashboard` | 3 | 19 |
| `@snowball/shared` | 1 | 3 |
| `@snowball/simulator` | 1 | 5 |
| `@snowball/telemetry-export` | 4 | 19 |
| **Total** | **27** | **179** |

Los seis workspaces declaran `"test": "vitest run"`. Cualquier cambio de la Feature 5 tiene que dejar estos números **iguales o mayores**: una baja en la cuenta total es un test que se dejó de ejecutar (típicamente un archivo que vitest ya no encuentra), no un test que «se arregló».

**El orden del `build` importa y es explícito** (`package.json:10`): la cadena es
`@snowball/shared` → `@snowball/alert-processor` → `@snowball/simulator` → `@snowball/api` → `@snowball/telemetry-export` → `@snowball/dashboard`.
`@snowball/shared` va primero porque los otros cinco lo consumen por su `dist/` (de ahí el comentario del workflow en `.github/workflows/terraform.yml:81`: «El build debe ir ANTES de los tests para que @snowball/shared esté disponible»). Si una pieza de la Feature 5 agrega un workspace nuevo hay que sumarlo **a mano** a esa cadena: no es `--workspaces`, es una lista literal.

### 1.2 Qué verifica y qué no verifica cada comando

| Comando | Verifica | **No** verifica |
|---|---|---|
| `npm ci` | Que `package-lock.json` esté sincronizado con todos los `package.json` y que las versiones existan en el registry | Nada del código |
| `npm run build` | Tipos de los 6 paquetes; en el dashboard, `tsc --noEmit -p tsconfig.json && vite build` (`packages/dashboard/package.json:7`), o sea typecheck **de `src` solamente** (`packages/dashboard/tsconfig.json:15`: `"include": ["src"]`) + bundle real de Vite | Que el bundle **funcione** en un navegador; que las dependencias nuevas no necesiten polyfills de Node en runtime; nada de `test/` (está fuera del `include`) |
| `npm test` | Lógica pura y los handlers contra fakes | Cualquier integración real: no hay tests de DOM ni de red |
| `terraform fmt -check -recursive` | Formato canónico de todos los `.tf`, incluidos los de `modules/` | Semántica |
| `terraform init -backend=false` | Que los providers y los **módulos externos** se puedan resolver y descargar (hay uno de registry: `terraform/modules/messaging/main.tf:36-38`, `terraform-aws-modules/cloudwatch/aws//modules/metric-alarm ~> 5.0`). **Necesita internet, no credenciales** | Nada de AWS |
| `terraform validate` | Sintaxis HCL, tipos de variables, referencias entre módulos y recursos, providers declarados y alias existentes, expresiones que no dependen del estado | **Nada que dependa del estado real o de la API de AWS** (ver 1.4). **Tampoco los bloques `validation` de las variables**: eso se evalúa en `plan`, comprobado con `validate -var dashboard_replica_region=eu-west-1`, que devuelve `Success!`. O sea que una `validation` **no tiene ningún gate en el job `validate` del CI** |

### 1.3 `terraform plan` no es un paso «gratis»

`plan` necesita dos cosas que hoy no hay:

1. **Credenciales frescas.** El gate de la composite action corta antes incluso de intentarlo: exige los valores de `.github/actions/terraform-setup/action.yml:33-35` y después un `aws sts get-caller-identity` (`:48-56`).
2. **El state remoto.** El backend es S3 sin parámetros en el repo (`terraform/backend.tf:1-5`, con `use_lockfile = true`), así que el `init` real pasa bucket, key y región por `-backend-config` (`.github/actions/terraform-setup/action.yml:94-102`; la versión manual está en el README). Además el gate del PR exige que el bucket de state ya exista (`action.yml:59-63`).

Corolario: **un `plan` local no se puede improvisar**. La secuencia mínima es credenciales → `bootstrap-buckets.sh` → `npm run bundle` → `init -backend-config` → `plan`, y eso ya es la mitad del checklist de la sección 2.

### 1.4 Los agujeros ciegos, dichos explícitamente

`terraform validate` **no detecta**, y ningún comando local tampoco:

- Que un **recurso o provider apunte a una región donde el servicio no existe o no está habilitado para la cuenta**. `validate` acepta cualquier string en `region`, venga de un provider aliased o del argumento `region` del recurso; el error aparece recién en el `plan`/`apply`.
- Que el **SCP del Learner Lab deniegue la acción**. Es el caso de `s3:GetBucketObjectLockConfiguration`, que es la razón documentada de que `aws_s3_bucket` no se use nunca en este repo (`docs/terraform-buckets-learner-lab.md:3-5`). Para F5-C el equivalente es `iot:CreateAuthorizer` y `lambda:AddPermission` para `iot.amazonaws.com`: **no hay forma local de saberlo**, por eso es un spike y no una tarea.
- Que un **nombre de bucket global ya esté tomado** por otra cuenta.
- Que **`LabRole` tenga la trust policy** que una integración nueva necesita. Hoy el rol se lee como dato (`terraform/providers.tf:6`) y se le pasa a Lambda, IoT y Scheduler; nadie verifica sus principals de `AssumeRole`. Un `aws_iot_authorizer` que invoque una Lambda es exactamente el caso donde esto falla y `validate` sonríe.
- Que el **zip de una Lambda exista**. Ver 3.2.
- Que un **script de bash sea sintácticamente válido**. Ver 3.2.

**Nota de versión de Terraform:** el CI pinea `1.10.5` (`.github/workflows/terraform.yml:59-61` y `.github/actions/terraform-setup/action.yml:81-86`), `terraform/versions.tf:1-5` exige `>= 1.10.0` con `aws ~> 6.46`, y el binario con el que se midió el baseline es más nuevo. «Verde en mi máquina» no es una garantía formal de verde en el job con 1.10.5; si `fmt` discrepa, manda el CI.

---

## 2. Checklist maestro de verificación manual en AWS

Es el **orden global**. Cada plan de pieza aporta su propio checklist específico, que se inserta en el paso 12. Todo esto necesita una sesión del Learner Lab iniciada y credenciales recién pegadas.

| # | Paso | Comando | Cómo se sabe que pasó |
|---|---|---|---|
| 1 | Credenciales | pegar *AWS Details → AWS CLI* en `~/.aws/credentials`; `aws sts get-caller-identity` | Devuelve el `Account` y un ARN de `LabRole`/`voclabs`. Si falla, nada de lo que sigue tiene sentido |
| 2 | Dependencias | `npm ci` | Termina sin error. Si se queja del lock, el commit está mal: ver 3.2 |
| 3 | Build + tests | `npm run build && npm test` | Build sin errores de `tsc` y **≥ 201 tests en ≥ 28 archivos**, todos verdes (el umbral es el estado al cierre de la Feature 5, no el baseline previo: con ≥ 179 pasaría una regresión de 22 tests) |
| 4 | Gate de Terraform sin credenciales | `terraform -chdir=terraform fmt -check -recursive -diff` y `terraform -chdir=terraform init -backend=false -input=false && terraform -chdir=terraform validate -no-color` | `fmt` sin diff y `Success! The configuration is valid.` Es exactamente el job `validate` del CI (`.github/workflows/terraform.yml:63-69`) |
| 5 | **Buckets, antes del `init`** | `DASHBOARD_REPLICA_REGION=us-west-2 bash scripts/bootstrap-buckets.sh <sufijo> <bucket-de-state>` (es el default del script; con `""` se apaga la réplica, y entonces hay que apagarla también en `dashboard_replica_region`) | Imprime `Creating bucket:` o `Bucket already exists:` por cada uno de los cuatro y termina con la línea de cierre (`scripts/bootstrap-buckets.sh:57-67`). **Este paso va antes del `init` por decisión escrita**: el SCP deniega `s3:GetBucketObjectLockConfiguration`, así que `aws_s3_bucket` no se usa y Terraform solo administra las configuraciones standalone (`docs/terraform-buckets-learner-lab.md:3-17`). El bucket de state queda configurado **entero** acá: versionado, cifrado y Public Access Block (`bootstrap-buckets.sh:57-59`) |
| 6 | Variables locales | copiar el `.tfvars` de ejemplo y completarlo | `bucket_suffix` **idéntico** al `<sufijo>` del paso 5. El archivo está gitignoreado, no se commitea nunca. El bucket de state **no** es variable de Terraform |
| 7 | **Artefactos** | `npm run bundle` | Deja en disco los tres zips y el bundle de la API que el `apply` necesita: `packages/alert-processor/dist/alert-processor.zip`, `packages/alert-processor/dist/no-signal-monitor.zip`, `packages/telemetry-export/dist/telemetry-export.zip` y `packages/api/dist/api.bundle.js` (defaults en `terraform/variables.tf:96-115`). La cadena está en `package.json:16` y el CI la corre dentro de la composite action antes del `init` (`.github/actions/terraform-setup/action.yml:74-79`) |
| 8 | Init del backend | `terraform -chdir=terraform init -backend-config="bucket=<state>" -backend-config="key=snowball/terraform.tfstate" -backend-config="region=us-east-1"` | `Terraform has been successfully initialized!` |
| 9 | Plan | `terraform -chdir=terraform plan` | Se **lee el plan**: el delta tiene que ser solo lo que la pieza agrega. Un `destroy`/`replace` de algo existente es señal de alarma (típicamente un recurso que cambió de dirección y necesita un bloque `moved`, como los de `terraform/main.tf:200-211`) |
| 10 | Apply | `terraform -chdir=terraform apply` | `Apply complete!` y los outputs. Acá fallan las cosas que `validate` no ve: zips ausentes, SCP, región sin servicio |
| 11 | Suscripción SNS | revisar el mail de `sns_subscription_email` y confirmar | Las suscripciones de `thermal` y `signal` pasan a `Confirmed`. Sin esto no llega ninguna alerta |
| 12 | Publicación del dashboard | `ALB=$(terraform -chdir=terraform output -raw alb_dns_name)`; `BUCKET=$(terraform -chdir=terraform output -raw dashboard_bucket)`; `VITE_API_BASE="http://${ALB}" npm run build -w @snowball/dashboard`; `aws s3 sync packages/dashboard/dist/ "s3://${BUCKET}/" --delete` | El sitio carga, el login funciona y el badge de la topbar dice «feed en vivo». Es el mismo bloque que corre el CI en `.github/workflows/terraform.yml:164-178`. **Acá se insertan los checklists de cada pieza**: el mapa (F5-A), el segundo bucket y su URL (F5-B), el feed MQTT (F5-C) |
| 13 | Datos en vivo | `bash scripts/export-certs.sh` y el simulador contra `$(terraform -chdir=terraform output -raw iot_endpoint)` con `--excursion SB-001@60` | Llegan lecturas al dashboard y, a los ~60 s, la alerta térmica. Para probar «sin señal» hay `--silence SB-002@120` |
| 14 | **Cierre: destroy y después borrar los buckets** | `terraform -chdir=terraform destroy` **y después** `bash scripts/delete-buckets.sh <sufijo> <bucket-de-state>` | `Destroy complete!` y después `Listo.` del script. **Los dos pasos son obligatorios**: Terraform no es dueño de los buckets, así que el destroy los deja en pie (`scripts/delete-buckets.sh:1-5`). El script pide escribir `DELETE` (`:48-54`) y **conserva el bucket de state** salvo que se pase `--include-state` (`:38-46`) |

Dos notas que afectan directamente a F5-B:

- `scripts/bootstrap-buckets.sh:4` toma la región de `AWS_REGION` (default `us-east-1`) y crea **los cuatro buckets en esa única región**. La rama de `LocationConstraint` para regiones distintas de `us-east-1` ya existe (`:26-33`), así que el mecanismo está, pero un bucket en una segunda región implica tocar el script.
- `scripts/delete-buckets.sh:17` tiene la misma asunción de región única y su lista de buckets es literal (`:37`). **Un bucket nuevo que no se agregue a ese script queda huérfano después del destroy** y bloquea la siguiente sesión por nombre tomado.

---

## 3. Riesgo de cada tipo de cambio sobre el CI

### 3.1 Los jobs del workflow

`.github/workflows/terraform.yml` dispara en `pull_request` y `workflow_dispatch` (`:8-20`). Los `TF_VAR_*` y las credenciales llegan por el `env` del workflow (`:34-49`).

| Job | Líneas | Se dispara en | Qué corre | `needs` |
|---|---|---|---|---|
| `validate` | `:53-69` | **siempre** (PR y dispatch; también en forks, no usa credenciales) | `fmt -check -recursive -diff`, `init -backend=false`, `validate` | — |
| `app` | `:72-83` | **siempre** | `npm ci` → `npm run build` → `npm test`, Node 22 con cache de npm | — |
| `plan` | `:86-130` | **solo `pull_request`** (`:87`) | composite action con `strict: "false"` → `terraform plan` → comentario idempotente en el PR (`:108-130`) | `validate` (`:88`) |
| `deploy` | `:133-183` | **solo `workflow_dispatch`** (`:134`), `environment: learner-lab` | según el input `action`: `plan`, `apply` (+ build y sync del dashboard, `:164-178`), o `destroy` (exige `confirm: DESTROY`, `:143-147`) | **`[validate, app]`** (`:137`) |

- **`concurrency: terraform-state` con `cancel-in-progress: false`** (`:22-25`): el state remoto es único y tiene lock nativo de S3 (`terraform/backend.tf:1-5`). Dos runs simultáneos o se pisarían o se quedarían esperando el lock; serializar en GitHub es más barato que depender del `-lock-timeout=120s`. **Consecuencia práctica para la Feature 5: con tres piezas en vuelo, los `plan` de tres PRs se encolan de a uno.** No es un error, es lentitud esperable.
- **El `needs` del `plan` es solo `validate`** (`:88`): un PR con los tests rotos todavía produce un `plan` (el `plan` no depende del código de la app). El `needs` del `deploy` es `[validate, app]` (`:137`): **no se despliega nada con tests rojos ni con Terraform inválido**, y ese es el punto.
- La composite action, además del gate, hace `npm ci` + `npm run bundle` (`action.yml:74-79`) **antes** del `init`, y corre `bootstrap-buckets.sh` **solo fuera de los PRs** (`action.yml:88-92`), para que un `plan` de PR no tenga efectos secundarios.

### 3.2 Riesgo por tipo de cambio

#### a) Dependencia nueva de front (F5-A, y F5-C si usa un cliente MQTT de navegador)

| Riesgo | Por qué | Cómo se detecta antes del CI |
|---|---|---|
| **`package-lock.json` desincronizado** | `npm ci` falla de entrada si el lock no coincide con los `package.json` (`.github/workflows/terraform.yml:80`, `action.yml:78`). **Es el error más común y más tonto de todos**: se agrega la dependencia al `package.json` del dashboard, se prueba con un `npm install` local, y se commitea el `package.json` **sin** el `package-lock.json`. El PR queda rojo en el primer step del job `app` | `rm -rf node_modules && npm ci` local, o simplemente `git status` antes de commitear: **el lock tiene que estar en el commit** |
| **Sin tipos** | El build del dashboard es `tsc --noEmit -p tsconfig.json && vite build` (`packages/dashboard/package.json:7`) con `strict: true`. Una librería sin `.d.ts` ni paquete `@types/*` rompe el `tsc` antes de llegar a Vite | `npm run build -w @snowball/dashboard` |
| **Necesita shims de Node en el navegador** | Vite no polyfillea `buffer`, `process`, `events`, `stream`. Varios clientes MQTT de Node los piden. La config de Vite es mínima (`packages/dashboard/vite.config.ts:1-5`: solo el plugin de React), así que no hay nada previsto | `npm run build -w @snowball/dashboard` detecta el fallo de resolución; un polyfill que falta **en runtime** no lo detecta ningún comando: hay que abrir el sitio |
| **CSS de la librería** | Si el CSS se importa desde el componente, Vite lo mete en el bundle y listo. Si se espera un `<link>` en el HTML, hay que tocar `packages/dashboard/index.html`, que hoy nadie toca | Mirar el sitio servido |
| **Tamaño del bundle** | Dos dependencias nuevas de front no rompen nada, pero el sitio se publica en S3 Website sin CloudFront (no hay CloudFront en el Lab) | Mirar la salida de `vite build` |

#### b) Recursos en una segunda región (F5-B)

> **Nota de consolidación (Gate 1).** Esta sección se escribió asumiendo un `provider "aws"` con `alias`. El plan de F5-B eligió finalmente **`region` por recurso** (*enhanced region support* del provider v6), que es mejor por las razones de `plan-replica-dashboard.md` §2.3. Se verificó contra el **schema del provider instalado** (`terraform providers schema -json`) que `region` es **Optional** en `aws_s3_bucket_website_configuration`, `_policy`, `_public_access_block`, `_server_side_encryption_configuration`, `_versioning` y `_replication_configuration`, y que `website_endpoint` **existe** como atributo del website configuration. El riesgo de `default_tags` que sigue abajo **queda neutralizado** por esa decisión; se conserva porque vuelve a aplicar si alguien prefiere el alias.

`terraform validate` **acepta las dos formas sin credenciales y sin tocar AWS**: la región es un string y todo compila. Lo que no se ve:

- **Con un provider aliased, si falta `default_tags`, los recursos de la segunda región pierden las etiquetas comunes.** El provider default las aplica a todo (`terraform/providers.tf:1-4`, con `local.common_tags` definido en `terraform/locals.tf:1-6`: `Project`, `ManagedBy = "terraform"`, `Phase = "delivery-3"`). Un `provider "aws" { alias = "replica" ... }` **no hereda nada**. Es un **bug silencioso**: `fmt` verde, `validate` verde, `plan` verde, `apply` verde, y los recursos replicados quedan sin etiquetar. Ningún comando local lo detecta. Con `region` por recurso el provider sigue siendo uno y el problema no existe. (Matiz honesto de F5-B: los cuatro recursos standalone del bucket **no son etiquetables** —son configuraciones, no el bucket—, así que hoy `default_tags` no les aplica de ninguna manera; el riesgo vale para el día en que se agregue un recurso etiquetable en la región réplica.)
- Que la región exista para el servicio y para la cuenta (ver 1.4).
- Que el nombre del bucket esté libre.
- **La URL del sitio está hardcodeada a `us-east-1`** en el resumen del deploy: `.github/workflows/terraform.yml:174` imprime `http://${BUCKET}.s3-website-us-east-1.amazonaws.com`. Un bucket en `us-west-2` tiene otro host. Si F5-B toca el workflow, esa línea es parte del cambio.
- El patrón que ya existe para configurar buckets ajenos a Terraform es el del dashboard actual: cifrado, Public Access Block, website y policy como recursos standalone contra un `bucket = local.bucket_names.dashboard` que **Terraform no creó** (`terraform/main.tf:70-104`). Cualquier variante de F5-B tiene que respetarlo, porque la causa (el SCP) no cambia por cambiar de región.

#### c) Lambda nueva (F5-C)

**Si el zip no existe, falla el `apply`, no el `validate`.** Las rutas son variables con default (`terraform/variables.tf:101-115`) y se consumen en `local.lambdas` (`terraform/locals.tf:28-68`, campo `zip_path` en `:31`, `:42` y `:55`), que alimenta un `module "lambda"` con `for_each` (`terraform/main.tf:147-157`). `validate` solo ve que el string es un string.

**Hay precedente exacto y vale citarlo entero.** Cuando se agregó `no-signal-monitor` (commit `8b0b6a3`, *feat: per-unit no-signal alerts*) hubo que:

1. Agregar los dos scripts al paquete (`packages/alert-processor/package.json:13-14`): un `bundle:no-signal` con esbuild hacia `dist/no-signal/index.js` y un `zip:no-signal` con el fallback `zip -j ... || python -m zipfile -c ...`.
2. **Sumarlos a la cadena `bundle` de la raíz** (`package.json:16`).
3. Declarar la variable del zip (`terraform/variables.tf:106-110`) y la entrada en `local.lambdas` (`terraform/locals.tf:53-67`).

**El paso 2 es el que se olvida**, y su síntoma es exactamente el de arriba: todo verde en el CI hasta que el `apply` del `deploy` dice que el archivo no existe. El `zip || python -m zipfile` del fallback existe porque en Windows no siempre hay `zip`: una Lambda nueva debería copiar ese mismo patrón en vez de inventar otro.

Dos observaciones más para F5-C, no de diseño sino de verificación:

- La **política de IoT de las unidades** está limitada por `thing` (`terraform/modules/iot-ingest/main.tf:14-32`: `client/${iot:Connection.Thing.ThingName}`, `topic/snowball/<thing>/*` y el shadow). Un navegador no es un Thing, así que esa política **no cubre** a un suscriptor del dashboard: el authorizer necesita su propia policy. No se reusa nada.
- Hoy **no existe ningún `aws_iot_authorizer` en el repo**, así que no hay patrón previo que copiar.

#### d) Cambios en bash (F5-B)

`scripts/bootstrap-buckets.sh` y `scripts/delete-buckets.sh` **no los corre ningún test ni los mira ningún linter**. No hay shellcheck en el repo y el job `app` solo hace `npm ci`/`build`/`test`. Un error de sintaxis no lo detecta **nada** hasta que el `deploy` real llega al step que corre el script (`.github/actions/terraform-setup/action.yml:88-92`) — es decir, con las credenciales ya cargadas y a mitad de un despliegue.

Agravantes concretos:

- `bootstrap-buckets.sh:2` y `delete-buckets.sh:15` usan `set -euo pipefail`: un error aborta a mitad de camino, posiblemente con algunos buckets creados y otros no.
- `delete-buckets.sh:58-69` usa process substitution (`< <(...)`), arrays (`POSITIONAL+=(...)`) y `${key%$'\r'}`: sintaxis de bash, no de sh. Y el archivo se versiona con `eol=lf` forzado (`.gitattributes`) justamente para no romperlo en Windows.
- El script se declara compatible con Git Bash, Linux y macOS (`delete-buckets.sh:14`), así que el mismo cambio tiene que seguir andando en los tres.

**Verificación mínima propuesta:** `bash -n scripts/bootstrap-buckets.sh && bash -n scripts/delete-buckets.sh` (chequea sintaxis sin ejecutar nada; cuesta un segundo y atrapa el 100 % de los errores de sintaxis, que es la clase de falla más cara acá). Opcionalmente `shellcheck` si está instalado.

Si conviene o no agregar eso como step del CI es **decisión del usuario**: sumar un step al workflow es un cambio de alcance (toca `.github/workflows/terraform.yml`, que ya está en disputa entre F5-B y F5-C). Queda en la tabla de la sección 6. Lo que sí se recomienda sin reservas es correr los dos `bash -n` **a mano** antes de commitear cualquier cambio en esos scripts.

---

## 4. Mapa de colisiones de archivos y orden de implementación

### 4.1 Archivo → qué plan lo toca

Leyenda: **✎** escribe · ○ probablemente solo lee · **⚠** colisión real (dos o más planes escriben).

| Archivo | F5-A (mapa) | F5-B (réplica) | F5-C (MQTT/WSS) | Nota |
|---|---|---|---|---|
| componente de mapa nuevo en `packages/dashboard/src/` | ✎ | | | Archivo nuevo, sin colisión |
| `packages/dashboard/src/App.tsx` | ✎ | | ✎ | **⚠** zonas distintas pero archivo único: ver 4.2 |
| `packages/dashboard/src/api.ts` | ○ (tipos `UnitWithReading`, `:14-24`) | | ✎ | **⚠** si F5-A solo importa tipos, el riesgo es bajo |
| `packages/dashboard/src/status.ts` | ✎ (o helper nuevo) | | | `UnitStatus` ya existe (`:10`), `readingStatus` (`:23-33`) |
| `packages/dashboard/src/styles.css` | ✎ | | ✎ (badge de conexión) | **⚠** un solo archivo chico; colisión muy probable |
| `packages/dashboard/src/UnitCard.tsx` | ○ (`STATUS_LABEL`, `:14`) | | | Fuente de verdad de las etiquetas en castellano |
| `packages/dashboard/package.json` | ✎ | | ✎ | **⚠** dependencia nueva cada uno |
| **`package-lock.json` (raíz)** | ✎ | | ✎ | **⚠⚠ el peor de todos: ver 4.3** |
| `packages/dashboard/vite.config.ts` | posible | | posible (shims) | **⚠** si los dos necesitan tocarlo |
| `packages/dashboard/test/*` | ✎ (nuevo) | | ✎ (nuevo) | Archivos nuevos distintos: sin colisión |
| `terraform/providers.tf` | | ○ (**no se toca** con `region` por recurso; ✎ solo si se elige el provider aliased) | | Hoy 7 líneas (`:1-7`) |
| `terraform/variables.tf` | | ✎ | ✎ | **⚠** los dos agregan variables al final |
| `terraform/outputs.tf` | | ✎ (URL del segundo sitio) | ✎ (endpoint/authorizer) | **⚠** |
| `terraform/locals.tf` | | ✎ (`bucket_names`, `:23-27`) | ✎ (`lambdas`, `:28-68`) | **⚠** bloques distintos del mismo archivo |
| `terraform/main.tf` | | ✎ (recursos del bucket réplica) | ✎ (authorizer + Lambda) | **⚠** los dos agregan al final |
| `scripts/bootstrap-buckets.sh` | | ✎ | | Sin colisión |
| `scripts/delete-buckets.sh` | | ✎ | | Sin colisión, **y obligatorio si hay bucket nuevo** |
| `.github/workflows/terraform.yml` | | ✎ (sync al segundo bucket, cerca de `:164-178`) | posible (`VITE_IOT_ENDPOINT` en el build del dashboard, línea `:169`) | **⚠** y además los dos tocarían **el mismo step** |
| `README.md` | ✎ | ✎ | ✎ | **⚠⚠** punto de encuentro final |
| `docs/features-faltantes-propuesta.md` | ✎ | ✎ | ✎ | **⚠⚠** fila 5 (`:19`) y prioridades (`:45-53`) |

### 4.2 Las zonas exactas de `App.tsx` y `api.ts`

`packages/dashboard/src/App.tsx` tiene 165 líneas y el componente `Dashboard` arranca en `:45`. Los dos planes entran por puertas distintas:

| Zona | Líneas | F5-A | F5-C |
|---|---|---|---|
| Imports | `:1-10` (el de `./api` en `:3`) | agrega el componente del mapa | cambia/agrega el import del feed |
| Estado del `Dashboard` | `:46-53` (incluye `connected` en `:51` y `nowMs` en `:53`) | — | toca el estado del feed |
| `onReading` | `:68-74` | lo consume indirectamente (la posición viene en la lectura) | es quien lo alimenta |
| **`useEffect` del `connectLive`** | **`:76-79`** | — | **acá entra**: es el único lugar donde se abre el feed |
| **Badge de conexión** | **`:117-119`** (`badge-ok` / `badge-stale`, «feed en vivo» / «reconectando…») | — | **puede entrar acá** si cambia la semántica de «conectado» |
| **`<section className="units">`** | **`:125-137`** | **acá entra**: el mapa va arriba o abajo de la grilla de tarjetas | — |
| Sección `detail` | `:139-155` | — | — |

Son zonas separadas por ~40 líneas, así que un merge de git probablemente se resuelva solo. **«Probablemente» no es una garantía**, y el costo de equivocarse (un merge mal resuelto en el componente raíz del dashboard) es alto porque **ningún test cubre `App.tsx`**: los tres archivos de `packages/dashboard/test/` prueban helpers puros y `connectLive`, no componentes.

`packages/dashboard/src/api.ts`: F5-C reemplaza o acompaña `connectLive` (**`:114-153`**), que es el bloque final del archivo y arrastra `deriveWsUrl` (`status.ts:42-47`) y el `API_BASE` de `:12`. F5-A, si se limita a leer `UnitWithReading` (`:14-24`) para tipar las posiciones, **no escribe este archivo**: ese es el acuerdo que hay que dejar escrito en el plan de F5-A.

### 4.3 `package-lock.json`: la razón más fuerte para secuenciar F5-A y F5-C

El repo es un **monorepo de npm workspaces** (`package.json:6-8`) con **un único `package-lock.json` en la raíz**, de unos 211 KB. Las dependencias de los paquetes se declaran en cada `package.json`, pero el árbol resuelto —hashes, versiones transitivas, estructura de `node_modules`— vive entero en ese archivo compartido.

Consecuencias, en orden de gravedad:

1. **Si F5-A y F5-C instalan dependencias en paralelo, el conflicto de merge en `package-lock.json` está garantizado.** No es un «quizás»: los dos `npm install` reescriben secciones solapadas del mismo archivo generado.
2. **Un conflicto en un lock no se resuelve a mano.** La única resolución correcta es descartar la versión mergeada y regenerar (`npm install` sobre los `package.json` ya mergeados). El segundo agente **tiene que esperar** a que el primero esté integrado, o rehacer su instalación al final.
3. **Y si el lock queda mal, el CI se cae en el primer step del job `app`** (`npm ci`, `.github/workflows/terraform.yml:80`) y también dentro de la composite action (`action.yml:78`), que es lo que hace que ni el `plan` ni el `deploy` lleguen a Terraform.

**Por eso F5-A y F5-C no pueden avanzar en paralelo si las dos agregan dependencias de front.** Es la restricción dura del orden de la sección 4.4, más fuerte que la de `App.tsx`.

### 4.4 Orden de implementación propuesto

La regla es «dos agentes nunca escriben los mismos archivos». Con el mapa de 4.1, el orden que respeta eso y además no deja a nadie esperando el spike de F5-C es:

```
Tanda 0 (sin tocar código)
  ├── los tres planes de pieza (archivos .md nuevos, disjuntos)
  └── el spike de permisos de F5-C: SOLO lecturas contra AWS
           (iot:CreateAuthorizer / lambda:AddPermission para iot.amazonaws.com)

Tanda 1 (en paralelo: conjuntos de archivos disjuntos)
  ├── F5-A: packages/dashboard/**  +  package-lock.json
  └── F5-B: terraform/**  +  scripts/*.sh  +  .github/workflows/terraform.yml

Tanda 2 (secuencial, solo si el spike dio verde)
  └── F5-C: packages/dashboard/** (sobre F5-A ya integrado)
            + terraform/** (sobre F5-B ya integrado)
            + .github/workflows/terraform.yml

Tanda 3 (al final, un solo agente)
  └── README.md  +  docs/features-faltantes-propuesta.md
```

Justificación, punto por punto:

| Decisión | Por qué |
|---|---|
| **F5-A y F5-B en paralelo** | Sus conjuntos de archivos son **disjuntos**: F5-A vive en `packages/dashboard/` + el lock; F5-B en `terraform/`, `scripts/` y el workflow. El único cruce sería el workflow, y F5-A no lo necesita (la publicación del dashboard ya existe tal cual en `.github/workflows/terraform.yml:164-178` y el mapa no cambia nada del build) |
| **F5-C después de F5-A, nunca a la vez** | El `package-lock.json` compartido (4.3) y, en segundo lugar, `App.tsx`, `api.ts`, `styles.css` y `packages/dashboard/package.json` |
| **F5-C después de F5-B** | Los dos escriben `terraform/variables.tf`, `outputs.tf`, `locals.tf`, `main.tf` y posiblemente el workflow. Cuatro archivos en común es demasiado para un merge a ciegas |
| **El spike de F5-C va en la tanda 0, aparte de todo** | Es la única tarea que **no produce código** y de la que depende que F5-C exista. Ponerlo primero es gratis, y si falla, se ahorra la tanda 2 entera |
| **F5-A y F5-B no esperan el spike** | La tanda 1 no tiene ninguna dependencia de F5-C. **Si el spike falla —el resultado más probable—, el orden no cambia: F5-C se documenta como pieza no implementada y se pasa directo a la tanda 3** |
| **`README.md` y `docs/features-faltantes-propuesta.md` al final, por un solo agente** | Son el punto de encuentro de los tres. Tres agentes editando el mismo README en paralelo es un conflicto seguro, y además **la redacción correcta depende de qué terminó implementado** (sección 5). Un solo pase final, cuando ya se sabe el resultado |
| **Si hay que priorizar una sola pieza** | **F5-A.** Es la de menor riesgo (no toca AWS, no toca Terraform, no depende de ningún permiso), es la prioridad #2 escrita en `docs/features-faltantes-propuesta.md:48`, y es la que más se ve en la defensa |

---

## 5. Honestidad documental: qué **no** se va a poder afirmar

El objetivo es que en la defensa nadie pueda señalar una afirmación del repo que el código no cumpla.

| ❌ No se puede escribir | ✅ Versión honesta | Por qué |
|---|---|---|
| «La plataforma es **multi-región**» | «El **sitio estático** del dashboard está replicado en una segunda región (`us-west-2`). El backend sigue siendo de una sola región.» | Si lo único replicado es el bucket, en `us-east-1` siguen enteros el ALB y el ASG (`terraform/main.tf:119-142`), las tablas DynamoDB (`module "data"`, `:9-13`), IoT Core (`module "iot_ingest"`, `:106-114`), SQS y SNS (`module "messaging"`, `:15-19`) y las tres Lambdas (`:147-157`) |
| «Hay **failover** entre regiones» / «la réplica da alta disponibilidad» | «Son **dos URLs distintas**; elegir una es manual. No hay failover ni nombre único.» | No hay Route 53 ni CloudFront en el Learner Lab, así que no hay registro DNS con health check ni distribución al frente. Y el dashboard replicado se compila con el **mismo** `VITE_API_BASE` apuntando al **mismo** ALB (`.github/workflows/terraform.yml:169`, `packages/dashboard/src/api.ts:12`): si cae `us-east-1`, la copia de `us-west-2` carga el HTML y después no puede hablar con nadie |
| «El dashboard usa **MQTT sobre WebSockets**» | «El feed en vivo es un WebSocket propio de la API que consulta DynamoDB cada 3 s. La suscripción MQTT sobre WSS está **documentada y no implementada**.» | Mientras siga el feed de `packages/api/src/live.ts` —que es polling explícito por diseño, documentado en `live.ts:4-11`— la afirmación es falsa. Y queda **visible en el código**: `connectLive` abre un `WebSocket` contra `/live` (`packages/dashboard/src/api.ts:114-153`, `status.ts:42-47`) |
| «**Tiempo real**» a secas, si queda el feed actual | «Actualización cada ~3 s (polling de la API).» | Honestidad barata y además juega a favor del requisito «<5 s p95» de `docs/features-faltantes-propuesta.md:29` |
| «El spike de IoT **se intentó y no se pudo**», sin evidencia | «El SCP del Learner Lab deniega `<acción exacta>`; salida del comando en `<ruta>`.» | Si el spike falla, lo que vale en la defensa es **la denegación concreta con el nombre de la acción**, no «no nos dejó» |
| Fila 5 de `docs/features-faltantes-propuesta.md` en ✅ con huecos abiertos | Ver 5.1 | Marcar ✅ con una pieza sin hacer es la afirmación más fácil de desmentir del repo |

### 5.1 Redacción de la fila 5 según el escenario

El texto actual de la fila 5 (`docs/features-faltantes-propuesta.md:19`) dice que faltan tres cosas. Según qué termine implementado se reemplaza por **una** de estas tres redacciones:

**Escenario A — las tres piezas (incluido F5-C con el spike en verde):** estado ✅. «Al frontend en S3, el gráfico histórico y la actualización en vivo se sumaron el **mapa de unidades por estado**, el **sitio replicado en una segunda región** (`us-west-2`; son dos URLs distintas, sin Route 53 ni CloudFront en el Learner Lab, así que no hay nombre único ni failover) y la **suscripción MQTT sobre WebSockets** contra IoT Core con un custom authorizer que valida el JWT del repo, en reemplazo del WebSocket propio de la API.»

**Escenario B — dos de tres (mapa + réplica; MQTT documentado y no implementado). Es el resultado más probable:** estado 🟡. «Se sumaron el **mapa de unidades por estado** y el **sitio estático replicado en una segunda región** (`us-west-2`). La réplica es solo del frontend: el backend sigue entero en `us-east-1` y las dos copias apuntan al mismo ALB, así que son dos URLs distintas sin failover. Falta la **suscripción MQTT sobre WebSockets**: el feed en vivo sigue siendo el WebSocket propio de la API, que consulta DynamoDB cada 3 s. Está **documentada y no implementada**: requiere un custom authorizer de IoT y el spike de permisos (`iot:CreateAuthorizer` y `lambda:AddPermission` para `iot.amazonaws.com`) está **pendiente de ejecución**, no fallado.»

**Escenario C — solo el mapa:** estado 🟡. «Se sumó el **mapa de unidades por estado**. Siguen faltando el **sitio replicado por región** (hay un único bucket en `us-east-1`) y la **suscripción MQTT sobre WebSockets** (el feed en vivo es el WebSocket propio de la API, que consulta DynamoDB cada 3 s).» Con link a los dos planes.

En los tres casos hay que actualizar además, **en el mismo pase final**:

- El resumen de `docs/features-faltantes-propuesta.md:7`, que hoy dice que las features 4 y 5 «siguen a medias».
- La prioridad #2 de `:48` (el mapa) y la #4 de `:50` (multi-región), que en el escenario B pasa a «réplica mínima del frontend hecha; el backend sigue en una sola región».
- El párrafo de cierre de `:53`, que enumera lo que «todavía no tiene plan escrito»: después de este trabajo el mapa, la réplica y MQTT **sí** lo tienen.
- En el README: el diagrama y la explicación del feed en vivo, la justificación de la API en EC2 (que se apoya en que `/live` es un WebSocket propio) y la lista «Pendiente (fases siguientes)».

---

## 6. Decisiones que son del usuario

Todas afectan a más de una pieza, así que conviene resolverlas **antes** de arrancar la tanda 1.

| # | Decisión | Opciones | Qué está en juego |
|---|---|---|---|
| 1 | **Presupuesto de complejidad**: ¿las tres piezas o se prioriza? | (a) las tres · (b) mapa + réplica · (c) solo el mapa | Tiempo, riesgo y cuántos huecos quedan abiertos en la fila 5. (b) es el escenario realista: F5-C depende de un permiso que probablemente no esté |
| 2 | **¿Se aceptan dependencias de front nuevas en el bundle?** | sí / no / solo una | Hoy el dashboard tiene **2 dependencias de producción**: `react` y `react-dom` (`packages/dashboard/package.json:11-14`). El mapa agrega al menos una, el cliente MQTT otra |
| 3 | **¿Se avanza con F5-C antes de que el spike dé verde?** | sí / no | Escribir un authorizer que el SCP va a rechazar es trabajo tirado, y además adelanta las colisiones de `terraform/` y del lock. **No se debería**: el spike es bloqueante por definición |
| 4 | **¿Se trabaja en `main` o en una rama?** | `main` directo / una rama por pieza / una rama para la Feature 5 | Con rama hay `plan` comentado en el PR (`.github/workflows/terraform.yml:86-130`) y revisión antes de integrar; en `main` directo no hay ninguna red. Ojo: el `deploy` manual **todavía no está restringido a `main`** (`TODO` en `:135-136`) |
| 5 | **¿Se acepta agregar `jsdom` (o `@testing-library/*`) al repo?** | sí / no | **Hoy no hay ni `jsdom` ni `happy-dom` ni `@testing-library` en ningún workspace, y ningún `vitest.config` declara un `environment`.** Los tres tests del dashboard corren en Node sobre helpers puros o con fakes a mano: `status.test.ts` (funciones puras), `auth.test.ts` (decodifica JWTs, sin DOM) y `api.connectLive.test.ts`, que para evitar el DOM stubbea `window` con `vi.hoisted` (`:8-12`), una `FakeStorage` (`:18-30`) y una `FakeWebSocket` manual (`:32-40`). Un componente de mapa no se puede testear así: o se extraen helpers puros (el camino que el repo ya eligió dos veces) o entra `jsdom` |
| 6 | **¿Se agrega un step de `bash -n` (o shellcheck) al CI?** | sí / no / solo a mano | Hoy los scripts de bash no los valida nada (3.2.d). Agregar un step toca `.github/workflows/terraform.yml`, que ya está en disputa, y amplía el alcance del PR |
| 7 | **¿Dual-deploy o CRR para F5-B?** | sync a los dos buckets / `aws_s3_bucket_replication_configuration` | Afecta si F5-B toca el workflow (`:164-178`) o solo `terraform/`, y con eso el tamaño de su colisión con F5-C. **Dato relevante: la CRR exige versionado en origen y destino, y el bucket del dashboard hoy no tiene versionado** (`terraform/main.tf:70-104` configura cifrado, PAB, website y policy; versionado solo lo tienen `artifacts` y `archive`, `:21-24` y `:44-47`) |
| 8 | **¿Qué pasa con el bucket réplica en el `destroy`?** | agregarlo a `delete-buckets.sh` / borrarlo a mano | Si no se agrega, queda huérfano después del `destroy` y bloquea la próxima sesión por nombre tomado. Y el script hoy asume **una sola región** (`scripts/delete-buckets.sh:17`, lista literal en `:37`). Agregarlo es parte de F5-B, no un extra |

---

## 7. Hallazgos fuera de alcance

Cosas encontradas en el camino que **no** se planifican acá (umbrales por Shadow, replicación del backend, latencias, HTTPS, autoescalado), anotadas para que no se pierdan:

1. ~~**Link roto en `docs/features-faltantes-propuesta.md:53`** a `relevamiento-variante-b.md`.~~ **Resuelto**: el párrafo se reescribió en el pase de consolidación y ya no apunta a un archivo inexistente. Verificado: los links `.md` del repo resuelven.
2. **`scripts/seed-db.sh` sigue sin trackear** (`git status`). Es un script que quedó fuera de git, probablemente residuo de la migración de RDS a DynamoDB: decidir si se commitea o se borra, no dejarlo en el limbo. `docs/encargo-feature-5.md` ya quedó commiteado, con un encabezado que aclara que describe el repo **antes** de este trabajo.
3. **Había credenciales de AWS activas en la sesión**, al contrario de lo que asumía el encargo (cuenta del Learner Lab, rol `voclabs`). Nada de lo que afirma este documento sobre AWS se verificó contra la cuenta: **no se corrió ningún `apply` ni ningún `plan` de despliegue**, así que todo lo que dependa de AWS sigue siendo checklist pendiente. El único efecto real fue un `create-bucket` accidental con un sufijo ficticio, que falló por nombre tomado y no dejó rastro.
3. **El `TODO(4.3)` del workflow** (`.github/workflows/terraform.yml:135-136`): `apply`/`destroy` todavía no están restringidos a `main`. Si se decide trabajar en ramas (decisión 4), conviene saber que **se puede desplegar desde cualquier rama**.
4. **El job `plan` no depende de `app`** (`:88`): un PR con los tests rotos igual genera y comenta un plan. Es intencional (el plan no depende del código), pero puede dar la impresión de «verde» en un PR rojo.
5. **El typecheck del dashboard no cubre `test/`** (`packages/dashboard/tsconfig.json:15`: `"include": ["src"]`), y vitest no hace typecheck. Un error de tipos en un archivo de test **no rompe el build**; solo se nota si el test falla en runtime.
6. **La política de IoT de las unidades está limitada por Thing** (`terraform/modules/iot-ingest/main.tf:14-32`). Relevante como insumo del spike de F5-C: un suscriptor de navegador no está cubierto por nada de lo que ya existe.
7. **La alarma de flota de «sin señal»** (`terraform/modules/messaging/main.tf:36-52`) usa un módulo del registry público. Es la única dependencia externa de Terraform del repo, y es lo que hace que `terraform init` necesite internet incluso con `-backend=false`.
8. **`aws_s3_bucket_policy.dashboard` (`terraform/main.tf:92-104`) no depende del `aws_s3_bucket_public_access_block.dashboard` de `:79-85`.** Con Block Public Access habilitado por defecto en los buckets nuevos, un `PutBucketPolicy` con `Principal: "*"` solo funciona si el PAB se aplicó antes, y hoy eso lo decide el grafo de Terraform, no el código. Es una línea de arreglo (`depends_on`), y conviene resolverla junto con F5-B, que replica exactamente este patrón en la segunda región.
9. **Versionado del bucket del dashboard**: no lo tiene (ver decisión 7). Es un prerequisito técnico de una de las dos variantes de F5-B.
