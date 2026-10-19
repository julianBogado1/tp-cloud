# Plan: alerta de «sin señal» por unidad

**Feature:** #3 de la propuesta formal (alertas por umbral sostenido) — la mitad que falta.
**Hueco a cerrar:** hoy hay **una sola** alarma de CloudWatch para toda la flota (`snowball-no-signal-alarm`, sobre `AWS/SQS NumberOfMessagesSent` de `snowball-readings`), así que solo salta si **todas** las unidades dejan de reportar; y el tópico `snowball-no-signal` **no tiene suscriptores**, así que nadie recibe el aviso.
**Fecha:** 2026-10-19

---

## 1. Qué ya existe y se reusa

El repo tiene casi todos los enganches puestos pero sin productor:

| Pieza | Dónde | Estado |
|---|---|---|
| Severidad `'no-signal'` | `packages/shared/src/types.ts:52` | declarada, **sin productor** |
| Tópico SNS `snowball-no-signal` | `terraform/locals.tf:19`, `terraform/modules/messaging/main.tf:12-15` | creado, **sin suscripción** |
| `NAMES.noSignalTopic` | `packages/shared/src/config.ts:19` | declarado, **sin consumidor** |
| Última lectura por unidad | tabla `snowball-unit-state` (PK `unit_id`, sin SK, sin TTL) | la escribe la regla IoT; su campo `ts` **es** el «última vez visto» |
| Insert idempotente de alertas | `packages/alert-processor/src/thresholds.ts:45-59` + `alert-id.ts:16` | reusable tal cual |
| Patrón de cron | `aws_scheduler_schedule` (EventBridge Scheduler) en `terraform/main.tf:159-170` | reusable tal cual |
| Estado por unidad en DynamoDB | ítem `ts = '_state'` en `snowball-telemetry` (`src/state.ts:16-35`) | patrón a espejar |
| Escenario de prueba | `packages/simulator`: `--silence SB-002@120` | ya existe, pensado para esto |
| Etiqueta «sin señal» en la UI | `packages/dashboard/src/status.ts:10` (`STALE_MS = 2 min`), `UnitCard.tsx:14` | derivada en el **cliente**, no es una alerta |

Lo que **no** existe: ningún componente se despierta por tiempo. Todo el pipeline de alertas es event-driven por lectura entrante, y `evaluate()` toma el tiempo de `reading.ts`, nunca del reloj. La ausencia de datos, por definición, no genera un evento.

## 2. Decisión de diseño

### Mecanismo: Lambda agendada que barre el estado

Una Lambda nueva (`snowball-no-signal-monitor`) disparada por **EventBridge Scheduler** cada minuto: lista las unidades activas, compara `now - last_reading.ts` contra el umbral de cada unidad, y para las que pasaron el umbral inserta una alerta `no-signal` y publica en `snowball-no-signal`.

**Alternativa descartada: una alarma de CloudWatch por unidad.** Haría falta publicar una métrica custom con dimensión `unit_id` en cada lectura (`PutMetricData`, que hoy nadie llama) y declarar N alarmas con `for_each = var.unit_ids`. Rompe el requisito no funcional de «escalar de 10 a 1.000 dispositivos sin rediseño» (1.000 alarmas + 1.000 métricas custom), y en Learner Lab es caro en cuota. Conviene dejarlo escrito como alternativa evaluada para la defensa.

**La alarma de flota se mantiene.** No es redundante: detecta la caída del *pipeline* (la cola no recibe nada), que es un modo de falla distinto de «esta unidad se calló». Con la suscripción nueva, por fin notifica.

### Decisiones tomadas (2026-10-19)

| Decisión | Elección | Por qué |
|---|---|---|
| Aviso de recuperación | **Sí**, publica en `snowball-no-signal` | La máquina de estados tiene que volver a `ok` de todos modos; el publish extra es casi gratis y cierra el ciclo de la demo |
| Suscriptor del tópico | Reusar `var.sns_subscription_email` | Ya es obligatoria y ya está cableada en el workflow y en el gate de la composite action: cero variables nuevas en CI |
| Cadencia del barrido | `rate(1 minute)` | La granularidad del scheduler **es** el error de detección; con 1 min la latencia real entra en el requisito de <60 s. El scan es de una tabla chica en PAY_PER_REQUEST |

### Fuente de verdad del barrido: `snowball-units`, no la tabla de estado

El barrido arranca de `snowball-units` (tiene el flag `active` y el `client_id` que la alerta necesita) y después hace `BatchGetItem` contra `snowball-unit-state`. Si arrancara de la tabla de estado, **una unidad provisionada que nunca reportó sería invisible** — justamente el caso más grave.

### Estado y antirrebote: ítem `ts = '_signal'`

Se espeja el truco ya documentado en `state.ts:6-14`: un ítem por unidad en `snowball-telemetry` con sort key fija `_signal` (ningún `ts` ISO empieza con underscore, así que no colisiona ni con las lecturas ni con `_state`).

Máquina de estados `ok | silent`, con el reloj como entrada **explícita** (igual que `readingStatus(reading, thresholds, nowMs)` en el dashboard), para que la función de decisión quede pura y testeable sin mocks:

```
            última lectura fresca
   ┌──────────────────────────────────────┐
   │                                      │
   ▼                                      │
 [ok] ──── silencio > timeout ────▶ [silent]
   ▲                                  │   │
   └──── lectura fresca ◀─────────────┘   └── silencio sostenido: no re-alerta
```

- `ok` + silencio > umbral → **emite alerta**, pasa a `silent` con `since` = ts de la última lectura.
- `silent` + sigue en silencio → no hace nada (evita el spam, igual que `alerted` en `excursion.ts:35-37`).
- `silent` + llegó una lectura fresca → vuelve a `ok` y **publica el aviso de recuperación** en el mismo tópico (decidido: cierra el ciclo en la demo y la transición de estado hacía falta igual).
- Unidad que **nunca reportó**: no hay fila en `snowball-unit-state`. Se registra la primera observación en el ítem `_signal` y se cuenta el umbral desde ahí, así la alerta sale una sola vez y con un `since` estable.

### Umbral por unidad

Se agrega `signal_timeout_min` a `ThresholdConfig` (fila de `snowball-device-config`, ya sembrada por Terraform desde `scripts/seed-data.json`), con fallback a `envAsNumber('NO_SIGNAL_TIMEOUT_MIN', 10)` para unidades sin el campo. Es el único camino coherente con «por unidad» y encaja con la prioridad #3 (mandar umbrales por el Shadow) sin adelantarla.

### Ubicación del código: segundo entry point de `alert-processor`

El handler nuevo vive en `packages/alert-processor/src/no-signal-handler.ts`, no en un paquete nuevo. Reusa sin copiar: `thresholds.ts` (`getThreshold`, `getUnit`, `insertAlert`), `alert-id.ts` y el harness `test/fake-aws.ts`. El paquete produce dos bundles.

### Colisión de ids de alerta

`alertId(unitId, since)` hashea `unit_id|since`. Una unidad que se desvía en la lectura T y después se calla con última lectura T produciría **el mismo id** para la alerta térmica y la de sin señal, y el `attribute_not_exists(id)` descartaría la segunda en silencio. Se agrega un tercer parámetro opcional de *seed* a `alertId`: con el seed el hash pasa a ser `seed|unit_id|since`, sin seed queda exactamente como hoy — así los ids de las alertas térmicas existentes no cambian y no se re-emite nada en el deploy.

### Tipos

`Alert.temp_c`, `lat` y `lon` son `number` obligatorios (`types.ts:62-64`), pero una unidad que nunca reportó no tiene ninguno. Se ensanchan a `number | null`, que es lo que `AlertRow` ya expone (`data-access.ts:28`) y lo que `AlertsTable.tsx:50` ya pinta como `—`.

## 3. Cambios, archivo por archivo

### `packages/shared`
1. `src/types.ts` — `signal_timeout_min?: number` en `ThresholdConfig`; `SignalPhase = 'ok' | 'silent'` + `SignalState { phase, since?, observed_at? }`; `temp_c`/`lat`/`lon` de `Alert` a `number | null`.

### `packages/alert-processor`
2. `src/silence.ts` (**nuevo**) — `evaluateSilence(state, lastReading | null, config, nowMs): { state, alert?, recovered? }`. Puro, sin I/O, sin `Date.now()` interno. Es el gemelo de `excursion.ts`.
3. `src/signal-state.ts` (**nuevo**) — `getSignalState` / `saveSignalState` sobre el ítem `_signal`, y `batchGetSignalStates` para el barrido. Espeja `state.ts`.
4. `src/no-signal-handler.ts` (**nuevo**) — `handler()`: escanea `snowball-units` con paginación filtrando `active`, `BatchGetItem` de estado y de `_signal`, llama `evaluateSilence` por unidad, y para cada alerta hace `insertAlert` → `PublishCommand` → `saveSignalState` (mismo orden que `process.ts:47-71`, por la misma razón de idempotencia). Un fallo por unidad se loguea y el barrido sigue.
5. `src/alert-id.ts` — tercer parámetro opcional `seed`, documentado.
6. `src/thresholds.ts` — `getThreshold` normaliza `signal_timeout_min`; `insertAlert` acepta el `seed` y `temp_c`/`lat`/`lon` nullables.
7. `package.json` — scripts `bundle:no-signal` y `zip:no-signal` (esbuild → `dist/no-signal/index.js` → `dist/no-signal-monitor.zip`), espejando los existentes con el fallback a `python -m zipfile`.
8. `test/fake-aws.ts` — agregar `ScanCommand` y `BatchGetCommand` a `ddbSend` y al export `libDynamodb`; `seedUnit` siembra `signal_timeout_min`; helper `seedState(unitId, reading)`.
9. `test/silence.test.ts` (**nuevo**) — la máquina de estados sin mocks: fresca, recién pasada el umbral, silencio sostenido sin re-alerta, recuperación, unidad que nunca reportó, unidad inactiva, borde exacto del umbral.
10. `test/no-signal-handler.test.ts` (**nuevo**) — barrido completo contra el fake: orden de efectos vía `expect(fake.log).toEqual([...])`, dedup por reintento, paginación del scan, un fallo de una unidad no corta el resto.

### `packages/api` y `packages/dashboard`
11. `src/data-access.ts` + `src/repositories/dynamodb.ts` + `test/fixtures.ts` — exponer `signal_timeout_min` en `UnitRow` (`listUnits` ya hace el `GetItem` a `device-config`, solo hay que mapear un campo más).
12. `packages/dashboard/src/api.ts` — el campo nuevo en `UnitWithReading`.
13. `packages/dashboard/src/status.ts` — `readingStatus` usa `unit.signal_timeout_min * 60_000` con fallback al `STALE_MS` de 2 min actual, para que la tarjeta y la alerta no se contradigan.
14. `packages/dashboard/src/AlertsTable.tsx` — mapa de etiquetas de severidad (`thermal-excursion` → «fuera de rango», `no-signal` → «sin señal», `low-battery` → «batería baja»); hoy imprime el string crudo (`AlertsTable.tsx:47`).
15. `packages/dashboard/test/status.test.ts` — casos del umbral por unidad.

### Terraform
16. `terraform/locals.tf` — entrada `"no-signal-monitor"` en `local.lambdas`: `timeout = 60`, `memory_size = 256`, env `SNS_NO_SIGNAL_TOPIC_ARN`, `DDB_TABLE`, `DDB_STATE_TABLE`, `DDB_UNITS_TABLE`, `DDB_DEVICE_CONFIG_TABLE`, `DDB_ALERTS_TABLE`, `NO_SIGNAL_TIMEOUT_MIN`.
17. `terraform/variables.tf` — `no_signal_lambda_zip_path` (default `../packages/alert-processor/dist/no-signal-monitor.zip`), `no_signal_schedule_expression` (default `rate(1 minute)`), `no_signal_timeout_min` (default `10`, con `validation`).
18. `terraform/modules/messaging/main.tf` — la suscripción por email pasa a `for_each` sobre `{ thermal, signal }` en vez de `count` sobre `thermal` solo, reusando `var.subscription_email`. **Esto es lo que cierra el «nadie recibe el aviso».** Hay que renombrar el recurso (`thermal_email` → `email`) con un bloque `moved`, o aceptar que Terraform destruya y recree la suscripción térmica (lo que obliga a reconfirmar el mail).
19. `terraform/modules/messaging/outputs.tf` — `no_signal_topic_arn`.
20. `terraform/main.tf` — `aws_scheduler_schedule "no_signal_monitor"`, copiando `telemetry_export` (`flexible_time_window { mode = "OFF" }`, `role_arn = data.aws_iam_role.lab.arn`, `input = "{}"`, sin `aws_lambda_permission`).
21. `terraform/outputs.tf` — `no_signal_schedule_arn`.
22. `scripts/seed-data.json` — `signal_timeout_min` en las tres filas de `device-config`.

### CI y docs
23. `package.json` (raíz) — sumar `bundle:no-signal` y `zip:no-signal` a la cadena de `npm run bundle`, que es lo que corre la composite action antes del `plan`/`apply`.
24. `README.md` — diagrama (sección MONITOREO), lista de componentes, y bajar el ítem de la lista de pendientes (`README.md:523-524`).
25. `docs/dynamodb-model.md` — el ítem `_signal` junto al `_state`.
26. `docs/infra-terraform.md` — la Lambda y el schedule nuevos; corregir «La alarma «sin señal» no notifica a nadie» (`:1038-1040`).
27. `docs/features-faltantes-propuesta.md` — feature #3 a ✅ y prioridad #1 hecha; además el link roto a `relevamiento-variante-b.md` (`:53`), que no existe en el repo.

## 4. Orden de implementación

Cuatro tandas; dentro de cada una el trabajo es paralelizable, entre tandas no.

1. **Shared + lógica pura** (1, 2, 5) — tipos, `silence.ts` y su test. No toca AWS, se valida con `npm test`.
2. **Handler + harness** (3, 4, 6, 8, 9, 10) — depende de la tanda 1.
3. **Infra + CI** (7, 16–23) — depende del handler solo por el nombre del zip, así que puede arrancar en paralelo con la 2.
4. **API + dashboard + docs** (11–15, 24–27) — depende de la 1 por los tipos.

## 5. Verificación

- `npm run build && npm test` en verde (el CI corre `validate` → `fmt -check -recursive` → `app`).
- `terraform fmt -check -recursive -diff` y `terraform validate` localmente: el job `validate` del workflow los corre sin credenciales y es el primer gate.
- End-to-end en el Lab: `apply`, confirmar la suscripción por email del tópico `snowball-no-signal`, correr el simulador con `--silence SB-002@120`, y verificar (a) la fila `no-signal` en `snowball-alerts`, (b) el mail, (c) la tarjeta en «sin señal» en el dashboard, (d) que al volver a publicar no se emite una segunda alerta.
- Evidencia para la defensa: el delta entre el `ts` de la última lectura y el `emitted_at` de la alerta mide la latencia de detección real, que es insumo directo del requisito no funcional «alerta en <60 s» (prioridad #5 del relevamiento).

## 6. Fuera de alcance

Mapa en el dashboard, umbrales por Device Shadow, multi-región, alertas de batería baja (`snowball-low-battery` sigue reservado), y la medición formal de latencias.
