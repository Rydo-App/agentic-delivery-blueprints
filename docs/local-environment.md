# Bringing the stack up locally

This document takes a developer from a clean machine to a running stack: an API, a web front end, a relational database, a cache, a queue and the local reverse proxy that puts them behind one address. It also takes the stack back down again without leaving state behind.

Everything here runs on one machine. Nothing here talks to a deployed environment.

## Tool placeholders

The repository does not hard-code one vendor's tools. Commands in this document use these placeholders, and each one is defined by a file at the repository root.

| Placeholder | Means | Defined by |
| --- | --- | --- |
| `<pkg>` | The package manager the repository declares | The `packageManager` field in the manifest file |
| `<runtime>` | The language runtime, at the pinned version | The runtime version file at the repository root |
| `<vcs>` | The version control client | The repository's own contributor guide |
| `<container>` | The container runtime the repository declares | The compose file and the container tool note in the readme |
| `<migrate>` | The migration command the repository exposes | The `migrate` script in the manifest file |
| `<http>` | An HTTP client on the command line | The contributor guide |

Substitute the real command once and keep a shell alias for the session if that is faster.

## Prerequisites

| Prerequisite | Version | Why it is needed | How to check |
| --- | --- | --- | --- |
| A version control client | Any recent release | Fetching the source and comparing against the base branch | `<vcs> --version` |
| The language runtime | The version pinned in the runtime version file | Running the API, the front end and the tests | `<runtime> --version` |
| The package manager | The version pinned in the manifest file | Installing dependencies reproducibly | `<pkg> --version` |
| The container runtime | Any recent release | Running the scratch database and cache | `<container> --version` |
| A terminal emulator with process multiplexing | Any recent release | Running several long-lived processes at once | Start one and confirm it stays open |

Two optional tools make the rest of this document easier.

| Optional tool | What it saves |
| --- | --- |
| A process multiplexer | Keeps the API, the front end and the proxy running in one terminal window |
| A port inspection utility | Makes the "port already in use" failure below obvious instead of guesswork |

## Ports

The compose file publishes the scratch services on deliberately unusual host ports so they do not collide with a real database or cache already running on the machine.

| Host port | Service | Notes |
| --- | --- | --- |
| `55432` | Scratch relational database | Not the default port of any database product |
| `56379` | Scratch cache and queue | Same process serves both roles in development |
| `4010` | API | Reached directly for quick checks |
| `4020` | Web front end | Reached through the proxy in most cases |
| `4080` | Reverse proxy | The single address the browser and the tests use |

## The order of the steps

The order matters, because each step depends on the one before it.

1. Fetch the source and check out the branch you intend to work on.
2. Install the toolchain and the dependencies.
3. Create the local environment file from the committed example.
4. Start the scratch database and the scratch cache.
5. Apply the schema so the database has the shape the code expects.
6. Start the API and confirm it reports ready.
7. Start the web front end and confirm the sign-in screen loads.
8. Run the full test suite.
9. Tear the stack down and clear the scratch state.

## Step 1: fetch the source

```bash
<vcs> clone <repository-url>
cd agentic-delivery-blueprints
<vcs> checkout feature/example-change
```

Use the repository address your team gave you. Nothing in this document assumes a public address.

## Step 2: install the toolchain and the dependencies

```bash
<runtime> --version
<pkg> install --frozen-lockfile
```

The frozen lockfile flag matters. Without it the package manager is free to update the lock file to match the current registry, which quietly changes what you test against and leaves an unexplained diff in your working tree. If the install fails on a frozen lock file, the lock file and the manifest disagree, and that is a real problem to fix rather than to work around.

## Step 3: create the local environment file

The repository ships an example file that contains every setting name with a placeholder value. Copy it and fill in only the values the local stack needs.

```bash
cp .env.example .env.local
```

The settings a local run needs are listed below. Replace each `REPLACE_ME` with a value of your own; the values do not have to be secret, but they do have to be present.

| Setting | Local value |
| --- | --- |
| `DATABASE_URL` | `db://127.0.0.1:55432/appdb` |
| `DATABASE_USER` | `app` |
| `DATABASE_PASSWORD` | `REPLACE_ME` |
| `DATABASE_MIGRATION_URL` | `db://127.0.0.1:55432/appdb` |
| `DATABASE_MIGRATION_USER` | `migrator` |
| `DATABASE_MIGRATION_PASSWORD` | `REPLACE_ME` |
| `CACHE_URL` | `cache://127.0.0.1:56379` |
| `QUEUE_URL` | `queue://127.0.0.1:56379` |
| `IDENTITY_ISSUER_URL` | `https://identity.example.invalid` |
| `IDENTITY_CLIENT_ID` | `delivery-web-local` |
| `IDENTITY_CLIENT_SECRET` | `REPLACE_ME` |
| `IDENTITY_SESSION_SECRET` | `REPLACE_ME` |
| `SESSION_COOKIE_SECRET` | `REPLACE_ME` |
| `CSRF_SECRET` | `REPLACE_ME` |
| `NEXT_PUBLIC_API_BASE_URL` | `http://127.0.0.1:4080` |

The loopback address is the address of the machine you are sitting at. It is the one address in this document that is not a placeholder, and it never leaves the machine.

Add `.env.local` to `.gitignore` before you fill anything in. If the file is already ignored, nothing needs to change. Check with:

```bash
<vcs> check-ignore -v .env.local
```

The command prints the rule that matches. If it prints nothing, the file is not ignored, and the next command that stages every file in the tree would publish your local secrets.

The identity settings point at a placeholder address on purpose. A local run does not need a working identity service to reach a health endpoint or run the unit and contract layers. The layers that do need one either use a local stub that the test suite starts, or they are skipped with a reason recorded in the test file. See [Testing](testing.md) for the rule about skipped tests.

## Step 4: start the scratch database and the scratch cache

```bash
<container> compose -f deploy/compose.yaml up -d database cache
<container> compose -f deploy/compose.yaml ps
```

The second command must show both services in a running state before you continue. If a service is restarting in a loop, read its log:

```bash
<container> compose -f deploy/compose.yaml logs --tail 50 database
```

To wipe the scratch state and start over from an empty database, remove the volumes rather than the containers:

```bash
<container> compose -f deploy/compose.yaml down -v
```

## Step 5: apply the schema

```bash
<pkg> run <migrate> -- --env local
```

The migration command must be run with the migration connection string, not the application connection string. The local migration user has rights the application user does not, and using the wrong one produces a permission error that looks like a schema bug.

If you change a schema file later, run the command again. Migrations are applied in order and each one is recorded, so re-running the command applies only what is outstanding.

## Step 6: run the API

```bash
<pkg> run dev:api
```

Wait for the startup banner that names the port and reports the service as ready. Then check it from another terminal:

```bash
<http> --fail --silent --show-error http://127.0.0.1:4010/health/live
<http> --fail --silent --show-error http://127.0.0.1:4010/health/ready
```

`live` answers as soon as the process is up. `ready` answers only when the database and the cache have been reached and the schema matches what the code expects. A failing `ready` with a passing `live` is a wiring problem, not a crash, and the response body names the dependency that is not ready.

## Step 7: run the web front end

```bash
<pkg> run dev:web
```

Then start the proxy so the browser sees one address:

```bash
<pkg> run dev:proxy
```

Open `http://127.0.0.1:4080` in a browser. The sign-in screen renders, and the page shows the environment label `local`. A blank page with an error in the browser console usually means the front end was built without `NEXT_PUBLIC_API_BASE_URL` or `NEXT_PUBLIC_IDENTITY_ISSUER_URL`, because those values are inlined at build time and a missing one leaves the bundle pointing at an address that does not exist. See [Configuration](configuration.md).

## Step 8: run the whole test suite

```bash
<pkg> run test:all
```

This runs the unit layer, the contract layer, the integration layer against the local stack and the end-to-end layer through the proxy, in that order. The suite expects the scratch database and cache to be running. The end-to-end layer expects the front end and the proxy to be running as well.

To run one layer on its own:

```bash
<pkg> run test:unit
<pkg> run test:contract
<pkg> run test:integration
<pkg> run test:e2e
```

When the suite fails, read the summary before reading the individual failures. The summary names the layer, and the layer tells you which of the common causes below applies.

## Step 9: tear the stack down

```bash
<container> compose -f deploy/compose.yaml down -v
```

The `-v` flag removes the scratch volumes. Without it the next run starts with yesterday's data, which is a frequent source of a test that passes on a clean machine and fails on a second one.

## Common failures

| Symptom | Cause | Fix |
| --- | --- | --- |
| The process refuses to start with a port-already-in-use error on port 4010, 4020 or 4080 | A previous run is still holding the port | Stop the earlier process, or stop the whole stack with `<container> compose -f deploy/compose.yaml down` and start again |
| The API starts and then exits with "mandatory setting missing" | A value in `.env.local` is absent or still `REPLACE_ME` | Fill in the value named in the message; the message names the setting |
| The API starts and then exits with "connection refused" to the database | The scratch database was never started, or was started and then stopped | Run the compose command from step 4 and confirm the service is running |
| `password authentication failed` for the `app` user | `DATABASE_URL` points at the wrong port or the wrong database name | Compare the port and the path in the value against the ports table above |
| Migration fails with "permission denied for schema" | The migration command was run with `DATABASE_URL` instead of `DATABASE_MIGRATION_URL` | Re-run with the migration connection string |
| Migration fails with "relation does not exist" | The migration ran against a database that was not created by the compose file | Remove the volumes with `down -v` and repeat steps 4 and 5 |
| The front end renders but every request fails | The bundle points at an address that is not running | Set `NEXT_PUBLIC_API_BASE_URL` to the proxy address and restart the front end |
| The readiness endpoint stays red while the service is running | The schema does not match the code | Re-run the migration command |
| The end-to-end layer fails with a connection refused to port 4080 | The proxy is not running | Start it with `<pkg> run dev:proxy` |
| The test suite says a layer was skipped | The layer needs a service that is not running locally | Start the service, or read the skip reason in the test file |
| `<vcs> status` shows the lock file modified after an install | The install ran without the frozen lock file flag | Restore the lock file with `<vcs> checkout -- <lock-file>` and reinstall with the flag |
| The suite passes on a second run but failed on the first | The scratch database still held data from an earlier run | `down -v`, then repeat steps 4 and 5 |

## The scratch environment is disposable

Anything you need to keep belongs in a test fixture or a seed file under the repository's test directory, not in the scratch database. The scratch database is deleted every time the stack is torn down, and every developer tears their stack down at some point. If a test depends on a row someone typed by hand into the scratch database, the test will fail for somebody else and the failure will look unrelated to the change under test.
