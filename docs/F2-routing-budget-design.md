# F2 — Presupuesto por upstream y reducción de llamadas (borrador técnico)

Estado: borrador revisado tras la primera ronda (decisiones aprobadas en §9); **implementación aún no autorizada**. **Sin código, sin configuración, sin datos y sin peticiones nuevas a los upstreams.** Commit base: `3a51b52`. Fecha: 2026-10-19.

## 0. Dos correcciones a lo dicho hasta ahora
1. **No hace falta una matriz de coche.** `RoutingPort.routeBus` devuelve solo geometría (`OsrmRoutingAdapter.ts`, `routeBus`); los minutos del trayecto en bus salen de la topología (`cand.estimate.rideMinutes`), no de OSRM. La opción B de la propuesta anterior ("dos `table`") queda en **una sola `table`, la de a pie**.
2. **El mayor consumidor de llamadas son los chips de favoritos**, no la búsqueda. Cada chip ejecuta el pipeline completo (`GetQuickVerdictUseCase` → `FindBestJourneysUseCase`, con `withBusGeometry:false`), hasta 8 favoritos, y el propio test fija el techo en `FAVORITES * 5` = **40 peticiones a pie por render** (`chip-fanout.test.js:54`). La captura real no los incluyó. Sin tratarlos, el presupuesto no se sostiene.

## 1. Dónde se gastan las llamadas hoy (código)
| Etapa | Llamadas | Upstream | Cacheable en el Worker |
|---|---|---|---|
| Candidato "andar": origen→destino | 1 | foot | no si el origen es GPS |
| Candidato bus: origen→parada de subida | 1 | foot | **no** (origen GPS, privacidad) |
| Candidato bus: parada de bajada→destino | 1 | foot | sí (empieza en una parada conocida) |
| Candidato bus: geometría | **1 por tramo** entre paradas (5–15 típico) | drive | sí, 24 h (`route:drive:`) |
Hasta 3 candidatos se evalúan a fondo (`FindBestJourneysUseCase.ts`, paso 3), en paralelo (`Promise.all`). Todo el `routeBus` es solo geometría visual. Red de 10 direcciones, 12–26 paradas cada una: ~150 pares de paradas en total, así que la caché de tramos converge rápido.

## 2. Contrato de `GET /table/foot/{coords}`
- Solo perfil `foot` (no se expone `drive`: no hay minutos que pedir).
- `{coords}`: `lon,lat;lon,lat;…`, mismo patrón numérico que `ROUTE_PATH`, **2 a 8 coordenadas** (≤4 orígenes + ≤4 destinos, **matriz máxima 4×4**).
- Query obligatoria: `sources=i;j` y `destinations=k;l` (índices enteros dentro de rango, sin repetir, conjuntos **disjuntos**, 1–4 cada uno).
- Cada coordenada dentro de `ROUTE_BOX` (misma validación de área que las rutas); cualquier otra cosa → `400 INVALID_ROUTE` / `OUTSIDE_SERVICE_AREA`.
- Upstream: `routing.openstreetmap.de/routed-foot/table/v1/foot/{coords}?sources=…&destinations=…` (por defecto devuelve solo duraciones; evidencia del 2026-10-19T10:18:57Z).
- Validación de la respuesta (`validTable`): `code:"Ok"`; `durations` con exactamente |S| filas × |D| columnas; cada celda número finito ≥ 0 o `null`; `sources`/`destinations` de la longitud correcta con `location` finito y `distance` (distancia de ajuste a la red) finita ≥ 0. Cualquier fallo → `502 UPSTREAM_INVALID_RESPONSE`; `NoTable` → `404 UPSTREAM_NOT_FOUND`.
- Respuesta al cliente, normalizada (sin `hint`, que pesa y no se usa): `{"code":"Ok","durations":[[…]],"snap_m":{"sources":[…],"destinations":[…]}}`.
- Cabeceras: `Cache-Control: private, max-age=…` (nunca compartida, ver §6). Errores: los códigos estables ya existentes.

## 3. Planificación de rutas
1. Puerta barata (sin red), como hoy: ≤3 candidatos.
2. **Una `table` a pie** con S = {origen, paradas de bajada} y D = {paradas de subida, destino}; cubre origen→subida, origen→destino (caminar) y bajada→destino. Con 3 candidatos es exactamente 4×4.
3. Minutos exactos de cada tramo = `ceil(duración/60)` con las comprobaciones de §5. Reordenación y elección del héroe como hoy (solo usa minutos).
4. **Geometría solo del candidato elegido**: `routeWalking` de sus tramos y `routeBus` tramo a tramo, cada una contra su presupuesto. Las alternativas muestran minutos y se dibujan con línea recta hasta que el usuario las promueve; en ese momento se pide su geometría (cambio de UI en `promote`).
5. Los minutos de la `table` y la geometría son datos distintos y la interfaz los distingue: si la geometría es aproximada, se rotula "ruta aproximada" sin tocar los minutos.
6. **Contrato de UI al promover una alternativa** (coherencia, un solo flujo): (i) la selección, el veredicto y los minutos cambian a la vez y de inmediato, con los minutos que ya se conocen; (ii) la geometría se pide después y mientras tanto se dibuja la línea recta rotulada aproximada; (iii) un fallo de geometría **nunca** altera minutos ni veredicto ni deshace la selección; (iv) se descartan las respuestas de geometría que lleguen tarde de una alternativa que ya no es la seleccionada (identificador de petición por promoción).

Cambio de puertos (arquitectura limpia): `RoutingPort` gana `walkingMatrix(sources, destinations)`; el adaptador OSRM llama a `/table/foot`; el caso de uso no conoce HTTP.

## 4. Presupuesto por upstream
- Un presupuesto independiente por `osrm-foot` y `osrm-drive` (Nominatim ya tiene el suyo). Regla: **máximo 1 petición en vuelo y ≥ 1 s entre el final de una y el inicio de la siguiente**; sin cola.
- Implementación: una fila `lease:<upstream>` en `proxy_slot` (sin migración). Reservar = `UPDATE … SET next_at = ahora + 6 s WHERE name = ? AND next_at <= ahora` (atómico, como la sonda del cortocircuito); liberar = `UPDATE … SET next_at = ahora + 1 s WHERE name = ? AND next_at = <mi valor>` (solo el propietario). Si el Worker muere, el arrendamiento caduca solo.
- Orden en cada llamada: caché compartida → cortocircuito (#84) → arrendamiento → llamada → liberación. Con el cortocircuito abierto no se gasta arrendamiento.
- Sin presupuesto: `503 BUSY` + `Retry-After` inmediato (sin esperar); el cliente degrada (§5).
- **Fallo cerrado**: si Turso está configurado y falla, no se llama. Sin secretos (solo desarrollo) rige memoria del isolate.
- Coste añadido: ~3 viajes a Turso por llamada upstream (lectura del cortocircuito + reserva + liberación) en cada fallo de caché. A optimizar luego (agrupar) si molesta; no cambia el contrato.
- **Un único presupuesto compartido por upstream.** La fila `lease:<upstream>` coordina **todo** lo que comparte upstream: chips, búsquedas, geometría y cualquier otro cliente, y entre todas las instancias del Worker (el estado vive en Turso). No se limita cada *pipeline* por separado: un chip, una búsqueda y una petición de geometría compiten por el mismo arrendamiento. No se garantiza ninguna llamada: si no hay capacidad, no se lanza y no se acumula en cola.
- **Capacidad: teórica frente a efectiva (todo son estimaciones, no medidas ni garantías).**
  - *Teórica*: ~0,2 s de latencia (2 muestras del 2026-10-19) + 1 s de separación ⇒ ~1 llamada cada 1,2 s ⇒ **~50 llamadas/min por upstream**.
  - *Coste por flujo* (llamadas a pie que consumen presupuesto): búsqueda = 1 `table` + hasta 2 rutas del elegido = **3**; chips automáticos = hasta **3** `table` por origen; geometría de una alternativa promovida = hasta 2 más; consulta explícita de un favorito = como una búsqueda (3).
  - *Sesión típica* (abrir la app con chips y hacer una búsqueda) ≈ 3 + 3 = **6 llamadas ≈ 7 s de presupuesto** ⇒ **~8 sesiones/min** como techo teórico si todo el mundo usa todos los flujos; ~16 búsquedas/min si no hay chips; ~50 usos de solo `table`/min.
  - *Efectiva*: más baja que la teórica, por aciertos de caché (que bajan el consumo), contención (`BUSY` para quien llega con el arrendamiento ocupado), latencia de Turso (~3 viajes por llamada), reintentos del usuario y la franja del cortocircuito. Se mide tras el despliegue con `proxy_request` y `upstream_blocked`; hasta entonces **no se prometen cifras**.
  - Superar el techo exige otro proveedor o uno propio (F6).

## 5. Degradación (nunca se presenta una estimación como duración del proveedor)
| Fallo | Comportamiento |
|---|---|
| Sin presupuesto o error en la `table` | se usa la estimación existente (`cand.estimate.*`, `computeLastMile(null, …)`), `dataQuality:'degraded'` y `lastMileDegraded:true` (rutas ya soportadas) |
| `null` en una celda (sin ruta a pie) | el candidato cuyo tramo es `null` se descarta, como hoy con `routeWalking` → `null` |
| Duración incoherente: < distancia en línea recta ÷ 3,5 m/s, o ajuste a la red > 150 m | tramo tratado como fallo de servicio (estimación degradada). La regla actual usa la distancia de la ruta, que `table` no entrega: es una **aproximación pendiente de validar** |
| Falla la geometría o no hay presupuesto | línea recta por las paradas, rotulada aproximada; los minutos válidos de la `table` se conservan |
| Cortocircuito abierto / Turso caído | igual que arriba: `503` y estimación degradada |
Los plazos: ninguna petición de geometría arranca si ya pasaron 3,5 s desde el inicio de la búsqueda (objetivo de respuesta 5 s).

## 6. Privacidad y caché
- **Ninguna `table` que contenga el origen GPS se guarda en la caché compartida**, y en la práctica ninguna de la clasificación (el destino tampoco es una parada). v1: **sin caché compartida para `table`**; solo `Cache-Control: private` en el navegador.
- Las geometrías de tramos parada→parada siguen cacheadas 24 h (claves por coordenadas de parada, sin datos de usuario). Opción a valorar: subir ese TTL (las calles cambian poco).
- El limitador cuenta peticiones, no las identifica: las filas `lease:*` no contienen coordenadas ni IP.
- Claves y cruces: no hay clave compartida para `table`, así que no hay cruce entre usuarios; la coalescencia en vuelo no se aplica a `table` (cada una lleva su origen).

## 7. Chips de favoritos (decisión aprobada: límite solo para el trabajo automático)
- El límite de **3 chips calculados automáticamente por origen** se aplica **únicamente al trabajo automático de los chips**. La búsqueda principal y la consulta explícita de un favorito conservan el pipeline y el veredicto normales.
- Los chips automáticos se calculan de forma **secuencial** y dentro del presupuesto común. **Tres es un máximo, no tres llamadas garantizadas**: si no hay capacidad (arrendamiento ocupado, cortocircuito abierto, Turso caído) no se lanza el siguiente cálculo y no se acumula trabajo pendiente.
- Los chips no calculados muestran un estado **neutral** ("Pulsa para calcular"): no parecen ni mejores ni peores por no tener dato (ni "—" ni tiempo estimado).
- Al pulsar uno, se solicita su cálculo explícito con el mismo presupuesto global; si no hay un resultado fiable, estado degradado o sin veredicto, nunca una estimación presentada como duración exacta.
- Los chips automáticos se cancelan en cuanto el usuario inicia una búsqueda (prioridad a la acción explícita).

## 8. Pruebas y despliegue
- **Contrato**: coordenadas inválidas/fuera de área, >8 coordenadas, matriz >4×4, índices repetidos/fuera de rango/solapados, respuesta con filas de más o de menos, celdas `NaN`/texto, `null`, `NoTable`, 5xx, JSON mal formado.
- **Concurrencia**: N peticiones simultáneas → como mucho 1 llega al upstream y el resto recibe `BUSY` (reloj simulado, como las pruebas del cortocircuito); separación ≥ 1 s; arrendamiento que caduca si el propietario muere; liberación solo del propietario.
- **Contención entre flujos**: chips, búsqueda y geometría compitiendo por el mismo arrendamiento (y desde "dos instancias" con estado compartido): nunca 2 en vuelo, ninguna cola, el excedente recibe `BUSY`; los chips no se reintentan solos al fallar.
- **UI**: promover una alternativa actualiza selección, veredicto y minutos a la vez; un fallo de geometría no cambia minutos ni veredicto; una respuesta de geometría tardía de otra alternativa se descarta; chips: tope 3 automáticos, resto neutral, tap = cálculo explícito.
- **Integración con el cortocircuito**: bloqueado ⇒ sin arrendamiento; sonda ⇒ pasa por presupuesto; Turso caído ⇒ fallo cerrado.
- **Planificador**: con `table` simulada, mismas decisiones y minutos que con rutas simuladas equivalentes; geometría solo del héroe; degradaciones del §5 etiquetadas; chips ≤ K exactos.
- **Despliegue**: sin forzar 403/429; interruptor `TABLE_ENABLED` (variable del Worker) que apaga `/table` con `503` y hace que el cliente degrade; comprobación posterior solo con lecturas: salud, una búsqueda normal desde el móvil y los eventos `proxy_request`/`upstream_blocked` en los registros.

## 9. Tabla de decisión
| # | Decisión | Justificación | Evidencia | Incertidumbre | Criterio de aceptación |
|---|---|---|---|---|---|
| D1 | Una sola `table` (a pie), sin `table` de coche | `routeBus` no usa minutos de OSRM | código, `OsrmRoutingAdapter.ts` | ninguna sobre el código | el planificador no llama a ningún `table` de coche |
| D2 | Matriz máxima 4×4, 8 coordenadas | cubre 3 candidatos exactos; conservador | consulta 1×3 del 2026-10-19, sin barrido | tamaño máximo real **no medido** | rechazo de matrices mayores con `400`; ningún barrido |
| D3 | Minutos de `table` como minutos de tramo | evita 3–5 llamadas por búsqueda | 2 respuestas 200 con duraciones plausibles | **equivalencia con `route` sin verificar**; falta `distance` de la ruta | tras autorizar una comparación, diferencia documentada; hasta entonces el diseño no la da por válida |
| D4 | Geometría solo del héroe | ranking solo usa minutos | código del paso 4 | cambio de UI al promover alternativas | el número de llamadas de geometría por búsqueda ≤ las del héroe |
| D5 | 1 petición en vuelo + ≥1 s por upstream, sin cola | FOSSGIS: "1 solicitud por segundo" y "scripts limitados a una conexión" | texto íntegro de las condiciones | cómo mide FOSSGIS 1/s (por IP o aplicación): no especificado | prueba de concurrencia: nunca 2 en vuelo ni 2 inicios en < 1 s |
| D6 | Fallo cerrado ante fallo de Turso | decisión previa y consistente con #84 | pruebas de #84 | latencia añadida por Turso | prueba: Turso caído ⇒ 503 sin llamada |
| D7 | Degradar a estimación marcada, nunca encolar | objetivo 5 s | decisión del propietario | calidad de las estimaciones | `dataQuality:'degraded'` siempre que no haya dato del proveedor |
| D8 | Sin caché compartida para `table` | origen GPS y destinos arbitrarios | `PRIVACY.md`, cómo se cachean rutas hoy | menor reutilización | prueba: ninguna escritura en `proxy_cache` por `table` |
| D9 | Chips automáticos: máx. 3 por origen, secuenciales, sin garantía; el resto neutral; búsqueda y consulta explícita sin ese límite | 8 chips no caben en el presupuesto | `chip-fanout.test.js:54` | UX del estado neutral | ≤ 3 tablas automáticas por render; tap = cálculo explícito |
| D10 | Interruptor `TABLE_ENABLED`, **apagado al desplegar**; no se enciende hasta completar pruebas y criterios de despliegue | reversión sin tocar código | — | requiere un despliegue de variable | con `false`, `/table` → 503 y el cliente degrada |

## 10. Pendiente de verificar (no se asume)
- Equivalencia `table` / `route` (necesita autorización expresa: 1 petición `route` por servidor).
- Disponibilidad de `annotations=distance` en la `table` (no consultada).
- Tamaño máximo de matriz permitido por cada servidor (no se busca; el diseño se queda en 4×4).
- Comportamiento del edge de producción con `Referer` (F10) y con peticiones reales bajo presupuesto (se observa tras desplegar, sin provocar errores).
- La interpretación de FOSSGIS de "1 petición por segundo" (por aplicación vs por IP): el diseño toma la lectura conservadora, global.

## 11. Secuencia de implementación (una PR independiente, commits ordenados)
1. Presupuesto genérico por upstream (arrendamiento) en el Worker + pruebas de concurrencia; aplicado a `route` foot/drive (sin cambiar aún el cliente).
2. Endpoint `/table/foot` + validadores + `TABLE_ENABLED` + pruebas de contrato.
3. Puerto `walkingMatrix` y adaptador; `FindBestJourneysUseCase` con matriz, degradaciones y geometría solo del héroe; pruebas con dobles.
4. UI: geometría diferida al promover, rótulo de "ruta aproximada", chips con K exactos y cancelación.
5. Documentación (`PRIVACY.md`, `OBSERVABILITY.md`: eventos de presupuesto) y regeneración de `public/web` y `SHELL_HASH`.
Cada paso deja `npm test`, `release:check` y E2E en verde. Despliegue con interruptor apagado primero, después encendido y observación.

## 12. Estado de las decisiones (propietario, ronda 1)
| Decisión | Resolución |
|---|---|
| `/table/foot` único | Aprobado como diseño; equivalencia con `route` pendiente |
| Matriz máxima 4×4 | Aprobada como límite conservador; no se investiga el máximo real |
| Presupuesto por upstream (1 en vuelo, ≥1 s, sin cola, fallo cerrado) | Aprobado |
| Caché de matrices | Ninguna matriz con origen GPS en caché compartida |
| Geometría | Solo de la alternativa elegida; minutos válidos de `table` se conservan si falla |
| Favoritos | Máx. 3 automáticos por origen; el resto neutral; búsqueda y consulta explícita sin límite |
| Equivalencia `table`/`route` | No verificada; **no autorizada** ninguna petición adicional |
| `annotations=distance` | No depender de ella sin verificar soporte |
| Activación | `TABLE_ENABLED` apagado inicialmente |
| Implementación | **No autorizada todavía** |
| F9 | Independiente y pendiente (sin inventar dominio, dirección ni responsable) |
