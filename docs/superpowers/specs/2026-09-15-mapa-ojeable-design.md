# Mapa ojeable — Diseño (2026-09-15)

Producto: mapa a pantalla completa para decidir andando-vs-bus en Cádiz, usable a una mano y con prisa.

## Pantalla principal
- Mapa 100% (Leaflet + teselas OSM, sin claves).
- Punto azul GPS (permiso una vez; autocentrado al abrir).
- Las 3 paradas más cercanas con insignia de minutos en vivo (datos de `GET /stops` + `GET /api?stop=N`).
- Buscador fijo arriba: «¿A dónde vas?» (Nominatim).
- Apertura: centra por GPS → carga `/stops` → pide tiempos de las cercanas.

## Tarjeta inferior
- Sin destino: lista las paradas cercanas con sus minutos en vivo; tocar un pin centra la tarjeta en esa parada.
- Con destino: `Andar X min` (OSRM a pie GPS→destino) vs `Bus Y min (Línea Z destino)` (mejor llegada viva de la parada enfocada) + veredicto grande →Bus / →Andar (regla actual de `decide()`).
- Sin parada enfocada: se usa la más cercana con datos en vivo.

## Errores y casos borde
- Sin GPS: aviso + centro en Cádiz para explorar manual.
- Parada sin buses próximos: insignia «—», veredicto Andar.
- Panel caído (`/api` 502): «sin datos en vivo → Andar».
- Geocodificación sin resultados: mensaje inline, se mantiene el mapa.

## Datos y APIs (todo sin claves)
- Teselas OSM, Nominatim (búsqueda + respeto 1 req/s), OSRM demo (`route/v1/foot`) para andar.
- Propios: `GET /stops` (106 paradas), `GET /api?stop=N` (stop-only).

## Reglas técnicas
- Búsqueda Nominatim solo tras pausa/submit (debounce), 1 req/s; sin búsquedas mientras escribe.
- Carrera de peticiones: si cambia destino/parada, solo la última respuesta actualiza el estado (AbortController o request-id monotónico).
- Estado explícito: `LOCATING | LOADING_STOPS | READY | GEOCODING | ROUTING | DECIDING | ERROR` (sin booleanos accidentales).
- Fallback único: sin destino → paradas; sin ruta andando → Andar; sin llegada viva → Andar; si no → bus (andar-a-parada + espera) vs andar total.
- OSRM a pie verificado contra distancia: si la velocidad implícita no es humana (>12 km/h), estimar por distancia a 5 km/h (el demo OSRM ha servido tiempos de coche).
- Leaflet solo dibuja: datos en `api/`, decisión en `decision/decide()`, la UI representa.

No-objetivos: favoritos/guardados, origen manual distinto del GPS, tiempo de trayecto en bus, modo offline, PWA instalable.
