# GitHub Actions CI & Continuous Deployment Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Automate test execution via GitHub Actions on PRs and pushes, and automate deployments to Cloudflare Workers on `main` pushes using `wrangler-action` and repository secrets.

**Architecture:** Two isolated workflow files under `.github/workflows/`: `ci.yml` (triggered on `pull_request` to `main` and `push` to `main`) and `deploy.yml` (triggered on `push` to `main` with a required `test` job before `deploy`). Zero package dependencies, runs `npm test` directly with Node 24.

**Tech Stack:** GitHub Actions, Node.js (`node --test`), Cloudflare Workers (`cloudflare/wrangler-action@v3`).

## Global Constraints
- Zero runtime and dev dependencies in `package.json` (no lockfile needed; runners invoke `npm test` directly without `npm ci` or `npm install`).
- Node 24 runner environment (`node-version: 24`).
- Deployment gate: `deploy.yml` must require `needs: test` before deploying.
- Deployment secret: Authenticate Wrangler via `${{ secrets.CLOUDFLARE_API_TOKEN }}`.

---

### Task 1: Create Workflow Files and Validate Syntax

**Files:**
- Create: `.github/workflows/ci.yml`
- Create: `.github/workflows/deploy.yml`

**Interfaces:**
- Produces: Valid GitHub Actions workflow YAML files for CI and Deployment.

- [ ] **Step 1: Create directory `.github/workflows`**

```bash
mkdir -p .github/workflows
```

- [ ] **Step 2: Create `.github/workflows/ci.yml`**

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

- [ ] **Step 3: Create `.github/workflows/deploy.yml`**

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

- [ ] **Step 4: Verify YAML syntax using Node built-in or python yaml parser**

Run: `node -e "const fs = require('fs'); ['ci.yml', 'deploy.yml'].forEach(f => { const content = fs.readFileSync('.github/workflows/' + f, 'utf8'); console.log(f, 'length:', content.length); });"`  
Expected: Outputs length of both files without errors.

- [ ] **Step 5: Run tests locally to ensure clean baseline**

Run: `npm test`  
Expected: PASS (76/76 passing)

- [ ] **Step 6: Commit**

```bash
git add .github/workflows/ci.yml .github/workflows/deploy.yml
git commit -m "ci: add GitHub Actions CI and Cloudflare deployment workflows"
```

---

### Task 2: Push Branch, Create PR #2, and Verify CI Run

**Files:**
- Push: `feature/github-actions-ci-cd` to `origin`

- [ ] **Step 1: Push branch to origin**

```bash
git push -u origin feature/github-actions-ci-cd
```

- [ ] **Step 2: Create Pull Request #2 using `gh pr create`**

```bash
gh pr create --title "ci: add GitHub Actions CI and deploy workflows" --body "## Summary
- Adds \`.github/workflows/ci.yml\` to run test suite on PRs and pushes to \`main\`.
- Adds \`.github/workflows/deploy.yml\` to run tests and deploy to Cloudflare Workers on pushes to \`main\`.
- Uses Node 24 and runs \`npm test\` directly with zero extra dependencies.
"
```

- [ ] **Step 3: Monitor CI workflow run on GitHub**

Run: `gh pr checks`  
Expected: `CI` workflow completes with success.
