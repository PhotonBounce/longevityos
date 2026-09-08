/* probe-quota — the adversarial probe on the ONE number the owner set.
 *
 * The owner's instruction for 4.1 was plain: never use more than 120 GB of the
 * Drive, and warn before it. Everything else in this project can be argued
 * about; that cannot. So this probe attacks the gate rather than exercising
 * it: hostile ledgers, a lying remote, a Drive that disagrees with itself,
 * arithmetic that could overflow or go negative, a caller passing a bigger
 * cap, and a plan whose files each fit but whose sum does not.
 *
 * A pass here means: there is no sequence of inputs I could find that writes
 * past 120 GB, and no failure that leaves the ledger claiming bytes that are
 * not there.
 *
 * Offline by construction — the real fetch is never used.
 */
import {
  GB, CAP_BYTES, WARN_BYTES, canAccept, reconcile, newLedger, readLedger,
  ledgerTotal, ledgerCount, recordUpload, recordDelete, ledgerOwns,
  uploadPlan, packUnit, planUnits, deleteFile, redact, gb
} from "../tools/drive.mjs";

let checks = 0, failed = 0;
const ok = (cond, msg) => { checks++; if (!cond) { failed++; console.error("  ✗ " + msg); } };
const suite = (name) => console.log("── " + name + " ──");

const unit = (name, bytes) => ({ name, bytes, gz: Buffer.from("x"), sha256: name.padEnd(64, "0").slice(0, 64) });
const acceptAll = async (url) => String(url).includes("/upload/")
  ? { ok: true, status: 200, text: async () => JSON.stringify({ id: "id-" + Math.random().toString(36).slice(2, 9) }) }
  : { ok: true, status: 200, text: async () => "{}" };

/* ————— 1. the cap cannot be walked past, one byte at a time ————— */
suite("probe-quota 1 — a thousand small writes stop exactly at the wall");
{
  const ledger = newLedger();
  let refusals = 0;
  const units = [];
  /* start 119 GB in, then offer 4 GB of 8 MB files: 128 fit, the rest must not */
  for (let i = 0; i < 600; i++) units.push(unit("u" + i, 8 * 1024 * 1024));
  const run = await uploadPlan(acceptAll, "t", { units }, { ledger, driveUsedBytes: 119 * GB }, {});
  refusals = run.refused.length;
  const landed = run.uploaded.reduce((n, u) => n + u.bytes, 0);
  ok(119 * GB + landed <= CAP_BYTES, `nothing crossed the cap: ${gb(119 * GB + landed)} of ${gb(CAP_BYTES)}`);
  ok(run.uploaded.length === 128, `exactly the files that fit went up (${run.uploaded.length})`);
  ok(refusals === 1 && run.stopped !== "", "the run stops at the first refusal rather than squeezing smaller files past it");
  ok(ledgerTotal(ledger) === landed, "the ledger equals what landed, to the byte");
}

/* ————— 2. a lying ledger cannot unlock the cap ————— */
suite("probe-quota 2 — a ledger that under-reports is overruled by Drive");
{
  /* The attack: a ledger fetched from Drive is untrusted, and an emptied or
   * truncated one would say "0 bytes used" and re-open the whole 120 GB. The
   * defence is that Drive's own usage is always consulted and the LARGER wins. */
  const emptied = readLedger("{}");
  ok(ledgerTotal(emptied) === 0, "a wiped ledger really does read as zero");
  const run = await uploadPlan(acceptAll, "t", { units: [unit("big", 10 * GB)] },
    { ledger: emptied, driveUsedBytes: 118 * GB }, {});
  ok(run.uploaded.length === 0 && /limit would be exceeded/.test(run.refused[0].reason),
     "…and it still cannot write, because Drive says 118 GB are already used");
  ok(/disagree by/.test(run.warnings.join(" ")), "the disagreement is reported, not silently swallowed");
}

/* ————— 3. hostile arithmetic ————— */
suite("probe-quota 3 — numbers that are not numbers");
{
  for (const bad of [NaN, Infinity, -1, -Infinity, "10", null, undefined, {}, [], 1e308]) {
    const r = canAccept(bad, 1 * GB);
    ok(r.ok === true || r.ok === false, `canAccept survives a ${String(bad)} total`);
    ok(Number.isFinite(r.after) && r.after >= 0, `…and yields a finite, non-negative total (${r.after})`);
  }
  ok(canAccept(0, Infinity).ok === false, "an infinite write is refused");
  ok(canAccept(0, -5).ok === false, "a negative write is refused");
  ok(canAccept(0, 1e308).ok === false, "an absurd write is refused, not wrapped around");
  const huge = canAccept(Number.MAX_SAFE_INTEGER, 1);
  ok(huge.ok === false, "a total at MAX_SAFE_INTEGER cannot accept more");
}

/* ————— 4. a caller cannot raise the owner's cap by passing one ————— */
suite("probe-quota 4 — the owner's number is the ceiling, whatever a caller asks for");
{
  /* canAccept takes a cap so tests can drive it, which means a caller could
   * hand it a bigger one. What must hold is that the SHIPPED default is the
   * owner's number and that uploadPlan's default is the same. */
  ok(CAP_BYTES === 120 * GB && WARN_BYTES === 100 * GB, "the shipped constants are 120 GB and 100 GB");
  const run = await uploadPlan(acceptAll, "t", { units: [unit("u", 10 * GB)] },
    { ledger: newLedger(), driveUsedBytes: 115 * GB }, {});   // no cap passed
  ok(run.uploaded.length === 0, "with no cap argument, the owner's 120 GB is what refuses the write");
  ok(/120\.00 GB/.test(run.refused[0].reason), "…and the refusal quotes that number back");
}

/* ————— 5. a failing remote never leaves the ledger lying ————— */
suite("probe-quota 5 — the ledger never claims bytes that did not land");
{
  const flaky = (() => {
    let n = 0;
    return async (url) => {
      if (!String(url).includes("/upload/")) return { ok: true, status: 200, text: async () => "{}" };
      n++;
      if (n % 2 === 0) return { ok: false, status: 500, text: async () => "upstream boom" };
      return { ok: true, status: 200, text: async () => JSON.stringify({ id: "id" + n }) };
    };
  })();
  const ledger = newLedger();
  const units = [];
  for (let i = 0; i < 10; i++) units.push(unit("f" + i, 1 * GB));
  const run = await uploadPlan(flaky, "t", { units }, { ledger, driveUsedBytes: 0 }, {});
  ok(run.uploaded.length === 5 && run.refused.length === 5, `half landed, half were refused (${run.uploaded.length}/${run.refused.length})`);
  ok(ledgerTotal(ledger) === 5 * GB, `the ledger holds only what landed (${gb(ledgerTotal(ledger))})`);
  ok(ledgerCount(ledger) === 5, "…and one entry per landed file");
  ok(run.refused.every((r) => /HTTP 500/.test(r.reason)), "each failure carries the status");
  /* a failed upload must not stop the run — only the cap does that */
  ok(run.stopped === "", "a remote failure is skipped, not treated as the wall");
}

/* ————— 6. nothing deletes a stranger's file ————— */
suite("probe-quota 6 — the owner's own Drive is not ours to tidy");
{
  const ledger = newLedger();
  recordUpload(ledger, "ours", { name: "u", bytes: 10, sha256: "a".repeat(64), at: 1 });
  ok(ledgerOwns(ledger, "ours") === true && ledgerOwns(ledger, "theirs") === false, "the ledger knows what it owns");
  const landmine = () => { throw new Error("a delete must be refused BEFORE any request"); };
  const r = await deleteFile(landmine, "t", "theirs", ledger);
  ok(r.ok === false && /does not own it/.test(r.reason), "deleting an unknown id never even reaches the network");
  ok(recordDelete(ledger, "theirs").ok === false, "…and the ledger refuses to forget it either");
  for (const id of ["__proto__", "constructor", "", null, undefined, 0]) {
    ok(ledgerOwns(ledger, id) === false, `a ${String(id)} id is not owned`);
  }
}

/* ————— 7. a plan whose files each fit but whose sum does not ————— */
suite("probe-quota 7 — the sum is what matters, not the file");
{
  const units = [unit("a", 50 * GB), unit("b", 50 * GB), unit("c", 50 * GB)];
  ok(units.every((u) => canAccept(0, u.bytes).ok === true), "every one of these files fits on its own");
  const run = await uploadPlan(acceptAll, "t", { units }, { ledger: newLedger(), driveUsedBytes: 0 }, {});
  ok(run.uploaded.length === 2 && run.refused.length === 1, "…but only two of the three are written");
  ok(run.total_after === 100 * GB && run.headroom_bytes === 20 * GB, `the report is exact (${gb(run.total_after)} used, ${gb(run.headroom_bytes)} left)`);
  ok(/APPROACHING THE LIMIT/.test(run.warnings.join(" ")), "and crossing 100 GB raised the warning the owner asked for");
}

/* ————— 8. packing cannot be tricked into unbounded bytes ————— */
suite("probe-quota 8 — hostile molecules");
{
  const nasty = [
    { cid: "1", smiles: "C".repeat(100000) },
    { cid: "2".repeat(50), smiles: "CC" },
    { cid: "3", smiles: null }, { cid: null, smiles: "CC" },
    { get cid() { throw new Error("accessor"); }, smiles: "CC" },
    "not an object", null, undefined, 42
  ];
  let packed = null;
  try { packed = packUnit(nasty); } catch (e) { packed = null; }
  ok(packed !== null, "packUnit survives hostile rows without throwing");
  ok(packed !== null && packed.rows === 0, `every hostile row is dropped (${packed ? packed.rows : "threw"} kept)`);
  const long = planUnits([{ cid: "9", smiles: "C".repeat(399) }], 500);
  ok(long.units.length === 1 && long.units[0].bytes < 2 * 1024 * 1024, "a legal but long SMILES still packs small");
  ok(planUnits(null).units.length === 0 && planUnits(undefined).total_rows === 0, "a non-list plan is empty, not a throw");
}

/* ————— 9. no credential can survive a printed error ————— */
suite("probe-quota 9 — nothing token-shaped is ever printed");
{
  const secrets = [
    "ya29.a0AfB_" + "x".repeat(80),
    "1//0g" + "y".repeat(60),
    "GOCSPX-" + "z".repeat(40),
    "z".repeat(120)
  ];
  for (const s of secrets) {
    const out = redact('{"error":{"message":"bad ' + s + '"}}');
    ok(!out.includes(s), "a token-shaped string is redacted from a printed body (" + s.slice(0, 10) + "…)");
  }
  ok(redact("x".repeat(4000)).length <= 244, "a huge body is capped");
  ok(redact("") === "" && redact(null) === "" && redact(undefined) === "", "no body, nothing printed");
  const angry = async () => ({ ok: false, status: 401, text: async () => '{"error":"invalid_token","token":"ya29.' + "q".repeat(70) + '"}' });
  const run = await uploadPlan(angry, "t", { units: [unit("u", 1)] }, { ledger: newLedger(), driveUsedBytes: 0 }, {});
  ok(!/ya29\.q/.test(JSON.stringify(run)), "…and nothing token-shaped survives into the run report");
}

console.log(failed ? `probe-quota: ${failed} FAILED of ${checks}` : `probe-quota: ${checks} checks passed ✓`);
process.exit(failed ? 1 : 0);
