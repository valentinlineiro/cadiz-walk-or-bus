# PR17 Boundary Hardening Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the architecture gate verify the expected Domain, Application, Infrastructure, UI, composition-root, legacy-file, and service-worker boundaries without changing product behavior.

**Architecture:** The existing gate becomes a pure, exported inspection function. A Node test exercises its result against the repository and checks the explicitly permitted composition test seams. The CLI wrapper remains the CI entry point.

**Tech Stack:** Node.js ESM, `node:test`, TypeScript source inspection, browser JavaScript import inspection.

**Spec:** `docs/architecture-audit-2026-09-18.md` and the PR17 boundary-hardening review direction.

## Global Constraints

- Behavioral change: `0`.
- Domain imports only Domain modules.
- Application imports only Application and Domain modules, except the composition root.
- Infrastructure imports Application ports and Domain modules, never UI modules.
- `public/web/ui.js` imports Application composition and presentation utilities, never Infrastructure.
- Exactly one production composition root exists: `public/web/application/composition.js`.
- The three mutable composition setters remain explicitly permitted test seams.
- No legacy bridge or deleted shell module may reappear.

### Task 1: Specify the executable architecture contract

**Files:**
- Create: `scripts/architecture-gate.test.js`
- Test: `scripts/architecture-gate.test.js`

- [x] **Step 1: Write failing tests** for zero violations, one composition root, no transitional bridges, valid shell URLs, and the three permitted test seams.
- [x] **Step 2: Run `node --test scripts/architecture-gate.test.js`** and verify it fails because the gate does not yet export the inspection API.
- [x] **Step 3: Commit the test contract** only after the failure is the expected missing-export failure.

### Task 2: Implement the pure architecture inspection

**Files:**
- Modify: `scripts/architecture-gate.mjs`

- [x] **Step 1: Export `collectArchitectureViolations()`** and keep CLI output unchanged.
- [x] **Step 2: Inspect direct imports for `src` and `public/web` layer roots, allowing only the documented composition-root exception.
- [x] **Step 3: Check composition-root count, legacy files, root domain bridges, forbidden UI imports, permitted test seams, and service-worker URL existence.
- [x] **Step 4: Run the focused architecture tests and verify they pass.

### Task 3: Run the complete regression gate

**Files:**
- Modify: none beyond Tasks 1–2.

- [x] **Step 1: Run `npm run architecture:check`.
- [x] **Step 2: Run `npm run build` and `npm run typecheck`.
- [x] **Step 3: Run `npm test` and `git diff --check`.
- [x] **Step 4: Confirm the diff contains only architecture tooling, its tests, and the PR17 plan.
