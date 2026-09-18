# Cádiz: ¿andar o bus?

Una PWA para decidir si te compensa andar o esperar el bus urbano en Cádiz.

## Qué hace

La aplicación compara el tiempo de caminar con las próximas llegadas de bus y
presenta una recomendación principal, alternativas y una explicación breve.

- Usa llegadas realtime cuando el servicio municipal está disponible.
- Usa horarios GTFS programados cuando realtime no está disponible.
- Permite buscar un destino y usar el GPS como origen.
- Está pensada para móvil y puede instalarse como PWA.

## Cómo usarlo

Abre la aplicación, permite el GPS si quieres usar tu posición, busca un
destino y selecciona una opción. La aplicación calcula la recomendación con
los datos disponibles en ese momento.

También conserva el artefacto de línea de comandos original:

Given a bus stop, a route, and how long it takes you to walk to your
destination, tells you the soonest bus and whether it beats walking.

```
node index.js <stop> <route> <walkMinutes>
node index.js 1106 110001 19
```

```
Bus 1 (CORTADURA): arrives in 3 min.
Walk: 19 min.
-> bus.
```

Data source: Cadiz's own live transit arrival panel
(`http://77.224.241.76/urbanos/mobile/panel.aspx?stop=<stop>&route=<route>`)
— the same source BusCadiz uses. `stop`/`route` are the transit system's
internal numeric IDs (e.g. `1106`/`110001`), not the display line number
(e.g. "1").

## Estado

La aplicación está en beta pública para Cádiz. La arquitectura y la
planificación v1 están estabilizadas; el trabajo pendiente se centra en
fiabilidad de producción, experiencia móvil y operación.

## Beta scope

The public beta supports:

- Cádiz.
- Walking.
- Urban bus.
- Realtime arrivals.
- Scheduled GTFS fallback.
- Destination search.
- GPS-assisted origin selection.
- PWA use on supported mobile browsers.
- One hero recommendation and up to three exact candidates in total.

The beta does not support:

- Accounts or authentication.
- Notifications.
- Personalization, ML, or automatic learning.
- Multiple cities.
- Other transport modes or operators.

Scheduled arrivals are not realtime predictions and may be less precise.

## Limitaciones

- Arrival data depends on the municipal service and the checked-in GTFS
  snapshot.
- Walking and routing estimates depend on the available geocoding and routing
  services.
- The application does not require or provide user accounts.

## Datos y atribuciones

Transit data comes from Cádiz's municipal realtime panel and the official NAP
GTFS feed used to build the scheduled snapshot. Map, geocoding, and routing
providers must be credited in the deployed application according to their
respective terms and licenses.

## Development

Install dependencies and run the checks:

```
npm install
npm run typecheck
npm run build
npm test
```

Run the Worker locally with Wrangler:

```
npm run dev
```

The release process and public-beta checklist live in
[`docs/RELEASE.md`](docs/RELEASE.md).
