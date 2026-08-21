# Contract

Three artifacts, in dependency order.

| File | What it is |
| --- | --- |
| `cronheart-contract.json` | The normative description of the Cronheart wire surface. Every fact in it was read out of the running server's source. |
| `CLASSIFICATION.md` | The rule table that turns a diff of that file into `additive` / `breaking-*` / `undecidable`. |
| `vectors/*.json` | Language-neutral conformance cases, written in the fixed predicate vocabulary defined in `vectors/_vocabulary.json`. |
| `classify.mjs` | That rule table as code, plus the reader that fails the drift watch on any cell the two disagree about. |
| `server-snapshot.json` | The published specification projected onto the pointers of the contract. Written by `contract:drift:live`, never by hand. |
| `drift.mjs` | The watch itself: offline against the snapshot on every pull request, live against the service on a schedule. |

They exist because the alternative — a hand-maintained prose table of "wire anchors" —
is unverifiable, and has already let real bugs ship green in a sibling SDK.

## Why a contract file instead of types

The SDK needs three different things from the same set of facts and they cannot share
one representation:

- **Constants** the code holds (the body cap, the marker, the pagination clamp). A test
  reads `anchors` out of the contract and asserts equality with the exported constant.
- **Behaviour** under adversarial input (what the server does with `-1`, where a
  four-byte character straddles the byte cap). No constant can express that; vectors can.
- **Tolerance rules** (which vocabularies may grow without breaking us). That is the
  `openness` tag, and it is what makes the classification table decidable at all.

A second SDK in another language consumes exactly these three, which is what makes the
Python port a port rather than a second design.

## Reading the contract

- `layer` distinguishes **server** facts (the service enforces them; changing one is a
  server change) from **client-convention** facts (nothing enforces them; every official
  SDK implements them identically so behaviour is portable). Body truncation, the
  `Retry-After` parser and the SDK's own outcome vocabulary are conventions. The action
  map, the dedup rule and every validation bound are server facts.
- `openness` on a vocabulary says whether a consumer must reject an unknown member
  (`closed`) or tolerate it (`open`). Read vocabularies are mostly open on purpose: a
  hydrator that throws on an unrecognised status turns a server-side addition into a
  client outage.
- The **deferral ledger** in `check.mjs` records anchors no SDK constant holds, each with
  a reason. A reason that names an unbuilt part of the SDK is a debt, not an exemption: the
  entries reading "management client" came due when that client shipped, and the three that
  remain are ping-surface facts the client neither implements nor compensates for.
- `hazards` carry an `id`, a `statement` of what the server does, and an `sdk_rule` for
  what we do about it. Vector cases reference hazard ids in their `why` field, so every
  hazard that is testable can be traced to the case that pins it.
- `discrepancies` records places where the published documentation and the code
  disagree. It is a list of things to fix on the server, not behaviour to implement.

## How a server change propagates

1. The server changes. The nightly `contract:drift:live` run sees it for the facts the
   published specification carries, rewrites `server-snapshot.json` and opens a pull
   request. Everything else it cannot see — the list below is not short.
2. Someone edits `cronheart-contract.json` and bumps `contract_version`.
3. `contract:check` validates the file against itself and fails on any anchor that stops
   resolving or whose value drifts. `contract:drift` classifies each difference between
   the contract and the snapshot through `CLASSIFICATION.md`, so a removal, a rename or a
   narrowed bound fails while an addition an open vocabulary tolerates does not. Reading
   the same rules against the *previous contract version*, so that a verdict disagreeing
   with the `contract_version` bump fails, is still not shipped.
4. `contract:vectors` runs every case in `vectors/` against the SDK, so a behavioural
   change fails here.
5. The SDK's constant test fails wherever an `anchors` value moved.
6. The `contract_version` string is embedded in the User-Agent, so a support request
   names the contract the client was built against.

## What the drift job cannot cover

Stated explicitly, because a check with unstated gaps is worse than no check.

**The offline comparison does no work on a normal pull request.** Neither the contract
nor the committed snapshot moved, so every fact compares equal. It earns its place on the
two pull requests where one of them did move: one that edits the contract, and the one the
nightly watch opens after the specification changed under us. That is deliberate — a job
that fetched on every pull request would let an unreachable service turn a review red.

**The published OpenAPI document is the only machine-readable thing the server offers,
and it is a partial view.** It carries the monitor name bounds, the grace range, the
pagination `limit` clamp, the read vocabularies, the identifier read/write asymmetry
and the three pagination shapes — those are the facts `contract:drift`
compares, and the job prints the count. It carries
**nothing at all about `/ping`**: no route, no action mapping, no dedup rule, no body
cap, no runtime header. And it omits most of the validation surface: the twelve-token
simple-schedule allowlist, the interval second bounds, the five-field cron dialect, the
timezone length bound, and every channel field constraint.

Everything in that second list is therefore covered **only** by constant assertions —
which prove the SDK agrees with this file, and prove nothing about whether this file
still agrees with the server. Closing that gap needs a short assertion over the same
constants living in the server's own test suite, and that has to land *before* anyone
treats these anchors as verified rather than as a snapshot.

Four more gaps worth naming:

- **The duplicate outcome is English prose.** `accepted` and `duplicate` share a status
  code and carry no header. The only signal is the response body string. No offline
  check can detect the day that string is reworded.
- **Problem responses carry no stable code.** Three different 409 conditions and every
  401 are distinguishable only by a `detail` field, which for 401 is a translation key.
  The SDK classifies on status alone, so a server-side change to *which* condition
  produces a 409 is invisible to every check here.
- **Ordering guarantees are asserted, not enforced.** The monitor and channel listings
  order by a second-precision timestamp with no tiebreaker. A drift job cannot observe
  a tiebreaker being lost — including from the two listings that have one today — only
  a live listing with colliding timestamps can.
- **`client-convention` facts have no server side to drift from.** They change when we
  change them, which is why the classification table reads a vocabulary's `layer` before
  its `openness`: widening one we own is an SDK minor release, not a coordinated major.
  What nothing here can confirm is that a fact called a convention really is unenforced,
  and a `breaking-*` verdict on one binds the SDK fleet rather than reporting a server
  event.

## Scripts

| Script | Status | Does |
| --- | --- | --- |
| `contract:check` | **shipped** | Validates `cronheart-contract.json`: every `anchors` pointer resolves, every stated `value` equals what it resolves to, ids are unique, and the validated count matches the entry count. Also compares anchors against the SDK's own constants — read from a build-time module that is never published — and sweeps that module and **both** published entry points, the check-in client and the management client, for a wire literal no anchor states. Fails on any anchor that is neither held nor named in the deferral ledger. |
| `contract:vectors` | **shipped** | Runs every case in `vectors/` through the adapter. Fails on an unknown predicate, an unknown non-optional subject, or an executed-case count that disagrees with the files. Reports the SDK-exercising cases apart from the server-model ones — see below. |
| `contract:drift` | **shipped** | Compares every fact in `server-snapshot.json` against the pointer it was projected from, classifies each difference through `CLASSIFICATION.md`, and fails on `breaking-*` or `undecidable` while passing `additive`. Refuses to run at all if the rules it holds and the rules that file documents have parted. Reads no network. |
| `contract:drift:live` | **shipped** | Fetches the published specification, projects it, rewrites the snapshot, and exits 3 when the projection moved so the scheduled workflow opens a pull request rather than failing at an unrelated moment. |
| `contract:check` diff classification | planned | Classifying a contract against its own previous version needs a previous version to diff against. The rule engine is shipped; what is missing is the second document. |

Every shipped script but `contract:drift:live` runs in the local gate and in CI on each
pull request; that one runs on a schedule, because it fetches.
`contract:vectors` is the one that has to be impossible to make vacuously green, which is
why the runner asserts its own case count against the files.

## Not every case is a claim about the SDK

`ping.classifyAction` models the **server's** action mapper. It is not a function an SDK
calls on a hot path, so an SDK implements it in test scope — which means those cases would
stay green if the SDK's own action module were deleted. They are a cross-language port
model, which is a large part of what vectors are for, but they are not conformance.

The Node runner therefore counts and reports the two halves separately, prefixes the
model cases in its test names, and pins the split, so adding cases to a model group cannot
quietly inflate a number that reads as "the SDK conforms". A port in another language
should do the same.

## Adding a vector

Add the case to the group file, bump that file's `case_count`, and give it a `why` only
if it exists because of a named hazard. Do not add a predicate: the vocabulary is fixed
at six so that a per-language adapter stays a lookup table and a switch, with no
expression evaluation anywhere. If a case cannot be written in the existing vocabulary,
that is a signal the behaviour belongs in a different test, not that the vocabulary
needs another entry.

## Public repo

This repository is public and the Cronheart server is not. Nothing here may name a
server class, file path, namespace, or internal change reference. Facts are described
by concept — "the server's ping ingest", "the account's default project" — which is
also what keeps the contract readable to someone who will never see that code.
