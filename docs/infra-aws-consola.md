# Snowball — Guía de infraestructura por consola AWS (VPC + ingesta + alertas + API + dashboard)

Guía paso a paso para crear **a mano, desde la consola**, todos los recursos que
el código de este repo necesita. No usamos IaC en esta entrega: cualquier
integrante puede reconstruir el entorno siguiendo este documento (por ejemplo,
después de un *Reset* del Learner Lab).

> **Los nombres importan.** El código lee estos nombres desde
> `packages/shared/src/config.ts` (`NAMES` para los servicios, `NETWORK` para la
> red). Si cambiás un nombre acá, cambialo allá.

**El orden de este documento es el orden de creación.** La red va primero porque
todo lo demás nace adentro: no se puede crear la RDS sin su *DB subnet group*,
ni el ALB sin dos subredes públicas, ni el Auto Scaling Group sin el *target
group* del balanceador.

| Recurso | Nombre |
|---|---|
| VPC | `snowball-vpc` — `10.0.0.0/16` |
| Subredes públicas | `snowball-public-a` `10.0.1.0/24` · `snowball-public-b` `10.0.2.0/24` |
| Subredes de aplicación | `snowball-app-a` `10.0.11.0/24` · `snowball-app-b` `10.0.12.0/24` |
| Subredes de datos | `snowball-data-a` `10.0.21.0/24` · `snowball-data-b` `10.0.22.0/24` |
| Internet Gateway | `igw-snowball` |
| NAT Gateway | `nat-snowball-a` (zonal, en `snowball-public-a`) |
| Tablas de ruteo | `rt-public`, `rt-app-a`, `rt-app-b`, `rt-data` |
| Gateway endpoints | `vpce-s3`, `vpce-ddb` |
| Security groups | `sg-alb`, `sg-app`, `sg-db`, `sg-bastion` |
| NACL | `nacl-data` (solo sobre las subredes de datos) |
| Balanceador | `snowball-alb` + target group `snowball-app-tg` |
| Cómputo | launch template `snowball-app-lt` → ASG `snowball-app-asg` (`t3.small`) |
| Bastión | `snowball-bastion` |
| RDS | `snowball-db` · DB subnet group `snowball-db-subnets` · base `snowball` |
| Tabla DynamoDB | `snowball-telemetry` |
| Tabla DynamoDB de estado | `snowball-unit-state` |
| Cola SQS principal | `snowball-readings` |
| Cola SQS DLQ | `snowball-readings-dlq` |
| Tópicos SNS | `snowball-thermal-excursion`, `snowball-low-battery`, `snowball-no-signal` |
| Regla IoT | `snowball_telemetry` |
| Tópicos MQTT | `snowball/<unit>/telemetry` |
| Things IoT / unidades | `SB-001`, `SB-002`, `SB-003` |

---

## 0. Antes de empezar

1. **Start Lab** en AWS Academy y esperar el círculo verde; entrar por el link **AWS**.
2. Verificar arriba a la derecha que la región sea **N. Virginia (us-east-1)**. Todo se crea ahí.
3. **Dos zonas de disponibilidad: `us-east-1a` y `us-east-1b`.** No es una
   preferencia estética y conviene tenerlo claro antes de empezar: RDS Multi-AZ
   exige un *DB subnet group* con subredes en al menos dos zonas, y un ALB exige
   al menos dos subredes públicas en zonas distintas. El requisito de alta
   disponibilidad impone el número de subredes por sí solo.
4. Recordatorios de presupuesto: lo que factura por hora es **RDS, las EC2, el
   NAT Gateway y el ALB**. DynamoDB, SQS, SNS, IoT Core y S3 a escala de demo
   cuestan centavos y no hace falta borrarlos. Ver la sección final.
5. En este laboratorio no se pueden crear roles IAM: donde un servicio pida un
   rol, usar siempre **LabRole** (y en EC2, el instance profile **LabInstanceProfile**).
6. Antes de comprometerse con el diseño conviene confirmar en la consola tres
   cosas: que se pueda crear un **NAT Gateway**, que **RDS admita Multi-AZ** con
   `db.t3.micro`, y que en **IoT Core** se puedan crear things, certificados y
   una regla que asuma el LabRole hacia DynamoDB y SQS.

---

## 1. VPC, subredes, ruteo y endpoints

Esta sección crea la red entera. Nada de lo que sigue funciona sin ella.

### 1.1 La VPC

**VPC → Your VPCs → Create VPC** → elegir **VPC only** (no el asistente, que
crea subredes que no son las nuestras):

1. Name tag: `snowball-vpc`
2. IPv4 CIDR: `10.0.0.0/16`
3. Sin IPv6, tenancy **Default** → Create.

Son 65.536 direcciones, muchísimas más de las necesarias. La holgura es
intencional: el espacio de direcciones de una VPC no se puede achicar después, y
conviene dejar lugar para subredes futuras — una capa de caché, un entorno de
staging, o el peering con una segunda región.

### 1.2 Las seis subredes

**VPC → Subnets → Create subnet** → VPC: `snowball-vpc`. Crear las seis, una por
una (la consola permite varias en la misma pantalla con *Add new subnet*):

| Nombre | CIDR | Zona | Tipo | Qué contiene y por qué existe |
|---|---|---|---|---|
| `snowball-public-a` | `10.0.1.0/24` | `us-east-1a` | Pública | Nodo del ALB, NAT Gateway y bastión. La única capa que necesita direcciones alcanzables desde Internet |
| `snowball-public-b` | `10.0.2.0/24` | `us-east-1b` | Pública | Segundo nodo del balanceador. Sin ella el ALB no se puede crear |
| `snowball-app-a` | `10.0.11.0/24` | `us-east-1a` | Privada | EC2 de la API y el procesador de alertas. Sin IP pública: se alcanza solo a través del ALB |
| `snowball-app-b` | `10.0.12.0/24` | `us-east-1b` | Privada | Idéntica a la anterior. El ASG mantiene instancias en ambas |
| `snowball-data-a` | `10.0.21.0/24` | `us-east-1a` | Privada aislada | Instancia primaria de RDS. Sin ruta por defecto de ningún tipo |
| `snowball-data-b` | `10.0.22.0/24` | `us-east-1b` | Privada aislada | Standby síncrono de RDS, que toma el rol de primaria en un failover |

Cada `/24` deja 251 direcciones usables — AWS reserva cinco por subred — y el
salto entre el tercer octeto de cada capa (1–2, 11–12, 21–22) hace que el rol de
una subred se lea de un vistazo en cualquier tabla de ruteo o log de flujo.

En las dos subredes públicas: **Actions → Edit subnet settings → Enable
auto-assign public IPv4 address**. En las otras cuatro, dejarlo desactivado.

### 1.3 Internet Gateway

**VPC → Internet gateways → Create internet gateway** → Name: `igw-snowball` →
Create → **Actions → Attach to VPC** → `snowball-vpc`.

> No hay un atributo de subred que diga «pública». Una subred es pública porque
> una tabla de ruteo apunta al IGW, y nada más. El IGW se adjunta a la VPC
> entera, no a una subred ni a una zona.

### 1.4 NAT Gateway

**VPC → NAT gateways → Create NAT gateway**:

1. Name: `nat-snowball-a`
2. Subnet: **`snowball-public-a`**
3. Connectivity type: **Public** → **Allocate Elastic IP** → Create.

Es **uno solo, y es un recurso zonal**: vive en `us-east-1a`, tiene una Elastic
IP, y si esa zona cae, se cae con ella. Esa es una debilidad conocida y
deliberada: si cae la zona `a`, el ALB y el ASG y RDS se recuperan solos, pero
se pierde la salida a Internet de las instancias privadas y las alertas se
retrasan hasta que vuelva. Un segundo NAT en `us-east-1b` lo resolvería a
cambio de unos USD 32 al mes; para esta entrega no se justifica.

### 1.5 Las cuatro tablas de ruteo

La diferencia entre estas cuatro tablas define la seguridad de la arquitectura
mucho más que cualquier regla de firewall.

**VPC → Route tables → Create route table** (VPC `snowball-vpc`) por cada una, y
después **Subnet associations** y **Routes** en cada pestaña:

| Tabla | Asociada a | Rutas |
|---|---|---|
| `rt-public` | `snowball-public-a`, `snowball-public-b` | `10.0.0.0/16 → local` · `0.0.0.0/0 → igw-snowball` |
| `rt-app-a` | `snowball-app-a` | `local` · `0.0.0.0/0 → nat-snowball-a` · `pl-s3 → vpce-s3` · `pl-dynamodb → vpce-ddb` |
| `rt-app-b` | `snowball-app-b` | idénticas a `rt-app-a` |
| `rt-data` | `snowball-data-a`, `snowball-data-b` | `10.0.0.0/16 → local` |

Las entradas `pl-*` las agrega sola la consola al crear los endpoints (paso 1.6);
no hay que escribirlas a mano.

**`rt-data` tiene una sola entrada, y eso es el corazón del diseño.** No hay ruta
hacia el Internet Gateway ni hacia el NAT: una máquina en esa subred no puede
iniciar una conversación con Internet y —más importante para la demo— no existe
camino de retorno para un paquete que venga de afuera. El aislamiento de la base
de datos no depende de una regla de security group que alguien pueda aflojar sin
querer, sino de que la ruta directamente no existe.

Las tablas de app son **dos idénticas** por una razón operativa, no de
configuración: si mañana se agrega un segundo NAT Gateway en la zona `b`, alcanza
con cambiar una línea de `rt-app-b`. Con una tabla compartida habría que
separarlas primero.

### 1.6 Gateway endpoints para S3 y DynamoDB

**VPC → Endpoints → Create endpoint**, dos veces:

1. Name `vpce-s3` · Type **AWS services** · buscar `com.amazonaws.us-east-1.s3`
   → elegir el de tipo **Gateway** · VPC `snowball-vpc` · Route tables: marcar
   **`rt-app-a` y `rt-app-b`** → Create.
2. Ídem con `com.amazonaws.us-east-1.dynamodb`, Name `vpce-ddb`, las mismas dos
   tablas.

No cuestan por hora ni por gigabyte, y sacan del NAT el tráfico de las
instancias hacia esos dos servicios: las consultas de telemetría que la API hace
a DynamoDB y la exportación del histórico a S3. La escritura masiva de la
telemetría no los atraviesa —la hace la regla de IoT Core, que vive fuera de la
VPC— pero el endpoint sigue siendo la diferencia entre pagar procesamiento de NAT
por cada consulta del dashboard y no pagarlo.

> **Un gateway endpoint no es una caja dentro de una subred.** No tiene ENI, ni
> IP, ni security group: es una entrada en la tabla de ruteo que desvía el
> tráfico por el backbone de AWS. Un *interface* endpoint sí sería una ENI con IP
> privada y security group propio — y por eso cuesta por hora. No usamos ninguno:
> los de SNS y SQS evitarían el NAT para las alertas y el consumo de la cola,
> pero cuestan unos USD 7 por mes cada uno más tráfico, y con el volumen de la
> demo pasar por el NAT sale más barato. Si el volumen crece, el de SQS es el
> primero que conviene agregar.

---

## 2. Security groups y NACL

### 2.1 Los cuatro security groups encadenados

El principio que ordena toda la configuración: **ningún security group referencia
un rango de direcciones cuando puede referenciar otro security group.** Un grupo
como origen es una identidad, no una ubicación: sigue funcionando cuando el ASG
reemplaza una instancia y le asigna otra IP, y no depende de que el CIDR que
alguien copió siga siendo el correcto. El resultado es una cadena donde cada
eslabón solo acepta al anterior.

**EC2 → Security Groups → Create security group**, cuatro veces, todos en
`snowball-vpc`. Crearlos primero vacíos y después agregar las reglas: se
referencian entre sí y no se puede apuntar a un grupo que todavía no existe.

| Grupo | Entrante | Saliente |
|---|---|---|
| `sg-alb` | `80/TCP` desde `0.0.0.0/0` | `3000/TCP` hacia `sg-app` |
| `sg-app` | `3000/TCP` desde `sg-alb` · `22/TCP` desde `sg-bastion` | `5432/TCP` hacia `sg-db` · `443/TCP` hacia `0.0.0.0/0` (APIs de AWS vía endpoints y NAT) |
| `sg-db` | `5432/TCP` desde `sg-app` y nada más | ninguna regla |
| `sg-bastion` | `22/TCP` desde la IP fija del equipo | `22/TCP` hacia `sg-app` |

Dos aclaraciones sobre los puertos:

- **La API escucha en el 3000**, que es el default de `PORT` en
  `packages/api/src/index.ts`. El diseño en prosa menciona 8080 en algún lugar;
  el código manda.
- **El listener del ALB es HTTP en el 80.** En producción sería 443 con un
  certificado de ACM, pero en el Learner Lab no se puede registrar un dominio y
  sin dominio un certificado público de ACM no se puede validar. El endpoint del
  sitio en S3 también es HTTP, así que la demo es HTTP de punta a punta.

> Con la ingesta en IoT Core, **ningún puerto de entrada de datos existe en la
> VPC**: el único ingreso de aplicación es el `3000` desde el ALB. La versión
> previa de este diseño abría el `8883` desde `0.0.0.0/0` para los sensores y el
> `2049` para NFS hacia EFS. La superficie de exposición del cómputo se redujo a
> un solo puerto desde una sola identidad.

### 2.2 La NACL de la capa de datos

Los security groups son **stateful**: si se permite la entrada, la respuesta sale
sin regla explícita. Las NACLs son **stateless** y actúan a nivel de subred,
antes de que el paquete llegue a la instancia. Se aplica una sola, como segunda
capa independiente.

**VPC → Network ACLs → Create network ACL** → Name `nacl-data` → VPC
`snowball-vpc` → Create. Después:

- **Subnet associations**: `snowball-data-a` y `snowball-data-b`.
- **Inbound rules**: regla 100, `PostgreSQL (5432)`, source `10.0.11.0/24`,
  Allow; regla 110, ídem con `10.0.12.0/24`. El `DENY` final va implícito.
- **Outbound rules**: regla 100, `Custom TCP`, rango `1024–65535`, destino
  `10.0.0.0/16`, Allow. Esta regla es necesaria justamente porque la NACL no
  recuerda la conexión de ida.

Conviene ser honesto sobre qué aporta: **no agrega seguridad frente a un
atacante que ya comprometió `sg-app`**, pero sí frente al error humano. Si
alguien agrega por equivocación una regla permisiva en `sg-db`, la NACL sigue
descartando el tráfico que no venga de las subredes de aplicación.

Sobre las demás subredes se deja la **NACL por defecto**, que permite todo, y es
una decisión deliberada: duplicar ahí las reglas de los security groups solo
agrega superficie de error de configuración sin ganancia real.

---

## 3. DynamoDB — tablas de telemetría

### 3.1 Histórico: `snowball-telemetry`

Consola → **DynamoDB → Tables → Create table**:

1. Table name: `snowball-telemetry`
2. Partition key: `unit_id` — tipo **String**
3. Sort key: `ts` — tipo **String**
4. Table settings → **Customize settings** → Capacity mode: **On-demand**
5. Create table.

Después, con la tabla creada → pestaña **Additional settings** →
**Time to Live (TTL)** → *Turn on* → TTL attribute: `expires_at`.
(`expires_at` lo calcula la **regla de IoT Core** — §6.4 — como epoch en
segundos a 30 días de la ingesta; el dispositivo no lo manda. DynamoDB borra solo.)

### 3.2 Estado actual: `snowball-unit-state`

Una fila por unidad con su **última lectura**, sobrescrita por cada mensaje.
La API usa esta tabla para `GET /api/units` y para el primer envío del feed
en vivo, sin recorrer el histórico.

1. **Create table** → Table name: `snowball-unit-state`
2. Partition key: `unit_id` — tipo **String**. **Sin sort key.**
3. Capacity mode: **On-demand** → Create table.

> **No activar TTL en esta tabla**: una unidad que dejó de reportar debe seguir
> mostrando su última lectura para poder detectar «sin señal».

---

## 4. SQS — cola de lecturas + DLQ

**Primero la DLQ** (para poder referenciarla desde la principal):

1. **SQS → Create queue** → tipo **Standard** → Name: `snowball-readings-dlq`.
2. Todo lo demás por defecto → Create queue.

**Después la principal**:

1. **Create queue** → **Standard** → Name: `snowball-readings`.
2. **Visibility timeout: 60 seconds** (el procesador tiene tiempo de sobra para
   RDS + SNS antes de que el mensaje reaparezca).
3. **Receive message wait time: 20 seconds** (long polling).
4. Sección **Dead-letter queue** → *Enabled* → elegir `snowball-readings-dlq` →
   **Maximum receives: 3**.
5. Create queue. **Copiar la URL de la cola** (la necesita el procesador como
   `SQS_QUEUE_URL`).

---

## 5. SNS — tópicos de alertas

Por cada uno de estos tres nombres: **SNS → Topics → Create topic** →
tipo **Standard** → Name → Create:

- `snowball-thermal-excursion`  ← el único que usa el código en esta fase
- `snowball-low-battery`
- `snowball-no-signal`

Suscribirse al de excursión: abrir el tópico → **Create subscription** →
Protocol **Email** → poner el mail del grupo → Create → **confirmar desde el
mail que llega** (sin confirmar no se entrega nada).
**Copiar el ARN** de `snowball-thermal-excursion` (env `SNS_THERMAL_EXCURSION_TOPIC_ARN`).

---

## 6. IoT Core — dispositivos, certificados y regla

### 6.1 Endpoint

Es el `--endpoint` del simulador, con la forma
`xxxxxxxxxxxxxx-ats.iot.us-east-1.amazonaws.com`. Tiene que ser la variante
**`-ats`** (Amazon Trust Services): es la que valida contra el
`AmazonRootCA1.pem` que carga el simulador.

La consola ya **no** lo muestra en *Settings*. Cualquiera de estos tres da el
mismo valor:

- **CloudShell** (botón abajo a la izquierda):
  ```bash
  aws iot describe-endpoint --endpoint-type iot:Data-ATS
  ```
- **Connect → Domain configurations** → entrada `iot:Data-ATS` (existe por
  defecto) → campo **Domain name**.
- **Connect → Connect one device** → el asistente lo muestra en el primer
  paso (leerlo y salir, no hace falta completarlo).

### 6.2 Política de dispositivos (una sola para todos)

**IoT Core → Security → Policies → Create policy**:

- Name: `snowball-device-policy`
- Elegir **JSON** y pegar:

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Action": "iot:Connect",
      "Resource": "arn:aws:iot:us-east-1:*:client/${iot:Connection.Thing.ThingName}"
    },
    {
      "Effect": "Allow",
      "Action": "iot:Publish",
      "Resource": [
        "arn:aws:iot:us-east-1:*:topic/snowball/${iot:Connection.Thing.ThingName}/*",
        "arn:aws:iot:us-east-1:*:topic/$aws/things/${iot:Connection.Thing.ThingName}/shadow/*"
      ]
    },
    {
      "Effect": "Allow",
      "Action": "iot:Subscribe",
      "Resource": "arn:aws:iot:us-east-1:*:topicfilter/$aws/things/${iot:Connection.Thing.ThingName}/shadow/*"
    },
    {
      "Effect": "Allow",
      "Action": "iot:Receive",
      "Resource": "arn:aws:iot:us-east-1:*:topic/$aws/things/${iot:Connection.Thing.ThingName}/shadow/*"
    }
  ]
}
```

Las *policy variables* (`${iot:Connection.Thing.ThingName}`) hacen que cada
dispositivo solo pueda conectarse con su propio nombre y publicar en **sus**
tópicos: es la ACL por dispositivo del diseño, sin escribir una política por unidad.

### 6.3 Things + certificados (repetir por unidad: SB-001, SB-002, SB-003)

**IoT Core → All devices → Things → Create things → Create single thing**:

1. Thing name: `SB-001` (exacto, es la identidad en TODO el sistema). Sin thing type ni shadow named.
2. Device Shadow: elegir **Unnamed shadow (classic)**.
3. **Auto-generate a new certificate**.
4. Attach policies: marcar `snowball-device-policy`.
5. En la pantalla de descarga, bajar y guardar (después no se puede volver a bajar la key):
   - Device certificate → guardarlo como `certs/SB-001/certificate.pem.crt`
   - Private key file → `certs/SB-001/private.pem.key`
   - Amazon Root CA 1 → `certs/AmazonRootCA1.pem` (una sola vez, es común a todos)
6. Verificar en **Security → Certificates** que el certificado quede **Active**.

La carpeta `certs/` va en la raíz del repo **y está gitignoreada: las claves
privadas no se commitean jamás**. Estructura esperada:

```
certs/
├── AmazonRootCA1.pem
├── SB-001/certificate.pem.crt
├── SB-001/private.pem.key
├── SB-002/…
└── SB-003/…
```

### 6.4 La regla de ingesta (el corazón de esta revisión)

**IoT Core → Message routing → Rules → Create rule**:

1. Name: `snowball_telemetry`.
2. SQL statement (versión 2016-03-23):

```sql
SELECT *, topic(2) AS unit_id, floor(timestamp() / 1000) + 2592000 AS expires_at
FROM 'snowball/+/telemetry'
```

`topic(2)` obtiene la unidad del tópico; `timestamp()` es el instante de
ingesta en milisegundos, así que `expires_at` queda en epoch-segundos a 30 días.
El TTL lo decide el servidor, no el dispositivo.

3. **Action 1 — DynamoDBv2**: *Insert a message into a DynamoDB table* →
   Table: `snowball-telemetry` → IAM role: **LabRole**.
4. **Add action** → **Action 2 — DynamoDBv2**: Table: `snowball-unit-state` →
   IAM role: **LabRole**. (Misma clave `unit_id`: cada lectura pisa la anterior.)
5. **Add action** → **Action 3 — SQS**: Queue: `snowball-readings` →
   *Use the message as-is* (sin base64) → IAM role: **LabRole**.
6. **Error action** (abajo): *Send message data to CloudWatch logs* →
   Log group: crear `snowball-iot-errors` → IAM role: **LabRole**.
7. Create rule.

> Si al elegir LabRole la consola se queja de permisos, reintentar una vez —
> pasa lo mismo que documenta el propio lab con los service-linked roles.

### 6.5 Probar la ingesta SIN código (vale hacerlo ya)

**IoT Core → MQTT test client**:

1. Pestaña **Publish to a topic** → topic `snowball/SB-001/telemetry` → payload:

```json
{"unit_id":"SB-001","ts":"2026-08-30T12:00:00.000Z","temp_c":-17.5,"humidity_pct":60,"lat":-34.6,"lon":-58.4,"battery":90,"signal":4}
```

2. **DynamoDB → Explore items → snowball-telemetry**: debe aparecer el ítem
   **con un `expires_at`** que el payload no traía. En
   **snowball-unit-state** debe quedar una única fila `SB-001` con la misma
   lectura; publicar otra vez con otro `ts` deja dos ítems históricos y uno solo
   (el nuevo) en estado actual.
3. **SQS → snowball-readings → Send and receive messages → Poll for messages**:
   debe aparecer el mensaje (después de mirarlo, no borrarlo o borralo, da igual:
   es de prueba).

Si esos dos puntos funcionan, **la premisa central de la variante B revisada
está validada** (sección 17 del documento de arquitectura).

---

## 7. S3 — los tres buckets

S3 cumple tres funciones en este diseño y solo la primera tiene que ver con el
frontend. Conviene crearlos ahora porque el *user data* del launch template
(sección 13) descarga los artefactos de despliegue desde acá.

Los nombres de bucket son globales: agregar un sufijo propio del grupo.

### 7.1 `snowball-dashboard-<sufijo>` — sitio estático

**S3 → Create bucket**, región us-east-1:

1. **Desmarcar «Block all public access»** y confirmar.
2. **Properties → Static website hosting → Enable**, index document `index.html`.
3. **Permissions → Bucket policy**:

```json
{
  "Version": "2012-10-17",
  "Statement": [{
    "Effect": "Allow",
    "Principal": "*",
    "Action": "s3:GetObject",
    "Resource": "arn:aws:s3:::snowball-dashboard-<sufijo>/*"
  }]
}
```

El contenido lo sube la sección 14, después de que exista el ALB (la URL de la
API queda horneada en el build).

### 7.2 `snowball-artifacts-<sufijo>` — artefactos de despliegue

**Create bucket** con **todos los accesos públicos bloqueados** (el default).
De acá bajan los bundles las instancias del ASG, usando el `LabInstanceProfile`.
Activar **Bucket Versioning** para poder volver a un bundle anterior.

### 7.3 `snowball-archive-<sufijo>` — archivo histórico y respaldos

**Create bucket**, público bloqueado, versionado activado. Dos usos:

- **Archivo histórico.** DynamoDB expira la telemetría a los 30 días por TTL.
  Antes de eso, una exportación programada deja el histórico acá, comprimido y
  particionado por unidad y fecha. Esto no es optimización de costo: SENASA y
  ANMAT exigen poder reconstruir la traza térmica de un lote mucho después de
  entregado, y guardar años de telemetría en la base caliente sería absurdo.
- **Respaldos.** Volcados lógicos de RDS.

Agregarle una regla de ciclo de vida: **Management → Create lifecycle rule** →
nombre `telemetry-to-glacier` → prefijo `telemetry/` → *Transition current
versions* → **Glacier Flexible Retrieval a los 30 días**.

---

## 8. Bastión

Hace falta un camino de entrada a las subredes privadas, y no lo puede dar el NAT
Gateway. El NAT es deliberadamente **unidireccional**: traduce la dirección de
origen de los paquetes que salen y mantiene una tabla de traducción para devolver
las respuestas; un paquete que llega desde Internet sin corresponder a una
conexión iniciada adentro no tiene entrada en esa tabla, así que se descarta. Esa
asimetría es su valor de seguridad, y es también la razón por la que jamás se
podría abrir una sesión SSH «a través» del NAT.

| | NAT Gateway | Bastión |
|---|---|---|
| Sentido | salida (*egress*) | entrada (*ingress*) |
| Quién inicia | la instancia privada, hacia afuera | el operador, desde afuera |
| Para qué | actualizaciones del SO, consumo de SQS, publicación en SNS, Device Shadow, cualquier API de AWS sin gateway endpoint | abrir SSH contra instancias sin IP pública: diagnosticar, desplegar, aplicar el esquema de RDS |

**EC2 → Launch instance**:

1. Name: `snowball-bastion` · Amazon Linux 2023 · **t3.micro** · key pair **vockey**.
2. Network: `snowball-vpc` → Subnet **`snowball-public-a`** → **Auto-assign public IP: Enable**.
3. Security group: elegir el existente **`sg-bastion`**.
4. Launch.

Endurecerlo, porque es el único host expuesto:

- `sg-bastion` con origen restringido a la **IP fija del equipo**, nunca `0.0.0.0/0`.
- Sin datos ni credenciales almacenados.
- **Apagado cuando no se usa.**

> **En producción esto iría con SSM Session Manager**, y conviene decirlo en la
> defensa. Session Manager abre una sesión interactiva sin puerto 22 abierto, sin
> par de claves y sin ningún host expuesto: el agente que corre en la instancia
> inicia la conexión saliente hacia el servicio. Es estrictamente más seguro, y
> el `LabInstanceProfile` suele traer los permisos. El bastión se conserva porque
> hace legible la topología de tres capas y porque la prueba de aislamiento más
> fuerte de la demo —intentar alcanzar RDS *desde el bastión* y fallar— necesita
> una máquina dentro de la VPC, en subred pública, que no sea de aplicación.

**Los sensores no pasan por el bastión, ni lo conocen, ni tocan la VPC.** Se
conectan al endpoint de IoT Core con TLS mutuo presentando su certificado X.509.
Ese es un camino de datos, automático y permanente, que ocurre por completo fuera
de la red propia. El bastión es un camino de administración, humano y ocasional.

---

## 9. RDS — PostgreSQL del dominio, privada y Multi-AZ

Acá vive el dominio del negocio: `clients`, `units`, `routes`, `users`,
`device_config` (setpoint deseado y aplicado, umbrales, minutos de tolerancia) y
`alerts` con su ciclo de vida y reconocimiento. Volumen chico y estable, pero con
relaciones reales y necesidad de transacciones — lo contrario de la telemetría,
que va a DynamoDB.

### 9.1 DB subnet group

**RDS → Subnet groups → Create DB subnet group**:

1. Name: `snowball-db-subnets` · Description: cualquiera · VPC: `snowball-vpc`
2. Availability Zones: **`us-east-1a` y `us-east-1b`**
3. Subnets: **`snowball-data-a` y `snowball-data-b`** (y ninguna otra) → Create.

### 9.2 La instancia

**RDS → Create database**:

1. **Standard create** → Engine: **PostgreSQL** (15.x).
2. Templates: **Dev/Test** · **Availability and durability: Multi-AZ DB instance**.
3. DB instance identifier: `snowball-db` · Master username: `snowball` ·
   contraseña: elegir una y guardarla en el gestor del grupo.
4. Instance: **db.t3.micro** · Storage: **20 GB gp3**.
5. **Connectivity**:
   - VPC: `snowball-vpc`
   - DB subnet group: `snowball-db-subnets`
   - **Public access: No** ← imprescindible
   - VPC security group: elegir el existente **`sg-db`**
6. Additional configuration → Initial database name: `snowball` →
   **desmarcar Enhanced monitoring** (el lab no lo permite).
7. Create database y esperar ~10 min (Multi-AZ tarda más que single-AZ).

**Tres barreras independientes sobre el mismo objetivo**, y conviene poder
enumerarlas: el **ruteo** (`rt-data` no tiene ruta por defecto), el **security
group** (`sg-db` acepta a `sg-app` y a nadie más) y el **atributo de la
instancia** (`publicly accessible = no`, así ni recibe un nombre DNS que resuelva
a una dirección pública).

> **Qué resuelve Multi-AZ y qué no.** Mantiene un standby con replicación
> síncrona en la otra zona. **No sirve para escalar lecturas** —el standby no es
> consultable, a diferencia de una réplica de lectura— sino para conmutar de
> forma automática si cae la zona primaria, redirigiendo el mismo nombre DNS al
> nodo sobreviviente, con una interrupción del orden de uno a dos minutos. Es lo
> que sostiene el objetivo de 99,9 % de disponibilidad, y de paso justifica por
> qué las subredes de datos son dos.

### 9.3 Aplicar el esquema y los datos de demo

La base ya no es alcanzable desde tu máquina: hay que pasar por el bastión. Abrir
un túnel SSH y correr `psql` contra `localhost`, así las credenciales no quedan
en el bastión:

```bash
# terminal 1 — túnel a una instancia de app, pasando por el bastión
# (hacerlo después de crear el ASG; usar la IP privada de una instancia sana)
ssh -i labsuser.pem -J ec2-user@<IP-BASTION> \
   -L 5432:<ENDPOINT-RDS>:5432 ec2-user@<IP-PRIVADA-INSTANCIA-APP>

# terminal 2 — el mismo comando de siempre, contra el túnel
psql "host=localhost dbname=snowball user=snowball sslmode=require" \
  -f infra/sql/schema.sql -f infra/sql/seed.sql
```

### 9.4 Autenticación de personas

La API no tiene registro público. Las cuentas iniciales se crean con
`infra/sql/seed.sql`; después un administrador puede crear usuarios desde el
ABM protegido de `/api/users`. Las credenciales demo son:

| Rol | Email | Contraseña |
|---|---|---|
| operador | `operator@snowball.example` | `operator123` |
| supervisor | `supervisor@snowball.example` | `supervisor123` |
| admin | `admin@snowball.example` | `admin123` |

Cambiar estas contraseñas antes de una entrega real. Para el API, generar una
clave de firma propia y guardarla solo en el entorno del servidor:

```bash
openssl rand -base64 32
```

La variable `JWT_SECRET` debe estar presente en cada instancia de la API y ser
la misma en todas ellas. No se guarda en Git, S3 público, el dashboard ni el
navegador. El JWT que recibe el navegador expira a las 8 horas; la clave no.

Probar el flujo desde el endpoint del ALB:

```bash
curl -i -X POST http://<DNS-DEL-ALB>/auth/login \
   -H 'Content-Type: application/json' \
   -d '{"email":"admin@snowball.example","password":"admin123"}'

curl -i http://<DNS-DEL-ALB>/auth/me \
   -H 'Authorization: Bearer <JWT>'
```

Sin token la API responde `401`; un rol insuficiente responde `403`, y una
unidad fuera del tenant responde `404` para no revelar su existencia.

Usuarios demo que crea el seed (cambiar las contraseñas fuera de la demo):

| Email | Contraseña | Rol | Cliente |
|---|---|---|---|
| operator@snowball.example | operator123 | operator | 1 |
| supervisor@snowball.example | supervisor123 | supervisor | 1 |
| admin@snowball.example | admin123 | admin | — (ve todo) |

Nuevo hash: `npx tsx scripts/hash-password.ts <contraseña>`. Si la base ya
existía de antes, el bloque final de `schema.sql` agrega la columna
`users.active` y la restricción admin ⇔ sin cliente; es idempotente.

---

## 10. Simulador — módulo local (tu máquina)

El simulador **no se despliega**: es un módulo que corre localmente y genera
la telemetría de los sensores. Se autentica ante IoT Core igual que un sensor
real — **solo con su certificado X.509**, sin credenciales AWS ni rol IAM —
así que puede correr desde cualquier red con salida al puerto 8883.

En tu máquina, con los certificados del paso 6.3 en `certs/` (gitignoreado):

```bash
npm install && npm run build

npm run simulator -- --endpoint <ENDPOINT-IOT> --units SB-001,SB-002,SB-003 \
  --interval 5 --excursion SB-001@60
```

`--excursion SB-001@60` = a los 60 s la unidad empieza a calentarse hasta salir
de rango. `--silence SB-002@120` = a los 2 min deja de reportar (para la
alarma «sin señal» de CloudWatch, fase siguiente).

> Si en la defensa quieren mostrar el «dispositivo» viviendo fuera de la
> notebook, el mismo módulo corre sin cambios en una EC2 pública **sin rol
> IAM** (la autenticación es solo por certificado); pero el flujo por defecto
> es local.

---

## 11. Empaquetado de los artefactos desplegables

Los dos módulos que sí van a EC2 (procesador de alertas y API) se empaquetan
con esbuild en **un único archivo `.js` autocontenido** — dependencias
incluidas, `@snowball/shared` adentro. En la instancia no hace falta ni git
ni `npm install`: solo Node y el archivo.

En tu máquina:

```bash
npm run bundle
# genera:
#   packages/alert-processor/dist/alert-processor.bundle.js
#   packages/api/dist/api.bundle.js
#   packages/telemetry-export/dist/telemetry-export.zip
```

Subir los bundles al bucket de artefactos: de ahí los baja el *user data* de
cada instancia que levante el Auto Scaling Group.

```bash
aws s3 cp packages/alert-processor/dist/alert-processor.bundle.js \
  s3://snowball-artifacts-<sufijo>/
aws s3 cp packages/api/dist/api.bundle.js \
  s3://snowball-artifacts-<sufijo>/
```

La Lambda se empaqueta aparte porque AWS Lambda recibe un `.zip`:

```bash
npm run bundle
```

El archivo queda en `packages/telemetry-export/dist/telemetry-export.zip`.

---

## 12. ALB y target group

El balanceador es la única puerta de entrada al cómputo. Va antes del ASG porque
el grupo se registra contra su *target group*.

### 12.1 Target group

**EC2 → Target Groups → Create target group**:

1. Target type: **Instances** · Name: `snowball-app-tg`
2. Protocol **HTTP**, port **3000** · VPC: `snowball-vpc`
3. Health checks: **HTTP**, path **`/health`** (la API ya responde
   `{"ok":true}` ahí) → Next → **Create** sin registrar objetivos: los agrega
   el ASG.

### 12.2 El balanceador

**EC2 → Load Balancers → Create load balancer → Application Load Balancer**:

1. Name: `snowball-alb` · Scheme: **Internet-facing** · IP type: IPv4
2. VPC: `snowball-vpc` · Mappings: marcar **`us-east-1a` → `snowball-public-a`**
   y **`us-east-1b` → `snowball-public-b`**
3. Security group: **`sg-alb`** (quitar el default)
4. Listener: **HTTP : 80** → forward to **`snowball-app-tg`** → Create.

> **El ALB no es una caja única.** Crea un nodo con su propia ENI en cada subred
> que se le asigna en el *subnet mapping*, y AWS exige mínimo dos subredes en dos
> zonas distintas. **Por eso `snowball-public-b` existe aunque no hospede
> cómputo.**

Copiar el **DNS name** del balanceador: es la URL de la API
(`http://<dns-del-alb>`) y la que se hornea en el build del dashboard.

Como el JavaScript del dashboard corre en el navegador del usuario y llama a la
API desde otro origen, **la API tiene que devolver los encabezados CORS** del
dominio del bucket.

---

## 13. Launch template y Auto Scaling Group

Las dos cargas que quedan en cómputo propio son procesos de larga vida y con
estado, y por eso son EC2 y no Lambda: la **API con WebSockets** mantiene la
conexión abierta mientras el usuario mira el dashboard, y el **procesador de
alertas** es un consumidor de SQS en bucle permanente. Cada instancia corre las
dos como servicios del sistema.

**Un ASG no puede convivir con un despliegue manual por `scp`**: cuando el grupo
reemplaza una instancia, la nueva tiene que levantar sirviendo, sin que nadie se
conecte a configurarla. De ahí el launch template con *user data*.

### 13.1 Launch template

**EC2 → Launch Templates → Create launch template**:

1. Name: `snowball-app-lt`
2. AMI: **Amazon Linux 2023** · Instance type: **t3.small**
3. Key pair: **vockey** (para poder entrar por el bastión a diagnosticar)
4. Network settings: **no elegir subred acá** (la define el ASG) ·
   Security group: **`sg-app`**
5. Storage: **20 GB gp3**
6. **Advanced details → IAM instance profile: `LabInstanceProfile`** ←
   imprescindible: de acá salen los permisos para SQS, SNS, DynamoDB y S3.
7. Antes de pegar el *user data*, reemplazar **todos** los valores entre
    `<...>` por los valores reales de esta instalación. El bloque siguiente es
    una plantilla: **no pegarlo sin editar**.
    - `<sufijo>`: sufijo exacto de `snowball-artifacts-<sufijo>`.
    - `<URL-SQS>`: URL completa de `snowball-readings` (sección 4).
    - `<ARN-SNS>`: ARN completo de `snowball-thermal-excursion` (sección 5).
    - `<ENDPOINT-RDS>`: endpoint DNS de `snowball-db`, sin `https://` ni puerto
       (sección 9.2).
    - `<PASSWORD-RDS>`: contraseña del usuario master `snowball`.
    - `<JWT-SECRET>`: clave aleatoria generada para esta instalación, por
       ejemplo con `openssl rand -base64 32` (sección 9.4).
8. **Advanced details → User data**: pegar el bloque ya editado:

```bash
#!/bin/bash
set -euxo pipefail
dnf install -y nodejs

BUCKET=snowball-artifacts-<sufijo> # reemplazar <sufijo>
install -d /opt/snowball
aws s3 cp "s3://$BUCKET/api.bundle.js"             /opt/snowball/
aws s3 cp "s3://$BUCKET/alert-processor.bundle.js" /opt/snowball/

cat >/etc/snowball.env <<'ENV'
AWS_REGION=us-east-1
SQS_QUEUE_URL=<URL-SQS>
SNS_THERMAL_EXCURSION_TOPIC_ARN=<ARN-SNS>
PGHOST=<ENDPOINT-RDS>
PGDATABASE=snowball
PGUSER=snowball
PGPASSWORD=<PASSWORD-RDS>
JWT_SECRET=<JWT-SECRET>
PORT=3000
ENV
chmod 600 /etc/snowball.env

for svc in api alert-processor; do
  case "$svc" in
    api)             bundle=api.bundle.js ;;
    alert-processor) bundle=alert-processor.bundle.js ;;
  esac
  cat >"/etc/systemd/system/snowball-$svc.service" <<UNIT
[Unit]
Description=Snowball $svc
After=network-online.target
Wants=network-online.target

[Service]
EnvironmentFile=/etc/snowball.env
ExecStart=/usr/bin/node /opt/snowball/$bundle
Restart=always
RestartSec=5
User=ec2-user

[Install]
WantedBy=multi-user.target
UNIT
done

systemctl daemon-reload
systemctl enable --now snowball-api snowball-alert-processor
```

No dejar los marcadores `<sufijo>`, `<URL-SQS>`, `<ARN-SNS>`,
`<ENDPOINT-RDS>`, `<PASSWORD-RDS>` ni `<JWT-SECRET>` en el bloque final. La
contraseña de RDS y el JWT quedan en `/etc/snowball.env` de cada instancia; no
se deben commitear ni subir al bucket de artefactos.

`Restart=always` es lo que reemplaza al `tmux` de la fase anterior: si un proceso
muere, systemd lo levanta, y si la instancia muere, la levanta el ASG.

### 13.2 Auto Scaling Group

**EC2 → Auto Scaling Groups → Create Auto Scaling group**:

1. Name: `snowball-app-asg` · Launch template: `snowball-app-lt`
2. VPC: `snowball-vpc` · Subnets: **`snowball-app-a` y `snowball-app-b`**
3. **Attach to an existing load balancer** → target group `snowball-app-tg`
4. **Health checks: activar «Turn on Elastic Load Balancing health checks»**
5. Group size: **Desired 2 · Minimum 2 · Maximum 4**
6. Create.

Dos instancias como piso, una por zona. Son de tipo *burstable*: acumulan
créditos de CPU mientras el tráfico es plano y los gastan durante la ráfaga, que
es el perfil exacto de esta carga. `t3.small` en lugar de `t3.micro` porque el
gigabyte extra de memoria evita que la API y el procesador compitan por RAM.

### 13.3 Por qué esto es legítimo

El almacenamiento de bloque se reduce al volumen raíz **EBS gp3 de 20 GB** de
cada instancia, con el sistema y la aplicación. Las instancias son
**deliberadamente descartables**: todo estado durable vive en RDS, DynamoDB, S3 o
en la propia cola SQS. El estado de excursión en curso está en DynamoDB y los
umbrales en RDS, así que matar una instancia y levantar otra no pierde nada. Eso
es lo que vuelve legítimo el escalado automático.

**No hay EFS.** Su única razón de existir en la versión previa era el material que
ambos brokers Mosquitto debían compartir —la CA, los certificados emitidos y las
ACL de tópicos—, porque un dispositivo podía aterrizar en cualquiera de los dos.
IoT Core absorbe exactamente ese problema: el registro de dispositivos, la
emisión de certificados y las políticas de tópicos son estado del servicio
gestionado, no archivos en un filesystem.

### 13.4 Redesplegar y diagnosticar

**Redesplegar** significa actualizar los artefactos y reemplazar gradualmente
las instancias del ASG. No hay `scp` a una IP pública: las instancias no tienen
una.

1. En tu máquina, generar los artefactos nuevos:

   ```bash
   npm run bundle
   ```

2. Subir al bucket `snowball-artifacts-<sufijo>` **los dos archivos que descarga
   el *user data***:

   ```bash
   aws s3 cp packages/api/dist/api.bundle.js \
     s3://snowball-artifacts-<sufijo>/api.bundle.js
   aws s3 cp packages/alert-processor/dist/alert-processor.bundle.js \
     s3://snowball-artifacts-<sufijo>/alert-processor.bundle.js
   ```

   Reemplazar `<sufijo>` por el sufijo real del bucket. Si se cambió el *user
   data* o la AMI, crear una **nueva versión** del launch template antes del
   refresh; para un cambio normal de los bundles, el mismo launch template los
   descargará al arrancar cada instancia nueva.

3. Abrir **EC2 → Auto Scaling Groups → `snowball-app-asg` → Instance refresh**.
4. Elegir **Start instance refresh**, revisar la configuración y confirmar.
   El ASG terminará y recreará las instancias gradualmente según la política
   de reemplazo, manteniendo capacidad disponible.
5. Esperar a que el target group muestre nuevamente dos objetivos **healthy**.
   Recién entonces validar `/health`, el login y el dashboard.

**Diagnosticar**, pasando por el bastión:

```bash
ssh -i labsuser.pem -J ec2-user@<IP-BASTION> ec2-user@<IP-PRIVADA-INSTANCIA>
sudo journalctl -u snowball-api -f
sudo journalctl -u snowball-alert-processor -f
```

Probar la API a través del balanceador:

```bash
curl http://<DNS-DEL-ALB>/health      # {"ok":true}
curl http://<DNS-DEL-ALB>/api/units
```

### 13.5 Lambda diaria de archivo

Esta función no corre en el ASG ni necesita una EC2 propia. Lee DynamoDB y
escribe S3 usando su **execution role**. El rol debe permitir como mínimo:

- `dynamodb:Scan` sobre `snowball-unit-state`
- `dynamodb:Query` sobre `snowball-telemetry`
- `s3:PutObject` sobre `arn:aws:s3:::snowball-archive-<sufijo>/telemetry/*`
- escribir logs en CloudWatch Logs

En AWS Academy, usar **LabRole** si aparece como rol seleccionable y ya tiene
esos permisos. Si no aparece o no tiene acceso a esos recursos, revisar la
política del rol antes de continuar: la función puede crearse, pero fallará al
leer DynamoDB o escribir S3.

#### 13.5.1 Crear y configurar la función

1. Abrir **AWS Console → Services → Lambda → Functions**.
2. Elegir **Create function**.
3. En **Author from scratch**, completar:
   - **Function name:** `snowball-telemetry-export`
   - **Runtime:** `Node.js 22.x` (Node 20 está deprecado en AWS Lambda)
   - **Architecture:** `x86_64`
4. En **Permissions → Change default execution role**, elegir **Use an
   existing role** y seleccionar `LabRole`. No crear otro rol si el lab no lo
   permite.
5. Elegir **Create function**.
6. Dentro de la función, abrir la pestaña **Code**.
7. En el panel **Code source**, elegir **Upload from → .zip file**.
8. Seleccionar el archivo local
   `packages/telemetry-export/dist/telemetry-export.zip`, elegir **Save** y
   esperar a que termine la actualización.
9. En **Runtime settings → Edit**, verificar:
   - **Handler:** `index.handler`
   - **Runtime:** `Node.js 22.x`
10. Ir a **Configuration → General configuration → Edit** y establecer:
    - **Memory:** `512 MB`
    - **Timeout:** `5 min`
    - Guardar con **Save**.
11. Ir a **Configuration → Environment variables → Edit → Add environment
    variable** y agregar:
    - **Key:** `ARCHIVE_BUCKET`
    - **Value:** `snowball-archive-<sufijo>`
    - Opcionales: `DDB_TABLE` y `DDB_STATE_TABLE`, solo si se usan nombres
      distintos de `snowball-telemetry` y `snowball-unit-state`.
    - Elegir **Save**.

No subir `JWT_SECRET`, `PGPASSWORD` ni otras credenciales a esta Lambda: no las
necesita. Lambda cifra sus variables de entorno en reposo, pero el bucket de
archivo debe seguir privado.

#### 13.5.2 Probar la función manualmente

1. En la página de la función, abrir la pestaña **Test**.
2. Elegir **Create new event** o **Create event**.
3. Event name: `export-yesterday-test`.
4. Usar este JSON para exportar una fecha concreta:

```json
{"date":"2026-09-06"}
```

5. Elegir **Save** y después **Test**.
6. La respuesta debe contener `"failed":[]`.
7. Ir a **S3 → snowball-archive-<sufijo> → telemetry/aaaa/mm/dd/** y
   verificar que exista un `.ndjson.gz` por unidad que haya reportado ese día.
8. Si falla, abrir **Monitor → View CloudWatch logs** en Lambda y revisar el
   log group `/aws/lambda/snowball-telemetry-export`.

#### 13.5.3 Crear el schedule diario

Esto se crea en **EventBridge Scheduler**, no en **EventBridge → Rules**.

1. Abrir **AWS Console → Services → EventBridge → Scheduler → Schedules**.
   También se puede abrir directamente **EventBridge Scheduler → Schedules**
   desde el buscador de servicios.
2. Elegir **Create schedule**.
3. En **Specify schedule detail** completar:
   - **Schedule name:** `snowball-telemetry-export`
   - **Schedule group:** `default`
   - **Occurrence:** `Recurring schedule`
   - **Schedule type:** `Cron-based schedule`
   - **Cron expression:** `cron(15 0 * * ? *)`
   - **Timezone:** `UTC`
   - **Flexible time window:** **Off**
4. Elegir **Next**.
5. En **Select target**:
   - Seleccionar **AWS Lambda → Invoke** como target templated.
   - Elegir la función `snowball-telemetry-export`.
   - Para la primera configuración, usar como input:

```json
{}
```

   La función interpreta un evento sin `date` como “el día anterior en UTC”.
   El backfill con `{"date":"YYYY-MM-DD"}` se hace desde el botón Test de
   Lambda o desde el CLI local, no desde el schedule diario.
6. Elegir **Next**.
7. En **Settings**:
   - **Enable schedule:** activado.
   - **Action after schedule completion:** `NONE`.
   - Configurar retry si se desea; el `ExportError` de la función hace que una
     ejecución fallida se reporte como fallo al scheduler.
8. En **Permissions**, seleccionar **Use existing role** solo si existe un rol
   cuyo trust policy permita `scheduler.amazonaws.com` y cuya policy permita
   `lambda:InvokeFunction` sobre `snowball-telemetry-export`. Si el laboratorio
   permite que la consola cree el rol, elegir **Create new role for this
   schedule** y aceptar el rol generado.
9. Elegir **Next**, revisar el resumen y elegir **Create schedule**.
10. Volver a **EventBridge → Scheduler → Schedules**, abrir
    `snowball-telemetry-export` y verificar que el estado sea **Enabled**.

El schedule invocará la Lambda todos los días a las 00:15 UTC. No crear una
regla equivalente en **EventBridge → Rules**, porque sería un segundo
disparador duplicado y no es el recurso que usa este diseño.

---

## 14. Dashboard — build y publicación

El bucket ya existe (sección 7.1). Ahora que hay un ALB, se puede hornear su DNS
en el build:

```bash
VITE_API_BASE=http://<DNS-DEL-ALB> npm run build -w @snowball/dashboard
aws s3 sync packages/dashboard/dist/ s3://snowball-dashboard-<sufijo>/ --delete
```

Abrir la **website endpoint** del bucket (Properties → Static website hosting).
A diferencia de la fase anterior, el DNS del ALB **no cambia** cuando se
reemplazan las instancias, así que no hay que recompilar por eso.

> **«Estático» califica a los archivos, no a lo que ve el usuario.** S3 entrega
> siempre el mismo `index.html`, el mismo bundle y el mismo CSS, byte por byte,
> sin ejecutar nada del lado del servidor. Después ese JavaScript corre en el
> navegador del usuario, y es él quien consulta la API por HTTP a través del ALB
> y abre el WebSocket que recibe las lecturas en tiempo real. El hosting es
> estático; la aplicación es dinámica. Sin CloudFront en el Learner Lab, el
> endpoint del sitio es HTTP — coherente con el listener del ALB.

---

## 15. Checklist de verificación end-to-end

**Red y aislamiento**

- [ ] Las seis subredes existen con sus CIDR y zonas correctas
- [ ] `rt-data` tiene **una sola** entrada (`10.0.0.0/16 → local`)
- [ ] Las instancias del ASG **no tienen IP pública**
- [ ] RDS muestra `Publicly accessible: No`
- [ ] `psql` directo al endpoint de RDS desde tu máquina: **falla** (no hay ruta de retorno)
- [ ] `nc -zv <endpoint-rds> 5432` **desde el bastión**: **falla también** — es la
      prueba más elocuente, porque muestra que la segmentación es por rol y no
      «adentro contra afuera»: `sg-db` acepta a `sg-app` y a nadie más, ni
      siquiera a otra máquina de la propia VPC
- [ ] `nc -zv <endpoint-rds> 5432` desde una instancia de `sg-app`: **conecta**

**Ingesta**

- [ ] MQTT test client muestra mensajes llegando a `snowball/+/telemetry`
- [ ] DynamoDB acumula ítems nuevos por unidad (Explore items, ordenados por `ts`)
- [ ] `snowball-unit-state` tiene exactamente una fila por unidad activa, con el `ts` más reciente
- [ ] Recién creada la tabla de estado, `GET /api/units` devuelve `last_reading: null` hasta que llega la próxima lectura
- [ ] La cola `snowball-readings` drena (mensajes *in flight* mientras el procesador corre)
- [ ] `snowball-readings-dlq` sigue vacía (si tiene mensajes, mirar qué payload rompió el parseo)

**Alertas**

- [ ] `journalctl -u snowball-alert-processor` loguea `ok -> deviated` al minuto
      de la excursión y `-> alerted` al superar la tolerancia
- [ ] Llega **un solo mail** por excursión al correo suscripto
- [ ] La alerta queda en RDS: `SELECT * FROM alerts ORDER BY emitted_at DESC;`

**Cómputo y publicación**

- [ ] El target group `snowball-app-tg` muestra **dos objetivos `healthy`**, uno por zona
- [ ] `curl http://<DNS-DEL-ALB>/api/units` devuelve las unidades con su última lectura
- [ ] El dashboard (website endpoint de S3) muestra las tarjetas actualizándose
      en vivo y la alerta en la tabla
- [ ] La Lambda deja un `.ndjson.gz` por unidad con lecturas en `telemetry/aaaa/mm/dd/`
- [ ] El bucket tiene la regla `telemetry-to-glacier`
- [ ] Login, `/auth/me`, roles y aislamiento por tenant funcionan a través del ALB
- [ ] Terminar una instancia a mano: el ASG levanta otra y vuelve a `healthy`
      sin intervención

---

## 16. Al terminar cada sesión (presupuesto)

Lo que factura por hora, en orden de costo:

1. **NAT Gateway** (~USD 32/mes si queda encendido). **Borrarlo** al terminar y
   recrearlo al empezar: son dos minutos y es el ahorro más grande. Al recrearlo
   hay que volver a apuntar las rutas `0.0.0.0/0` de `rt-app-a` y `rt-app-b`.
2. **RDS Multi-AZ** — **detenerla** (no borrarla). *Ojo:* AWS re-enciende una RDS
   detenida a los 7 días; si nadie la va a usar en la semana, sacarle un
   snapshot y borrarla.
3. **ALB** (~USD 16/mes). Borrarlo también si la pausa es larga; recrearlo es
   rápido, pero cambia su DNS name y hay que **recompilar el dashboard**.
4. **Las EC2 del ASG** — poner el ASG en **Desired 0 / Minimum 0**. Es más
   prolijo que terminar instancias a mano, que el grupo repondría.
5. **El bastión** — detenerlo.

DynamoDB / SQS / SNS / IoT Core / S3 / Lambda / EventBridge quedan como están: centavos o nada en
reposo. La VPC, las subredes, las tablas de ruteo, los security groups y los
gateway endpoints **no cuestan nada**: no hace falta borrarlos nunca.

Cerrar la sesión del lab con **End Lab** — y revisar el budget en la pantalla del
curso.
