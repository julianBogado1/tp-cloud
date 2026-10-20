# Plan: suscripción MQTT sobre WebSockets para el dashboard

**Feature:** F5-C de la Feature 5 de la propuesta formal (dashboard en tiempo real).
**Hueco a cerrar:** la propuesta promete que el dashboard recibe la telemetría por **suscripción MQTT sobre WebSockets** contra IoT Core. Hoy el feed en vivo es un WebSocket propio de la API que *pollea* DynamoDB cada `LIVE_POLL_MS` (3 s) por unidad suscripta. Funciona y cumple el requisito no funcional de «<5 s p95», pero no es lo que dice la propuesta.
**Fecha:** 2026-10-20
**Estado:** plan escrito. **El paso 1 (spike de permisos) está PENDIENTE DE EJECUCIÓN** — no fallado y no aprobado. Nada del resto se implementa antes de que dé verde.

---

## 1. Qué ya existe y se reusa

| Pieza | Dónde | Estado / cómo se reusa |
|---|---|---|
| Feed en vivo actual (polling de DynamoDB) | `packages/api/src/live.ts:22-78` | funciona; el comentario de `live.ts:4-11` explica por qué no consume SQS (la cola es exclusiva del alert-processor y los consumidores compiten por los mensajes) |
| Handler de conexión del feed (auth + alcance) | `packages/api/src/live.ts:108-149` | token del query string (`:110`), cierre **4401** si es inválido (`:115`), unidades permitidas por `deps.listUnitIds(auth)` (`:120`) |
| Cableado del feed en el servidor | `packages/api/src/index.ts:93-102`, poll en `:104-114`, `LIVE_POLL_MS` en `:33` | queda intacto en la opción recomendada |
| Protocolo del feed, documentado | `packages/api/src/index.ts:24-30` | es el contrato que el cliente MQTT tiene que igualar o romper a propósito |
| Cliente del feed en el navegador | `packages/dashboard/src/api.ts:114-153` | token por query string (`:126`), reconexión a 3 s (`:142`), sin retry en 4401 (`:136-141`) |
| `deriveWsUrl(apiBase)` | `packages/dashboard/src/status.ts:42-47` | el gemelo exacto de lo que hay que escribir para `wss://<endpoint>/mqtt` |
| Badge «feed en vivo / reconectando…» | `packages/dashboard/src/App.tsx:117-119`, estado en `:51`, cableado en `:76-79` | el nuevo cliente alimenta el **mismo** `setConnected` |
| Acumulación de lecturas en vivo | `packages/dashboard/src/App.tsx:68-74` (`onReading`) | el callback nuevo tiene la misma firma |
| Sesión y token en el navegador | `packages/dashboard/src/auth.ts:51-64` (`getSession`), `:34-44` (`decodeExp`), `:46-49` (`isExpired`) | **`isExpired` es la pieza clave del plan**: permite distinguir «token muerto» de «red caída» sin que el broker nos lo diga |
| Verificación del JWT | `packages/api/src/auth/jwt.ts:36-52` (`verifyToken`), `:10-17` (`loadJwtSecret`), TTL de 8 h en `:7` | la Lambda del authorizer lo importa **tal cual**, sin duplicar nada |
| Claims del JWT | `packages/shared/src/auth.ts:32-39` (`AuthClaims`) | `sub`, `email`, `role`, `client_id`, `iat`, `exp` |
| Alcance por cliente | `packages/api/src/auth/scope.ts:24-28` (`scopeOf`), invariante en `:19-22` | el alcance sale del **rol**, nunca de un `client_id` nulo: `admin` → `{all:true}` |
| Unidades permitidas de un usuario | `packages/api/src/repositories/dynamodb.ts:86-98` (`listUnits`), `:99` (`listUnitIds`) | la query va por la GSI `client_id-index` (`terraform/modules/data/main.tf:7`) |
| Contrato `DataAccess` | `packages/api/src/data-access.ts:71-73` | `listUnitIds(scope)` ya existe; se refactoriza para no traer configs (ver §7, paso 4) |
| Tipos de la telemetría | `packages/shared/src/types.ts:14-26` (`Telemetry`), `:29-32` (`IngestedReading extends Telemetry` con `expires_at`) | el navegador recibirá `Telemetry`, no `IngestedReading` (ver §6) |
| Tópico de telemetría | `packages/shared/src/config.ts:96-98` (`telemetryTopic`), prefijo en `:21` | `snowball/<unit_id>/telemetry` |
| Policy del certificado de cada unidad | `terraform/modules/iot-ingest/main.tf:6-36` | condiciones `${iot:Connection.Thing.ThingName}`: **no se toca**, es la policy de los equipos |
| Regla IoT de ingesta | `terraform/modules/iot-ingest/main.tf:59-87`, SQL en `:62` | `SELECT *, topic(2) AS unit_id, ... FROM 'snowball/+/telemetry'`: el `unit_id` autoritativo sale del **tópico** |
| Endpoint ATS | `terraform/modules/iot-ingest/main.tf:3-5` (data), `outputs.tf:1-3`, `terraform/outputs.tf:16-18` | el valor que el navegador necesita |
| Data de región y cuenta | `terraform/modules/iot-ingest/main.tf:1-2` | ya están en el módulo donde va el authorizer |
| Módulo reusable de Lambda | `terraform/modules/lambda-function/main.tf:1-22`, variables en `variables.tf:1-40` | **no tiene `aws_lambda_permission`**: el authorizer lo necesita y hay que declararlo fuera del módulo |
| Catálogo de Lambdas | `terraform/locals.tf:28-68`, instanciado en `terraform/main.tf:147-157` | se suma una cuarta entrada |
| Por qué las Lambdas agendadas no necesitan permiso | comentario en `terraform/main.tf:172-174` | el Scheduler invoca **asumiendo** `LabRole`; IoT, en cambio, invoca como servicio → `aws_lambda_permission` obligatorio |
| Patrón de segundo entry point del mismo paquete | `packages/alert-processor/package.json:13-14` (`bundle:no-signal` / `zip:no-signal`) | **el patrón a imitar** para el authorizer dentro de `packages/api` |
| Cadena de bundling en CI | `package.json:16` (script `bundle`) | hay que sumar los dos scripts nuevos |
| `JWT_SECRET` por Terraform | `terraform/variables.tf:52-56` (sensitive) → `terraform/main.tf:134` → `terraform/modules/compute/main.tf:66` → `terraform/modules/compute/user-data.sh.tftpl:9` | hoy viaja **en texto plano en el user data** del launch template |
| Build y publicación del dashboard | `.github/workflows/terraform.yml:164-170` (`VITE_API_BASE` en `:169`) y el flujo manual en `README.md:109-112` | el punto exacto donde se inyectan las variables nuevas |
| Única variable de build del dashboard | `packages/dashboard/src/api.ts:12` (`VITE_API_BASE`) | hay que agregar dos más |
| `mqtt.js` ya en el repo (Node) | `packages/simulator/package.json:14` (`mqtt@^5.10.3`, instalado 5.15.2), uso en `packages/simulator/src/index.ts:70-77` y `scripts/mqtt-probe.mjs` | demuestra que la librería funciona contra este endpoint; **pero el simulador es Node con mTLS, no el navegador** |
| Dependencias del dashboard | `packages/dashboard/package.json:11-14` | sólo `react` y `react-dom`: `mqtt` es una dependencia **nueva** |
| Harness de AWS falso | `packages/alert-processor/test/fake-aws.ts:133-144` (exports), `:72-125` (`ddbSend`) | el estilo de fake del repo; el test del authorizer lo espeja |
| Tests que definen el contrato actual | `packages/api/test/live.test.ts:61-180` y `:181-245`; `packages/dashboard/test/api.connectLive.test.ts:82-144` | 4401 sin retry, retry a 3 s, `subscribe` sólo después de `ready`, cleanup que corta el timer |
| Tests del dashboard sin DOM | `packages/dashboard/test/status.test.ts:6`, `:71`, `:80` | **no hay `jsdom` ni `@testing-library` en ningún workspace**: todo lo nuevo se testea como helper puro |

### Dos restricciones del repo que condicionan todo el diseño

1. **El dashboard consume `@snowball/shared` sólo como tipos.** Lo dice el comentario de `packages/dashboard/src/auth.ts:5-7` («its `dist/` is CommonJS, which Vite does not pre-bundle for linked workspace packages») y lo confirma el grep: las cinco importaciones del paquete en `packages/dashboard/src/` son `import type`. **Consecuencia:** el cliente MQTT del navegador **no puede llamar a `telemetryTopic()`** de `packages/shared/src/config.ts:96-98`. El prefijo `snowball` se duplica en el dashboard, con el mismo comentario de «duplicado a propósito» que ya tiene `auth.ts`.
2. **`packages/dashboard/tsconfig.json:15` tiene `"include": ["src"]`.** El directorio `test/` **no lo typechequea** `tsc --noEmit`, y vitest tampoco. Por eso `packages/dashboard/test/api.connectLive.test.ts:64-66` puede devolver un objeto de tres campos tipado como `IngestedReading` sin que el CI se queje. **Consecuencia:** los tests nuevos no protegen de errores de tipo; lo que protege es que el código de `src/` compile.

---

## 2. El spike — PRIMERO Y BLOQUEANTE

> **Nada de las secciones 3 a 8 se implementa antes de que este paso dé verde.** Si da rojo, se va directo a §9 (plan B), que cuenta como entregable cumplido.

Lo que hay que averiguar son dos permisos, no uno:

| Permiso | Para qué | Comando que lo prueba |
|---|---|---|
| `iot:CreateAuthorizer` | crear el `aws_iot_authorizer` | `aws iot create-authorizer` |
| `lambda:AddPermission` con principal `iot.amazonaws.com` | que IoT pueda invocar la Lambda | `aws lambda add-permission` |

El segundo es el que la doc de AWS exige explícitamente ([Authorizing AWS IoT to invoke your Lambda function](https://docs.aws.amazon.com/iot/latest/developerguide/custom-auth-authorize.html)) y el que el repo **nunca** usó: el comentario de `terraform/main.tf:172-174` dice que las Lambdas agendadas no lo necesitan porque el Scheduler **asume** `LabRole`. IoT no asume nada: invoca como servicio.

### Preparación

```bash
# Credenciales frescas del Learner Lab (vencen a las ~4 h)
export AWS_ACCESS_KEY_ID=... AWS_SECRET_ACCESS_KEY=... AWS_SESSION_TOKEN=...
export AWS_REGION=us-east-1

ACCOUNT=$(aws sts get-caller-identity --query Account --output text)
echo "cuenta=$ACCOUNT"
```

### Paso 1.0 — Preflight: ¿el plano de control de IoT responde?

```bash
aws iot describe-endpoint --endpoint-type iot:Data-ATS
aws iot list-authorizers
```

- **Verde:** el primero devuelve `{"endpointAddress": "xxxxxxxx-ats.iot.us-east-1.amazonaws.com"}` y el segundo `{"authorizers": []}` (o una lista).
- **Rojo:** `AccessDeniedException` en `list-authorizers` → el plano de control de authorizers está cerrado. **No hace falta seguir: plan B.** Guardar la salida literal del error.

### Paso 1.1 — ¿Se puede crear un authorizer?

Se apunta a un ARN de función **que todavía no existe** (`snowball-iot-authorizer`). `CreateAuthorizer` no valida la existencia de la función (`authorizerFunctionArn` es un string de hasta 2048 caracteres con patrón `[\s\S]*`, según la [referencia de la API](https://docs.aws.amazon.com/iot/latest/apireference/API_UpdateAuthorizer.html)), así que este paso **no crea ni invoca nada**.

```bash
aws iot create-authorizer \
  --authorizer-name snowball-spike-authorizer \
  --authorizer-function-arn "arn:aws:lambda:us-east-1:${ACCOUNT}:function:snowball-iot-authorizer" \
  --signing-disabled \
  --status ACTIVE
```

- **Verde:** `{"authorizerName": "snowball-spike-authorizer", "authorizerArn": "arn:aws:iot:us-east-1:...:authorizer/snowball-spike-authorizer"}`. Guardar el ARN:
  ```bash
  AUTHZ_ARN=$(aws iot describe-authorizer --authorizer-name snowball-spike-authorizer \
    --query authorizerDescription.authorizerArn --output text)
  ```
- **Rojo:** `AccessDeniedException` — y hay dos sabores que significan cosas distintas:
  - el mensaje contiene **`with an explicit deny in a service control policy`** → el SCP del Lab lo prohíbe. **Irrecuperable: plan B.**
  - el mensaje dice sólo `is not authorized to perform: iot:CreateAuthorizer` sin mencionar SCP → le falta el permiso al usuario/rol del Lab, no hay deny de organización. Igual de bloqueante en la práctica (en el Lab no se pueden editar políticas IAM, `docs/infra-terraform.md:151`), pero **anotar la diferencia**: en la defensa no es lo mismo «AWS Academy lo prohíbe por diseño» que «este usuario no lo tiene».
  - `LimitExceededException` → ya hay 100 authorizers registrados o 32 activos (cuotas no ajustables, [AWS IoT Core endpoints and quotas](https://docs.aws.amazon.com/general/latest/gr/iot-core.html)). Improbable; listar y limpiar.

### Paso 1.2 — ¿Se puede dar permiso de invocación a `iot.amazonaws.com`?

Se usa una Lambda **existente** como blanco. Dar un permiso **no la invoca**, así que no hay efecto lateral: `snowball-telemetry-export` es la más inofensiva (correría un export diario completo si se invocara, y no se invoca).

```bash
aws lambda add-permission \
  --function-name snowball-telemetry-export \
  --principal iot.amazonaws.com \
  --action lambda:InvokeFunction \
  --statement-id snowball-spike-iot \
  --source-arn "$AUTHZ_ARN"
```

- **Verde:** devuelve un `{"Statement": "{\"Sid\":\"snowball-spike-iot\",...\"Principal\":{\"Service\":\"iot.amazonaws.com\"}...}"}`.
- **Rojo:** `AccessDeniedException ... not authorized to perform: lambda:AddPermission` (el error exacto que la doc de AWS muestra como caso de fallo) → **plan B**, incluso si el paso 1.1 dio verde: un authorizer que IoT no puede invocar es inútil.

> **Ojo con el orden de los dos pasos:** si 1.1 da rojo, `$AUTHZ_ARN` queda vacío y `add-permission` fallaría por `--source-arn` inválido, no por permisos. En ese caso correr 1.2 con un `--source-arn` cualquiera bien formado (`arn:aws:iot:us-east-1:${ACCOUNT}:authorizer/fake`) para separar las dos respuestas: así el documento puede decir **cuál** de los dos permisos falta.

### Paso 1.3 — Limpieza (correr siempre, verde o rojo)

```bash
aws lambda remove-permission --function-name snowball-telemetry-export --statement-id snowball-spike-iot
aws iot update-authorizer --authorizer-name snowball-spike-authorizer --status INACTIVE
aws iot delete-authorizer --authorizer-name snowball-spike-authorizer
aws iot list-authorizers   # tiene que volver a como estaba en 1.0
```

`DeleteAuthorizer` devuelve `DeleteConflictException` (409) si el authorizer está en uso; el `update-authorizer --status INACTIVE` previo lo evita.

### Qué NO forma parte del spike

El extremo a extremo (`curl` de upgrade contra `GET /mqtt`, abrir el dashboard y ver llegar un mensaje) **necesita la Lambda real desplegada**, así que es el paso 10 de la implementación, no del spike. El spike responde una sola pregunta: *¿el Lab deja construir esto?*

### Resultado del spike — a completar cuando se corra

| Paso | Comando | Salida | Veredicto |
|---|---|---|---|
| 1.0 | `iot describe-endpoint` / `list-authorizers` | _pendiente_ | — |
| 1.1 | `iot create-authorizer --signing-disabled` | _pendiente_ | — |
| 1.2 | `lambda add-permission --principal iot.amazonaws.com` | _pendiente_ | — |
| 1.3 | limpieza | _pendiente_ | — |

**Hoy: PENDIENTE DE EJECUCIÓN.** No hay credenciales de AWS en la sesión en la que se escribió este plan.

---

## 3. Decisión de diseño

### Mecanismo elegido: custom authorizer de IoT Core que valida el JWT del repo

El navegador abre `wss://<endpoint-ats>/mqtt?x-amz-customauthorizer-name=snowball-dashboard&token=<jwt>`. IoT Core invoca una Lambda nueva (`snowball-iot-authorizer`) que valida el JWT con el mismo `verifyToken` de `packages/api/src/auth/jwt.ts:36-52`, resuelve las unidades del `client_id` con la misma lógica de alcance de `packages/api/src/auth/scope.ts:24-28`, y devuelve un `policyDocuments` que permite `iot:Connect` sobre un client id atado al usuario y `iot:Subscribe`/`iot:Receive` **sólo** sobre los tópicos de esas unidades.

**Por qué este camino y no otro:** es el único que preserva el modelo de permisos que el repo ya respeta. El alcance por `client_id` no es decorativo — `scopeOf` lo deriva del rol justamente para que un operador mal configurado con `client_id` nulo no se convierta en lector global (comentario en `scope.ts:3-7`). Cualquier solución que no pueda expresar «este usuario ve estas unidades» es un retroceso de seguridad, no un avance de arquitectura.

### Por qué desde el navegador la autenticación sólo entra por query params

El `WebSocket` del navegador no permite mandar headers propios (la API web sólo acepta URL y subprotocolos). La doc de AWS acepta exactamente eso: en MQTT over WebSockets las credenciales van «through request headers **or query parameters** in the HTTP UPGRADE request» ([Connecting to AWS IoT Core by using custom authentication](https://docs.aws.amazon.com/iot/latest/developerguide/custom-auth.html)), y el flujo de autenticación confirma que el paso 1 admite query parameters «for the HTTP Publish or MQTT over WebSockets protocols» ([Understanding the custom authentication workflow](https://docs.aws.amazon.com/iot/latest/developerguide/custom-authorizer.html)).

### Alternativas descartadas

**(A) URL WSS presignada con SigV4 emitida por la API.** La API firmaría `wss://<endpoint>/mqtt?X-Amz-Algorithm=...` y la devolvería al dashboard. Técnicamente funciona y no necesita ningún recurso nuevo de IoT.
**Se descarta por seguridad, no por viabilidad.** La API corre con `LabRole` (`terraform/main.tf:128`, instance profile del Lab). Una URL firmada hereda **los permisos del firmante**: cualquier usuario autenticado de cualquier cliente obtendría los permisos de `LabRole` sobre IoT Core, es decir podría suscribirse a `snowball/+/telemetry` y leer los tópicos de **todos** los clientes. Acotarlo requeriría `sts:AssumeRole` con una *session policy* por usuario, y en el Learner Lab asumir roles arbitrarios es dudoso (no se pueden crear roles, `docs/infra-terraform.md:151`). Esto rompe frontalmente el alcance por `client_id` de `scope.ts:24-28`. Entre «no cumplir la promesa de la propuesta» y «cumplirla rompiendo el aislamiento entre clientes», lo correcto es lo primero.

**(B) Cognito Identity Pool.** Es el camino canónico de AWS para MQTT desde el navegador: identidad federada, credenciales temporales por usuario, policy de IoT adjunta a la identidad. **Se descarta por disponibilidad:** Cognito no figura entre los servicios habilitados del Learner Lab. No tiene sentido diseñar contra un servicio al que no se puede llegar.

**(C) Cambiar el esquema de tópicos a `snowball/<client_id>/<unit_id>/telemetry`.** Resolvería de un golpe el problema de tamaño del policy document (§5): una sola línea `topicfilter/snowball/7/+/telemetry` por cliente, sin lista explícita.
**Se descarta porque rompe tres cosas a la vez:**
- la regla IoT (`terraform/modules/iot-ingest/main.tf:62`): el filtro pasaría de `snowball/+/telemetry` a `snowball/+/+/telemetry` y `topic(2) AS unit_id` tendría que ser `topic(3)`;
- la policy de los certificados (`main.tf:20`): `topic/snowball/${iot:Connection.Thing.ThingName}/*` sólo matchea si el nombre del thing es el **segundo** segmento; con el `client_id` adelante ninguna unidad podría publicar;
- `telemetryTopic()` en `packages/shared/src/config.ts:96-98`, usado por el simulador en `packages/simulator/src/index.ts:134`.
Es un cambio coordinado en infra, firmware simulado y librería compartida para resolver un problema que con 3 unidades (`terraform/variables.tf:149-153`) no existe. La variante **aditiva** del mismo concepto (una acción `republish` extra en la regla existente que reemita a `snowball/client/<client_id>/<unit_id>/telemetry`, sin tocar el tópico original) sí es la vía de escape si algún día hay más de ~120 unidades por cliente; queda documentada en §5 y fuera del alcance de hoy.

**(D) Librería cliente: `aws-crt` (bundle de navegador) en lugar de `mqtt.js`.**
Se descarta. `aws-crt` resuelve el problema que acá **no tenemos** (firmar SigV4 y manejar ALPN/SNI desde el navegador para `wss-custom-auth`), a cambio de una dependencia nueva, pesada y con binarios nativos en el camino de Node, cuando `mqtt@5` ya está en el repo (`packages/simulator/package.json:14`) y publica un bundle de navegador pre-armado. Verificado leyendo el paquete instalado (5.15.2):
- `exports["."]` tiene la condición `browser.import → ./dist/mqtt.esm.js`, que es lo que Vite elige para el build de cliente;
- el bundle del navegador trae `Buffer` y el shim de `process.nextTick` **adentro** (las 10 apariciones de `Buffer.from` resuelven contra un polyfill de `buffer` bundleado; la única mención de `process.nextTick` es un string de log, la llamada real es `(0, bi.nextTick)`), así que **no hace falta ningún shim de Node en `vite.config.ts`**;
- `node_modules/mqtt/build/lib/connect/ws.js:92-101` hace `new WebSocket(url, ['mqtt'])` en el camino del navegador: manda exactamente el `sec-websocket-protocol: mqtt` que el `GET /mqtt` de IoT Core exige;
- `node_modules/mqtt/build/lib/connect/index.js:47-60` asigna `parsedOptions.path = parsedUrl.path`, y `path` de Node incluye la query string, así que `mqtt.connect('wss://host/mqtt?a=b')` la preserva hasta `buildUrl` (`ws.js:22-27`). **Cuidado con `index.js:76-77`:** si la query trae un parámetro llamado `clientId`, mqtt.js lo usa como client id del cliente — no usar ese nombre.

### Decisiones tomadas (2026-10-20)

| Decisión | Elección | Por qué |
|---|---|---|
| Mecanismo de auth | **Custom authorizer de IoT** | único camino que preserva el alcance por `client_id` (ver alternativas A y B) |
| `signing_disabled` | **`true`** | el navegador no puede firmar el token con una clave RSA privada sin exponerla. Ver la advertencia de inmutabilidad más abajo |
| `token_key_name` | **`"token"`**, aun con signing deshabilitado | así IoT puebla `event.token` en vez de obligar a parsear la query string a mano. La Lambda igual lleva un fallback que parsea `protocolData.http.queryString`, porque la doc no garantiza la combinación |
| Dónde vive la Lambda | **segundo entry point de `packages/api`** (`src/iot-auth/`) | copia el patrón de `no-signal-handler` dentro de `alert-processor` (`packages/alert-processor/package.json:13-14`). Reusa `auth/jwt.ts`, `auth/scope.ts` y `repositories/dynamodb.ts` **sin duplicar una línea**. `jsonwebtoken` y los SDK ya son dependencias de ese paquete |
| Librería en el navegador | **`mqtt@^5.15.2`** (la versión ya instalada; en npm la última es 5.16.1) | ver alternativa D. Se fija el mismo rango que el simulador para no tener dos copias en el árbol |
| De dónde sale el endpoint en el navegador | **`VITE_IOT_ENDPOINT` + `VITE_IOT_AUTHORIZER_NAME` inyectadas en el build** | ver §6 |
| Convivencia con `/live` | **los dos, con fallback automático: MQTT primero, API si falla** | ver §8. **Decisión del usuario** |
| `refreshAfterInSeconds` | **300** (el mínimo) | re-valida el JWT cada 5 min: es lo que convierte la revocación en algo real, cosa que `/live` hoy no hace (lo admite `README.md:544-549`) |
| `disconnectAfterInSeconds` | **`clamp(exp - now, 300, 86400)`** | la conexión muere junto con el token en vez de sobrevivirlo |
| Client id MQTT | **`dashboard-<userId>-<random>`**, con policy sobre `client/dashboard-<userId>-*` | ver §4 |

> ### Advertencia de inmutabilidad de `signing_disabled` — verificada, y es peor de lo que parece
> La doc de AWS es explícita: «You can't update an authorizer's signing requirement. This means that you can't disable signing in an existing authorizer that requires it. You also can't require signing in an existing authorizer that doesn't require it» ([Managing custom authorizers](https://docs.aws.amazon.com/iot/latest/developerguide/custom-auth-manage.html)). La referencia de [`UpdateAuthorizer`](https://docs.aws.amazon.com/iot/latest/apireference/API_UpdateAuthorizer.html) lo confirma por omisión: el body acepta `authorizerFunctionArn`, `enableCachingForHttp`, `status`, `tokenKeyName` y `tokenSigningPublicKeys` — **`signingDisabled` no está**.
> Y el provider de Terraform (`hashicorp/aws ~> 6.46`, `terraform/versions.tf:4`) **no marca ningún campo del recurso como `ForceNew`**, ni manda `signing_disabled` en el update. Resultado práctico: si algún día alguien cambia `signing_disabled`, `terraform plan` va a mostrar un diff **que nunca converge** — un apply tras otro sin efecto. No es «Terraform lo recrea»: es deriva permanente y silenciosa.
> **Mitigación:** un comentario en el recurso diciéndolo, y la instrucción de que cambiarlo exige `terraform state rm` + `aws iot delete-authorizer` + recrear. Lo mismo vale para `name`, que el provider tampoco manda en el update.

---

## 4. Diseño del custom authorizer

### 4.1 Shape exacto del evento que IoT manda

Verificado contra [Defining your Lambda function](https://docs.aws.amazon.com/iot/latest/developerguide/custom-auth-lambda.html) y contra los tipos de `@types/aws-lambda@8.10.164` que ya están en el árbol (`node_modules/@types/aws-lambda/trigger/iot-authorizer.d.ts:23-35`), que coinciden campo por campo:

```jsonc
{
  "token": "aToken",                      // sólo si el authorizer tiene token_key_name
  "signatureVerified": false,             // con signing deshabilitado, siempre false
  "protocols": ["tls", "http"],           // en el upgrade WebSocket: tls + http (NO mqtt)
  "protocolData": {
    "tls":  { "serverName": "xxxx-ats.iot.us-east-1.amazonaws.com" },
    "http": { "headers": { "...": "..." },
              "queryString": "?x-amz-customauthorizer-name=...&token=..." }
    // "mqtt": sólo si las credenciales van por el MQTT CONNECT, no por el upgrade
  },
  "connectionMetadata": { "id": "<uuid>" }   // el único campo que es seguro loguear
}
```

**Dos consecuencias de diseño que salen de este shape:**
1. **`protocolData.mqtt.clientId` NO está disponible.** La doc dice que ese campo viene «only when the device sends the value», y en el camino del HTTP UPGRADE la Lambda se invoca **antes** del paquete MQTT CONNECT. Por eso la policy de `iot:Connect` tiene que usar un **wildcard**, no el client id concreto (§5).
2. Todo el token está en `protocolData.http.queryString`. Es un string crudo, con el `?` adelante. Parsearlo con `new URLSearchParams(qs.replace(/^\?/, ''))`.

### 4.2 Shape exacto de la respuesta

Verificado en la misma página de la doc (y espejado en `iot-authorizer.d.ts:42-48`):

| Campo | Tipo | Restricción verificada |
|---|---|---|
| `isAuthenticated` | boolean | — |
| `principalId` | string | **`([a-zA-Z0-9]){1,128}`** — alfanumérico puro, ningún guion, ningún `@` |
| `policyDocuments` | array de documentos de policy de IoT | **máximo 10 documentos, máximo 2 048 caracteres cada uno** |
| `disconnectAfterInSeconds` | integer | mínimo **300**, máximo **86 400**, default 86 400. Se fija al establecer la conexión y **no se puede modificar en los refresh posteriores** |
| `refreshAfterInSeconds` | integer | mínimo **300**, máximo **86 400** |

**El `principalId` es una trampa.** El patrón prohíbe no-alfanuméricos, así que ni el email (`@`, `.`) ni `dashboard-<id>` (guion) sirven. Se usa **`u<userId>`** (`u42`): alfanumérico, estable, y suficiente para correlacionar en los logs de IoT sin filtrar el email del usuario.

Otros límites verificados que condicionan el diseño:
- **timeout de la Lambda del authorizer: 5 segundos** (no el timeout de la función, un techo del servicio). Esto descarta cualquier resolución de unidades con N llamadas a DynamoDB (ver §7, paso 4).
- tras la primera invocación, la siguiente puede demorarse hasta 5 minutos en conexiones ociosas; después sigue `refreshAfterInSeconds`.
- cuotas de cuenta: 100 authorizers registrados, 32 activos (no ajustables).

### 4.3 Validación del JWT sin duplicar lógica

```ts
// packages/api/src/iot-auth/handler.ts  (comentarios en inglés, como el resto del código)
import { loadJwtSecret, verifyToken } from '../auth/jwt';
import { scopeOf } from '../auth/scope';
import { dataAccess } from '../repositories/dynamodb';
```

`loadJwtSecret()` ya valida presencia y longitud mínima de 32 caracteres (`jwt.ts:10-17`) y falla en el arranque del módulo, no en la primera invocación — exactamente lo que se quiere en una Lambda con 5 s de techo. `verifyToken` ya chequea firma, expiración, claims malformados **y la invariante rol↔`client_id`** (`jwt.ts:50` llamando a `assertClientInvariant`). No se reimplementa nada: si tira, la respuesta es `isAuthenticated: false`.

Región y cuenta para armar los ARN: **de `context.invokedFunctionArn`**, cuyo campo 4 es la región y el 5 la cuenta. Así no hace falta ninguna variable de entorno nueva ni una llamada a STS (que consumiría parte de los 5 s). `AWS_REGION` sirve de respaldo, la pone Lambda sola.

### 4.4 Qué pasa cuando el JWT expira en medio de una sesión

```
       conecta (token con exp = T)
            │
            ▼
   ┌──────────────────┐   cada refreshAfterInSeconds = 300 s
   │  conexión viva   │◀──────────── IoT reinvoca la Lambda ────┐
   └──────────────────┘                                          │
            │                                    verifyToken OK ─┘
            │  verifyToken tira (exp pasado)
            ▼
   isAuthenticated: false  →  IoT corta la conexión
            │
            ▼
   mqtt.js intenta reconectar con el MISMO token (ya muerto)
            │
            ▼
   el upgrade falla; el navegador ve un error genérico + close 1006,
   SIN status HTTP (la spec de WebSocket no lo expone a JS)
            │
            ▼
   el cliente consulta isExpired(token)  (dashboard/src/auth.ts:46-49)
            │
      ┌─────┴─────┐
   expirado    no expirado
      │             │
      ▼             ▼
 clearSession() reintento a 3 s
 onUnauthorized()  (igual que hoy)
 SIN reintento
```

**Esto es el hallazgo más importante del plan en términos de pérdida funcional.** El feed de hoy distingue «token rechazado» de «red caída» con un close code de aplicación (4401, `live.ts:115` → `api.ts:136-141`). Con MQTT/WSS **eso se pierde**: el rechazo ocurre en el handshake HTTP y el navegador no entrega el status. La reconstrucción con `isExpired` cubre el caso dominante (token vencido) pero **no** cubre «token válido pero el usuario fue desactivado o movido de cliente»: ahí el cliente reintentaría a 3 s indefinidamente contra un authorizer que lo rechaza.
**Mitigación:** cortar los reintentos tras N fallos consecutivos sin haber llegado nunca a `connected` (se propone N=5, ~15 s) y caer al feed de la API, que **sí** devuelve 4401 y resuelve la sesión correctamente. Es otro argumento fuerte para la convivencia de §8.

El `disconnectAfterInSeconds = clamp(exp - now, 300, 86400)` hace que, en el caso normal, la conexión muera cuando muere el token. **Borde documentado:** si la conexión se abre en los últimos 5 minutos de vida del token, el mínimo de 300 s hace que pueda sobrevivirlo hasta 5 minutos. Comparado con `/live`, que valida **una sola vez** al conectar y después nunca más (hasta 8 h de sobrevida, `jwt.ts:7`), MQTT es estrictamente mejor. Vale decirlo así en la defensa.

---

## 5. El `policyDocuments`

### 5.1 Los ARN exactos

Verificados contra [AWS IoT Core action resources](https://docs.aws.amazon.com/iot/latest/developerguide/iot-action-resources.html):

| Acción | Tipo de recurso | ARN |
|---|---|---|
| `iot:Connect` | `client` | `arn:aws:iot:<region>:<account>:client/dashboard-<userId>-*` |
| `iot:Subscribe` | **`topicfilter`** | `arn:aws:iot:<region>:<account>:topicfilter/snowball/<unit_id>/telemetry` |
| `iot:Receive` | **`topic`** | `arn:aws:iot:<region>:<account>:topic/snowball/<unit_id>/telemetry` |

### 5.2 `topicfilter` vs `topic` — el error clásico, explicado

Son **dos tipos de recurso distintos** y no son intercambiables:

- **`iot:Subscribe` se autoriza sobre `topicfilter/`** porque lo que el cliente manda en el paquete SUBSCRIBE es un *filtro*, que puede contener los comodines MQTT `+` y `#`. El recurso describe el filtro pedido, no el tópico de un mensaje.
- **`iot:Receive` se autoriza sobre `topic/`** porque se evalúa **una vez por mensaje entregado**, contra el tópico concreto en el que se publicó.

Dos corolarios que muerden en la práctica:
1. **Hacen falta las dos.** Con sólo `Subscribe`, el SUBACK llega bien y después no aparece ni un mensaje: IoT acepta la suscripción y deniega silenciosamente cada entrega. Es el síntoma de «se conecta, dice que está suscripto, no llega nada» y es casi siempre `iot:Receive` faltante.
2. **Los comodines son distintos según el lado.** En un **documento de policy**, `*` es el comodín, y `+` y `#` se tratan como **literales** — lo dice la doc: «The characters `+` and `#` are treated as literal strings in a policy» ([AWS IoT Core policy variables](https://docs.aws.amazon.com/iot/latest/developerguide/iot-policy-variables.html)). Así que para permitir todos los tópicos de telemetría hay que escribir `topicfilter/snowball/*/telemetry` en la policy, aunque el cliente vaya a **suscribirse** a `snowball/+/telemetry`.

### 5.3 Límite de tamaño y el problema real de diseño

**El límite verificado: 10 documentos de policy, 2 048 caracteres cada uno.** Los documentos se evalúan en unión, con la lógica de IAM: «By default, all policies are implicitly denied. An explicit allow in any identity-based or resource-based policy overrides the default behavior. An explicit deny in any policy overrides any allows» ([AWS IoT Core policies](https://docs.aws.amazon.com/iot/latest/developerguide/iot-policies.html)). Así que partir las unidades en varios documentos **funciona**.

Cuentas con ARN reales (`us-east-1`, cuenta de 12 dígitos):
- `arn:aws:iot:us-east-1:123456789012:topicfilter/snowball/SB-001/telemetry` = **68 caracteres**; con comillas y coma en el JSON, ~71.
- `topic/...` es 6 caracteres más corto: ~65.
- Por unidad: ~136 caracteres de ARN.
- Esqueleto del documento (`Version`, dos `Statement`, `Action`, `Effect`, llaves): ~230 caracteres.
- Presupuesto útil: `2048 - 230 ≈ 1818` → **~13 unidades por documento**, **~130 unidades por conexión** con los 10 documentos.

Con las 3 unidades del repo (`terraform/variables.tf:149-153`) sobra todo. Pero el requisito no funcional dice «escalar de 10 a 1 000 dispositivos sin rediseño», así que hay que decir qué pasa arriba.

**Y acá aparece el problema de diseño real: los tópicos son `snowball/<unit_id>/telemetry` y no tienen el `client_id` en el path.** No existe ningún wildcard que signifique «todas las unidades del cliente 7»: `snowball/*/telemetry` significa *todas las unidades de todos los clientes*. La lista explícita no es una elección de estilo, es la única forma de expresar el alcance con este esquema de tópicos.

Las tres salidas, y qué se hace con cada una:

| Salida | Cuándo aplica | Veredicto |
|---|---|---|
| **Lista explícita, partida en ≤10 documentos de ≤2048 chars** | hasta ~130 unidades por usuario | **elegida**. El builder parte solo y es una función pura testeable |
| **Wildcard `snowball/*/telemetry` para `admin`** | `scopeOf` devuelve `{all:true}` | **elegida también**. Un admin legítimamente ve todo, así que para ese rol un solo statement con `*` es correcto *y* resuelve el límite de tamaño y el de suscripciones de un golpe. Para no-admin, jamás |
| **Cambiar el esquema de tópicos** | >130 unidades por cliente | **descartada** (alternativa C de §3): rompe la regla IoT, la policy de los certificados y el simulador |
| **Acción `republish` aditiva en la regla existente** | >130 unidades por cliente | **documentada, fuera de alcance**: una acción más en `aws_iot_topic_rule.telemetry` que reemita a `snowball/client/<client_id>/<unit_id>/telemetry` sin tocar el tópico original. Habilita el wildcard por cliente sin romper nada, a cambio de duplicar el volumen de mensajes del broker |

**Y hay un segundo techo, independiente del tamaño de la policy:** las cuotas de IoT Core dicen **máximo 8 suscripciones por request SUBSCRIBE** y **50 suscripciones por conexión** ([AWS IoT Core endpoints and quotas](https://docs.aws.amazon.com/general/latest/gr/iot-core.html)). `mqtt.js` manda un solo SUBSCRIBE con todos los filtros que se le pasen, así que **el cliente tiene que partir en lotes de 8**, y por encima de 50 unidades la suscripción explícita deja de ser posible aunque la policy quepa. Esto refuerza que el camino escalable es el wildcard por cliente (fila 4), no la lista.

### 5.4 El client id y el `iot:Connect`

El client id lo elige el navegador: **`dashboard-<userId>-<random>`**, con `random` de 8 caracteres hex. El `userId` va adentro a propósito: la policy permite `client/dashboard-<userId>-*`, de modo que un usuario **no puede** conectarse con el client id de otro. Esto importa porque MQTT desconecta al cliente existente cuando llega otro con el mismo client id: sin el prefijo atado al usuario, cualquiera podría echar a cualquiera del feed. El sufijo aleatorio permite que el mismo usuario tenga dos pestañas abiertas sin pelearse.

No se puede usar la variable de policy `${iot:ClientId}` para condicionar los tópicos (como hace el ejemplo de la doc de AWS, o como hace `aws_iot_policy.device` con `${iot:Connection.Thing.ThingName}` en `terraform/modules/iot-ingest/main.tf:14`), porque el client id del dashboard no tiene relación con ningún `unit_id`. El alcance se expresa enumerando, no con una variable.

### 5.5 Documento resultante (ejemplo, operador del cliente 7 con dos unidades)

```json
{
  "Version": "2012-10-17",
  "Statement": [
    { "Effect": "Allow", "Action": "iot:Connect",
      "Resource": "arn:aws:iot:us-east-1:123456789012:client/dashboard-42-*" },
    { "Effect": "Allow", "Action": "iot:Subscribe", "Resource": [
      "arn:aws:iot:us-east-1:123456789012:topicfilter/snowball/SB-001/telemetry",
      "arn:aws:iot:us-east-1:123456789012:topicfilter/snowball/SB-002/telemetry" ] },
    { "Effect": "Allow", "Action": "iot:Receive", "Resource": [
      "arn:aws:iot:us-east-1:123456789012:topic/snowball/SB-001/telemetry",
      "arn:aws:iot:us-east-1:123456789012:topic/snowball/SB-002/telemetry" ] }
  ]
}
```

El `iot:Connect` va **sólo en el primer documento** cuando hay que partir; los documentos 2..10 llevan nada más que `Subscribe`/`Receive` (la unión de allows hace el resto). Un usuario sin unidades recibe `isAuthenticated: true` con un único documento que sólo permite `Connect`: se conecta, no se suscribe a nada, y el dashboard muestra el badge en verde sin datos — que es exactamente lo que hoy pasa con `listUnitIds` devolviendo `[]` (`live.ts:169-180` del test).

---

## 6. El cliente MQTT en el dashboard

### 6.1 Dependencia nueva

`packages/dashboard/package.json` → `dependencies`: **`"mqtt": "^5.15.2"`**. Se fija la versión ya instalada en el árbol (`node_modules/mqtt` = 5.15.2) en vez del `^5.10.3` del simulador o del `5.16.1` que es el `latest` de npm hoy: el rango `^5.15.2` es compatible con el del simulador, así que npm resuelve **una sola copia** y el `package-lock.json` no se mueve más de lo necesario.

### 6.2 Construcción de la URL

```
wss://<endpoint>/mqtt
    ?x-amz-customauthorizer-name=snowball-dashboard
    &token=<jwt>
```

Los dos valores van `encodeURIComponent`-eados: la doc de AWS lo recomienda explícitamente para `x-amz-customauthorizer-name` y `token-key-name`, y el JWT puede traer `-` y `_` del base64url (inofensivos) pero conviene no depender de eso. **El nombre del parámetro del token NO puede ser `clientId`**, por `node_modules/mqtt/build/lib/connect/index.js:76-77`.

### 6.3 De dónde sale el `iot_endpoint` en el navegador — comparación

Hoy la única variable inyectada en el build es `VITE_API_BASE` (`packages/dashboard/src/api.ts:12`, inyectada en `.github/workflows/terraform.yml:169` y en el flujo manual de `README.md:111`).

| Camino | A favor | En contra |
|---|---|---|
| **(a) `VITE_IOT_ENDPOINT` + `VITE_IOT_AUTHORIZER_NAME` en el build** | copia exactamente el patrón que ya existe; cero round-trips antes de conectar; cero rutas nuevas; el workflow ya tiene `terraform output -raw iot_endpoint` a mano (lo imprime en `terraform.yml:175`) | queda horneado en el bundle: cambiar el endpoint exige recompilar. En la práctica el endpoint ATS es estable por cuenta+región, así que es un no-problema |
| **(b) `GET /api/live-config` que lo devuelva** | sin recompilar; el endpoint podría cambiar por ambiente | una ruta más, un test más, un round-trip más antes de conectar, **y un modo de falla nuevo** sin ninguna ganancia real: si la API no responde, `fetchUnits()` ya falló y el dashboard está mostrando la pantalla de error (`App.tsx:110`), así que el feed es irrelevante |

**Elegido: (a).** Y hay un beneficio de diseño gratis: si `VITE_IOT_ENDPOINT` está vacío (que es el caso de `npm run dashboard` en local), `connectLiveMqtt` no está disponible y el orquestador cae al WebSocket de la API sin ninguna rama especial. El modo dev sigue funcionando igual que hoy.

### 6.4 Mapeo del payload MQTT → lectura

**Lo que llega por el tópico NO es un `IngestedReading`.** Verificado:
- la unidad publica `JSON.stringify(result.reading)` donde `reading: Telemetry` (`packages/simulator/src/index.ts:134`, armado en `packages/simulator/src/telemetry.ts:45-54`);
- `expires_at` lo calcula la **regla**, no el dispositivo — `floor(timestamp() / 1000) + 2592000` en `terraform/modules/iot-ingest/main.tf:62`, y lo dice el comentario del tipo en `packages/shared/src/types.ts:30` («set by the rule, never by the device»);
- `IngestedReading` declara `expires_at: number` **obligatorio** (`types.ts:29-32`).

**Corrección a un supuesto del encargo:** el payload del simulador **sí** trae `unit_id` (`telemetry.ts:46`), y el comentario de `types.ts:10-11` dice que es a propósito, «so both match byte for byte». Lo que falta es `expires_at`, no el `unit_id`.

**Aun así, el `unit_id` se saca del tópico, no del body.** Dos razones: (1) es lo que la regla considera autoritativo (`topic(2) AS unit_id`), y por eso un dispositivo real que omita el campo igual queda bien indexado; (2) la policy autoriza por tópico, así que el tópico es el único dato cuya procedencia está garantizada por IoT — si body y tópico discrepan, confiar en el body permitiría a una unidad comprometida inyectar lecturas atribuidas a otra. Si discrepan, **gana el tópico**, y el caso se descarta con un `console.warn`.

**Consecuencia de tipos:** la firma del callback en vivo pasa de `IngestedReading` a `Telemetry`. Es un cambio seguro y chico: `grep expires_at packages/dashboard/` no devuelve **nada**, y `IngestedReading extends Telemetry`, así que `UnitCard.tsx:17` (`history[last] ?? unit.last_reading`, con `last_reading: IngestedReading | null` en `api.ts:23`) sigue tipando porque el resultado se ensancha a `Telemetry | null`, que es lo que `readingStatus` pide (`status.ts:23-27` sólo usa `ts` y `temp_c`).

### 6.5 Reconexión y el estado `connected`

Estados del cliente MQTT, con el mismo badge de `App.tsx:117-119` como salida:

```
          connectLiveFeed(units, token)
                   │
                   ▼
            ┌─────────────┐   VITE_IOT_ENDPOINT vacío, o 5 fallos
            │  mqtt-init  │────── sin llegar nunca a live ──────┐
            └─────────────┘                                     │
                   │ open + CONNACK                             │
                   ▼                                            │
            ┌─────────────┐                                     │
            │  mqtt-live  │  connected = true                   │
            └─────────────┘                                     │
                │       ▲                                       │
       close/offline    │ reconnect OK                          │
                │       │                                       │
                ▼       │                                       │
         ┌───────────────┐                                      │
         │ mqtt-retrying │  connected = false                    │
         └───────────────┘                                      │
                │                                               │
      isExpired(token) === true                                 │
                │                                               │
                ▼                                               ▼
        ┌──────────────┐                              ┌──────────────────┐
        │ unauthorized │  clearSession()               │  api-fallback    │
        │  (terminal)  │  onUnauthorized()             │  connectLive()   │
        └──────────────┘  sin reintento                └──────────────────┘
                                                        (el feed de hoy, con
                                                         su 4401 y su retry)
```

Reglas de la máquina, todas puras y testeables:
- `mqtt-init` → `api-fallback` si pasan **8 s** sin CONNACK, o si hay **5** `close` consecutivos sin haber estado nunca en `mqtt-live`.
- Una vez que se llegó a `mqtt-live`, **no** se cae al fallback nunca más: se reintenta MQTT a 3 s (mismo intervalo que `api.ts:142`), porque un corte después de una conexión exitosa es red, no permisos.
- `isExpired(token)` (`dashboard/src/auth.ts:46-49`) se consulta **antes** de cada reintento; si da `true`, estado terminal `unauthorized` con `clearSession()` + `onUnauthorized()` — exactamente lo que hoy hace el 4401 en `api.ts:136-141`.
- El cleanup que devuelve `connectLiveFeed` corta el timer pendiente y cierra lo que esté abierto (MQTT o WebSocket), igual que `api.ts:148-152`.

`mqtt.js` se configura con `reconnectPeriod: 0` y la reconexión la maneja el orquestador. Se renuncia a la reconexión interna de la librería a propósito: con `reconnectPeriod` propio, mqtt.js reintentaría con el token viejo sin pasar por el chequeo de expiración, y el bucle infinito contra un authorizer que rechaza sería invisible.

### 6.6 Impacto en el bundle — medido

| | JS crudo | JS gzip |
|---|---|---|
| Bundle actual (`packages/dashboard/dist/assets/index-bA9J42tP.js`) | 158 212 B | 51 093 B |
| `node_modules/mqtt/dist/mqtt.esm.js` (el bundle de navegador, ya minificado) | 369 206 B | 111 099 B |
| **Proyección** | **~480-520 kB** | **~140-160 kB** |

Tres cosas importantes:
1. El `mqtt.esm.js` está **pre-bundleado y pre-minificado** (mide igual que `mqtt.min.js`: 369 231 B), así que Rollup casi no puede sacudirle nada: hay que presupuestar el total, no una fracción.
2. **Vite va a imprimir el aviso de «chunk size > 500 kB»** (el umbral por defecto). Es un `warn`, **no rompe el build** — pero conviene decidir antes si se silencia con `build.chunkSizeWarningLimit` o si se acepta el ruido en el log del workflow.
3. Mitigación disponible si el tamaño molesta: cargar el cliente MQTT con `await import('mqtt')` dentro de `connectLiveMqtt`. Vite lo parte en un chunk aparte y el *first paint* del dashboard sigue pesando 158 kB; los 110 kB se bajan sólo cuando el feed arranca. Cuesta hacer `connectLiveMqtt` asíncrona. **Recomendado**, y es lo que hace que esta feature no empeore el tiempo de carga de la pantalla de login.

---

## 7. Pasos de implementación

> Precondición absoluta: **§2 en verde.**

### Tanda A — lógica pura (sin AWS, sin DOM, sin red)

1. **`packages/api/src/iot-auth/policy.ts`** (nuevo, puro)
   ```ts
   export interface PolicyInput {
     region: string; accountId: string; userId: number;
     unitIds: readonly string[];
     /** admin scope: one wildcard statement instead of an explicit list */
     allUnits: boolean;
   }
   export const MAX_POLICY_DOCUMENTS = 10;
   export const MAX_POLICY_CHARS = 2048;
   export function connectResource(region: string, accountId: string, userId: number): string;
   export function buildPolicyDocuments(input: PolicyInput): PolicyDocument[];
   export function clampDisconnectSeconds(expSeconds: number, nowSeconds: number): number;
   export function principalIdOf(userId: number): string;   // -> `u<userId>`
   export function authorizerResponse(input: PolicyInput & { expSeconds: number; nowSeconds: number }): IoTCustomAuthorizerResult;
   export function denied(): IoTCustomAuthorizerResult;
   ```
   `buildPolicyDocuments` parte la lista en documentos midiendo `JSON.stringify(doc).length` contra `MAX_POLICY_CHARS` y tira si no alcanza con `MAX_POLICY_DOCUMENTS` (mejor un error explícito que una policy truncada en silencio). Tipos `PolicyDocument` / `IoTCustomAuthorizerResult` desde `@types/aws-lambda`.
2. **`packages/api/src/iot-auth/event.ts`** (nuevo, puro)
   ```ts
   /** Reads event.token, falling back to parsing protocolData.http.queryString. */
   export function tokenFromEvent(event: IoTCustomAuthorizerEvent, tokenKeyName?: string): string | null;
   ```
3. **`packages/api/package.json`** — `devDependencies`: `"@types/aws-lambda": "^8.10.164"` (misma versión que `packages/alert-processor/package.json:24`, ya en el árbol). Scripts nuevos, espejando `packages/alert-processor/package.json:13-14`:
   ```
   "bundle:iot-auth": "esbuild src/iot-auth/handler.ts --bundle --platform=node --target=node22 --external:@aws-sdk/* --outfile=dist/iot-auth/index.js",
   "zip:iot-auth": "cd dist/iot-auth && (zip -j ../iot-authorizer.zip index.js || python -m zipfile -c ../iot-authorizer.zip index.js)"
   ```
   (`--external:@aws-sdk/*` porque el runtime los provee, igual que en alert-processor; `jsonwebtoken` **sí** se bundlea.)

### Tanda B — handler y acceso a datos (depende de A)

4. **`packages/api/src/repositories/dynamodb.ts:86-99`** — refactor acotado: extraer la query de unidades de `listUnits` a un `queryUnitItems(scope)` y hacer que `listUnitIds` la use **sin** el `Promise.all` de `GetCommand` contra `device-config` de `:90`. Hoy `listUnitIds` paga N GetItems para después tirar las configs (`:99` sólo mapea `unit_id`). Con el techo de **5 segundos** del authorizer eso es inaceptable a escala, y de paso acelera el camino de auth de `/live` (`packages/api/src/index.ts:98`). Contrato de `data-access.ts:71-73` **sin cambios**; los fakes de `packages/api/test/fixtures.ts:39` siguen válidos.
5. **`packages/api/src/iot-auth/handler.ts`** (nuevo, impuro). `handler(event, context)`:
   - `tokenFromEvent` → si no hay token, `denied()`;
   - `verifyToken(token, SECRET)` → si tira, `denied()`;
   - `scopeOf(auth)`; si `{all:true}` → `allUnits: true`; si no → `dataAccess.listUnitIds(scope)`;
   - región y cuenta de `context.invokedFunctionArn`;
   - `authorizerResponse(...)`.
   **Regla de logging, no negociable:** jamás loguear `event` completo ni `protocolData.http.queryString` (llevan el JWT). Sólo `connectionMetadata.id`, el `principalId` y la cantidad de unidades.
6. **`packages/api/test/iot-auth-policy.test.ts`** (nuevo) y **`packages/api/test/iot-auth-handler.test.ts`** (nuevo) — ver §11.

### Tanda C — infra (depende de B sólo por el nombre del zip, puede ir en paralelo)

7. **`terraform/variables.tf`** — `iot_authorizer_lambda_zip_path` (default `../packages/api/dist/iot-authorizer.zip`), `iot_authorizer_name` (default `"snowball-dashboard"`; validación contra `^[\w=,@-]+$`, que es el patrón que la API exige), `iot_authorizer_enabled` (bool, default **`false`**). El flag apagado por defecto es lo que materializa el bloqueo del spike: hasta que dé verde, `terraform apply` no intenta crear nada.
8. **`terraform/locals.tf:28-68`** — cuarta entrada en `local.lambdas`:
   ```hcl
   "iot-authorizer" = {
     function_name = "snowball-iot-authorizer"
     zip_path      = var.iot_authorizer_lambda_zip_path
     timeout       = 5   # el servicio corta a los 5 s; más no sirve
     memory_size   = 256
     environment   = { JWT_SECRET = var.jwt_secret, DDB_UNITS_TABLE = module.data.table_names.units }
   }
   ```
   Si `iot_authorizer_enabled` es `false`, la entrada no se agrega (merge condicional), y el `for_each` de `terraform/main.tf:149` no crea nada.
9. **`terraform/modules/iot-ingest/main.tf`** — `aws_iot_authorizer` + `aws_lambda_permission`, con `count = var.authorizer_function_arn == null ? 0 : 1`. Va en este módulo porque ya tiene `data.aws_region` y `data.aws_caller_identity` (`:1-2`) y es el módulo de IoT. Variables nuevas en `terraform/modules/iot-ingest/variables.tf`: `authorizer_function_arn`, `authorizer_function_name`, `authorizer_name`.
   ```hcl
   # signing_disabled is immutable: UpdateAuthorizer does not accept it and the
   # provider does not force replacement, so changing it yields a plan that never
   # converges. To change it: terraform state rm + aws iot delete-authorizer.
   resource "aws_iot_authorizer" "dashboard" { ... signing_disabled = true, token_key_name = "token", status = "ACTIVE" }
   # IoT invokes as a service principal, unlike the Scheduler (see main.tf:172-174).
   resource "aws_lambda_permission" "iot_authorizer" { principal = "iot.amazonaws.com", action = "lambda:InvokeFunction", source_arn = aws_iot_authorizer.dashboard[0].arn, ... }
   ```
   Sin ciclo: lambda → authorizer → permission, y la Lambda no depende del permiso.
10. **`terraform/modules/iot-ingest/outputs.tf`** — `authorizer_name`; **`terraform/outputs.tf`** — `iot_authorizer_name` (lo consume el workflow).
11. **`package.json:16`** — sumar `bundle:iot-auth` y `zip:iot-auth` a la cadena de `npm run bundle`.

### Tanda D — dashboard (depende de A por nada; puede ir con C)

12. **`packages/dashboard/package.json:11-14`** — `"mqtt": "^5.15.2"` en `dependencies`.
13. **`packages/dashboard/src/iot.ts`** (nuevo, puro — el gemelo de `status.ts`)
    ```ts
    /** Mirrors snowball/<unit_id>/telemetry from @snowball/shared; duplicated on
     *  purpose, like the role ladder in auth.ts (the dashboard imports that
     *  package as types only). */
    export const TOPIC_PREFIX = 'snowball';
    export const MAX_FILTERS_PER_SUBSCRIBE = 8;   // IoT Core quota
    export function telemetryTopicFilter(unitId: string): string;
    export function unitIdFromTopic(topic: string): string | null;
    export function normalizeTelemetry(unitId: string, raw: unknown): Telemetry | null;
    export function chunkFilters(filters: readonly string[], size?: number): string[][];
    export function buildIotWsUrl(i: { endpoint: string; authorizerName: string; token: string; tokenKeyName?: string }): string;
    export function mqttClientId(userId: number, random: string): string;
    ```
14. **`packages/dashboard/src/live-mqtt.ts`** (nuevo, impuro) — `connectLiveMqtt(opts): () => void`, con `await import('mqtt')` (§6.6) y `reconnectPeriod: 0`.
15. **`packages/dashboard/src/live-feed.ts`** (nuevo) — el reducer puro de la máquina de §6.5:
    ```ts
    export type FeedState = { kind: 'mqtt-init' | 'mqtt-live' | 'mqtt-retrying' | 'api-fallback' | 'unauthorized'; failures: number };
    export type FeedEvent = { type: 'connected' } | { type: 'closed' } | { type: 'timeout' } | { type: 'token-expired' } | { type: 'no-endpoint' };
    export function nextFeedState(state: FeedState, event: FeedEvent): FeedState;
    ```
    más el orquestador `connectLiveFeed(unitIds, token, userId, onReading, onStatus)`, que es lo que `App.tsx` llama.
16. **`packages/dashboard/src/api.ts`** — `connectLive` **queda intacta**; se exporta además `connectLiveFeed` desde `live-feed.ts` y se cambia la firma del callback de `IngestedReading` a `Telemetry` (`api.ts:117`, `:130`). `deriveWsUrl` (`status.ts:42-47`) no se toca.
17. **`packages/dashboard/src/App.tsx:68`, `:78`** — `onReading` pasa a `(reading: Telemetry)`, `history` a `Record<string, Telemetry[]>` (`:48`), y la llamada de `:78` pasa a `connectLiveFeed(units.map(...), session.token, session.user.id, onReading, setConnected)`. **El badge de `:117-119` no se toca**: sigue leyendo el mismo `connected`.
18. **`packages/dashboard/src/UnitCard.tsx:1`, `:8`** — `history: Telemetry[]`.

### Tanda E — CI y docs

19. **`.github/workflows/terraform.yml:164-170`** — en el paso «Compilar y publicar el dashboard»:
    ```bash
    IOT_ENDPOINT="$(terraform -chdir=terraform output -raw iot_endpoint)"
    IOT_AUTHORIZER="$(terraform -chdir=terraform output -raw iot_authorizer_name || echo '')"
    VITE_API_BASE="http://${ALB}" VITE_IOT_ENDPOINT="$IOT_ENDPOINT" \
      VITE_IOT_AUTHORIZER_NAME="$IOT_AUTHORIZER" npm run build -w @snowball/dashboard
    ```
    El `|| echo ''` es lo que hace que el workflow siga funcionando con `iot_authorizer_enabled = false`: sin nombre de authorizer, el dashboard cae al feed de la API.
20. **`README.md:109-112`** — las mismas dos variables en el flujo manual. También: `README.md:525` menciona un `packages/dashboard/.env.example` que **no existe** en el repo; crearlo con las tres variables cierra ese hueco.
21. **`README.md:35`, `:40`, `:417-422`, `:544-549`** — el diagrama y el párrafo «Por qué la API sigue en EC2» (que hoy justifica `/live` como razón de ser de EC2 y sigue siendo cierto: `/live` queda como fallback); y en `:544-549`, que hoy dice que el feed fija las unidades al conectar y no se entera de una desactivación, agregar que por MQTT el authorizer re-valida cada 300 s.
22. **`docs/features-faltantes-propuesta.md:19`** — fila 5: el ítem de MQTT pasa de pendiente a hecho, **con la honestidad de decir que el feed de la API queda como fallback**. Texto propuesto en §9.3 (sirve igual en el caso verde, cambiando el veredicto).
23. **`docs/infra-terraform.md:987`** (tabla del módulo `lambda-function`) y **`:1013-1019`** — la Lambda nueva, el authorizer, y el matiz de que ésta **sí** lleva `aws_lambda_permission` mientras las agendadas no.

---

## 8. Convivencia o reemplazo del feed actual — **decisión del usuario**

| | (i) reemplazar y borrar `/live` | (ii) los dos, con fallback automático | (iii) MQTT como demo opcional |
|---|---|---|---|
| Latencia | ms (push) | ms, degradando a ≤3 s | ms cuando se enciende |
| Carga en DynamoDB | cero | cero mientras MQTT ande | cero cuando se enciende |
| **Backlog tras un corte** | **se pierde** | se recupera al caer al fallback | se pierde |
| Lectura inicial | ya viene en `GET /api/units` (`api.ts:95`, `App.tsx:56`) | idem | idem |
| Sesión inválida (4401) | **no se puede distinguir** desde el navegador | sí, vía el fallback | no |
| Código y tests | se borran ~230 líneas y 2 archivos de test | nada se borra, +~120 líneas | nada se borra |
| Cumple la propuesta | sí | sí, con una nota al pie | a medias |
| Riesgo en la defensa | si el authorizer falla, **no hay feed** | siempre hay feed | hay que explicar por qué está apagado |

### Recomendación: (ii), con fallback automático

Tres argumentos, en orden de peso:

1. **El backlog.** El polling de `live.ts` lleva un cursor `lastSeen` por unidad (`live.ts:24`, `:72`) y hace `Query(unit_id, ts > lastSeen)` (`packages/api/src/data.ts:15-27`): después de un corte de red de dos minutos, la próxima vuelta **devuelve todo lo que se perdió**, y el sparkline del dashboard (`App.tsx:69-71`, `Sparkline` en `:143-149`) queda continuo. MQTT es *fire and forget*: lo que se publicó mientras el navegador estaba desconectado no existe. Con QoS 1 y sesión persistente MQTT 5 se podría mitigar, pero IoT Core no retiene mensajes para sesiones de navegador de forma confiable, y entrar ahí es un rediseño, no un ajuste. El fallback resuelve esto sin ninguna complejidad nueva: si MQTT se cae, el polling se encarga y recupera el hueco.
2. **El 4401.** Es el único mecanismo por el que hoy una sesión vencida saca al usuario al login (`live.ts:115` → `api.ts:136-141`, con test en `api.connectLive.test.ts:104-120`). Con MQTT se pierde (§4.4). El fallback lo devuelve.
3. **Riesgo de la defensa.** Las credenciales del Lab vencen a las ~4 h y el authorizer puede quedar en un estado raro. Con (i), un authorizer caído el día de la defensa significa un dashboard sin feed en vivo — la peor demo posible, borrando código que funcionaba. Con (ii), siempre hay feed.

El costo es honesto y chico: dos caminos vivos y un orquestador de ~120 líneas, del cual la parte decisoria es un **reducer puro** (`nextFeedState`, paso 15) testeable sin DOM ni red.

### Si el usuario elige (i): qué se rompe

- **Tests que se caen:** `packages/api/test/live.test.ts` **completo** (`:61-180` para `createLiveFeed` y `:181-245` para `createLiveConnectionHandler`) y `packages/dashboard/test/api.connectLive.test.ts` **completo** (`:82-144`). Son dos archivos y ~20 casos de los que `npm test` depende hoy.
- **Código que se borra:** `packages/api/src/live.ts` entero, el cableado de `packages/api/src/index.ts:93-114` (incluido el `clearInterval(timer)` del shutdown en `:122`), `queryNewReadings` en `packages/api/src/data.ts:15-27`, `connectLive` en `packages/dashboard/src/api.ts:114-153` y `deriveWsUrl` en `packages/dashboard/src/status.ts:42-47` (con sus casos de `status.test.ts:80-84`).
- **Argumento de arquitectura que se cae:** `README.md:417-422` justifica que la API siga en EC2 porque `/live` mantiene conexiones abiertas y una Lambda no puede. Sin `/live`, **ese argumento desaparece** y hay que reescribirlo (la API sigue necesitando EC2 por otras razones, pero no por esa). En una defensa oral esto es un flanco: se promete «sin instancias permanentes» (`docs/features-faltantes-propuesta.md:39` lo marca ❌) y se acaba de borrar la única razón técnica por la que había instancias.
- **Requisito no funcional «<5 s p95»** (`features-faltantes-propuesta.md:29`): MQTT lo cumple **mejor** en el caso feliz (ms contra ≤3 s), pero **lo deja de cumplir por completo** mientras el navegador esté desconectado, porque no hay recuperación. Con (ii) el peor caso sigue acotado a 3 s. **Si lo que importa es el p95 medido, (ii) es estrictamente mejor que (i).**

---

## 9. Plan B — si el spike da rojo

> Este es **el resultado más probable**, y es un entregable cumplido, no un fracaso. El criterio es el del encargo: no se fuerza nada.

### 9.1 Qué se hace

1. **No se toca una línea de `live.ts`, de `api.ts` ni de Terraform.** El feed actual queda exactamente como está.
2. **No se agrega `mqtt` al dashboard.** Sin camino de auth viable, la dependencia sería 110 kB de gzip de código muerto.
3. Se completa la tabla de resultados de §2 con la **salida literal** de los comandos que fallaron. Es la evidencia de la defensa: no «probamos y no se pudo», sino el `AccessDeniedException` textual.
4. Este documento se queda en el repo, con §9.2 como conclusión, y se enlaza desde `features-faltantes-propuesta.md` y el README.
5. Se escribe §9.4: **qué haría falta exactamente en una cuenta real**, con los permisos nombrados. Eso es lo que convierte un «no se pudo» en un diseño defendible.

### 9.2 Encabezado a agregar arriba de este documento

```markdown
> **RESULTADO (fecha): el camino MQTT/WSS no es viable en el Learner Lab.**
> El spike de §2 falló en el paso 1.<N>: `<comando>` devolvió
> `<error literal>`. El feed en vivo sigue siendo el WebSocket de la API
> (`packages/api/src/live.ts`), que cumple la función y el requisito de <5 s p95
> pero no es la «suscripción MQTT sobre WebSockets» que promete la propuesta.
> El diseño de las secciones 3 a 8 está completo y es correcto: queda como plan
> ejecutable en una cuenta AWS con permisos plenos (§9.4).
```

### 9.3 Texto exacto para `docs/features-faltantes-propuesta.md:19`

Reemplazar la última oración de la celda («y la suscripción MQTT sobre WebSockets: el feed en vivo es un WebSocket propio de la API que consulta DynamoDB cada 3 s. Esto último cumple la función, pero no es lo que dice la propuesta.») por:

```markdown
y **la suscripción MQTT sobre WebSockets**: el feed en vivo sigue siendo un
WebSocket propio de la API que consulta DynamoDB cada 3 s (`LIVE_POLL_MS`).
Cumple la función y el requisito de <5 s p95, pero no es lo que dice la
propuesta. El camino correcto está diseñado en
[`plan-mqtt-websockets.md`](plan-mqtt-websockets.md) — custom authorizer de IoT
Core que valida el JWT propio y devuelve un policy document acotado a las
unidades del `client_id` — y **no es implementable en el Learner Lab**: el
spike de permisos (§2 de ese documento) demostró que `<iot:CreateAuthorizer |
lambda:AddPermission para iot.amazonaws.com>` está denegado. Desde el navegador
no hay alternativa: el `WebSocket` del navegador no puede mandar headers, así
que las credenciales sólo entran por query params del `GET /mqtt`, y las otras
dos vías quedan descartadas por diseño — una URL WSS presignada con SigV4
heredaría los permisos de `LabRole` y daría a cualquier usuario acceso a los
tópicos de **todos** los clientes (rompe el alcance por `client_id`), y Cognito
Identity Pools no está entre los servicios del Lab. En una cuenta AWS con
permisos plenos el plan se ejecuta tal cual está escrito.
```

Y en la lista de prioridades, agregar como ítem 6: `~~Suscripción MQTT sobre WebSockets.~~ **Diseñada y bloqueada por el Learner Lab**: ver plan-mqtt-websockets.md §2 y §9.`

### 9.4 Texto para el README (sección «Pendiente (fases siguientes)», `README.md:550`)

```markdown
- **Suscripción MQTT sobre WebSockets desde el dashboard.** La propuesta formal
  promete que el navegador se suscribe directo a IoT Core. Hoy el feed en vivo
  es el WebSocket `/live` de la API, que consulta DynamoDB cada 3 s: cumple la
  función y el requisito de <5 s p95, con la diferencia de que la latencia es de
  hasta 3 s en vez de milisegundos y de que cada unidad suscripta cuesta una
  Query a DynamoDB cada 3 s.
  El diseño del camino correcto está en
  [`docs/plan-mqtt-websockets.md`](docs/plan-mqtt-websockets.md) y **está
  bloqueado por el Learner Lab**, no por falta de diseño. Lo que haría falta en
  una cuenta AWS con permisos plenos es exactamente esto:
  - `iot:CreateAuthorizer`, `iot:UpdateAuthorizer`, `iot:DescribeAuthorizer`,
    `iot:DeleteAuthorizer` y `iot:ListAuthorizers` sobre
    `arn:aws:iot:<region>:<cuenta>:authorizer/*`;
  - `lambda:AddPermission` / `lambda:RemovePermission` sobre la función del
    authorizer, para el principal de servicio `iot.amazonaws.com`;
  - una Lambda `snowball-iot-authorizer` con `JWT_SECRET` y acceso de lectura a
    `snowball-units` (la cubre `LabRole`);
  - un `aws_iot_authorizer` con `signing_disabled = true` (el navegador no puede
    firmar el token sin exponer la clave privada) y `token_key_name = "token"`.
  Nada de esto necesita servicios que el Lab no tenga: es sólo el plano de
  control de los authorizers de IoT.
```

### 9.5 Lo que el plan B **sí** deja ganado

- El análisis de por qué SigV4 presignado es inseguro con `LabRole` (§3, alternativa A) es un argumento de defensa reutilizable: muestra que la decisión de no implementar fue **de seguridad**, no de pereza.
- El mapeo tópico→`unit_id` y la distinción `topicfilter`/`topic` (§5.2) quedan documentados para quien retome.
- La medición del costo de bundle (§6.6) es el dato que justifica no haber agregado la dependencia.
- El hallazgo de inmutabilidad de `signing_disabled` y la deriva silenciosa del provider (§3) es una trampa real documentada.

---

## 10. Solapamiento con otros planes

El plan del mapa de unidades (F5-A, `docs/plan-mapa-unidades.md`) y este tocan **los mismos dos archivos**. Reparto exacto:

| Archivo | Qué necesita **este** plan | Qué necesita el plan del mapa | Conflicto |
|---|---|---|---|
| `packages/dashboard/src/App.tsx` | `:48` (`history` a `Telemetry[]`), `:68` (firma de `onReading`), `:78` (`connectLive` → `connectLiveFeed`). **No toca** el badge de `:117-119` ni el JSX | una sección nueva de JSX con el mapa, y `selected`/`setSelected` (`:49`, `:133`) para la selección cruzada tarjeta↔marcador | **Sí, pero disjunto por líneas.** Este plan toca el bloque de estado y efectos (`:45-80`); el mapa toca el render (`:113-164`) y lee `selected`. Secuencial es más seguro; en paralelo con este reparto también sale |
| `packages/dashboard/src/api.ts` | `:117` y `:130` (`IngestedReading` → `Telemetry`), y un export nuevo de `connectLiveFeed`. `connectLive` **se conserva entera** | probablemente nada: los datos del mapa salen de `fetchUnits()` (`:95`), que no se toca | **No, en la práctica** |
| `packages/dashboard/src/UnitCard.tsx` | `:1`, `:8` (`history: Telemetry[]`) | posiblemente el `onSelect` o el resaltado | **Sí, menor.** Dos líneas de tipos contra cambios de presentación |
| `packages/dashboard/package.json` | `+mqtt` | `+leaflet` (y quizá `react-leaflet@4`) | **Sí, en `dependencies` y en `package-lock.json`.** Dos agentes editando el lock a la vez es conflicto garantizado |
| `packages/dashboard/src/status.ts` | sólo lectura (`readingStatus`) | sólo lectura (`readingStatus`) | **No** |
| `.github/workflows/terraform.yml:164-170` | `VITE_IOT_ENDPOINT`, `VITE_IOT_AUTHORIZER_NAME` | nada | con el plan de la réplica (F5-B), que **sí** toca ese paso para el segundo bucket → **conflicto con F5-B, no con el mapa** |

**Orden sugerido:** mapa primero (toca el render, que es la parte voluminosa), después MQTT (toca el estado y los efectos, más quirúrgico). Si van en paralelo, el agente del mapa es el **único dueño** de `packages/dashboard/package.json` y del lock, y aplica la línea de `mqtt` de este plan de paso.

**Terraform:** este plan toca `locals.tf`, `variables.tf`, `outputs.tf`, `modules/iot-ingest/*`. El plan de la réplica toca `main.tf`, `providers.tf`, `bootstrap-buckets.sh` y el workflow. Solapan en `variables.tf` y `outputs.tf` (agregados en archivos distintos del mismo archivo → conflicto de merge trivial) y en `terraform.yml:164-170` (**conflicto real**: los dos editan el mismo bloque `run`). Ese paso lo tiene que escribir **un solo** agente.

**Nada de este plan toca** `packages/alert-processor`, `packages/telemetry-export`, `packages/simulator`, `scripts/` ni `terraform/modules/{network,data,messaging,compute}`.

---

## 11. Tests nuevos

Todo lo decisorio es una función pura. Ni DOM, ni red, ni AWS, ni `jsdom` (que el repo no tiene).

### `packages/api/test/iot-auth-policy.test.ts` (nuevo)

1. operador con 2 unidades → 1 documento con los 3 statements; los ARN de `Subscribe` llevan `topicfilter/` y los de `Receive` `topic/` (**el caso que atrapa el error clásico**);
2. `iot:Connect` apunta a `client/dashboard-<userId>-*` y **no** a un client id concreto;
3. `allUnits: true` (admin) → un solo statement con `snowball/*/telemetry` y **ninguna** lista explícita;
4. 40 unidades → se parte en varios documentos, cada uno con `JSON.stringify(doc).length <= 2048`, y el `iot:Connect` aparece **una sola vez** (en el primero);
5. 500 unidades → tira un error explícito en vez de devolver una policy truncada;
6. `principalIdOf` cumple `/^[a-zA-Z0-9]{1,128}$/` (el patrón que la doc exige) para `userId` de 1 y de 9 dígitos;
7. `clampDisconnectSeconds`: token con 7 h de vida → 25 200; con 2 min → **300** (el piso); con 30 h → **86 400** (el techo); token ya vencido → 300;
8. usuario sin unidades → documento con sólo `iot:Connect`, `isAuthenticated: true`;
9. `denied()` devuelve `isAuthenticated: false` y **no** filtra ningún ARN.

### `packages/api/test/iot-auth-handler.test.ts` (nuevo)

Fake de DynamoDB en el estilo de `packages/alert-processor/test/fake-aws.ts:133-144` (inyectado con `vi.mock('@aws-sdk/lib-dynamodb', ...)`), y un JWT firmado de verdad con `signToken` (`packages/api/src/auth/jwt.ts:19-33`) y un secreto de test de ≥32 caracteres. **Cero red.**

1. token válido de operador → `isAuthenticated: true` y sólo las unidades de su `client_id`;
2. token válido de admin → rama `allUnits`, **sin** ninguna query de unidades;
3. token con firma inválida → `isAuthenticated: false`;
4. token vencido (`nowSeconds` inyectado) → `isAuthenticated: false`;
5. token con la invariante rota (operador con `client_id: null`) → `false`, **vía `assertClientInvariant`**, sin reimplementar el chequeo;
6. evento **sin** `token` pero con `protocolData.http.queryString = '?x-amz-customauthorizer-name=snowball-dashboard&token=<jwt>'` → el fallback de `tokenFromEvent` lo encuentra y autentica (el camino real del navegador);
7. evento sin token en ningún lado → `false`;
8. la región y la cuenta de los ARN salen de `context.invokedFunctionArn`, no de variables de entorno;
9. **el handler no loguea nunca el token:** se espía `console.log`/`console.error` y se afirma que ninguna llamada contiene el JWT ni la query string. Es un test de seguridad, no de comportamiento;
10. si la query de unidades falla → `isAuthenticated: false` (fail closed), no una excepción sin atrapar.

### `packages/dashboard/test/iot.test.ts` (nuevo)

1. `telemetryTopicFilter('SB-001')` → `'snowball/SB-001/telemetry'`, y coincide con lo que produce `telemetryTopic` de `packages/shared/src/config.ts:96-98` (se escribe el valor literal esperado, porque el dashboard no puede importar runtime de shared);
2. `unitIdFromTopic`: `'snowball/SB-001/telemetry'` → `'SB-001'`; `'snowball/SB-001/shadow'` → `null`; `'otra/cosa'` → `null`; `'snowball//telemetry'` → `null`; `'snowball/a/b/telemetry'` → `null`;
3. `normalizeTelemetry`: payload completo del simulador → `Telemetry` válido; payload **sin** `unit_id` → usa el del tópico; payload con un `unit_id` **distinto** al del tópico → **gana el tópico** (es la garantía de IoT); `temp_c` como string → `null`; `ts` ausente → `null`; JSON no-objeto → `null`;
4. `buildIotWsUrl`: produce `wss://<endpoint>/mqtt?...`, los dos parámetros van URL-encodeados, y **no** aparece ningún parámetro llamado `clientId` (por `mqtt/build/lib/connect/index.js:76-77`);
5. `mqttClientId(42, 'ab12cd34')` → `'dashboard-42-ab12cd34'`, y matchea el wildcard `dashboard-42-*` que emite `connectResource`;
6. `chunkFilters`: 20 filtros → 3 lotes de ≤8 (la cuota de IoT); 0 filtros → `[]`.

### `packages/dashboard/test/live-feed.test.ts` (nuevo)

La máquina de §6.5 como reducer puro, sin timers ni sockets:

1. `mqtt-init` + `connected` → `mqtt-live`;
2. `mqtt-init` + `timeout` → `api-fallback`;
3. `mqtt-init` + 5 `closed` → `api-fallback`; con 4, sigue en `mqtt-init`;
4. `mqtt-live` + `closed` → `mqtt-retrying`, **nunca** `api-fallback` (ya se demostró que MQTT funciona);
5. `mqtt-retrying` + `connected` → `mqtt-live`, contador de fallos en 0;
6. cualquier estado + `token-expired` → `unauthorized`, que es **terminal** (ningún evento lo saca);
7. `mqtt-init` + `no-endpoint` → `api-fallback` (el caso de `npm run dashboard` en local).

### Tests existentes que **no** se tocan

`packages/api/test/live.test.ts` y `packages/dashboard/test/api.connectLive.test.ts` quedan intactos: en la opción recomendada `/live` y `connectLive` sobreviven. Esto es un criterio de aceptación por sí mismo (ver §13).

---

## 12. Impacto en CI

El CI son tres gates: `terraform fmt -check -recursive -diff` y `terraform init -backend=false && terraform validate` (job `validate`, `.github/workflows/terraform.yml`), y `npm ci && npm run build && npm test` (job `app`).

| Riesgo | Probabilidad | Mitigación |
|---|---|---|
| **`mqtt` no tipa bajo `moduleResolution: "bundler"`** (`packages/dashboard/tsconfig.json:4`) y `tsc --noEmit` rompe el build (`packages/dashboard/package.json:7`) | **baja, pero es el riesgo nº 1** | Analizado: `exports["."]` de `mqtt` (verificado en el paquete instalado) no tiene condición `types`, y TypeScript no usa la condición `browser`, así que resuelve `default → ./build/index.js` y toma el `./build/index.d.ts` que existe. **Debe confirmarse con un `npm run build -w @snowball/dashboard` real en el primer commit.** Si falla: `"paths": { "mqtt": ["./node_modules/mqtt/build/index.d.ts"] }` en el tsconfig del dashboard — una línea, sin tocar el resto |
| **`mqtt` necesita shims de Node (`process`, `Buffer`, `stream`) bajo Vite** | **muy baja** | Descartado leyendo `node_modules/mqtt/dist/mqtt.esm.js`: `Buffer` viene de un polyfill bundleado (18 `Buffer:` + 2 `exports.Buffer`), `process.nextTick` sólo aparece en un string de log y la llamada real va a un shim interno, y no hay un solo `process.env`. No hace falta tocar `packages/dashboard/vite.config.ts` |
| Aviso de Vite «chunk > 500 kB» | **alta** | Es `warn`, no error. Se mitiga con el `await import('mqtt')` del paso 14 (§6.6), que además mejora el *first paint* |
| `terraform validate` falla por `aws_iot_authorizer` | **muy baja** | El recurso existe en `hashicorp/aws ~> 6.46` (`terraform/versions.tf:4`). `validate` no necesita credenciales |
| `terraform fmt -check` | **media** (es el gate más fácil de romper) | correr `terraform fmt -recursive` antes de commitear |
| El bundle del authorizer rompe `npm run bundle` | **baja** | el script nuevo espeja `bundle:no-signal` (`packages/alert-processor/package.json:13`), con el mismo `--external:@aws-sdk/*` y el mismo fallback `zip || python -m zipfile` |
| `npm ci` cambia el lock y el job `app` se desincroniza del del mapa | **media** si F5-A y F5-C van en paralelo | ver §10: un solo dueño de `packages/dashboard/package.json` y del lock |
| `plan` en el PR muestra recursos nuevos sin que el spike esté verde | **alta si se olvida el flag** | `iot_authorizer_enabled = false` por defecto (paso 7): el plan no crea nada hasta que alguien lo prenda a mano |

**Lo que el CI no puede verificar:** que el authorizer funcione. El job `plan` corre `terraform plan` contra el state real pero nunca aplica, y nada en CI abre una conexión MQTT. Todo eso es §14.

---

## 13. Criterios de aceptación verificables

**Sin credenciales (todo verificable en cualquier máquina):**

1. `npm ci && npm run build && npm test` en verde desde la raíz.
2. `npm run build -w @snowball/dashboard` sin errores de tipo (es lo que confirma el riesgo nº 1 de §12).
3. `terraform fmt -check -recursive -diff` y `terraform -chdir=terraform init -backend=false && terraform -chdir=terraform validate` en verde.
4. `npm run bundle` produce `packages/api/dist/iot-authorizer.zip`, y el zip contiene un solo `index.js`.
5. Los cuatro archivos de test de §11 existen y pasan; **y `packages/api/test/live.test.ts` y `packages/dashboard/test/api.connectLive.test.ts` siguen existiendo y pasando sin modificaciones** (ésta es la prueba de que la opción recomendada no rompió nada).
6. `grep -rn "console\.\(log\|error\|warn\)" packages/api/src/iot-auth/` no imprime ni `event`, ni `queryString`, ni `token`.
7. El tamaño de `packages/dashboard/dist/assets/*.js` queda **anotado en el PR**, con el delta contra los 158 212 B actuales.
8. `grep -rn "from '@snowball/shared'" packages/dashboard/src/` sigue devolviendo sólo `import type` (no se rompió la restricción de §1).

**Con credenciales (§14):**

9. El spike de §2 está **ejecutado y su tabla de resultados completa** en este documento.
10. `aws iot describe-authorizer --authorizer-name snowball-dashboard` devuelve `status: ACTIVE` y `signingDisabled: true`.
11. `aws lambda get-policy --function-name snowball-iot-authorizer` muestra el statement con `"Service": "iot.amazonaws.com"`.
12. El `curl` de upgrade del paso 14.4 devuelve **101**.
13. Con el simulador corriendo, el dashboard muestra el badge «feed en vivo» y el sparkline avanza; `/aws/lambda/snowball-iot-authorizer` tiene invocaciones y **ninguna línea con un JWT**.
14. Un operador del cliente A, con un client id forjado apuntando a una unidad del cliente B, **no recibe** mensajes (la prueba de aislamiento del paso 14.6).

---

## 14. Checklist de verificación manual en AWS

Con credenciales frescas del Learner Lab, en orden. **14.0 es el spike de §2 y es bloqueante.**

```bash
export AWS_REGION=us-east-1
ACCOUNT=$(aws sts get-caller-identity --query Account --output text)
ENDPOINT=$(aws iot describe-endpoint --endpoint-type iot:Data-ATS --query endpointAddress --output text)
```

**14.0 — Spike (§2).** Si da rojo, **frenar acá** y ejecutar §9.

**14.1 — Apply con el authorizer prendido.**
```bash
npm run bundle
terraform -chdir=terraform apply -var iot_authorizer_enabled=true
```

**14.2 — El authorizer existe y está como se espera.**
```bash
aws iot describe-authorizer --authorizer-name snowball-dashboard
# esperado: status=ACTIVE, signingDisabled=true, tokenKeyName=token,
#           authorizerFunctionArn terminando en :function:snowball-iot-authorizer
```

**14.3 — IoT puede invocar la Lambda.**
```bash
aws lambda get-policy --function-name snowball-iot-authorizer \
  --query Policy --output text | python -m json.tool
# esperado: un Statement con Principal.Service = iot.amazonaws.com
```

**14.4 — La Lambda responde bien a un token real.** Sacar un JWT del login:
```bash
ALB=$(terraform -chdir=terraform output -raw alb_dns_name)
TOKEN=$(curl -s -X POST "http://${ALB}/auth/login" -H 'Content-Type: application/json' \
  -d '{"email":"<email del operador>","password":"operator123"}' | python -c 'import sys,json;print(json.load(sys.stdin)["token"])')

aws iot test-invoke-authorizer --authorizer-name snowball-dashboard \
  --token "$TOKEN" \
  --http-context "{\"queryString\":\"?x-amz-customauthorizer-name=snowball-dashboard&token=${TOKEN}\"}"
# esperado: isAuthenticated=true, principalId=u<id>, y policyDocuments con
#   topicfilter/snowball/<unidad>/telemetry  Y  topic/snowball/<unidad>/telemetry
#   SOLO de las unidades del client_id de ese usuario.
# Nota: test-invoke-authorizer devuelve policyDocuments como lista de STRINGS
#       (JSON serializado); la Lambda devuelve objetos y IoT los serializa.
```
Y con un token roto, para ver el camino negativo:
```bash
aws iot test-invoke-authorizer --authorizer-name snowball-dashboard --token "no-es-un-jwt"
# esperado: isAuthenticated=false
```

**14.5 — El handshake WebSocket real llega a 101.**
```bash
curl -i -s -o /dev/null -w 'HTTP %{http_code}\n' \
  "https://${ENDPOINT}/mqtt?x-amz-customauthorizer-name=snowball-dashboard&token=${TOKEN}" \
  -H "Connection: Upgrade" -H "Upgrade: websocket" \
  -H "Sec-WebSocket-Version: 13" \
  -H "Sec-WebSocket-Key: $(openssl rand -base64 16)" \
  -H "Sec-WebSocket-Protocol: mqtt"
# 101 = el authorizer aceptó y el upgrade se concretó.
# 401/403 = rechazo; mirar /aws/lambda/snowball-iot-authorizer para saber por qué.
```
(El `Sec-WebSocket-Protocol: mqtt` es obligatorio: es el header que la doc de AWS muestra en el `GET /mqtt` y el que `mqtt.js` manda solo en el navegador, `node_modules/mqtt/build/lib/connect/ws.js:101`.)

**14.6 — Aislamiento entre clientes (la prueba de seguridad).** Con un token de un operador del cliente A, suscribirse al tópico de una unidad del cliente B:
```bash
node -e "
const mqtt=require('mqtt');
const t=process.env.TOKEN, e=process.env.ENDPOINT;
const url='wss://'+e+'/mqtt?x-amz-customauthorizer-name=snowball-dashboard&token='+encodeURIComponent(t);
const c=mqtt.connect(url,{clientId:'dashboard-1-probe001',protocolVersion:5,reconnectPeriod:0});
c.on('connect',()=>c.subscribe('snowball/<UNIDAD-DEL-CLIENTE-B>/telemetry',(err,g)=>{console.log('suback',err,JSON.stringify(g));setTimeout(()=>{c.end();process.exit(0)},5000)}));
c.on('message',(top)=>console.log('*** FUGA ***',top));
c.on('error',(err)=>console.log('error',err.message));
"
# esperado: el SUBACK puede llegar con reason code de rechazo, y sobre todo
#   NO tiene que imprimirse ninguna línea "*** FUGA ***".
# Si imprime una, el policy document está mal: PARAR Y REVISAR §5.
```
Repetirlo con una unidad **propia** del cliente A: ahí **sí** tienen que llegar mensajes (con el simulador corriendo). Es la prueba de que `iot:Receive` está bien puesto.

**14.7 — Extremo a extremo en el dashboard.**
```bash
npm run simulator -- --endpoint "$ENDPOINT" --units SB-001,SB-002 --interval 5
```
Abrir el dashboard publicado, loguearse, y verificar: badge «feed en vivo», el sparkline avanzando cada ~5 s (no cada 3 s en bloques, que es la huella del polling), y en DevTools → Network → WS una conexión a `${ENDPOINT}` y **no** al ALB (eso confirma que está andando MQTT y no el fallback).

**14.8 — El fallback funciona.** Poner `iot_authorizer_enabled=false`, re-aplicar, recompilar y republicar el dashboard; el badge tiene que seguir en «feed en vivo», ahora con el WebSocket contra el ALB. Esto valida que el camino de degradación de §6.5 no es teórico.

**14.9 — Refresh y expiración.** Dejar el dashboard abierto >5 minutos y confirmar en `/aws/lambda/snowball-iot-authorizer` una invocación nueva (el `refreshAfterInSeconds = 300`). Para la expiración, lo práctico es emitir un token de vida corta con `signToken` y un `nowSeconds` corrido, y comprobar que al expirar la conexión se corta y el dashboard vuelve al login en vez de reintentar para siempre.

**14.10 — Higiene de logs.**
```bash
aws logs filter-log-events --log-group-name /aws/lambda/snowball-iot-authorizer \
  --filter-pattern '"eyJ"' --max-items 5
# esperado: events vacío. "eyJ" es el prefijo de todo header JWT en base64url.
```

---

## 15. Seguridad

### 15.1 El JWT en la query string

**Es inevitable desde el navegador.** La API `WebSocket` del navegador acepta sólo URL y subprotocolos: no hay forma de mandar un header `Authorization`. Es exactamente la misma razón por la que `/live` ya lo hace hoy (`packages/dashboard/src/api.ts:126` → `packages/api/src/live.ts:110`). Lo que cambia es **a quién** se le entrega el token: antes a la API propia, ahora a IoT Core.

Exposiciones, una por una:

| Dónde | Riesgo | Veredicto |
|---|---|---|
| En el cable | ninguno: `wss://` es TLS, la query va cifrada en el request HTTP | sin cambios respecto de hoy |
| Barra de direcciones / historial / `Referer` | ninguno: la URL del WebSocket nunca navega | sin cambios |
| DevTools → Network del usuario | visible | sin cambios; es la sesión del propio usuario |
| **CloudWatch Logs de la Lambda del authorizer** | **riesgo nuevo y real**: el token llega en `event.token` **y** en `protocolData.http.queryString`. Un `console.log(event)` de depuración lo deja escrito en texto plano, con 14 días de retención (`terraform/modules/lambda-function/main.tf:3-6`) | **mitigado por diseño**: §7 paso 5 lo prohíbe, §11 caso 9 lo testea, §13 criterio 6 lo grepea y §14.10 lo verifica en AWS |
| Logs de IoT Core | el repo **no configura** logging de IoT (no hay `aws_iot_logging_options` en `terraform/`; el único log group es el `error_action` de la regla, `modules/iot-ingest/main.tf:55-58`, y ése sólo recibe fallos de la regla, no handshakes). Con el logging V2 apagado, IoT no escribe nada del handshake en CloudWatch | **aceptable hoy**. La doc de AWS no especifica si el logging V2 incluiría la query string; **si alguien lo prende, hay que revisarlo.** Dejarlo escrito así, sin afirmar lo que no está documentado |

**Por qué se acepta:** la exposición es la misma que hoy en el único vector que importaba (la query string en tránsito y en DevTools), y la única exposición nueva —los logs de la Lambda— está bajo control total del código propio y tiene un test que lo custodia. El TTL del token es de 8 h (`packages/api/src/auth/jwt.ts:7`) y, por primera vez, con `refreshAfterInSeconds = 300` **una revocación tiene efecto en ≤5 minutos**, contra las hasta 8 h de hoy (`README.md:544-549`). En balance, el camino MQTT es **más** seguro que el feed actual en el punto que más duele.

### 15.2 El `JWT_SECRET` en la Lambda del authorizer

La Lambda necesita el secreto para verificar las firmas. Camino propuesto: variable de entorno, desde `var.jwt_secret` (ya `sensitive = true`, `terraform/variables.tf:52-56`), vía la entrada de `local.lambdas` del paso 8 y el `environment` del módulo (`terraform/modules/lambda-function/main.tf:16-18`).

**¿Es coherente con cómo el repo maneja secretos hoy?** Sí, y de hecho es una mejora. Hoy el mismo secreto viaja a la API **en el user data del launch template en texto plano**: `terraform/main.tf:134` → `terraform/modules/compute/main.tf:66` → `terraform/modules/compute/user-data.sh.tftpl:9`. El user data es legible con `ec2:DescribeLaunchTemplateVersions`. Una variable de entorno de Lambda es legible con `lambda:GetFunctionConfiguration` y está cifrada en reposo con la clave gestionada por AWS. **Mismo nivel de exposición, no peor.** En CI el secreto ya entra como `TF_VAR_jwt_secret: ${{ secrets.JWT_SECRET }}` (`.github/workflows/terraform.yml`), así que no hace falta ninguna variable nueva en el workflow.

Dos cosas que hay que decir y no hacer:
- **No se mitiga más que eso.** Lo correcto sería SSM Parameter Store `SecureString` o Secrets Manager, leído en el cold start. Es un cambio transversal (afectaría también a la API en EC2) y está **fuera de alcance**. Queda anotado.
- **El secreto se replica en un lugar más.** Antes vivía en un sitio (user data); ahora en dos. No cambia la superficie cualitativamente, pero sí hay que acordarse: **si se rota el `JWT_SECRET`, hay que recrear la Lambda además de refrescar las instancias.** Vale un comentario en el recurso.

---

## 16. Decisiones que son del usuario

1. **Reemplazar el feed actual, o dejar los dos.** Recomendación: **los dos, con fallback automático** (§8). El argumento decisivo no es la elegancia sino el *backlog*: MQTT no recupera lo que pasó mientras el navegador estaba desconectado, y el polling sí.
2. **Cuánta complejidad se acepta, sabiendo que el feed de hoy funciona.** El precio concreto: ~800 líneas nuevas entre código y tests, una dependencia de ~110 kB gzip en el bundle del navegador, una Lambda más, un recurso de IoT más, y un segundo camino de datos que hay que mantener. La ganancia concreta: cumplir lo que la propuesta promete, latencia de ms en vez de ≤3 s, cero lecturas de DynamoDB por el feed, y revocación efectiva en ≤5 min. **Si la respuesta es «no vale la pena», el plan B de §9 es una entrega perfectamente defendible** — y como el spike es lo primero, se puede decidir *después* de saber si siquiera es posible.
3. **Si se avanza con el camino MQTT antes de que el spike dé verde.** **No se debería**, y el plan lo bloquea estructuralmente: `iot_authorizer_enabled = false` por defecto (§7 paso 7). Implementar primero y spikear después significa arriesgar ~800 líneas contra un `AccessDeniedException`.
4. **Si el aviso de chunk >500 kB de Vite se silencia o se resuelve** con el `await import('mqtt')` del paso 14 (§6.6). Recomendación: resolverlo, no silenciarlo — mejora el *first paint* de la pantalla de login.

---

## 17. Fuera de alcance

Umbrales por Device Shadow, replicación multi-región del backend, medición formal de latencias, HTTPS de punta a punta, autoescalado de la API. El mapa de unidades (F5-A) y la réplica del sitio estático (F5-B) tienen sus propios planes; §10 detalla el solapamiento de archivos. Tampoco entran: `aws_iot_logging_options`, mover el `JWT_SECRET` a SSM/Secrets Manager, el `republish` por cliente de §5.3, y la publicación de alertas por MQTT al dashboard (hoy las alertas se refrescan por HTTP cada 30 s, `packages/dashboard/src/App.tsx:13`, `:61-66`, y eso no cambia).

---

## Fuentes consultadas en esta sesión (para las afirmaciones que no salen del repo)

- [Defining your Lambda function](https://docs.aws.amazon.com/iot/latest/developerguide/custom-auth-lambda.html) — shape del evento y de la respuesta; 10 documentos × 2 048 caracteres; `principalId` `([a-zA-Z0-9]){1,128}`; `disconnectAfterInSeconds`/`refreshAfterInSeconds` 300-86 400.
- [Connecting to AWS IoT Core by using custom authentication](https://docs.aws.amazon.com/iot/latest/developerguide/custom-auth.html) — `GET /mqtt`, `sec-websocket-protocol: mqtt`, credenciales por headers **o query parameters**, recomendación de URL-encodear.
- [Understanding the custom authentication workflow](https://docs.aws.amazon.com/iot/latest/developerguide/custom-authorizer.html) — selección del authorizer, timeout de 5 s, retraso de hasta 5 min en conexiones ociosas.
- [Creating and managing custom authorizers (CLI)](https://docs.aws.amazon.com/iot/latest/developerguide/config-custom-auth.html) y [Managing custom authorizers](https://docs.aws.amazon.com/iot/latest/developerguide/custom-auth-manage.html) — componentes del authorizer; **«You can't update an authorizer's signing requirement»**; semántica de `SetDefaultAuthorizer`.
- [Authorizing AWS IoT to invoke your Lambda function](https://docs.aws.amazon.com/iot/latest/developerguide/custom-auth-authorize.html) — el `aws lambda add-permission` exacto y el error de `AccessDeniedException`.
- [`UpdateAuthorizer`](https://docs.aws.amazon.com/iot/latest/apireference/API_UpdateAuthorizer.html) y [`DeleteAuthorizer`](https://docs.aws.amazon.com/iot/latest/apireference/API_DeleteAuthorizer.html) — `signingDisabled` ausente del update; `DeleteConflictException`.
- [AWS IoT Core policies](https://docs.aws.amazon.com/iot/latest/developerguide/iot-policies.html), [policy variables](https://docs.aws.amazon.com/iot/latest/developerguide/iot-policy-variables.html) y [action resources](https://docs.aws.amazon.com/iot/latest/developerguide/iot-action-resources.html) — unión de allows con lógica IAM; `*` es comodín y `+`/`#` son literales; `client/` para Connect, `topicfilter/` para Subscribe, `topic/` para Receive.
- [AWS IoT Core endpoints and quotas](https://docs.aws.amazon.com/general/latest/gr/iot-core.html) — 8 suscripciones por SUBSCRIBE, 50 por conexión, 24 h de duración máxima de WebSocket, 100/32 authorizers.
- [`aws iot test-invoke-authorizer`](https://docs.aws.amazon.com/cli/latest/reference/iot/test-invoke-authorizer.html) — opciones y shape de `--http-context`.
- [`aws_iot_authorizer`](https://github.com/hashicorp/terraform-provider-aws/blob/main/website/docs/r/iot_authorizer.html.markdown) y el schema del provider (`internal/service/iot/authorizer.go`) — argumentos y **ausencia de `ForceNew`**.
- [`mqtt` en npm](https://registry.npmjs.org/mqtt/latest) — `latest` = 5.16.1; mapa de `exports` con la condición `browser`.
- Paquete instalado `node_modules/mqtt@5.15.2` — `dist/mqtt.esm.js` (369 206 B, 111 099 B gzip), subprotocolo `mqtt` en `build/lib/connect/ws.js:92-101`, preservación de la query en `build/lib/connect/index.js:47-60` y la trampa de `clientId` en `:76-77`.
- `node_modules/@types/aws-lambda@8.10.164/trigger/iot-authorizer.d.ts` — tipos `IoTCustomAuthorizerEvent` / `IoTCustomAuthorizerResult`, coincidentes con la doc.
