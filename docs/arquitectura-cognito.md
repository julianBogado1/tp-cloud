# Cambios de arquitectura: autenticación con Cognito (Entrega 4)

Qué cambia en la arquitectura con el login por Cognito y qué hay que agregar
al diagrama (`docs/Snowball Arquitectura.png`). El funcionamiento detallado del
login está en [`infra-terraform.md`](infra-terraform.md#autenticación-con-cognito).

## Resumen

Aparece un **cuarto flujo, el de autenticación**. Los otros tres (ingesta,
monitoreo agendado y plano web) no cambian.

- **Se agrega**, todo fuera de la VPC y en `us-east-1`:
  - un user pool de Cognito con su Hosted UI;
  - un HTTP API de API Gateway, el «puente HTTPS»;
  - una Lambda nueva, `snowball-auth-callback`;
  - un log group de CloudWatch para los access logs del API.
- **Cambia** lo que viaja del navegador a la API: antes era un JWT firmado por
  la propia API, ahora es el *access token* de Cognito. La API lo valida contra
  Cognito y sigue sacando el rol de DynamoDB.
- **Se va** el login propio de la API (`POST /auth/login`, bcrypt y
  `JWT_SECRET`). En el diagrama no estaba dibujado, así que no hay nada que
  borrar.
- **Dentro de la VPC no cambia nada**: ni subredes, ni security groups, ni
  endpoints. La API sale a Cognito por el NAT que ya existe (Cognito no tiene
  gateway endpoint).

## Por qué hace falta el puente

Cognito solo redirige a URLs **HTTPS** después del login (`http://localhost`
es la única excepción), y el dashboard es un sitio estático de S3 en **HTTP**.
Entonces Cognito no puede volver directo al dashboard. API Gateway sí tiene una
URL HTTPS fija: Cognito vuelve ahí, una Lambda canjea el *code* por los tokens y
redirige al dashboard con los tokens en la URL. Es el workaround que dio la
cátedra.

## Componentes nuevos (nodos del diagrama)

Todos van **dentro de la región `us-east-1` y fuera de la VPC**, igual que las
otras Lambdas y servicios administrados.

| Nodo | Ícono AWS sugerido | Etiqueta | Recurso de Terraform |
|---|---|---|---|
| User pool de Cognito | Amazon Cognito | `snowball-users` · Hosted UI · 3 cuentas demo | `module.cognito` (`aws_cognito_user_pool`, `aws_cognito_user_pool_domain`, `aws_cognito_user_pool_client`, `aws_cognito_user`) |
| API Gateway | Amazon API Gateway | `snowball-auth` · HTTP API · `GET /callback`, `GET /logout` · HTTPS | `aws_apigatewayv2_api.auth` y su stage, rutas e integración |
| Lambda del puente | AWS Lambda | `snowball-auth-callback` · code → tokens | `module.auth_callback` (módulo `lambda-function`) |
| Log group (opcional) | CloudWatch Logs | `/aws/apigateway/snowball-auth` · access logs | `aws_cloudwatch_log_group.auth_api` |

Sugerencias de ubicación:

- **Agrupar los tres nodos** (Cognito, API Gateway y la Lambda) en un recuadro
  punteado propio, «Autenticación», como el de las Lambdas.
- **Ponerlo cerca del navegador y del bucket del dashboard**, porque el flujo
  arranca y termina en el navegador. Por ejemplo, abajo del grupo de Lambdas,
  a la derecha del bucket `snowball-dashboard`.
- **No meter `snowball-auth-callback` dentro del recuadro de Lambdas
  existente**: ese grupo es el del pipeline de datos y este flujo no tiene que
  ver con él.

## Flechas nuevas

Se pueden numerar, porque el login es una secuencia. Los colores siguen la
leyenda del README:
- **Azul (nuevo):** el flujo de autenticación.
- **Naranja:** invocación de Lambda.
- **Violeta punteado:** salida a Internet por el NAT.

| # | Desde | Hacia | Etiqueta | Color |
|---|---|---|---|---|
| 1 | Operadores y supervisores (navegador) | Cognito (Hosted UI) | `1 · login (Hosted UI) · HTTPS` | azul |
| 2 | Cognito | API Gateway `snowball-auth` | `2 · redirect GET /callback?code` | azul |
| 3 | API Gateway | `snowball-auth-callback` | `3 · invoca` | naranja |
| 4 | `snowball-auth-callback` | Cognito | `4 · /oauth2/token · code → tokens (client secret)` | azul |
| 5 | `snowball-auth-callback` | Operadores y supervisores (navegador) | `5 · 302 al dashboard · #access_token` | azul |
| — | EC2 de la API (ASG) | Cognito | `JWKS (valida el token) · Admin*User · HTTPS por el NAT` | violeta punteado |
| — | API Gateway | CloudWatch Logs `/aws/apigateway/snowball-auth` | `access logs` | gris (opcional) |

La flecha de la API a Cognito se dibuja como las otras salidas por el NAT (por
ejemplo, la de Device Shadow): sale de las EC2, pasa por `nat-snowball-a` y el
IGW, y llega a Cognito.

Flechas que **solo cambian de etiqueta**:

| Flecha existente | Etiqueta actual | Etiqueta nueva |
|---|---|---|
| Navegador → ALB | `sg-alb 80/TCP · REST + WebSocket` | `sg-alb 80/TCP · REST + WebSocket · Bearer token de Cognito` |

## Lo que no hace falta dibujar

- **El logout.** La Hosted UI vuelve por `GET /logout` del mismo API Gateway y
  la Lambda redirige al dashboard. Es el mismo camino que el login, así que
  alcanza con mencionar `/logout` en la etiqueta del API Gateway.
- **La lectura del rol.** La API sigue leyendo el rol en DynamoDB por el
  `vpce-ddb`, con la flecha que ya existe.
- **La réplica en `us-west-2`.** Usa el mismo Cognito y el mismo puente: el
  `state` del login lleva el origen y la Lambda devuelve los tokens a la réplica.
  No hace falta otra flecha.
- **El log group de la Lambda.** Las otras Lambdas tampoco tienen el suyo
  dibujado.

## Relacionado (de la entrega anterior, tampoco está en el diagrama)

Los fixes de tfsec agregaron una clave KMS propia (`alias/snowball`,
`terraform/kms.tf`), que cifra:
- las dos colas SQS;
- los tres tópicos SNS;
- todos los log groups, incluido el nuevo de API Gateway.

Si quieren mostrarla, es un nodo de AWS KMS fuera de la VPC, conectado con una
línea fina a SQS, SNS y CloudWatch Logs. Es opcional: es cifrado en reposo, no
un flujo de datos.

## Checklist para el diagrama

- [ ] Recuadro «Autenticación» con Cognito, API Gateway `snowball-auth` y la
      Lambda `snowball-auth-callback`, en `us-east-1` y fuera de la VPC.
- [ ] Flechas 1 a 5 del login (azul; la 3 en naranja).
- [ ] Flecha violeta punteada de las EC2 a Cognito, por el NAT.
- [ ] Cambiar la etiqueta de navegador → ALB para que mencione el token de
      Cognito.
- [ ] Agregar el azul a la leyenda de colores del README.
- [ ] (Opcional) Log group de API Gateway y clave KMS.
