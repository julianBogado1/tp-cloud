# Plan: sitio estático del dashboard replicado por región

**Feature:** #5 de la propuesta formal («Dashboard en tiempo real»), parte **F5-B**.
**Hueco a cerrar:** la propuesta promete el dashboard **replicado por región**. Hoy hay **un solo** bucket S3 Website, `snowball-dashboard-<sufijo>`, en `us-east-1` (`terraform/locals.tf:24`, `terraform/main.tf:70-104`).
**Fecha:** 2026-10-20

---

## 1. Qué ya existe y se reusa

La pieza buena de esta feature es que **no hay nada que inventar**: el bucket del dashboard ya está hecho con recursos *standalone* sobre un bucket creado por script, y ese patrón se copia tal cual en la segunda región.

| Pieza | Dónde | Estado / cómo se reusa |
|---|---|---|
| Nombres de los buckets | `terraform/locals.tf:23-27` (`local.bucket_names`, armados con `var.bucket_suffix`) | se le agrega una clave `dashboard_replica` |
| Cifrado SSE-S3 del dashboard | `terraform/main.tf:70-77` | se espeja con `region` de la réplica |
| Public Access Block **abierto** del dashboard (los cuatro flags en `false`, porque S3 Website exige lectura pública) | `terraform/main.tf:79-85` | se espeja |
| Website configuration (`index_document.suffix = "index.html"`) | `terraform/main.tf:87-90` | se espeja; su atributo `website_endpoint` resuelve el problema del formato de URL (ver §2.4) |
| Policy pública de `s3:GetObject` con `Principal = "*"` y `depends_on` del website | `terraform/main.tf:92-104` | se espeja, con un `depends_on` **más completo** (ver §2.6) |
| Versionado como recurso standalone (patrón) | `terraform/main.tf:21-24` (`artifacts`), `:44-47` (`archive`) | solo se usa si se elige CRR; el dashboard **no tiene** versionado hoy |
| Provider único, sin alias, `region = var.region` + `default_tags` | `terraform/providers.tf:1-4` | no se modifica en el camino recomendado |
| `data.aws_iam_role.lab` / `data.aws_iam_instance_profile.lab` | `terraform/providers.tf:6-7` | **no hace falta duplicarlos**: IAM es global (ver §2.3) |
| Provider `hashicorp/aws ~> 6.46`, `required_version >= 1.10.0` | `terraform/versions.tf:1-6` | la v6 es la que habilita `region` por recurso |
| Output del bucket del dashboard | `terraform/outputs.tf:10-12` | se le suman los de la réplica y las dos URLs |
| Creación de los buckets por CLI (el SCP del Lab impide `aws_s3_bucket`) | `scripts/bootstrap-buckets.sh`, `docs/terraform-buckets-learner-lab.md:1-21` | se extiende con un quinto bucket en otra región |
| Rama de `create-bucket` con `LocationConstraint` para regiones ≠ `us-east-1` | `scripts/bootstrap-buckets.sh:26-33` | **ya está escrita**: es exactamente la que necesita la réplica |
| Defaults privados y versionado por CLI | `scripts/bootstrap-buckets.sh:36-48`, `:50-55` | no se usan para el dashboard (lo configura Terraform) |
| Vaciado con versiones y delete markers, y borrado | `scripts/delete-buckets.sh:56-81` | se reusa; hay que hacerlo multi-región |
| Publicación del dashboard en CI | `.github/workflows/terraform.yml:164-178` | se le suma el segundo `sync` y se le saca el `us-east-1` hardcodeado de `:174` |
| `AWS_REGION: us-east-1` del workflow | `.github/workflows/terraform.yml:35` | sigue siendo la región principal; la réplica llega por una variable nueva |
| Llamada al bootstrap desde la composite action | `.github/actions/terraform-setup/action.yml:88-92` | se le pasa la región réplica por entorno |
| `terraform init` con `-backend-config` | `.github/actions/terraform-setup/action.yml:94-102` | no cambia (el state sigue en `us-east-1`) |
| Flujo manual equivalente | `README.md:108-112` (paso 5), `docs/infra-terraform.md:467-481` (sección 10.2) | se actualizan los dos |
| `cors_origin` con default `*` | `terraform/variables.tf:65-69`, consumido en `packages/api/src/index.ts:35` y `:44` | **por eso la réplica funciona sin tocar la API** (ver §2.7) |
| Estilo de `validation` en variables | `terraform/variables.tf:29-32` (`vpc_cidr`), `:135-138` (`no_signal_timeout_min`), `:144-147` (`archive_glacier_days`) | se imita para la variable nueva |

Lo que **no** existe: ninguna noción de «otra región» en el repo. `terraform/variables.tf:1-5` tiene una sola `region`, `scripts/bootstrap-buckets.sh:4` y `scripts/delete-buckets.sh:17` hardcodean `REGION="${AWS_REGION:-us-east-1}"` para los cuatro buckets, y `docs/infra-terraform.md:1134` lo dice en la lista de limitaciones conocidas: «**Una sola región** (`us-east-1`) y dos zonas de disponibilidad».

### 1.1 Restricciones del Learner Lab que condicionan todo el diseño

1. **El SCP deniega `s3:GetBucketObjectLockConfiguration`.** El provider lee Object Lock después de crear cualquier bucket con `aws_s3_bucket`, así que el recurso crea el bucket y queda en error, y vuelve a fallar en cada `plan` (`docs/infra-terraform.md:237-244`). **El bucket réplica se crea por CLI, igual que los otros cuatro.** No se declara `aws_s3_bucket` en ningún caso.
2. **Solo `us-east-1` y `us-west-2` responden.** El resto de las regiones da errores de acceso (hallazgo de investigación previo). La réplica va en `us-west-2`.
3. **No hay Route 53 ni CloudFront.** Sin ellos no hay un único nombre de dominio ni failover: la réplica es, literalmente, **dos URLs de S3 Website distintas**. Ver §7, que es la sección que importa para la defensa.
4. **No se crean roles IAM** (`docs/infra-terraform.md:152-153`): todo usa `LabRole`. Eso es lo que hace frágil el camino CRR.

---

## 2. Decisión de diseño

### 2.1 Mecanismo de sincronización: **dual-deploy** (recomendado)

El paso «Compilar y publicar el dashboard» del workflow ya tiene en la mano el `dist/` compilado. Publicar en dos buckets es **un `aws s3 sync` más**:

```bash
aws s3 sync packages/dashboard/dist/ "s3://${REPLICA_BUCKET}/" --delete --region "${DASHBOARD_REPLICA_REGION}"
```

Cero dependencias de IAM, cero servicios nuevos, y la propiedad más valiosa: **los dos buckets contienen exactamente lo que se compiló**, verificable con un `diff` de dos listados. No hay latencia de convergencia ni un estado intermedio en el que una región sirve una versión y la otra otra.

### 2.2 Alternativa comparada: **CRR** (`aws_s3_bucket_replication_configuration`)

| Criterio | (a) Dual-deploy | (b) CRR |
|---|---|---|
| Recursos de Terraform nuevos | 4 (SSE, PAB, website, policy) con `region` de la réplica | 4 + `aws_s3_bucket_versioning` **en origen** + `aws_s3_bucket_versioning` en destino + `aws_s3_bucket_replication_configuration` = 7 |
| Cambios en el workflow | un `sync` más (≈2 líneas) | ninguno en el `sync`, pero hay que documentar y verificar la convergencia |
| Dependencia de IAM | **ninguna** | un rol que S3 asuma. Hay que pasarle `LabRole`, lo que exige que su trust policy incluya `s3.amazonaws.com`, que el SCP permita `iam:PassRole` sobre él y `s3:PutReplicationConfiguration`. **No verificable en esta sesión** |
| Versionado | no hace falta | **obligatorio en origen y destino** (doc oficial de AWS). El bucket del dashboard hoy no lo tiene |
| Interacción con `--delete` del deploy | ninguna: borra y listo | cada deploy deja versiones y delete markers acumulados en los dos buckets. Un `--delete` en origen **no borra** el objeto en destino salvo que `delete_marker_replication` esté `Enabled`, y aun así nunca replica el borrado de una versión puntual |
| Objetos preexistentes | no aplica | **no se replican**: «Objects that existed before you set up replication aren't replicated automatically». Haría falta S3 Batch Replication, que además pide activación por AWS Support y un rol con `batchoperations.s3.amazonaws.com` — muy improbable en el Lab |
| Riesgo de deriva silenciosa | bajo | **alto**: Vite nombra los assets por hash de contenido, así que un deploy que no cambia nada no sube nada y **no replica nada**; la réplica puede quedarse con el build anterior (o vacía) sin que falle ningún paso |
| Determinismo / verificabilidad | `diff` de dos `aws s3 ls` | hay que esperar (minutos) y sondear con un objeto canario |
| Valor «más AWS» para la defensa | bajo | **alto**: es el servicio que AWS vende para esto |
| Costo | +1 bucket (ver §8) | +1 bucket + transferencia inter-región + PUTs de replicación + almacenamiento de versiones |

**Veredicto: (a).** CRR replica *el contenido nuevo*, y el contenido nuevo lo produce el mismo build que el workflow ya tiene. Lo que CRR aporta de verdad —replicación continua de un bucket que escriben muchos productores desacoplados del deploy— no es el caso de un sitio estático publicado por un único pipeline. En cambio sí aporta tres modos de falla nuevos (rol, objetos preexistentes, deriva silenciosa por hash de contenido), dos de ellos imposibles de descartar sin credenciales.

**Si el usuario elige (b), el plan cambia así** (está especificado, no es una nota al pie):
- `terraform/main.tf`: `aws_s3_bucket_versioning.dashboard` (origen, región por defecto) y `aws_s3_bucket_versioning.dashboard_replica` (`region` de la réplica), **ambos antes** de la replicación.
- `aws_s3_bucket_replication_configuration.dashboard`: `bucket = local.bucket_names.dashboard`, `role = data.aws_iam_role.lab.arn`, un `rule` con `status = "Enabled"`, `filter {}` (vacío = todo el bucket, configuración V2), `delete_marker_replication { status = "Enabled" }` y `destination { bucket = "arn:aws:s3:::${local.bucket_names.dashboard_replica}" }`, con `depends_on` de los dos `aws_s3_bucket_versioning`.
- El `sync` del workflow queda en un solo bucket; el `GITHUB_STEP_SUMMARY` muestra las dos URLs igual, con una línea que avise que la réplica converge en minutos.
- `scripts/delete-buckets.sh` pasa a ser crítico: los dos buckets quedan versionados y el borrado de versiones ya está implementado (`:56-69`), pero ahora corre sobre cinco buckets en dos regiones.
- **Spike bloqueante antes de escribir una línea** (ver §9.B): `aws iam get-role --role-name LabRole --query 'Role.AssumeRolePolicyDocument'` tiene que mostrar `s3.amazonaws.com` entre los principals. Si no está, (b) **no es viable** y se cae a (a) sin discusión.

### 2.3 Multi-región en Terraform: `region` por recurso, no provider aliased (recomendado)

El provider es `hashicorp/aws ~> 6.46` (`terraform/versions.tf:4`). La v6 introdujo *enhanced region support*: **casi todos los recursos regionales aceptan un argumento `region` de nivel superior**, opcional y computado, que por defecto toma la región del provider. Está confirmado en la doc de los tres recursos que importan acá (`aws_s3_bucket_website_configuration`, `aws_s3_bucket_policy`, `aws_s3_bucket_public_access_block` listan `region` (Optional) en su Argument Reference).

Entonces:

```hcl
resource "aws_s3_bucket_website_configuration" "dashboard_replica" {
  count  = var.dashboard_replica_region == "" ? 0 : 1
  region = var.dashboard_replica_region
  bucket = local.bucket_names.dashboard_replica
  index_document { suffix = "index.html" }
}
```

Por qué es mejor que el alias:
- **No hay que repetir `default_tags`.** Con un provider aliased habría que duplicar el bloque `default_tags { tags = local.common_tags }` de `providers.tf:3`, y si alguien cambia `local.common_tags` y se olvida del alias, los dos providers divergen. Con `region` por recurso el provider sigue siendo uno. (Nota honesta: los cuatro recursos standalone **no son etiquetables** —son configuraciones, no el bucket—, así que hoy `default_tags` no les aplica de todos modos; el argumento vale para el día en que se agregue un recurso etiquetable en la región réplica.)
- **Resuelve la pregunta de los `data` sources.** `data.aws_iam_role.lab` y `data.aws_iam_instance_profile.lab` (`providers.tf:6-7`) son de **IAM, que es global**: el guide del provider excluye explícitamente IAM, Route 53, CloudFront y Organizations del argumento `region`. No existe «el LabRole de us-west-2» y **no hay que duplicar nada**. Con un provider aliased la tentación de duplicarlos existe y sería un error (dos lecturas del mismo rol global, dos entradas en el state, ruido en cada plan).
- Menos superficie: no se toca `providers.tf`.

**Alternativa descartada: `provider "aws" { alias = "replica" }`.** Perfectamente válida y **no está deprecada** (el guide del provider lo dice explícitamente: las configuraciones por región, incluidos los alias, siguen siendo válidas). Si el usuario la prefiere por legibilidad, el cambio es:

```hcl
provider "aws" {
  alias  = "replica"
  region = var.dashboard_replica_region
  default_tags { tags = local.common_tags }
}
```
y `provider = aws.replica` en los cuatro recursos en lugar de `region = ...`. **Contra:** `var.dashboard_replica_region` no puede ser `""` (un provider con `region = ""` es inválido), así que el apagado por centinela deja de funcionar y hace falta el booleano `var.enable_dashboard_replica` aparte, con la posibilidad de que las dos perillas se contradigan. Es la razón técnica por la que el camino `region` por recurso también gana en la interfaz de apagado.

**Sobre `terraform validate`:** `validate` no contacta a AWS, así que no necesita credenciales en ninguno de los dos caminos, y `-backend=false` en el `init` previo (como hace `.github/workflows/terraform.yml:68`) alcanza. Un provider aliased **no requiere nada especial**: `init -backend=false` instala el plugin y `validate` chequea la configuración, incluidos los alias declarados. La única precaución real es darle **default** a `var.dashboard_replica_region` para que `validate` nunca la vea sin valor.

### 2.4 Las dos URLs: usar `website_endpoint`, no construir el string

El endpoint de S3 Website **tiene dos formatos según la región** y no hay regla deducible: la tabla oficial de endpoints de S3 los lista uno por uno. Verificado hoy contra `docs.aws.amazon.com/general/latest/gr/s3.html`, sección *Amazon S3 website endpoints and HostedZone IDs*:

| Región | Endpoint de website | Formato |
|---|---|---|
| `us-east-1` | `s3-website-us-east-1.amazonaws.com` | **guión** |
| `us-west-2` | `s3-website-us-west-2.amazonaws.com` | **guión** |
| (contraste) `us-east-2` | `s3-website.us-east-2.amazonaws.com` | punto |

O sea: para las **dos** regiones del Learner Lab el formato es con **guión**, y el `s3-website-us-east-1` que hoy está hardcodeado en `.github/workflows/terraform.yml:174`, `docs/infra-terraform.md:480` y `docs/infra-terraform.md:616` es correcto *para us-east-1*. Pero no hay que replicar el hardcodeo: el recurso **`aws_s3_bucket_website_configuration` exporta el atributo `website_endpoint`** (y `website_domain`), verificado en la Attribute Reference de su doc. Entonces las URLs salen del provider y el repo no tiene que saber nada de formatos:

```hcl
output "dashboard_url" {
  description = "URL del sitio estático principal (S3 Website, solo HTTP)."
  value       = "http://${aws_s3_bucket_website_configuration.dashboard.website_endpoint}"
}
output "dashboard_replica_url" {
  description = "URL del sitio estático replicado; vacío si la réplica está apagada."
  value       = join("", [for w in aws_s3_bucket_website_configuration.dashboard_replica : "http://${w.website_endpoint}"])
}
```

**Cuidado con el `null`:** la forma «obvia» `var.dashboard_replica_region == "" ? "" : "http://${aws_s3_bucket_website_configuration.dashboard_replica[0].website_endpoint}"` es frágil, porque con `count = 0` el índice `[0]` no existe. El `for` sobre la lista del `count` devuelve `[]` y `join` da `""` sin tocar ningún índice. `try("http://${...[0].website_endpoint}", "")` también sirve. Se usa la forma con `join`.

**Dato relevante para §7:** la nota de la propia doc de AWS es explícita: «Amazon S3 website endpoints do not support HTTPS». Las dos URLs son HTTP. Esto ya figura como ❌ en `docs/features-faltantes-propuesta.md:34` y la réplica no lo cambia (ni lo empeora).

### 2.5 Nombre del bucket réplica: `snowball-dashboard-<sufijo>-<region>`

Los nombres de bucket son **globales en toda la partición `aws`** (doc oficial de naming rules), así que el réplica necesita un nombre propio. Patrón propuesto, que mantiene los dos buckets adyacentes en un `aws s3 ls` y hace obvia la región:

```
snowball-dashboard-grupo-01-us-west-2
```

Chequeo contra las reglas oficiales, con la cuenta real de caracteres:

| Regla oficial | Cumple |
|---|---|
| 3–63 caracteres | `snowball-dashboard-` = **19** + `-us-west-2` = **10** → 29 fijos. Con `grupo-01` (8) el nombre tiene **37**. Deja **34 caracteres** de margen para el sufijo |
| solo minúsculas, números, puntos y guiones | sí (no se usan puntos) |
| empieza y termina con letra o número | empieza con `s`, termina con `2` |
| sin dos puntos adyacentes, no con formato de IP | sí |
| no empieza con `xn--`, `sthree-`, `amzn-s3-demo-` | empieza con `snowball-` |
| no termina en `-s3alias`, `--ol-s3`, `.mrap`, `--x-s3`, `--table-s3`, `-an` | termina en `-2`; ningún código de región de AWS termina en `-an` |
| sin puntos, requisito de Transfer Acceleration | sí, y además evita el problema de certificados de virtual-hosting |

**Validación nueva a agregar en `var.bucket_suffix`:** hoy no tiene `validation` (`terraform/variables.tf:11-14`) y el margen real pasa de 44 a 34 caracteres. Se propone agregarle `validation { condition = length(var.bucket_suffix) <= 34 }` con un `error_message` que explique la cuenta, para que el error salga en `plan` y no en el `create-bucket`. **Decisión del usuario**, porque es un cambio de contrato sobre una variable existente.

**Alternativa descartada:** `snowball-dashboard-<region>-<sufijo>`. Igual de válida, pero rompe el orden alfabético junto al bucket principal y no aporta nada.

### 2.6 Dependencias y orden: el `depends_on` que falta

`aws_s3_bucket_policy.dashboard` (`terraform/main.tf:92-104`) declara `depends_on = [aws_s3_bucket_website_configuration.dashboard]`, pero **no** depende de `aws_s3_bucket_public_access_block.dashboard` (`:79-85`). S3 habilita Block Public Access por defecto en todos los buckets nuevos, y con `BlockPublicPolicy = true` un `PutBucketPolicy` con `Principal = "*"` es rechazado. Hoy el `apply` funciona porque el grafo de Terraform ordena el PAB primero, pero eso no está garantizado por nada escrito.

En la réplica el `depends_on` se declara completo:

```hcl
depends_on = [
  aws_s3_bucket_public_access_block.dashboard_replica,
  aws_s3_bucket_website_configuration.dashboard_replica,
]
```

y se propone **agregar el PAB al `depends_on` del origen también** (una línea en `main.tf:103`). No es estrictamente parte de F5-B; es una corrección de una línea en el mismo bloque que se está tocando, y evita que la réplica herede un error latente. **Marcado como decisión del usuario** (ampliar el diff vs dejarlo).

### 2.7 Lo que **no** hay que tocar (y por qué)

- **La API y el dashboard (`packages/`).** No se toca un solo archivo. El build de la réplica es **el mismo artefacto** con el mismo `VITE_API_BASE="http://${ALB}"`: las dos copias apuntan al **mismo ALB de `us-east-1`**.
- **CORS.** `var.cors_origin` tiene default `*` (`terraform/variables.tf:65-69`) y la API lo usa tal cual (`packages/api/src/index.ts:35` y `:44`). Con el default, el origen nuevo de `us-west-2` funciona sin cambios. **Pero**: si alguien setea `cors_origin` a un origen concreto, la réplica deja de poder hablar con la API (y la API solo acepta **un** origen, no una lista). Queda anotado en §7 y en el checklist.
- **El backend remoto.** El state sigue en el bucket de `us-east-1`; `terraform init -backend-config="region=${AWS_REGION}"` (`.github/actions/terraform-setup/action.yml:102`) no cambia.
- **`packages/dashboard/vite.config.ts` y el `base` de Vite.** Los assets se sirven desde la raíz del bucket en los dos casos; no hay prefijo distinto.

### 2.8 Interfaz nueva de los scripts: una sola variable de entorno

`scripts/bootstrap-buckets.sh` lo corren **personas a mano** (`README.md:90`, `docs/infra-terraform.md:272`) y lo corre la composite action (`action.yml:92`) con dos argumentos posicionales ya ocupados (sufijo y bucket de state). Se elige una **variable de entorno**:

```bash
DASHBOARD_REPLICA_REGION=us-west-2 bash scripts/bootstrap-buckets.sh grupo-01 snowball-tfstate-grupo-01
```

- **Retrocompatible por construcción:** `DASHBOARD_REPLICA_REGION="${DASHBOARD_REPLICA_REGION:-}"`; vacía o ausente ⇒ el script hace **exactamente** lo que hace hoy, cuatro buckets en `REGION`. Ninguna invocación existente se rompe.
- **Misma variable en los dos scripts**, para que bootstrap y delete no puedan desincronizarse.
- **Misma semántica que Terraform**: `var.dashboard_replica_region = ""` apaga la réplica. Una sola fuente de verdad, un solo concepto.

**Alternativas descartadas:**
- *Tercer argumento posicional* (`$3`): ambiguo con los dos que ya hay y obliga a pasar el bucket de state para llegar al tercero.
- *Flag `--replica-region us-west-2`*: `bootstrap-buckets.sh` hoy no parsea flags (sí lo hace `delete-buckets.sh:22-28`); agregar un parser a bootstrap para un solo valor es más código que beneficio.
- *Dos variables (`DASHBOARD_REPLICA_ENABLED` + `DASHBOARD_REPLICA_REGION`)*: dos perillas que pueden contradecirse, en bash y en Terraform.

**Riesgo operativo principal de este diseño, y hay que escribirlo:** si alguien corre `terraform apply` con `dashboard_replica_region = "us-west-2"` **sin** haber corrido el bootstrap con `DASHBOARD_REPLICA_REGION=us-west-2`, el `apply` falla con `NoSuchBucket` en los cuatro recursos de la réplica. Mitigación: la composite action exporta la misma variable a los dos lugares (§4, paso 7), el README lo dice en el paso 1, y el mensaje final del script enumera los buckets creados **con su región**.

### 2.9 Decisiones tomadas (2026-10-20)

| Decisión | Elección | Por qué |
|---|---|---|
| Mecanismo de sincronización | **Dual-deploy** (`aws s3 sync` a los dos buckets) | Determinista y sin IAM. CRR no replica preexistentes, exige versionado y un rol que el SCP puede denegar, y puede derivar en silencio porque los assets de Vite son hash de contenido |
| Multi-región en Terraform | **`region` por recurso** (provider v6) | Un solo provider, sin duplicar `default_tags`, y deja claro que los `data` de IAM son globales y no se duplican |
| Región réplica | **`us-west-2`** (default) | Es la única otra región que responde en el Learner Lab |
| Formato de las URLs | **atributo `website_endpoint`** del website configuration | El endpoint de website tiene dos formatos según la región; que lo resuelva el provider y no el repo |
| Apagado de la réplica | **centinela `dashboard_replica_region = ""`** | Una sola perilla para Terraform, bootstrap y delete; imposible que se contradigan |
| Nombre | **`snowball-dashboard-<sufijo>-<region>`** (37 car. con `grupo-01`, límite 63) | Queda adyacente al principal en `aws s3 ls` y la región es legible |
| Interfaz de los scripts | **variable de entorno `DASHBOARD_REPLICA_REGION`** | Retrocompatible, igual para humanos y para la composite action, idéntica en los dos scripts |
| Qué NO se promete | **sin dominio único ni failover** | No hay Route 53 ni CloudFront en el Lab (ver §7) |

### 2.10 Decisiones que son **del usuario**

1. **(a) dual-deploy vs (b) CRR.** La principal. El plan recomienda (a); (b) queda especificado en §2.2 y con su spike bloqueante en §9.B.
2. **`region` por recurso vs provider aliased.** Recomendado el primero; el segundo está escrito en §2.3 y arrastra el booleano aparte.
3. **Réplica activada por defecto.** `default = "us-west-2"` (activada, y el `plan` del próximo PR muestra 4 recursos nuevos) o `default = ""` (apagada, y hay que activarla a mano en `terraform.tfvars` y en el repo variable del CI). Recomendado: **activada**, porque la feature es justamente demostrar que existe, y el costo es indistinguible de cero (§8).
4. **Región réplica.** `us-west-2`. Se permite `us-east-1` en la `validation` para poder probar el mecanismo en una sola región.
5. **Patrón de nombre** y si se agrega la `validation` de 34 caracteres a `var.bucket_suffix` (§2.5).
6. **Si se arregla el `depends_on` del origen** (§2.6).

---

## 3. Qué se puede y qué no se puede prometer

Esta sección es la que hay que tener lista para la defensa.

**Lo que esto da:**
- El **sitio estático** del dashboard existe en dos regiones, con dos buckets independientes y dos URLs. Si `us-west-2` se cae, `us-east-1` sigue sirviendo el frontend, y viceversa.
- Cercanía de red para un usuario del oeste de EE. UU. (menos RTT para bajar los 161 KB del bundle).
- Resiliencia ante un error de operación en un bucket (un `--delete` mal hecho, una policy borrada): la otra copia queda en pie.

**Lo que esto NO da:**
- **No hay un único nombre.** Sin Route 53 no hay registro con política de failover ni health checks; sin CloudFront no hay un único hostname por delante de los dos orígenes. Son dos URLs y **el usuario elige a mano** cuál abre.
- **No hay failover automático.** Nadie detecta la caída de una región ni redirige nada.
- **El backend sigue entero en `us-east-1`**: ALB, EC2 del ASG, DynamoDB, IoT Core, las tres Lambdas, SQS y SNS. Las **dos** copias del dashboard apuntan al **mismo** ALB vía `VITE_API_BASE` (`.github/workflows/terraform.yml:169`). **Si `us-east-1` se cae, la copia de `us-west-2` sirve HTML que no puede hablar con nada**: el login falla, no hay unidades, no hay feed en vivo.
- **Esto no es «multi-región».** Llamarlo así sería sobreventa. Es *replicación del sitio estático*. La replicación multi-región del backend (DynamoDB Global Tables, segunda región de la API/ALB) sigue siendo la prioridad 4 de `docs/features-faltantes-propuesta.md:50` y está **fuera del alcance** de este plan.
- **Sigue siendo HTTP.** Los endpoints de website de S3 no soportan HTTPS (doc oficial); duplicar el bucket no cambia el ❌ de `docs/features-faltantes-propuesta.md:34`.
- **Si `cors_origin` deja de ser `*`**, la réplica se rompe: la API acepta un solo origen (`packages/api/src/index.ts:35`).

### 3.1 Frase redactada para `docs/features-faltantes-propuesta.md` (fila 5) y el README

> El dashboard está replicado en dos regiones (`us-east-1` y `us-west-2`) como **dos sitios estáticos independientes, con dos URLs distintas**. No hay un único nombre de dominio ni failover automático: el Learner Lab no habilita Route 53 ni CloudFront, así que ante la caída de una región hay que cambiar de URL a mano. Además el backend (ALB, EC2, DynamoDB, IoT Core, Lambdas, SQS y SNS) sigue entero en `us-east-1` y las dos copias del dashboard consultan el **mismo** ALB vía `VITE_API_BASE`: si `us-east-1` se cae, la copia de `us-west-2` sirve el HTML pero no tiene con quién hablar. Lo que esto cumple es la **replicación del sitio estático** de la propuesta, no la replicación multi-región de la plataforma, que sigue pendiente.

---

## 4. Pasos de implementación

Tres tandas. Dentro de cada una se puede paralelizar; entre tandas, no.

### Tanda 1 — Terraform (no necesita AWS; se valida con `fmt` + `validate`)

1. **`terraform/variables.tf`** — agregar, después de `var.region` (`:1-5`) para que queden juntas:
   ```hcl
   variable "dashboard_replica_region" {
     type        = string
     description = "Region for the replicated dashboard website bucket. Empty disables the replica. The Learner Lab only allows us-east-1 and us-west-2."
     default     = "us-west-2"
     validation {
       condition     = contains(["", "us-east-1", "us-west-2"], var.dashboard_replica_region)
       error_message = "dashboard_replica_region must be \"\" (disabled), us-east-1 or us-west-2: the Learner Lab denies access to other regions."
     }
   }
   ```
   Opcional (decisión del usuario, §2.5): `validation` de longitud en `var.bucket_suffix` (`:11-14`).
2. **`terraform/locals.tf`** — en `local.bucket_names` (`:23-27`), agregar:
   ```hcl
   # Globally unique name for the replica: bucket names are global, so the region
   # goes in the name. 19 + len(suffix) + 10 chars; S3 allows 63.
   dashboard_replica = "snowball-dashboard-${var.bucket_suffix}-${var.dashboard_replica_region}"
   ```
   (con `dashboard_replica_region = ""` el nombre queda con un guión al final y sería inválido — no importa: ningún recurso lo referencia, porque los cuatro tienen `count = 0`, y el output lo recorta con el `join`. Para que el nombre tampoco quede raro en el output se usa la guarda del paso 4.)
3. **`terraform/main.tf`** — a continuación del bloque del dashboard (`:70-104`), cuatro recursos nuevos, cada uno con `count = var.dashboard_replica_region == "" ? 0 : 1` y `region = var.dashboard_replica_region`:
   - `aws_s3_bucket_server_side_encryption_configuration.dashboard_replica` (espeja `:70-77`)
   - `aws_s3_bucket_public_access_block.dashboard_replica` (espeja `:79-85`, los cuatro flags en `false`)
   - `aws_s3_bucket_website_configuration.dashboard_replica` (espeja `:87-90`)
   - `aws_s3_bucket_policy.dashboard_replica` (espeja `:92-104`, con el `depends_on` completo de §2.6)
   Comentario en inglés arriba del bloque explicando que el bucket lo crea `scripts/bootstrap-buckets.sh` y que `region` reemplaza al provider aliased.
   Opcional (§2.6): sumar el PAB al `depends_on` de `aws_s3_bucket_policy.dashboard` (`:103`).
4. **`terraform/outputs.tf`** — después de `dashboard_bucket` (`:10-12`):
   ```hcl
   output "dashboard_replica_bucket" {
     description = "Replicated dashboard bucket name; empty when the replica is disabled."
     value       = var.dashboard_replica_region == "" ? "" : local.bucket_names.dashboard_replica
   }
   output "dashboard_replica_region" {
     value = var.dashboard_replica_region
   }
   output "dashboard_url" { ... }          # ver §2.4
   output "dashboard_replica_url" { ... }  # ver §2.4, forma con join
   ```
   Los cuatro son **siempre strings** (vacíos si está apagada): así `terraform output -raw` no falla en el workflow.
5. **`terraform/terraform.tfvars.example`** — una línea comentada después de `region` (`:1`):
   ```
   # dashboard_replica_region = "us-west-2"   # "" para apagar la réplica del sitio estático
   ```

### Tanda 2 — Scripts de bash (no necesitan AWS para `bash -n`)

6. **`scripts/bootstrap-buckets.sh`**
   - Leer `DASHBOARD_REPLICA_REGION="${DASHBOARD_REPLICA_REGION:-}"` junto a `REGION` (`:4`).
   - `create_if_missing()` (`:18-34`) y `put_private_defaults()` (`:36-48`) pasan a recibir la **región como segundo parámetro** en vez de usar la global `${REGION}`; todos los llamados actuales (`:57-65`) pasan `"${REGION}"`. La rama de `LocationConstraint` (`:26-33`) ya está escrita y es justo lo que necesita la réplica: **no se toca su lógica**, solo se le cambia la variable por el parámetro.
   - Al final, si `DASHBOARD_REPLICA_REGION` no está vacía:
     ```bash
     DASHBOARD_REPLICA_BUCKET="snowball-dashboard-${SUFFIX}-${DASHBOARD_REPLICA_REGION}"
     create_if_missing "${DASHBOARD_REPLICA_BUCKET}" "${DASHBOARD_REPLICA_REGION}"
     ```
     (igual que el dashboard principal: **solo crear**; la configuración es de Terraform).
   - El `echo` final (`:67`) enumera los buckets **con su región** y menciona el réplica solo si se creó.
   - Opcional: imprimir la lista de buckets+regiones **antes** de la primera llamada a `aws`, para que se pueda revisar el plan sin credenciales (es lo que ya hace `delete-buckets.sh:42-43`).
7. **`scripts/delete-buckets.sh`**
   - Leer `DASHBOARD_REPLICA_REGION="${DASHBOARD_REPLICA_REGION:-}"` junto a `REGION` (`:17`).
   - `BUCKETS` (`:37`) pasa de una lista de nombres a una lista de pares `"nombre|region"`, y el bucle (`:71-81`) hace `IFS='|' read -r bucket region <<< "${entry}"`. **Sin arrays asociativos**: el script declara compatibilidad con Git Bash, Linux y macOS (`:14`), y macOS trae bash 3.2.
   - `delete_all()` (`:58-69`) recibe la región como tercer parámetro; `head-bucket`, `list-object-versions`, `delete-object` y `delete-bucket` usan esa región, no la global.
   - Si `DASHBOARD_REPLICA_REGION` no está vacía, se agrega `"snowball-dashboard-${SUFFIX}-${DASHBOARD_REPLICA_REGION}|${DASHBOARD_REPLICA_REGION}"`.
   - El `printf` de confirmación (`:42-43`) muestra `bucket (región)` por línea; el encabezado «región ${REGION}» de `:42` deja de ser válido para toda la lista y hay que reescribirlo.
   - **Por qué esto es obligatorio:** Terraform no es dueño de los buckets, así que `destroy` no los borra (`docs/infra-terraform.md:919-920`, `:1130-1131`). Si el réplica no entra en este script queda **huérfano**, y como los nombres son globales en toda la partición, la próxima sesión del Lab choca con `BucketAlreadyExists` (`docs/infra-terraform.md:1152`) y hay que ir a borrarlo a mano a la consola de otra región.

### Tanda 3 — CI y documentación (depende de las tandas 1 y 2)

8. **`.github/actions/terraform-setup/action.yml`** — el step «Crear buckets (idempotente)» (`:88-92`) no necesita cambios en el comando: la variable llega por el `env` del job (es el mismo mecanismo con el que ya recibe `TF_VAR_bucket_suffix`). **No** agregar `DASHBOARD_REPLICA_REGION` a la lista de obligatorias del gate (`:33-35`): es opcional y tiene default. Sí conviene un comentario en el step diciendo que la región réplica llega por entorno.
9. **`.github/workflows/terraform.yml`** — en el bloque `env` (`:34-49`), después de `AWS_REGION` (`:35`):
   ```yaml
   # Región de la réplica del sitio estático. Una sola fuente de verdad para
   # bootstrap-buckets.sh, delete-buckets.sh y Terraform. Vacía = sin réplica.
   DASHBOARD_REPLICA_REGION: ${{ vars.DASHBOARD_REPLICA_REGION || 'us-west-2' }}
   TF_VAR_dashboard_replica_region: ${{ vars.DASHBOARD_REPLICA_REGION || 'us-west-2' }}
   ```
   (en las expresiones de Actions, `||` devuelve el operando derecho cuando el izquierdo es *falsy*, y un repo variable sin definir es string vacío.)
10. **`.github/workflows/terraform.yml`**, step «Compilar y publicar el dashboard» (`:164-178`) — queda:
    ```bash
    ALB="$(terraform -chdir=terraform output -raw alb_dns_name)"
    BUCKET="$(terraform -chdir=terraform output -raw dashboard_bucket)"
    REPLICA_BUCKET="$(terraform -chdir=terraform output -raw dashboard_replica_bucket)"
    VITE_API_BASE="http://${ALB}" npm run build -w @snowball/dashboard
    aws s3 sync packages/dashboard/dist/ "s3://${BUCKET}/" --delete --region "${AWS_REGION}"
    if [ -n "${REPLICA_BUCKET}" ]; then
      aws s3 sync packages/dashboard/dist/ "s3://${REPLICA_BUCKET}/" --delete \
        --region "${DASHBOARD_REPLICA_REGION}"
    fi
    {
      echo "### Despliegue"
      echo "- API: http://${ALB}"
      echo "- Dashboard (${AWS_REGION}): $(terraform -chdir=terraform output -raw dashboard_url)"
      if [ -n "${REPLICA_BUCKET}" ]; then
        echo "- Dashboard réplica (${DASHBOARD_REPLICA_REGION}): $(terraform -chdir=terraform output -raw dashboard_replica_url)"
      fi
      echo "- IoT endpoint: $(terraform -chdir=terraform output -raw iot_endpoint)"
      echo ""
      echo "Las dos URLs sirven el mismo build y consultan el mismo ALB de ${AWS_REGION}."
      echo "Los certificados IoT se bajan en tu máquina con scripts/export-certs.sh."
    } >> "$GITHUB_STEP_SUMMARY"
    ```
    Tres cosas a notar: el `us-east-1` hardcodeado de `:174` **desaparece** (sale del output `dashboard_url`); se pasa `--region` explícito en los dos `sync` en vez de confiar en la resolución automática de región del bucket; y el `if` sobre un output string vacío es lo que hace que el step no se rompa con la réplica apagada.
11. **`README.md`**
    - Paso 1 del bloque de despliegue (`:89-90`): mostrar la variable de entorno.
      ```bash
      # 1. Buckets (los crea la CLI, no Terraform: el SCP del Lab bloquea la lectura de Object Lock)
      #    DASHBOARD_REPLICA_REGION crea además el bucket replicado del dashboard en esa región
      DASHBOARD_REPLICA_REGION=us-west-2 bash scripts/bootstrap-buckets.sh <sufijo> <bucket-de-state>
      ```
    - Paso 5 (`:108-112`): agregar el segundo `sync` y el `echo` de las dos URLs usando los outputs `dashboard_url` / `dashboard_replica_url`.
    - Paso 7 (`:119-121`): `DASHBOARD_REPLICA_REGION=us-west-2 bash scripts/delete-buckets.sh ...`, con una línea que avise que sin la variable el bucket réplica **queda huérfano** y el nombre queda tomado.
    - Nota «Sin `aws_s3_bucket`» (`:183-187`): «los cuatro buckets» pasa a «los buckets (state, dashboard, dashboard réplica, artifacts, archive)».
    - Sección «Variables y outputs» (`:189-213`): sumar `dashboard_replica_region` a las variables nuevas y `dashboard_replica_bucket`, `dashboard_replica_region`, `dashboard_url`, `dashboard_replica_url` a los outputs nuevos.
    - Tabla de módulos / configuración de la raíz (`:166-181`): mencionar los cuatro recursos de la réplica con `region`.
    - Tabla de la sección «Pipeline» (`:291`) y el punto 3 de «Cómo correrlo (cátedra)» (`:330-331`): «la URL del dashboard» → «las dos URLs del dashboard».
    - Variables a cargar en GitHub (`:327-328`): agregar `DASHBOARD_REPLICA_REGION` como **opcional** (con default `us-west-2`).
    - Sección «Pendiente (fases siguientes)» (`:550-554`) y la lista de «Agregado» (`:470-495`): sumar la réplica con la **frase honesta de §3.1**.
12. **`docs/infra-terraform.md`**
    - `:148-150` («Lo que NO crea Terraform: los cuatro buckets»): pasa a cinco, con la región de cada uno.
    - Tabla «Quién es dueño de qué» (`:248-253`): fila nueva para `snowball-dashboard-<sufijo>-<region>` («lo crea el script, lo configura Terraform: cifrado, PAB abierto, website, policy pública»).
    - «Elegir el sufijo» (`:257-266`): el margen real es 34 caracteres, no 44.
    - «Correr el script» (`:267-283`): la variable de entorno y `aws s3api get-bucket-location` como verificación.
    - Sección 10.2 (`:467-481`): los dos `sync` y las dos URLs; **borrar el `s3-website-us-east-1` hardcodeado de `:480`** y usar los outputs.
    - Checklist end-to-end (`:616`): reemplazar la URL hardcodeada por `terraform output -raw dashboard_url` y agregar un ítem para `dashboard_replica_url`.
    - Sección 15 «Destruir» (`:919-928`): la variable de entorno en los dos ejemplos de `delete-buckets.sh`.
    - Sección 16: configuración de la raíz (`:1001-1008`), tabla de variables (`:1036-1066`) y tabla de outputs (`:1067-1088`).
    - Limitaciones conocidas (`:1134`): «**Una sola región** (`us-east-1`) y dos zonas de disponibilidad» pasa a decir que **el backend** está en una sola región y que lo único replicado es el sitio estático, con la frase de §3.1.
    - Troubleshooting (`:1188-1194`, acentos rotos): el `cp` con `--content-type` hay que hacerlo **en los dos buckets**, cada uno con su `--region`. Vale la pena dejarlo escrito porque es un bug que ya apareció una vez.
13. **`docs/terraform-buckets-learner-lab.md`** (`:13-17`) — el párrafo «Para dashboard, artifacts y archive el script sólo crea los buckets» pasa a incluir el réplica, y se agrega que es el **único** bucket que no vive en `var.region` y que su región la fija `DASHBOARD_REPLICA_REGION` / `var.dashboard_replica_region`, que tienen que coincidir.
14. **`docs/features-faltantes-propuesta.md`** — fila 5 (`:19`): tachar «el S3 Website replicado por región» de la lista de faltantes y poner la frase de §3.1, con link a este plan. **Ojo: la fila 5 sigue siendo 🟡**, no ✅: quedan el mapa (F5-A) y MQTT/WSS (F5-C). Prioridad 4 (`:50`) se aclara: la parte «un segundo bucket del dashboard» queda hecha, DynamoDB Global Tables sigue pendiente. Último párrafo (`:53`): quitar «la réplica del dashboard por región» de la lista de cosas sin plan escrito. **No tocar** el link roto a `relevamiento-variante-b.md` (`:53`): ya está anotado en `docs/plan-sin-senal.md:123` como trabajo de otro plan.

---

## 5. Tests

**No hay nada testeable en vitest, y hay que decirlo explícitamente.** Los tests del repo son `vitest` sobre TypeScript (`package.json:11`, `"test": "npm run test --workspaces --if-present"`) y este cambio **no toca ningún archivo de `packages/`**: es Terraform (HCL), bash, YAML de Actions y Markdown. Escribir un test de vitest para esto obligaría a inventar un harness que parsee HCL o que ejecute bash con un `aws` mockeado — mucho andamiaje, cero señal sobre el único riesgo real, que es si AWS acepta las llamadas. Ese riesgo **solo se puede verificar con credenciales** (§9).

Lo que sí se verifica, y cómo:

| Qué | Con qué | Qué atrapa |
|---|---|---|
| Formato del HCL nuevo | `terraform fmt -check -recursive -diff` (CI: `.github/workflows/terraform.yml:64`) | indentación y alineación de los recursos nuevos |
| Sintaxis y referencias | `terraform -chdir=terraform init -backend=false && terraform validate` (CI: `:66-69`) | variable inexistente, `local.bucket_names.dashboard_replica` mal escrito, **atributo inexistente** (si `website_endpoint` no existiera, `validate` lo marcaría), `count` mal puesto, alias de provider no declarado |
| Bloque `validation` de la variable | el mismo `validate`/`plan` con un valor inválido: `terraform -chdir=terraform validate -var dashboard_replica_region=eu-west-1` debe fallar con el `error_message` | que la validación efectivamente rechaza regiones que el Lab no permite |
| Sintaxis de los scripts | `bash -n scripts/bootstrap-buckets.sh && bash -n scripts/delete-buckets.sh` | errores de sintaxis del `IFS`/`read`, comillas sin cerrar |
| Retrocompatibilidad de los scripts | `bash -n` + revisión del diff: sin `DASHBOARD_REPLICA_REGION`, el conjunto de comandos `aws` emitidos tiene que ser **idéntico** al de hoy | que no se rompa ninguna invocación existente (README, composite action) |
| Lista de buckets y regiones sin credenciales | el `echo`/`printf` previo de los dos scripts (`delete-buckets.sh:42-43` ya lo hace; se propone lo mismo en bootstrap) | nombre mal armado, región equivocada, antes de tocar AWS |
| Que el YAML del workflow siga siendo válido | el propio `actions/checkout` + arranque del job en el primer PR | indentación del bloque `env` y del `if` del step |
| Que el dashboard siga compilando | `npm ci && npm run build && npm test` (CI job `app`, `:72-83`) | nada de este cambio puede afectarlo: es la prueba de que no se tocó `packages/` |

**No se propone agregar un job de `shellcheck` al CI.** Sería una mejora genuina, pero es un cambio de alcance del pipeline que ningún plan de F5 pidió; queda como hallazgo.

---

## 6. Impacto en CI

| Gate de CI | Riesgo | Por qué |
|---|---|---|
| `terraform fmt -check -recursive` (`:64`) | **Bajo, pero es el que más rompe PRs.** Mitigación: correr `terraform fmt -recursive` antes de commitear | cuatro recursos nuevos y cinco outputs nuevos: `fmt` alinea los `=` dentro de cada bloque |
| `terraform init -backend=false` + `validate` (`:66-69`) | **Bajo.** `validate` no contacta AWS; la variable nueva tiene default, así que nunca queda sin valor | si se eligiera el provider aliased, `validate` tampoco necesita nada especial (el guide del provider confirma que los alias siguen siendo válidos), pero `region = ""` en un provider **sí** sería inválido |
| `npm ci && npm run build && npm test` (`:80-83`) | **Nulo.** Cero archivos de `packages/` en el diff | — |
| job `plan` de los PRs (`:86-130`) | **Bajo.** El bootstrap no corre en PRs (`action.yml:90`), así que el bucket réplica **no existe** cuando se hace el `plan`. Igual el `plan` pasa: `plan` no llama a `PutBucketWebsite`, solo muestra 4 creates | el `apply` sí fallaría con `NoSuchBucket` si el bootstrap no corrió — pero el `apply` solo pasa por `workflow_dispatch`, donde el bootstrap corre siempre (`action.yml:90`) |
| job `deploy` (`:133-183`) | **Medio, y es el único riesgo real.** Si `vars.DASHBOARD_REPLICA_REGION` y `TF_VAR_dashboard_replica_region` se desincronizan, el `apply` rompe | mitigado porque las dos salen de la **misma** expresión en el bloque `env` (paso 9) |
| gate de la composite action (`action.yml:25-65`) | **Nulo** | no se agrega la variable a la lista de obligatorias: tiene default |

**Primer PR después del merge:** el `plan` comentado en el PR va a mostrar **4 recursos a crear** (o 7 si se elige CRR) y **ningún destroy**. Si muestra un destroy o un replace del dashboard actual, algo está mal y hay que frenar.

---

## 7. Criterios de aceptación

Verificables sin credenciales:

1. `terraform fmt -check -recursive -diff` sin diferencias.
2. `terraform -chdir=terraform init -backend=false && terraform -chdir=terraform validate` en verde.
3. ~~`terraform validate -var dashboard_replica_region=eu-west-1` **falla**.~~ **Criterio corregido (2026-10-20): era inválido.** `validate` **no evalúa los bloques `validation` de las variables** — comprobado: devuelve `Success!` y exit 0. La validación recién salta en `plan`, así que el comando correcto es `terraform -chdir=terraform plan -var dashboard_replica_region=eu-west-1`, que **sí** falla con el `error_message`. Consecuencia que importa: la `validation` **no tiene ningún gate en el job `validate` del CI**, que es el que corre siempre; solo se evalúa en `plan`/`deploy`, que necesitan credenciales.
4. `npm ci && npm run build && npm test` en verde, y `git diff --name-only` **no lista ningún archivo bajo `packages/`**.
5. `bash -n` limpio en los dos scripts.
6. `grep -rn "s3-website-us-east-1" .github README.md docs/infra-terraform.md docs/terraform-buckets-learner-lab.md` **no devuelve nada** (el formato de URL ya no está hardcodeado en ningún lugar operativo). **Criterio acotado (2026-10-20):** la versión original barría todo `docs/`, lo que es imposible de cumplir — los `docs/plan-*.md` citan el host a propósito, incluida la tabla de formatos por región de este mismo plan y este mismo criterio.
7. ~~Sin `DASHBOARD_REPLICA_REGION` el comportamiento es byte por byte el de hoy.~~ **Criterio retirado (2026-10-20):** es incompatible con la decisión 3 de §2.10 (réplica **encendida** por default). Si el script calla la réplica y Terraform la espera, el `apply` falla con `NoSuchBucket`. Los defaults tienen que coincidir en los tres lugares: el script pasó a `${DASHBOARD_REPLICA_REGION:-us-west-2}`, igual que `var.dashboard_replica_region`. La retrocompatibilidad que se conserva es la de los **argumentos** del script, no la de sus defaults.
8. `README.md` y `docs/features-faltantes-propuesta.md` contienen la frase de §3.1 y la fila 5 sigue en 🟡.

Verificables solo con credenciales (§9):

9. Los dos buckets existen, cada uno en su región, con website, policy pública, PAB abierto y cifrado.
10. Las dos URLs devuelven `200` y el mismo `index.html`.
11. El listado de objetos de los dos buckets es idéntico.
12. Se puede iniciar sesión y ver las tarjetas en vivo **desde la URL de la réplica**.
13. Después de `destroy` + `delete-buckets.sh`, `head-bucket` del bucket réplica devuelve 404.

---

## 8. Costo

El `dist/` actual son **3 objetos y 161 KB** (`packages/dashboard/dist/`: `index.html` 425 B, un `.js` de 158.212 B y un `.css` de 3.102 B).

| Concepto | Cuenta | Orden de magnitud |
|---|---|---|
| Almacenamiento del bucket réplica | 0,000157 GB × USD 0,023/GB-mes (S3 Standard, us-east-1) | ≈ **USD 0,0000036/mes** |
| PUTs de un deploy a los dos buckets | 6 PUT × USD 0,005/1.000 | ≈ **USD 0,00003** por deploy |
| GETs de los visitantes | USD 0,0004/1.000 GET | 3 GET por carga de página: indistinguible de cero |
| Transferencia de salida a internet | primeros 100 GB/mes gratis; después USD 0,09/GB | 161 KB por carga: ≈ USD 0,0000145 si llegara a facturarse |
| **Solo si va CRR:** transferencia inter-región `us-east-1` → otra región de EE. UU. | USD **0,01/GB** × 0,000157 GB | ≈ **USD 0,0000016** por replicación completa |
| **Solo si va CRR:** PUTs de replicación en destino + almacenamiento de versiones acumuladas por cada `--delete` | 3 objetos × N deploys × 161 KB | centésimas de centavo incluso con cientos de deploys |

**Conclusión honesta: el costo es indistinguible de cero en la factura del Lab** — centésimas de centavo por mes contra el NAT Gateway (≈ USD 32/mes) y el ALB (≈ USD 16/mes) que `docs/infra-terraform.md:906-910` identifica como lo único que pesa. **El costo real de esta feature no es dinero: es complejidad operativa** (un bucket más que crear, configurar, publicar y borrar, en una región donde nadie mira). Ese es el argumento para preferir el camino con menos piezas móviles.

Precios: tarifas públicas de S3 (us-east-1) consultadas el 2026-10-20; GET en S3 Standard a USD 0,0004/1.000 y transferencia inter-región desde N. Virginia a otra región de EE. UU. a USD 0,01/GB están en la página oficial de precios de S3; el almacenamiento a USD 0,023/GB-mes (primeros 50 TB) y los PUT a USD 0,005/1.000 hay que reconfirmarlos en la calculadora oficial antes de ponerlos en una lámina (las fuentes que los listan son secundarias).

---

## 9. Checklist de verificación manual en AWS

**Nada de esto se pudo correr en la sesión de planificación: no hay credenciales.** Correr con una sesión fresca del Learner Lab (vencen a las ~4 h). Reemplazar `grupo-01` / `snowball-tfstate-grupo-01` por los valores reales.

### 9.A — Camino (a), dual-deploy

```bash
# 0. Precondiciones y el supuesto de que us-west-2 responde
aws sts get-caller-identity
aws ec2 describe-regions --region us-west-2 --query 'Regions[?RegionName==`us-west-2`].RegionName'
aws s3 ls                                   # los cuatro buckets actuales

# 1. Bootstrap con réplica (idempotente: se puede correr sobre un despliegue existente)
export DASHBOARD_REPLICA_REGION=us-west-2
bash scripts/bootstrap-buckets.sh grupo-01 snowball-tfstate-grupo-01
# -> tiene que imprimir "Creating bucket: snowball-dashboard-grupo-01-us-west-2"
#    Si da AccessDenied o un deny explícito de SCP: el camino (a) tampoco es viable y
#    hay que documentarlo como límite del Lab (no forzarlo).

# 2. El bucket quedó REALMENTE en us-west-2 (no es cosmético: el nombre no prueba nada)
aws s3api get-bucket-location --bucket snowball-dashboard-grupo-01-us-west-2
# -> {"LocationConstraint": "us-west-2"}

# 3. Plan: tiene que mostrar 4 creates y NINGÚN destroy ni replace del dashboard actual
terraform -chdir=terraform plan -var dashboard_replica_region=us-west-2
terraform -chdir=terraform apply

# 4. Las cuatro configuraciones quedaron aplicadas en la región correcta
R=us-west-2; B=snowball-dashboard-grupo-01-us-west-2
aws s3api get-bucket-website            --bucket "$B" --region "$R"   # IndexDocument: index.html
aws s3api get-bucket-policy             --bucket "$B" --region "$R"   # s3:GetObject, Principal "*"
aws s3api get-public-access-block       --bucket "$B" --region "$R"   # los cuatro flags en false
aws s3api get-bucket-encryption         --bucket "$B" --region "$R"   # SSEAlgorithm: AES256

# 5. Outputs nuevos
terraform -chdir=terraform output -raw dashboard_bucket
terraform -chdir=terraform output -raw dashboard_replica_bucket
terraform -chdir=terraform output -raw dashboard_url
terraform -chdir=terraform output -raw dashboard_replica_url
# -> dashboard_url debe terminar en s3-website-us-east-1.amazonaws.com
#    dashboard_replica_url debe terminar en s3-website-us-west-2.amazonaws.com
#    (los dos con GUIÓN: es el formato que la tabla oficial da para estas dos regiones)

# 6. Publicar en los dos
ALB=$(terraform -chdir=terraform output -raw alb_dns_name)
A=$(terraform -chdir=terraform output -raw dashboard_bucket)
VITE_API_BASE="http://${ALB}" npm run build -w @snowball/dashboard
aws s3 sync packages/dashboard/dist/ "s3://${A}/" --delete --region us-east-1
aws s3 sync packages/dashboard/dist/ "s3://${B}/" --delete --region us-west-2

# 7. Los dos buckets tienen EXACTAMENTE lo mismo (esta es la prueba de dual-deploy)
diff <(aws s3 ls "s3://${A}/" --recursive --region us-east-1 | awk '{print $3, $4}' | sort) \
     <(aws s3 ls "s3://${B}/" --recursive --region us-west-2 | awk '{print $3, $4}' | sort)
# -> sin salida

# 8. Las dos URLs sirven
for U in "$(terraform -chdir=terraform output -raw dashboard_url)" \
         "$(terraform -chdir=terraform output -raw dashboard_replica_url)"; do
  echo -n "$U -> "; curl -s -o /dev/null -w '%{http_code}\n' "$U"
done
# -> 200 y 200. Un 404 NoSuchKey significa bucket vacío (docs/infra-terraform.md:483-484);
#    un 403 significa que la policy pública o el PAB no se aplicaron.

# 9. Funcional desde la réplica (el punto que importa para la defensa)
#  - Abrir dashboard_replica_url en el navegador, iniciar sesión (operator/supervisor/admin
#    de scripts/seed-data.json), ver las tres tarjetas actualizándose en vivo y el historial.
#  - En la consola del navegador (F12) NO debe haber errores de CORS: el ALB es el mismo
#    de us-east-1 y cors_origin tiene que seguir en "*" (terraform/variables.tf:65-69).
#  - Comprobar que la URL de la API horneada en el bundle es la del ALB de us-east-1:
curl -s "$(terraform -chdir=terraform output -raw dashboard_replica_url)/assets/" >/dev/null
#    (o buscar el DNS del ALB dentro del .js descargado)
#  - Verificar los acentos: si aparecen "Ã±", aplicar el fix de content-type de
#    docs/infra-terraform.md:1188-1194 EN LOS DOS BUCKETS, cada uno con su --region.

# 10. El ciclo de limpieza cierra (si esto falla, el nombre queda tomado para siempre)
terraform -chdir=terraform destroy
DASHBOARD_REPLICA_REGION=us-west-2 bash scripts/delete-buckets.sh grupo-01 snowball-tfstate-grupo-01 --yes
aws s3api head-bucket --bucket "$B" --region us-west-2    # debe fallar con 404
aws s3 ls                                                  # solo queda el bucket de state
```

### 9.B — Camino (b), CRR: spike bloqueante **antes** de escribir código

```bash
# B1. ¿LabRole confía en S3? Si s3.amazonaws.com NO aparece, (b) NO es viable. Fin.
aws iam get-role --role-name LabRole \
  --query 'Role.AssumeRolePolicyDocument.Statement[].Principal'

# B2. ¿Qué permisos tiene LabRole sobre S3? (buscar s3:ReplicateObject / s3:Replicate*)
aws iam list-attached-role-policies --role-name LabRole
aws iam list-role-policies --role-name LabRole

# B3. ¿El SCP permite habilitar replicación? Probar sobre los buckets reales, con
#     versionado puesto primero (origen y destino), y mirando si falla por SCP o por IAM.
aws s3api put-bucket-versioning --bucket "$A" --region us-east-1 \
  --versioning-configuration Status=Enabled
aws s3api put-bucket-versioning --bucket "$B" --region us-west-2 \
  --versioning-configuration Status=Enabled
aws s3api get-bucket-replication --bucket "$A" --region us-east-1   # antes: NoSuchReplicationConfiguration

# B4. Después del apply de Terraform, medir la convergencia con un objeto canario
echo "probe $(date -u +%s)" | aws s3 cp - "s3://${A}/canary.txt" --region us-east-1
for i in $(seq 1 20); do
  if aws s3api head-object --bucket "$B" --key canary.txt --region us-west-2 >/dev/null 2>&1; then
    echo "replicado en ~$((i*15)) s"; break
  fi
  sleep 15
done
aws s3api head-object --bucket "$A" --key canary.txt --region us-east-1 \
  --query 'ReplicationStatus'   # COMPLETED

# B5. Verificar las dos trampas documentadas de CRR
#   - Objetos preexistentes: los que ya estaban antes de habilitar la replicación
#     NO aparecen en el destino. Confirmar con el diff del paso 7 de 9.A: va a dar diferencias.
#   - Borrados: hacer un sync con --delete en origen y ver si el objeto desaparece del
#     destino (solo pasa si delete_marker_replication está Enabled, y nunca para versiones puntuales).
aws s3api list-object-versions --bucket "$B" --region us-west-2 \
  --query 'DeleteMarkers[].Key'
```

Si B1 o B3 fallan: **no forzar**. El resultado esperado es documentar en `docs/` por qué CRR no es viable en el Learner Lab y qué haría falta en una cuenta real, e implementar (a). Eso cuenta como entregable cumplido.

---

## 10. Solapamiento con otros planes

Dos agentes están planificando F5-A (mapa) y F5-C (MQTT/WSS) en paralelo.

| Archivo | Lo toca también | Choque | Cómo se resuelve |
|---|---|---|---|
| `README.md` | plan-mapa, plan-mqtt | **Sí**, seguro | Secciones distintas: F5-B toca «Despliegue» (`:79-122`), «Variables y outputs» (`:189-213`), «Pipeline» (`:280-336`) y «Pendiente» (`:550-554`); el mapa toca «Uso de la aplicación» y la tabla de paquetes (`:73`). Merge trivial si cada uno se queda en su sección |
| `docs/features-faltantes-propuesta.md` | plan-mapa, plan-mqtt | **Sí**, los tres editan la **misma fila 5** (`:19`) | **Un solo agente** la edita al final, con el estado consolidado de las tres sub-features. No tres ediciones concurrentes de la misma celda |
| `terraform/variables.tf` | plan-mqtt (variables del authorizer) | **Sí** | Puntos de inserción distintos: F5-B inserta después de `var.region` (`:5`), MQTT al final (después de `:153`) |
| `terraform/outputs.tf` | plan-mqtt (ARN del authorizer) | **Sí** | F5-B inserta después de `:12`, MQTT al final (después de `:55`) |
| `terraform/main.tf` | plan-mqtt (authorizer, permiso de Lambda) | **Sí** | F5-B inserta después de `:104` (bloque del dashboard), MQTT al final |
| `terraform/locals.tf` | plan-mqtt (una Lambda nueva en `local.lambdas`) | **Sí** | F5-B toca `local.bucket_names` (`:23-27`), MQTT toca `local.lambdas` (`:28-68`) |
| `.github/workflows/terraform.yml` | plan-mqtt (posible `TF_VAR_*` nueva) | **Sí**, el bloque `env` (`:34-49`) y el step de publicación (`:164-178`) | F5-B es dueño del step de publicación; en `env` cada uno agrega sus líneas |
| `packages/dashboard/**`, `packages/api/**` | plan-mapa, plan-mqtt | **No** | F5-B no toca `packages/` |
| `scripts/*`, `docs/infra-terraform.md`, `docs/terraform-buckets-learner-lab.md` | — | **No** | exclusivos de F5-B |

**Orden sugerido:** F5-B puede ir **en paralelo** con F5-A (el mapa vive en `packages/dashboard/`, F5-B en `terraform/` + `scripts/` + `.github/`; el único cruce es el README). Contra F5-C hay que **secuenciar los cuatro archivos de Terraform y el `env` del workflow**, o acordar los puntos de inserción de la tabla antes de lanzar los agentes.

**Dependencia blanda con F5-A:** el mapa va a agregar Leaflet al bundle, lo que probablemente lleve los 161 KB actuales a varios cientos. Eso **no cambia ninguna decisión de este plan** (el costo sigue siendo indistinguible de cero, §8), pero si F5-A entra primero hay que volver a medir el `dist/` antes de citar números en la defensa.

---

## 11. Fuera de alcance

Replicación multi-región del **backend** (DynamoDB Global Tables, segunda región de la API o del ALB) — es la prioridad 4 de `docs/features-faltantes-propuesta.md:50` y explícitamente otra tarea. Route 53, CloudFront, HTTPS de punta a punta y dominio propio: no están disponibles en el Lab. Medición de latencias (prioridad 5), autoescalado de la API, umbrales por Device Shadow. El mapa de unidades (F5-A) y la suscripción MQTT sobre WebSockets (F5-C), que tienen plan propio.

---

## 12. Fuentes consultadas (2026-10-20)

- Endpoints de website de S3 por región y la nota de que no soportan HTTPS: *Amazon Simple Storage Service endpoints and quotas*, sección «Amazon S3 website endpoints and HostedZone IDs» — `docs.aws.amazon.com/general/latest/gr/s3.html`.
- Reglas de nombres de bucket (3–63 caracteres, caracteres permitidos, prefijos y sufijos reservados, unicidad global por partición): *General purpose bucket naming rules* — `docs.aws.amazon.com/AmazonS3/latest/userguide/bucketnamingrules.html`.
- Requisitos de replicación y que los objetos preexistentes no se replican: *Setting up live replication overview* — `docs.aws.amazon.com/AmazonS3/latest/userguide/replication-how-setup.html`.
- Trust policy (`s3.amazonaws.com`) y permisos del rol de replicación: *Setting up permissions for live replication* — `docs.aws.amazon.com/AmazonS3/latest/userguide/setting-repl-config-perm-overview.html`.
- Atributos exportados `website_endpoint` / `website_domain` y el argumento `region`: doc del provider de `aws_s3_bucket_website_configuration`, `aws_s3_bucket_policy` y `aws_s3_bucket_public_access_block`.
- `region` por recurso en el provider v6, servicios globales excluidos (IAM, Route 53, CloudFront), y que los provider alias siguen siendo válidos: guide *Enhanced Region Support* del provider AWS.
- `aws_s3_bucket_replication_configuration`: `bucket`/`role`/`rule` requeridos, `delete_marker_replication` solo en configuraciones V2, `existing_object_replication` no soportado por S3.
- Precios de S3 (GET en S3 Standard USD 0,0004/1.000 y transferencia inter-región desde N. Virginia USD 0,01/GB): página oficial de precios de S3. El almacenamiento (USD 0,023/GB-mes) y los PUT (USD 0,005/1.000) provienen de fuentes secundarias y **conviene reconfirmarlos** en la calculadora oficial antes de citarlos.
