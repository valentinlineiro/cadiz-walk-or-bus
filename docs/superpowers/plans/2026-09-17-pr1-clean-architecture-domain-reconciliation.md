# Plan de Implementación: PR 1 — Reconciliación de Dominio (Clean Architecture)

* **Rama:** `refactor/clean-architecture-pr1-domain`
* **Objetivo:** Convertir el modelo de dominio implícito (acumulado en Planning v1/v2, Memory y F3) en tipos, entidades, value objects y reglas puras en `src/domain/`, garantizando **cero cambios en el comportamiento observable del producto**.
* **Invariante:** Los 121 tests existentes deben permanecer en verde en todo momento. Se añaden tests de contrato para los nuevos tipos y reglas.

---

## 1. Alcance de PR 1

### Dentro de PR 1:
1. **Constantes de Transporte (`src/domain/constants.ts`):**
   - Unificar `WALK_METERS_PER_MINUTE = 80` y `BUS_METERS_PER_MINUTE = 250`.
   - Constantes de política de planificación (`DEFAULT_PLANNING_POLICY`) y umbrales de diversidad (`DEFAULT_DIVERSITY_THRESHOLDS`).
2. **Value Object `JourneyIdentity` (`src/domain/identity.ts`):**
   - Tipos estructurados: `WalkIdentity`, `BusIdentity`, `JourneyIdentityParts`.
   - Funciones puras: `createWalkIdentity()`, `createBusIdentity(line, board, alight)`, `parseIdentity(id)`, `isSameIdentity(a, b)`.
   - Elimina la dependencia de `.split(':')` disperso en `planner.js`, `ui.js` y `journey-log.js`.
3. **Modelos y Entidades de Dominio (`src/domain/models.ts`):**
   - `JourneyCandidate` (hipótesis barata para pre-selección).
   - `EvaluatedJourney` (viaje con resolución física y tiempos exactos).
   - `Decision` (Hero + alternativas admitidas).
   - `DecisionAlternative` y `DivergenceType`.
4. **Contrato de Last Mile (`src/domain/last-mile.ts`):**
   - Extracción de `computeLastMile(lastMileRoute, distanceMeters, walkPace)` fuera de `ui.js`.
   - Contrato explícito: distancia conocida $\to$ fallback degradado; exact route $\to$ routed minutes; flag `lastMileDegraded`.
5. **Reglas de Diversidad y Divergencia (`src/domain/diversity.ts`):**
   - Reglas puras: `isStructurallyDiverse`, `filterDiverseAlternatives`, `classifyDivergence`.
6. **Consumo no disruptivo en Infrastructure/UI:**
   - `public/web/planner.js`, `public/web/journey-log.js` y `public/web/ui.js` importan desde los módulos compilados en `public/web/` sin alterar su API externa.
   - Preservar `src/domain/decision.ts` y su función `verdict()` intacta por ahora (se retirará en PR 5).

### Fuera de PR 1:
- ❌ No crear `FindBestJourneysUseCase` ni la capa Application (reservado para PR 2).
- ❌ No crear interfaces de puertos (`RoutingPort`, `TransitDataPort`) (reservado para PR 2).
- ❌ No crear adaptadores de infraestructura para OSRM ni Worker API (reservado para PR 3).
- ❌ No reescribir la orquestación de `ui.js` (reservado para PR 4).
- ❌ No eliminar `src/domain/decision.ts` (reservado para PR 5).
- ❌ Cero cambios en UI, CSS, textos, scoring o comportamiento funcional.

---

## 2. Desglose de Tareas

### Task 1: Constantes de Transporte e Identidad de Viaje
**Archivos:**
- Crear: `src/domain/constants.ts`
- Crear: `src/domain/identity.ts`
- Modificar: `src/domain/models.ts`
- Tests: `public/web/logic.test.js`

**Pasos:**
1. Crear `src/domain/constants.ts` con `WALK_METERS_PER_MINUTE`, `BUS_METERS_PER_MINUTE`, `DEFAULT_PLANNING_POLICY`, `DEFAULT_DIVERSITY_THRESHOLDS`.
2. Crear `src/domain/identity.ts` con funciones puras `parseIdentity`, `createWalkIdentity`, `createBusIdentity`, `isSameIdentity`.
3. Compilar con `npm run build` (`tsc`).
4. Añadir tests unitarios en `public/web/logic.test.js` verificando parseo, formateo y comparación de identidades.
5. Conectar `public/web/planner.js` y `public/web/journey-log.js` para usar `identity.js` y `constants.js` eliminando `.split(':')` manuales.
6. Verificar que los 121 tests pasan.
7. Commit: `refactor(domain): extract transport constants and formalize JourneyIdentity value object`

---

### Task 2: Contrato y Cálculo de Last-Mile
**Archivos:**
- Crear: `src/domain/last-mile.ts`
- Modificar: `src/domain/models.ts`
- Modificar: `public/web/ui.js`
- Tests: `public/web/logic.test.js`

**Pasos:**
1. Crear `src/domain/last-mile.ts` con la función pura `computeLastMile(lastMileRoute, distanceMeters, walkPace)` y su interfaz de salida `{ lastMileMinutes: number, lastMileDegraded: boolean }`.
2. Compilar con `npm run build`.
3. Actualizar `public/web/ui.js` para re-exportar/importar `computeLastMile` desde `./last-mile.js` sin alterar contratos existentes.
4. Verificar que los tests existentes de `computeLastMile` en `logic.test.js` siguen pasando sin cambios.
5. Commit: `refactor(domain): extract computeLastMile into pure domain module`

---

### Task 3: Reglas de Diversidad Estructural y Divergencia
**Archivos:**
- Crear: `src/domain/diversity.ts`
- Modificar: `public/web/planner.js`
- Modificar: `public/web/journey-log.js`
- Tests: `public/web/logic.test.js`

**Pasos:**
1. Mover `isStructurallyDiverse` y `filterDiverseAlternatives` de `planner.js` a `src/domain/diversity.ts`.
2. Mover `classifyDivergence` de `journey-log.js` a `src/domain/diversity.ts`.
3. Compilar con `npm run build`.
4. Actualizar `public/web/planner.js` y `public/web/journey-log.js` para re-exportar estas funciones desde `./diversity.js` (manteniendo retrocompatibilidad exacta para sus consumidores y tests).
5. Ejecutar `npm test` y verificar 121/121 tests verdes.
6. Commit: `refactor(domain): move structural diversity and divergence classification to domain`

---

### Task 4: Formalización de Contratos `Candidate` y `EvaluatedJourney`
**Archivos:**
- Modificar: `src/domain/models.ts`
- Tests: `public/web/logic.test.js`

**Pasos:**
1. Declarar en `src/domain/models.ts` las interfaces completas:
   - `CandidateEstimate`
   - `JourneyCandidate`
   - `EvaluatedJourney`
   - `Decision`
   - `DecisionAlternative`
   - `DivergenceType`
2. Compilar con `npm run build` y validar `npm run typecheck`.
3. Añadir tests de tipos y contratos en `logic.test.js`.
4. Commit: `feat(domain): formalize JourneyCandidate, EvaluatedJourney, and Decision contracts`

---

### Task 5: Verificación Integral de No-Regresión
**Archivos:**
- Suite de tests completa (`logic.test.js`, `topology.test.js`, etc.)

**Pasos:**
1. Ejecutar suite completa: `npm test` (esperado: $\ge 121$ tests pasando, 0 fallos).
2. Ejecutar typecheck: `npm run typecheck` (esperado: 0 errores).
3. Ejecutar build: `npm run build` (esperado: 0 errores).
4. Smoke test con escenarios normalizados: verificar que ningún escenario snapshot cambia su resultado.
5. Push de rama y apertura de PR 1.

---

## 3. Criterio de Aceptación de PR 1
* Cero cambios en `src/domain/decision.ts` legacy.
* Cero cambios en el comportamiento observable de la UI.
* Las constantes `WALK_METERS_PER_MINUTE` y `BUS_METERS_PER_MINUTE` residen en un único lugar (`src/domain/constants.ts`).
* `JourneyIdentity` encapsula toda manipulación de strings de identidad.
* `computeLastMile` es una función pura del dominio.
* 100% de los tests pasan.
