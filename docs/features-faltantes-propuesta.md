# Features faltantes respecto de la propuesta formal (Entrega 1)

**Repo relevado:** `tp2/tp-cloud` (rama `main`, commit `9a04b9a`)
**Referencia:** propuesta formal «Snowball — Plataforma Elástica de Monitoreo de Cadena de Frío en Tiempo Real»
**Fecha:** 2026-10-19

Resumen: de las 5 features de la propuesta, la autenticación, la ingesta y las alertas están completas (las alertas, desde que se implementó el «sin señal» por unidad). Las otras dos (configuración remota y dashboard) siguen a medias. Además faltan la replicación multi-región y algunos requisitos no funcionales.

---

## 1. Features

| # | Feature | Estado | Qué falta |
|---|---|---|---|
| 1 | Autenticación de personas y máquinas | ✅ | Nada funcional. Hay JWT propio con roles operador/supervisor/admin y certificado X.509 por unidad con política limitada a sus tópicos. La diferencia es que no hay Lambda Authorizer: la API valida el JWT por su cuenta. |
| 2 | Ingesta de telemetría | ✅ | Nada. IoT Core escribe directo en DynamoDB (estado actual + histórico con TTL), hay exportación diaria a S3 y la telemetría no pasa por ninguna capa web. |
| 3 | Alertas por umbral sostenido | ✅ | Nada. Al desvío sostenido con estado en DynamoDB, SNS con unidad, duración y posición y la DLQ se sumó el **«sin señal» por unidad**: la Lambda `snowball-no-signal-monitor`, agendada con EventBridge Scheduler cada minuto, compara el silencio de cada unidad contra su `signal_timeout_min` (`snowball-device-config`, con fallback a `NO_SIGNAL_TIMEOUT_MIN`), emite una alerta `no-signal` idempotente y avisa también cuando la unidad se recupera. El tópico `snowball-no-signal` ya tiene suscripción por mail, y la alarma de flota se mantiene a propósito: detecta la caída del pipeline, que es otro modo de falla. Plan y decisiones en [`plan-sin-senal.md`](plan-sin-senal.md). |
| 4 | Configuración remota | 🟡 | El setpoint va por Device Shadow, persiste ante desconexiones y la interfaz muestra deseado vs. aplicado. **Los umbrales no viajan por el Shadow**: se guardan en DynamoDB y solo los usa la Lambda de alertas, el equipo nunca los recibe (`packages/api/src/config-routes.ts` manda al Shadow solo el `setpoint_c`). |
| 5 | Dashboard en tiempo real | 🟡 | Hay frontend en S3, gráfico histórico (sparkline) y actualización en vivo. Faltan tres cosas: **el mapa de unidades por estado** (hoy son tarjetas con las coordenadas en texto y no hay librería de mapas); **el S3 Website replicado por región**; y la suscripción MQTT sobre WebSockets: el feed en vivo es un WebSocket propio de la API que consulta DynamoDB cada 3 s. Esto último cumple la función, pero no es lo que dice la propuesta. |

## 2. Lo que dice el contexto y no está

- **Replicación multi-región del backend.** La propuesta la presenta como argumento central («los sensores se desplazan grandes distancias»), y hoy todo vive en una sola región (`us-east-1`). Es lo más grande que falta.

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
2. Mapa de unidades en el dashboard (con Leaflet y OpenStreetMap alcanza; las coordenadas ya están en cada lectura).
3. Enviar los umbrales por el Device Shadow además del setpoint.
4. Multi-región, al menos documentado como plan o con una réplica mínima (DynamoDB Global Tables + un segundo bucket del dashboard).
5. Medir las latencias de <5 s y <60 s y dejar la evidencia.

El plan detallado del «sin señal» por unidad, con las alternativas evaluadas y las decisiones tomadas, está en [`plan-sin-senal.md`](plan-sin-senal.md) (ya implementado). El mapa, los umbrales por Shadow, multi-región, la réplica del dashboard por región, la medición de latencias, HTTPS de punta a punta y el autoescalado de la API todavía no tienen plan escrito.
