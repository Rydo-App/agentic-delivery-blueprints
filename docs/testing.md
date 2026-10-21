# Test strategy

The suite has four layers. Each layer answers a different question, and each layer is allowed to leave some questions unanswered. This document says what each layer proves, what it cannot prove, and the rules that keep the suite worth running.

## The layers at a glance

| Layer | Runs against | Typical duration | The question it answers |
| --- | --- | --- | --- |
| Unit | Nothing but the code under test, in process | Seconds | Does this function do the right thing for the inputs it will actually receive? |
| Contract | A real dependency at its boundary, reached over the wire | Seconds to a minute | Does this component speak the protocol its counterpart expects? |
| Integration | The real stack: real database, real cache, real queue, real identity service | A minute | Do the components work together correctly on real infrastructure? |
| End to end | The whole product through the real proxy, driving a real browser | Minutes | Does a user, using the product as shipped, get the result they expect? |

A change is not finished when one layer passes. The pipeline runs all four.

In the commands below, `<pkg>` is the package manager the repository declares and `<vcs>` is the version control client. The same placeholders appear in [Local environment](local-environment.md), where they are defined in full.

## Layer 1: unit

A unit test exercises a single unit in the process, with no network, no disk and no clock it does not control.

**What it proves.** That the logic is correct for the inputs you think about. A unit test that covers a decision table is the cheapest possible evidence that the decision is right, and it stays fast enough to run on every keystroke in an editor.

**What it cannot prove.** That the unit is wired into the product correctly. It cannot prove that the database column exists, that the token contains the claim the resource server checks, or that the queue message is shaped the way the consumer expects. A suite of unit tests can all pass while the product is broken end to end.

**Rules.**

- No network access. A unit test that opens a socket is an integration test that has not been admitted yet.
- No reading of the real clock. Pass the current time in, or inject a clock. A test that passes at 03:00 and fails at 15:00 is a defect in the test.
- No randomness without a fixed seed. Inject the seed rather than letting the source of randomness vary per run.
- One behaviour per test. A test that asserts six unrelated things reports the first failure and hides the other five.

Example:

```typescript
describe("lease expiry", () => {
  it("treats a lease that ran out as abandoned", () => {
    const lease = makeLease({ expiresAt: "2026-01-01T00:00:00Z" });
    const now = new Date("2026-01-01T00:00:01Z");

    expect(leaseStatus(lease, now)).toBe("abandoned");
  });
});
```

## Layer 2: contract

A contract test runs the component against a real dependency and checks the shape of the exchange: the request that goes out, the response that comes back, the headers, the error codes, the field names.

**What it proves.** That the two sides of a boundary agree. When an upstream service adds a field, renames a claim or changes an error code, the contract test fails on the side that still expects the old shape, before the change reaches a deployed environment.

**What it cannot prove.** That the behaviour behind the boundary is correct. A contract test can confirm that a response contains a list of task identifiers and that each identifier has a shape; it cannot confirm that the list is the right list.

**Rules.**

- The dependency is real. It is a scratch instance of the real service, started by the test harness, not a hand-written double. The reason is in the next section.
- The check is on the contract, not on the internals. Assert on the published wire shape.
- Contract tests are cheap to run and are run on every change.

Example of the assertion style, written in the runner's own dialect:

```typescript
const { tokenType, expiresIn, accessToken } = await releaseToken({
  code: "example-authorisation-code",
  redirectUri: "https://app.example.invalid/auth/callback",
});

expect(tokenType).toBe("Bearer");
expect(typeof accessToken).toBe("string");
expect(typeof expiresIn).toBe("number");
```

## Layer 3: integration

An integration test runs the real product code against the real infrastructure: the actual database engine with the actual schema and the actual row-level policies, the actual cache, the actual queue, the actual identity service.

**What it proves.** That the pieces work together on real infrastructure. This is the only layer that can prove that a migration is applied, that a constraint behaves, that a query against real row-level policies returns the right rows for the right role, and that a message published to a real queue is consumed by a real consumer.

**What it cannot prove.** That the whole product is usable by a person. Integration tests call the interface directly. They do not exercise routing, cookie handling, redirects, the browser bundle or the reverse proxy.

**Rules.**

- The infrastructure is real and started by the harness. See the next section.
- The schema is real. Tests run against the migrated schema, not a hand-built approximation of it.
- Each test arranges its own data and removes it afterwards, or each test owns a namespace it is free to clear. A test that depends on a row left behind by another test is not a test.

## Layer 4: end to end

An end-to-end test drives a real browser against the deployed product through the real proxy, following the same path a person would follow.

**What it proves.** That the assembled product works. It covers the front-end bundle, the proxy's routing and header handling, the session cookie, the redirect to the identity service and back, and the write path into the database.

**What it cannot prove.** Anything about the parts it does not touch. It says nothing about a background worker, a scheduled job, an email template or a migration that runs later. It is also the slowest and the most fragile layer, so it must cover journeys, not every branch.

**Rules.**

- The target is the real thing. The test starts the stack the same way a developer does locally, or points at a staging deployment.
- Journeys, not selectors. Assert on what the person sees, not on the structure of the markup. A test that breaks when a heading becomes a paragraph has cost more than it has taught.
- One browser, one journey per test. Tests that share a browser state share a failure.

## Rule: do not mock the thing under test

> When the real thing is available, a test may not be written against a mock of it.

A mock of the database is not the database. It has no transactions, no constraints, no indexes, no row-level policies and no migration history. A test that passes against a mock of the database tells you that your code called the methods you expected, in the order you expected. It tells you nothing about whether the statement is valid, whether the policy allows it, or whether the column exists.

The same holds for the identity service, the queue and the object store.

What mocking is good for stays good:

| Mocking is appropriate for | Example |
| --- | --- |
| Outbound calls to a third party the project does not own | A payment provider, in a unit test |
| Slow or expensive dependencies that are not the subject of the test | A notification provider in a unit test for a scheduler |
| Failure injection that cannot be produced otherwise | Making a downstream call time out |
| Replacing the boundary of a unit with a deterministic value | Passing a fixed clock into a lease calculation |

What mocking is not good for:

| Mocking is forbidden for | Reason |
| --- | --- |
| The database | Hides schema, transaction and policy behaviour |
| The identity service | Hides claim and expiry mismatches, which are the failures that matter most |
| The queue | Hides delivery, retry and visibility-timeout behaviour |
| The object store | Hides key, path and permission behaviour |
| The component under test itself | A test that asserts on the mock asserts on nothing |

The practical consequence is that the integration layer exists. If a test cannot be written against the real thing because the real thing is expensive to start, the fix is to make it cheap to start, not to fake it.

## Rule: a skipped test must say why

A skipped test is a decision somebody made. The decision has to be visible at the point the skip happens, not in a ticket that nobody reads. The examples below use the runner's own skip marker.

Good:

```typescript
skip("sends the weekly digest", () => {
  // Skipped because the digest provider has no sandbox account in this
  // environment. Tracked in TEST-482. Remove when the sandbox is provisioned.
});
```

Bad:

```typescript
skip("sends the weekly digest", () => {});
```

A skip without a reason is indistinguishable from a test someone could not make pass and hid. The rules that make a skip acceptable:

1. The reason names the missing prerequisite, not a feeling.
2. The reason names where the work is tracked, if it is tracked.
3. The skip is counted. The suite reports how many tests were skipped and in which files, and a build fails when the skipped count rises above the recorded baseline.
4. A skip on a test that asserts something important is not permitted. Important behaviour is either proven or the product does not claim to do it.

Skipping a test because it is failing is not a use of this mechanism. Fix it or delete it.

## Proving a failure is pre-existing

When a test fails, the first question is not "what broke" but "did I break it". A failure that already existed on the base commit is not caused by the change under review, and treating it as if it were wastes the reviewer's attention and hides a real regression.

The proof is a comparison. Run the failing test twice, once with the change and once without, from the same base commit.

```bash
# 1. Record the failing test name and the base of the branch.
BASE_REF=origin/main
TEST_ID="packages/api/test/lease.test.ts > expired lease is abandoned"

# 2. Run it on the change, and capture the output.
<pkg> run test:unit -- "$TEST_ID" > after.txt 2>&1

# 3. Create a clean worktree at the base and run the same test there.
<vcs> worktree add .tmp/base-check "$BASE_REF"
cd .tmp/base-check
<pkg> install --frozen-lockfile
<pkg> run test:unit -- "$TEST_ID" > ../before.txt 2>&1
cd ../..
<vcs> worktree remove .tmp/base-check
```

Compare the two outputs.

| Result on the base | Result with the change | Conclusion |
| --- | --- | --- |
| Fails the same way | Fails the same way | Pre-existing. Report it separately; do not block the change on it. |
| Fails the same way | Passes | The change fixed it. Say so in the description of the change. |
| Passes | Fails | Introduced by the change. This is the only case that blocks. |
| Passes | Fails differently | Introduced by the change, and the change also broke something else. Fix both. |

Rules for the comparison:

- The base worktree must be clean. Use a fresh worktree rather than stashing, so nothing about the working tree changes the result.
- The test must be the same test. Same identifier, same seed, same fixture.
- Record the comparison in the change description. "This test already fails on the base, here is the before and after" is a fact the reviewer can check.

## Why the proof matters

Without the proof, three things go wrong.

1. **Good changes get rejected.** A reviewer cannot tell an introduced regression from a pre-existing failure without running the comparison, so the reviewer's only safe action is to ask for it.
2. **Real regressions get waved through.** If "the test was already failing" is an accepted answer with no evidence attached, then it becomes an answer anyone can give for any regression.
3. **The suite loses its value.** Once a suite is known to contain failures nobody is chasing, the green result stops meaning anything, and people stop reading the pipeline output.

The cost of the proof is small: one worktree and one command. The saving is the reviewer's attention on every future change.

## Keeping the suite honest

| Practice | The rule | How it is enforced |
| --- | --- | --- |
| No retry-until-pass | A test that fails must fail the build. Retrying hides flakiness. | The pipeline runs the suite once. A retry step is not allowed in the main path. |
| Quarantine has a limit | A quarantined test is removed from the required set and has a named owner and a date. | The report lists quarantined tests. The count is capped, and exceeding the cap fails the build. |
| No network in unit and contract layers | A unit or contract test that opens an outbound connection fails. | The test runner blocks outbound connections for those layers. |
| Deterministic time and randomness | The current time and the random seed are injected, not read from the environment. | Tests that call the real clock or use unseeded randomness fail in a strict mode the pipeline enables. |
| Coverage is a floor, not a target | Coverage below the floor fails the build. Coverage above it earns nothing. | A threshold check in the pipeline. |
| Tests do not depend on each other | Any test can run alone, in any order. | The suite runs in a randomised order on a schedule, and a failure caused by ordering is fixed immediately. |
| The slow layer is used sparingly | End-to-end tests cover journeys. They do not cover every branch. | A count limit on end-to-end tests is reviewed when one is added. |
| Test data is created and destroyed by the test | No test reads state another test left behind. | The harness gives each test its own namespace and verifies isolation at the end of the run. |
| A failing test blocks the merge | There is no "merge anyway" for a red suite. | The merge gate reads the pipeline result. |

A suite is honest when a red result is information. Every practice in the table above exists to keep a red result meaning "something is wrong" and nothing else.

## What a test may not do

| Not allowed | Why |
| --- | --- |
| Assert on a log line | Logs are for operators. Their format changes for good reasons. |
| Assert on an exact timestamp | Time is injected and asserted on as a relationship, not as a literal. |
| Sleep to wait for a condition | Wait for the condition, with a bounded timeout and a clear failure message. |
| Read a file written by another test | See the isolation rule above. |
| Depend on a record in the scratch database | See the note in [Local environment](local-environment.md). |
| Call a real third-party service | It makes the suite slow, flaky and dependent on someone else's availability. Use a stub at a layer that allows it. |
