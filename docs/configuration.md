# Configuration reference

This document is the catalogue of settings that a deployment of the agent delivery stack needs. It covers the identity service, the messaging service, the web front end, the database, the cache and queue, the object storage, the outbound email and short-message providers, and the CI and release pipeline.

Every setting in this document is described in the same five columns.

| Column | Meaning |
| --- | --- |
| Setting | The exact environment variable name. Names are case sensitive. |
| What it does | One sentence describing the behaviour the setting controls. |
| Required | `Yes`, `No`, or `Conditional` with the condition stated. |
| Example | A placeholder value that is safe to publish. Replace it with a real value locally. |
| Present at | `Build`, `Run`, or `Build and run`. See the legend below. |

## Build time and run time

| Term | Meaning |
| --- | --- |
| Build | The value must exist when the artefact is produced. Changing it requires a rebuild. |
| Run | The value is read when the process starts or on each request. Changing it requires a restart. |
| Build and run | The value is needed in both places, usually with the same meaning but read by different code. |

## Warning about browser-visible settings

> Any setting whose name starts with `NEXT_PUBLIC_` is inlined into the browser bundle at build time.
>
> The value is not hidden. It is readable by anyone who opens the browser developer tools or downloads the bundle. The prefix changes nothing about confidentiality; it only changes where the value ends up.
>
> Therefore **a setting prefixed `NEXT_PUBLIC_` must never hold a secret**: no API keys, no tokens, no passwords, no connection strings, no signing material, no tenant identifiers that are considered private.
>
> The bundler performs no check for this. A secret placed behind the prefix is published to every visitor of that site. The build pipeline includes a check that scans the bundle for values that also appear in the secret store, and fails the build when a match is found. See the guard in [The naming convention for secrets](#the-naming-convention-for-secrets).

## Identity service

The identity service issues and validates the sessions that every other component trusts.

| Setting | What it does | Required | Example | Present at |
| --- | --- | --- | --- | --- |
| `IDENTITY_ISSUER_URL` | Base address the identity service publishes its issuer metadata under. | Yes | `https://identity.example.invalid` | Run |
| `IDENTITY_CLIENT_ID` | Identifier of this deployment registered as a client of the identity service. | Yes | `delivery-web` | Run |
| `IDENTITY_CLIENT_SECRET` | Shared secret proving this deployment may exchange a code for a token. | Yes | `REPLACE_ME` | Run |
| `IDENTITY_REDIRECT_URI` | Exact callback address the identity service returns the browser to. Must match a registered value exactly, including trailing slash. | Yes | `https://app.example.invalid/auth/callback` | Run |
| `IDENTITY_SCOPE` | Space-separated list of scopes requested during the authorisation request. | Yes | `openid profile offline_access` | Run |
| `IDENTITY_SESSION_SECRET` | Key material used to sign the session cookie issued to the browser. | Yes | `REPLACE_ME` | Run |
| `IDENTITY_SESSION_TTL_SECONDS` | Lifetime of an issued session before it must be renewed. | No | `28800` | Run |
| `IDENTITY_TENANT_ID` | Identifier of the tenant this deployment serves. Requests carrying a different tenant are rejected. | Conditional: required in multi-tenant deployments | `tenant-example-a` | Run |
| `IDENTITY_JWKS_URL` | Address the resource server fetches signing keys from to validate a token. | Conditional: required when tokens are validated by a key set rather than by introspection | `https://identity.example.invalid/.well-known/jwks.json` | Run |
| `IDENTITY_KEY_ID` | Identifier of the private key this deployment signs with, used to select the right entry from a rotating key set. | Conditional: required when rotation is enabled | `key-2026-04` | Run |

## Messaging service

The messaging service carries work items between agents and between agents and the API.

| Setting | What it does | Required | Example | Present at |
| --- | --- | --- | --- | --- |
| `MESSAGING_BROKER_URL` | Address of the broker that holds the queues. | Yes | `messaging://broker.example.invalid:5672` | Run |
| `MESSAGING_QUEUE_NAME` | Name of the queue that carries work items. | Yes | `agent-work` | Run |
| `MESSAGING_DEAD_LETTER_QUEUE_NAME` | Queue that receives items that exhausted their retry budget. | Yes | `agent-work-dead` | Run |
| `MESSAGING_CONSUMER_GROUP` | Group name that identifies the consumers sharing a queue. | Yes | `delivery-workers` | Run |
| `MESSAGING_ACK_TIMEOUT_SECONDS` | Time the broker waits for a successful acknowledgement before making an item visible again. | No | `300` | Run |
| `MESSAGING_MAX_RETRIES` | Number of delivery attempts before an item is sent to the dead letter queue. | No | `5` | Run |
| `MESSAGING_PREFETCH_COUNT` | Number of items delivered to a consumer at once. Raising it raises throughput and memory use together. | No | `10` | Run |
| `MESSAGING_PAYLOAD_MAX_BYTES` | Largest accepted message body. Oversized items are rejected at the producer. | No | `262144` | Run |

## Web front end

The front end is a server-rendered application. Settings split into those the browser may see and those only the server may see.

| Setting | What it does | Required | Example | Present at |
| --- | --- | --- | --- | --- |
| `NEXT_PUBLIC_APP_NAME` | Product name shown in the page title, the navigation bar and the sign-in screen. | No | `Delivery Console` | Build |
| `NEXT_PUBLIC_APP_ENVIRONMENT` | Environment label shown in the interface and sent with every request. | Yes | `local` | Build |
| `NEXT_PUBLIC_API_BASE_URL` | Address the browser uses to reach the API. | Yes | `https://api.example.invalid` | Build |
| `NEXT_PUBLIC_IDENTITY_ISSUER_URL` | Identity service address the browser redirects to for sign-in. | Yes | `https://identity.example.invalid` | Build |
| `NEXT_PUBLIC_IDENTITY_CLIENT_ID` | Client identifier the browser presents to the identity service. | No | `delivery-web` | Build |
| `NEXT_PUBLIC_TENANT_SLUG` | Tenant shown in the interface and used to scope browser-side queries. | Conditional: required in multi-tenant deployments | `example-a` | Build |
| `NEXT_PUBLIC_RELEASE_CHANNEL` | Channel label shown in the interface, for example `stable` or `preview`. | No | `stable` | Build |
| `API_BASE_URL` | Address the server uses to reach the API. Usually a private address inside the network. | Yes | `https://api.internal.example.invalid` | Run |
| `API_TIMEOUT_MS` | Time the server waits for an API response before failing the request. | No | `15000` | Run |
| `SESSION_COOKIE_SECRET` | Key material used to sign the application session cookie. | Yes | `REPLACE_ME` | Run |
| `CSRF_SECRET` | Key material used to bind form submissions to the session that produced them. | Yes | `REPLACE_ME` | Run |
| `SESSION_COOKIE_SECURE` | Whether the session cookie is only sent over an encrypted connection. Must be `true` in every deployed environment. | Yes | `true` | Run |
| `LOG_LEVEL` | Lowest severity written to the log stream. | No | `info` | Run |

## Database

| Setting | What it does | Required | Example | Present at |
| --- | --- | --- | --- | --- |
| `DATABASE_URL` | Address of the primary relational database. Credentials are supplied separately. | Yes | `db://database.example.invalid:5432/appdb` | Run |
| `DATABASE_USER` | Role the application connects as. | Yes | `app` | Run |
| `DATABASE_PASSWORD` | Password of the application role. | Yes | `REPLACE_ME` | Run |
| `DATABASE_POOL_MAX` | Largest number of connections the process holds open. | No | `20` | Run |
| `DATABASE_POOL_MIN` | Number of connections kept open while idle. | No | `2` | Run |
| `DATABASE_SSL_MODE` | Whether and how the connection to the database is encrypted. | Conditional: required for any database reached across a network boundary | `require` | Run |
| `DATABASE_STATEMENT_TIMEOUT_MS` | Time the database waits before cancelling a query. | No | `15000` | Run |
| `DATABASE_MIGRATION_URL` | Address of the primary database, used only by the migration step. | Yes | `db://database.example.invalid:5432/appdb` | Run |
| `DATABASE_MIGRATION_USER` | Role used by the migration step. It has rights to change the schema. | Yes | `migrator` | Run |
| `DATABASE_MIGRATION_PASSWORD` | Password of the migration role. | Yes | `REPLACE_ME` | Run |
| `DATABASE_READ_REPLICA_URL` | Address of a read-only replica, when reads are split from writes. | No | `db://replica.example.invalid:5432/appdb` | Run |

The migration credentials are deliberately separate from the application credentials so that the deployment can grant the application role only read and write rights on its own tables. A pipeline stage that applies migrations is the only thing that reads `DATABASE_MIGRATION_USER` and `DATABASE_MIGRATION_PASSWORD`.

## Cache and queue

| Setting | What it does | Required | Example | Present at |
| --- | --- | --- | --- | --- |
| `CACHE_URL` | Address of the cache server. | Yes | `cache://cache.example.invalid:6379` | Run |
| `CACHE_DEFAULT_TTL_SECONDS` | Lifetime applied when a caller does not set one. | No | `300` | Run |
| `CACHE_PREFIX` | String prepended to every key, which keeps two environments on one server apart. | No | `delivery:example-a:` | Run |
| `QUEUE_URL` | Address of the queue server used for background jobs that are not agent work items. | No | `queue://queue.example.invalid:6379` | Run |
| `QUEUE_VISIBILITY_TIMEOUT_SECONDS` | Time a job stays hidden from other workers after it is picked up. | No | `120` | Run |
| `QUEUE_DEAD_LETTER_URL` | Address of the queue that receives jobs that failed repeatedly. | No | `queue://queue-dead.example.invalid:6379` | Run |

## Object storage

| Setting | What it does | Required | Example | Present at |
| --- | --- | --- | --- | --- |
| `OBJECT_STORE_ENDPOINT` | Address of the object storage endpoint. | Yes | `https://objects.example.invalid` | Run |
| `OBJECT_STORE_REGION` | Region the bucket lives in. | Yes | `example-region-1` | Run |
| `OBJECT_STORE_BUCKET` | Bucket that holds uploads, artefacts and build output. | Yes | `delivery-artifacts-example-a` | Run |
| `OBJECT_STORE_ACCESS_KEY_ID` | Identifier of the credential permitted to reach the bucket. | Yes | `example-access-key-id` | Run |
| `OBJECT_STORE_SECRET_ACCESS_KEY` | Secret half of the credential permitted to reach the bucket. | Yes | `REPLACE_ME` | Run |
| `OBJECT_STORE_PATH_STYLE` | Whether addresses are written in path form rather than subdomain form. | Conditional: required when the endpoint does not support subdomain addressing | `true` | Run |
| `OBJECT_STORE_PRESIGN_EXPIRY_SECONDS` | Lifetime of a generated download link. | No | `900` | Run |
| `ARTIFACT_BUCKET` | Bucket that holds release artefacts between build and deployment. | Conditional: required when releases are staged in storage | `delivery-releases-example-a` | Run |

## Email and short-message providers

| Setting | What it does | Required | Example | Present at |
| --- | --- | --- | --- | --- |
| `EMAIL_PROVIDER` | Name of the outbound email adapter to use. | Yes | `https://email.example.invalid` | Run |
| `EMAIL_API_KEY` | Credential that authorises sending email. | Yes | `sk-placeholder-value` | Run |
| `EMAIL_FROM_ADDRESS` | Address that appears in the `From` header. | Yes | `no-reply@example.invalid` | Run |
| `EMAIL_REPLY_TO_ADDRESS` | Address that receives replies. | No | `support@example.invalid` | Run |
| `EMAIL_MAX_RETRIES` | Number of send attempts before a message is given up on. | No | `3` | Run |
| `SMS_PROVIDER` | Name of the outbound short-message adapter to use. | Conditional: required when the product sends short messages | `https://sms.example.invalid` | Run |
| `SMS_API_KEY` | Credential that authorises sending short messages. | Conditional: required when the product sends short messages | `sk-placeholder-value` | Run |
| `SMS_SENDER_ID` | Identifier the receiver sees as the sender. | No | `Delivery` | Run |

## CI and release

| Setting | What it does | Required | Example | Present at |
| --- | --- | --- | --- | --- |
| `CI_RUNNER_IMAGE` | Image the pipeline builds in, pinned by digest so the environment does not drift between runs. | Yes | `build-image@example-digest` | Run |
| `CI_RUNTIME_VERSION` | Version of the language runtime the build uses. | Yes | `22` | Run |
| `CI_PACKAGE_REGISTRY_URL` | Address the package registry is read from and published to. | Yes | `https://packages.example.invalid` | Run |
| `CI_REGISTRY_TOKEN` | Credential used to publish packages. | Conditional: required only for the publishing step | `REPLACE_ME` | Run |
| `CI_CACHE_KEY_PREFIX` | Prefix for cached dependency directories, used to key the cache by lock file hash. | No | `delivery-cache` | Run |
| `CI_TEST_COMMAND` | Command that runs the full test suite. | Yes | `<pkg> run test:all` | Run |
| `CI_COVERAGE_THRESHOLD` | Minimum coverage percentage the build refuses to go below. | No | `80` | Run |
| `CI_ARTIFACT_BUCKET` | Bucket that receives build output for the deployment stages to read. | Yes | `delivery-artifacts-example-a` | Run |
| `RELEASE_SIGNING_KEY_REF` | Reference to the key used to sign release artefacts. The reference is stored in the secret store; the key material is not in the repository or the environment file. | Yes | `signing-key/example-a/release` | Run |
| `DEPLOY_TARGET_URL` | Address the deployment stage talks to. | Yes | `https://deploy.example.invalid` | Run |
| `DEPLOY_APPROVAL_REQUIRED` | Whether the production stage refuses to run without a recorded one-time approval. | Yes | `true` | Run |
| `DEPLOY_HEALTHCHECK_PATH` | Path used to confirm a deployed instance is serving traffic. | Yes | `/health/ready` | Run |
| `DEPLOY_SMOKE_TEST_COMMAND` | Command that runs the post-release smoke test against the live address. | Yes | `<pkg> run smoke -- --target $DEPLOY_TARGET_URL` | Run |

## The naming convention for secrets

Naming is the only documentation a secret ever gets, so the convention is enforced.

1. Names use `UPPER_SNAKE_CASE` and are prefixed with the component that consumes them: `IDENTITY_`, `MESSAGING_`, `DATABASE_`, `CACHE_`, `QUEUE_`, `OBJECT_STORE_`, `EMAIL_`, `SMS_`, `CI_`, `DEPLOY_`, `RELEASE_`.
2. The suffix says what the value is, not where it lives. `_ID` for an identifier, `_URL` for an address, `_SECRET` for shared secret material, `_KEY` for key material, `_TOKEN` for a credential, `_TTL_SECONDS` and `_TIMEOUT_MS` for durations, `_COUNT` for numbers.
3. A name never changes to rotate a value. Rotate the value behind the name. A renamed setting silently reads as unset and takes the application down.
4. A secret is named after the thing it unlocks, not after the team that stores it. `OBJECT_STORE_SECRET_ACCESS_KEY` stays `OBJECT_STORE_SECRET_ACCESS_KEY` when it moves to a different secret store.
5. An unset mandatory secret is written as `REPLACE_ME`. The application refuses to start on `REPLACE_ME` rather than failing later with a confusing error.
6. A value that appears in more than one setting is a smell. Give each consumer its own credential so one can be revoked without disturbing the others.
7. A name starting with `NEXT_PUBLIC_` must never be a secret. The CI scans the built bundle for any string that also appears in the secret store and fails the build on a match.

## Where each kind of value belongs

| Kind of value | Where it lives | Example | Never |
| --- | --- | --- | --- |
| Secret needed only by the pipeline | CI secret store, exposed to the pipeline as an environment variable for the duration of one job | `CI_REGISTRY_TOKEN` | In the repository, in the build output, in a log line |
| Secret needed by a running service | Orchestrator secret, mounted into the workload as an environment variable | `IDENTITY_CLIENT_SECRET` | In the repository, in an image layer, in the pipeline log |
| Local development value | Environment file in the working directory, listed in `.gitignore` and committed as `.env.example` with placeholders | `DATABASE_URL` pointing at the scratch database | Committed to the repository |
| Non-secret configuration | Repository configuration file, versioned with the code | `DEPLOY_HEALTHCHECK_PATH`, `MESSAGING_MAX_RETRIES` | Duplicated in an environment file where it can drift |
| Public build value | Repository configuration, prefixed `NEXT_PUBLIC_` when the browser needs it | `NEXT_PUBLIC_API_BASE_URL` | Behind `NEXT_PUBLIC_` if it holds a secret |

## Keeping configuration honest

Three checks keep the catalogue above and the running system in agreement.

| Check | When it runs | What it fails on |
| --- | --- | --- |
| Catalogue drift check | On every pull request | A setting that the code reads but this document does not list, or a listed setting that no code reads |
| Secret scan of the bundle | During the build | A `NEXT_PUBLIC_` value that also appears in the secret store |
| Startup validation | When a service starts | A mandatory setting that is missing, still `REPLACE_ME`, or a placeholder value |

The drift check is what keeps this document from becoming fiction. It reads the settings the code looks up, compares the set against this file, and fails the build when the two differ.
