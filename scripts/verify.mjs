/* Independent re-check for SubsetCert: re-reads the live contract state
 * and compares it against evidence.json. No writes, no new transactions.
 *
 * Usage: node scripts/verify.mjs
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createClient, createAccount, generatePrivateKey } from "genlayer-js";
import { studionet } from "genlayer-js/chains";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const deployment = JSON.parse(readFileSync(path.join(root, "deployment.json"), "utf-8"));
const evidence = JSON.parse(readFileSync(path.join(root, "evidence.json"), "utf-8"));
const address = deployment.contractAddress;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const reader = createClient({ chain: studionet, account: createAccount(generatePrivateKey()) });
const RETRYABLE = /html|429|rate limit|too many|ECONNRESET|ETIMEDOUT|fetch failed|Unexpected token|Service Unavailable|Bad Gateway|Gateway Timeout|temporarily|RLP|internal error|InternalRpcError|32603/i;
async function withRetry(fn, label, maxAttempts = 10) {
  let delay = 5000;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (e) {
      if (attempt === maxAttempts || !RETRYABLE.test(String(e?.message || e))) throw e;
      console.log(`  [retry ${label} ${attempt}/${maxAttempts}]`);
      await sleep(delay);
      delay = Math.min(delay * 2, 60000);
    }
  }
}
async function readJson(functionName, args = []) {
  const raw = await withRetry(
    () => reader.readContract({ address, functionName, args }),
    `read ${functionName}`,
  );
  return typeof raw === "string" && (raw.startsWith("{") || raw.startsWith("[")) ? JSON.parse(raw) : raw;
}

const canon = (v) =>
  JSON.stringify(v, (k, val) =>
    val && typeof val === "object" && !Array.isArray(val)
      ? Object.fromEntries(Object.entries(val).sort())
      : val,
  );

function recomputeMembership(a, b) {
  const bSet = new Set(b);
  return a.map((item) => bSet.has(item));
}

let failures = 0;
const check = (label, ok, detail = "") => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
};

console.log("Contract:", address);
console.log("Explorer:", deployment.explorer);

// 1. Deployed code still matches the source file.
const { createHash } = await import("node:crypto");
const code = readFileSync(path.join(root, "contracts", "subset_cert.py"), "utf-8");
check("source SHA matches deployment.json", createHash("sha256").update(code).digest("hex") === deployment.contractSha256);
const cc = await withRetry(() => reader.request({ method: "gen_getContractCode", params: [address] }), "gen_getContractCode");
let decoded = null;
try { decoded = Buffer.from(cc, "base64").toString("utf-8"); } catch { /* ignore */ }
if (decoded !== code && cc === code) decoded = cc;
check("live deployed code matches source", decoded === code);

// 2. Cases re-read live match evidence.json.
for (const c of evidence.cases) {
  const live = await readJson("get_case", [c.id]);
  if (c.record_expected === false) {
    check(`${c.id} has no record after rejected claim`, live === "");
    continue;
  }
  check(`${c.id} verdict ${c.expected_verdict}`, live.verdict === c.expected_verdict);
  check(`${c.id} membership match evidence`, JSON.stringify(live.membership) === JSON.stringify(c.expected_membership));
  check(`${c.id} witness matches evidence`, canon(live.witness) === canon(c.expected_witness));
  check(`${c.id} state DECIDED`, live.state === "DECIDED");
  check(`${c.id} membership recompute from A and B`,
    JSON.stringify(live.membership) === JSON.stringify(recomputeMembership(live.a, live.b)));
}

// 3. Stats.
const stats = await readJson("get_stats", []);
check("stats match evidence final readback",
  JSON.stringify(stats) === JSON.stringify(evidence.finalReadbacks.stats));

// 4. Every recorded transaction is FINALIZED.
for (const tx of evidence.transactions) {
  check(`tx ${tx.label} FINALIZED`, tx.receiptStatus === "FINALIZED", tx.txHash);
}

console.log(failures === 0 ? "\nVERIFY: ALL CHECKS PASS" : `\nVERIFY: ${failures} CHECK(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
