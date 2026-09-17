# Planning v2: Alternatives & Choice — Spec

**Fecha:** 2026-09-17  
**Estado:** Borrador de Diseño para Congelación  
**Alcance:** Semántica estricta de elección (`choice ≠ journey`), diversidad estructural de alternativas útiles, modelo de datos de decisión y observabilidad de divergencias.

---

## 1. Goal y Filosofía

Planning v1 resolvió el problema fundamental de computación y presentación:
> *«¿Cuál es la opción más rápida y qué otras opciones cercanas en tiempo existen?»*

Planning v2 ataca dos problemas cualitativos indispensables antes de cualquier intento de personalización:
1. **Calidad y utilidad de las alternativas:** evitar opciones cognitivamente triviales (p. ej. el mismo bus 1 minuto después o en la marquesina de enfrente) garantizando **diversidad estructural**.
2. **Semántica rigurosa de la elección:** modelar la interacción del usuario como **declaración explícita de preferencia en la UI** (`choice ≠ journey`) y registrar la tupla completa de decisión para hacer observable la divergencia.

### Secuencia de Madurez

```text
OBSERVAR  ───►  REPRESENTAR  ───►  FILTRAR  ───►  EXPLICAR  ───►  APRENDER
   (v1)             (v2)            (v2)           (v2)            (v3+)
```

> [!IMPORTANT]
> **Planning v2 NO aprende ni adapta la recomendación.**
> Primero se garantiza la observabilidad fiable del comportamiento declarado del usuario; solo en fases posteriores se estudiará si esas divergencias justifican adaptar pesos o heurísticas.

---

## 2. Invariantes de Arquitectura

1. **`choice ≠ journey`:**
   - Un tap sobre una alternativa es una **elección declarada en la UI**, nunca una confirmación de viaje físico completado. La app no realiza rastreo ni inferencias de desplazamiento real.
2. **Presupuesto computacional acotado:**
   - Se mantiene el techo de `maxCandidates = 3` completos enrutados con OSRM.
   - Se mantiene el techo de `maxAlternatives = 2` mostradas simultáneamente en UI.
3. **Pipeline en dos fases con diversidad en ambos extremos:**
   - *Fase 1 (barata):* pre-selecciona hasta 3 candidatos favoreciendo diversidad de modo y línea.
   - *Fase 2 (exacta):* OSRM concurrente, re-ranking exacto para fijar el Hero real, y filtrado final de utilidad/diversidad.
4. **Diversidad estructural sin reglas rígidas:**
   - La diversidad **no** es un simple `Set(line)`. Dos opciones de la misma línea son válidas si representan estrategias de acceso materialmente distintas (p. ej. caminar menos vs esperar menos).
5. **Observabilidad simétrica:**
   - Toda evaluación registra la tupla completa: recomendación inicial, elección final (si existió promoción), delta temporal y tipo de divergencia.
6. **Modo-agnóstico:**
   - El selector sigue sin contener condicionales de negocio tipo `if (cand.mode === 'bus')` para calcular rangos o similitud. La diversidad se evalúa sobre atributos dimensionales normalizados (`dimensions`).
7. **Diversidad evaluada contra el Hero definitivo:**
   - La diversidad estructural de las alternativas se calcula estrictamente contra el Hero final resultante del re-ranking post-OSRM, no contra el candidato provisional del pre-ranking barato.

---

## 3. Modelo de Datos: Decision Record

En `public/web/journey-log.js`, la entrada histórica (`JourneyEntry`) evoluciona para capturar la decisión completa:

```ts
interface DecisionAlternative {
  identity: string;
  mode: 'walk' | 'bus';
  busLine?: string | null;
  totalMinutes: number;
  deltaMinutes: number;        // Diferencia respecto al Hero ganador final
  divergenceType: 'none' | 'mode' | 'line' | 'access';
}

interface JourneyEntry {
  id: string;                  // Identificador único de evaluación
  timestamp: number;           // Epoch ms
  destination: {
    label: string;
    lat: number;
    lon: number;
  };
  recommendation: {
    identity: string;          // identity del Hero resultante de la planificación
    kind: 'walk' | 'bus';
    busLine: string | null;
    totalMinutes: number;
  };
  // null si no hubo interacción explícita (aceptación implícita del Hero)
  // Objeto completo si hubo elección explícita (tap sobre una alternativa o sobre el propio Hero)
  choice: DecisionAlternative | null;
}
```

> [!NOTE]
> **Compatibilidad hacia atrás (Backward Compatibility v1):**
> En Planning v1, `choice` se almacenaba como `string | null` (o no existía). La función de lectura `getLog()` y los consumidores deben normalizar entradas heredadas: si `choice` es una cadena, se conserva de forma segura sin romper contratos de lectura (`typeof entry.choice === 'string' ? { identity: entry.choice, mode: 'bus', totalMinutes: entry.recommendation?.totalMinutes ?? 0, deltaMinutes: 0, divergenceType: 'none' } : entry.choice`).

### Clasificación de Elección y Divergencia (`divergenceType`)

Se distingue explícitamente entre la falta de interacción y la elección consciente:

| Estado / Tipo | Condición | Significado |
|---|---|---|
| `choice = null` | No hay tap en tarjetas | Aceptación implícita de la recomendación (flujo estándar) |
| `choice.divergenceType = 'none'` | `choice.identity === recommendation.identity` | Elección explícita del propio Hero (tap en Hero o re-promoción del original) |
| `choice.divergenceType = 'mode'` | `choice.mode !== recommendation.kind` | Divergencia modal: Recomendado BUS (14′) → Elige ANDAR (17′) |
| `choice.divergenceType = 'line'` | `choice.mode === 'bus'` y `choice.busLine !== recommendation.busLine` | Divergencia de línea: Recomendado BUS L1 (14′) → Elige BUS L2 (16′) |
| `choice.divergenceType = 'access'` | Misma línea, pero cambia parada de subida o bajada sustancialmente | Divergencia de acceso: Recomendado BUS L1 en parada X → Elige BUS L1 en parada Y |

---

## 4. Diversidad Estructural: Utilidad de Alternativas

### El Problema de las Alternativas Triviales en v1

En v1, si dos buses de la línea 1 pasan con 2 minutos de diferencia en la misma parada, `byIdentity` descarta el segundo por ser idéntico en clave `bus:1:1106:1204`. Sin embargo, si la parada 1106 y la parada 1107 están a 80 metros en la misma avenida, generaban identidades distintas (`bus:1:1106:1204` vs `bus:1:1107:1204`) y podían ocupar los dos slots de alternativas ofreciendo exactamente el mismo servicio.

### Dimensiones Estructurales

Un candidato $C$ proyecta tres dimensiones respecto a otro candidato $H$ (Hero):

1. **Dimensión Modal ($\Delta_{\text{mode}}$):**
   - $1$ si uno es `walk` y el otro `bus`.
   - $0$ si ambos son del mismo modo.
2. **Dimensión de Línea ($\Delta_{\text{line}}$):**
   - $1$ si operan líneas distintas.
   - $0$ si operan la misma línea.
3. **Dimensión de Acceso / Corredor ($\Delta_{\text{access}}$):**
   - Para la misma línea:
     - Diferencia de caminata al origen: $|\text{walkToStop}_A - \text{walkToStop}_B| \ge 3'$
     - O parada de bajada distinta con tramo final diferente: $\Delta d_{\text{alight}} \ge 250\text{ m}$.
     - Si no cumple ninguno: $\Delta_{\text{access}} = 0$ (redundancia trivial).

### Regla de Aceptación de Alternativas Útiles

Un candidato $A$ es admitido como alternativa del Hero $H$ si y solo si:

$$\text{totalMinutes}(A) - \text{totalMinutes}(H) \le \text{similarityMaxDeltaMinutes}\ (5')$$

$$\mathbf{Y}$$

$$\Delta_{\text{mode}}(A, H) + \Delta_{\text{line}}(A, H) + \Delta_{\text{access}}(A, H) \ge 1$$

Si dos alternativas candidatas $A_1$ y $A_2$ compiten por el último slot disponible y ambas son válidas:
1. Se prioriza **mayor diversidad dimensional** respecto al Hero (modo diferente > línea diferente > acceso diferente).
2. Como desempate, se prioriza **menor tiempo total**.

---

## 5. Pipeline Completo de Planificación v2

```text
1. GENERACIÓN DE CANDIDATOS
   ├── Candidato ANDAR (OSRM directo)
   └── Candidatos BUS desde pool de paradas cercanas diversas (diversifyByLine)

2. PRE-SELECCIÓN BARATA CON DIVERSIDAD (Top ≤ 3)
   ├── Agrupación por structural identity
   ├── Ranking por cheap estimatedMinutes
   ├── Filtro de diversidad estructural preliminar
   └── Selección de presupuesto: 1 provisional + máx 2 alternativas

3. ENRUTADO EXACTO CONCURRENTE (OSRM)
   └── Promise.all() sobre los ≤ 3 candidatos seleccionados:
       ├── walkToStopRoute
       ├── lastMileRoute (walkRoute)
       └── busRoute

4. RE-RANKING EXACTO
   ├── cand.estimatedMinutes = cand.exactJourney.totalMinutes
   └── selectCandidates(exactCandidates, policy) ──► determina Hero real definitivo

5. FILTRO FINAL DE UTILIDAD Y DIVERSIDAD
   ├── Re-evalúa Δ <= 5' respecto al Hero real
   ├── Aplica filtro dimensional (elimina redundancias de misma línea/mismo acceso)
   └── Entrega: Hero + 0..2 alternativas útiles

6. OBSERVABILIDAD Y REGISTRO
   ├── Render Hero + alternativas
   ├── Escribe JourneyEntry inicial (choice: null)
   └── En caso de tap-to-promote:
       ├── Actualiza UI y mapa
       └── Actualiza JourneyEntry con choice estructurado y divergenceType
```

---

## 6. Fuera de Alcance Explícito (Fronteras Congeladas)

* ❌ **Inferencia de hábitos o pesos personales:** la app no aprende sesgos del usuario en v2.
* ❌ **Auto-corrección de recomendaciones:** si el usuario siempre elige andar, la app sigue recomendando bus si es objetivamente más rápido según la física del transporte.
* ❌ **Telemetría o confirmación de viaje completado:** `choice` es una interacción de UI, no un GPS trace.
* ❌ **Frecuencia como ranking:** `Mis destinos` sigue ordenando por frecuencia de consultas, no por ratio de elección.
* ❌ **Transbordos (Transfers):** se reserva para una fase posterior con discovery propio de espacio de búsqueda y presupuesto de cálculo.

---

## 7. Criterios de Aceptación y Verificación

1. **No redundancia de marquesina:** dos paradas consecutivas de la misma línea separadas por <100 m no pueden aparecer simultáneamente como alternativas si ofrecen el mismo servicio.
2. **Supervivencia de alternativa de misma línea legítima:** una opción de la misma línea que ahorre 5 minutos de espera caminando 3 minutos más a una parada troncal anterior sí es admitida como alternativa útil.
3. **Registro de elección completo:**
   - Una consulta sin clics adicionales persiste `choice: null`.
   - Promocionar una alternativa persiste `choice` con `deltaMinutes` positivo y `divergenceType` categorizado (`mode`, `line`, o `access`).
4. **Desacoplamiento total:** cero dependencias nuevas de npm; funciones puras testables en `logic.test.js`.
