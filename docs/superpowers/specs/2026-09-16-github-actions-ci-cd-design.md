# Design Spec: GitHub Actions CI & Continuous Deployment

**Date:** 2026-09-16  
**Status:** Approved by user  
**Target:** `cadiz-walk-or-bus`

---

## 1. Overview & Objectives

Automate the safety net of `cadiz-walk-or-bus` by establishing GitHub Actions workflows:
1. **CI Pipeline (`ci.yml`):** Automatically run `npm test` on every pull request targeting `main` and on direct pushes to `main`.
2. **Continuous Deployment (`deploy.yml`):** Automatically test and deploy pushes to `main` using `cloudflare/wrangler-action@v3` and `secrets.CLOUDFLARE_API_TOKEN`.

---

## 2. Core Constraints & Decisions

1. **Zero Runtime / Dev Dependencies:** Keep `package.json` with zero dependencies and no `package-lock.json`. Node's built-in test runner (`node --test`) runs natively without `npm ci` or `npm install`.
2. **Node Version Floor:** Use Node.js 24 (`node-version: 24`), consistent with development environment (`v24.14.1`).
3. **Workflow Separation:**
   - `.github/workflows/ci.yml`: Pure verification gate for PRs and `main` pushes.
   - `.github/workflows/deploy.yml`: Deployment pipeline with an independent `test` job acting as a mandatory gate (`needs: test`) before triggering `deploy`.
4. **Secret Management:** Deployment authenticates via `secrets.CLOUDFLARE_API_TOKEN` (configured in repository settings).

---

## 3. Workflow Specifications

### 3.1 `.github/workflows/ci.yml`
```yaml
name: CI

on:
  pull_request:
    branches: [main]
  push:
    branches: [main]

jobs:
  test:
    name: Run tests
    runs-on: ubuntu-latest
    steps:
      - name: Checkout repository
        uses: actions/checkout@v4

      - name: Setup Node.js
        uses: actions/setup-node@v4
        with:
          node-version: 24

      - name: Run test suite
        run: npm test
```

### 3.2 `.github/workflows/deploy.yml`
```yaml
name: Deploy

on:
  push:
    branches: [main]

jobs:
  test:
    name: Test before deploy
    runs-on: ubuntu-latest
    steps:
      - name: Checkout repository
        uses: actions/checkout@v4

      - name: Setup Node.js
        uses: actions/setup-node@v4
        with:
          node-version: 24

      - name: Run test suite
        run: npm test

  deploy:
    name: Deploy to Cloudflare Workers
    needs: test
    runs-on: ubuntu-latest
    steps:
      - name: Checkout repository
        uses: actions/checkout@v4

      - name: Deploy with Wrangler
        uses: cloudflare/wrangler-action@v3
        with:
          apiToken: ${{ secrets.CLOUDFLARE_API_TOKEN }}
```

---

## 4. Verification & Gates

1. **Local Syntax & Schema Validation:** Validate yaml files and ensure valid GitHub Actions syntax.
2. **PR Verification:** Open PR #2 (`feature/github-actions-ci-cd`). Confirm GitHub triggers the `CI` workflow on the PR.
3. **Test Gate:** All 76 tests must pass in CI runner.
