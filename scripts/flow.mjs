/* On-chain evidence flow for SubsetCert on Stable Studionet.
 *
 * Usage: node scripts/flow.mjs   (uses deployment.json for the address)
 *
 * One ephemeral account only (key never written to disk). No GEN moves
 * anywhere in this flow: create_case is not payable and the verdict is
 * informational only, so no faucet funding is needed.
 *
 * Flow (deploy + 3 writes = 4 transactions):
 *   C-OK-01:  A ["read","write"], B ["read","write","admin"]
 *       -> GOOD, membership [true,true], verdict SUBSET_OK
 *   C-BAD-01: same A and B, last membership entry flipped to false
 *       -> BAD, must fail MEMBERSHIP_MISMATCH, no record created
 *   C-NOT-01: A ["read","delete"], B ["read","write","admin"]
 *       -> GOOD, membership [true,false], verdict NOT_SUBSET,
 *          witness {index: 1, item: "delete"}
 *
 * RPC discipline: reads retry with exponential back-off; receipts are
 * polled slowly (12 s); a write is sent exactly ONCE per attempt
 * and never re-sent on a polling failure.
 */
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createClient, createAccount, generatePrivateKey } from "genlayer-js";
import { studionet } from "genlayer-js/chains";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const deployment = JSON.parse(readFileSync(path.join(root, "deployment.json"), "utf-8"));
const address = process.env.CONTRACT_ADDRESS || deployment.contractAddress;
if (!address) throw new Error("No contract address: set CONTRACT_ADDRESS or run deploy first");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// --- account (ephemeral; key never leaves this process) -----------------------
const creator = createAccount(generatePrivateKey());
console.log(`creator: ${creator.address}`);
console.log("Contract:", address);

const clientFor = (account) => createClient({ chain: studionet, account });
const reader = clientFor(creator);

const evidence = {
  network: "Stable Studionet",
  chainId: 61999,
  rpcUrl: "https://studio.genlayer.com/api",
  contractAddress: address,
  deployTxHash: deployment.deployTxHash,
  contractFile: "contracts/subset_cert.py",
  contractSha256: deployment.contractSha256,
  deployedCodeSha256: deployment.deployedCodeSha256,
  deployedCodeMatchesSource: deployment.deployedCodeMatchesSource,
  accounts: { creator: creator.address },
  cases: [],
  transactions: [],
  finalReadbacks: null,
  generatedAt: new Date().toISOString(),
};
const save = () => writeFileSync(path.join(root, "evidence.json"), JSON.stringify(evidence, null, 2) + "\n");

// --- rate-limit-aware reads --------------------------------------------------
const RETRYABLE = /html|429|rate limit|too many|ECONNRESET|ETIMEDOUT|fetch failed|Unexpected token|Service Unavailable|Bad Gateway|Gateway Timeout|temporarily|RLP|internal error|InternalRpcError|32603/i;
function retryAfterMs(err) {
  let node = err;
  for (let i = 0; i < 5 && node; i++) {
    const secs = node?.data?.retry_after_seconds ?? node?.cause?.data?.retry_after_seconds;
    if (typeof secs === "number" && secs > 0) return Math.min(secs * 1000, 1500000);
    if (typeof node?.message === "string" && /rate limit/i.test(node.message)) {
      const m = node.message.match(/retry_after_seconds\D*(\d+)/);
      if (m) return Math.min(Number(m[1]) * 1000, 1500000);
    }
    node = node?.cause;
  }
  return null;
}
async function withRetry(fn, label, maxAttempts = 15) {
  let delay = 5000;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const out = await fn();
      if (typeof out === "string" && out.trimStart().startsWith("<")) {
        throw new Error("HTML error page instead of JSON");
      }
      return out;
    } catch (e) {
      const msg = String(e?.message || e);
      if (attempt === maxAttempts || !RETRYABLE.test(msg)) throw e;
      const wait = retryAfterMs(e) ?? delay;
      console.log(`  [retry ${label} attempt ${attempt}/${maxAttempts} after ${Math.round(wait / 1000)}s: ${msg.slice(0, 120)}]`);
      await sleep(wait);
      delay = Math.min(delay * 2, 60000);
    }
  }
}

async function rpc(method, params) {
  return withRetry(() => reader.request({ method, params }), `rpc ${method}`);
}

async function readJson(functionName, args = []) {
  const raw = await withRetry(
    () => reader.readContract({ address, functionName, args }),
    `read ${functionName}`,
  );
  if (typeof raw === "string" && (raw.startsWith("{") || raw.startsWith("["))) return JSON.parse(raw);
  return raw;
}

// --- receipt polling (slow; never re-submits) --------------------------------
const STATUS = { 0: "UNINITIALIZED", 1: "PENDING", 2: "PROPOSING", 3: "COMMITTING", 4: "REVEALING", 5: "ACCEPTED", 6: "UNDETERMINED", 7: "FINALIZED", 8: "CANCELED" };
const statusOf = (r) => r.status_name ?? r.statusName ?? STATUS[r.status] ?? String(r.status ?? "");
const resultOf = (r) => r.result_name ?? r.resultName ?? "";
function leaderOf(receipt) {
  const list = receipt.consensus_data?.leader_receipt || [];
  const arr = Array.isArray(list) ? list : [list];
  return arr.find((x) => x.mode === "leader") || arr[arr.length - 1] || {};
}

function decodeResultField(value) {
  if (typeof value !== "string" || !value) return "";
  try {
    return Buffer.from(value, "base64").toString("utf-8").replace(/^[^\x20-\x7E]+/, "");
  } catch {
    return "";
  }
}
function errorTextOf(leader) {
  const fromResult = decodeResultField(leader.result);
  const fromStderr = (leader.genvm_result?.stderr || leader.stderr || "").toString();
  return [fromResult, fromStderr].filter(Boolean).join("\n");
}

async function pollReceipt(hash, label, maxPolls = 40, intervalMs = 12000) {
  for (let i = 0; i < maxPolls; i++) {
    const receipt = await rpc("eth_getTransactionByHash", [hash]);
    if (receipt && (statusOf(receipt) === "FINALIZED" || statusOf(receipt) === "CANCELED")) {
      return receipt;
    }
    if (i % 5 === 0) console.log(`  ${label}: waiting (${statusOf(receipt || {}) || "unknown"}), poll ${i + 1}/${maxPolls}`);
    await sleep(intervalMs);
  }
  throw new Error(`${label} did not finalize after ${maxPolls} polls (tx ${hash})`);
}

// --- writes: sent exactly once per attempt ------------------------------
async function write(account, functionName, args, label, expectError = null) {
  const client = clientFor(account);
  const hash = await client.writeContract({ address, functionName, args, value: 0n, leaderOnly: false });
  console.log(`${label} tx: ${hash}`);
  const receipt = await pollReceipt(hash, label);
  const status = statusOf(receipt);
  const consensus = resultOf(receipt);
  const leader = leaderOf(receipt);
  const execution = leader.execution_result || leader.executionResult || "";
  const stderr = errorTextOf(leader);
  const record = {
    label,
    method: functionName,
    args: JSON.parse(JSON.stringify(args, (k, v) => (typeof v === "bigint" ? v.toString() : v))),
    sender: account.address,
    value_wei: "0",
    txHash: hash,
    receiptStatus: status,
    consensus,
    execution,
    expected_error: expectError,
    stderr_excerpt: stderr.slice(0, 500),
  };
  evidence.transactions.push(record);
  save();
  if (status !== "FINALIZED") throw new Error(`${label} ended ${status}, not FINALIZED (tx ${hash})`);
  if (consensus !== "MAJORITY_AGREE") throw new Error(`${label} consensus ${consensus}, not MAJORITY_AGREE (tx ${hash})`);
  if (expectError) {
    if (execution !== "ERROR") throw new Error(`${label} expected ERROR but leader executed ${execution} (tx ${hash})`);
    if (!stderr.includes(expectError)) {
      throw new Error(`${label} expected error ${expectError} but stderr was: ${stderr.slice(0, 300)} (tx ${hash})`);
    }
    console.log(`  ${label}: FINALIZED / MAJORITY_AGREE / ERROR (${expectError}) as expected`);
  } else {
    if (execution !== "SUCCESS") throw new Error(`${label} expected SUCCESS but leader executed ${execution}: ${stderr.slice(0, 300)} (tx ${hash})`);
    console.log(`  ${label}: FINALIZED / MAJORITY_AGREE / SUCCESS`);
  }
  return { hash, receipt, record };
}

const canon = (v) =>
  JSON.stringify(v, (k, val) =>
    val && typeof val === "object" && !Array.isArray(val)
      ? Object.fromEntries(Object.entries(val).sort())
      : val,
  );

function assertEq(actual, expected, label) {
  if (String(actual) !== String(expected)) {
    throw new Error(`${label}: expected ${expected}, got ${actual}`);
  }
}

async function pollUntil(label, fn, ok, timeoutMs = 90000, intervalMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  let last;
  for (;;) {
    last = await fn();
    if (ok(last)) return last;
    if (Date.now() >= deadline) {
      throw new Error(`${label}: state did not appear within ${timeoutMs / 1000}s; last value: ${JSON.stringify(last).slice(0, 400)}`);
    }
    await sleep(intervalMs);
  }
}

// ===========================================================================
// Main flow
// ===========================================================================
console.log("Flow start:", new Date().toISOString());

const A_SUB = ["read", "write"];
const B_SUPER = ["read", "write", "admin"];
const A_NOT = ["read", "delete"];

async function createCase(cid, a, b, membership, verdict, label, expectError = null) {
  const args = [
    cid,
    JSON.stringify(a),
    JSON.stringify(b),
    JSON.stringify(membership),
    verdict,
  ];
  const { hash } = await write(creator, "create_case", args, label, expectError);
  return hash;
}

// --- preflight: fresh contract ------------------------------------------------
{
  const pre = await readJson("get_stats", []);
  if (pre.total !== 0) {
    throw new Error(`contract is not fresh: total cases is ${pre.total}, expected 0. Redeploy a fresh contract before running the flow.`);
  }
  console.log("  preflight: fresh contract (0 cases)");
}

// --- C-OK-01: A is a subset of B ----------------------------------------------
console.log("\n--- C-OK-01: A is a subset of B ---");
await createCase("C-OK-01", A_SUB, B_SUPER, [true, true], "SUBSET_OK", "create-C-OK-01-good");
{
  const back = await pollUntil(
    "C-OK-01 readback",
    () => readJson("get_case", ["C-OK-01"]),
    (b) => b.id === "C-OK-01" && b.verdict === "SUBSET_OK" && JSON.stringify(b.membership) === "[true,true]",
  );
  assertEq(back.state, "DECIDED", "C-OK-01 state");
  assertEq(back.witness, null, "C-OK-01 witness");
  console.log(`  C-OK-01: verdict ${back.verdict}, witness ${JSON.stringify(back.witness)}`);
}
evidence.cases.push({
  id: "C-OK-01", a: A_SUB, b: B_SUPER,
  expected_membership: [true, true],
  expected_verdict: "SUBSET_OK", expected_witness: null,
});
save();

// --- C-BAD-01: BAD claim on the same sets --------------------------------------
console.log("\n--- C-BAD-01: flipped membership entry ---");
await createCase("C-BAD-01", A_SUB, B_SUPER, [true, false], "SUBSET_OK", "create-C-BAD-01-bad-claim", "MEMBERSHIP_MISMATCH");
{
  const back = await readJson("get_case", ["C-BAD-01"]);
  assertEq(back, "", "bad claim created a record");
  console.log("  C-BAD-01: no record after bad claim, as expected");
}
evidence.cases.push({
  id: "C-BAD-01", a: A_SUB, b: B_SUPER,
  expected_membership: [true, true],
  expected_verdict: "SUBSET_OK", expected_witness: null,
  bad_claim: { claimed_membership: [true, false], claimed_verdict: "SUBSET_OK", error: "MEMBERSHIP_MISMATCH" },
  record_expected: false,
});
save();

// --- C-NOT-01: A contains an element outside B --------------------------------
console.log("\n--- C-NOT-01: A contains an element outside B ---");
await createCase("C-NOT-01", A_NOT, B_SUPER, [true, false], "NOT_SUBSET", "create-C-NOT-01-good");
{
  const back = await pollUntil(
    "C-NOT-01 readback",
    () => readJson("get_case", ["C-NOT-01"]),
    (b) => b.id === "C-NOT-01" && b.verdict === "NOT_SUBSET" && JSON.stringify(b.membership) === "[true,false]",
  );
  assertEq(back.state, "DECIDED", "C-NOT-01 state");
  assertEq(
    canon(back.witness),
    canon({ index: 1, item: "delete" }),
    "C-NOT-01 witness",
  );
  console.log(`  C-NOT-01: verdict ${back.verdict}, witness ${JSON.stringify(back.witness)}`);
}
evidence.cases.push({
  id: "C-NOT-01", a: A_NOT, b: B_SUPER,
  expected_membership: [true, false],
  expected_verdict: "NOT_SUBSET",
  expected_witness: { index: 1, item: "delete" },
});
save();

// --- final read-backs -----------------------------------------------------------
console.log("\n--- final read-backs ---");
const finalStats = await readJson("get_stats", []);
assertEq(finalStats.total, 2, "final total cases");
assertEq(finalStats.subset_ok, 1, "final subset_ok count");
assertEq(finalStats.not_subset, 1, "final not_subset count");
const finalCases = [];
for (const c of evidence.cases) {
  if (c.record_expected === false) continue;
  const live = await readJson("get_case", [c.id]);
  assertEq(live.verdict, c.expected_verdict, `${c.id} verdict`);
  assertEq(JSON.stringify(live.membership), JSON.stringify(c.expected_membership), `${c.id} membership`);
  assertEq(canon(live.witness), canon(c.expected_witness), `${c.id} witness`);
  assertEq(live.state, "DECIDED", `${c.id} state`);
  finalCases.push(live);
}
console.log("  final stats:", JSON.stringify(finalStats));
console.log("  all 2 cases read back live and match evidence");

evidence.finalReadbacks = {
  cases: finalCases,
  stats: finalStats,
  readBackAt: new Date().toISOString(),
};
evidence.generatedAt = new Date().toISOString();
save();
console.log("\nFLOW DONE: all transactions FINALIZED, all readbacks match");
