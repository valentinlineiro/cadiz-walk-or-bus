# F2 — Presupuesto por upstream y reducción de llamadas (diseño, v2.1)

Estado: **v2.1, tras la segunda revisión**. Diseño únicamente: sin código, sin configuración, sin datos y sin peticiones nuevas a los upstreams. **Implementación no autorizada.** Commit base: `3a51b52`. Fecha: 2026-10-19.

## Cambios de la v2.1 (segunda revisión de la PR #86)
A. §4.2: la invariante temporal estaba mal (4 + 4 < 8 es falso). Valores nuevos y desglose explícito del margen: `CALL_TIMEOUT_MS + 2×TURSO_TIMEOUT_MS + SAFETY_MS = 4000 + 3000 + 1000 = 8000 < LEASE_MS = 10000`, comprobada **en el código** (al cargar el módulo y antes de cada llamada) y en una prueba.
B. §4.2/§8: dos garantías distintas: **local** (como máximo una petición saliente activa por upstream desde el punto de vista del Worker) y **límite de la remota** (no se puede garantizar que el proveedor deje de procesar al abortar la conexión). La prueba comprueba el comportamiento observable del Worker; ya no afirma nada sobre la ejecución interna del proveedor.
C. §2: la deduplicación del origen se hace por identidad estable de parada, nunca por coordenadas redondeadas; el origen GPS conserva su coordenada original.

## Cambios de la v2 (primera revisión)
1. §4: protocolo completo del arrendamiento (creación segura de la fila, reserva atómica, `BUSY` si no se modifica ninguna fila, liberación solo del propietario).
2. §4: tiempo límite efectivo de cada llamada al proveedor **menor** que el vencimiento del arrendamiento, con cancelación real y liberación en `finally`; la prueba debe demostrar que nunca hay dos llamadas activas.
3. §4: interacción con el cortocircuito de la #84: el permiso de sonda solo se reclama **después** de tener el arrendamiento; si la sonda se pierde, el arrendamiento se libera en el acto; pruebas de esa secuencia.
4. §4: capacidad separada por upstream (a pie, coche en frío y en caliente); sin cifra global; efectiva pendiente de medir.
5. §2/§3: política inequívoca de índices: listas sin repetidos y disjuntas, con coordenadas duplicadas permitidas entre fuentes y destinos; caso de prueba.
6. §2/§6: `/table/foot` con `Cache-Control: no-store` y sin coalescencia ni almacenamiento.
7. §5/D3: se retira la heurística duración-vs-recta; v1 solo valida esquema, dimensiones, celdas y distancias de ajuste.
8. §3/§4/§8: terminología ("duración calculada por el proveedor, redondeada a minutos"), semántica de `Retry-After`, error estable de `TABLE_ENABLED` apagado sin bucles de reintento, equivalencia simulada frente a real.

## 0. Dos correcciones a lo dicho antes de la v1
1. **No hace falta una matriz de coche.** `RoutingPort.routeBus` devuelve solo geometría (`OsrmRoutingAdapter.ts`); los minutos del bus salen de la topología (`cand.estimate.rideMinutes`). Hay **una sola `table`, la de a pie**.
2. **El mayor consumidor de llamadas son los chips de favoritos.** Cada chip ejecuta el pipeline completo (`GetQuickVerdictUseCase` → `FindBestJourneysUseCase`, `withBusGeometry:false`); el test fija el techo en `FAVORITES * 5` = 40 peticiones a pie por render (`chip-fanout.test.js:54`).

## 1. Dónde se gastan las llamadas hoy (código)
| Etapa | Llamadas | Upstream | Cacheable en el Worker |
|---|---|---|---|
| Candidato "andar": origen→destino | 1 | foot | no si el origen es GPS |
| Candidato bus: origen→parada de subida | 1 | foot | no (origen GPS, privacidad) |
| Candidato bus: parada de bajada→destino | 1 | foot | sí (empieza en una parada conocida) |
| Candidato bus: geometría | 1 por tramo entre paradas (5–15 típico) | drive | sí, 24 h (`route:drive:`) |

Hasta 3 candidatos se evalúan a fondo (`FindBestJourneysUseCase.ts`, paso 3), en paralelo. Red de 10 direcciones, 12–26 paradas cada una: ~150 pares de paradas, así que la caché de tramos converge.

## 2. Contrato de `GET /table/foot/{coords}`
- Solo perfil `foot` (no se expone `drive`: no hay minutos que pedir).
- `{coords}`: `lon,lat;lon,lat;…`, mismo patrón numérico que `ROUTE_PATH`, **2 a 8 coordenadas**; **matriz máxima 4×4** (|S| ≤ 4, |D| ≤ 4).
- Query obligatoria `sources=i;j` y `destinations=k;l`: índices enteros en rango, **sin repetirse dentro de cada lista**, 1–4 por lista y listas **disjuntas entre sí** (ningún índice en ambas).
- **Política de duplicados (inequívoca).** Una misma posición física puede aparecer **dos veces** en `{coords}`, una como fuente y otra como destino (p. ej. una parada que es de subida en un candidato y de bajada en otro). Son coordenadas independientes con índices distintos; **no** se pide que el proveedor admita índices solapados (no verificado, no se necesita). Construcción: `S = [origen] ++ únicos(paradas de bajada)` y `D = únicos(paradas de subida) ++ [destino]`, deduplicando **solo las paradas, por su identificador estable (`stop`)** y **nunca por coordenadas redondeadas**; `{coords} = S ++ D`. El origen (GPS o no) y el destino son entradas propias que **jamás se funden con una parada**, aunque sus coordenadas coincidan a 5 decimales: así la regla de deduplicación no modifica en silencio el origen de una búsqueda. El Worker no deduplica: valida y reenvía cada coordenada como llegó (con el mismo redondeo a 5 decimales que ya aplica a las rutas en la URL al proveedor). La validación comprueba índices válidos, únicos por lista y listas disjuntas, **no** que las coordenadas sean únicas.
- Cada coordenada dentro de `ROUTE_BOX`; si no → `400 INVALID_ROUTE` / `OUTSIDE_SERVICE_AREA`.
- Upstream: `routing.openstreetmap.de/routed-foot/table/v1/foot/{coords}?sources=…&destinations=…` (por defecto solo duraciones; evidencia del 2026-10-19T10:18:57Z, sets disjuntos).
- Validación de la respuesta (`validTable`): `code:"Ok"`; `durations` con exactamente |S| filas × |D| columnas; cada celda número finito ≥ 0 o `null`; `sources`/`destinations` de la longitud correcta con `location` finito y `distance` (ajuste a la red) finita ≥ 0. Cualquier fallo → `502 UPSTREAM_INVALID_RESPONSE`; `NoTable` → `404 UPSTREAM_NOT_FOUND`.
- Respuesta normalizada al cliente (sin `hint`): `{"code":"Ok","durations":[[…]],"snap_m":{"sources":[…],"destinations":[…]}}`.
- **`Cache-Control: no-store`** en toda respuesta de `/table/foot` (puede contener el origen GPS). Sin caché del Worker, sin coalescencia en vuelo, sin almacenamiento persistente. El cliente llama con `cache: 'no-store'`. (Nota: las rutas sin caché compartida hoy usan `private, max-age=3600`; la `table` es deliberadamente más estricta.)
- Interruptor: con `TABLE_ENABLED` apagado, `/table/foot` responde `503 {"code":"TABLE_DISABLED"}` (código estable, sin `Retry-After`). El cliente lo trata como definitivo para la sesión: degrada y **no reintenta**.

## 3. Planificación de rutas
1. Puerta barata (sin red), como hoy: ≤3 candidatos.
2. **Una `table` a pie** con S = {origen, paradas de bajada} y D = {paradas de subida, destino}. Con 3 candidatos de bus: 4×4.
3. Cada tramo toma la **duración calculada por el proveedor, redondeada a minutos** (`ceil(duración/60)`), sin reglas de descarte en v1 (§5). No se afirma que coincida con `route` (§10). Reordenación y elección del héroe como hoy (solo usa minutos).
4. **Geometría solo del candidato elegido**: `routeWalking` de sus tramos y `routeBus` tramo a tramo, cada una contra su presupuesto. Las alternativas muestran minutos y se dibujan con línea recta hasta que el usuario las promueve; entonces se pide su geometría.
5. Los minutos de la `table` y la geometría son datos distintos: si la geometría es aproximada se rotula "ruta aproximada" sin tocar los minutos.
6. **Contrato de UI al promover una alternativa**: (i) selección, veredicto y minutos cambian a la vez y de inmediato con los minutos ya conocidos; (ii) la geometría se pide después y mientras tanto se dibuja la línea recta rotulada aproximada; (iii) un fallo de geometría nunca altera minutos, veredicto ni la selección; (iv) las respuestas de geometría tardías de una alternativa que ya no es la seleccionada se descartan (identificador de petición por promoción).

Cambio de puertos: `RoutingPort` gana `walkingMatrix(sources, destinations)`; el adaptador llama a `/table/foot`; el caso de uso no conoce HTTP.

## 4. Presupuesto por upstream
**Regla**: por upstream (`osrm-foot`, `osrm-drive`; Nominatim conserva el suyo) como máximo **una petición realmente activa** y **≥ 1 s entre el final de una y el inicio de la siguiente**, sin cola. El estado vive en Turso y es compartido por todas las instancias y por todos los flujos (chips, búsquedas, geometría): no se limita cada *pipeline* por separado.

### 4.1 Protocolo del arrendamiento (`proxy_slot`, sin migración)
Fila `lease:<upstream>`; `next_at` = instante hasta el que el upstream está reservado.
1. **Reserva (creación + atómica en una sola sentencia)**, igual que `claimNominatimSlot`:
   `INSERT INTO proxy_slot (name, next_at) VALUES ('lease:<u>', ?1) ON CONFLICT(name) DO UPDATE SET next_at = ?1 WHERE next_at <= ?2` con `?1 = ahora + LEASE_MS` y `?2 = ahora`. La primera vez crea la fila (no hay fila previa que "falte"); después la actualiza solo si el arrendamiento anterior venció.
2. **Comprobación explícita**: `affected_row_count > 0` ⇒ reservado (valor propio = `?1`); **0 ⇒ `BUSY`** inmediato. Un error de Turso ⇒ `BUSY` (fallo cerrado), nunca "reservado".
3. **Llamada** al proveedor dentro de `try … finally`.
4. **Liberación solo del propietario**: `UPDATE proxy_slot SET next_at = ?1 WHERE name = 'lease:<u>' AND next_at = <mi valor>`, con `?1 = ahora + 1 s` si hubo llamada (la separación) o `= ahora` si no la hubo. Si otro ya reservó, no cambia nada.
5. Si el Worker muere o la invocación se cancela antes del `finally`, el arrendamiento **caduca solo** a los `LEASE_MS`.

### 4.2 Garantías temporales y sus límites
**Constantes y desglose del margen.** El arrendamiento se cuenta desde el instante `ahora` tomado **antes** de enviar la reserva a Turso, así que su viaje de ida y vuelta ya consume arrendamiento.
| Constante | Valor | Qué cubre |
|---|---|---|
| `CALL_TIMEOUT_MS` | 4000 | duración máxima de la llamada al proveedor (`AbortSignal.timeout`, incluye la lectura del cuerpo; hoy 5 s) |
| `TURSO_TIMEOUT_MS` | 1500 | tope de cada operación de Turso (valor actual de `tursoDb`); entran **dos** antes de la llamada: la reserva y, en semiabierto, la reclamación de la sonda |
| `SAFETY_MS` | 1000 | planificación del Worker y desfase de reloj entre instancias (el arrendamiento compara `Date.now()` de isolates distintos) |
| `LEASE_MS` | **10000** | vencimiento del arrendamiento |
**Invariante** (desigualdad estricta): `CALL_TIMEOUT_MS + 2 × TURSO_TIMEOUT_MS + SAFETY_MS = 4000 + 3000 + 1000 = 8000 < LEASE_MS = 10000` (2 s de holgura). Se comprueba **en el código**, no solo se documenta: (a) al cargar el módulo (si no se cumple, el Worker no arranca); (b) en ejecución, justo antes de enviar la petición al proveedor, **se descarta la llamada** (liberar y `BUSY`) si `ahora − instante_de_la_reserva > LEASE_MS − CALL_TIMEOUT_MS − SAFETY_MS`, es decir, si la latencia previa ya se comió la holgura; (c) en una prueba que verifica la desigualdad con los valores definitivos.
El plazo de 3,5 s desde el inicio de la búsqueda para **empezar** geometría es otro control y **no sustituye** al límite de duración de cada petición. Una llamada abortada cuenta como terminada; la separación de 1 s se mide desde ese instante.

**Dos garantías distintas.**
- **Garantía local (la que da el diseño):** por upstream hay como máximo **una petición saliente activa desde el punto de vista del Worker**, es decir, entre que arranca el `fetch` y que se resuelve o se aborta, bajo el modelo de cancelación del Worker (`AbortSignal`). La invariante temporal asegura que esa petición termina antes de que el arrendamiento pueda adquirirse otra vez.
- **Límite de la garantía remota (no se puede dar):** abortar cierra nuestra conexión, pero **no garantiza que el proveedor haya dejado de procesar** internamente. Puede haber trabajo residual del proveedor que se solape con la siguiente petición. Dos casos concretos: (i) tras un `abort`, la separación de 1 s mitiga pero no elimina el solapamiento; (ii) si una invocación del Worker muere sin ejecutar el `finally`, su llamada puede seguir viva hasta que el arrendamiento caduque a los 10 s. Un arrendamiento temporal **no puede** impedir cualquier solapamiento remoto; si el contrato exigiera eso, haría falta otro mecanismo (p. ej. un proveedor propio, F6). Se acepta como **riesgo residual R1** y se observa con los registros.

### 4.3 Orden por llamada y cortocircuito (#84)
caché compartida → **lectura** del estado del cortocircuito (solo lectura) → **reserva del arrendamiento** → *si el cortocircuito estaba en semiabierto*, reclamar ahora el permiso de sonda (`UPDATE … WHERE next_at <= ahora`, atómico) → llamada → `finally` (liberar arrendamiento) → informar al cortocircuito.
- El permiso de sonda **se reclama después de tener el arrendamiento**, así una sonda no puede quedarse retenida sin llamar al proveedor por falta de presupuesto.
- Si el cortocircuito está abierto: respuesta inmediata sin gastar arrendamiento.
- Si tras reservar el arrendamiento **se pierde** el permiso de sonda (otra petición lo tomó): se libera el arrendamiento en el acto (`next_at = ahora`, sin separación porque no hubo llamada) y se responde bloqueado.
- Si por cualquier excepción un permiso de sonda ya reclamado no llega a usarse, se devuelve con un `UPDATE` **condicional** al valor exacto de esa sonda (`… SET next_at = <valor previo vencido> WHERE name = 'block:<u>' AND next_at = <mi sonda>`), sin tocar un estado más reciente de otra instancia.
- Turso configurado pero caído: fallo cerrado (`503 BUSY`), igual que #84. Sin secretos (desarrollo): memoria del isolate.

### 4.4 Respuesta sin presupuesto
`503 BUSY` **inmediato**, con `Retry-After` **solo informativo**. El cliente **no reintenta por su cuenta**: degrada (§5) y, si procede, ofrece al usuario volver a intentarlo manualmente. Nada se encola.

### 4.5 Capacidad: por upstream, teórica frente a efectiva (estimaciones, no medidas ni garantías)
Base teórica: ~0,2 s de latencia (2 muestras del 2026-10-19) + 1 s de separación ⇒ ~1 llamada cada 1,2 s ⇒ **~50 llamadas/min por upstream**.
| Upstream | Coste por flujo | Techo teórico (solo ese presupuesto) | Notas |
|---|---|---|---|
| `osrm-foot` (a pie) | búsqueda = 1 `table` + ≤2 rutas del elegido = 3; chips automáticos ≤ 3 `table` por origen; geometría de una alternativa promovida ≤ 2; consulta explícita de un favorito = 3 | sesión con chips + búsqueda ≈ 6 llamadas ≈ **~8 sesiones/min**; sin chips ~16 búsquedas/min; solo `table` ~50/min | las rutas de bajada→destino sin origen GPS pueden salir de caché y bajar el consumo |
| `osrm-drive` (coche, solo geometría) | tramos del elegido: 5–15 | **caché fría**: ~3–10 búsquedas/min según tramos; **caché caliente**: cercano a 0 llamadas (≤ ~150 pares distintos, refresco a 24 h ⇒ ≤ ~150 llamadas/día) | la capacidad depende de la tasa de aciertos, no medida |
- **No hay cifra global.** El servicio se limita por el más escaso de ambos en cada momento; la capacidad **efectiva** queda **pendiente de medir en producción** (eventos `proxy_request`, `upstream_blocked`, `BUSY`), con contención, latencia de Turso (~3 viajes por llamada), reintentos manuales y cortocircuito incluidos. No se prometen cifras.
- Superar el techo exige otro proveedor o uno propio (F6).

## 5. Degradación (una estimación nunca se presenta como duración del proveedor)
| Fallo | Comportamiento |
|---|---|
| Sin presupuesto o error en la `table` | estimación existente (`cand.estimate.*`, `computeLastMile(null, …)`) con `dataQuality:'degraded'` y `lastMileDegraded:true` |
| Celda `null` (sin ruta a pie) | el candidato cuyo tramo es `null` se descarta, como hoy con `routeWalking` → `null` |
| Respuesta que no cumple el esquema, dimensiones o valores (§2) | `502`; el cliente degrada como en la primera fila |
| Falla la geometría o no hay presupuesto | línea recta por las paradas, rotulada aproximada; se **conservan** los minutos válidos de la `table` |
| Cortocircuito abierto / Turso caído / `TABLE_ENABLED` apagado | estimación degradada; sin reintentos automáticos |
**Heurística de duración retirada de v1.** No se usa una velocidad supuesta ni la distancia en línea recta para descartar tramos. Queda como decisión pendiente (D3b): solo se estudiará cuando exista una regla justificada y probada para este perfil y sus datos. Las `distance` de ajuste a la red se **validan** (finitas, ≥ 0) pero **no** se usan para descartar en v1.

## 6. Privacidad y caché
- **Ninguna respuesta de `/table/foot` se guarda en caché de ningún tipo**: ni compartida, ni del Worker, ni coalescencia, ni persistente, ni del navegador (`no-store`). Cubre toda matriz que contenga el origen GPS y, de hecho, todas las de clasificación.
- Las geometrías de tramos parada→parada siguen cacheadas 24 h (claves por coordenadas de parada, sin datos de usuario). Opción a valorar: subir ese TTL.
- Las filas `lease:*` y `block:*` no contienen coordenadas ni IP; los eventos de registro solo llevan upstream y estado.
- No hay clave compartida para `table`, así que no hay cruces entre usuarios.

## 7. Chips de favoritos (límite solo para el trabajo automático)
- **3 chips calculados automáticamente por origen**, y **solo** para el trabajo automático de chips: la búsqueda principal y la consulta explícita de un favorito conservan el pipeline y el veredicto normales.
- Secuenciales y dentro del presupuesto común. **Tres es un máximo, no tres llamadas garantizadas**: sin capacidad (arrendamiento ocupado, cortocircuito abierto, Turso caído) no se lanza el siguiente ni se acumula trabajo.
- Los chips no calculados muestran estado **neutral** "Pulsa para calcular". Al pulsarlos, cálculo explícito con el mismo presupuesto; si no hay resultado fiable, estado degradado o sin veredicto.
- Los chips automáticos se cancelan en cuanto el usuario lanza una búsqueda.

## 8. Pruebas y despliegue
- **Contrato**: coordenadas inválidas/fuera de área, >8 coordenadas, matriz >4×4, índices repetidos dentro de una lista / fuera de rango / listas solapadas; **parada que es de subida en un candidato y de bajada en otro** (aparece dos veces en `{coords}`); **origen GPS cuyas coordenadas coinciden a 5 decimales con una parada**: se conservan ambas entradas, el origen no se sustituye por la parada y las paradas repetidas se deduplican por identificador; respuesta con filas o columnas de más o de menos, celdas `NaN`/texto, `null`, `NoTable`, 5xx, JSON mal formado; `Cache-Control: no-store` presente.
- **Arrendamiento**: reserva inicial crea la fila; 0 filas modificadas ⇒ `BUSY`; Turso caído ⇒ `BUSY`; liberación solo del propietario; caducidad si el propietario muere; separación ≥ 1 s medida desde el final.
- **Exclusión mutua observable en el Worker** (garantía local, ver §4.2): un proveedor simulado cuyo contador de llamadas **activas** cuenta desde que arranca la petición hasta que se resuelve **o su señal se aborta**, con reloj simulado: (a) una llamada que tarda más que `CALL_TIMEOUT_MS` recibe el aborto en ese instante, el Worker libera en el `finally` y la siguiente petición solo puede arrancar tras la separación de 1 s; (b) el máximo simultáneo observado es 1 con retrasos y abortos; (c) con una reserva lenta (la latencia previa supera la holgura) el Worker **no llama** y responde `BUSY`. **No** se simula ni se afirma qué hace el proveedor tras el aborto: eso no es observable y queda como riesgo R1. La invariante `CALL_TIMEOUT_MS + 2×TURSO_TIMEOUT_MS + SAFETY_MS < LEASE_MS` se comprueba con los valores definitivos.
- **Sonda y presupuesto (secuencia exacta)**: cortocircuito semiabierto + arrendamiento ocupado ⇒ `BUSY` sin reclamar la sonda y la sonda sigue disponible de inmediato; arrendamiento reservado + sonda perdida ⇒ arrendamiento liberado en el acto; una sonda reclamada y no usada se devuelve de forma condicional sin pisar un estado más reciente.
- **Contención entre flujos** (chips, búsqueda, geometría, "dos instancias" con estado compartido): nunca 2 en vuelo, sin cola, el excedente recibe `BUSY`; los chips no se reintentan solos.
- **Planificador**: pruebas unitarias con una `table` simulada que reproduce *por construcción* las mismas duraciones que las rutas simuladas; **demuestran la lógica, no la equivalencia real con el proveedor, que sigue pendiente** (§10). Geometría solo del elegido, degradaciones etiquetadas, chips ≤ 3 automáticos.
- **UI**: promover actualiza selección, veredicto y minutos a la vez; un fallo de geometría no los cambia; una respuesta tardía de otra alternativa se descarta; chips: tope 3 automáticos, resto neutral, tap = cálculo explícito; `TABLE_DISABLED` ⇒ degrada sin bucle.
- **Despliegue**: sin forzar 403/429; `TABLE_ENABLED` apagado al desplegar; solo se enciende tras completar pruebas y criterios; después, observación con lecturas (salud, una búsqueda normal desde el móvil, eventos `proxy_request`/`upstream_blocked`).

## 9. Tabla de decisión
| # | Decisión | Justificación | Evidencia | Incertidumbre | Criterio de aceptación |
|---|---|---|---|---|---|
| D1 | Una sola `table` (a pie), sin `table` de coche | `routeBus` no usa minutos de OSRM | código, `OsrmRoutingAdapter.ts` | ninguna sobre el código | el planificador no llama a ninguna `table` de coche |
| D2 | Matriz máxima 4×4, 8 coordenadas | cubre 3 candidatos; conservador | consulta 1×3 del 2026-10-19, sin barrido | tamaño máximo real **no medido** | rechazo de matrices mayores con `400`; ningún barrido |
| D3 | Duración del proveedor redondeada a minutos como minutos de tramo, **sin reglas de descarte en v1** | evita 3–5 llamadas por búsqueda | 2 respuestas 200 con duraciones plausibles | **equivalencia con `route` sin verificar**; sin `distance` de la ruta | tras autorizar una comparación, diferencia documentada; hasta entonces no se afirma equivalencia |
| D3c | Deduplicar solo paradas por identificador; origen y destino nunca se funden con una parada | no alterar en silencio el origen de una búsqueda | contrato de §2 | ninguna | prueba del origen GPS coincidente con una parada |
| D3b | Heurística duración-vs-recta | — | — | no validada para este perfil | **pendiente**; no se implementa en v1 |
| D4 | Geometría solo del héroe; promover actualiza todo a la vez | el ranking solo usa minutos | código, paso 4 | cambio de UI | nº de llamadas de geometría por búsqueda ≤ las del héroe; pruebas de UI del §8 |
| D5 | 1 activa + ≥1 s por upstream, sin cola | FOSSGIS: "1 solicitud por segundo", "scripts, una conexión" | texto íntegro de las condiciones | cómo mide FOSSGIS 1/s (por IP o aplicación) | pruebas de exclusión mutua real del §8 |
| D5b | `CALL_TIMEOUT_MS` 4 s, 2×`TURSO_TIMEOUT_MS` 1,5 s, `SAFETY_MS` 1 s, `LEASE_MS` 10 s (8000 < 10000), comprobado en código y en prueba; descarte de la llamada si la latencia previa se come la holgura | evitar dos llamadas activas **desde el Worker** | razonamiento del protocolo; `tursoDb` ya limita cada operación a 1,5 s | **solapamiento remoto tras abortar: no garantizable (R1)**; desfase de reloj supuesto ≤ `SAFETY_MS` | invariante en código y en prueba; máximo de activas observable = 1; sin llamada si no hay holgura |
| D5c | Sonda tras el arrendamiento | evitar sondas retenidas | #84 | carreras entre instancias | pruebas de secuencia exacta |
| D6 | Fallo cerrado ante fallo de Turso | coherente con #84 | pruebas de #84 | latencia añadida | Turso caído ⇒ 503 sin llamada |
| D7 | Degradar a estimación marcada, nunca encolar; `Retry-After` solo informativo, sin reintento automático | objetivo de 5 s | decisión del propietario | calidad de las estimaciones | `dataQuality:'degraded'`; ningún reintento automático |
| D8 | `no-store` en `/table/foot`; ninguna caché | origen GPS y destinos arbitrarios | `PRIVACY.md` | menor reutilización | prueba: cabecera `no-store`, cero escrituras en `proxy_cache` |
| D9 | Chips automáticos: máx. 3 por origen, secuenciales, sin garantía; neutral "Pulsa para calcular"; búsqueda y consulta explícita sin ese límite | 8 chips no caben en el presupuesto | `chip-fanout.test.js:54` | UX del estado neutral | ≤ 3 `table` automáticas por render; tap = cálculo explícito |
| D10 | `TABLE_ENABLED` apagado al desplegar; apagado ⇒ `503 TABLE_DISABLED` estable sin reintentos | reversión sin tocar código | — | requiere un despliegue de variable | con `false`, `/table` → 503 y el cliente degrada sin bucle |

## 10. Pendiente de verificar (no se asume)
- **Equivalencia `table` / `route`**: necesita autorización expresa (1 petición `route` por servidor). Hasta entonces las pruebas unitarias solo demuestran la lógica con equivalencia simulada.
- Disponibilidad de `annotations=distance` en la `table` (no consultada; no se depende de ella).
- Tamaño máximo de matriz de cada servidor (no se busca; el diseño se queda en 4×4).
- Si el proveedor admite índices solapados entre `sources` y `destinations` (no se necesita: ver §2).
- Comportamiento del edge de producción con `Referer` (F10) y con llamadas reales bajo presupuesto (se observa tras desplegar, sin provocar errores).
- Interpretación de FOSSGIS de "1 petición por segundo" (por aplicación o por IP): el diseño toma la lectura conservadora, global.
- Regla de plausibilidad de duraciones (D3b).
- **Riesgo residual R1**: el proveedor puede seguir procesando tras un aborto o tras la muerte de una invocación; no es observable ni garantizable desde el Worker.

## 11. Secuencia de implementación (una PR independiente, commits ordenados)
1. Presupuesto genérico por upstream (§4.1–4.4) en el Worker, con pruebas de arrendamiento, exclusión mutua real y secuencia con el cortocircuito; aplicado a `route` foot/drive (cliente sin cambios).
2. Endpoint `/table/foot`, validadores, `no-store`, `TABLE_ENABLED` y pruebas de contrato.
3. Puerto `walkingMatrix`, adaptador y `FindBestJourneysUseCase` (matriz, degradaciones, geometría solo del héroe), con dobles.
4. UI: promoción coherente, geometría diferida y descartes, "ruta aproximada", chips (3 automáticos, estado neutral, cancelación).
5. Documentación (`PRIVACY.md`, `OBSERVABILITY.md`: eventos de presupuesto), `public/web` regenerado con `tsc` y `SHELL_HASH`.
Cada paso deja `npm test`, `release:check` y E2E en verde. Despliegue con el interruptor apagado primero.

## 12. Estado de las decisiones (propietario)
| Decisión | Resolución |
|---|---|
| `/table/foot` único | Aprobado como diseño; equivalencia con `route` pendiente |
| Matriz máxima 4×4 | Aprobada como límite conservador; no se investiga el máximo real |
| Presupuesto por upstream | Aprobado en principio; v2 corrige arrendamiento, tiempo límite e interacción con el cortocircuito (revisión de la #86) |
| Caché de matrices | Ninguna; v2: `no-store` |
| Geometría | Solo de la alternativa elegida; minutos válidos de `table` se conservan si falla |
| Favoritos | Máx. 3 automáticos por origen; el resto neutral; búsqueda y consulta explícita sin límite |
| Equivalencia `table`/`route` | No verificada; **no autorizada** ninguna petición adicional |
| `annotations=distance` | No depender de ella sin verificar |
| Activación | `TABLE_ENABLED` apagado inicialmente |
| Implementación | **No autorizada todavía** |
| F9 | Independiente y pendiente (sin inventar dominio, dirección ni responsable) |
