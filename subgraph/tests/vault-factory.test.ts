import { BigInt } from "@graphprotocol/graph-ts";
import { afterEach, assert, clearStore, describe, test } from "matchstick-as/assembly/index";
import { handleVaultRegistered } from "../src/epoch-manager";
import { PROTOCOL_ID, uint256Id } from "../src/helpers";
import { handleVaultCreated } from "../src/vault-factory";
import {
  AGENT_ID,
  CURATOR,
  DAY,
  PUT_VAULT,
  T0,
  TSLA,
  TSLA_FEED,
  USDG,
  VAULT,
  mockVault,
  setupCallVault,
  vaultCreated,
  vaultRegistered,
} from "./utils";

describe("VaultFactory.VaultCreated", () => {
  afterEach(() => {
    clearStore();
  });

  test("creates the vault with its on-chain metadata and starts the StrikeVault template", () => {
    setupCallVault();
    const id = VAULT.toHexString();

    assert.entityCount("Vault", 1);
    assert.fieldEquals("Vault", id, "underlying", TSLA.toHexString());
    assert.fieldEquals("Vault", id, "isCall", "true");
    assert.fieldEquals("Vault", id, "curator", CURATOR.toHexString());
    assert.fieldEquals("Vault", id, "agent", uint256Id(AGENT_ID).toHexString());
    assert.fieldEquals("Vault", id, "agentId", "1");
    assert.fieldEquals("Vault", id, "name", "Strike TSLA Covered Call");
    assert.fieldEquals("Vault", id, "symbol", "sTSLA-CC");
    assert.fieldEquals("Vault", id, "asset", TSLA.toHexString());
    assert.fieldEquals("Vault", id, "assetDecimals", "18");
    assert.fieldEquals("Vault", id, "premiumToken", USDG.toHexString());
    assert.fieldEquals("Vault", id, "premiumDecimals", "6");
    assert.fieldEquals("Vault", id, "depositCap", "1000000000000000000000000");
    assert.fieldEquals("Vault", id, "locked", "false");
    assert.fieldEquals("Vault", id, "totalAssets", "0");
    assert.fieldEquals("Vault", id, "pricePerShare", "1");
    assert.fieldEquals("Vault", id, "createdAt", BigInt.fromI64(T0 - DAY).toString());

    assert.fieldEquals("Underlying", TSLA.toHexString(), "symbol", "TSLA");
    assert.fieldEquals("Underlying", TSLA.toHexString(), "decimals", "18");
    assert.fieldEquals("Underlying", TSLA.toHexString(), "allowed", "true");
    assert.fieldEquals("Underlying", TSLA.toHexString(), "feed", TSLA_FEED.toHexString());
    assert.fieldEquals("Underlying", TSLA.toHexString(), "maxPriceAge", "3600");

    // VaultRegistered and VaultCreated describe the same vault: counted once.
    const protocol = PROTOCOL_ID.toHexString();
    assert.fieldEquals("ProtocolStats", protocol, "vaultCount", "1");
    assert.fieldEquals("ProtocolStats", protocol, "callVaultCount", "1");
    assert.fieldEquals("ProtocolStats", protocol, "putVaultCount", "0");
    assert.fieldEquals("ProtocolStats", protocol, "perfFeeBps", "1000");
    assert.fieldEquals("ProtocolStats", protocol, "agentShareBps", "5000");

    assert.dataSourceCount("StrikeVault", 1);
    assert.dataSourceExists("StrikeVault", VAULT.toHexString());
  });

  test("a put vault holds USDG and is counted separately", () => {
    setupCallVault();
    mockVault(PUT_VAULT, USDG, 6, "Strike TSLA Cash-Secured Put", "sTSLA-CSP");
    handleVaultRegistered(vaultRegistered(PUT_VAULT, CURATOR, AGENT_ID, TSLA, false, T0));
    handleVaultCreated(vaultCreated(PUT_VAULT, CURATOR, TSLA, false, AGENT_ID, T0));

    const id = PUT_VAULT.toHexString();
    assert.fieldEquals("Vault", id, "isCall", "false");
    assert.fieldEquals("Vault", id, "asset", USDG.toHexString());
    assert.fieldEquals("Vault", id, "assetDecimals", "6");
    assert.fieldEquals("ProtocolStats", PROTOCOL_ID.toHexString(), "vaultCount", "2");
    assert.fieldEquals("ProtocolStats", PROTOCOL_ID.toHexString(), "putVaultCount", "1");
    assert.dataSourceCount("StrikeVault", 2);
  });
});
