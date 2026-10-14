# Expense Tracker

Auto-captures bank transactions via webhook, stores them, and categorizes them
either by a user tap or, after a timeout, by an automatic best-guess mapping.
Includes a small dashboard UI for viewing and managing expenses.

**Stack:** Node.js + TypeScript + Express, PostgreSQL (via Docker), vanilla
HTML/CSS/JS frontend.

## Prerequisites

- [Node.js](https://nodejs.org/) (v20+)
- [Docker Desktop](https://www.docker.com/products/docker-desktop/) (for Postgres)

## First time setup (nothing installed yet)

1. **Install dependencies**

   ```bash
   npm install
   ```

2. **Create your local env file**

   ```bash
   cp .env.example .env
   ```

   The defaults in `.env.example` already match the Docker Compose Postgres
   config below, so no edits are needed for local development.

3. **Start Postgres** (make sure Docker Desktop is running first)

   ```bash
   docker compose up -d
   ```

   This runs Postgres on port `5433` (not the default `5432`).

4. **Run the database migrations**

   ```bash
   npm run migrate
   ```

5. **Start the server**

   ```bash
   npm run dev
   ```

   The server listens on `http://localhost:3001` (port `3000` is reserved for
   another local project). Open that URL in your browser to see the
   dashboard.

## Returning later (already set up, just want to run it again)

1. **Make sure Docker Desktop is open/running**, then start Postgres if it's
   not already up:

   ```bash
   docker compose up -d
   ```

   (If the container is already running, this is a no-op.)

2. **Start the server**

   ```bash
   npm run dev
   ```

3. Open `http://localhost:3001` in your browser.

No need to repeat `npm install`, `cp .env.example .env`, or `npm run migrate`
unless dependencies changed, your `.env` was deleted, or a new file was added
under `migrations/`.

## Other useful commands

```bash
npm run mock-bank    # simulate an incoming bank webhook from the CLI
```

The dashboard also has a built-in "+ Simulate Transaction" button that does
the same thing without needing the CLI.

## Checking things are running

```bash
docker compose ps              # is Postgres up?
lsof -iTCP:3001 -sTCP:LISTEN   # is the server already running?
```
