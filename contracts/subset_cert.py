# { "Depends": "py-genlayer:1jb45aa8ynh2a9c9xn3b7qqh8sm5q93hwfp7jqmwsfhh8jpz09h6" }
"""SubsetCert: subset certificate primitive.

One thing: certify whether a set A (a list of strings) is a subset of
a set B (a list of strings) — every element of A is a member of B.
Anyone may submit a certification; the result is recomputable by
anyone from A and B alone.

For every element of A, in index order, the contract recomputes
membership_k = True iff A[k] is a member of B. The verdict is a
fixed enumeration over the full membership vector:

  SUBSET_OK  — every membership entry is True (A is a subset of B).
  NOT_SUBSET — at least one membership entry is False.

The witness is the first element of A that is not in B:
{index, item} (or null when the verdict is SUBSET_OK). The full
membership vector is stored with the record.

This is element-wise membership only. Unlike a multiset comparison,
no counts are compared: an element is either in B or it is not, and
duplicates inside A or inside B are rejected outright.

Equivalence check: create_case takes a caller-proposed membership
vector and a caller-proposed verdict and requires EXACT element-wise
equality with the vector the contract recomputes deterministically,
plus exact equality of the verdict. Any single entry flipped, or a
verdict that does not match the recomputed vector, fails the call
and creates no record. Leader and validators each recompute the
same vector from the same locked inputs; there is no judgement call
anywhere in the decision. Zero tolerance: no aggregation, no scores,
no thresholds.

State machine: a record is created once, in state DECIDED, and the
verdict is immutable — there is no update method. A second
create_case with the same case_id always fails.

No LLM is used: this is pure deterministic string membership.
The consequence is informational only: the record states the
verdict and the witness. No GEN moves, no money changes hands.
"""

import json

from genlayer import *

PROTOCOL = "subsetcert-1"
MIN_A = 2
MAX_A = 16
MIN_B = 1
MAX_B = 32
MIN_ITEM_LEN = 1
MAX_ITEM_LEN = 32
VERDICTS = ["SUBSET_OK", "NOT_SUBSET"]
ID_CHARS = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789._-"


def pack(value):
    return json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False)


def need(ok, code):
    if not ok:
        raise gl.vm.UserError("EXPECTED: " + code)


def unique_pairs(pairs):
    d = {}
    for key, value in pairs:
        need(key not in d, "DUPLICATE_JSON_KEY")
        d[key] = value
    return d


def parse(raw):
    return json.loads(raw, object_pairs_hook=unique_pairs) if isinstance(raw, str) else raw


def compute_membership(a_items, b_items):
    """Pure function: the full per-element boolean vector, index order."""
    b_set = set(b_items)
    return [item in b_set for item in a_items]


def compute_verdict(membership):
    """Pure function: the fixed-enumeration verdict of a membership vector."""
    return "SUBSET_OK" if all(membership) else "NOT_SUBSET"


def compute_witness(a_items, membership):
    """Pure function: first element of A not in B, or null."""
    for i, ok in enumerate(membership):
        if not ok:
            return {"index": i, "item": a_items[i]}
    return None


class SubsetCert(gl.Contract):
    cases: TreeMap[str, str]
    total_cases: u32
    subset_ok_count: u32
    not_subset_count: u32

    def __init__(self):
        self.total_cases = u32(0)
        self.subset_ok_count = u32(0)
        self.not_subset_count = u32(0)

    @gl.public.view
    def get_protocol(self) -> str:
        return pack({
            "protocol": PROTOCOL,
            "min_a": MIN_A,
            "max_a": MAX_A,
            "min_b": MIN_B,
            "max_b": MAX_B,
            "min_item_len": MIN_ITEM_LEN,
            "max_item_len": MAX_ITEM_LEN,
            "verdicts": VERDICTS,
            "states": ["DECIDED"],
            "membership_rule": "each_element_of_A_is_a_member_of_B",
            "equivalence": "full_membership_vector_exact_equality_zero_tolerance",
        })

    @gl.public.view
    def get_case(self, case_id: str) -> str:
        return self.cases.get(case_id, "")

    @gl.public.view
    def get_stats(self) -> str:
        return pack({
            "total": int(self.total_cases),
            "subset_ok": int(self.subset_ok_count),
            "not_subset": int(self.not_subset_count),
        })

    @gl.public.write
    def create_case(
        self,
        case_id: str,
        a_json: str,
        b_json: str,
        claimed_membership_json: str,
        claimed_verdict: str,
    ) -> str:
        need(type(case_id) is str and 1 <= len(case_id) <= 64, "CASE_ID_LENGTH")
        need(all(c in ID_CHARS for c in case_id), "CASE_ID_CHARS")
        need(not self.cases.get(case_id, ""), "ALREADY_EXISTS")
        need(
            len(a_json) <= 2000
            and len(b_json) <= 2000
            and len(claimed_membership_json) <= 2000,
            "INPUT_BOUND",
        )
        a_items = parse(a_json)
        b_items = parse(b_json)
        claimed_membership = parse(claimed_membership_json)
        need(type(a_items) is list, "LIST_INPUT")
        need(type(b_items) is list, "LIST_INPUT")
        need(type(claimed_membership) is list, "CLAIMED_LIST_INPUT")
        need(MIN_A <= len(a_items) <= MAX_A, "A_COUNT_2_16")
        need(MIN_B <= len(b_items) <= MAX_B, "B_COUNT_1_32")
        need(
            all(
                type(s) is str and MIN_ITEM_LEN <= len(s) <= MAX_ITEM_LEN
                for s in a_items
            ),
            "A_FORMAT",
        )
        need(
            all(
                type(s) is str and MIN_ITEM_LEN <= len(s) <= MAX_ITEM_LEN
                for s in b_items
            ),
            "B_FORMAT",
        )
        need(len(set(a_items)) == len(a_items), "DUPLICATE_A")
        need(len(set(b_items)) == len(b_items), "DUPLICATE_B")
        need(len(claimed_membership) == len(a_items), "CLAIMED_LENGTH")
        need(
            all(type(r) is bool for r in claimed_membership),
            "CLAIMED_FORMAT",
        )
        need(claimed_verdict in VERDICTS, "VERDICT_UNKNOWN")
        membership = compute_membership(a_items, b_items)
        verdict = compute_verdict(membership)
        # Equivalence: the full membership vector must match exactly,
        # element by element, zero tolerance. Checked before the verdict
        # so a wrong vector can never slip through behind a right label.
        need(claimed_membership == membership, "MEMBERSHIP_MISMATCH")
        need(claimed_verdict == verdict, "VERDICT_MISMATCH")
        record = {
            "id": case_id,
            "a": a_items,
            "b": b_items,
            "membership": membership,
            "verdict": verdict,
            "witness": compute_witness(a_items, membership),
            "state": "DECIDED",
            "creator": str(gl.message.sender_address).lower(),
        }
        self.cases[case_id] = pack(record)
        self.total_cases = self.total_cases + u32(1)
        if verdict == "SUBSET_OK":
            self.subset_ok_count = self.subset_ok_count + u32(1)
        else:
            self.not_subset_count = self.not_subset_count + u32(1)
        return pack(record)
