# Modelo de persistencia DynamoDB

Todas las tablas de dominio tienen los nombres definidos en `packages/shared/src/config.ts` (`NAMES`). La telemetría histórica y el estado de unidad ya existen; este documento describe además las cinco tablas migradas desde PostgreSQL.

| Entidad / tabla | Partition key | Sort key | GSIs | Accesos que cubre |
|---|---|---|---|---|
| `users` / `NAMES.usersTable` | `id` (Number) | Ninguna | `email-index`: `email_lower` | Login por email sin distinguir mayúsculas; ABM por `id`; listado administrativo por Scan ordenado por `id`. |
| `clients` / `NAMES.clientsTable` | `id` (Number) | Ninguna | Ninguno | Validación de existencia de cliente al crear/editar usuarios. |
| `units` / `NAMES.unitsTable` | `unit_id` (String) | Ninguna | `client_id-index`: `client_id` | `GET /units` y `GET /units/:id/*`; operadores/supervisores consultan sólo su tenant mediante el GSI; admin usa Scan. |
| `device-config` / `NAMES.deviceConfigTable` | `unit_id` (String) | Ninguna | Ninguno | Lectura de umbrales por unidad en API, alert-processor y monitor de «sin señal»; actualización parcial de configuración. |
| `alerts` / `NAMES.alertsTable` | `id` (Number) | Ninguna | `client_id-emitted_at-index`: `client_id`, `emitted_at` | Alert-processor inserta alertas con tenant, con `id` determinístico (entero derivado de `sha256(unit_id\|since)`, o de `sha256(severidad\|unit_id\|since)` para las alertas de «sin señal», que si no colisionarían con una térmica de la misma unidad y el mismo `since`) y `attribute_not_exists(id)`, así un reintento de SQS o un segundo barrido no duplican la fila; `GET /alerts` consulta por tenant y fecha; admin usa Scan; ack obtiene por `id` y actualiza condicionalmente. |

## Campos denormalizados

`units.client_id` permite resolver alcance sin joins. Las alertas copian `client_id` al insertarse, resolviéndolo desde la unidad, para que la lista por tenant sea una sola Query. `users.email_lower` es el email normalizado usado por `email-index`; `email` conserva el valor mostrado.

Los campos `alerts.acknowledged_by` y `alerts.acknowledged_at` son `null` hasta el acknowledgement. La API usa `ConditionExpression = attribute_not_exists(acknowledged_at)`, equivalente a la actualización transaccional anterior: el primer supervisor gana y los siguientes reciben `already acknowledged`; una alerta de otro tenant se presenta como 404.

Las tablas `snowball-telemetry` (`unit_id`, `ts`) y `snowball-unit-state` (`unit_id`) mantienen sus claves existentes. El estado de excursión del alert-processor sigue usando el ítem `ts = _state` en telemetría y no se mezcla con las lecturas históricas.

## Ítems de estado en `snowball-telemetry`

Las dos máquinas de estados del paquete `alert-processor` guardan su estado como ítems de la misma tabla de telemetría, con una sort key fija que empieza con `_`. Ningún `ts` ISO-8601 empieza con underscore, así que no colisionan entre sí ni con las lecturas, y una Query por rango de fechas nunca los devuelve.

| Sort key | Quién lo escribe | Contenido | Para qué |
|---|---|---|---|
| `_state` | `snowball-alert-processor` (`src/state.ts`) | `phase` (`ok` / `deviated` / `alerted`) y `since` (ISO, primera lectura fuera de rango de la excursión en curso) | Antirrebote del desvío sostenido: la alerta se emite una sola vez por excursión, recién al superar `tolerance_min`. |
| `_signal` | `snowball-no-signal-monitor` (`src/signal-state.ts`) | `phase` (`ok` / `silent`), `since` (ISO, `ts` de la última lectura: cuándo empezó el silencio) y `observed_at` (ISO, solo para una unidad que nunca reportó, porque no hay última lectura desde la que contar) | Antirrebote del «sin señal»: en `silent` el barrido siguiente no vuelve a alertar, y la transición `silent → ok` dispara el aviso de recuperación. |

El barrido de «sin señal» no arranca de estos ítems sino de `snowball-units` (es la tabla que tiene el flag `active` y el `client_id`), y después hace `BatchGetItem` contra `snowball-unit-state` (última lectura) y contra los ítems `_signal`. Si arrancara del estado, una unidad provisionada que nunca reportó sería invisible, que es justamente el caso más grave.

## Umbral de silencio por unidad

`device-config` tiene, además de los umbrales térmicos (`temp_min_c`, `temp_max_c`, `setpoint_c`, `tolerance_min`), el campo opcional **`signal_timeout_min`**: los minutos sin lecturas que tolera esa unidad antes de contar como silenciosa. Es opcional a propósito —una fila sembrada antes de que el campo existiera sigue siendo válida— y en ese caso el monitor usa la variable de entorno `NO_SIGNAL_TIMEOUT_MIN` (10 minutos por defecto, de la variable Terraform `no_signal_timeout_min`).

El mismo valor viaja al dashboard en `GET /units` (`UnitRow.signal_timeout_min`, `null` si la fila no lo tiene), para que la tarjeta marque «sin señal» con la misma ventana con la que sale la alerta por mail y no se contradigan.

## Seed

`scripts/seed-data.json` contiene los mismos clientes, unidades, configuraciones y usuarios demo que el seed SQL. Cada entrada tiene una clave estable `key` y un `item` en DynamoDB JSON explícito: strings usan `S`, números `N`, booleanos `BOOL` y valores nulos `NULL`; listas/mapas anidados usarían `L`/`M`. Terraform pasa `item` sin inferir ni convertir tipos. Los usuarios llevan hashes bcrypt precalculados; no se incluyen contraseñas en claro.
