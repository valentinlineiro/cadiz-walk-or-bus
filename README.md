# Cádiz: ¿andar o bus?

Una PWA para decidir si te compensa andar o esperar el bus urbano en Cádiz.

## Qué hace

La aplicación compara el tiempo de caminar con las próximas llegadas de bus y
presenta una recomendación principal, alternativas y una explicación breve.

- Usa llegadas realtime cuando el servicio municipal está disponible.
- Si el servicio municipal no responde, lo dice: no inventa horarios ni usa otra fuente. Ofrece el tiempo andando como información, no como recomendación.
- Permite buscar un destino y usar el GPS como origen.
- Está pensada para móvil y puede instalarse como PWA.

## Cómo usarlo

Abre la aplicación, permite el GPS si quieres usar tu posición, busca un
destino y selecciona una opción. La aplicación calcula la recomendación con
los datos disponibles en ese momento.

Data source: Cadiz's own live transit arrival panel
(`http://77.224.241.76/urbanos/mobile/panel.aspx?stop=<stop>`)
— the same source BusCadiz uses. `stop` is the transit system's internal
numeric ID (e.g. `1106`), not the display line number. The Worker's
`/api?stop=<stop>` only serves the stops listed in `stops.json` (refresh
it with `scrape-stops.js` when the operator adds stops); unknown ids get
`404` and the `route` parameter is ignored.

## Estado

La aplicación está preparada para la beta pública de Cádiz. La arquitectura y
la planificación v1 están estabilizadas; la publicación depende de completar
el release gate de producción, experiencia móvil y operación.

## Beta scope

The public beta supports:

- Cádiz.
- Walking.
- Urban bus.
- Realtime arrivals.
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

There is no scheduled fallback: when the municipal service does not answer, the app says it
has no bus data and offers walking only as an option to weigh, never as a conclusion.

## Limitaciones

- Arrival data depends on the municipal service alone; there is no second source.
- Walking and routing estimates depend on the available geocoding and routing
  services.
- The application does not require or provide user accounts.

## Datos y atribuciones

Transit data comes from Cádiz's municipal realtime panel. Map, geocoding, and routing
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
