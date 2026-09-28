// VaultFactory: starts indexing each new vault clone.
import { VaultCreated } from "../generated/VaultFactory/VaultFactory";
import { StrikeVault as StrikeVaultTemplate } from "../generated/templates";
import { getOrCreateVault } from "./helpers";

export function handleVaultCreated(event: VaultCreated): void {
  // EpochManager.VaultRegistered (same transaction, earlier log) normally created the entity already.
  getOrCreateVault(
    event.params.vault,
    event.params.curator,
    event.params.underlying,
    event.params.isCall,
    event.params.agentId,
    event,
  );
  StrikeVaultTemplate.create(event.params.vault);
}
