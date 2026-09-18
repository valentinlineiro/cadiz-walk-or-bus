# Public beta scope

Status: frozen for the Cádiz public beta.

## Product promise

> ¿Me compensa andar o esperar el bus?

The beta answers that question for a journey in Cádiz using the current
walking and urban-bus data available to the app.

## In scope

- Cádiz as the supported territory.
- Walking.
- Cádiz urban bus.
- Realtime arrivals when the municipal service is available.
- GTFS scheduled arrivals when realtime is unavailable.
- Destination search.
- GPS-assisted origin selection.
- PWA installation and use on supported mobile browsers.
- One hero recommendation and up to three exact candidates in total.
- Alternatives and a short explanation of the recommendation.
- Anonymous operation without user accounts.

## Out of scope

- User accounts or authentication.
- Notifications.
- Machine learning or habit prediction.
- Personalized weights or automatic learning.
- Multi-city support.
- Other transport operators or modes.
- Advanced personalization.
- A promise that scheduled data has realtime precision.

## Release constraints

- Architecture is frozen unless a production or user-evidence gate requires a
  change.
- New behavior requires a reproducible gate case or observed user failure.
- The beta must disclose when it is using scheduled rather than realtime data.
- No personal data is required to use the product.
