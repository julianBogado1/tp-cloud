# Plan: mapa de unidades por estado

**Feature:** #5 de la propuesta formal (dashboard en tiempo real) — la parte F5-A.
**Hueco a cerrar:** la propuesta promete un mapa con las unidades coloreadas por estado. Hoy las unidades son tarjetas (`packages/dashboard/src/UnitCard.tsx`) que imprimen el GPS como texto (`UnitCard.tsx:38-41`) y **no hay ninguna librería de mapas en el repo** (`packages/dashboard/package.json:11-21`: solo `react`, `react-dom`, `vite`, `@vitejs/plugin-react` y los `@types`).
**Fecha:** 2026-10-20

---

## 1. Qué ya existe y se reusa

| Pieza | Dónde | Estado |
|---|---|---|
| Estado por lectura (`ok`/`excursion`/`stale`) | `packages/dashboard/src/status.ts:23-33` (`readingStatus`), tipo en `:10` | **Se reusa tal cual**, no se duplica la lógica |
| Umbral de silencio por unidad | `packages/dashboard/src/status.ts:12` (`DEFAULT_STALE_MS`), `:18-21` (`staleMs`) | Ya resuelto por la feature «sin señal»; el mapa lo hereda gratis |
| Paleta por estado | `packages/dashboard/src/styles.css:8-10` (`--ok: #34c98e`, `--excursion: #f0596b`, `--stale: #8195ad`), `--accent` en `:11` | **Única fuente de color**; prohibido inventar hexadecimales |
| Clases de estado ya en uso | `packages/dashboard/src/styles.css:49-50` (`.status-excursion .temp`), `:59-61` (`.badge-*`) | Patrón a espejar con `.unit-marker-*` |
| Última lectura efectiva de una unidad | `packages/dashboard/src/UnitCard.tsx:17` (`history.at(-1) ?? unit.last_reading`) | Se **extrae** a helper puro y la tarjeta pasa a usarlo |
| Datos de las unidades | `packages/dashboard/src/api.ts:14-24` (`UnitWithReading`), `:95` (`fetchUnits`) | Sin cambios: el mapa no hace fetch propio |
| Feed en vivo acumulado | `packages/dashboard/src/App.tsx:12` (`HISTORY_POINTS = 60`), `:48` (`history`), `:68-74` (`onReading`), `:76-79` (`connectLive`) | Sin cambios: el mapa consume el mismo estado |
| Reloj de la UI | `packages/dashboard/src/App.tsx:53` (`nowMs`), `:57` (`setInterval` de 5 s) | Sin cambios: es la entrada de `readingStatus` |
| Selección cruzada | `packages/dashboard/src/App.tsx:49` (`selected`), `:133` (`onSelect` con toggle), `:105-108` (`selectedUnit`), `:139-155` (sección `detail`) | **Ya está todo**: el mapa solo se engancha |
| `lat`/`lon` en la lectura | `packages/shared/src/types.ts:20-21` (`Telemetry`), `:29-32` (`IngestedReading`) | Tipados `number` **obligatorio**, pero el runtime no lo garantiza (ver §2.5) |
| Defensa runtime de GPS faltante | `packages/dashboard/src/UnitCard.tsx:38-41` (`typeof last.lat === 'number'`) | Patrón a espejar y endurecer |
| Estilo «sin librería si se puede» | `packages/dashboard/src/Sparkline.tsx:9-13` | Precedente explícito del repo, citado en la decisión |
| Tests del dashboard, entorno Node | `packages/dashboard/test/status.test.ts`, `auth.test.ts`, `api.connectLive.test.ts` | **No hay `jsdom` ni `@testing-library`** en ningún workspace; no hay `vitest.config.*` en la raíz ni en los paquetes, así que corre el entorno `node` por defecto |
| Entrada de estilos | `packages/dashboard/src/main.tsx:4` (`import './styles.css'`), `:6-9` (`StrictMode`) | Donde entra el CSS de Leaflet; `StrictMode` obliga a cleanup estricto (§2.2) |
| Build del dashboard | `packages/dashboard/package.json:7` (`tsc --noEmit -p tsconfig.json && vite build`) | Los tipos tienen que cerrar: `tsc` corre sobre `src` (`tsconfig.json:15`) |
| Vite sin plugins extra | `packages/dashboard/vite.config.ts` (solo `@vitejs/plugin-react`) | No hace falta configuración nueva |
| Publicación | `.github/workflows/terraform.yml:164`, `:169-170` (`VITE_API_BASE="http://${ALB}" npm run build` + `aws s3 sync packages/dashboard/dist/`) | Sin cambios: `sync` sube también los PNG que emite el CSS de Leaflet |
| CI de la app | `.github/workflows/terraform.yml:80` (`npm ci`), `:82` (`npm run build`), `:83` (`npm test`) | `npm ci` exige lockfile en sync (§6) |
| Coordenadas del simulador | `packages/simulator/src/telemetry.ts:22-23` (origen), `:41-42` (deriva ±0.001°) | Insumo del encuadre y del centro de fallback |

Lo que **no** existe: ninguna dependencia de mapas, ningún contenedor con altura en `styles.css`, y ningún helper que derive puntos geográficos. El estado por unidad ya está resuelto; esta feature es **presentación**, no lógica de dominio nueva.

## 2. Decisión de diseño

### 2.1 Librería: Leaflet 1.9.4 puro, sin `react-leaflet`

Verificado en el registry de npm en esta sesión (2026-10-20):

| Paquete | Versión | Peers / datos |
|---|---|---|
| `leaflet` | `latest` = **1.9.4**; `alpha` = `2.0.0-alpha.1` (no estable) | sin `module` ni `exports` en el `package.json` publicado; `main: dist/leaflet-src.js`; `style: dist/leaflet.css` |
| `react-leaflet` | `latest` = **5.0.0** | peers `react ^19.0.0`, `react-dom ^19.0.0`, `leaflet ^1.9.0`, dep `@react-leaflet/core ^3.0.0` |
| `react-leaflet` | **4.2.1** (la rama de React 18) | peers `react ^18.0.0`, `react-dom ^18.0.0`, `leaflet ^1.9.0`, dep `@react-leaflet/core ^2.1.0` (peers `react ^18.0.0`) |
| `@types/leaflet` | **1.9.22** | dep `@types/geojson`; cubre Leaflet 1.9 |

El repo está en `react@^18.3.1` / `react-dom@^18.3.1` (`packages/dashboard/package.json:11-14`), así que **`react-leaflet` serviría solo pinneado en `^4.2.1`**: un `npm install react-leaflet` sin pin instala 5.0.0 y rompe los peers.

**Decisión: Leaflet puro dentro de un `useEffect`.** Razones:

1. **La superficie que necesitamos es mínima**: un `L.map`, un `L.tileLayer`, y N `L.circleMarker` en un `L.layerGroup`. Son ~60 líneas imperativas. El valor de `react-leaflet` (children declarativos, contexto, reconciliación de capas) no se paga con una sola capa.
2. **Una dependencia menos y ningún major atado a React.** `react-leaflet@4` está en rama legacy (el `latest` ya es 5). Cuando el repo suba a React 19, con Leaflet puro no hay nada que migrar; con el wrapper hay que saltar a `react-leaflet@5` el mismo día.
3. **Precedente explícito del repo.** `Sparkline.tsx:9-13` dice, en sus propias palabras, que el gráfico se hizo a mano «sin pulling a chart library into the static bundle». La coherencia de estilo vale.
4. **Lo testeable no está en el wrapper.** La lógica que queremos cubrir con tests (qué puntos hay, de qué color, qué bounds) se va a `map.ts` y es pura con o sin `react-leaflet`; el wrapper no aporta testabilidad en un repo sin DOM en los tests.
5. **Peso**: `react-leaflet@4.2.1` suma 11,187 B min / 3,615 B gzip (bundlephobia). No es dramático, pero es gratis no pagarlo.

**Alternativa descartada: `react-leaflet@4.2.1`.** Es técnicamente correcta y compatible. Si el usuario prefiere la ergonomía declarativa, el plan entero sigue valiendo: cambian solo el paso 3 (`UnitsMap.tsx` pasa a `<MapContainer>` + `<TileLayer>` + `<CircleMarker>`), el paso 1 (una dependencia más, pinneada `^4.2.1`) y desaparece el manejo manual de `classList` (§2.4) a cambio de un `key` por estado para forzar el remount del marcador. **Es una decisión del usuario** (ver §9).

**Alternativa descartada: MapLibre GL / Mapbox GL.** Vector tiles, WebGL y ~200 kB gzip adicionales, y además necesita un proveedor de tiles vectoriales con API key (no hay). Desproporcionado para tres marcadores.

**Alternativa descartada: SVG a mano (seguir el camino del `Sparkline`).** Dibujar los puntos sobre una proyección propia sin tiles: cero dependencias, pero sin mapa de fondo no es «un mapa», es un scatter de coordenadas; la propuesta formal pide mapa. Se descarta por no cumplir el requisito.

**Alternativa descartada: Leaflet 2.0.0-alpha.1.** Es ESM nativo y traería tree-shaking, pero es `alpha`. No se mete un alpha en una entrega.

### 2.2 Dónde vive el componente y cómo se monta

- **Nuevo** `packages/dashboard/src/UnitsMap.tsx` (PascalCase, como el resto de los componentes).
- **Nuevo** `packages/dashboard/src/map.ts` (minúscula, como `status.ts` / `auth.ts` / `api.ts`): helpers **puros**, sin `import 'leaflet'` y sin tocar el DOM.
- Se monta en `App.tsx` **arriba de las tarjetas**, entre el `</header>` (`App.tsx:123`) y `<section className="units">` (`App.tsx:125`):

```tsx
<UnitsMap units={units} history={history} nowMs={nowMs} selected={selected}
          onSelect={(id) => setSelected((prev) => (prev === id ? null : id))} />
```

Por qué arriba y no abajo: la sección `detail` aparece y desaparece según `selected` (`App.tsx:139-155`). Si el mapa estuviera debajo, cada selección lo empujaría verticalmente; arriba, su caja nunca cambia de tamaño y no hace falta `map.invalidateSize()`.

**El mapa acompaña a las tarjetas, no las reemplaza.** Las tarjetas son el único lugar donde se ven temperatura, batería, humedad y sparkline (`UnitCard.tsx:26-44`); el mapa aporta ubicación y una lectura de flota de un vistazo. *Decisión del usuario* si prefiere reemplazarlas (§9).

**Ciclo de vida (clave con `StrictMode`, `main.tsx:6-9`):** dos efectos y dos refs.

```
  mount                            cada cambio de units/history/nowMs/selected
   │                                             │
   ▼                                             ▼
 effect A (deps [])                        effect B (deps [units, history, nowMs, selected])
   ├─ L.map(div, {...})                      ├─ mapPoints(units, history, nowMs)   (puro)
   ├─ L.tileLayer(TILE_URL).addTo(map)       ├─ alta/baja/actualización de markers
   ├─ layerGroup().addTo(map)                │    · nuevo  → L.circleMarker(..., {className})
   └─ cleanup: map.remove()                  │    · movido → marker.setLatLng()
                                             │    · cambió status/selección → classList
                                             └─ primer frame con puntos → fitBounds (una sola vez)
```

Sin el `map.remove()` del cleanup, el doble montaje de `StrictMode` en dev tira `Error: Map container is already initialized`. Es el bug clásico y hay que dejarlo escrito en un comentario del código (en inglés).

### 2.3 De dónde salen los datos: props `units` + `history` + `nowMs`

El mapa recibe **exactamente las mismas props que `UnitCard`** (`App.tsx:126-134`), más `selected` y `onSelect`:

```ts
interface Props {
  units: UnitWithReading[];
  history: Record<string, IngestedReading[]>;
  nowMs: number;
  selected: string | null;
  onSelect: (unitId: string) => void;
}
```

Por qué así y no de otra forma:

- **Un solo fetch.** `fetchUnits()` ya se llama una vez (`App.tsx:56`) y el feed ya se acumula en `history` (`App.tsx:68-74`). Un fetch propio del mapa duplicaría tráfico y podría mostrar un estado distinto al de la tarjeta de la misma unidad.
- **Mismo contrato que la tarjeta** = misma fuente de verdad. La posición del marcador sale de `latestReading(unit, history[unit.unit_id] ?? [])`, que es literalmente lo que hoy hace `UnitCard.tsx:17`, extraído a `map.ts` y usado por los dos. Así no pueden divergir.
- **`nowMs` como entrada explícita** (nunca `Date.now()` adentro) es lo que mantiene `readingStatus` pura y los tests sin mocks de reloj (`status.test.ts:51-57` ya testea bordes exactos gracias a eso).
- **Alternativa descartada: `UnitsMap` hace su propio `useState` + `connectLive`.** Abriría un segundo WebSocket por página (`api.ts:114-153` abre uno por llamada), duplicando la carga de la API, que **poll-ea DynamoDB** por unidad suscripta. Descartada.
- **Alternativa descartada: context/`useReducer` global.** No hay context en el repo; sumarlo por un componente es sobre-ingeniería.
- `history` se pasa completo (el `Record`) en vez de armar un `Map` por unidad en `App.tsx`: así `App.tsx` cambia **dos líneas** (import + montaje), que es lo que minimiza el conflicto con el plan de MQTT (§8).

### 2.4 Color por estado: clases CSS, no opciones de color en JS

El estado sale de `readingStatus(last, unit, nowMs)` — la misma llamada de `UnitCard.tsx:18`, sin reimplementar nada.

El color se aplica con la opción `className` de Leaflet y reglas CSS que leen las variables de `styles.css:8-10`:

```ts
// map.ts  (pure, no DOM)
export function markerClass(status: UnitStatus, selected: boolean): string {
  return `unit-marker unit-marker-${status}${selected ? ' unit-marker-selected' : ''}`;
}
```

```css
/* styles.css */
.units-map { height: 360px; border: 1px solid var(--border); border-radius: 10px; margin-bottom: 14px; }
.unit-marker { stroke-width: 2; fill-opacity: 0.55; cursor: pointer; }
.unit-marker-ok        { stroke: var(--ok);        fill: var(--ok); }
.unit-marker-excursion { stroke: var(--excursion); fill: var(--excursion); }
.unit-marker-stale     { stroke: var(--stale);     fill: var(--stale); }
.unit-marker-selected  { stroke: var(--accent); stroke-width: 4; }
```

**Por qué esto funciona (verificado en el fuente de Leaflet 1.9.4, `src/layer/vector/SVG.js`):**

- `_initPath(layer)` hace `DomUtil.addClass(path, layer.options.className)` → la clase llega al `<path>`.
- `_updateStyle(layer)` escribe el color con **atributos de presentación**: `path.setAttribute('stroke', options.color)` y `path.setAttribute('fill', options.fillColor || options.color)`. **Nunca toca `path.style`.** Los atributos de presentación SVG tienen la precedencia más baja de la cascada, así que cualquier regla de stylesheet les gana **sin `!important`**. El `#3388ff` por defecto de `Path` (`src/layer/vector/Path.js`) queda pisado.
- Corolario operativo: **no usar `preferCanvas: true`** en las opciones del mapa. Con el renderer de canvas no hay un elemento por marcador y el truco de la clase no existe. Dejarlo comentado en el código.

Cambio de estado en caliente (una unidad pasa de `ok` a `stale` sin recargar): `setStyle({ className })` **no sirve** (`_updateStyle` no aplica `className`, solo `_initPath` lo hace). Se resuelve con `marker.getElement()` —método público de `Path`, tipado en `@types/leaflet@1.9.22` como `getElement(): Element | undefined`— y `classList.remove/add` sobre las clases que el registro interno sabe que estaban puestas. Nunca se reescribe el atributo `class` completo: Leaflet pone ahí sus propias clases (`leaflet-interactive`, que es la que habilita el click y el cursor) y borrarlas rompería la selección.

**Alternativa descartada: `getComputedStyle(document.documentElement).getPropertyValue('--ok')`.** Tres problemas: (a) devuelve el valor con espacios y hay que `trim()`; (b) obliga a mantener un objeto `{ ok: '--ok', ... }` en TS que es exactamente la duplicación que queremos evitar, solo con nombres de variables en vez de hex; (c) **mete DOM en el camino del color**, y el criterio de este plan es que todo lo testeable corra en Node (`status.ts:1` ya declara el módulo «kept DOM-free for tests»). Queda documentada como plan B si en la verificación manual el inspector mostrara que Leaflet escribe `style=` en vez de atributos (no debería, según el fuente citado).

**Alternativa descartada: `L.divIcon` con `<div>` coloreado por CSS.** También resolvería el color desde la paleta y tiene una API pública limpia para el cambio de estado (`marker.setIcon(...)`). Se descarta por peso: un elemento HTML por unidad escala peor que un `<path>`, y obliga a calcular `iconSize`/`iconAnchor` para centrar el punto sobre la coordenada. Nota: igual que `circleMarker`, evita por completo el problema de los iconos por defecto (abajo).

**El problema conocido de los iconos por defecto de Leaflet, y cómo lo esquivamos.** `L.Icon.Default` no trae las URLs de sus PNG: las **adivina** leyendo el `background-image` de un elemento temporal con la clase `.leaflet-default-icon-path`, que en `leaflet.css` es `url(images/marker-icon.png)` (verificado en `leaflet@1.9.4/dist/leaflet.css`, que tiene exactamente cuatro `url(...)`: `images/layers.png`, `images/layers-2x.png`, `images/marker-icon.png` y el `url(#default#VML)` de IE). Vite reescribe los `url()` del CSS a assets con hash (`marker-icon-<hash>.png`), así que el recorte del sufijo `marker-icon.png` que hace la heurística falla y los marcadores salen roto/invisibles. **Al no usar `L.marker` ni `L.Icon.Default` el problema no existe**, y además `circleMarker` es lo único que nos deja colorear por estado desde CSS. Dos pájaros.

### 2.5 Unidades sin posición

`packages/shared/src/types.ts:20-21` declara `lat: number` y `lon: number` **obligatorios**, pero eso es una promesa del tipo, no del runtime: `GET /api/units` devuelve el ítem de DynamoDB tal como está (`packages/api/src/routes.ts:22` hace `{ ...unit, last_reading: latest.get(unit.unit_id) ?? null }`), así que un ítem viejo o escrito a mano puede no tener los atributos. La tarjeta ya se defiende (`UnitCard.tsx:38-41`).

El filtro del mapa es más estricto que el de la tarjeta, porque **Leaflet tira una excepción con coordenadas inválidas** (`L.latLng` lanza `Invalid LatLng object` si `lat`/`lng` son `NaN`), y `App.tsx` no tiene error boundary: una excepción en el render dejaría el dashboard entero en blanco. Valores fuera de rango (|lat| > 90) no lanzan pero proyectan basura.

```ts
// map.ts
function hasPosition(r: IngestedReading | null): boolean {
  return !!r && Number.isFinite(r.lat) && Number.isFinite(r.lon)
      && Math.abs(r.lat) <= 90 && Math.abs(r.lon) <= 180;
}
```

Comportamiento: **se omiten del mapa y se listan aparte**, debajo del mapa, con contador y los ids:

```tsx
{unpositioned.length > 0 && (
  <p className="empty">{unpositioned.length} unidad(es) sin posición: {unpositioned.join(', ')}</p>
)}
```

Por qué no inventarles una posición ni mandarlas a (0, 0): un marcador en el Golfo de Guinea es información falsa, y en un sistema de cadena de frío la información falsa es peor que la ausencia. Las tarjetas siguen mostrando esas unidades con todos sus datos, así que no se pierde nada.

**Si ninguna unidad tiene posición** (`points.length === 0`): el mapa **se renderiza igual** (contenedor, tiles y atribución) con centro y zoom de fallback, más el mensaje de arriba, que en ese caso dice «N unidades sin posición» con todas. No se desmonta el mapa para que la UI no salte cuando llegue la primera lectura con GPS.

```ts
// map.ts — justified by packages/simulator/src/telemetry.ts:22-23
export const FALLBACK_CENTER: [number, number] = [-34.6037, -58.3816];
export const FALLBACK_ZOOM = 10;
```

El fallback es el origen de las unidades simuladas (`telemetry.ts:22-23`), no un punto arbitrario, así que el mapa vacío muestra la región donde van a aparecer. *Decisión del usuario* si prefiere una vista mundial (`[0, 0]`, zoom 2) para no sugerir una geografía (§9).

### 2.6 Encuadre: `fitBounds` una vez, después solo mover marcadores

- **Inicial:** en el **primer** render con al menos un punto, `map.fitBounds(bounds, { padding: [24, 24], maxZoom: 16 })`; se marca un `didFitRef.current = true` y no se vuelve a encuadrar nunca por su cuenta. Sin puntos, `map.setView(FALLBACK_CENTER, FALLBACK_ZOOM)`.
- **Lecturas nuevas:** solo `marker.setLatLng([lat, lon])`. **No re-encuadra.** Con el feed en vivo llegando cada pocos segundos (`App.tsx:68-74`) y el reloj cada 5 s (`App.tsx:57`), re-encuadrar le arrancaría el mapa de las manos al usuario varias veces por minuto. Es inaceptable.
- **Volver a encuadrar es una acción del usuario:** un botón «Encuadrar» arriba del mapa que llama al mismo `fitBounds` (reusa `boundsOf`). Barato y resuelve el caso «me perdí».
- `maxZoom: 16` no es decorativo: las tres unidades simuladas arrancan **en la misma coordenada** (`telemetry.ts:22-23`) y derivan ±0.001° (`telemetry.ts:41-42`), o sea ±111 m. Sin `maxZoom`, `fitBounds` sobre una caja de ~200 m salta al zoom máximo del tile layer; con 16 (~2.4 m/px) los marcadores quedan a decenas de píxeles, visibles y separados. **Hallazgo anotado, fuera del diff:** si se quiere una demo más vistosa, habría que separar las coordenadas iniciales por unidad en el simulador; eso es un cambio en `packages/simulator` y no entra en este plan.
- `bounds` de un solo punto es degenerado; Leaflet lo acepta y, con `maxZoom`, encuadra en ese nivel.

### 2.7 Selección cruzada tarjeta ↔ marcador

`App.tsx` ya tiene todo (`:49`, `:133`), así que el mapa solo se engancha al mismo par `selected`/`onSelect`:

| Acción | Efecto |
|---|---|
| Click en un marcador | `onSelect(unit_id)` — **el mismo callback de la tarjeta**, con el toggle de `App.tsx:133`: clickear el marcador ya seleccionado deselecciona. Consistencia por construcción |
| `selected` cambia (por tarjeta **o** por marcador) | el marcador gana `.unit-marker-selected` (borde `--accent`, más grueso) y `bringToFront()`; el anterior lo pierde |
| `selected` cambia a una unidad **con** posición | `map.panTo([lat, lon], { animate: true })`, **sin** cambiar el zoom |
| `selected` cambia a una unidad **sin** posición | el mapa no se mueve. La sección `detail` (`App.tsx:139-155`) igual se abre: la selección no es del mapa, es de la app |
| `selected` pasa a `null` | se quita la clase, el mapa no se mueve |

El `panTo` es la única excepción a «el mapa no se mueve solo», y es legítima porque la disparó el usuario. Sin cambio de zoom para no desorientarlo.

Detalle de implementación: el `panTo` tiene que dispararse **solo cuando cambia `selected`**, no en cada tick del reloj. Se guarda el último `selected` aplicado en un `useRef` y se compara; si no, `nowMs` cada 5 s (`App.tsx:57`) estaría re-centrando el mapa.

### 2.8 Tiles de OpenStreetMap, atribución y HTTP vs HTTPS

```ts
// UnitsMap.tsx
const TILE_URL: string = import.meta.env.VITE_TILE_URL ?? 'https://tile.openstreetmap.org/{z}/{x}/{y}.png';
const ATTRIBUTION = '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors';
L.tileLayer(TILE_URL, { attribution: ATTRIBUTION, maxZoom: 19 }).addTo(map);
```

Todo lo de abajo sale de la **Tile Usage Policy** de la OSM Foundation (`operations.osmfoundation.org/policies/tiles/`), consultada en esta sesión:

- **URL exacta:** `https://tile.openstreetmap.org/{z}/{x}/{y}.png`. La política pide usar esa y **no** la versión HTTP. También **recomienda no hardcodearla**, para poder cambiar de proveedor sin recompilar: de ahí el override por `VITE_TILE_URL`, que además calca el patrón de `api.ts:12` (`import.meta.env.VITE_API_BASE`).
- **Atribución: es un requisito, no un adorno.** Tiene que estar visible sobre el mapa (típicamente abajo a la derecha), sin esconderla detrás de un toggle, ni taparla con otro elemento, ni sacarla de pantalla. Consecuencia concreta para este repo: el control de atribución de Leaflet viene con fondo blanco semitransparente, que sobre el tema oscuro (`styles.css:1-12`) queda incoherente; **se le puede dar contraste** con `.leaflet-control-attribution { background: rgba(23, 31, 46, 0.85); color: var(--muted); }` y `.leaflet-control-attribution a { color: var(--accent); }`, pero **jamás `display: none`** ni opacidad que la haga ilegible.
- **Referer:** la política exige que el navegador mande un `Referer` válido y que el sitio no lo bloquee. El dashboard se sirve por **HTTP** desde S3 Website y los tiles por **HTTPS**; con la política de referrer por defecto de los navegadores (`strict-origin-when-cross-origin`) ese caso **sí manda el origen**: según el algoritmo de la spec (W3C Referrer Policy, §8.3) el `Referer` se descarta solo cuando *el referrer es potentially trustworthy y el destino no lo es* (HTTPS→HTTP). Acá el referrer es HTTP (no trustworthy), así que no entra en esa rama y el algoritmo devuelve el origen: el tile server recibe `Referer: http://snowball-dashboard-<sufijo>.s3-website-us-east-1.amazonaws.com/`. **Queda en el checklist manual verificarlo en DevTools** — es la clase de afirmación que no se defiende de memoria.
- **User-Agent:** el requisito de UA propio aplica a aplicaciones; una página web manda el UA del navegador, que es válido. Nada que hacer.
- **No se bajan tiles en bulk**, no se pre-siembran áreas ni se cachean fuera del navegador. El uso es interactivo, con 3 unidades y un puñado de usuarios: muy por debajo de «heavy use». Aun así, para la defensa conviene decirlo tal cual: el servidor de OSM es *best effort*, sin SLA, y para producción real correspondería un proveedor comercial o self-hosting.

**Mixed content: no hay.** «Mixed content» es, por definición, una subrequest **insegura** desde un **contexto seguro** (HTTPS cargando HTTP). Lo nuestro es al revés: una página HTTP cargando un recurso HTTPS, y la doc de MDN lo dice explícito — «no hay restricción para cargar un contexto seguro dentro de un contexto insecure». Nada se bloquea y nada se advierte por mixed content. (Lo que sí va a aparecer en la consola es la advertencia genérica de sitio no seguro por el HTTP del propio dashboard y de la API, que ya existe hoy y es un hueco conocido, fuera de alcance acá.)

**¿Los tiles cargan sin internet?** No. Los tiles los baja **el navegador del usuario** desde `tile.openstreetmap.org`; no pasan por la VPC, ni por el ALB, ni por la API. Consecuencias: (a) si la máquina del usuario no tiene internet, el mapa queda gris pero **los marcadores se siguen dibujando** (son SVG, no dependen de los tiles) y el dashboard no se rompe; (b) nada hay que abrir en security groups ni en la VPC; (c) el mapa **no** funciona en una demo offline, lo cual conviene saber antes de la defensa y está en el checklist.

### 2.9 Qué lógica se extrae a helpers puros (y por qué no se agrega `jsdom`)

Verificado: `packages/dashboard/test/` tiene `status.test.ts`, `auth.test.ts` y `api.connectLive.test.ts`; no hay `vitest.config.*` en la raíz ni en ningún paquete, así que vitest corre con el entorno **`node`** por defecto y no hay `jsdom` ni `@testing-library` en ningún `package.json` del repo. **Este plan no cambia eso.** Todo lo testeable sale del componente a `packages/dashboard/src/map.ts`, que **no importa `leaflet` ni toca `document`**.

Firmas exactas de `packages/dashboard/src/map.ts`:

```ts
import type { IngestedReading } from '@snowball/shared';
import type { UnitWithReading } from './api';
import { readingStatus, type UnitStatus } from './status';

/** One unit rendered on the map: already positioned and already classified. */
export interface MapPoint {
  unit_id: string;
  lat: number;
  lon: number;
  status: UnitStatus;
}

/** Plain bounds, so this module stays free of Leaflet types. */
export interface MapBounds {
  south: number;
  west: number;
  north: number;
  east: number;
}

/** The live tail wins over the snapshot from /api/units; mirrors UnitCard. */
export function latestReading(unit: UnitWithReading, history: IngestedReading[]): IngestedReading | null;

/** Single pass: positioned points (with status) and the ids left out. */
export function mapPoints(
  units: UnitWithReading[],
  history: Record<string, IngestedReading[]>,
  nowMs: number,
): { points: MapPoint[]; unpositioned: string[] };

/** null when there is nothing to frame. */
export function boundsOf(points: MapPoint[]): MapBounds | null;

/** The only place that names a marker CSS class. */
export function markerClass(status: UnitStatus, selected: boolean): string;

export const FALLBACK_CENTER: [number, number];
export const FALLBACK_ZOOM: number;
```

`UnitsMap.tsx` queda reducido a lo que **no** se puede testear sin DOM: crear el mapa, el tile layer, dar de alta/baja marcadores, mover `setLatLng`, mover clases y llamar `fitBounds`/`panTo`. Eso se verifica a mano en el navegador (§8).

**`jsdom` no se agrega.** Y no alcanzaría igual: Leaflet necesita medidas de layout reales y `jsdom` no implementa layout, así que un test de `UnitsMap` contra `jsdom` terminaría en mocks de `getBoundingClientRect` — mucho andamio para cubrir cuatro llamadas a Leaflet. **Si el usuario quiere `jsdom`, es su decisión y suma dependencias de dev a todo el repo** (§9); este plan no lo necesita.

### 2.10 CSS de Leaflet y qué emite `vite build`

`import 'leaflet/dist/leaflet.css'` va en **`main.tsx`**, inmediatamente **antes** de `import './styles.css'` (`main.tsx:4`). Dos razones: el orden de los imports determina el orden en el CSS final, y queremos que nuestras reglas (`.unit-marker-*`, los overrides del control de atribución) vengan **después** de las de Leaflet y le ganen por cascada sin `!important`. Importarlo dentro de `UnitsMap.tsx` dejaría el orden a merced del grafo de módulos.

Que `vite build` lo emita al bundle de CSS no es magia, pero tampoco hay que afirmarlo de memoria. Lo que sostiene la afirmación:

1. La doc de Vite (guide/features, «CSS») dice que importar un `.css` inyecta su contenido, y que **todos los `url()` del CSS se rebasean automáticamente**, incluso si los archivos importados están en otros directorios. Eso cubre los cuatro `url()` de `leaflet.css`: los PNG de `leaflet/dist/images/` salen como assets con hash en `dist/assets/`.
2. `build.cssCodeSplit` extrae CSS **por chunk async**. El dashboard no tiene ningún `import()` dinámico, así que hay un solo chunk y un solo CSS: coincide con el `dist/` actual, que tiene exactamente `assets/index-*.js` + `assets/index-*.css`.
3. Como `leaflet@1.9.4` no declara `exports` en su `package.json` (verificado en el registry y en unpkg), el subpath `leaflet/dist/leaflet.css` es importable sin restricciones de export map.

**Queda como criterio de aceptación verificable**, no como acto de fe: después del build, `dist/assets/index-*.css` tiene que contener `.leaflet-container` y pesar ~18 kB en vez de 3.10 kB (§7).

Nota de implementación chica: el contenedor **necesita altura explícita** (`.units-map { height: 360px }`). Sin eso el `<div>` mide 0 px y el mapa simplemente no se ve. Es el error número uno con Leaflet.

### 2.11 Tipos: `@types/leaflet` y `tsc --noEmit`

- `leaflet@1.9.4` **no** trae tipos (sin `types`/`typings` en su `package.json`), así que hace falta `@types/leaflet` (`^1.9.22`) como **devDependency**, al lado de `@types/react` (`packages/dashboard/package.json:15-21`).
- `packages/dashboard/tsconfig.json:13` tiene `"types": ["vite/client"]`. **Eso no bloquea `@types/leaflet`**: la lista `types` solo restringe la inclusión automática de paquetes de **tipos globales**; la resolución de `import * as L from 'leaflet'` pasa por la resolución de módulos normal, que cae en `node_modules/@types/leaflet/index.d.ts`. Igual es un riesgo barato de verificar: lo confirma el propio `npm run build -w @snowball/dashboard`.
- Verificado en `@types/leaflet@1.9.22` que existe todo lo que usa el plan: `Path.getElement(): Element | undefined`, `PathOptions.className?: string`, `circleMarker(latlng, options?: CircleMarkerOptions)` con `radius?: number`, `attribution` en `LayerOptions` y `maxZoom` en `GridLayerOptions`.
- `tsconfig.json:15` tiene `include: ["src"]`, así que `tsc --noEmit` typechequea `map.ts` y `UnitsMap.tsx` **pero no** `test/map.test.ts` (vitest tampoco typechequea). Un error de tipos en el test no rompe el build; conviene saberlo para no confiarse.

### 2.12 Decisiones tomadas (2026-10-20)

| Decisión | Elección | Por qué |
|---|---|---|
| Librería | **`leaflet@^1.9.4` puro**, sin `react-leaflet` | El mapa es un tile layer + N markers; una dependencia menos, nada atado a React 18, y mismo criterio que `Sparkline.tsx:9-13` |
| Tipos | `@types/leaflet@^1.9.22` (devDependency) | Leaflet 1.9.4 no publica tipos y el build corre `tsc --noEmit` (`package.json:7`) |
| Tipo de marcador | `L.circleMarker` con `className` | Liviano, sin anchors, y **evita** la heurística de `L.Icon.Default` que los bundlers rompen |
| Renderer | SVG (default); **nunca `preferCanvas: true`** | Con canvas no hay elemento por marcador y el color por CSS no existe |
| Origen del color | Clases CSS que leen `var(--ok|--excursion|--stale)` | Leaflet pone el color como **atributo** (`SVG.js` `_updateStyle`), que pierde contra cualquier regla CSS → cero hex en TS |
| CSS de Leaflet | `import 'leaflet/dist/leaflet.css'` en `main.tsx`, antes de `styles.css` | Orden de cascada determinístico; nuestras reglas últimas |
| Alto del contenedor | `.units-map { height: 360px }` en `styles.css` | Sin altura el mapa mide 0 px |
| Datos | Props `units` + `history` + `nowMs` + `selected` + `onSelect` | Mismo contrato que `UnitCard` (`App.tsx:126-134`): una sola fuente de verdad, ningún fetch ni WebSocket nuevo |
| Última lectura | `latestReading()` en `map.ts`, usado por el mapa **y** por `UnitCard.tsx:17` | Que la tarjeta y el marcador no puedan divergir |
| Estado | `readingStatus` de `status.ts:23-33`, sin tocar | Es la regla del repo y ya contempla `signal_timeout_min` |
| Sin GPS | Fuera del mapa + línea «N unidades sin posición» con los ids | Un marcador falso es peor que ninguno; las tarjetas siguen mostrándolas |
| Validación de coordenadas | `Number.isFinite` + rango | `L.latLng` lanza con `NaN` y `App.tsx` no tiene error boundary |
| Mapa vacío | Se renderiza igual, `FALLBACK_CENTER` = origen del simulador (`telemetry.ts:22-23`), zoom 10 | La UI no salta cuando llega la primera posición |
| Encuadre inicial | `fitBounds(bounds, { padding: [24,24], maxZoom: 16 })`, **una sola vez** | Las 3 unidades simuladas arrancan en el mismo punto con deriva de ±111 m (`telemetry.ts:41-42`) |
| Lecturas nuevas | Solo `setLatLng`; **nunca** re-encuadra | Re-encuadrar con el feed en vivo le arranca el mapa al usuario |
| Re-encuadrar | Botón «Encuadrar» | La única forma honesta: que lo pida el usuario |
| Selección | Click en marcador → el **mismo** `onSelect` con toggle de `App.tsx:133`; clase `.unit-marker-selected` + `bringToFront()` + `panTo` sin cambiar zoom | Cero estado nuevo; `detail` (`App.tsx:139-155`) ya reacciona |
| Ubicación en el layout | Arriba de `<section className="units">` (`App.tsx:125`) | La sección `detail` aparece/desaparece; abajo empujaría el mapa |
| Mapa vs tarjetas | **Acompaña**, no reemplaza | Las tarjetas son el único lugar con temp/batería/humedad/sparkline (`UnitCard.tsx:26-44`) |
| Tiles | `https://tile.openstreetmap.org/{z}/{x}/{y}.png`, override por `VITE_TILE_URL` | La política de OSM exige esa URL y **recomienda no hardcodearla**; calca `api.ts:12` |
| Atribución | Visible siempre; se le da contraste, nunca se oculta | Requisito de uso de OSM, no un detalle de diseño |
| Tests | Helpers puros en `map.ts` + `test/map.test.ts`, entorno Node | Estilo del repo; **no se agrega `jsdom`** |

## 3. Cambios, archivo por archivo

### `packages/dashboard`

1. **`package.json`** — `leaflet: "^1.9.4"` en `dependencies` (junto a react/react-dom, `:11-14`) y `@types/leaflet: "^1.9.22"` en `devDependencies` (`:15-21`). Instalar de verdad, no editar a mano: `npm install -w @snowball/dashboard leaflet@^1.9.4` y `npm install -D -w @snowball/dashboard @types/leaflet@^1.9.22`, y **commitear `package-lock.json`** (si no, `npm ci` del CI falla, §6).

2. **`src/map.ts` (nuevo)** — los helpers puros con las firmas de §2.9. Sin `import 'leaflet'`, sin `document`, sin `Date.now()`. Comentario de cabecera en inglés al estilo de `status.ts:1`.

3. **`src/UnitsMap.tsx` (nuevo)** — el componente. Estructura:
   - `containerRef` (`<div className="units-map" />`), `mapRef`, `markersRef: Map<string, { marker: L.CircleMarker; status: UnitStatus; selected: boolean }>`, `didFitRef`, `lastSelectedRef`.
   - Efecto A (`[]`): `L.map(container, { preferCanvas: false })`, `L.tileLayer(TILE_URL, { attribution: ATTRIBUTION, maxZoom: 19 })`, `L.layerGroup()`, `setView(FALLBACK_CENTER, FALLBACK_ZOOM)`; **cleanup `map.remove()`** (obligatorio por `StrictMode`, `main.tsx:6-9`).
   - Efecto B (`[units, history, nowMs, selected]`): `mapPoints(...)`; alta (`L.circleMarker(..., { radius: 7, weight: 2, className: markerClass(status, isSelected) })` + `on('click', () => onSelect(id))`), baja (`layer.removeLayer`), movimiento (`setLatLng`), swap de clases por `getElement()?.classList` cuando cambió `status` o `selected`, `bringToFront()` del seleccionado, `fitBounds` solo si `!didFitRef.current && points.length > 0`, y `panTo` solo si `selected !== lastSelectedRef.current`.
   - Render: el `<div>` del mapa, el botón «Encuadrar» (deshabilitado si no hay puntos) y la línea de unidades sin posición.
   - Comentarios en inglés explicando: por qué `circleMarker` y no `L.marker` (iconos por defecto + bundler), por qué el color vive en CSS, y por qué no se re-encuadra.

4. **`src/UnitCard.tsx:17`** — reemplazar la expresión por `const last = latestReading(unit, history);` e importar de `./map`. Una línea; garantiza que tarjeta y marcador miren la misma lectura.

5. **`src/App.tsx`** — dos líneas: `import { UnitsMap } from './UnitsMap';` (junto a los imports de componentes, `:5-10`) y el montaje antes de `<section className="units">` (`:125`), pasando el mismo `onSelect` de `:133`. **Nada más**: ni estado nuevo, ni efectos, ni cambios en `connectLive` (`:76-79`) — a propósito, por §8.

6. **`src/main.tsx`** — `import 'leaflet/dist/leaflet.css';` **antes** de `import './styles.css';` (`:4`).

7. **`src/styles.css`** — al final, un bloque nuevo: `.units-map` (alto 360 px, borde y radio como `.detail`, `:67`), `.unit-marker` + `.unit-marker-ok|-excursion|-stale|-selected` (solo `var(--…)`, ningún hex nuevo), overrides de contraste para `.leaflet-control-attribution` y `.leaflet-control-zoom` sobre el tema oscuro, y `.map-toolbar` para el botón «Encuadrar» (reusando `button.link`, `:81`).

8. **`test/map.test.ts` (nuevo)** — §4.

### Documentación

9. **`README.md:73`** — la fila de `packages/dashboard` pasa a decir «tarjetas por unidad **y mapa de unidades coloreado por estado (Leaflet + tiles de OpenStreetMap)**, feed en vivo, historial y alertas». **`README.md:61`** — agregar la fila de este documento en la tabla de Documentación.
10. **`README.md`, sección «Pendiente»** (`:550` y siguientes) — si quedara algún ítem de mapa, bajarlo; y dejar dicho en una línea que **los tiles los baja el navegador del usuario**, así que el mapa necesita internet del lado del cliente (no de la VPC).
11. **`docs/features-faltantes-propuesta.md:19`** — en la fila 5, sacar «el mapa de unidades por estado» de la lista de faltantes (la fila sigue 🟡 mientras F5-B y F5-C no estén). **`:48`** — marcar hecha la prioridad 2. **`:53`** — sacar «El mapa» de la lista de «todavía no tienen plan escrito» y linkear este documento.

**Lo que explícitamente NO se toca:** `packages/dashboard/src/api.ts`, `packages/api/**`, `packages/shared/**`, `terraform/**`, `.github/workflows/**`, `scripts/**`. El workflow (`:169-170`) publica el `dist/` con `aws s3 sync` y eso ya sube los assets nuevos (los PNG del CSS de Leaflet) sin ningún cambio.

## 4. Tests nuevos

**`packages/dashboard/test/map.test.ts`** (vitest, entorno Node, sin mocks, sin `import 'leaflet'`):

| `describe` | Casos |
|---|---|
| `latestReading` | (a) con historial, devuelve el **último** punto del historial y no `last_reading`; (b) historial vacío → `last_reading`; (c) historial vacío y `last_reading: null` → `null`; (d) no muta el array de historial |
| `mapPoints` | (a) tres unidades con GPS → tres puntos **en el orden de `units`** (el mapa no reordena); (b) `lat` ausente, `null`, `NaN`, `Infinity` y fuera de rango (`lat: 91`, `lon: -181`) → van a `unpositioned`, no a `points`; (c) `last_reading: null` → `unpositioned`; (d) el `status` sale de `readingStatus`: en rango y reciente → `ok`, fuera de rango → `excursion`, vieja → `stale`; (e) una unidad con `last_reading` viejo pero con un punto **fresco en `history`** sale `ok` (prueba que gana el feed en vivo); (f) `signal_timeout_min` de la unidad corre el borde de `stale` (espeja `status.test.ts:32-43`); (g) `units: []` → `{ points: [], unpositioned: [] }`; (h) `unpositioned` trae los `unit_id` en orden |
| `boundsOf` | (a) `[]` → `null`; (b) un punto → bounds degenerados (`south === north`, `west === east`); (c) varios → min/max correctos con **lat/lon negativas** (Buenos Aires, el caso real: `telemetry.ts:22-23`); (d) cruce de signos (`lon: -58` y `lon: 2`) |
| `markerClass` | (a) `('ok', false)` → `'unit-marker unit-marker-ok'` exacto; (b) los tres estados; (c) `selected: true` agrega `' unit-marker-selected'` **sin** perder la clase de estado. Comparación por string exacto a propósito: es el contrato con `styles.css` y si alguien renombra una clase el test lo caza |

Fixtures a mano en el archivo, al estilo de `status.test.ts:4` (`const unit = { temp_min_c: -25, temp_max_c: -15 }`): un helper local `makeUnit(id, overrides)` y `makeReading(ts, overrides)`, sin importar nada de `packages/api`.

No hay test nuevo de `status.ts` (no se modifica) ni de `UnitCard` (el cambio es sustituir una expresión por el helper que este archivo ya cubre).

## 5. Orden de implementación

Tres tandas; dentro de cada una es paralelizable, entre tandas no.

1. **Dependencias** (paso 1): `npm install` real + `package-lock.json`. Bloquea todo lo demás; es lo único que puede romper el `npm ci` del CI.
2. **Lógica pura + tests** (pasos 2 y 8): `map.ts` y `map.test.ts`. Se valida con `npm test -w @snowball/dashboard`, sin navegador y sin AWS. **Se puede hacer antes que la tanda 1** porque `map.ts` no importa `leaflet`.
3. **Componente, montaje y estilos** (pasos 3-7) y luego **docs** (pasos 9-11). Depende de 1 y 2.

## 6. Impacto en CI y riesgos

El CI que tiene que seguir en verde: job `validate` (terraform, intacto: este plan no toca `terraform/`) y job `app` (`.github/workflows/terraform.yml:80-83`: `npm ci` → `npm run build` → `npm test`).

| Riesgo | Probabilidad | Mitigación / detección |
|---|---|---|
| **`npm ci` falla por lockfile desincronizado** — es el riesgo #1: `npm ci` aborta si `package.json` y `package-lock.json` no coinciden | Alta si se edita `package.json` a mano | Instalar con `npm install -w @snowball/dashboard ...` y commitear el lock. Se detecta local con `npm ci` en la raíz |
| **`tsc --noEmit` no resuelve los tipos de `leaflet`** por el `types: ["vite/client"]` de `tsconfig.json:13` | Baja (esa lista solo afecta tipos globales) | `npm run build -w @snowball/dashboard` local antes de pushear. Si fallara, el arreglo es declarar el módulo o ajustar `paths`, **no** agregar `leaflet` a `types` (no cambiaría la resolución del módulo) |
| Error de tipos en `test/map.test.ts` que el CI no ve (`tsconfig.json:15` solo incluye `src`; vitest no typechequea) | Media | Mantener los fixtures del test simples y tipados con `UnitWithReading`/`IngestedReading` |
| `react-leaflet` instalado sin pin se va a 5.0.0 y rompe los peers de React 18 | Nula con este plan (no se instala) | Si el usuario elige el wrapper: pin **exacto** `^4.2.1` |
| El bundle crece ~1.9x y alguien lo toma como regresión | Alta de que se note, nula de que rompa | §7 lo pone como número esperado y no como falla |
| Vite warnea por el `url(#default#VML)` de `leaflet.css` (fragmento, no asset) | Baja | Es un warning, no un error; Vite ignora URLs que empiezan con `#` |
| Conflicto de merge en `App.tsx` / `package-lock.json` con el plan de MQTT | Media | §8 |

Lo que el CI **no** puede verificar y queda para la verificación manual: que los tiles carguen, que los colores salgan de la paleta, que la atribución se vea, que el `fitBounds` encuadre bien y que la selección cruzada funcione.

## 7. Impacto en el tamaño del bundle

Medido en esta sesión sobre `packages/dashboard/dist/assets/`: `index-bA9J42tP.js` = **158,212 B** (158.21 kB; 51.23 kB gzip) y `index-BYV7esMf.css` = **3,102 B** (3.10 kB).

Números de npm / bundlephobia (consultados hoy):

| Pieza | Minificado | Gzip |
|---|---|---|
| `leaflet@1.9.4` | 148,515 B | 42,736 B |
| `react-leaflet@4.2.1` (si se eligiera) | 11,187 B | 3,615 B |
| `leaflet@1.9.4/dist/leaflet.css` | 14,806 B (sin minificar) | ~4 kB |
| PNGs del CSS (`layers`, `layers-2x`, `marker-icon`, `marker-icon-2x`, `marker-shadow`) | 6,503 B en total | — (ya comprimidos) |

Proyección: **JS 158.21 kB → ~306 kB** (~94 kB gzip), **CSS 3.10 kB → ~18 kB**, más ~6.5 kB de PNG como assets separados. Casi 2x en JS. Y es **el total de Leaflet**, sin descuento: `leaflet@1.9.4` no publica `module` ni `exports` y su `main` es el UMD `dist/leaflet-src.js`, así que Rollup no puede tree-shakearlo — no existe «importar solo `circleMarker`». (Importar `leaflet/dist/leaflet-src.esm.js` sí sería tree-shakeable, pero rompe la resolución de `@types/leaflet`; no vale la pena.)

**¿Importa en un S3 Website sin CDN?** Hay que decirlo con precisión, porque es materia de defensa:

- **S3 Website no comprime al vuelo.** No hay CloudFront en el Learner Lab, y S3 devuelve el objeto tal cual, sin `Content-Encoding`, salvo que se suban archivos pre-comprimidos con el header puesto. O sea que **las cifras de gzip son irrelevantes hoy**: el navegador baja los ~306 kB crudos. El `aws s3 sync` del workflow (`:170`) sube tal cual.
- En términos absolutos sigue siendo poco: 306 kB de JS + 18 kB de CSS en un sitio interno de monitoreo, servido desde `us-east-1`. Son ~150 kB más que hoy, una sola vez por deploy (los nombres tienen hash, así que el navegador cachea hasta el siguiente deploy).
- **Los tiles dominan la transferencia, no el bundle.** Cada PNG de OSM pesa ~10-25 kB y un viewport de ~1000×400 px necesita del orden de 12-20 tiles: **200-400 kB en el primer encuadre**, y más a cada paneo. Optimizar 150 kB de JS mientras el mapa baja eso en tiles sería optimizar la pieza equivocada.
- Opciones si el usuario quiere acotarlo (ninguna incluida en este plan): (a) subir pre-comprimido (`gzip` + `aws s3 sync --content-encoding gzip`), que es un cambio en el workflow; (b) cargar `UnitsMap` con `import()` dinámico para que Leaflet quede en un chunk aparte — no baja los bytes totales, solo los corre del first paint, y además activaría el CSS code-splitting (un segundo archivo CSS).

**Es una decisión del usuario** si fija un presupuesto de kB (§9). Mi recomendación: aceptar el crecimiento, dejarlo medido en el README y no complicar el pipeline.

## 8. Solapamiento con otros planes

| Archivo | Este plan | plan-mqtt (F5-C) | plan-replica (F5-B) | Cómo se ordena |
|---|---|---|---|---|
| `packages/dashboard/src/App.tsx` | **2 líneas**: un import (`:5-10`) y el montaje de `<UnitsMap>` antes de `:125` | Probable: `connectLive` (`:76-79`), `onReading` (`:68-74`), estado de conexión (`:51`, `:117-119`) | No lo toca | Zonas distintas del archivo, pero **mismo archivo**: conviene **secuencial, primero el mapa** (es el cambio chico y aislado) y después MQTT. Si van en paralelo, el reparto es: el mapa toca solo el bloque JSX de `:113-137` y la lista de imports; MQTT no toca ese bloque |
| `packages/dashboard/src/api.ts` | **No lo toca** | Sí: `connectLive` (`:114-153`) o un cliente nuevo | No lo toca | **Sin conflicto.** Es deliberado: el mapa consume `history` desde las props, así que le da igual si el feed es el WebSocket de la API o MQTT |
| `packages/dashboard/package.json` + `package-lock.json` | `leaflet`, `@types/leaflet` | Probable `mqtt` (y sus tipos) | No lo toca | **Conflicto garantizado en el lockfile.** Que un solo agente corra el `npm install` final, o que se hagan en serie y el segundo rebase el lock |
| `packages/dashboard/src/styles.css` | Bloque nuevo al final | Posible (badge de conexión) | No lo toca | Appends al final: conflicto trivial |
| `packages/dashboard/src/main.tsx` | 1 línea (CSS de Leaflet) | Improbable | No lo toca | Sin conflicto |
| `packages/dashboard/src/UnitCard.tsx` | 1 línea (`:17`) | Improbable | No lo toca | Sin conflicto |
| `README.md`, `docs/features-faltantes-propuesta.md` | Filas 5 / `:19`, `:48`, `:53`, `:61`, `:73` | Las mismas filas | Las mismas filas | **Los tres escriben las mismas líneas.** Mejor que los tres editen y el orquestador consolide la fila 5 **una sola vez al final** |
| `.github/workflows/terraform.yml` | **No lo toca** | Posible | **Sí** (`:164-178`) | Sin conflicto con este plan |
| `terraform/**`, `scripts/**` | **No los toca** | Sí | Sí | Sin conflicto |

Nota para F5-B: el mapa es 100 % estático y no depende de la región. El mismo `dist/` replicado en `us-west-2` funciona idéntico; los tiles salen del navegador del usuario hacia OSM y la URL de tiles no cambia por región.

## 9. Decisiones que son del usuario

1. **`react-leaflet@4.2.1` en vez de Leaflet puro.** Compatible y ergonómico; cuesta una dependencia más (+2 paquetes, +3.6 kB gzip) y queda pinneado a un major legacy (el `latest` es 5.0.0, que pide React 19). Mi recomendación: Leaflet puro.
2. **Presupuesto de kB.** ¿Se acepta JS 158 kB → ~306 kB sin comprimir en S3 Website? ¿Se agrega pre-gzip al workflow? Mi recomendación: aceptar y documentar.
3. **¿El mapa reemplaza a las tarjetas o las acompaña?** Mi recomendación: acompaña (el mapa arriba, las tarjetas abajo); las tarjetas son el único lugar con temperatura, batería, humedad y sparkline.
4. **Centro del mapa vacío:** Buenos Aires (origen del simulador, `telemetry.ts:22-23`) con zoom 10, o vista mundial neutra. Mi recomendación: Buenos Aires con zoom 10, que es donde van a aparecer las unidades.
5. **`jsdom`.** Este plan **no** lo necesita y recomiendo no agregarlo: cambiaría el entorno de tests de todo el repo y, para Leaflet, no alcanzaría sin mockear layout.
6. **Separar las coordenadas iniciales por unidad en el simulador** (hoy las tres arrancan en el mismo punto con deriva de ±111 m). Es un cambio en `packages/simulator/src/telemetry.ts` y **queda fuera de este plan**; sin él, la demo muestra tres marcadores casi superpuestos a zoom 16.
7. **Proveedor de tiles.** Se usa el servidor público de OSM (best effort, sin SLA, sujeto a su política de uso). Si se quiere algo con garantías habría que pagar un proveedor o self-hostear: con el `VITE_TILE_URL` previsto, es cambiar una variable de entorno.

## 10. Criterios de aceptación verificables

Sin credenciales de AWS, en esta máquina:

1. `npm ci` en la raíz termina sin error (lockfile en sync).
2. `npm run build` en la raíz en verde — incluye `tsc --noEmit -p tsconfig.json && vite build` del dashboard (`packages/dashboard/package.json:7`).
3. `npm test` en la raíz en verde, con `test/map.test.ts` incluido y **sin** agregar dependencias de test (`grep -rn "jsdom\|@testing-library" packages/*/package.json` → sin resultados).
4. **Cero colores nuevos en TS:** `grep -nE "#[0-9a-fA-F]{3,6}" packages/dashboard/src/UnitsMap.tsx packages/dashboard/src/map.ts` → sin resultados. Y los únicos colores en el CSS nuevo son `var(--ok|--excursion|--stale|--accent|--border|--muted|--panel)`.
5. **El helper es DOM-free:** `grep -n "leaflet\|document\|window" packages/dashboard/src/map.ts packages/dashboard/test/map.test.ts` → sin resultados. Esto es lo que garantiza que los tests corran en Node.
6. **No se duplica la lógica de estado:** `grep -rn "readingStatus" packages/dashboard/src` muestra `status.ts` (definición), `UnitCard.tsx:18` y `map.ts`, y ningún otro lugar que recalcule `ok`/`excursion`/`stale`.
7. **El CSS de Leaflet entra al bundle:** después del build, `grep -c "leaflet-container" packages/dashboard/dist/assets/index-*.css` ≥ 1, el archivo pesa ~18 kB (vs 3,102 B hoy) y `ls packages/dashboard/dist/assets/` muestra los PNG con hash.
8. **Tamaño esperado, no sorpresa:** `ls -l packages/dashboard/dist/assets/index-*.js` ≈ 300-320 kB (desde 158,212 B). Si sale muy por encima, algo extra se colgó del bundle.
9. `npm run dashboard` (modo dev, con la API local): el mapa aparece arriba de las tarjetas, con alto 360 px, un marcador por unidad con GPS, tiles de OSM y la atribución visible abajo a la derecha.
10. En dev con `StrictMode` (`main.tsx:6-9`) **no** aparece `Map container is already initialized` en la consola (prueba que el cleanup `map.remove()` está).
11. Cambiar el umbral o esperar el `signal_timeout_min` de una unidad pone su marcador gris (`--stale`) **al mismo tiempo** que la tarjeta cambia a «sin señal» (`UnitCard.tsx:14`): es la prueba de que comparten `readingStatus`.
12. Click en un marcador → la tarjeta correspondiente queda `selected` (borde `--accent`, `styles.css:45`) y se abre la sección `detail` (`App.tsx:139-155`); click de nuevo en el mismo marcador → deselecciona (toggle de `App.tsx:133`). Click en la tarjeta → el marcador queda resaltado y el mapa hace `panTo` sin cambiar el zoom.
13. Mover el mapa a mano y esperar varias lecturas en vivo: **el encuadre no se mueve solo**; los marcadores sí se desplazan. El botón «Encuadrar» vuelve a encuadrar.
14. Con una unidad sin `lat`/`lon` en su última lectura: no hay marcador y abajo del mapa dice «1 unidad(es) sin posición: SB-00X». Con **ninguna** unidad posicionada: el mapa se muestra igual, centrado en el fallback, con el mensaje listando todas.

## 11. Checklist de verificación manual en AWS

Nada de esto se puede probar en esta sesión: no hay credenciales y el Learner Lab vence a las ~4 h. Con credenciales frescas:

1. `terraform apply` (o el workflow con `action=apply`) y dejar que corra el paso «Compilar y publicar el dashboard» (`.github/workflows/terraform.yml:164-170`). **No hace falta ningún cambio de infra para esta feature**; el `aws s3 sync` sube los assets nuevos solo.
2. `aws s3 ls s3://$(terraform -chdir=terraform output -raw dashboard_bucket)/assets/` → aparecen el `index-*.js`, el `index-*.css` y los PNG de Leaflet con hash.
3. `aws s3api head-object --bucket <bucket> --key assets/<marker-icon-hash>.png` → `ContentType: image/png` (el `sync` lo infiere por extensión; si saliera `binary/octet-stream`, los iconos del control de capas se verían mal — los marcadores, que son SVG, no).
4. Abrir `http://<bucket>.s3-website-us-east-1.amazonaws.com` y, en DevTools:
   - **Network:** requests a `https://tile.openstreetmap.org/...` con **200** (si hubiera 418/403, OSM está bloqueando: revisar Referer y volumen).
   - En el request de un tile, confirmar el header **`Referer: http://<bucket>.s3-website-us-east-1.amazonaws.com/`** presente. Esto es lo que valida la afirmación de §2.8 sobre HTTP→HTTPS y el requisito de OSM.
   - **Console:** ninguna advertencia de *mixed content* por los tiles (la de «sitio no seguro» por el HTTP propio del dashboard y de la API sigue, y es un hueco conocido fuera de alcance).
   - **Elements:** inspeccionar un `<path>` de marcador: tiene `class="unit-marker unit-marker-ok leaflet-interactive"` y el `stroke` **computado** resuelve a `#34c98e` aunque el atributo diga `#3388ff`. Si en cambio Leaflet hubiera escrito `style="stroke:..."`, hay que pasar al plan B documentado en §2.4.
   - Confirmar que el control de atribución se lee (contraste suficiente sobre el tema oscuro) y que **no** está tapado por ningún elemento.
5. Correr el simulador contra el endpoint de IoT (`npm run simulator -- --endpoint <...> --units SB-001,SB-002,SB-003 --interval 5`) y verificar, con el dashboard abierto: (a) los marcadores se desplazan con cada lectura (deriva de `telemetry.ts:41-42`); (b) con `--excursion SB-001@60` el marcador de SB-001 se pone rojo (`--excursion`) a la vez que su tarjeta; (c) con `--silence SB-002@120` el de SB-002 se pone gris (`--stale`) cuando vence su `signal_timeout_min`, igual que la tarjeta; (d) al volver el flujo, vuelve a verde.
6. Login con el usuario **operador** (`scripts/seed-data.json`): el mapa muestra **solo** las unidades de su `client_id`. Sale gratis porque los puntos se derivan de `fetchUnits()` (`api.ts:95`) y el alcance ya lo aplica la API, pero hay que verlo con los ojos.
7. **Prueba sin internet de tiles:** con el dashboard abierto, bloquear `tile.openstreetmap.org` (DevTools → Network request blocking) y recargar: el fondo queda gris, **los marcadores siguen dibujándose** y la app no se rompe. Esto deja demostrado que los tiles son cosa del navegador y no de la VPC — y que una demo offline no va a tener mapa de fondo.
8. Verificar en al menos dos navegadores (Chrome y Firefox) el punto 4, porque el comportamiento del Referer y del zoom depende del navegador.
9. Si F5-B ya está implementada: repetir los puntos 4 y 5 contra la URL del bucket de `us-west-2`; tiene que comportarse igual (el `dist/` es idéntico y la URL de tiles no cambia).
10. Al terminar la sesión del Lab, el `destroy` habitual. Esta feature **no agrega ningún recurso de AWS**, así que no cambia nada del ciclo bootstrap → apply → destroy → borrado de buckets.

## 12. Fuera de alcance

Umbrales por Device Shadow; replicación multi-región del backend (DynamoDB Global Tables, segunda región de la API); medición de latencias; HTTPS de punta a punta; autoescalado de la API. La réplica del sitio estático por región (F5-B) y la suscripción MQTT sobre WebSockets (F5-C) tienen plan propio: ver `docs/plan-replica-dashboard.md` y `docs/plan-mqtt-websockets.md`. Tampoco entran acá: clustering de marcadores (`leaflet.markercluster`), rastros/polilíneas del recorrido histórico, geocercas, y separar las coordenadas iniciales de las unidades simuladas.

## 13. Fuentes consultadas (2026-10-20)

- Registry de npm: `registry.npmjs.org/leaflet` (dist-tags: `latest` 1.9.4, `alpha` 2.0.0-alpha.1), `registry.npmjs.org/leaflet/1.9.4` (sin `types`/`typings`, sin `module`, sin `exports`; `main: dist/leaflet-src.js`), `registry.npmjs.org/react-leaflet` (`latest` 5.0.0), `.../react-leaflet/5.0.0` (peers React 19), `.../react-leaflet/4.2.1` (peers React 18 + `leaflet ^1.9.0`), `.../@react-leaflet/core/2.1.0`, `.../@types/leaflet/latest` (1.9.22).
- `unpkg.com/leaflet@1.9.4/package.json` (campos `main`, `style`, `files`).
- Fuente de Leaflet 1.9.4: `src/layer/vector/SVG.js` (`_initPath` aplica `options.className`; `_updateStyle` usa `setAttribute` para `stroke`/`fill`) y `src/layer/vector/Path.js` (`getElement()`, defaults de `color`/`weight`/`fillOpacity`).
- `leaflet@1.9.4/dist/leaflet.css` (los cuatro `url(...)`, incluido `.leaflet-default-icon-path`).
- `@types/leaflet@1.9.22/index.d.ts` (`Path.getElement(): Element | undefined`, `PathOptions.className`, `circleMarker`/`CircleMarkerOptions.radius`, `attribution` en `LayerOptions`, `maxZoom` en `GridLayerOptions`).
- bundlephobia: `leaflet@1.9.4` (148,515 B / 42,736 B gzip), `react-leaflet@4.2.1` (11,187 B / 3,615 B gzip). jsDelivr data API para los tamaños de `dist/`.
- Doc de Vite, guía de features, sección CSS (inyección del `.css` importado, rebase de `url()`, `build.cssCodeSplit` por chunk async).
- OSMF Tile Usage Policy (`operations.osmfoundation.org/policies/tiles/`).
- MDN *Mixed content* (una página HTTP cargando un recurso HTTPS no es mixed content) y MDN *Referrer-Policy* + W3C Referrer Policy §8.3 (el `Referer` se descarta solo en HTTPS→HTTP; HTTP→HTTPS manda el origen).

