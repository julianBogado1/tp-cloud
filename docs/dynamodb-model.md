# Modelo de persistencia DynamoDB

Todas las tablas de dominio tienen los nombres definidos en `packages/shared/src/config.ts` (`NAMES`). La telemetría histórica y el estado de unidad ya existen; este documento describe además las cinco tablas migradas desde PostgreSQL.

| Entidad / tabla | Partition key | Sort key | GSIs | Accesos que cubre |
|---|---|---|---|---|
| `users` / `NAMES.usersTable` | `id` (Number) | Ninguna | `email-index`: `email_lower` | Login por email sin distinguir mayúsculas; ABM por `id`; listado administrativo por Scan ordenado por `id`. |
| `clients` / `NAMES.clientsTable` | `id` (Number) | Ninguna | Ninguno | Validación de existencia de cliente al crear/editar usuarios. |
| `units` / `NAMES.unitsTable` | `unit_id` (String) | Ninguna | `client_id-index`: `client_id` | `GET /units` y `GET /units/:id/*`; operadores/supervisores consultan sólo su tenant mediante el GSI; admin usa Scan. |
| `device-config` / `NAMES.deviceConfigTable` | `unit_id` (String) | Ninguna | Ninguno | Lectura de umbrales por unidad en API y alert-processor; actualización parcial de configuración. |
| `alerts` / `NAMES.alertsTable` | `id` (Number) | Ninguna | `client_id-emitted_at-index`: `client_id`, `emitted_at` | Alert-processor inserta alertas con tenant; `GET /alerts` consulta por tenant y fecha; admin usa Scan; ack obtiene por `id` y actualiza condicionalmente. |

## Campos denormalizados

`units.client_id` permite resolver alcance sin joins. Las alertas copian `client_id` al insertarse, resolviéndolo desde la unidad, para que la lista por tenant sea una sola Query. `users.email_lower` es el email normalizado usado por `email-index`; `email` conserva el valor mostrado.

Los campos `alerts.acknowledged_by` y `alerts.acknowledged_at` son `null` hasta el acknowledgement. La API usa `ConditionExpression = attribute_not_exists(acknowledged_at)`, equivalente a la actualización transaccional anterior: el primer supervisor gana y los siguientes reciben `already acknowledged`; una alerta de otro tenant se presenta como 404.

Las tablas `snowball-telemetry` (`unit_id`, `ts`) y `snowball-unit-state` (`unit_id`) mantienen sus claves existentes. El estado de excursión del alert-processor sigue usando el ítem `ts = _state` en telemetría y no se mezcla con las lecturas históricas.

## Seed

`scripts/seed-data.json` contiene los mismos clientes, unidades, configuraciones y usuarios demo que el seed SQL. Cada entrada tiene una clave estable `key` y un `item` en DynamoDB JSON explícito: strings usan `S`, números `N`, booleanos `BOOL` y valores nulos `NULL`; listas/mapas anidados usarían `L`/`M`. Terraform pasa `item` sin inferir ni convertir tipos. Los usuarios llevan hashes bcrypt precalculados; no se incluyen contraseñas en claro.
