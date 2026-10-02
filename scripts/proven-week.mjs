#!/usr/bin/env node
// One proven week as a machine-readable record: every step of a deployment's weekly epoch, read from the chain
// (read-only, no key) with its transaction, block, time and amounts, written to
// docs/evidence/<chainId>-<version>-<expiry date>.json.
//
//   node scripts/proven-week.mjs --expiry 2026-10-02             every deployment in strike.config.json
//   node scripts/proven-week.mjs --expiry 2026-10-02 --deployment contracts/deployments/46630-v3.json
//   node scripts/proven-week.mjs --expiry 2026-10-02 --check     exit 1 if a committed record differs from the chain
//   node scripts/proven-week.mjs --expiry 2026-10-02 --stdout    print instead of writing
//
// A week is the epoch of each vault whose proposals expire on that date (UTC). The steps, in order: deposit, open,
// proposal (with each decision record's hash and anchor transaction), rejection and slash, accept, buys, settlement
// (price and round, or the abort that paid a slash to the vault), redemptions and claims. A step that has not happened
// yet is "pending"; one that will not happen this week is "none". Keys are sorted and lists are in chain order, so an
// unchanged chain gives an unchanged file. RPC: the chain's public RPC in strike.config.json, or STRIKE_RPC_<chainId>.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  CONFIG,
  ROOT,
  decodeLog,
  encodeCall,
  formatUnits,
  parseEvent,
  rpcClient,
  rpcUrl,
  words,
} from "./lib/evm.mjs";

// ------------------------------------------------------------------------------------------------ arguments

const argv = process.argv.slice(2);
const opt = (name) => (argv.includes(name) ? argv[argv.indexOf(name) + 1] : undefined);
const EXPIRY_DATE = opt("--expiry");
if (!EXPIRY_DATE || !/^\d{4}-\d{2}-\d{2}$/.test(EXPIRY_DATE)) {
  console.error(
    "usage: node scripts/proven-week.mjs --expiry YYYY-MM-DD [--deployment contracts/deployments/<file>.json] [--check | --stdout]",
  );
  process.exit(2);
}
const CHECK = argv.includes("--check");
const STDOUT = argv.includes("--stdout");
const OUT_DIR = join(ROOT, "docs/evidence");

const deployments = opt("--deployment")
  ? [opt("--deployment")]
  : Object.values(CONFIG.chains)
      .filter((c) => !c.local)
      .flatMap((c) => c.deployments);

// ------------------------------------------------------------------------------------------------ events

const E = Object.fromEntries(
  Object.entries({
    VaultRegistered:
      "VaultRegistered(address indexed vault, address indexed curator, uint256 indexed agentId, address underlying, bool isCall)",
    EpochOpened: "EpochOpened(address indexed vault, uint64 indexed epoch, uint256 spot)",
    SeriesProposed:
      "SeriesProposed(address indexed vault, uint64 indexed epoch, uint256 indexed seriesId, uint256 strike, uint64 expiry, uint256 size, uint16 premiumBps, uint256 fairValue, int256 delta)",
    SeriesRisk:
      "SeriesRisk(uint256 indexed seriesId, int256 delta, uint256 gamma, uint256 vega, int256 theta)",
    ProposalRejected:
      "ProposalRejected(address indexed vault, uint64 indexed epoch, uint256 indexed agentId, uint8 reason, uint256 slashed, uint256 strike, uint64 expiry, uint256 size, uint16 premiumBps)",
    OptionsBought:
      "OptionsBought(uint256 indexed seriesId, address indexed buyer, address indexed recipient, uint256 amount, uint256 premium)",
    EpochSettled:
      "EpochSettled(address indexed vault, uint64 indexed epoch, uint256 indexed seriesId, uint256 settlementPrice, uint256 payout, uint256 premium, uint256 fee)",
    EpochAborted: "EpochAborted(address indexed vault, uint64 indexed epoch)",
    SeriesCancelled: "SeriesCancelled(address indexed vault, uint64 indexed epoch, uint256 indexed seriesId)",
    OptionsRedeemed:
      "OptionsRedeemed(uint256 indexed seriesId, address indexed holder, address indexed recipient, uint256 amount, uint256 paid)",
    SettlementPriceRecorded:
      "SettlementPriceRecorded(address indexed token, uint64 indexed expiry, uint80 roundId, uint256 price)",
    Slashed: "Slashed(uint256 indexed agentId, address indexed recipient, uint256 amount, uint32 strikes)",
    ReputationFeedback:
      "ReputationFeedback(uint256 indexed agentId, uint256 indexed erc8004Id, int128 value, string tag, bool posted)",
    DecisionRecorded:
      "DecisionRecorded(uint256 indexed agentId, address indexed vault, uint64 indexed epoch, bytes32 recordHash, string uri, uint256 timestamp)",
    Deposit: "Deposit(address indexed sender, address indexed owner, uint256 assets, uint256 shares)",
    Withdraw:
      "Withdraw(address indexed sender, address indexed receiver, address indexed owner, uint256 assets, uint256 shares)",
    PremiumClaimed: "PremiumClaimed(address indexed account, uint256 amount)",
    DepositRequested: "DepositRequested(address indexed account, uint64 indexed epoch, uint256 assets)",
    DepositClaimed:
      "DepositClaimed(address indexed account, uint64 indexed epoch, uint256 assets, uint256 shares)",
    RedeemRequested: "RedeemRequested(address indexed account, uint64 indexed epoch, uint256 shares)",
    RedeemClaimed:
      "RedeemClaimed(address indexed account, uint64 indexed epoch, uint256 shares, uint256 assets)",
    VaultEpochSettled:
      "EpochSettled(uint64 indexed epoch, uint256 payout, uint256 premium, uint256 assets, uint256 supply, uint256 accPremium)",
    Transfer: "Transfer(address indexed from, address indexed to, uint256 value)",
  }).map(([k, v]) => [k, parseEvent(v)]),
);
const REASONS = [
  "None",
  "ZeroSize",
  "TenorOutOfRange",
  "InvalidExpiry",
  "StrikeWrongSide",
  "SizeTooLarge",
  "PremiumBelowFair",
  "PremiumAboveCap",
  "DeltaOutOfBand",
  "PremiumTooSmall",
];

const topicOf = (v) => `0x${BigInt(v).toString(16).padStart(64, "0")}`;
const addrTopic = (a) => `0x${a.toLowerCase().replace(/^0x/, "").padStart(64, "0")}`;
const lc = (a) => a.toLowerCase();
const WAD = 18;
const USDG = 6;
const iso = (ts) => new Date(Number(ts) * 1000).toISOString().replace(".000Z", "Z");

// ------------------------------------------------------------------------------------------------ chain reads

function decodeString(hex) {
  const data = hex.replace(/^0x/, "");
  if (data.length < 128) return "";
  const len = Number(BigInt(`0x${data.slice(64, 128)}`));
  return Buffer.from(data.slice(128, 128 + len * 2), "hex").toString("utf8");
}

function reader(chainId) {
  const c = rpcClient(rpcUrl(chainId));
  const blocks = new Map();
  const receipts = new Map();
  return {
    c,
    async time(block) {
      if (!blocks.has(block))
        blocks.set(
          block,
          c.block(block).then((b) => Number(BigInt(b.timestamp))),
        );
      return blocks.get(block);
    },
    async receipt(hash) {
      if (!receipts.has(hash)) receipts.set(hash, c.receipt(hash));
      return receipts.get(hash);
    },
    /** getLogs over [from, to], halving the range when the RPC refuses it. */
    async logs(address, topics, from, to) {
      try {
        return await c.logs({
          address,
          topics,
          fromBlock: `0x${from.toString(16)}`,
          toBlock: `0x${to.toString(16)}`,
        });
      } catch (e) {
        if (to - from < 1000) throw e;
        const mid = from + Math.floor((to - from) / 2);
        return [
          ...(await this.logs(address, topics, from, mid)),
          ...(await this.logs(address, topics, mid + 1, to)),
        ];
      }
    },
    async callString(to, sig) {
      return decodeString(await c.ethCall(to, encodeCall(sig)));
    },
    async callUint(to, sig, args = []) {
      return words(await c.ethCall(to, encodeCall(sig, args)))[0];
    },
    async callAddress(to, sig) {
      return `0x${(await c.ethCall(to, encodeCall(sig))).slice(-40)}`;
    },
  };
}

/** Decodes raw logs with the first matching event of `events`; adds tx, block and log index. */
function decodeAll(logs, events) {
  const out = [];
  for (const l of logs) {
    for (const name of events) {
      const args = decodeLog(E[name], l);
      if (args) {
        out.push({
          name,
          args,
          tx: l.transactionHash,
          block: Number(BigInt(l.blockNumber)),
          logIndex: Number(BigInt(l.logIndex)),
          address: lc(l.address),
        });
        break;
      }
    }
  }
  return out.sort((a, b) => a.block - b.block || a.logIndex - b.logIndex);
}

// ------------------------------------------------------------------------------------------------ the record

async function week(deploymentPath) {
  const dep = JSON.parse(readFileSync(join(ROOT, deploymentPath), "utf8"));
  const chainId = dep.chainId;
  const chain = CONFIG.chains[String(chainId)];
  const r = reader(chainId);
  const latest = await r.c.blockNumber();
  const now = await r.time(latest);
  const from = dep.block;
  const em = lc(dep.epochManager);
  const at = async (ev) => ({ tx: ev.tx, block: ev.block, time: iso(await r.time(ev.block)) });

  const registered = decodeAll(await r.logs(em, [E.VaultRegistered.topic0], from, latest), [
    "VaultRegistered",
  ]);
  const vaults = [];
  let expiryTs = null;

  for (const reg of registered) {
    const vault = lc(reg.args.vault);
    const emLogs = decodeAll(await r.logs(em, [null, addrTopic(vault)], from, latest), [
      "EpochOpened",
      "SeriesProposed",
      "ProposalRejected",
      "EpochSettled",
      "EpochAborted",
      "SeriesCancelled",
    ]);
    const proposals = emLogs.filter(
      (x) =>
        (x.name === "SeriesProposed" || x.name === "ProposalRejected") &&
        iso(x.args.expiry).slice(0, 10) === EXPIRY_DATE,
    );
    if (!proposals.length) continue;
    expiryTs ??= Number(proposals[0].args.expiry);
    const epoch = proposals.at(-1).args.epoch;
    const ofEpoch = (name, e = epoch) => emLogs.filter((x) => x.name === name && x.args.epoch === e);

    // Vault and token metadata.
    const asset = lc(await r.callAddress(vault, "asset()"));
    const assetDecimals = Number(await r.callUint(asset, "decimals()"));
    const assetSymbol = await r.callString(asset, "symbol()");
    const underlyingSymbol = await r.callString(reg.args.underlying, "symbol()");
    const shareDecimals = Number(await r.callUint(vault, "decimals()"));
    const vaultLogs = decodeAll(await r.logs(vault, [], from, latest), [
      "Deposit",
      "Withdraw",
      "PremiumClaimed",
      "DepositRequested",
      "DepositClaimed",
      "RedeemRequested",
      "RedeemClaimed",
      "VaultEpochSettled",
    ]);

    // The epoch's window: after the previous epoch closed, up to the next one opening.
    const opened = ofEpoch("EpochOpened")[0];
    const prevClose = vaultLogs.find((x) => x.name === "VaultEpochSettled" && x.args.epoch === epoch - 1n);
    const closed = vaultLogs.find((x) => x.name === "VaultEpochSettled" && x.args.epoch === epoch);
    const nextOpen = ofEpoch("EpochOpened", epoch + 1n)[0];
    const startBlock = prevClose ? prevClose.block : reg.block;
    const settled = ofEpoch("EpochSettled")[0];
    const aborted = ofEpoch("EpochAborted")[0];
    const cancelled = ofEpoch("SeriesCancelled")[0];

    // Keyed "1 deposit" to "8 redemptions and claims", so sorted keys keep the lifecycle's order.
    const lifecycle = {};
    const step = (name, status, data = {}) => {
      lifecycle[`${Object.keys(lifecycle).length + 1} ${name}`] = { status, ...data };
    };

    // 1. Deposit: deposits made for this epoch, before it opened.
    const deposits = vaultLogs.filter(
      (x) =>
        (x.name === "Deposit" || x.name === "DepositRequested") &&
        x.block > startBlock &&
        (!opened || x.block <= opened.block),
    );
    step("deposit", deposits.length ? "done" : opened ? "none" : "pending", {
      events: await Promise.all(
        deposits.map(async (x) => ({
          ...(await at(x)),
          account: x.name === "Deposit" ? x.args.owner : x.args.account,
          assets: formatUnits(x.args.assets, assetDecimals),
          asset: assetSymbol,
          ...(x.name === "Deposit"
            ? { shares: formatUnits(x.args.shares, shareDecimals) }
            : { queued: true }),
        })),
      ),
    });

    // 2. Open: locks the vault and snapshots spot.
    step(
      "open",
      opened ? "done" : "pending",
      opened
        ? { ...(await at(opened)), epoch: Number(epoch), spotUsd: formatUnits(opened.args.spot, WAD) }
        : {},
    );

    // 3. Proposal: every proposal of the epoch, with the decision records anchored for it.
    const records = dep.decisionLog
      ? decodeAll(
          await r.logs(
            lc(dep.decisionLog),
            [E.DecisionRecorded.topic0, null, addrTopic(vault), topicOf(epoch)],
            from,
            latest,
          ),
          ["DecisionRecorded"],
        )
      : [];
    const anchors = await Promise.all(
      records.map(async (x) => ({
        ...(await at(x)),
        agentId: Number(x.args.agentId),
        recordHash: x.args.recordHash,
        uri: x.args.uri,
      })),
    );
    const props = [...ofEpoch("SeriesProposed"), ...ofEpoch("ProposalRejected")].sort(
      (a, b) => a.block - b.block || a.logIndex - b.logIndex,
    );
    const proposalEvents = [];
    for (const p of props) {
      const receipt = await r.receipt(p.tx);
      proposalEvents.push({
        ...(await at(p)),
        outcome: p.name === "SeriesProposed" ? "accepted" : "rejected",
        signer: lc(receipt.from),
        strikeUsd: formatUnits(p.args.strike, WAD),
        expiry: iso(p.args.expiry),
        options: formatUnits(p.args.size, WAD),
        premiumBps: Number(p.args.premiumBps),
      });
    }
    step("proposal", props.length ? "done" : "pending", { events: proposalEvents, decisionRecords: anchors });

    // 4. Rejection and slash: the rejected proposals, the slash and where it went.
    const rejections = props.filter((p) => p.name === "ProposalRejected");
    const rejectionEvents = [];
    for (const p of rejections) {
      const receipt = await r.receipt(p.tx);
      const slashed = decodeAll(receipt.logs, ["Slashed"])[0];
      const feedback = decodeAll(receipt.logs, ["ReputationFeedback"])[0];
      rejectionEvents.push({
        ...(await at(p)),
        agentId: Number(p.args.agentId),
        reason: REASONS[Number(p.args.reason)] ?? String(p.args.reason),
        slashedUsdg: formatUnits(p.args.slashed, USDG),
        ...(slashed ? { strikes: Number(slashed.args.strikes) } : {}),
        erc8004Feedback: feedback
          ? {
              erc8004Id: Number(feedback.args.erc8004Id),
              posted: feedback.args.posted,
              tag: feedback.args.tag,
              valueUsdg: formatUnits(feedback.args.value, USDG),
            }
          : "none",
      });
    }
    step("rejection and slash", rejections.length ? "done" : "none", { events: rejectionEvents });

    // 5. Accept: the accepted series and its risk at proposal (v3's SeriesRisk).
    const accepted = props.find((p) => p.name === "SeriesProposed");
    let seriesId = null;
    if (accepted) {
      seriesId = accepted.args.seriesId;
      const risk = decodeAll((await r.receipt(accepted.tx)).logs, ["SeriesRisk"]).find(
        (x) => x.args.seriesId === seriesId,
      );
      step("accept", "done", {
        ...(await at(accepted)),
        seriesId: seriesId.toString(),
        strikeUsd: formatUnits(accepted.args.strike, WAD),
        expiry: iso(accepted.args.expiry),
        options: formatUnits(accepted.args.size, WAD),
        premiumBps: Number(accepted.args.premiumBps),
        fairValueUsd: formatUnits(accepted.args.fairValue, WAD),
        delta: formatUnits(accepted.args.delta, WAD),
        seriesRisk: risk
          ? {
              delta: formatUnits(risk.args.delta, WAD),
              gamma: formatUnits(risk.args.gamma, WAD),
              thetaPerDay: formatUnits(risk.args.theta, WAD),
              vega: formatUnits(risk.args.vega, WAD),
            }
          : "none",
      });
    } else step("accept", aborted || settled ? "none" : "pending");

    // 6. Buys of the accepted series.
    const buys = seriesId
      ? decodeAll(await r.logs(em, [E.OptionsBought.topic0, topicOf(seriesId)], from, latest), [
          "OptionsBought",
        ])
      : [];
    const sum = (xs, f) => xs.reduce((s, x) => s + f(x), 0n);
    step(
      "buys",
      buys.length ? "done" : !accepted || now >= Number(accepted.args.expiry) ? "none" : "pending",
      {
        events: await Promise.all(
          buys.map(async (x) => ({
            ...(await at(x)),
            buyer: x.args.buyer,
            recipient: x.args.recipient,
            options: formatUnits(x.args.amount, WAD),
            premiumUsdg: formatUnits(x.args.premium, USDG),
          })),
        ),
        totalOptions: formatUnits(
          sum(buys, (x) => x.args.amount),
          WAD,
        ),
        totalPremiumUsdg: formatUnits(
          sum(buys, (x) => x.args.premium),
          USDG,
        ),
      },
    );

    // 7. Settlement: the price and round, or the abort that closed an epoch without a series.
    if (settled) {
      const receipt = await r.receipt(settled.tx);
      const price = decodeAll(receipt.logs, ["SettlementPriceRecorded"])[0];
      const feedback = decodeAll(receipt.logs, ["ReputationFeedback"])[0];
      step("settlement", "done", {
        ...(await at(settled)),
        outcome: "settled",
        settlementPriceUsd: formatUnits(settled.args.settlementPrice, WAD),
        ...(price
          ? {
              oracle: price.address,
              roundId: price.args.roundId.toString(),
              oraclePriceUsd: formatUnits(price.args.price, WAD),
            }
          : {}),
        payout: formatUnits(settled.args.payout, assetDecimals),
        payoutAsset: assetSymbol,
        premiumUsdg: formatUnits(settled.args.premium, USDG),
        feeUsdg: formatUnits(settled.args.fee, USDG),
        erc8004Feedback: feedback
          ? {
              erc8004Id: Number(feedback.args.erc8004Id),
              posted: feedback.args.posted,
              tag: feedback.args.tag,
              valueUsdg: formatUnits(feedback.args.value, USDG),
            }
          : "none",
      });
    } else if (aborted) {
      const receipt = await r.receipt(aborted.tx);
      const paid = decodeAll(receipt.logs, ["Transfer"]).filter(
        (x) => x.address === lc(dep.usdg) && lc(x.args.from) === em && lc(x.args.to) === vault,
      );
      step("settlement", "done", {
        ...(await at(aborted)),
        outcome: "aborted",
        slashPaidToVaultUsdg: formatUnits(
          sum(paid, (x) => x.args.value),
          USDG,
        ),
      });
    } else if (cancelled) {
      step("settlement", "done", { ...(await at(cancelled)), outcome: "cancelled" });
    } else step("settlement", "pending");

    // 8. Redemptions (options burned for their payout) and claims (depositors' withdrawals and premium).
    const redemptions = seriesId
      ? decodeAll(await r.logs(em, [E.OptionsRedeemed.topic0, topicOf(seriesId)], from, latest), [
          "OptionsRedeemed",
        ])
      : [];
    const claims = closed
      ? vaultLogs.filter(
          (x) =>
            ["Withdraw", "PremiumClaimed", "RedeemClaimed", "DepositClaimed"].includes(x.name) &&
            x.block > closed.block &&
            (!nextOpen || x.block < nextOpen.block),
        )
      : [];
    step("redemptions and claims", redemptions.length || claims.length ? "done" : "pending", {
      redemptions: await Promise.all(
        redemptions.map(async (x) => ({
          ...(await at(x)),
          holder: x.args.holder,
          options: formatUnits(x.args.amount, WAD),
          paid: formatUnits(x.args.paid, reg.args.isCall ? assetDecimals : USDG),
          paidAsset: reg.args.isCall ? underlyingSymbol : "USDG",
        })),
      ),
      claims: await Promise.all(
        claims.map(async (x) => {
          const base = { ...(await at(x)), kind: x.name };
          if (x.name === "PremiumClaimed")
            return {
              ...base,
              account: x.args.account,
              amount: formatUnits(x.args.amount, USDG),
              asset: "USDG",
            };
          if (x.name === "Withdraw")
            return {
              ...base,
              account: x.args.owner,
              amount: formatUnits(x.args.assets, assetDecimals),
              asset: assetSymbol,
            };
          return {
            ...base,
            account: x.args.account,
            amount: formatUnits(x.args.assets, assetDecimals),
            asset: assetSymbol,
          };
        }),
      ),
    });

    vaults.push({
      address: vault,
      agentId: Number(reg.args.agentId),
      curator: lc(reg.args.curator),
      epoch: Number(epoch),
      kind: reg.args.isCall ? "covered call" : "cash-secured put",
      lifecycle,
      status: settled ? "settled" : aborted ? "aborted" : cancelled ? "cancelled" : "pending",
      symbol: await r.callString(vault, "symbol()"),
      underlying: underlyingSymbol,
      underlyingToken: lc(reg.args.underlying),
    });
  }

  const file = `${chainId}-${dep.version}-${EXPIRY_DATE}.json`;
  return {
    file,
    record: {
      about:
        "One week of a Strike deployment, read from the chain by scripts/proven-week.mjs; every tx and block is checked by scripts/check-claims.mjs. Amounts are exact decimals; a step not done yet is 'pending', one that will not happen this week is 'none'.",
      chain: chain.name,
      chainId,
      contracts: {
        agentRegistry: lc(dep.agentRegistry),
        decisionLog: dep.decisionLog ? lc(dep.decisionLog) : "none",
        epochManager: em,
        stockOracle: lc(dep.stockOracle),
        usdg: lc(dep.usdg),
      },
      deployment: deploymentPath,
      expiry: expiryTs ? iso(expiryTs) : `${EXPIRY_DATE} (no proposal for this date)`,
      explorer: chain.explorer,
      regenerate: `node scripts/proven-week.mjs --expiry ${EXPIRY_DATE} --deployment ${deploymentPath}`,
      status: !vaults.length
        ? "none"
        : vaults.every((v) => v.status !== "pending")
          ? "closed"
          : "pending settlement",
      vaults,
      version: dep.version,
    },
  };
}

// ------------------------------------------------------------------------------------------------ output

/** JSON with sorted object keys (lists keep their order), two-space indent, a trailing newline. */
function stable(value) {
  const sort = (v) =>
    Array.isArray(v)
      ? v.map(sort)
      : v && typeof v === "object"
        ? Object.fromEntries(
            Object.keys(v)
              .sort()
              .map((k) => [k, sort(v[k])]),
          )
        : typeof v === "bigint"
          ? v.toString()
          : v;
  return `${JSON.stringify(sort(value), null, 2)}\n`;
}

let differs = 0;
for (const d of deployments) {
  const { file, record } = await week(d);
  const text = stable(record);
  const path = join(OUT_DIR, file);
  const pending = record.vaults.flatMap((v) =>
    Object.entries(v.lifecycle)
      .filter(([, s]) => s.status === "pending")
      .map(([k]) => `${v.symbol} ${k.replace(/^\d+ /, "")}`),
  );
  const line = `${file}: ${record.vaults.length} vault(s), ${record.status}${pending.length ? ` (pending: ${pending.join(", ")})` : ""}`;
  if (STDOUT) process.stdout.write(text);
  else if (CHECK) {
    const same = existsSync(path) && readFileSync(path, "utf8") === text;
    if (!same) differs++;
    console.log(`${same ? "same" : "DIFFERS"} ${line}`);
  } else {
    mkdirSync(OUT_DIR, { recursive: true });
    writeFileSync(path, text);
    console.log(`wrote docs/evidence/${line}`);
  }
}
process.exit(differs ? 1 : 0);
