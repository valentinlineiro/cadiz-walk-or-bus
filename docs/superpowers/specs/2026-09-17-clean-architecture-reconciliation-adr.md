# ADR: Clean Architecture Reconciliation — Cadiz Walk or Bus

* **Status:** Proposed / Frozen for Review
* **Date:** 2026-09-17
* **Scope:** Architectural reconciliation post-Planning v2 (Alternatives & Choice)

---

## 1. Contexto y Diagnóstico

A lo largo de las fases de desarrollo recientes (Explicación completa F3, Bounding Box geográfico, Memory v1, Planning v1 y Planning v2), el producto ha evolucionado de un modelo reactivo simple:

$$\text{GPS} \to \text{parada cercana} \to \text{llegada de bus} \to \text{comparación puntual} \to \text{render}$$

a un pipeline de planificación y toma de decisiones multivariante:

$$\text{Origen / Destino} \to \text{Candidatos baratos} \to \text{Pre-selección} \to \text{Enrutamiento exacto} \to \text{Diversidad estructural} \to \text{Hero + Alternativas} \to \text{Registro estructurado}$$

### El Desacople Detectado
La estructura de código ha quedado desfasada respecto a lo que el producto realmente hace:
1. **`src/domain/decision.ts` está obsoleto:** Su función central `verdict()` ya no participa en el flujo principal (`routeToDestination`). Solo subsiste en rutas secundarias (badging de favoritos y exploración legacy).
2. **`public/web/ui.js` actúa como monolito:** Con más de 1.100 líneas, mezcla manipulación del DOM, mapa Leaflet, geolocalización, orquestación de red OSRM concurrente y cálculos puros de dominio (como `computeLastMile` y la constante de paso peatonal).
3. **`public/web/planner.js` y `public/web/journey-log.js` son Domain + Application mezclados:** Contienen reglas puras (diversidad estructural, distancias umbral, clasificación de divergencia) junto con orquestación y acceso a storage.
4. **Constantes y tipos duplicados:** Velocidades de transporte (`WALK_METERS_PER_MINUTE = 80`, `BUS_METERS_PER_MINUTE = 250`) y la noción de `identity` están repetidas y tratadas como strings planos con `.split(':')` dispersos.

---

## 2. Principio Arquitectónico Rector

> **Regla de Oro:**
> No se crean capas, paquetes o directorios por afinidad temática o técnica (`planning/`, `routing/`, `memory/`).
> Las únicas capas permitidas en la arquitectura son las capas formales de **Clean Architecture**, con su estricta regla de dependencias unidireccional hacia el centro.

```text
                    ┌───────────────────────────────┐
                    │            DOMAIN             │
                    │  Entidades · Value Objects    │
                    │  Reglas de Negocio · Invariantes
                    └───────────────▲───────────────┘
                                    │
                    ┌───────────────┴───────────────┐
                    │          APPLICATION          │
                    │   Casos de Uso · Workflows    │
                    │        Puertos (Ports)        │
                    └───────────────▲───────────────┘
                                    │
    ┌───────────────────────────────┴───────────────────────────────┐
    │                        INFRASTRUCTURE                         │
    │                                                               │
    │  [Driving Adapters]                 [Driven Adapters]         │
    │  • Web UI / DOM Events              • OSRM (peatonal/motor)   │
    │  • Leaflet Map Adapter              • Nominatim Geocoder      │
    │  • Sheet State Controller           • Municipal Transit API   │
    │                                     • localStorage            │
    └───────────────────────────────────────────────────────────────┘
```

Dirección de dependencias:
$$\text{Infrastructure} \longrightarrow \text{Application} \longrightarrow \text{Domain}$$

* **Driving Adapter (`ui.js`):** Traduce eventos de usuario (GPS, input, clicks) en llamadas a Casos de Uso de Aplicación y presenta el resultado.
* **Driven Adapters (`api.js`, `journey-log.js` storage):** Implementan los puertos requeridos por los Casos de Uso para consultar servicios externos o almacenamiento.

> **Diagnóstico Preciso de `ui.js`:**
> `ui.js` no es una "capa aparte con demasiadas responsabilidades". Es un **Driving Adapter de Infrastructure** que actualmente **viola su frontera** porque alberga orquestación de Casos de Uso (Application) y cálculos puros (Domain). El objetivo es devolverlo a su rol legítimo de adapter.

---

## 3. Definición de Capas y Responsabilidades

### A. Capa de Dominio (`src/domain/`)

Contiene **lo que es verdad independientemente del navegador, OSRM, Cloudflare Workers o Leaflet**. Es código 100% puro en TypeScript, sin efectos secundarios, sin I/O, sin asincronía.

#### 1. Value Objects
* **`JourneyIdentity`**: Representación estructurada de la identidad de un viaje:
  ```ts
  export type JourneyIdentity = 
    | { mode: 'walk'; variant: 'direct' }
    | { mode: 'bus'; line: string; boardingStopId: string; alightStopId: string };
  ```
  Posee funciones puras: `serializeIdentity()`, `parseIdentity()`, `isSameIdentity()`. Se erradica el uso de `.split(':')` disperso.
* **`TransportConstants`**: Fuente única de verdad de cinemática urbana:
  * `WALK_METERS_PER_MINUTE = 80` (4.8 km/h).
  * `BUS_METERS_PER_MINUTE = 250` (15 km/h con paradas).
  * `MAX_WALK_TO_STOP_MINUTES = 20`.
  * `DIVERSITY_THRESHOLDS = { accessWalkMinutes: 3, alightDistanceMeters: 250 }`.

#### 2. Entidades del Dominio
* **`JourneyCandidate` (Hipótesis)**:
  * Candidato generado a bajo coste para alimentar el pool de comparación.
  * Atributos: `identity`, `mode`, `estimatedMinutes`, `breakdown` (espera, viaje, caminata estimada), `metadata`.
* **`EvaluatedJourney` (Viaje Resuelto)**:
  * Candidato cuya ruta física ha sido calculada de forma exacta mediante routing.
  * Atributos: `identity`, `mode`, `totalMinutes`, `breakdown` (caminata a parada exacta, espera real, viaje en bus, last-mile exacto o degradado), `routes` (geometrías resueltas), `dataQuality` (`live` | `degraded`).
* **`Decision` (Resultado de Planificación)**:
  * `hero`: El viaje ganador seleccionado (`EvaluatedJourney`).
  * `alternatives`: Hasta 2 viajes alternativos admitidos (`EvaluatedJourney[]`).
* **`DecisionRecord` (Registro de Observabilidad)**:
  * `recommendation`: Datos esenciales del Hero emitido.
  * `choice`: Declaración de elección explícita (`DecisionAlternative | null`).
  * `divergenceType`: `'none' | 'mode' | 'line' | 'access'`.
  * `deltaMinutes`: Diferencia con signo real vs Hero (`choice.totalMinutes - recommendation.totalMinutes`).

#### 3. Reglas de Dominio Puras
* **`StructuralDiversity`**: Algoritmo que determina si dos viajes son estructuralmente diversos en dimensiones modal ($\Delta_{\text{mode}}$), de línea ($\Delta_{\text{line}}$) o de acceso ($\Delta_{\text{access}}$).
* **`CandidateSelector`**: Algoritmo agnóstico al modo que toma un conjunto de candidatos/viajes, impone presupuesto duro ($\le 3$ candidatos, $\le 2$ alternativas), filtra por delta temporal ($\le 5'$) y garantiza diversidad estructural cruzada.
* **`LastMileEvaluation`**: Cálculo de tramo final (`computeLastMile`), marcando degradación geométrica si el routing peatonal no está disponible.
* **`Topology & Geometry`**: Fórmulas Haversine, ordenación por proximidad, y validación de dirección y secuencia en líneas de autobús (`findAlightStop`).

---

### B. Capa de Aplicación (`src/application/`)

Contiene los **Casos de Uso** que orquestan las operaciones del sistema, interactuando con el Dominio y dependiendo únicamente de abstracciones (Puertos / Interfaces).

#### 1. Caso de Uso Central: `FindBestJourneysUseCase`
Coordina el flujo completo de planificación sin conocer el DOM ni Leaflet:
```text
execute(origin, destination, policy):
  1. Validar frontera geográfica (origin, destination en Cádiz)
  2. Obtener ruta peatonal base a través de RoutingPort
  3. Crear JourneyCandidate peatonal
  4. Consultar paradas cercanas y llegadas a través de TransitPort
  5. Generar JourneyCandidates de autobús con estimación barata
  6. Pre-seleccionar top candidatos diversos (≤ 3) mediante CandidateSelector
  7. Resolver en paralelo rutas exactas para los candidatos admitidos vía RoutingPort
  8. Construir EvaluatedJourneys con tiempos reales
  9. Re-seleccionar y re-clasificar con tiempos definitivos mediante CandidateSelector
 10. Construir la Decision final (Hero + Alternativas)
 11. Registrar en JourneyLogPort la recomendación emitida (choice: null)
 12. Retornar Decision
```

#### 2. Caso de Uso Secundario: `RecordUserChoiceUseCase`
Gestiona la interacción explícita del usuario cuando selecciona una opción:
```text
execute(decisionRecordId, chosenJourney, initialHero):
  1. Calcular deltaMinutes exacto con signo (chosen.total - hero.total)
  2. Determinar divergenceType mediante regla de dominio classifyDivergence
  3. Actualizar registro en JourneyLogPort
```

#### 3. Puertos de Aplicación (Interfaces)
* **`RoutingPort`**:
  * `getWalkRoute(from, to): Promise<Route | null>`
  * `getBusRoute(stopCoordinates): Promise<Route | null>`
* **`TransitDataPort`**:
  * `getStops(): Promise<Stop[]>`
  * `getLines(): Promise<LinesTopology | null>`
  * `getArrivals(stopId): Promise<Arrival[]>`
* **`JourneyLogPort`**:
  * `append(entry): void`
  * `getHistory(): JourneyEntry[]`
  * `getTopDestinations(limit): HabitualDestination[]`
* **`GeocodingPort`**:
  * `search(query, limit): Promise<SearchResult[]>`

---

### C. Capa de Infraestructura (`src/infrastructure/` / `public/web/`)

Contiene todos los adaptadores hacia el mundo exterior (browser, red, almacenamiento). Se divide en dos tipos de adaptadores:

#### 1. Driving Adapters (Adaptadores Primarios / Entrada)
Inician acciones en el sistema traduciendo eventos de la UI hacia Casos de Uso:
* **`WebUiAdapter` (`public/web/ui.js`)**:
  * Captura entradas de usuario (GPS, búsqueda en input, taps en tarjetas de Hero/alternativa, clics en mapa).
  * Invoca Casos de Uso (`FindBestJourneysUseCase.execute(...)`, `RecordUserChoiceUseCase.execute(...)`).
  * Mapea el resultado (`Decision`) a HTML mediante plantillas puras (`heroCardHTML`, `buildAlternativeCardHTML`).
  * Actualiza la máquina de estados visual (`sheet-state.js`).
* **`LeafletMapAdapter` (`public/web/map.js`)**:
  * Traduce geometrías y paradas provistas por el Caso de Uso a capas Leaflet y marcadores interactivos.

#### 2. Driven Adapters (Adaptadores Secundarios / Salida)
Implementan los puertos requeridos por la capa de Aplicación:
* **`OsrmRoutingAdapter`**: Cliente HTTP de OSRM peatonal (`routed-foot`) y OSRM motorizado (`router.project-osrm.org`). Implementa `RoutingPort`.
* **`MunicipalTransitAdapter`**: Cliente HTTP de los endpoints del backend/worker (`/stops`, `/lines`, `/api?stop=...`). Implementa `TransitDataPort`.
* **`NominatimGeocodingAdapter`**: Cliente de búsqueda y geocodificación acotado a la viewbox de Cádiz. Implementa `GeocodingPort`.
* **`LocalStorageJourneyLogAdapter`**: Implementación de almacenamiento y recuperación de logs de viaje y favoritos en `localStorage`. Implementa `JourneyLogPort`.

---

## 4. Hoja de Ruta de Transición (Migration Plan)

Para no introducir regresiones, no alterar los 121 tests existentes y verificar la suite en cada paso, la reconciliación se ejecutará en **5 PRs acotados**:

```text
PR 1: DOMAIN RECONCILIATION
  ├── Formalizar tipos e invariantes en src/domain/ (Candidate, EvaluatedJourney, Identity, TransportConstants)
  ├── Extraer cálculo computeLastMile y reglas de diversidad al dominio puro
  └── Unificar constantes duplicadas
  └── Verificación: 121/121 tests pasando, 0 roturas en UI

PR 2: APPLICATION PORTS & USE CASE
  ├── Definir puertos (RoutingPort, TransitDataPort, JourneyLogPort)
  ├── Implementar FindBestJourneysUseCase (aislado de DOM y Leaflet)
  ├── Tests unitarios puros para el Use Case con mocks en memoria
  └── Verificación: tests nuevos + 121 tests existentes verdes

PR 3: INFRASTRUCTURE ADAPTERS
  ├── Extraer clientes OSRM, Nominatim y Worker API a adaptadores que implementan los puertos
  ├── Extraer almacenamiento de logs a LocalStorageJourneyLogAdapter
  └── Verificación: contratos cumplidos, 121 tests verdes

PR 4: UI REFACTOR AS ADAPTER
  ├── Conectar ui.js a FindBestJourneysUseCase
  ├── Eliminar orquestación de red y cálculos de routing inline en ui.js
  └── ui.js queda como vista + controlador de eventos
  └── Verificación: smoke en navegador, 121 tests verdes

PR 5: RETIRO DE LEGACY Y CONGELACIÓN
  ├── Eliminar la función verdict() obsoleta de src/domain/decision.ts
  ├── Actualizar quickVerdictFor para usar el Use Case o el ranking moderno
  └── Limpieza final y congelación arquitectónica v1
```

---

## 5. Invariantes a Mantener Durante la Reconciliación

1. **Cero cambios en el comportamiento funcional:** La experiencia de usuario, las pantallas, las tarjetas y los tiempos no cambian un solo píxel o milisegundo funcional.
2. **`choice ≠ journey`:** Se mantiene intacta la semántica de intención vs viaje físico.
3. **Presupuesto duro:** Máximo 3 candidatos evaluados con OSRM exacto; máximo 2 alternativas mostradas.
4. **Verificación permanente:** Cada PR debe pasar `npm test` (121/121), `npm run typecheck` (0 errores) y `npm run build` (0 errores).
