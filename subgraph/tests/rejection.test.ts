// A proposal outside the mandate: the agent is slashed, gets a strike, and depositors receive the bond.
import { BigInt } from "@graphprotocol/graph-ts";
import { afterEach, assert, beforeEach, clearStore, describe, test } from "matchstick-as/assembly/index";
import { handleReputationFeedback, handleSlashed, handleStatusSet } from "../src/agent-registry";
import { handleEpochAborted, handleEpochOpened, handleProposalRejected } from "../src/epoch-manager";
import { PROTOCOL_ID, epochId, eventId, uint256Id } from "../src/helpers";
import { handleDeposit, handleEpochLocked, handleVaultEpochSettled } from "../src/strike-vault";
import {
  AGENT_ID,
  ALICE,
  DAY,
  EPOCH_1,
  T0,
  VAULT,
  epochAborted,
  epochLocked,
  epochOpened,
  proposalRejected,
  reputationFeedback,
  setupAgent,
  setupCallVault,
  slashed,
  statusSet,
  usdg,
  vaultDeposit,
  vaultEpochSettled,
  wad,
} from "./utils";

const EXPIRY: i64 = T0 + 4 * DAY;
const ERC8004_ID = BigInt.fromI32(7);

describe("ProposalRejected", () => {
  beforeEach(() => {
    setupCallVault();
    setupAgent(); // 100 USDG bond; slashAmount 10 USDG, maxStrikes 3
    handleDeposit(vaultDeposit(VAULT, ALICE, wad(100), wad(100), T0 - 3600));
    handleEpochLocked(epochLocked(VAULT, EPOCH_1, T0));
    handleEpochOpened(epochOpened(VAULT, EPOCH_1, wad(250), T0));
  });

  afterEach(() => {
    clearStore();
  });

  test("records the reason, slashes the bond and credits the vault's depositors", () => {
    // proposeSeries → AgentRegistry.slash (Slashed, ERC-8004 feedback) → ProposalRejected
    handleSlashed(slashed(AGENT_ID, usdg(10), 1, T0 + 60));
    handleReputationFeedback(
      reputationFeedback(AGENT_ID, ERC8004_ID, usdg(-10), "strike.mandate.rejection", true, T0 + 60),
    );
    const event = proposalRejected(
      VAULT,
      EPOCH_1,
      AGENT_ID,
      6,
      usdg(10),
      wad(240),
      EXPIRY,
      wad(50),
      9000,
      T0 + 60,
    );
    handleProposalRejected(event);

    const id = eventId(event).toHexString();
    const agent = uint256Id(AGENT_ID).toHexString();
    const epoch = epochId(VAULT, EPOCH_1).toHexString();

    assert.entityCount("ProposalRejection", 1);
    assert.fieldEquals("ProposalRejection", id, "reason", "PremiumBelowFair");
    assert.fieldEquals("ProposalRejection", id, "reasonCode", "6");
    assert.fieldEquals("ProposalRejection", id, "slashed", usdg(10).toString());
    assert.fieldEquals("ProposalRejection", id, "vault", VAULT.toHexString());
    assert.fieldEquals("ProposalRejection", id, "epoch", epoch);
    assert.fieldEquals("ProposalRejection", id, "agent", agent);
    assert.fieldEquals("ProposalRejection", id, "strike", wad(240).toString());
    assert.fieldEquals("ProposalRejection", id, "expiry", BigInt.fromI64(EXPIRY).toString());
    assert.fieldEquals("ProposalRejection", id, "size", wad(50).toString());
    assert.fieldEquals("ProposalRejection", id, "premiumBps", "9000");

    assert.fieldEquals("Agent", agent, "bond", usdg(90).toString());
    assert.fieldEquals("Agent", agent, "strikes", "1");
    assert.fieldEquals("Agent", agent, "rejected", "1");
    assert.fieldEquals("Agent", agent, "acceptanceRate", "0");
    assert.fieldEquals("Agent", agent, "totalSlashed", usdg(10).toString());
    assert.fieldEquals("Agent", agent, "status", "Active");
    assert.fieldEquals("Agent", agent, "reputationFeedbackCount", "1");
    assert.entityCount("ReputationFeedback", 1);

    // The epoch stays open for another proposal; the slash is owed to depositors at close.
    assert.fieldEquals("Epoch", epoch, "state", "Open");
    assert.fieldEquals("Epoch", epoch, "rejectionCount", "1");
    assert.fieldEquals("Epoch", epoch, "compensation", usdg(10).toString());
    assert.fieldEquals("Vault", VAULT.toHexString(), "rejectionCount", "1");
    assert.fieldEquals("Vault", VAULT.toHexString(), "cumulativeCompensation", usdg(10).toString());

    const protocol = PROTOCOL_ID.toHexString();
    assert.fieldEquals("ProtocolStats", protocol, "rejectionCount", "1");
    assert.fieldEquals("ProtocolStats", protocol, "totalSlashed", usdg(10).toString());
    assert.fieldEquals("ProtocolStats", protocol, "totalBonded", usdg(90).toString());
  });

  test("third strike suspends the agent; aborting pays the slashed bonds to the vault", () => {
    for (let i = 1; i <= 3; i++) {
      if (i == 3) handleStatusSet(statusSet(AGENT_ID, 2, T0 + 60 * i)); // emitted before Slashed
      handleSlashed(slashed(AGENT_ID, usdg(10), i, T0 + 60 * i));
      handleProposalRejected(
        proposalRejected(
          VAULT,
          EPOCH_1,
          AGENT_ID,
          8,
          usdg(10),
          wad(251),
          EXPIRY,
          wad(50),
          10_000,
          T0 + 60 * i,
        ),
      );
    }
    const agent = uint256Id(AGENT_ID).toHexString();
    assert.fieldEquals("Agent", agent, "status", "Suspended");
    assert.fieldEquals("Agent", agent, "strikes", "3");
    assert.fieldEquals("Agent", agent, "bond", usdg(70).toString());

    // abortEpoch: the vault hook distributes the 30 USDG compensation, then EpochAborted.
    handleVaultEpochSettled(
      vaultEpochSettled(
        VAULT,
        EPOCH_1,
        BigInt.zero(),
        usdg(30),
        wad(100),
        wad(100),
        BigInt.fromString("300000000000000000000000"),
        T0 + 2 * DAY,
      ),
    );
    handleEpochAborted(epochAborted(VAULT, EPOCH_1, T0 + 2 * DAY));

    const epoch = epochId(VAULT, EPOCH_1).toHexString();
    assert.fieldEquals("Epoch", epoch, "state", "Aborted");
    assert.fieldEquals("Epoch", epoch, "aborted", "true");
    assert.fieldEquals("Epoch", epoch, "rejectionCount", "3");
    assert.fieldEquals("Epoch", epoch, "compensation", usdg(30).toString());
    assert.fieldEquals("Epoch", epoch, "premiumToDepositors", usdg(30).toString());
    assert.fieldEquals("Vault", VAULT.toHexString(), "locked", "false");
    assert.fieldEquals("ProtocolStats", PROTOCOL_ID.toHexString(), "abortedEpochCount", "1");
  });

  test("an unknown reason code is kept as Unknown", () => {
    handleSlashed(slashed(AGENT_ID, usdg(10), 1, T0 + 60));
    const event = proposalRejected(
      VAULT,
      EPOCH_1,
      AGENT_ID,
      42,
      usdg(10),
      wad(260),
      EXPIRY,
      wad(1),
      10_000,
      T0 + 60,
    );
    handleProposalRejected(event);
    assert.fieldEquals("ProposalRejection", eventId(event).toHexString(), "reason", "Unknown");
    assert.fieldEquals("ProposalRejection", eventId(event).toHexString(), "reasonCode", "42");
  });
});
