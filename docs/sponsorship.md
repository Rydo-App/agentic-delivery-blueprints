# Sponsorship

Sponsorship pays for the running of this project: the maintainer time, the review queue, and the hosted infrastructure the CI needs. It does not buy influence over the project.

This document sets out what a sponsorship buys, what it does not, the levels available, how to sponsor, what a sponsor receives, and the rules that keep sponsorship from turning into control.

## What sponsorship buys

| What is funded | What it pays for |
| --- | --- |
| Maintainer time | Reviewing pull requests, triaging issues, answering questions, keeping the documentation current, releasing versions |
| Faster review | The single largest effect of sponsorship is the queue. Sponsored projects review pull requests in hours rather than in weeks, and that is the whole of the effect. |
| Hosted infrastructure for the CI | The build machines, the artefact storage and the network egress the pipeline needs. These cost real money and are the reason sponsorship matters even for a project with no paid staff. |
| Security response | Responding to a reported vulnerability, reproducing it, preparing a fix and coordinating the disclosure. |
| Tooling and licences | The services and tools the project depends on. |

Sponsorship money goes to the project as a whole. It is not a payment for a specific piece of work and it is not a retainer on the maintainer.

## What sponsorship does not buy

| Not included | Why |
| --- | --- |
| Roadmap influence | The order of the backlog is decided by maintainers on the basis of what the project needs. A sponsorship does not move an item up. |
| A feature guarantee | Sponsorship does not commit the project to building anything, in any timeframe. |
| A private support channel | Questions are answered in the public issue tracker, where the answer helps every reader. |
| A response time | No response time is promised, for sponsors or for anyone else. |
| A seat at the table | Sponsors are not part of the governance. There is no sponsor vote and no sponsor meeting. |
| Access to private material | Sponsors get what everybody gets: the code, the documentation and the issue tracker. |
| Priority during an incident | During an incident the order of attention is decided by impact, not by sponsorship. |

## The principle

> Sponsorship is not a purchase order.

A purchase order buys a deliverable. Sponsorship buys the capacity to keep a project healthy. The difference matters to both sides:

- A sponsor who buys a deliverable is owed that deliverable, and the project owes a date.
- A sponsor who supports a project is buying an outcome they cannot specify: a project that is maintained, reviewed and still there next year.

Sponsors get a clear statement of what they paid for, and the project keeps the freedom to decide what to do with the money. If a project starts treating sponsors as customers with contracts, it stops being a project and becomes an agency, and the difference shows up in the backlog within a few months.

The corollary is that sponsorship is never a condition of anything else. Nobody is refused access, and no sponsorship is required to have an issue closed, a pull request reviewed or a question answered.

## The levels

| Level | Monthly amount | What it funds | Extra recognition |
| --- | --- | --- | --- |
| Supporter | `10` | Part of a hosted build machine's cost | Name in the sponsors file |
| Sponsor | `100` | Part of the infrastructure and part of the review time | Name in the sponsors file |
| Sustainer | `500` | A substantial share of the infrastructure and the review time | Name in the sponsors file |
| Lead sponsor | `1000` | The infrastructure, and the time that keeps the backlog moving | Name in the sponsors file, logo in the readme |

Amounts are in the reporting currency of the project and are set so that the funded work is roughly proportional to the amount. If the cost of the infrastructure changes, the levels are adjusted and the change is announced before it takes effect, not after.

## How to sponsor

Sponsorship runs through the payment platform linked from the sponsors page in the readme. The process is deliberately short.

1. Open the sponsors page and choose a level.
2. Pay with the method the platform offers.
3. Optionally provide a display name and, at the lead sponsor level and above, a logo file.
4. The sponsorship appears in the sponsors file at the start of the next period, and the receipt is emailed to the address given at checkout.

There is no contract, no negotiation and no minimum term. A sponsorship continues until it is cancelled.

## What a sponsor receives

| Level | Receives |
| --- | --- |
| All levels | The name in the sponsors file (`SPONSORS.md` at the repository root) |
| All levels | A receipt for every payment |
| All levels | The yearly summary of what the money was spent on, published with the annual review |
| Lead sponsor | The above, plus the logo in the readme, next to the project name |

The name in the sponsors file is shown as the sponsor chose to write it. A company name, a personal name or a project name are all fine. The logo is only asked for at the top level, because that is the only level at which a logo is displayed.

Recognition is not permanent and it is not a trademark licence. A sponsor may ask to be removed at any time, and the logo is removed with the name.

## The rules that protect the project

### Sponsorship never influences the order of the backlog

The backlog is ordered by maintainers, using maintainers' judgement, and the order is published. Sponsorship is not an input to that decision. A sponsor may open an issue like anybody else, and that issue is prioritised like anybody else's.

The practical test is simple: if the order changed because a sponsor asked, the rule is broken. If the order changed because a maintainer decided the item was more valuable, the order changed the way it always does.

### Sponsorship never influences a security report

A security report is handled by the process described in the security policy, without reference to who sponsors the project.

| Rule | Reason |
| --- | --- |
| Reports are never discussed with a sponsor | A sponsor learns about a vulnerability only when the fix is published |
| Reports are never triaged by sponsorship | The triage order is by impact |
| Sponsors are never told which report is being worked on | Disclosure timing is decided by the disclosure policy, not by the sponsor list |
| Sponsors are never credited in an advisory | The advisory names the reporter and the project, not the sponsor list |

A sponsor who discovers a vulnerability reports it in the same way and on the same terms as anybody else, and the project does not treat sponsorship as a reason to handle it sooner.

### Sponsorship does not create a private channel

Questions go to the public issue tracker or the public discussion forum. There is no private channel for sponsors and no private channel for anyone else. A private channel would produce the same answer twice, once for one person and once for everybody, and it would make the project slower rather than faster.

### Sponsorship does not grant a service level

No response time, no availability commitment, no severity guarantee. The project publishes what it can keep working and what it cannot, and sponsors are subject to exactly that.

## Cancelling, refunds and withdrawal

A sponsorship can be cancelled at any time from the payment platform, with no notice period and no reason required.

| Situation | What happens |
| --- | --- |
| Cancelled during a period | The sponsorship continues to the end of the paid period, then ends |
| Cancelled and the sponsor asks for a refund of the unused part | The unused part of the current period is refunded to the original payment method |
| Refund processing | Refunds are issued to the original payment method, within the window the payment platform requires, and a confirmation is emailed |
| A sponsor asks to be removed from the sponsors file before the period ends | The name and the logo are removed immediately, even though the sponsorship is paid to the end of the period |
| A sponsorship ends by itself | The name moves from the current sponsors list to the historical ledger. The historical entry is not erased |

The historical ledger is public and shows every sponsorship ever received, with its amount and its period. Removing an entry from that ledger would break the transparency rule described below, so entries are never deleted from it. What is removed is the name from the current sponsors list.

## Transparency

| Rule | Detail |
| --- | --- |
| The list of sponsors is public | The sponsors file is in the repository. It names sponsors who agreed to be named. |
| The amounts are public | Each level corresponds to a stated amount, and the ledger records the amount received per period |
| The ledger is cumulative | Historical entries are kept, so the total raised over the project's life can be checked |
| The spending is reported | The yearly review lists what the money paid for: infrastructure, tooling, and the proportion of maintainer time |
| The unpaid contribution is not monetised | Maintainer time that is not paid for is described as contributed, never as a donated amount. Inventing a rate for it would make the published figures meaningless |

## Tax and invoicing

Sponsors are invoiced where invoicing is required, and the payment platform handles the billing and the collection of any applicable tax or value-added tax. The amount a sponsor pays in total depends on their own tax position and on the jurisdiction they are in.

The project publishes no tax advice, no guidance on which entity to invoice, and no interpretation of what a sponsor may deduct. Sponsors who need a specific invoice or a specific form should ask their own adviser before sponsoring, and the project's answer will always be the same: ask your adviser, then sponsor.

Two practical points that are easy to get wrong:

- **Invoices are issued by the payment platform**, in the sponsor's own name and with the tax treatment that applies to their country. The project does not issue separate tax documents.
- **A sponsorship is not a charitable donation** unless it is arranged as one through the platform, and the project does not describe it as one. Sponsors who need a donation receipt must check whether the platform offers that, and what the rules are in their country.

## Why the rules exist

Every rule in this document protects the same thing: that the project stays worth sponsoring.

A project where sponsorship decides the roadmap is a project whose roadmap is written by its largest sponsor. A project where a security report is discussed with sponsors is a project whose users have to decide how much they trust it. A project where the money is invisible is a project nobody can check.

The rules make sponsorship safe to offer, because the sponsor knows exactly what they are buying: capacity, not control. That is the reason sponsors keep paying after the first year.
