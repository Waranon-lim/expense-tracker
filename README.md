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
   another local project). Open that URL in your browser. You will land on the
   sign-in page the first time (see "Signing in" below).

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
npm test             # run the unit tests
```

The dashboard also has a built-in "+ Simulate Transaction" button that does
the same thing without needing the CLI.

To add an expense by hand, use the "Add expense" button. Choose a merchant,
amount, category and date. The expense is saved as categorized at once. You
must be signed in.

## Signing in

- Open `http://localhost:3001/login.html` and choose "Create account". Use an
  email and a password of at least 8 characters. "Remember me" keeps you signed
  in for 30 days. Without it, you are signed out after 12 hours or when you
  close the browser.
- The first account created keeps all data that existed before accounts were
  added (it gets the id `usr_demo_1`). Every later account starts empty, with
  its own categories.
- Set `ALLOW_SIGNUP=false` in `.env` once everyone has an account. This closes
  sign-up. The very first account can always be created.
- `NOTIFICATION_SECRET` in `.env` signs the buttons on phone alerts. Any long
  random string works. Create one with `openssl rand -hex 32`.
- A bank webhook must name an existing user in its `user_id` field (for example
  `usr_demo_1` for the first account). An unknown user gets `404`.
- Passwords are never stored. The database keeps a salted scrypt hash, so two
  users with the same password have different hashes.

## Checking things are running

```bash
docker compose ps              # is Postgres up?
lsof -iTCP:3001 -sTCP:LISTEN   # is the server already running?
```
