# Snowball — Guía de infraestructura por consola AWS (ingesta + alertas + API + dashboard)

Guía paso a paso para crear **a mano, desde la consola**, todos los recursos que
el código de este repo necesita. No usamos IaC en esta entrega: cualquier
integrante puede reconstruir el entorno siguiendo este documento (por ejemplo,
después de un *Reset* del Learner Lab).

> **Los nombres importan.** El código lee estos nombres desde
> `packages/shared/src/config.ts`. Si cambiás un nombre acá, cambialo allá.

| Recurso | Nombre |
|---|---|
| Tabla DynamoDB | `snowball-telemetry` |
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
3. Recordatorios de presupuesto: lo único de esta guía que factura por hora es
   **RDS y las EC2** (y el NAT/ALB cuando llegue la fase de VPC). DynamoDB, SQS,
   SNS e IoT Core a escala de demo cuestan centavos y no hace falta borrarlos.
4. En este laboratorio no se pueden crear roles IAM: donde un servicio pida un
   rol, usar siempre **LabRole** (y en EC2, el instance profile **LabInstanceProfile**).

---

## 1. DynamoDB — tabla de telemetría

Consola → **DynamoDB → Tables → Create table**:

1. Table name: `snowball-telemetry`
2. Partition key: `unit_id` — tipo **String**
3. Sort key: `ts` — tipo **String**
4. Table settings → **Customize settings** → Capacity mode: **On-demand**
5. Create table.

Después, con la tabla creada → pestaña **Additional settings** →
**Time to Live (TTL)** → *Turn on* → TTL attribute: `expires_at`.
(El simulador manda `expires_at` = epoch en segundos a 30 días; DynamoDB borra solo.)

---

## 2. SQS — cola de lecturas + DLQ

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

## 3. SNS — tópicos de alertas

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

## 4. IoT Core — dispositivos, certificados y regla

### 4.1 Endpoint

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

### 4.2 Política de dispositivos (una sola para todos)

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

### 4.3 Things + certificados (repetir por unidad: SB-001, SB-002, SB-003)

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

### 4.3 bis. Alta de unidades por script (alternativa a los clicks)

Desde **CloudShell** (o local con las credenciales de la sesión Academy):

```bash
git clone <repo> && cd tp-cloud
scripts/provision-unit.sh SB-004
```

Crea el thing, el certificado (queda en `certs/SB-004/`), le adjunta
`snowball-device-policy` y lo asocia al thing; al final imprime el `INSERT`
para RDS. Probarlo una vez de punta a punta antes de la demo: usa las
credenciales de la sesión (las mismas que la consola), no LabRole.

Si falla después de crear el certificado, el script imprime los comandos de
limpieza: hay que dar de baja el certificado huérfano en AWS **y** borrar la
carpeta local `certs/<UNIT>/` antes de reintentar.

### 4.4 La regla de ingesta (el corazón de esta revisión)

**IoT Core → Message routing → Rules → Create rule**:

1. Name: `snowball_telemetry`.
2. SQL statement (versión 2016-03-23):

```sql
SELECT *, topic(2) AS unit_id FROM 'snowball/+/telemetry'
```

3. **Action 1 — DynamoDBv2**: *Insert a message into a DynamoDB table* →
   Table: `snowball-telemetry` → IAM role: **LabRole**.
4. **Add action** → **Action 2 — SQS**: Queue: `snowball-readings` →
   *Use the message as-is* (sin base64) → IAM role: **LabRole**.
5. **Error action** (abajo): *Send message data to CloudWatch logs* →
   Log group: crear `snowball-iot-errors` → IAM role: **LabRole**.
6. Create rule.

> Si al elegir LabRole la consola se queja de permisos, reintentar una vez —
> pasa lo mismo que documenta el propio lab con los service-linked roles.

### 4.5 Probar la ingesta SIN código (vale hacerlo ya)

**IoT Core → MQTT test client**:

1. Pestaña **Publish to a topic** → topic `snowball/SB-001/telemetry` → payload:

```json
{"unit_id":"SB-001","ts":"2026-08-30T12:00:00.000Z","temp_c":-17.5,"humidity_pct":60,"lat":-34.6,"lon":-58.4,"battery":90,"signal":4,"expires_at":1790000000}
```

2. **DynamoDB → Explore items → snowball-telemetry**: debe aparecer el ítem.
3. **SQS → snowball-readings → Send and receive messages → Poll for messages**:
   debe aparecer el mensaje (después de mirarlo, no borrarlo o borralo, da igual:
   es de prueba).

Si esos dos puntos funcionan, **la premisa central de la variante B revisada
está validada** (sección 17 del documento de arquitectura).

---

## 5. RDS — PostgreSQL del dominio

> Fase actual (sin la VPC del diseño todavía): lo creamos en la **default VPC**,
> accesible solo desde tu IP. En la fase de red se recrea privado en las
> subredes de datos, como manda el PDF (§7 y §13).

**RDS → Create database**:

1. **Standard create** → Engine: **PostgreSQL** (15.x).
2. Templates: **Free tier / Dev-Test** → Instance: **db.t3.micro**.
3. DB instance identifier: `snowball-db` · Master username: `snowball` ·
   contraseña: elegir una y guardarla en el grupo.
4. Storage: 20 GB gp2/gp3. **Sin** Multi-AZ por ahora (se activa la semana de la demo).
5. Connectivity: default VPC → **Public access: Yes** (solo esta fase) →
   VPC security group: crear `snowball-db-dev` .
6. Additional configuration → Initial database name: `snowball` →
   **desmarcar Enhanced monitoring** (el lab no lo permite).
7. Create database y esperar ~10 min.

Después: **EC2 → Security Groups → snowball-db-dev → Edit inbound rules** →
dejar una sola regla: PostgreSQL (5432) — Source **My IP** (y agregar la IP de
cada integrante que lo use).

Aplicar esquema y datos de demo desde tu máquina (endpoint en la pestaña
*Connectivity* de la instancia):

```bash
psql "host=<ENDPOINT-RDS> dbname=snowball user=snowball sslmode=require" \
  -f infra/sql/schema.sql -f infra/sql/seed.sql
```

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

## 6. Simulador — módulo local (tu máquina)

El simulador **no se despliega**: es un módulo que corre localmente y genera
la telemetría de los sensores. Se autentica ante IoT Core igual que un sensor
real — **solo con su certificado X.509**, sin credenciales AWS ni rol IAM —
así que puede correr desde cualquier red con salida al puerto 8883.

En tu máquina, con los certificados del paso 4.3 en `certs/` (gitignoreado):

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

## 7. Empaquetado de los artefactos desplegables

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
```

---

## 8. EC2 procesador de alertas

**EC2 → Launch instance**:

1. Name: `snowball-app` · Amazon Linux 2023 · **t3.micro** (t3.small en la demo) · vockey.
2. Default VPC, SG nuevo `snowball-app`: SSH desde *My IP* + **TCP 3000 desde *My IP*** (para la API del paso 9).
3. **Advanced details → IAM instance profile: `LabInstanceProfile`** ← imprescindible:
   de acá salen los permisos para SQS, SNS y DynamoDB.
4. Agregar la IP privada (o el SG) de esta instancia al inbound del SG
   `snowball-db-dev` (puerto 5432) para que llegue a RDS.
5. Copiar el artefacto y correr:

```bash
# en tu máquina
scp -i labsuser.pem packages/alert-processor/dist/alert-processor.bundle.js \
  ec2-user@<IP-PUBLICA>:

# en la instancia
ssh -i labsuser.pem ec2-user@<IP-PUBLICA>
sudo dnf install -y nodejs

export AWS_REGION=us-east-1
export SQS_QUEUE_URL='<URL de snowball-readings (paso 2)>'
export SNS_THERMAL_EXCURSION_TOPIC_ARN='<ARN del tópico (paso 3)>'
export PGHOST='<ENDPOINT-RDS>' PGDATABASE=snowball PGUSER=snowball PGPASSWORD='<pass>'

node alert-processor.bundle.js
```

El proceso es **stateless**: el estado de excursión vive en DynamoDB y los
umbrales en RDS, así que matar la instancia y levantar otra no pierde nada.
Redesplegar = volver a hacer `scp` y reiniciar el proceso. (Cuando esto esté
estable lo convertimos en servicio systemd; por ahora una sesión de `tmux`
por proceso alcanza para la demo.)

---

## 9. EC2 API de lectura (REST + WebSocket)

La API corre **en la misma instancia** `snowball-app` como segundo proceso
(en la fase VPC completa irá detrás del ALB). No consume la cola — esa es
exclusiva del procesador —: lee DynamoDB y RDS, y el feed en vivo del
WebSocket lo resuelve consultando DynamoDB solo por las unidades que los
dashboards conectados están mirando.

```bash
# en tu máquina
scp -i labsuser.pem packages/api/dist/api.bundle.js ec2-user@<IP-PUBLICA>:

# en la instancia (otra sesión de tmux)
export AWS_REGION=us-east-1
export PGHOST='<ENDPOINT-RDS>' PGDATABASE=snowball PGUSER=snowball PGPASSWORD='<pass>'
export JWT_SECRET="$(head -c 48 /dev/urandom | base64)"   # ≥ 32 chars; el mismo en todas las instancias
export IOT_ENDPOINT='<xxxx-ats.iot.us-east-1.amazonaws.com>'   # el del simulador (§4.1)
export CORS_ORIGIN='http://<bucket>.s3-website-us-east-1.amazonaws.com'
# opcionales: PORT (3000), LIVE_POLL_MS (3000), DDB_TABLE

node api.bundle.js
```

Probar: `curl http://<IP-PUBLICA>:3000/health` → `{"ok":true}` y
`curl http://<IP-PUBLICA>:3000/api/units`.

Antes de confiar en la configuración remota, verificar que `LabInstanceProfile`
permite el data plane de IoT desde la instancia:

```bash
aws iot-data get-thing-shadow --thing-name SB-001 /dev/stdout
```

Si responde `AccessDenied`, `GET /api/units/:id/shadow` devuelve **500** (no
503: el 503 es solo cuando `IOT_ENDPOINT` no está seteado) y `PUT
/api/units/:id/config` con cambio de setpoint devuelve **200** con
`warning: "shadow update failed"` — la escritura en RDS se guarda igual, solo
falla el empuje al equipo (limitación del laboratorio); los umbrales se
siguen pudiendo editar porque solo tocan RDS.

Login de prueba:

```bash
curl -s -X POST http://<IP-PUBLICA>:3000/auth/login \
  -H 'Content-Type: application/json' \
  -d '{"email":"admin@snowball.example","password":"admin123"}'
# → {"token":"…","user":{…}}
curl -s http://<IP-PUBLICA>:3000/api/units -H "Authorization: Bearer <token>"
```

Nota de seguridad: en Academy tanto el sitio S3 como la API van por HTTP
plano, así que contraseña y token viajan sin cifrar. TLS (ALB + ACM o
CloudFront) queda para una fase posterior.

---

## 10. Dashboard estático en S3

**S3 → Create bucket**: nombre `snowball-dashboard-<sufijo>` (los nombres de
bucket son globales; agregar un sufijo propio), región us-east-1.

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

4. Compilar apuntando a la API y subir (el valor queda horneado en el build):

```bash
VITE_API_BASE=http://<IP-PUBLICA-EC2>:3000 npm run build -w @snowball/dashboard
aws s3 sync packages/dashboard/dist/ s3://snowball-dashboard-<sufijo>/ --delete
```

5. Abrir la **website endpoint** del bucket (Properties → Static website
   hosting). Cambió la IP de la EC2 → recompilar y volver a sincronizar.

> El dashboard es 100 % estático (HTML+JS+CSS): S3 solo sirve archivos; toda
> la data sale de la API. Sin CloudFront en el Learner Lab, el endpoint del
> sitio es HTTP — coherente con la API, también HTTP en esta fase.

---

## 11. Checklist de verificación end-to-end

- [ ] MQTT test client muestra mensajes llegando a `snowball/+/telemetry`
- [ ] DynamoDB acumula ítems nuevos por unidad (Explore items, ordenados por `ts`)
- [ ] La cola `snowball-readings` drena (mensajes *in flight* mientras el procesador corre)
- [ ] El procesador loguea `ok -> deviated` al minuto de la excursión y `-> alerted` al superar la tolerancia
- [ ] Llega **un solo mail** por excursión al correo suscripto
- [ ] La alerta queda en RDS: `SELECT * FROM alerts ORDER BY emitted_at DESC;`
- [ ] `snowball-readings-dlq` sigue vacía (si tiene mensajes, mirar qué payload rompió el parseo)
- [ ] `GET /api/units` devuelve las unidades con su última lectura
- [ ] El dashboard (website endpoint de S3) muestra las tarjetas actualizándose en vivo y la alerta en la tabla
- [ ] Login con cada rol: operator ve solo SB-001/SB-002, admin ve las tres.
- [ ] Como supervisor, "Marcar vista" en una alerta → la fila queda gris y RDS tiene `acknowledged_by`.
- [ ] Como supervisor, cambiar el setpoint de SB-001 → el simulador loguea `desired setpoint … applying` y el panel pasa de "(pendiente)" a aplicado.
- [ ] Como admin, crear un usuario y desactivarlo → ya no puede loguearse.

> Ojo: "ya no puede loguearse" es sobre intentos nuevos de login. El JWT que ese
> usuario ya tenía sigue siendo válido hasta que expire (hasta 8 h) — desactivarlo
> no lo desloguea ni corta su conexión `/live` si tenía una abierta, porque el feed
> fija las unidades permitidas al momento de conectar el WebSocket.

## 12. Al terminar cada sesión (presupuesto)

1. **Detener** (no borrar) la EC2 y la RDS. *Ojo:* AWS re-enciende una RDS
   detenida a los 7 días; si nadie la va a usar en la semana, sacarle un snapshot y borrarla.
2. DynamoDB / SQS / SNS / IoT Core / S3 quedan como están: centavos o nada en reposo.
3. Cerrar la sesión del lab con **End Lab** — y revisar el budget en la pantalla del curso.
