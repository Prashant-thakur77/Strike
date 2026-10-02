#!/usr/bin/env python3
"""Mutation check for the adversarial suite (docs/security/adversarial.md).

Copies contracts/ to a scratch directory, injects one bug at a time into the copy's src/, and runs the adversarial test
that should catch it. A mutant counts as caught when that test fails. The repository's own files are never modified.

Usage (from the repository root, Foundry on PATH):
    python3 scripts/adversarial-mutation.py                     # this checkout (main: the v2 sources)
    python3 scripts/adversarial-mutation.py ../strike-v3/contracts   # a v3-contracts worktree

Only mutants whose code and target test exist in the given tree are run, so the same script serves both branches.
Exit code 1 if any mutant is missed or a mutant does not compile.
"""
import os
import shutil
import subprocess
import sys

# (id, description, file under src/, code to replace, replacement, test that must fail)
MUTANTS = [
    ("M1", "proposals judged at the live spot", "core/EpochManager.sol",
     "p.spot = open ? ep.openSpot : _spot(token);", "p.spot = _spot(token);",
     "test_ADV_CHEAT_proposalJudgedAgainstOpenSnapshot"),
    ("M2", "no intrinsic floor on buys", "core/EpochManager.sol",
     "uint256 perOption = Math.max(fair * s.premiumBps / BPS, intrinsic);",
     "uint256 perOption = fair * s.premiumBps / BPS;",
     "test_ADV_CHEAT_noSaleBelowIntrinsicOrPremiumFloor"),
    ("M3", "sales until expiry (no cutoff)", "core/EpochManager.sol",
     "if (block.timestamp + saleCutoff >= s.expiry) revert SaleClosed(s.expiry);",
     "if (block.timestamp > s.expiry) revert SaleClosed(s.expiry);",
     "test_ADV_CHEAT_buyerBuysAfterSaleCutoff"),
    ("M4", "no size cap per series", "core/EpochManager.sol",
     "if (s.sold + amount > s.size) revert ExceedsSize(amount, s.size - s.sold);", "",
     "test_ADV_CHEAT_buyerBuysAboveSize"),
    ("M5", "any signer may propose", "core/EpochManager.sol",
     "if (msg.sender != agents.signerOf(v.agentId)) revert NotAgent(msg.sender);\n        if (!agents.isActive",
     "if (!agents.isActive",
     "test_ADV_CHEAT_agentProposesForVaultItDoesNotRun"),
    ("M6", "compensation not cleared once paid", "core/EpochManager.sol",
     "if (amount != 0) compensation[vault] = 0;", "",
     "test_ADV_DOUBLESPEND_slashSameRejectionTwice"),
    ("M7", "settlement round's predecessor not checked", "libraries/SafeStockFeed.sol",
     "if (prevUpdatedAt >= target) revert InvalidSettlementRound(roundId);", "prevUpdatedAt;",
     "test_ADV_CHEAT_adminCannotSettleOffTheFirstRound"),
    ("M8", "recorded settlement price not final", "oracle/StockOracle.sol",
     "if (priceWad != 0) return priceWad;", "",
     "test_ADV_REPLAY_settleTwice"),
    ("M9", "zero, negative or future-dated price accepted", "libraries/SafeStockFeed.sol",
     "if (answer <= 0 || updatedAt > block.timestamp) revert InvalidPrice(answer);\n"
     "        if (block.timestamp - updatedAt",
     "if (block.timestamp < updatedAt) return (toWad(answer, c.feedDecimals), updatedAt);\n"
     "        if (block.timestamp - updatedAt",
     "test_ADV_CHEAT_maliciousOracleAnswerBlocksSales"),
    ("M10", "no staleness check", "libraries/SafeStockFeed.sol",
     "if (block.timestamp - updatedAt > c.maxPriceAge) revert StalePrice(updatedAt, c.maxPriceAge);", "",
     "test_ADV_OFFLINE_keeperStopsFeedGoesStale"),
    ("M11", "no sequencer check on live prices", "oracle/StockOracle.sol",
     "SafeStockFeed.checkSequencer(sequencerFeed, sequencerGrace);\n        return _config(token).latest(token);",
     "return _config(token).latest(token);",
     "test_ADV_OFFLINE_sequencerDown"),
    ("M12", "settlement ignores the oracle pause", "libraries/SafeStockFeed.sol",
     "if (_flag(token, IStockToken.oraclePaused.selector)) revert FeedPaused(token);\n"
     "        int256 answer;\n        uint256 i;",
     "int256 answer;\n        uint256 i;",
     "test_ADV_OFFLINE_tokenOrOraclePausedAtExpiry"),
    ("M13", "queued deposits share the epoch's premium", "vaults/StrikeVault.sol",
     "uint256 perShare = _distributePremium(premium);", "uint256 perShare = _deferPremium(premium);",
     "test_ADV_DOUBLESPEND_depositAroundSettlementCapturesNoPremium"),
    ("M14", "faucet without cooldown", "testnet/UsdgDrip.sol",
     "if (block.timestamp < next) revert TooSoon(next);", "next;",
     "test_ADV_DOUBLESPEND_faucetDripTwiceIn24h"),
    ("M15", "premium checkpoint skipped for the receiver of shares", "vaults/StrikeVault.sol",
     "if (to != address(0) && to != address(this) && to != from) _checkpoint(to);", "",
     "test_ADV_DOUBLESPEND_claimPremiumTwice"),
    ("M16", "ERC-8056 multiplier applied to the feed price", "libraries/SafeStockFeed.sol",
     "priceWad = toWad(answer, c.feedDecimals);\n    }\n\n    /// @notice Non-reverting",
     "priceWad = toWad(answer, c.feedDecimals);\n"
     "        (bool okM, uint256 m) = _uint(token, IStockToken.uiMultiplier.selector);\n"
     "        if (okM && m != 0) priceWad = priceWad * m / 1e18;\n    }\n\n    /// @notice Non-reverting",
     "test_ADV_CHEAT_multiplierNeverAppliedTwice"),
    # v3-contracts only
    ("V1", "consent nonce not consumed", "agents/AgentRegistry.sol",
     "keccak256(abi.encode(SET_SIGNER_TYPEHASH, msg.sender, agentId, _useNonce(signer), deadline));",
     "keccak256(abi.encode(SET_SIGNER_TYPEHASH, msg.sender, agentId, nonces(signer), deadline));",
     "test_ADV_REPLAY_usedConsentCannotBringOldKeyBack"),
    ("V2", "openEpoch without the active-agent rule", "core/EpochManager.sol",
     "!hasRole(KEEPER_ROLE, msg.sender)) revert NotAgent(msg.sender);\n"
     "        if (!agents.isActive(v.agentId)) revert AgentNotActive(v.agentId);",
     "!hasRole(KEEPER_ROLE, msg.sender)) revert NotAgent(msg.sender);",
     "test_ADV_CHEAT_agentDeactivatesAfterOpening"),
    ("V3", "chargeFee open to anyone", "core/FeeManager.sol",
     "external\n        onlyRole(DEPOSITOR_ROLE)\n        returns (uint256 fee, uint256 agentCut)\n    {\n"
     "        uint256 carried",
     "external\n        returns (uint256 fee, uint256 agentCut)\n    {\n        uint256 carried",
     "test_ADV_DOUBLESPEND_feeChargedOnceAboveHighWaterMark"),
    ("V4", "fee high-water mark ignored", "core/FeeManager.sol",
     "if (net <= carried) return (0, 0, carried - net);\n        net -= carried;", "",
     "test_ADV_DOUBLESPEND_feeChargedOnceAboveHighWaterMark"),
    ("V5", "RiskLens prices settled series", "core/RiskLens.sol",
     "if (s.settled || s.cancelled) {", "if (false) {",
     "test_ADV_OFFLINE_riskLensRefusesUnsafeFeed"),
    ("V6", "RiskLens bypasses SafeStockFeed", "core/RiskLens.sol",
     "return _risk(s, manager.spot(s.underlying), sigma, defaultShocks());",
     "(,,, uint128 openSpot,) = manager.epochs(s.vault);\n"
     "        return _risk(s, openSpot == 0 ? s.strike : openSpot, sigma, defaultShocks());",
     "test_ADV_OFFLINE_riskLensRefusesUnsafeFeed"),
    ("V7", "risk call before the verdict (rejections revert too)", "core/EpochManager.sol",
     "        if (reason != MandateGuard.Reason.None) {\n            _reject(",
     "        pricer.greeks(p.spot, p.strike, 1 days, ep.openSigma, p.isCall);\n"
     "        if (reason != MandateGuard.Reason.None) {\n            _reject(",
     "test_ADV_OFFLINE_riskEngineReverts"),
]

# M13 defers the premium until the queue has been processed, so newly minted deposit shares share it.
M13_EXTRA = [
    ("    /// @return perShare Accumulator increase.",
     "    uint256 internal _deferred;\n\n"
     "    function _deferPremium(uint256 amount) internal returns (uint256) {\n"
     "        _deferred = amount;\n        return 0;\n    }\n\n"
     "    /// @return perShare Accumulator increase."),
    ("        lastProcessedEpoch = epoch;",
     "        if (_deferred != 0) {\n            uint256 d = _deferred;\n            _deferred = 0;\n"
     "            uint256 ps = _distributePremium(d);\n"
     "            epochSnapshots[epoch].premiumPerShare = ps;\n"
     "            epochSnapshots[epoch].accPremium = accPremiumPerShare - ps;\n        }\n"
     "        lastProcessedEpoch = epoch;"),
]


def main():
    repo = subprocess.run(["git", "rev-parse", "--show-toplevel"], capture_output=True, text=True).stdout.strip()
    source = os.path.abspath(sys.argv[1]) if len(sys.argv) > 1 else os.path.join(repo, "contracts")
    cache = os.environ.get("XDG_CACHE_HOME", os.path.expanduser("~/.cache"))
    scratch = os.path.join(cache, "strike-adversarial-mutation")
    shutil.rmtree(scratch, ignore_errors=True)
    shutil.copytree(source, scratch, symlinks=True, ignore=shutil.ignore_patterns(
        "out", "out-*", "cache", "cache-*", "broadcast", "lib"))
    os.symlink(os.path.join(source, "lib"), os.path.join(scratch, "lib"))
    env = dict(os.environ, FOUNDRY_OUT=os.path.join(scratch, "out"),
               FOUNDRY_CACHE_PATH=os.path.join(scratch, "cache"))
    tests = ""
    for root, _, files in os.walk(os.path.join(scratch, "test", "adversarial")):
        for f in files:
            tests += open(os.path.join(root, f)).read()

    def run(match):
        r = subprocess.run(["forge", "test", "--root", scratch, "--match-test", match], capture_output=True,
                           text=True, env=env)
        return r.returncode, r.stdout + r.stderr

    code, out = run("test_ADV_")
    if code != 0:
        print("The adversarial suite fails on the unmutated copy:\n" + out[-3000:])
        sys.exit(1)
    print(f"{source}: the adversarial suite passes unmutated")
    ran, caught = 0, 0
    for mid, desc, rel, old, new, test in MUTANTS:
        path = os.path.join(scratch, "src", rel)
        if not os.path.exists(path) or f"function {test}(" not in tests:
            continue
        original = open(path).read()
        if original.count(old) != 1:
            continue
        mutated = original.replace(old, new)
        if mid == "M13":
            for anchor, replacement in M13_EXTRA:
                mutated = mutated.replace(anchor, replacement)
        open(path, "w").write(mutated)
        try:
            code, out = run(test)
        finally:
            open(path, "w").write(original)
        ran += 1
        if "Compiler run failed" in out:
            verdict = "DOES NOT COMPILE"
        elif code != 0:
            verdict, caught = "caught", caught + 1
        else:
            verdict = "MISSED"
        print(f"{mid:4} {desc}: {verdict} by {test}")
    print(f"\n{caught} of {ran} injected bugs caught")
    sys.exit(0 if caught == ran and ran else 1)


if __name__ == "__main__":
    main()
