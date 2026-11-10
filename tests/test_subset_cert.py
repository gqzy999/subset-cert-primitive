"""Local mock tests for SubsetCert. NOT chain consensus evidence.

The real contract source (contracts/subset_cert.py) is imported with
a stubbed `genlayer` module: the host fakes the VM (message, storage)
so the contract's deterministic logic can be exercised locally.
Passing here proves the membership logic and the guards in this file;
on-chain proof comes only from the FINALIZED transactions in
evidence.json.
"""
import importlib.util
import json
import sys
import types
import unittest
from pathlib import Path


class Map(dict):
    @classmethod
    def __class_getitem__(cls, value):
        return cls


class _Write:
    def __call__(self, f):
        return f

    def payable(self, f):
        return f


identity = lambda f: f


class UserError(Exception):
    pass


host = types.SimpleNamespace(
    Contract=object,
    public=types.SimpleNamespace(view=identity, write=_Write()),
    message=types.SimpleNamespace(sender_address="0x" + "1" * 40, value=0),
    evm=types.SimpleNamespace(contract_interface=identity),
    vm=types.SimpleNamespace(UserError=UserError, Return=object),
    nondet=types.SimpleNamespace(),
)
sdk = types.ModuleType("genlayer")
sdk.gl, sdk.TreeMap, sdk.u32, sdk.u256 = host, Map, int, int
sdk.Address = lambda a: a
sys.modules["genlayer"] = sdk

spec = importlib.util.spec_from_file_location(
    "subset_cert", Path(__file__).parents[1] / "contracts" / "subset_cert.py"
)
r = importlib.util.module_from_spec(spec)
spec.loader.exec_module(r)

CREATOR = "0x" + "1" * 40
A_SUB = ["read", "write"]
B_SUPER = ["read", "write", "admin"]
A_NOT = ["read", "delete"]


def expect_error(fn, code):
    with unittest.TestCase().assertRaises(UserError) as ctx:
        fn()
    assert code in str(ctx.exception), f"expected {code}, got {ctx.exception}"


class SubsetCertTests(unittest.TestCase):
    def setUp(self):
        host.message.sender_address = CREATOR
        host.message.value = 0
        self.c = r.SubsetCert()
        self.c.cases = Map()
        self.c.total_cases = 0
        self.c.subset_ok_count = 0
        self.c.not_subset_count = 0

    def create(self, cid, a, b, membership, verdict):
        return self.c.create_case(
            cid,
            json.dumps(a),
            json.dumps(b),
            json.dumps(membership),
            verdict,
        )

    def test_protocol(self):
        p = json.loads(self.c.get_protocol())
        self.assertEqual(p["protocol"], "subsetcert-1")
        self.assertEqual(p["verdicts"], ["SUBSET_OK", "NOT_SUBSET"])
        self.assertEqual(p["states"], ["DECIDED"])
        self.assertEqual(p["min_a"], 2)
        self.assertEqual(p["max_a"], 16)
        self.assertEqual(p["min_b"], 1)
        self.assertEqual(p["max_b"], 32)
        self.assertEqual(p["max_item_len"], 32)

    def test_membership_and_verdicts(self):
        self.assertEqual(r.compute_membership(A_SUB, B_SUPER), [True, True])
        self.assertEqual(r.compute_verdict([True, True]), "SUBSET_OK")
        self.assertEqual(r.compute_membership(A_NOT, B_SUPER), [True, False])
        self.assertEqual(r.compute_verdict([True, False]), "NOT_SUBSET")
        self.assertEqual(r.compute_verdict([False, False]), "NOT_SUBSET")
        # Membership is per element, not per count: B having "read"
        # once still covers A; duplicates are rejected elsewhere.
        self.assertEqual(r.compute_membership(["a", "b"], ["b", "a", "c"]), [True, True])
        self.assertEqual(r.compute_membership(["a", "x", "y"], ["a", "b"]), [True, False, False])

    def test_witness_is_first_missing_element(self):
        self.assertIsNone(r.compute_witness(A_SUB, [True, True]))
        self.assertEqual(
            r.compute_witness(A_NOT, [True, False]),
            {"index": 1, "item": "delete"},
        )
        # Two missing elements: the witness is the first one in order.
        self.assertEqual(
            r.compute_witness(["a", "x", "y"], [True, False, False]),
            {"index": 1, "item": "x"},
        )

    def test_good_subset_ok(self):
        out = json.loads(self.create("C-OK", A_SUB, B_SUPER, [True, True], "SUBSET_OK"))
        self.assertEqual(out["verdict"], "SUBSET_OK")
        self.assertEqual(out["membership"], [True, True])
        self.assertIsNone(out["witness"])
        self.assertEqual(out["state"], "DECIDED")
        back = json.loads(self.c.get_case("C-OK"))
        self.assertEqual(back, out)
        stats = json.loads(self.c.get_stats())
        self.assertEqual(stats, {"total": 1, "subset_ok": 1, "not_subset": 0})

    def test_good_not_subset_with_witness(self):
        out = json.loads(self.create("C-NOT", A_NOT, B_SUPER, [True, False], "NOT_SUBSET"))
        self.assertEqual(out["verdict"], "NOT_SUBSET")
        self.assertEqual(out["membership"], [True, False])
        self.assertEqual(out["witness"], {"index": 1, "item": "delete"})
        stats = json.loads(self.c.get_stats())
        self.assertEqual(stats, {"total": 1, "subset_ok": 0, "not_subset": 1})

    def test_bad_claims_fail_and_create_nothing(self):
        # Subset case, but the last membership entry flipped to False.
        expect_error(
            lambda: self.create("C-BAD", A_SUB, B_SUPER, [True, False], "SUBSET_OK"),
            "MEMBERSHIP_MISMATCH",
        )
        self.assertEqual(self.c.get_case("C-BAD"), "")
        # Right vector, wrong verdict label.
        expect_error(
            lambda: self.create("C-BAD", A_SUB, B_SUPER, [True, True], "NOT_SUBSET"),
            "VERDICT_MISMATCH",
        )
        self.assertEqual(self.c.get_case("C-BAD"), "")
        # Not-subset case claimed as a subset: vector and verdict both
        # wrong, the vector check fires first.
        expect_error(
            lambda: self.create("C-BAD", A_NOT, B_SUPER, [True, True], "SUBSET_OK"),
            "MEMBERSHIP_MISMATCH",
        )
        self.assertEqual(self.c.get_case("C-BAD"), "")
        # Wrong-length claimed vector.
        expect_error(
            lambda: self.create("C-BAD", A_SUB, B_SUPER, [True], "SUBSET_OK"),
            "CLAIMED_LENGTH",
        )
        # The correct claim then succeeds on the same id.
        out = json.loads(self.create("C-BAD", A_SUB, B_SUPER, [True, True], "SUBSET_OK"))
        self.assertEqual(out["verdict"], "SUBSET_OK")
        self.assertEqual(json.loads(self.c.get_stats())["total"], 1)

    def test_validation(self):
        expect_error(
            lambda: self.create("C-X", ["read"], B_SUPER, [True], "SUBSET_OK"),
            "A_COUNT_2_16",
        )
        expect_error(
            lambda: self.create("C-X", A_SUB, [], [True, True], "SUBSET_OK"),
            "B_COUNT_1_32",
        )
        expect_error(
            lambda: self.create("C-X", ["read", ""], B_SUPER, [True, True], "SUBSET_OK"),
            "A_FORMAT",
        )
        expect_error(
            lambda: self.create("C-X", ["read", "x" * 33], B_SUPER, [True, True], "SUBSET_OK"),
            "A_FORMAT",
        )
        expect_error(
            lambda: self.create("C-X", A_SUB, ["read", ""], [True, True], "SUBSET_OK"),
            "B_FORMAT",
        )
        expect_error(
            lambda: self.create("C-X", ["read", "read"], B_SUPER, [True, True], "SUBSET_OK"),
            "DUPLICATE_A",
        )
        expect_error(
            lambda: self.create("C-X", A_SUB, ["read", "read"], [True, True], "SUBSET_OK"),
            "DUPLICATE_B",
        )
        expect_error(
            lambda: self.create("C-X", ["read"] * 17, B_SUPER, [True] * 17, "SUBSET_OK"),
            "A_COUNT_2_16",
        )
        expect_error(
            lambda: self.create("C-X", A_SUB, B_SUPER, [True, True], "UNKNOWN"),
            "VERDICT_UNKNOWN",
        )
        expect_error(
            lambda: self.create("bad id!", A_SUB, B_SUPER, [True, True], "SUBSET_OK"),
            "CASE_ID_CHARS",
        )

    def test_verdict_is_immutable(self):
        self.create("C-ONE", A_SUB, B_SUPER, [True, True], "SUBSET_OK")
        # Same id again, even with a different (correct) claim, fails.
        expect_error(
            lambda: self.create("C-ONE", A_NOT, B_SUPER, [True, False], "NOT_SUBSET"),
            "ALREADY_EXISTS",
        )
        back = json.loads(self.c.get_case("C-ONE"))
        self.assertEqual(back["verdict"], "SUBSET_OK")
        self.assertEqual(back["membership"], [True, True])


if __name__ == "__main__":
    unittest.main()
