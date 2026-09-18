# Architecture Audit — 2026-09-18

## Scope

PR16 audits the post-PR15 tree for transitional modules, duplicate implementations,
hidden UI domain logic, infrastructure leakage, dead exports, and composition roots.
The audit is cleanup-only: no product behavior or application contracts change.

## Baseline findings

| Area | Count | Finding | Action |
| --- | ---: | --- | --- |
| Transitional runtime files | 6 | Root `public/web/*.js` re-export bridges for domain modules | Removed; consumers now import `public/web/domain/*` directly |
| Duplicate domain implementations | 0 | Domain logic exists in `public/web/domain` and compiled `src/domain`, not as two runtime implementations | Keep TypeScript source and generated browser output aligned |
| Dead compatibility exports | 6 | The same root domain bridges exported compatibility-only APIs with no runtime consumers | Removed; no replacement shim added |
| UI boundary violations | 0 | `ui.js` composes use cases and presentation helpers only | Verified by import audit and architecture gate |
| Application boundary violations | 0 | Application imports domain and ports only | Verified by architecture gate |
| Domain boundary violations | 0 | Domain has no I/O, DOM, or infrastructure imports | Verified by architecture gate |
| Composition roots | 1 | `public/web/application/composition.js` is the only production wiring point | Keep as the single composition root |
| Test-only composition hooks | 3 | `setTransitAdapter`, `setCachedStops`, `setCachedLines` are used by infrastructure tests | Retain; they are explicit test seams, not runtime bridges |
| Service-worker stale entries | 1 | `/web/topology.js` was cached after its bridge became unused | Removed from the shell allowlist |

## Dependency shape

```text
UI
  -> application composition
  -> presentation utilities

Application
  -> domain
  -> application ports

Infrastructure
  -> application ports
  -> domain models and pure mapping helpers

Domain
  -> domain only
```

## Result

`CLEANUP COMPLETE` for PR16's scope.

The remaining composition test hooks are intentionally retained and covered. A
future architecture-gate strengthening PR may verify this inventory mechanically,
but this cleanup does not broaden into behavior changes or a new dependency policy.
