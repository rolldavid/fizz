import { describe, expect, it } from "vitest";
import { Fr } from "@aztec/foundation/curves/bn254";
import { nullifierWitnessProvesPresence } from "../../src/lib/aztec/autoClaim";

// BRIDGE-39 / TRUST-01 — the false-consume gate. markBridgeConsumed is
// irreversible for an entry, so the nullifier sweep must consume a funded claim
// ONLY on authenticated evidence and must FAIL SAFE (leave the claim pending)
// in every ambiguous case. This pins the exact-equality decision so a future
// refactor can't silently revert to the old bare findLeavesIndexes("latest", …)
// index — which a node could forge outright — or drop the leaf check.
//
// Note on the residual it does NOT close: the sweep hands the node the target
// nullifier in the query, so a malicious node CAN echo it back in a forged leaf
// (the Merkle sibling-path is not verified to a trusted root — a documented
// residual). The defense-in-depth for that is the L1-event re-adoption recovery
// (covered by bridgeInvariants.test.ts "wrongly-CONSUMED claim can be
// re-adopted"). What THIS test guarantees is that nothing ambiguous, absent, or
// mismatched ever flips a claim to consumed.

const nullifier = new Fr(0x1234abcdn);
const matchingWitness = { leafPreimage: { leaf: { nullifier: new Fr(0x1234abcdn) } } };
const differentLeafWitness = { leafPreimage: { leaf: { nullifier: new Fr(0x9999n) } } };

describe("nullifierWitnessProvesPresence — the consume gate (BRIDGE-39/TRUST-01)", () => {
    it("CONSUMES only when the witness leaf nullifier exactly equals ours", () => {
        expect(nullifierWitnessProvesPresence(matchingWitness, nullifier)).toBe(true);
    });

    it("stays PENDING when the node returns nothing (absent ⇒ unspent)", () => {
        expect(nullifierWitnessProvesPresence(undefined, nullifier)).toBe(false);
        expect(nullifierWitnessProvesPresence(null, nullifier)).toBe(false);
    });

    it("stays PENDING for a witness missing the leaf preimage / leaf / nullifier", () => {
        expect(nullifierWitnessProvesPresence({}, nullifier)).toBe(false);
        expect(nullifierWitnessProvesPresence({ leafPreimage: {} }, nullifier)).toBe(false);
        expect(nullifierWitnessProvesPresence({ leafPreimage: { leaf: {} } }, nullifier)).toBe(false);
        expect(
            nullifierWitnessProvesPresence({ leafPreimage: { leaf: { nullifier: undefined } } }, nullifier),
        ).toBe(false);
    });

    it("REJECTS a non-membership / low-leaf witness whose nullifier differs from ours", () => {
        // This is the case an honest node returns for an UNSPENT claim (a witness
        // for the nearest existing leaf, not ours). It must never consume.
        expect(nullifierWitnessProvesPresence(differentLeafWitness, nullifier)).toBe(false);
    });
});
