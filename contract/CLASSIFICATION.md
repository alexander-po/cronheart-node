# Contract change classification

How a diff of `cronheart-contract.json` is turned into a verdict.

"Additive passes, breaking fails" is not implementable as stated, which is why this
file exists before anything consumes the contract. Three counterexamples, all real:

- Adding an entry to a required-field set is a **key addition** that **breaks writers**.
- Narrowing an enum is a **removal inside an array**, not a key removal.
- Widening a response vocabulary is **additive on the server** and **breaking for a
  reader that modelled it as a closed type**.

So the classifier cannot work from the diff shape alone. It resolves each changed
JSON Pointer to a **pointer class**, reads the **direction** of the change, and — for
vocabularies and constraints — consults the contract's own `openness` and `direction`
tags. The verdict is a function of all three.

## Verdicts

| Verdict | Meaning |
| --- | --- |
| `additive` | An up-to-date SDK keeps working unchanged. |
| `breaking-readers` | Code that parses a server response may now be wrong. |
| `breaking-writers` | Code that constructs a request may now be rejected. |
| `breaking-both` | Both halves. |
| `undecidable` | The rules cannot decide. A human names the verdict in the PR; CI fails until they do. |

`breaking-*` requires a major bump of `contract_version` and a coordinated SDK
release. `additive` requires a minor bump. Editorial changes (see the last table)
are a patch bump.

## Directions

`added` — a member or key appears. `removed` — one disappears. `changed` — a scalar
leaf takes a different value. `reordered` — an array's membership is identical but its
order differs.

## Layers

Every pointer sits in a layer, read from the nearest enclosing `layer` tag. `server`
means the service enforces the fact; `client-convention` means nothing enforces it and
every official SDK implements it identically so that behaviour is portable. A pointer
with no tag above it is classified as `server`, which is the louder of the two verdicts.

**The layer decides who a widening can break.** A `server` vocabulary gaining a member
means a response may now carry a string the SDK has never seen, and the reader sits on
the far side of the wire where it cannot be updated in the same release. A
`client-convention` vocabulary is one we emit ourselves: no member can reach a consumer
that the SDK did not ship, so a widening is an SDK minor release rather than a
contract-breaking change. Reading `openness` without reading `layer` classifies the
second case as the first and demands a coordinated major for a change no server ever
sees.

Narrowings and value changes are **not** layer-sensitive. Removing a member breaks
whoever reads it either way; on a `client-convention` vocabulary that reader is a
consumer of the SDK rather than of the server, so the coordinated release the verdict
demands is a fleet release, not a server one.

## Rule table

Pointer patterns use `*` for one path segment and `**` for any number.

| # | Pointer class | `added` | `removed` | `changed` | `reordered` |
| --- | --- | --- | --- | --- | --- |
| 1 | `/vocabularies/*/members` where `openness: open` **and** `direction: read` | `additive` | `breaking-readers` | `breaking-readers` | `additive` |
| 2a | `/vocabularies/*/members` where `openness: closed`, `direction: read` **and** `layer: server` | `breaking-readers` | `breaking-readers` | `breaking-readers` | `additive` |
| 2b | the same where `layer: client-convention` | `additive` — the vocabulary is ours, so a member reaches a consumer only in an SDK release that already knows it | `breaking-readers` | `breaking-readers` | `additive` |
| 3 | `/vocabularies/*/members` where `direction: write` (any openness) | `additive` | `breaking-writers` | `breaking-writers` | `additive` |
| 4 | `/vocabularies/*/members` where `direction: read+write` | apply rows 1, 2a and 2b for the read half **and** row 3 for the write half; take the union | union | union | `additive` |
| 5 | `/vocabularies/*/openness` (`open` → `closed`) | — | — | `breaking-readers` | — |
| 6 | `/vocabularies/*/openness` (`closed` → `open`) | — | — | `additive` | — |
| 6a | `/vocabularies/*/layer` (`client-convention` → `server`) | — | — | `breaking-readers` — a vocabulary we owned is now the service's, so a member we never shipped can arrive on the wire | — |
| 6b | `/vocabularies/*/layer` (`server` → `client-convention`) | — | — | `undecidable` — the claim is that the service does not enforce this after all, which nothing offline can confirm, and every later verdict on that vocabulary turns on the answer | — |
| 7 | `/api/constraints/schedule.simple/allowlist` | `additive` | `breaking-writers` | `breaking-writers` | `additive` |
| 8 | `/api/constraints/*/max*` and `/**/max_value`, `/**/cap_bytes` — bound **raised** | — | — | `additive` | — |
| 9 | the same bounds — **lowered** | — | — | `breaking-writers` | — |
| 10 | `/api/constraints/*/min*` — bound **lowered** | — | — | `additive` | — |
| 11 | the same bounds — **raised** | — | — | `breaking-writers` | — |
| 12 | `/api/constraints/*/format`, `/**/pattern` | — | — | `undecidable` — a regex change is only classifiable by deciding language inclusion; state it by hand | — |
| 13 | `/api/constraints/*/required_for_kinds`, `/api/constraints/*/not_blank`, `/api/constraints/*/required` | `breaking-writers` | `additive` | `breaking-writers` | `additive` |
| 14 | `/api/constraints/*/default` | — | — | `breaking-both` — a default is observable on read and changes what an omitted key means on write | — |
| 15 | `/api/read_shapes/*/keys` | `additive` | `breaking-readers` | `breaking-readers` | `additive` |
| 16 | `/api/read_shapes/*/nullable` | `breaking-readers` — a key that could not be null now can | `additive` | `breaking-readers` | `additive` |
| 17 | `/api/read_shapes/*/absent_by_design` | `breaking-readers` — a key that existed is now documented as absent | `additive` — a promised-absent key now exists | `breaking-readers` | `additive` |
| 18 | `/api/pagination/shapes/*/response_keys` | `additive` | `breaking-readers` | `breaking-readers` | `additive` |
| 19 | `/api/pagination/shapes/*/request_params` | `additive` | `breaking-writers` | `breaking-writers` | `additive` |
| 20 | `/api/pagination/shapes/*/termination`, `/api/pagination/limit_clamp/**`, `/api/pagination/offset_clamp/**` | — | — | `breaking-both` — a pager reads the clamp to size its requests and to decide it has finished | — |
| 21 | `/api/pagination/shapes` (a whole shape added or removed) | `additive` | `breaking-readers` | — | `additive` |
| 22 | `/api/ordering/*/guarantee` — strengthened (a tiebreaker added, or a partial order made total) | — | — | `additive` | — |
| 23 | the same — weakened or reversed | — | — | `breaking-readers` | — |
| 24 | `/api/status_to_error_class/map/*` | `additive` when `openness: open` **or** `layer: client-convention`, else `breaking-readers` | `breaking-readers` | `breaking-readers` | `additive` |
| 25 | `/api/identifiers/*/read_type` | — | — | `breaking-readers` | — |
| 26 | `/api/identifiers/*/write_type` — widened | — | — | `additive` | — |
| 27 | the same — narrowed | — | — | `breaking-writers` | — |
| 28 | `/api/idempotency/behaviours/*`, `/api/idempotency/in_flight_ttl_seconds`, `/api/idempotency/fingerprint` | `breaking-writers` | `breaking-writers` | `breaking-writers` | `additive` |
| 29 | `/ping/action_to_kind/algorithm`, `/ping/action_to_kind/case_sensitivity`, `/ping/action_to_kind/digit_test` | `breaking-both` | `breaking-both` | `breaking-both` | `undecidable` |
| 30 | `/ping/routes/*/action_pattern`, `/ping/routes/*/uuid_pattern` | — | — | `undecidable` — see row 12 | — |
| 31 | `/ping/routes/*/methods` | `additive` | `breaking-writers` | `breaking-writers` | `additive` |
| 32 | `/ping/dedup/**` | — | — | `breaking-both` — the window and its key are asserted in tests on both sides | — |
| 33 | `/ping/runtime_header/name`, `/**/format`, `/**/applied_to_kinds` | — | — | `breaking-writers` | — |
| 34 | `/ping/responses/table/*` (a row added) | `breaking-readers` — a new status or body an outcome mapper does not classify | — | — | `additive` |
| 35 | `/ping/responses/table/*` (a row removed or its `outcome`/`body`/`status` changed) | — | `breaking-readers` | `breaking-readers` | — |
| 36 | `/ping/responses/table/*/retryable` | — | — | `breaking-both` | — |
| 37 | `/body_truncation/marker`, `/body_truncation/cap_bytes`, `/body_truncation/budget_bytes`, `/body_truncation/modes/*` | `additive` (a new mode) | `breaking-writers` | `breaking-writers` | `additive` |
| 38 | `/retry_after/accepted_forms/*` | `additive` | `breaking-readers` | `breaking-readers` | `additive` |
| 39 | `/retry_after/rules/*`, `/ping_retry/rules/*` | `undecidable` — the rules are prose; a change must be restated as vectors before it can be classified | `undecidable` | `undecidable` | `additive` |
| 40 | `/anchors/*` | `additive` | `breaking-both` — an SDK's constant test loses its anchor and silently stops asserting | `breaking-both` when `value` changes; `additive` when only `pointer` is retargeted at an identical value | `additive` |
| 41 | `/api/rate_limits/by_plan/*`, `/ping/rate_limits/*/limit` — raised | — | — | `additive` | — |
| 42 | the same — lowered | — | — | `breaking-writers` | — |
| 43 | `/api/rate_limits/headers/*`, `/api/rate_limits/headers_absent_on` | `breaking-readers` | `breaking-readers` | `breaking-readers` | `additive` |
| 44 | `/api/entitlement/required_plans`, `/api/entitlement/denied_plans` | `breaking-writers` on `denied_plans`; `additive` on `required_plans` | inverse of the above | `breaking-writers` | `additive` |
| 45 | `/non_goals/*` | `breaking-both` — a new non-goal means something the SDK relied on is now disclaimed | `additive` — a non-goal removed means a gap was filled | `breaking-both` | `additive` |
| 46 | `/ping_retry/retried`, `/ping_retry/not_retried` | `breaking-writers` — the fleet starts issuing requests it did not issue before, into the ping rate limits | `additive` | `breaking-writers` | `additive` |
| 47 | `/ping_retry/max_retries` raised, or `/ping_retry/floor_delay_ms` lowered | — | — | `breaking-writers` — more traffic per job than the fleet was sized for | — |
| 48 | the same, in the direction of less traffic | — | — | `additive` | — |

### Editorial: never a version-bumping verdict on its own

| Pointer class | Verdict |
| --- | --- |
| `/**/description`, `/**/note`, `/**/statement`, `/**/sdk_rule`, `/**/example` | `editorial` |
| `/discrepancies/*` | `editorial` — a record of a documentation bug, not a wire change |
| `/**/hazards/*` (adding, removing or rewording a hazard) | `editorial` |
| `/title`, `/verified_on`, `/layers/*`, `/openness/*` (the glossary, not a vocabulary's tag) | `editorial` |

A hazard is editorial **only** while the fact it describes is unchanged. A hazard added
alongside a change elsewhere is classified by that other change.

## Resolution algorithm

1. Diff the two contract documents into a flat list of `(pointer, direction, before, after)`.
2. Match each pointer against the classes above, **most specific pattern first**. The
   editorial table is consulted last, so an editorial pattern never shadows a rule.
3. For rows 1 through 6b and 24, read the enclosing object's `openness`, `direction` and
   `layer` tags **from the new document**, and re-read them from the old one; if a tag
   itself changed, emit both the tag-change verdict (rows 5–6b) and the member verdict.
   `layer` is inherited: an object without its own tag takes the nearest one above it, and
   a pointer with none above it is read as `server`.
4. Union all verdicts. `undecidable` present ⇒ the whole change is `undecidable`.
   Otherwise `breaking-*` wins over `additive`, which wins over `editorial`.
5. Compare against the `contract_version` bump in the same diff and fail on a mismatch.

## What these rules cannot decide

Stated plainly, because a classifier that pretends to total coverage is worse than one
with a documented hole:

- **Regex and pattern changes** (rows 12, 30). Deciding whether one pattern's language
  contains another's is not something a diff-walker does. Every such change is
  `undecidable` and needs a human verdict plus, ideally, vectors on both sides of the
  new boundary.
- **Prose rules** (rows 29, 39, and any `algorithm` array). These are the facts most
  worth classifying and the least classifiable. The mitigation is to move each prose
  rule behind vectors: once a rule's behaviour is pinned by cases, a change to it is
  visible as vector churn, which *is* mechanically classifiable.
- **Semantic drift with no textual change.** The server changes and the contract does
  not. No diff exists, so no verdict exists. Only a live check against a real server
  catches this, and only for facts a live check can reach — see `README.md`.
- **Additive-for-us, breaking-for-them.** A response key added (row 15, `additive`) is
  breaking for a downstream consumer that validates our output against a closed schema.
  We classify from the SDK's point of view and say so; we do not model third-party
  strictness.
- **Coupled changes.** Two individually-additive edits can be jointly breaking — a
  vocabulary widened *and* the field's openness narrowed in the same PR resolve to
  `additive` and `breaking-readers` separately, and the union happens to be right here,
  but the rules carry no general notion of interaction. Anything touching more than
  three pointer classes at once should be read by a human regardless of the verdict.
- **Whether a `layer` tag is true.** The rules now read the tag (rows 2b, 6a, 6b, 24),
  which makes it load-bearing: calling a fact a `client-convention` downgrades every
  future widening of it. Nothing offline can observe that the service really does not
  enforce it, which is why changing the tag is `undecidable` rather than merely
  classified. Beyond that, a `breaking-*` verdict on a `client-convention` fact (body
  truncation, `Retry-After` parsing, the SDK outcome vocabulary) binds the SDK fleet
  rather than describing server drift, so the release process must read the layer and
  not only the verdict.
