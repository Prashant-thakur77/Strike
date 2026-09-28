import { BigInt } from "@graphprotocol/graph-ts";
import { afterEach, assert, clearStore, describe, test } from "matchstick-as/assembly/index";
import {
  handleAgentRegistered,
  handleBondPosted,
  handlePayoutSet,
  handleSignerSet,
  handleSlashed,
  handleStatusSet,
  handleUnbondRequested,
  handleUnbonded,
} from "../src/agent-registry";
import { PROTOCOL_ID, uint256Id } from "../src/helpers";
import {
  AGENT_ID,
  AGENT_OWNER,
  AGENT_PAYOUT,
  AGENT_SIGNER,
  ALICE,
  BOB,
  DAY,
  T0,
  agentRegistered,
  bondPosted,
  mockPayoutOf,
  payoutSet,
  signerSet,
  slashed,
  statusSet,
  unbondRequested,
  unbonded,
  usdg,
} from "./utils";

describe("AgentRegistry", () => {
  afterEach(() => {
    clearStore();
  });

  test("registration reads the payout address and links the ERC-8004 identity", () => {
    mockPayoutOf(AGENT_ID, AGENT_PAYOUT);
    handleAgentRegistered(agentRegistered(AGENT_ID, AGENT_OWNER, AGENT_SIGNER, BigInt.fromI32(7), T0));

    const id = uint256Id(AGENT_ID).toHexString();
    assert.assertTrue(id == "0x0000000000000000000000000000000000000000000000000000000000000001");
    assert.fieldEquals("Agent", id, "agentId", "1");
    assert.fieldEquals("Agent", id, "owner", AGENT_OWNER.toHexString());
    assert.fieldEquals("Agent", id, "signer", AGENT_SIGNER.toHexString());
    assert.fieldEquals("Agent", id, "payout", AGENT_PAYOUT.toHexString());
    assert.fieldEquals("Agent", id, "erc8004Id", "7");
    assert.fieldEquals("Agent", id, "status", "Active");
    assert.fieldEquals("Agent", id, "bond", "0");
    assert.fieldEquals("Agent", id, "strikes", "0");
    assert.fieldEquals("Agent", id, "registeredAt", BigInt.fromI64(T0).toString());
    assert.fieldEquals("ProtocolStats", PROTOCOL_ID.toHexString(), "agentCount", "1");

    // setIdentity re-emits AgentRegistered: update, don't double count.
    handleAgentRegistered(agentRegistered(AGENT_ID, AGENT_OWNER, AGENT_SIGNER, BigInt.fromI32(9), T0 + 60));
    assert.fieldEquals("Agent", id, "erc8004Id", "9");
    assert.entityCount("Agent", 1);
    assert.fieldEquals("ProtocolStats", PROTOCOL_ID.toHexString(), "agentCount", "1");

    handleSignerSet(signerSet(AGENT_ID, ALICE, T0 + 120));
    handlePayoutSet(payoutSet(AGENT_ID, BOB, T0 + 120));
    assert.fieldEquals("Agent", id, "signer", ALICE.toHexString());
    assert.fieldEquals("Agent", id, "payout", BOB.toHexString());
  });

  test("bond, unbonding and slashing follow AgentRegistry's accounting", () => {
    mockPayoutOf(AGENT_ID, AGENT_PAYOUT);
    handleAgentRegistered(agentRegistered(AGENT_ID, AGENT_OWNER, AGENT_SIGNER, BigInt.zero(), T0));
    const id = uint256Id(AGENT_ID).toHexString();
    const protocol = PROTOCOL_ID.toHexString();

    handleBondPosted(bondPosted(AGENT_ID, AGENT_OWNER, usdg(100), T0));
    handleUnbondRequested(unbondRequested(AGENT_ID, usdg(40), T0 + 14 * DAY, T0 + 60));
    assert.fieldEquals("Agent", id, "bond", usdg(60).toString());
    assert.fieldEquals("Agent", id, "unbonding", usdg(40).toString());
    assert.fieldEquals("Agent", id, "unbondAt", BigInt.fromI64(T0 + 14 * DAY).toString());

    // Slash takes the bond first...
    handleSlashed(slashed(AGENT_ID, usdg(50), 1, T0 + 120));
    assert.fieldEquals("Agent", id, "bond", usdg(10).toString());
    assert.fieldEquals("Agent", id, "unbonding", usdg(40).toString());
    // ...then the unbonding queue.
    handleSlashed(slashed(AGENT_ID, usdg(30), 2, T0 + 180));
    assert.fieldEquals("Agent", id, "bond", "0");
    assert.fieldEquals("Agent", id, "unbonding", usdg(20).toString());
    assert.fieldEquals("Agent", id, "strikes", "2");
    assert.fieldEquals("Agent", id, "rejected", "2");
    assert.fieldEquals("Agent", id, "totalSlashed", usdg(80).toString());

    handleUnbonded(unbonded(AGENT_ID, AGENT_OWNER, usdg(20), T0 + 15 * DAY));
    assert.fieldEquals("Agent", id, "unbonding", "0");
    assert.fieldEquals("ProtocolStats", protocol, "totalBonded", "0");
    assert.fieldEquals("ProtocolStats", protocol, "totalSlashed", usdg(80).toString());

    // Admin reinstatement clears strikes; retiring is terminal.
    handleStatusSet(statusSet(AGENT_ID, 1, T0 + 16 * DAY));
    assert.fieldEquals("Agent", id, "strikes", "0");
    handleStatusSet(statusSet(AGENT_ID, 3, T0 + 17 * DAY));
    assert.fieldEquals("Agent", id, "status", "Retired");
  });
});
