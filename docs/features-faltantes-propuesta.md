# Features faltantes respecto de la propuesta formal (Entrega 1)

**Repo relevado:** `tp2/tp-cloud` (rama `main`, commit `9a04b9a`)
**Referencia:** propuesta formal «Snowball — Plataforma Elástica de Monitoreo de Cadena de Frío en Tiempo Real»
**Fecha:** 2026-10-19

Resumen: de las 5 features de la propuesta, la autenticación, la ingesta y las alertas están completas (las alertas, desde que se implementó el «sin señal» por unidad). Las otras dos (configuración remota y dashboard) siguen a medias, pero el dashboard se acercó bastante: ya tiene el **mapa de unidades por estado** y el **sitio estático replicado por región**, y lo único que le falta es la suscripción MQTT sobre WebSockets. Además falta la replicación multi-región **del backend** y algunos requisitos no funcionales.

---

## 1. Features

| # | Feature | Estado | Qué falta |
|---|---|---|---|
| 1 | Autenticación de personas y máquinas | ✅ | Nada funcional. Hay JWT propio con roles operador/supervisor/admin y certificado X.509 por unidad con política limitada a sus tópicos. La diferencia es que no hay Lambda Authorizer: la API valida el JWT por su cuenta. |
| 2 | Ingesta de telemetría | ✅ | Nada. IoT Core escribe directo en DynamoDB (estado actual + histórico con TTL), hay exportación diaria a S3 y la telemetría no pasa por ninguna capa web. |
| 3 | Alertas por umbral sostenido | ✅ | Nada. Al desvío sostenido con estado en DynamoDB, SNS con unidad, duración y posición y la DLQ se sumó el **«sin señal» por unidad**: la Lambda `snowball-no-signal-monitor`, agendada con EventBridge Scheduler cada minuto, compara el silencio de cada unidad contra su `signal_timeout_min` (`snowball-device-config`, con fallback a `NO_SIGNAL_TIMEOUT_MIN`), emite una alerta `no-signal` idempotente y avisa también cuando la unidad se recupera. El tópico `snowball-no-signal` ya tiene suscripción por mail, y la alarma de flota se mantiene a propósito: detecta la caída del pipeline, que es otro modo de falla. Plan y decisiones en [`plan-sin-senal.md`](plan-sin-senal.md). |
| 4 | Configuración remota | 🟡 | El setpoint va por Device Shadow, persiste ante desconexiones y la interfaz muestra deseado vs. aplicado. **Los umbrales no viajan por el Shadow**: se guardan en DynamoDB y solo los usa la Lambda de alertas, el equipo nunca los recibe (`packages/api/src/config-routes.ts` manda al Shadow solo el `setpoint_c`). |
| 5 | Dashboard en tiempo real | 🟡 | Hay frontend en S3, gráfico histórico (sparkline) y actualización en vivo. De las tres cosas que faltaban se cerraron dos. **Mapa de unidades por estado**: hecho, con Leaflet y tiles de OpenStreetMap, un marcador por unidad coloreado con el mismo `readingStatus` que las tarjetas, selección cruzada tarjeta ↔ marcador y las unidades sin GPS listadas aparte en vez de ubicadas en falso ([`plan-mapa-unidades.md`](plan-mapa-unidades.md)). **S3 Website replicado por región**: hecho, el dashboard se publica en dos buckets (`us-east-1` y `us-west-2`) como **dos sitios estáticos independientes con dos URLs distintas** — sin dominio único ni failover automático, porque el Learner Lab no habilita Route 53 ni CloudFront, y con el backend entero en `us-east-1`, al que apuntan las dos copias ([`plan-replica-dashboard.md`](plan-replica-dashboard.md)). **Falta la suscripción MQTT sobre WebSockets**: el feed en vivo sigue siendo un WebSocket propio de la API que consulta DynamoDB cada 3 s. Cumple la función y el requisito de <5 s, pero no es lo que dice la propuesta. Está **documentada y no implementada**: necesita un custom authorizer de IoT, y eso depende de un permiso del SCP (`iot:CreateAuthorizer` y `lambda:AddPermission` para `iot.amazonaws.com`) que es un spike **pendiente de ejecución**, no fallado ni aprobado ([`plan-mqtt-websockets.md`](plan-mqtt-websockets.md)). |

## 2. Lo que dice el contexto y no está

- **Replicación multi-región del backend.** La propuesta la presenta como argumento central («los sensores se desplazan grandes distancias»), y el backend entero sigue viviendo en una sola región (`us-east-1`): el ALB, las instancias EC2, DynamoDB, IoT Core, SQS, SNS y las tres Lambdas. Es lo más grande que falta. Lo único replicado hoy es el **sitio estático** del dashboard (dos buckets, dos URLs), que no es replicación de la plataforma: si `us-east-1` se cae, la copia de `us-west-2` sirve el HTML pero no tiene con quién hablar.

## 3. Requisitos no funcionales

| Requisito | Estado | Detalle |
|---|---|---|
| Lectura en el dashboard en <5 s (p95) | 🟡 | Debería cumplirse: la API consulta cada 3 s (`LIVE_POLL_MS`) y el envío del sensor es inmediato. Pero no está medido. |
| Alerta en <60 s desde la condición | 🟡 | Por diseño sí (SQS → Lambda casi en tiempo real), pero tampoco está medido. |
| Escalar de 10 a 1.000 dispositivos sin rediseño | 🟡 | La ingesta escala sola. La API en EC2 no tiene política de autoescalado (queda fija en 2 instancias) y no hay prueba de carga. |
| Disponibilidad 99,9 % multi-AZ | 🟡 | Hay ALB + autoescalado en 2 zonas, pero un solo NAT Gateway. |
| TLS mutuo por dispositivo | ✅ | — |
| **HTTPS de punta a punta** | ❌ | El ALB y el dashboard en S3 son solo HTTP. |
| Buckets privados | 🟡 | Los de artefactos y archivo son privados; el del dashboard es público porque así lo exige S3 Website. |
| Mínimo privilegio / LabRole | ✅ | — |
| Límite de tasa | 🟡 | Solo en el login (10 por minuto por instancia). El resto de la API no tiene. |
| TTL + Glacier | ✅ | — |
| **Sin instancias permanentes** | ❌ | La API corre en EC2 (2 instancias siempre encendidas) y hay un NAT Gateway fijo. |

## 4. Lo que se cambió a propósito

Estos puntos no son olvidos: la propuesta pedía API Gateway + Lambda, CloudFront y «sin instancias permanentes», y en la Entrega 2 se movió la API a EC2 dentro de una VPC porque el enunciado pedía justificar VPC, EC2 y NAT. Igual conviene explicarlo en la defensa, porque la propuesta formal dice lo contrario.

## 5. Prioridades

1. ~~Avisos de «sin señal» por unidad, con suscriptores en el tópico.~~ **Hecho**: Lambda agendada `snowball-no-signal-monitor`, umbral por unidad, alerta y aviso de recuperación en `snowball-no-signal`, con suscripción por mail.
2. ~~Mapa de unidades en el dashboard.~~ **Hecho**: componente `UnitsMap` con Leaflet 1.9.4 puro (sin `react-leaflet`), `circleMarker` coloreado por CSS desde la paleta de `styles.css` —cero hexadecimales en el TypeScript—, encuadre inicial único más botón «Encuadrar», y selección compartida con las tarjetas. Plan y decisiones en [`plan-mapa-unidades.md`](plan-mapa-unidades.md).
3. Enviar los umbrales por el Device Shadow además del setpoint.
4. Multi-región del **backend**: DynamoDB Global Tables y una segunda región de la API/ALB. La parte del «segundo bucket del dashboard» **ya está hecha** ([`plan-replica-dashboard.md`](plan-replica-dashboard.md)), pero es solo el sitio estático: no es replicación de la plataforma.
5. Medir las latencias de <5 s y <60 s y dejar la evidencia.

Los planes detallados, con las alternativas evaluadas y las decisiones tomadas, están en [`plan-sin-senal.md`](plan-sin-senal.md) (implementado), [`plan-mapa-unidades.md`](plan-mapa-unidades.md) (implementado), [`plan-replica-dashboard.md`](plan-replica-dashboard.md) (implementado) y [`plan-mqtt-websockets.md`](plan-mqtt-websockets.md) (documentado, no implementado). El marco de verificación de la Feature 5 —qué se puede probar sin credenciales, el checklist manual de AWS y el riesgo de cada cambio sobre el CI— está en [`plan-feature-5-restricciones.md`](plan-feature-5-restricciones.md). Los umbrales por Shadow, la multi-región del backend, la medición de latencias, HTTPS de punta a punta y el autoescalado de la API todavía no tienen plan escrito.
