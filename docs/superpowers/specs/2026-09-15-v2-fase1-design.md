# V2 Fase 1 — Diseño (2026-09-15)

Tesis: el mapa explica la decisión en menos de un segundo, sin abrir nada. Modelo intacto: espera-vs-andar (`decide()` manda); «Bus X min» se renombra a «Espera X min».

## Identidad semántica
- Azul → tú (punto GPS). Verde → andar. Ámbar → espera bus. Gris → sin datos/degradado.
- Parada enfocada: escala mayor + halo. Las otras dos: peso visual menor.

## Pines-círculo (opción B elegida)
- El pin ES el minuto: círculo con `4′` / `9′` / `—`, color semántico, borde blanco + sombra.
- Nada de tooltips para el dato crítico; tooltip opcional solo con el nombre.
- Solo render en `map.js`; sin lógica de negocio en Leaflet.

## Tarjeta duelo (opción B elegida)
- Dos mitades: 🚶 Andar `12′` vs 🚌 Espera `4′ (L1)`; la ganadora enmarcada en su color; veredicto `→ BUS` / `→ ANDAR` debajo.
- Sin destino: la tarjeta lista las cercanas con sus círculos-pequeños/tiempos.
- Estado calculando: spinner + «Calculando…» (nunca texto gris estático que parezca congelado).

## Reglas intactas de la spec anterior
- Debounce Nominatim 400ms + 1 req/s; request-id monotónico; AppState explícito; fallback único (sin destino → paradas; sin ruta → Andar; sin llegada viva → Andar).

No-objetivos Fase 1: ruta dibujada, buscador con sugerencias, puerta-a-puerta, tráfico (Fase 2 y más allá).
