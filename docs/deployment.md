# Release and deployment runbook

This is the runbook for taking a change from a branch to production. It covers the stages, the approval that production requires, the order in which platforms are deployed, the tagging convention, the rollback plan, the smoke test that follows a release, and the machine rules that keep production separate from the build.

Replace the placeholders in the commands with the values from your own environment. The names below are generic on purpose: `DEPLOY_TARGET_URL`, `DEPLOY_APPROVAL_TICKET` and `ARTIFACT_BUCKET` are the setting names used in the [configuration reference](configuration.md).

In the commands, `<pkg>` is the package manager the repository declares and `<vcs>` is the version control client. Both are defined in full in [Local environment](local-environment.md).

## The three stages

| Stage | Where it runs | Who starts it | What it proves |
| --- | --- | --- | --- |
| Preparation | A build machine | Anyone with write access to the branch | The change builds, passes every test layer and produces a signed, numbered artefact |
| Staging | A staging platform that mirrors production | The release owner | The change works against real infrastructure with production-shaped configuration |
| Production | A production platform | The release owner, after an explicit one-time approval | The change works for users |

A stage may only begin when the previous stage has finished successfully. There is no path from preparation straight to production, even for a one-line change, even for a change that has been through staging a hundred times.

## Roles

| Role | Responsibility |
| --- | --- |
| Release owner | Decides that a change is ready, starts the preparation and staging stages, records what was released |
| Approver | Grants the one-time approval that production requires. Must not be the release owner. |
| On-call engineer | Watches the release, runs the smoke test, decides whether to roll back |

A person may hold more than one role on a small team, except the approver role. The release owner and the approver must be different people. An approval that the release owner grants themselves is not an approval; it is a button they pressed.

## Preconditions

Nothing starts until all of these are true.

| Precondition | How it is checked |
| --- | --- |
| The branch is based on the current release branch | The pipeline compares the merge base with the release branch head |
| Every test layer is green | The pipeline result, not a message in a channel |
| The change is reviewed | The pull request shows an approving review from someone other than the author |
| The migration set is backwards compatible | A human read, and the pipeline ran the schema against the previous release of the code |
| The configuration for the target environment is complete | The startup validation passes against the staging configuration |
| The rollback plan is written down | A note in the release record naming the previous artefact and the revert procedure |

## Stage 1: preparation

Preparation runs on a build machine. It never runs on a machine that serves production.

```bash
<pkg> run ci:verify          # every test layer, in the order the pipeline runs them
<pkg> run ci:build           # produces the artefact
<pkg> run release:sign -- --artifact <artifact-path>
<pkg> run release:publish -- --bucket "$ARTIFACT_BUCKET"
```

**Expected result.** A signed artefact with an immutable identifier, published to the artefact bucket and recorded in the release record together with the commit it was built from.

**Rollback.** Nothing has been deployed. If preparation fails, the artefact is deleted and the branch goes back to the author. There is nothing to roll back in production.

### Rules for the build machine

- The build machine builds and publishes artefacts. It never deploys to production.
- The build machine holds read-only credentials: it can read the source, download dependencies and write to the artefact bucket. It cannot read production configuration and cannot write to production.
- The build is reproducible from the commit and the pinned toolchain image. If the artefact cannot be rebuilt from the same inputs, the artefact is not trustworthy.
- The artefact identifier is derived from the commit, never from the wall clock or the machine name. Two builds of the same commit produce the same identifier.

## Stage 2: staging

```bash
<pkg> run release:deploy -- --target "$DEPLOY_TARGET_URL" --artifact <artifact-identifier>
<pkg> run release:smoke -- --target "$DEPLOY_TARGET_URL"
```

**Expected result.** The new version is serving on staging, the smoke test passes, and the release record shows the new artefact with the time of the deployment.

**Rollback.** Redeploy the previous artefact:

```bash
<pkg> run release:deploy -- --target "$DEPLOY_TARGET_URL" --artifact <previous-artefact-identifier>
```

The rollback is rehearsed, not improvised. Before the first production release of a new format, the previous artefact is redeployed to staging once to prove that the rollback path works.

**The staging window.** Staging stays on the new version for an agreed observation period before production is approved. The period is longer when the change touches data, permissions or money. If anything looks wrong during the window, the release stops here.

## Stage 3: production

Production requires an explicit, one-time approval.

### The approval rule

> Production does not deploy without a recorded approval that has never been used before, granted by a person who is not the release owner, inside an expiry window.

| Property | Requirement |
| --- | --- |
| Explicit | The approver takes a deliberate action. Silence, a message saying "looks fine to me" and a default configuration do not count. |
| One-time | The approval is consumed by the deployment that used it. It cannot be replayed. |
| Personal | The approver is a named person and is not the release owner. |
| Time-limited | The approval expires. An approval given yesterday for today's window does not work today. |
| Recorded | The approval, the approver, the artefact and the time are written to the release record and cannot be edited afterwards. |

If the deployment fails and must be retried, that retry needs a fresh approval. A failed production deployment does not leave a reusable approval behind, because the state after the failed attempt is not the state the approval was given for.

```bash
<pkg> run release:deploy \
  --target "$DEPLOY_TARGET_URL" \
  --artifact <artefact-identifier> \
  --approval-ticket "$DEPLOY_APPROVAL_TICKET"
```

**Expected result.** The new version serves production traffic, the smoke test passes, and the release record shows the new artefact.

**Rollback.** See the rollback plan below. Rolling back is always available and never needs a second approval.

### The order of platforms

When one release reaches several platforms, they are deployed one at a time, in a fixed order, and each one is observed before the next begins.

The order is:

1. **Shared components first.** The schema change, the shared packages and the infrastructure change go before the applications that use them. A schema change that is backwards compatible is applied before any code that depends on it.
2. **The internal platform first.** The platform used by staff is deployed and observed before any customer-facing platform.
3. **The smallest audience first.** The platform with the least traffic is the canary. It absorbs the first failure of a bad release while the blast radius is smallest.
4. **One at a time.** Two platforms never deploy in the same window. A failure must be attributable to one platform.
5. **The observation window before the next platform.** Each platform runs for the agreed window with its smoke test green before the next one starts.
6. **A failure stops the sequence.** A platform that fails is returned to its last known good version, and the remaining platforms are not touched until the cause is understood.

| Order | Platform | Why it is here |
| --- | --- | --- |
| 1 | Internal platform | Failure is visible to the team before any user sees it |
| 2 | Platform with the smallest audience | Smallest blast radius for a bad release |
| 3 | Platform with a medium audience | Confirms the release under real load |
| 4 | Platform with the largest audience | Last, because it is the most expensive to fix if it goes wrong |

## Tagging convention

Every release is tagged on the commit that was built.

```text
vMAJOR.MINOR.PATCH
```

| Part | Changes when | Example |
| --- | --- | --- |
| `MAJOR` | A change breaks a published interface or a stored format | `v2.0.0` |
| `MINOR` | A change adds something in a backwards-compatible way | `v2.4.0` |
| `PATCH` | A change fixes something without changing behaviour for others | `v2.4.1` |

Rules for tags:

- The tag carries the `v` prefix. `v2.4.0` is a release tag; `2.4.0` is not.
- The tag is annotated, not lightweight, and its message names the release and the artefact identifier.
- The tag is placed on the commit that produced the artefact, not on a later commit. A tag on a commit that was never built produces an artefact nobody can reproduce.
- A rebuild of the same commit keeps the same tag and adds a build suffix, for example `v2.4.0+build.7`. The suffix never changes the version number and never appears in the version the application reports.
- A release that has to be withdrawn keeps its tag. The tag is not moved and not deleted. The release record says the tag was withdrawn and why.

```bash
<vcs> tag -a "v2.4.0" -m "Release 2.4.0, artefact build-2026-04-12-a1"
<vcs> push origin "v2.4.0"
```

## The rollback plan

Three shapes of rollback exist, and each one has a different trigger.

| Shape | What moves | When it is used | Time to recover |
| --- | --- | --- | --- |
| Roll back the artefact | The platform runs the previous artefact again | The new version is broken in a way a code change fixes | Minutes |
| Roll forward | The broken version is left running and a fix is deployed | The fault is in the data or the configuration and a previous artefact would hit the same fault | Minutes to hours |
| Roll back the data | The schema or the data is restored | The new version corrupted data or applied an irreversible change | Hours, and it means the release was not backwards compatible |

Rules:

- Rolling back the artefact never requires a second approval. The ability to undo a production change is not gated behind a meeting.
- A schema change must be backwards compatible with the previous release for one full release cycle. The previous artefact must be able to run against the new schema. This is what makes the fast rollback possible.
- A destructive schema change is split into two releases: first the code that stops using the old shape, then the change that removes it.
- Data migrations are reversible, or they are staged so that the reverse can be computed. A migration that cannot be reversed is only allowed behind an explicit flag that is off by default.
- The rollback target is recorded before the release starts, not looked up afterwards. The release record names the previous artefact identifier and the revert command.

```bash
<pkg> run release:rollback -- --target "$DEPLOY_TARGET_URL" --to <previous-artefact-identifier>
```

## The smoke test after the release

The smoke test runs against the live address after the deployment finishes, from outside the platform's private network, so it exercises the same path a user takes.

| Check | What it proves | Fails when |
| --- | --- | --- |
| The health endpoint returns success | The process is serving | The process crashed or is unhealthy |
| The readiness endpoint returns success | The dependencies are reachable and the schema matches | A dependency is down or the schema is wrong |
| The front end loads and shows the environment label | The bundle was built with the right public settings | The bundle was built with the wrong settings |
| A signed-in session can be established | The identity service and the session cookie work | The issuer, the redirect address or the cookie secret is wrong |
| A read of one existing record returns it | The database path works end to end | The connection string or the credentials are wrong |
| A write of a new record returns it on a second read | The write path and the read path agree | The write was dropped or the read is served from a stale replica |
| The deployed version string matches the artefact identifier | The right artefact is running | The deployment picked up the wrong artefact |

The smoke test is automated and it runs as part of the deployment. A manual check that somebody remembers to do is not a smoke test.

```bash
<pkg> run release:smoke -- --target "$DEPLOY_TARGET_URL" --expect-version <artefact-identifier>
```

## Machine rules

> A machine that runs production is never used to build anything.

This applies to the machine itself and to any agent that runs on it.

| Rule | Reason |
| --- | --- |
| No build on a production machine | A build runs arbitrary code from the branch. On a production machine, that code runs with access to production data and production credentials. |
| No build tool installed on a production machine | Even an accidental invocation is a problem. The rule is enforced by what is installed, not by good intentions. |
| No production credentials on a build machine | A build reads the repository. If the repository is untrusted, the credentials are too. The build machine holds read-only credentials only. |
| No test suite on a production machine | Tests write data. Production data is not a scratch space. |
| No agent that can write to the repository on a production machine | See [Agent coordination](agent-coordination.md). |

The separation is checked in both directions. The pipeline refuses to deploy from a machine whose identifier is on the production inventory, and the production inventory refuses to accept a machine whose identifier is on the build inventory.

## The step table

| Stage | Action | Expected result | Rollback |
| --- | --- | --- | --- |
| Prepare | Run the full verification job | All four test layers pass, coverage above the floor | Nothing to undo; the branch returns to the author |
| Prepare | Build the artefact | Artefact produced with an identifier derived from the commit | Delete the artefact |
| Prepare | Sign the artefact | Signature verifies against the published key | Delete the artefact and the signature |
| Prepare | Publish the artefact to the bucket | Artefact present and readable by the deploy stage | Remove the object from the bucket |
| Prepare | Tag the release commit | Annotated tag points at the built commit | Delete the tag; the release record notes the withdrawal |
| Stage | Deploy the artefact to staging | New version serving on staging | Redeploy the previous artefact |
| Stage | Run the smoke test on staging | Every check passes | Redeploy the previous artefact, stop the release |
| Stage | Observe for the agreed window | No error-rate, latency or queue-depth regression | Redeploy the previous artefact, stop the release |
| Approve | Request a one-time approval | Approval recorded with approver, artefact and expiry | Withdraw the approval; nothing has been deployed |
| Approve | Approve the release | Approval consumed by exactly one deployment | A new approval is required for a retry |
| Produce | Deploy the artefact to the first platform | New version serving on the first platform | Redeploy the previous artefact |
| Produce | Smoke test the first platform | Every check passes | Redeploy the previous artefact |
| Produce | Observe the first platform | Healthy for the agreed window | Redeploy the previous artefact and stop the sequence |
| Produce | Deploy the remaining platforms one at a time | Each platform passes its smoke test | Stop the sequence; roll back the platform that failed |
| Produce | Record the release | Release record names the artefact, the platforms, the approver and the time | Records are not edited; a correction is appended |
| Verify | Run the smoke test from outside the network | Every check passes | Redeploy the previous artefact |

## If the release goes wrong

Work through this list in order. It is ordered from cheapest and quickest to most disruptive.

1. **Do not make a second change.** A second change while the first is still being diagnosed destroys the evidence and doubles the blast radius.
2. **Decide within the observation window, not after it.** If the smoke test is red, or the error rate rose, the decision to roll back is made now. Investigating happens afterwards.
3. **Roll back the artefact** to the recorded previous artefact. This restores service in minutes and preserves the failing version for investigation.
4. **Freeze the release.** No further platform is touched. The remaining platforms stay on their current version.
5. **Capture the evidence before the environment is changed again.** The logs, the metrics for the window, the exact artefact identifier and the exact time of the deployment. Copy them out of the environment before rolling forward.
6. **Write the record.** What was released, what went wrong, what was rolled back, when, and by whom. Write it while it is fresh.
7. **Reproduce it in staging** before attempting another production deployment. If it cannot be reproduced, the release does not go out again.
8. **If the data is affected**, treat the data as a separate incident. Restore to the last known good backup only after the application has been rolled back, otherwise the restored data is immediately written again by the same faulty code.

### When the rollback itself fails

| Symptom | What to do |
| --- | --- |
| The previous artefact refuses to start | The schema changed in a way that is not backwards compatible. This is a design failure in the release, not an operational one. Restore from backup as a last resort and treat the data path separately. |
| The smoke test fails on the rolled-back version | The fault is in the data or the configuration, not in the artefact. Rolling forward with a fix is the right move. |
| The rollback succeeds but users still see errors | The symptom is downstream. Check the queue for a backlog of items produced by the faulty version and decide whether to drain or discard them. |
| The platform is unreachable entirely | Stop the deployment machinery. Do not start another deployment on top of an unreachable platform. Restore the machine from its image, then re-run the rollback. |

A release that went wrong is not a failure of the person who released it. The point of this runbook is that the procedure absorbs the failure, and the record explains what happened.
