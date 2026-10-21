# Delivery blockers

A blocker is a failure that stops work from being delivered. Some are obvious: a build is broken. Most are not. The interesting blockers are the ones where every part of the system reports itself as healthy and the result is still wrong.

Every pattern below has been resolved. Each is written as the symptom that was observed, the cause that was found, the resolution that was applied, and the guard that now stops it coming back.

## How to use this document

When something blocks a delivery, find the symptom in the list below and compare. If the symptom matches, look at the cause: the resolution and the guard usually apply unchanged. If it does not match, the blocker is new, and it should be written up here in the same form before it is closed.

The summary table maps a symptom to the pattern that explains it.

| Symptom | Pattern |
| --- | --- |
| Files that existed before are gone after a merge, with no conflict | [1. A merge that drops files only the base had](#1-a-merge-that-drops-files-only-the-base-had) |
| Two branches both deploy to the same environment | [2. Two branches that both claim to be the ship line](#2-two-branches-that-both-claim-to-be-the-ship-line) |
| A merged change never reaches production | [3. A release workflow missing from one branch](#3-a-release-workflow-missing-from-one-of-two-branches) |
| A job sits queued and never starts | [4. A workflow that names a runner that no longer exists](#4-a-workflow-that-names-a-runner-that-no-longer-exists) |
| The schema runner reports a duplicate version | [5. A migration number used twice](#5-a-migration-number-used-twice-in-two-branches) |
| Signatures verify for some requests and not others | [6. A public key and a secret key from different tenants](#6-a-public-key-and-a-secret-key-that-belong-to-two-different-tenants) |
| The readiness check is red but the application works | [7. A readiness probe red only because a provider was never configured](#7-a-readiness-probe-red-only-because-the-provider-was-never-configured) |
| The application reads none of its own rows | [8. A role that cannot read its own rows](#8-a-database-role-that-cannot-read-its-own-rows) |
| The user is signed in but every request is unauthenticated | [9. A session token that carries none of the claims the other side checks](#9-a-session-token-that-carries-none-of-the-claims-the-other-side-checks) |
| Installing a dependency rewrites unrelated files | [10. A publish command that rewrites the tree](#10-a-publish-command-that-regenerates-the-lock-file-and-rewrites-the-tree) |

---

## 1. A merge that drops files only the base had

**Symptom.** A change merged cleanly, every test passed, and afterwards some files that had existed on the base branch were gone. No conflict was shown at any point. The missing files were ones the change itself never touched, and they were mostly files that the base had gained since the branch was created.

**Cause.** The branch had been created from an old snapshot of the base, and the merge was performed with a strategy that took the incoming side as the whole result rather than combining the two trees. The files that existed only on the base were not conflicts, so nothing was reported, and they were not carried over either. A squash-merge onto a branch that had drifted the same way produced the same outcome.

**How it was found.** The tree of the base branch was compared before and after the merge, and the difference showed deletions that appeared in no commit. Searching the history for the deletion pointed at the merge commit itself rather than at any change in the branch. The change under review had been working on its own branch, so the loss only became visible on the base.

**Fix.** The dropped files were restored from the base, and the branch was re-merged with a strategy that combines both trees, so the files present only on the base survived the merge. The root cause of the drift was addressed separately: branches are now cut from the current base, and the pipeline refuses a branch whose base is more than a short distance behind.

**Guard.** The pipeline compares the file list of the merge result against the file list of the base. A file present in the base and absent from the merge result fails the build unless the change contains an explicit, reviewed deletion marker for that file. The merge owner also checks the ownership map before merging, because a path that was never claimed by the change is exactly the path at risk.

**Lesson.** A merge that reports no conflict has not necessarily kept everything. Compare the trees, not the conflict count.

## 2. Two branches that both claim to be the ship line

**Symptom.** Two branches both deployed to the same environment, minutes apart, and the running version was not the one the team expected. Different people were working from different branches, both of which were described as the current line of work.

**Cause.** A long-lived release branch and a trunk branch were both configured as the ship line for the same environment. A branch created from the release branch was also matched by the deployment selector, so three branches matched a rule that was meant to match one.

**How it was found.** The deployment record showed two different commit identifiers for the same environment within the same hour. The release note for one of them described changes that were not in the other. The selector pattern that matched the branches was compared against the list of branches and found to match more than one.

**Fix.** The two lines were converged: the changes unique to the release branch were merged into the trunk branch, the release branch was retired, and its name was removed from the deployment selector. The deployment configuration now names exactly one ship line per environment.

**Guard.** The pipeline fails when more than one branch matches the ship-line selector for an environment. The board records which branch is canonical, and the selector is checked against that record. A branch that is created from a non-canonical branch is labelled as such at creation.

**Lesson.** A deployment selector that matches by pattern will eventually match more than one branch. Name the ship line, and check the count.

## 3. A release workflow missing from one of two branches

**Symptom.** A change was merged, reviewed and green, but the artefact that reached production was older than the merged commit. Nothing failed. The release simply did not happen.

**Cause.** The release workflow lived in one branch only. The deployment ran the workflow from the branch being deployed, so when the other branch was deployed, the release job did not exist. The pipeline treated a missing job as a job with nothing to do, so the release was silently skipped rather than failing.

**How it was found.** The artefact identifier produced by the build was compared against the artefact identifier recorded in the deployment record. They differed by a release. Inspecting the branches showed the workflow file present in one and absent from the other.

**Fix.** The release definition was moved out of the branches and into a single shared definition that every deployable branch references, so a branch cannot be missing it. The deployment was then re-run and the correct artefact was produced.

**Guard.** The deployment stage fails closed. If the referenced workflow or release definition is absent, the deployment stops with an error rather than completing with nothing done. A check lists the branches that can be deployed and fails if any of them references a release definition that does not exist.

**Lesson.** A stage that is missing is not a stage that succeeded. Missing-workflow cases must fail, not pass quietly.

## 4. A workflow that names a runner that no longer exists

**Symptom.** The release job stayed in a queued state for many minutes and never started. No error was raised. The pipeline summary showed a job waiting for a runner that never appeared.

**Cause.** The job asked for a build machine by a label that referred to a group of machines that had been renamed when the build fleet was reorganised. The label matched nothing.

**How it was found.** The queued job's label was listed and compared against the labels actually registered on the build fleet. The label was absent. The same label had been in use since the fleet was reorganised, and no job had needed that particular label since, so nothing had failed until the next release needed it.

**Fix.** The job now asks for a group label that is registered, rather than for a named machine. The release ran immediately.

**Guard.** A pre-flight check in the pipeline lists the labels currently registered on the build fleet and fails the run when the workflow references a label that is not among them. Separately, an alarm reports any job that has been queued longer than a few minutes, so a missing label is caught even when no release depends on it.

**Lesson.** A label that nothing uses is a label nobody checks. Reference groups, and check the reference list automatically.

## 5. A migration number used twice in two branches

**Symptom.** The schema runner refused to apply the migrations, reporting that two files claimed the same version. On a machine where the branches were applied separately, each applied cleanly and the resulting schema was missing one of the two changes.

**Cause.** Two branches were cut from the same base and each took the next number in the sequence. Neither branch knew about the other, and the sequence was only meaningful within a branch.

**How it was found.** The runner's duplicate-version error named the two files. Reading them showed two unrelated changes to the same table, one in each branch, each numbered as the next in the sequence.

**Fix.** The later of the two was renumbered to the next free number, and the ordering between the two was checked to confirm they were independent. Where two migrations touch the same structure, they were combined into one migration instead of being renumbered, because renumbering two migrations that interfere only hides the interference until the next run.

**Guard.** The runner refuses to apply two files with the same version and says which files they are. A pre-merge check scans both sides of a merge for the same version and fails the merge. Version numbers are also checked against the applied set on the target database, so a branch that would re-apply an old version is rejected.

**Lesson.** A number that is only unique within a branch is not unique. Give migrations an identifier that cannot collide, or check for the collision before the merge.

## 6. A public key and a secret key that belong to two different tenants

**Symptom.** Requests failed with a signature verification error, but only for some requests and some users. A retry of the same request succeeded, and the failure rate moved around in a way that had nothing to do with the change being deployed.

**Cause.** The configuration held a public key belonging to one tenant and a secret key belonging to another. Both had been set correctly on their own, and both were valid keys, so nothing detected the mismatch at startup. Only the pairing was wrong.

**How it was found.** The failing token was decoded and the identifier of the key that signed it was compared with the identifiers of the configured keys. The token was signed with the key from the second tenant, while verification was using the public key from the first. The two keys belonged to different tenants and were never a pair.

**Fix.** The configuration was corrected to use a matched pair. The key pair is now stored as a single entry in the secret store so that the two halves cannot be fetched independently, and the deployment tooling refuses to write one half without the other.

**Guard.** The service derives the public key from the configured secret key at startup and compares it with the configured public key. If they do not match, the service refuses to start with a message that names the mismatch. A key-pair check also runs in the deployment pipeline before the rollout, so the failure happens before traffic moves.

**Lesson.** Two values that are each individually valid can be invalid together. Check the relationship, not just the values.

## 7. A readiness probe red only because the provider was never configured

**Symptom.** The readiness check stayed red in one environment while the application served traffic perfectly. Deployments to that environment failed their health gate even though nothing was wrong with the running service.

**Cause.** The readiness check asked every dependency whether it was reachable. One outbound provider had no credentials in that environment, because the environment was not expected to send that kind of message. The check treated "no credentials configured" as "not ready", so the instance was never reported as ready.

**How it was found.** The readiness response body named the dependency that was not ready. The service log for that dependency showed no connection attempt at all, which pointed at configuration rather than connectivity. The deployment was then run with that provider configured, and readiness turned green, which confirmed the diagnosis.

**Fix.** The two states were separated. A dependency that is not configured is reported as `not_configured` and does not block readiness, because readiness answers one question: can this instance serve the traffic it is given? A dependency that is required is checked at startup instead, so an instance that cannot work without it never starts. The health gate was changed to check the readiness state and the reported version.

**Guard.** Startup validation distinguishes required settings from optional ones and refuses to start when a required setting is missing. The readiness check only asserts on dependencies that are configured. The deployment smoke test confirms the running version matches the artefact, so a build that was missing a public setting is still caught.

**Lesson.** Readiness must mean "can serve traffic", not "is configured completely". A required dependency belongs in startup validation, not in the health gate.

## 8. A database role that cannot read its own rows

**Symptom.** The application role returned no rows from a table it owned. There was no error, only empty results. A query that filtered explicitly by the tenant the application serves returned nothing, and the same query run with an administrative role returned the expected rows.

**Cause.** Row-level policies had been applied to the table, and they were enforced for every role. The policy set restricted rows to a tenant, but it contained no permissive policy allowing the application role to see the rows that belonged to it. The policies defined who was excluded and never defined who was included, so the application role fell outside every policy.

**How it was found.** Running the identical query under the administrative role returned rows, and under the application role returned none. The policy catalogue was read, and the application role was absent from every policy expression. The change that introduced the policies had been tested with a role that the application does not use.

**Fix.** A permissive policy was added that allows the application role to read and write rows whose tenant identifier matches its own, while the existing restrictive policy continues to exclude rows belonging to other tenants. The result is that the application role sees exactly its own rows and no others.

**Guard.** The migration test creates the roles, applies the policies, and asserts three things: the application role reads its own rows, the application role reads none of another role's rows, and the administrative role still reads everything. A check refuses a policy set that contains only restrictive policies for a table an application role must use. Roles used only in tests are not allowed, so the gap cannot reappear in a role nobody exercises.

**Lesson.** Policies that only say "no" leave every role out. A role that matches no policy sees no rows, silently.

## 9. A session token that carries none of the claims the other side checks

**Symptom.** The browser showed a signed-in session, but every request to the API was treated as unauthenticated. The sign-in flow completed without error and the application behaved as though nobody were signed in.

**Cause.** The token issued by the identity service carried its claims under one set of names, and the resource server read a different set. The token was valid and correctly signed, so the resource server accepted it and then found no subject in it. The two sides used different names for the same thing, and the mismatch was invisible because both sets of names were internally consistent.

**How it was found.** The token from a failing request was decoded and its claims listed. The list was compared with the claims the resource server reads. The names did not match, and one of the required claims was simply absent from the token.

**Fix.** The claim names were aligned, and both sides now read the required claim list from one shared definition rather than each writing its own list. The resource server was changed to reject a token that lacks a required claim with an explicit error, instead of silently treating it as an anonymous request.

**Guard.** A contract test runs between the identity service and the resource server. It obtains a real token, decodes it, and asserts that every required claim is present, correctly named and correctly typed. The test runs in the contract layer on every change, and the shared claim definition means the two sides cannot drift again.

**Lesson.** A token can be valid and still carry nothing the other side looks for. Test the claims, not the signature.

## 10. A publish command that regenerates the lock file and rewrites the tree

**Symptom.** Running the publish command locally modified files that had nothing to do with the package being published: a manifest version, a formatting change across several source files, a configuration file. The diff was large and none of it was authored. Contributors started avoiding the publish command, which meant releases were made by whoever was comfortable with it.

**Cause.** The publish command did two things: it regenerated the lock file from the current registry state, and it normalised the whole working tree before packaging. Because it operated on the working tree, both actions wrote into the repository. The lock file it produced was therefore not the lock file that was committed, and the published package and the repository disagreed about their dependencies.

**How it was found.** A contributor ran the publish command on a clean checkout and found the working tree dirty afterwards. The published package's lock file was compared with the repository's lock file and they differed, which meant the release was not reproducible from the commit.

**Fix.** The publish command now runs in a clean export of the tagged commit, in a scratch directory, so it cannot write into anybody's working tree. The lock file is regenerated inside the scratch copy, and it is copied back into the repository as a separate, explicit step that is reviewed on its own.

**Guard.** The publish job checks out the tagged commit into a fresh directory and asserts that the tracked files are unchanged after the build step. If the build step modified anything, the publish fails. The pipeline also compares the published package's lock file with the repository's and fails when they differ.

**Lesson.** A command that writes to the tree must not be allowed to run where the tree matters. Build in a copy, and let the difference be an explicit, reviewable change.

---

## Turning a new blocker into a pattern

When a new blocker is resolved, write it up in the same form as the ones above. The form is what makes the list usable: the symptom is matched by somebody who is stuck, the cause is matched by somebody who is fixing it, and the guard is what makes it cheap to confirm that it worked.

| Part | The question it answers |
| --- | --- |
| Symptom | Does my problem look like this one? |
| Cause | Why did it happen? |
| How it was found | How do I confirm the cause without guessing? |
| Fix | What do I change to resolve it? |
| Guard | What stops it coming back? |
| Lesson | What do I carry to the next occurrence? |

A blocker without a guard is a blocker that will return, usually after something unrelated changed and nobody was looking.
