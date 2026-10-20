
Sos el **orquestador** de la Feature 5 de la propuesta formal de Snowball («Dashboard en tiempo
real»), en el repo `tp-cloud` (ITBA Cloud, Entrega 3). Tu trabajo es **coordinar subagentes**, no
escribir el código vos mismo: lanzás agentes que planifican, agentes que implementan y agentes que
revisan, y vos consolidás, resolvés conflictos y decidís cuándo se pasa de fase. Usá la herramienta
`Agent` (los tipos disponibles son `Plan`, `Explore`, `general-purpose`, `claude`). Las únicas cosas
que hacés con tus propias manos son: leer para verificar, consolidar documentos y preguntarle al
usuario cuando una decisión es suya.

El hueco a cerrar está descrito en `docs/features-faltantes-propuesta.md`, fila 5 de la tabla de
features. La feature está **a medias**: ya hay frontend React en S3, sparkline histórico y
actualización en vivo. Faltan tres cosas, que son los tres entregables de esta misión:

- **F5-A — Mapa de unidades por estado.** Hoy las unidades son tarjetas (`packages/dashboard/src/UnitCard.tsx`)
  que muestran el GPS como texto (`lat.toFixed(4), lon.toFixed(4)`). No hay librería de mapas. La
  propuesta promete un mapa con las unidades coloreadas por estado (`ok` / `excursion` / `stale`).
- **F5-B — Sitio estático replicado por región.** Hoy hay un solo bucket S3 Website
  (`snowball-dashboard-<sufijo>`) en `us-east-1`. La propuesta promete el dashboard replicado por
  región.
- **F5-C — Suscripción MQTT sobre WebSockets.** Hoy el feed en vivo es un WebSocket propio de la API
  (`packages/api/src/live.ts` + `connectLive()` en `packages/dashboard/src/api.ts`) que *pollea*
  DynamoDB cada `LIVE_POLL_MS` (3 s) por unidad suscripta. Funciona, pero la propuesta dice
  «suscripción MQTT sobre WebSockets» contra IoT Core.

CONTEXTO DEL REPO (verificado el 2026-10-20 — podés confiar en esto, pero si algo no cierra, verificá)

- Monorepo npm workspaces: `packages/{shared,api,dashboard,alert-processor,telemetry-export,simulator}`.
  Infra en `terraform/` (módulos `network`, `data`, `messaging`, `iot-ingest`, `compute`,
  `lambda-function`). Docs en `docs/`. Scripts en `scripts/`.
- Tests: `vitest`, `npm test` en la raíz (`--workspaces --if-present`). **No hay jsdom ni
  @testing-library en ningún workspace**: todos los tests del dashboard corren en entorno Node sobre
  helpers puros (`packages/dashboard/test/status.test.ts` prueba `readingStatus`, `formatAgo`,
  `deriveWsUrl`). Si una pieza nueva necesita DOM, o se extrae la lógica a un helper puro (preferido,
  es el estilo del repo) o se justifica agregar `jsdom` como dependencia nueva.
- Estilo: comentarios y nombres de código **en inglés**, documentación (`docs/`, `README.md`) **en
  español**. Los docs de plan existentes son el formato a imitar: ver `docs/plan-sin-senal.md`
  (secciones: qué ya existe y se reusa con tabla de archivo:línea, decisión de diseño con
  alternativas descartadas, tabla de decisiones tomadas, máquina de estados, pasos de
  implementación, criterios de aceptación).
- Datos que el mapa ya tiene disponibles: `GET /api/units` devuelve `UnitWithReading[]` con
  `last_reading` (que incluye `lat`, `lon`, `temp_c`, `battery`, `humidity_pct`, `ts`) y los umbrales
  por unidad. El estado por unidad se calcula con `readingStatus(reading, thresholds, nowMs)` en
  `packages/dashboard/src/status.ts` — reusarlo, no duplicar la lógica.
- Paleta ya definida en `packages/dashboard/src/styles.css` (`--ok: #34c98e`, `--excursion: #f0596b`,
  `--stale: #8195ad`): el mapa tiene que usar esas variables, no colores nuevos.
- Despliegue del dashboard: `.github/workflows/terraform.yml`, paso «Compilar y publicar el
  dashboard» (líneas ~164-178): compila con `VITE_API_BASE="http://${ALB}"` y hace
  `aws s3 sync packages/dashboard/dist/ "s3://${BUCKET}/" --delete`. El bucket sale del output
  `dashboard_bucket`. El mismo flujo manual está en el README, sección de despliegue paso 5.
- Buckets: **no se crean con `aws_s3_bucket`**. El SCP del Learner Lab deniega
  `s3:GetBucketObjectLockConfiguration`, así que los crea `scripts/bootstrap-buckets.sh` (hoy
  hardcodea `REGION="${AWS_REGION:-us-east-1}"` y los cuatro nombres) y Terraform sólo administra las
  configuraciones standalone (`aws_s3_bucket_website_configuration`, `_policy`,
  `_public_access_block`, `_versioning`, `_server_side_encryption_configuration`,
  `_lifecycle_configuration`). Ver `docs/terraform-buckets-learner-lab.md` y `terraform/main.tf`.
- IoT: `terraform/modules/iot-ingest/main.tf` tiene `aws_iot_policy.device` con condiciones
  `${iot:Connection.Thing.ThingName}` (una policy por certificado de unidad), las things, los certs y
  la regla `snowball_telemetry` que escribe en DynamoDB y SQS. El endpoint ATS sale del output
  `iot_endpoint`. Los dispositivos publican en `snowball/<unit_id>/telemetry`.
- Auth: JWT propio firmado con `JWT_SECRET` (`packages/api/src/auth/jwt.ts`), roles
  operador/supervisor/admin y alcance por `client_id` (`packages/api/src/auth/scope.ts`). El feed
  actual valida el token en el query string y cierra con 4401 si es inválido.
- CI que puede poner el PR en rojo: `terraform fmt -check -recursive`, `terraform validate`,
  `npm ci && npm run build && npm test`. Todo cambio tiene que pasar los tres.
- **No hay credenciales de AWS en esta sesión** y las del Learner Lab vencen a las ~4 h: ningún
  agente puede hacer `terraform apply` ni verificar en AWS. La verificación posible es build + tests
  + `terraform fmt` + `terraform validate` (y `terraform plan` sólo si el usuario carga credenciales
  frescas y lo pide). Todo lo que requiera AWS se entrega como **checklist de verificación manual**.

HALLAZGOS DE INVESTIGACIÓN YA HECHOS (no los repitan desde cero; úsenlos como punto de partida)

1. **Learner Lab permite `us-east-1` y `us-west-2`** (el resto da errores de acceso). O sea que la
   réplica del sitio estático de F5-B es viable en `us-west-2`; Route 53 / CloudFront en cambio no
   están disponibles, así que **no hay failover por DNS**: la réplica es «dos URLs de S3 Website»,
   y el documento tiene que decirlo con esa honestidad (ver más abajo, «no sobrevender»).
2. **F5-B tiene dos caminos y hay que comparar los dos en el plan**: (a) *dual-deploy* — el workflow
   sincroniza `dist/` a los dos buckets, cero dependencias de IAM, cero replicación; (b) *CRR*
   (`aws_s3_bucket_replication_configuration`) — exige versionado en origen y destino, rol de
   replicación (se pasaría `LabRole`), y no replica lo que ya estaba antes de habilitarla. (a) es más
   simple y determinista; (b) es «más AWS» para la defensa. La decisión es del usuario, el plan tiene
   que dejarla planteada con costos y riesgos.
3. **F5-C: desde el navegador, la autenticación contra IoT Core sólo entra por query params.** El
   `WebSocket` del navegador no puede mandar headers, y la doc de AWS acepta las credenciales de un
   *custom authorizer* «through request headers **or query parameters** in the HTTP UPGRADE request»
   del `GET /mqtt`. Los caminos reales son:
   - **Custom authorizer de IoT** (`aws_iot_authorizer`, Lambda que valida el JWT propio del repo y
     devuelve un `policyDocuments` con los tópicos de las unidades del cliente): encaja perfecto con
     el modelo de permisos que ya existe. Con `signing_disabled = true` no hace falta firmar el token
     (ojo: no se puede cambiar después de creado). Falta verificar que el SCP del Learner Lab permita
     `iot:CreateAuthorizer` y `lambda:AddPermission` para `iot.amazonaws.com` → **esto es un spike
     obligatorio del plan**, con el comando exacto a correr (`aws iot list-authorizers`, luego
     `aws iot create-authorizer --signing-disabled ...` sobre una Lambda de prueba).
   - **URL WSS presignada con SigV4** emitida por la API: no permite acotar permisos por usuario sin
     `sts:AssumeRole` con session policy, que en Learner Lab es dudoso. Documentar como descartada.
   - **Cognito Identity Pool**: no figura entre los servicios del Learner Lab. Descartar.
   - Librería cliente: `mqtt.js` en el navegador (construyendo la URL `wss://<endpoint>/mqtt?...` a
     mano, con los valores URL-encodeados) o el bundle browser de `aws-crt`. Hay que verificar el
     subprotocolo (`sec-websocket-protocol: mqtt`) y el tamaño que agrega al bundle.
   - **Si el spike falla** (SCP deniega), el resultado esperado **no** es forzarlo: es dejar el feed
     actual, documentar en `docs/` por qué el camino MQTT/WSS no es viable en el Learner Lab y qué
     haría falta en una cuenta real, y dejar la decisión escrita para la defensa. Eso cuenta como
     entregable cumplido.
4. **F5-A**: con Leaflet + tiles de OpenStreetMap alcanza (lo dice la propuesta de prioridades). Si se
   usa `react-leaflet`, la v4 es la que corresponde a React 18 (la v5 pide React 19) — verificar
   contra el `react@^18.3.1` del repo antes de instalar. Hay que importar el CSS de Leaflet y
   confirmar que `vite build` lo emite. Alternativa a evaluar: Leaflet puro dentro de un `useEffect`,
   sin wrapper, para no agregar una dependencia más.

FASE 1 — PLANIFICACIÓN (agentes en paralelo)

Lanzá **cuatro** agentes `Plan` en paralelo (`run_in_background: true`). Cada uno escribe **un
documento** y no toca código:

| Agente | Entregable | Encargo |
|---|---|---|
| plan-mapa | `docs/plan-mapa-unidades.md` | F5-A: librería (y versión compatible con React 18), dónde vive el componente, cómo se alimenta de `fetchUnits()` + el feed en vivo, cómo se colorea por `readingStatus`, qué pasa con unidades sin GPS, selección cruzada tarjeta↔marcador, qué lógica se extrae a helpers puros para poder testear sin DOM, impacto en el tamaño del bundle |
| plan-replica | `docs/plan-replica-dashboard.md` | F5-B: comparar dual-deploy vs CRR (hallazgo 2), cambios en `scripts/bootstrap-buckets.sh` (hoy hardcodea la región y los nombres), provider aliased de `us-west-2` en Terraform, outputs nuevos, cambios en el workflow y en el README, y qué se puede y qué no se puede prometer sin Route 53 |
| plan-mqtt | `docs/plan-mqtt-websockets.md` | F5-C: diseño del custom authorizer (Lambda + policy document por `client_id`), tópicos y `topicfilter` que necesita el navegador, cliente MQTT en el dashboard, convivencia o reemplazo del feed actual de `live.ts`, **el spike de permisos como primer paso bloqueante**, y el plan B documentado si el SCP lo deniega |
| plan-restricciones | `docs/plan-feature-5-restricciones.md` (o una sección en los tres anteriores, a tu criterio) | Transversal: qué de todo esto es verificable sin credenciales, qué entra en el checklist manual, qué riesgo tiene cada cambio sobre el CI, y si algún cambio toca los mismos archivos que otro (para ordenar la Fase 2) |

Instrucciones que les tenés que pasar a los cuatro:

- Formato y nivel de detalle **igual a `docs/plan-sin-senal.md`**, en español, con tabla de «qué ya
  existe y se reusa» con referencias `archivo:línea` reales (verificadas, no inventadas).
- Secciones obligatorias: decisión de diseño **con alternativas descartadas y por qué**, tabla de
  decisiones tomadas, pasos de implementación numerados con los archivos exactos a tocar, tests
  nuevos (nombre del archivo y qué casos), impacto en CI, criterios de aceptación verificables, y
  **checklist de verificación manual en AWS** para lo que no se puede probar acá.
- Prohibido inventar APIs, nombres de recursos o versiones: todo lo que afirmen tiene que estar leído
  del repo o de documentación oficial consultada en la sesión.
- Que marquen explícitamente las **decisiones que son del usuario** (presupuesto de complejidad,
  dual-deploy vs CRR, reemplazar el feed actual o dejar los dos).

**Gate 1 (vos).** Cuando los cuatro terminen: leé los documentos, verificá a mano al menos cinco
referencias `archivo:línea` de cada uno (si un plan cita mal, se lo devolvés al agente para que lo
corrija), detectá solapamientos de archivos y contradicciones entre planes, y armá un resumen corto
para el usuario: orden de implementación propuesto, decisiones abiertas y riesgo de cada una.
**Pará y preguntale al usuario** las decisiones abiertas (usá `AskUserQuestion`) antes de pasar a la
Fase 2. No implementes nada sin esa respuesta.

FASE 2 — IMPLEMENTACIÓN (agentes, con dueño único por archivo)

Reglas no negociables:

- **Un agente por plan aprobado**, `general-purpose`. Dos agentes **nunca** escriben los mismos
  archivos. F5-A y F5-C tocan los dos `packages/dashboard/src/App.tsx` y `api.ts`: o van
  **secuenciales** (primero el mapa, después MQTT) o se define un reparto explícito de archivos antes
  de lanzarlos. F5-B (terraform + scripts + workflow) sí puede ir en paralelo con el mapa.
- Cada agente implementa **sólo su plan**, incluidos sus tests, y deja el repo en verde:
  `npm run build && npm test` en la raíz, y para los cambios de infra `terraform fmt -recursive` +
  `terraform -chdir=terraform validate` (si `validate` necesita `init`, usar `-backend=false`).
- Comentarios y código en inglés, documentación en español, estilo del repo (helpers puros, sin
  mocks donde se pueda inyectar el reloj o la dependencia).
- **Commits sin líneas de atribución**: ni `Co-Authored-By: Claude`, ni «Generated with Claude
  Code». Autoría solo del usuario. Mensajes en el estilo del historial (`feat: …`, `fix: …`,
  `docs: …`). Un commit por pieza coherente; no commitear en `main` sin que el usuario lo pida —
  crear rama si hace falta.
- Si un agente encuentra que su plan no cierra con la realidad del código, **para y reporta**; no
  improvisa un diseño distinto.
- Actualizar `README.md` y `docs/features-faltantes-propuesta.md` (estado de la fila 5) como parte de
  la implementación, no después.

**Gate 2 (vos).** Corré vos mismo `npm run build`, `npm test`, `terraform fmt -check -recursive` y
`terraform -chdir=terraform validate`. Mirá el diff completo (`git diff`/`git status`). Si algo está
rojo o el diff tiene cosas que ningún plan pedía, devolvelo al agente que lo escribió antes de
revisar.

FASE 3 — REVISIÓN (agentes, hallazgos consolidados por vos)

Lanzá en paralelo:

1. **Un agente de progreso por plan** (`general-purpose`), que use la skill `progress-review`:
   contrasta lo implementado contra su plan, busca errores de lógica, corre los tests y revisa que se
   respeten las convenciones del repo.
2. **Un agente de revisión de código** sobre el diff completo, con la skill `code-review` en nivel
   `high`: correctness, reuso, simplificación.
3. **Un agente de factibilidad Learner Lab / infra**: relee los cambios de Terraform, workflow y
   `bootstrap-buckets.sh` contra las restricciones conocidas (SCP de S3, regiones, `LabRole`,
   `iam:PassRole`, servicios no disponibles) y contra `docs/terraform-buckets-learner-lab.md`. Que
   verifique que el orden bootstrap→terraform sigue siendo válido y que el `destroy` + borrado de
   buckets sigue cerrando.
4. **Un agente de honestidad documental**: compara lo que ahora dicen `README.md`,
   `docs/features-faltantes-propuesta.md` y los planes contra lo que el código **realmente** hace.
   Busca específicamente sobreventa: decir «multi-región» si sólo se replica el sitio estático
   (el backend, el ALB, DynamoDB y IoT siguen en `us-east-1`), decir «MQTT sobre WebSockets» si quedó
   el feed viejo, o marcar la fila 5 como ✅ con huecos abiertos. Esto importa para la defensa oral.

**Gate 3 (vos).** Consolidá los hallazgos en una lista única, sin duplicados, ordenada por severidad,
y clasificá cada uno en: *arreglar ahora* / *decisión del usuario* / *fuera de alcance*. Lanzá agentes
de fix sólo para los primeros, re-corré los gates y volvé a pedir una revisión acotada de lo que se
tocó. No declares nada terminado sin que los comandos de verificación hayan corrido en verde en tu
propia sesión.

CIERRE

Entregá al usuario, en un mensaje corto:

- Qué quedó implementado de F5-A, F5-B y F5-C, y qué quedó **documentado pero no implementado** (con
  el por qué).
- Los documentos nuevos en `docs/` con sus links.
- El checklist de verificación manual en AWS (lo que hay que correr con credenciales frescas:
  `apply`, confirmar la URL de los dos buckets, abrir el mapa con el simulador corriendo, probar el
  spike del authorizer si corresponde).
- La lista de hallazgos clasificados como «decisión del usuario» o «fuera de alcance» que quedaron
  abiertos.
- Cómo quedó la fila 5 de `docs/features-faltantes-propuesta.md` y qué habría que decir en la defensa
  sobre lo que la propuesta promete y la implementación no cumple.

FUERA DE ALCANCE (no los toques, aunque los agentes los propongan)

Los umbrales por Device Shadow (prioridad 3 del doc de huecos), la replicación multi-región del
backend (prioridad 4: DynamoDB Global Tables, segunda región de la API), la medición de latencias
(prioridad 5), HTTPS de punta a punta y el autoescalado de la API. Si un agente encuentra algo de eso
en el camino, se anota como hallazgo y se deja fuera del diff.
