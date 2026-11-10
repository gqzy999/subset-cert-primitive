# SubsetCert — subset certificate primitive

集合 A 是否为集合 B 的子集的认证原语：对 A 的每个元素，逐项判定它是否属于 B。

SubsetCert is a deterministic subset certificate primitive: it certifies whether a set A (a list of strings) is a subset of a set B (a list of strings) — every element of A is a member of B. The verdict is fixed by the full per-element membership vector.

- Network: Stable Studionet, Chain ID 61999, RPC https://studio.genlayer.com/api
- Contract: `TBD`
- Explorer: https://explorer-studio.genlayer.com/address/TBD
- Source: `contracts/subset_cert.py`
- Source SHA-256: `TBD`
- Deployed code matches the source byte for byte (checked with `gen_getContractCode`).

## Mechanism / 机制

One thing, one fixed enumeration table, full-vector exact equality, one explicit counterexample on-chain.

`create_case(case_id, a_json, b_json, claimed_membership_json, claimed_verdict)` certifies one pair of sets:

1. Set A: 2–16 unique non-empty strings, each 1–32 characters long. Set B: 1–32 unique non-empty strings, each 1–32 characters long.
2. For every element of A, in index order, the contract recomputes `membership_k = True` iff `A[k]` is a member of B. Membership is per element only — no counts are compared: an element is either in B or it is not, and duplicates inside A or inside B are rejected outright.
3. The verdict is a fixed enumeration over the full membership vector:

   | Verdict | Meaning |
   | --- | --- |
   | `SUBSET_OK` | Every membership entry is True — A is a subset of B. |
   | `NOT_SUBSET` | At least one membership entry is False — some element of A is outside B. |

4. The witness is the first element of A that is not in B: `{index, item}` (or `null` when the verdict is `SUBSET_OK`). The full membership vector is stored with the record.
5. **Equivalence check, zero tolerance:** the caller-proposed membership vector must equal the recomputed vector element by element, and the caller-proposed verdict must equal the recomputed verdict. Any single entry flipped, or a verdict that does not match the recomputed vector, fails the call (`MEMBERSHIP_MISMATCH` / `VERDICT_MISMATCH`) and creates no record. No aggregation, no scores, no thresholds.

No LLM is used: this is pure deterministic string membership. Leader and validators each recompute the same vector from the same locked inputs; there is no judgement call anywhere in the decision. The consequence is informational only: the record states the verdict and the witness. No GEN moves, no money changes hands.

## State machine / 状态机

```
create_case() --> DECIDED (terminal, verdict immutable)
```

- A record is created once, already in state `DECIDED`. There is no update method, so the verdict can never change.
- A second `create_case` with the same `case_id` fails with `ALREADY_EXISTS`.
- A failed claim (wrong vector or wrong verdict) creates no record at all — the same `case_id` can be retried with the correct claim.

## How to call / 调用方法

All sets are string lists inside JSON. All on-chain values are English.

```js
// Certify a subset: A ["read","write"], B ["read","write","admin"]
// membership [true, true]
// -> SUBSET_OK, witness null
create_case(
  "C-OK-01",
  JSON.stringify(["read", "write"]),
  JSON.stringify(["read", "write", "admin"]),
  JSON.stringify([true, true]),
  "SUBSET_OK",
);
// -> the stored record, state DECIDED
```

```js
// Certify a non-subset: A ["read","delete"], B ["read","write","admin"]
// membership [true, false]
// -> NOT_SUBSET, witness {index: 1, item: "delete"}
create_case(
  "C-NOT-01",
  JSON.stringify(["read", "delete"]),
  JSON.stringify(["read", "write", "admin"]),
  JSON.stringify([true, false]),
  "NOT_SUBSET",
);
```

```js
// A wrong claim fails on-chain and creates no record:
// same sets as C-OK-01, but the last membership entry flipped to false
// -> ERROR MEMBERSHIP_MISMATCH
create_case(
  "C-BAD-01",
  JSON.stringify(["read", "write"]),
  JSON.stringify(["read", "write", "admin"]),
  JSON.stringify([true, false]),
  "SUBSET_OK",
);
```

Reads:

```js
get_protocol(); // protocol, bounds, verdicts, states, membership rule
get_case("C-OK-01"); // id, a, b, membership, verdict, witness, state, creator
get_stats(); // total, subset_ok, not_subset
```

## Evidence / 证据

All transactions FINALIZED with MAJORITY_AGREE consensus. Full machine-readable evidence: [`evidence.json`](evidence.json). Deployment record: [`deployment.json`](deployment.json).

| Case | Transaction | Result |
| --- | --- | --- |
| Deploy | `TBD` | FINALIZED, contract `TBD` |
| C-OK-01 A ["read","write"], B ["read","write","admin"] | `TBD` | FINALIZED / SUCCESS — membership [true, true], verdict SUBSET_OK, witness null |
| C-BAD-01 same sets, last membership entry flipped to False | `TBD` | FINALIZED / ERROR `MEMBERSHIP_MISMATCH` — the flipped claim was rejected; no record created |
| C-NOT-01 A ["read","delete"], B ["read","write","admin"] | `TBD` | FINALIZED / SUCCESS — membership [true, false], verdict NOT_SUBSET, witness {index: 1, item: "delete"} |

Final stats read back live: total 2 — subset_ok 1, not_subset 1.

## Reuse / 复用价值

Any permission set, capability list, tag set, or allowlist check — a role's permissions against the permissions a system grants, a document's tags against an approved vocabulary, a requested scope list against an allowed scope list — can be certified with this primitive: send the two sets with the claimed membership vector and verdict, and consensus either confirms the first set is contained in the second or names the first element that falls outside. The same contract also serves as the deterministic core for any set-inclusion check.

## Tests / 测试

`tests/test_subset_cert.py` runs the real contract source locally with a stubbed host module (local mock only — not chain consensus evidence). It covers the subset verdict, the non-subset verdict with witness, first-missing-element selection, tampered vectors, wrong-verdict labels, input validation, and the immutable-verdict rule:

```bash
npm test   # python3 tests/test_subset_cert.py — 8 tests
```

## Known limitations / 已知限制

- The sets are caller-supplied: the contract certifies the sets as given, but it does not verify they came from a real permission system or allowlist. A certificate is only as honest as its input sets.
- There is no independent anchor for the sets: the contract checks the claimed membership vector and verdict against the sets exactly, but nothing outside the chain vouches for where the sets came from. The sets are provided by the caller, with no independent anchor.
- The consequence is informational only: the record states the verdict and the witness; no GEN moves and no money changes hands.
- Set A is capped at 16 items and set B at 32 items, each item at most 32 characters; larger sets must be split into several cases.
