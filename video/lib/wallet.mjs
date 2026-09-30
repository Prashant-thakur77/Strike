// The wallet-signing scene: a real transaction signed from the app's own UI.
//
// The page gets an EIP-1193 provider (window.ethereum) whose signing happens in Node, with a throwaway key made for
// the recording (video/.out/wallet/key.json, gitignored; never the deployer's key). Every eth_sendTransaction first
// shows an in-page confirmation panel labelled as that test wallet, with what the app asked to sign; the recorder
// presses Confirm, Node signs and broadcasts, and the app shows its own pending and done states. Reads go to the RPC.
//
// SIGN_RPC=http://127.0.0.1:8599 rehearses the scene against an anvil fork of the testnet (the app's RPC calls are
// routed there too), so the real run happens once.
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { ROOT, log, sleep } from "./engine.mjs";

const require = createRequire(join(ROOT, "app", "package.json"));
const viem = require("viem");
const { privateKeyToAccount } = require("viem/accounts");

export const TESTNET_RPC = "https://rpc.testnet.chain.robinhood.com";
const DEP = JSON.parse(readFileSync(join(ROOT, "contracts/deployments/46630.json"), "utf8"));
const NAMES = { [DEP.usdg.toLowerCase()]: "USDG", [DEP.agentRegistry.toLowerCase()]: "AgentRegistry" };
const ABI = viem.parseAbi([
  "function approve(address spender, uint256 amount)",
  "function register(address signer, address payout, uint256 erc8004Id)",
  "function postBond(uint256 agentId, uint256 amount)",
]);
const short = (a) => `${a.slice(0, 6)}…${a.slice(-4)}`;

export function walletEnv() {
  const raw = JSON.parse(readFileSync(join(ROOT, "video/.out/wallet/key.json"), "utf8"));
  const k = Array.isArray(raw) ? raw[0] : raw;
  const account = privateKeyToAccount(k.private_key ?? k.privateKey);
  const rpc = process.env.SIGN_RPC ?? TESTNET_RPC;
  const chain = viem.defineChain({
    id: 46630,
    name: "Robinhood Chain testnet",
    nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
    rpcUrls: { default: { http: [rpc] } },
  });
  const client = viem.createPublicClient({ chain, transport: viem.http(rpc) });
  const wallet = viem.createWalletClient({ account, chain, transport: viem.http(rpc) });
  return { account, rpc, client, wallet, sent: [] };
}

async function describe(w, tx) {
  const to = tx.to.toLowerCase();
  let fn = "contract call",
    rows = [];
  try {
    const d = viem.decodeFunctionData({ abi: ABI, data: tx.data });
    fn = d.functionName;
    if (fn === "approve")
      rows = [
        ["Spender", `${NAMES[d.args[0].toLowerCase()] ?? ""} ${short(d.args[0])}`],
        ["Amount", `${viem.formatUnits(d.args[1], 6)} USDG`],
      ];
    if (fn === "register")
      rows = [
        ["Signer", short(d.args[0])],
        ["Payout", short(d.args[1])],
        ["ERC-8004 id", d.args[2] === 0n ? "none" : `#${d.args[2]}`],
      ];
    if (fn === "postBond")
      rows = [
        ["Agent", `#${d.args[0]}`],
        ["Bond", `${viem.formatUnits(d.args[1], 6)} USDG`],
      ];
  } catch {}
  const gas = await w.client.estimateGas({
    account: w.account.address,
    to: tx.to,
    data: tx.data,
    value: tx.value ? BigInt(tx.value) : 0n,
  });
  const price = await w.client.getGasPrice();
  return {
    title: { approve: "Approve USDG", register: "Register agent", postBond: "Post bond" }[fn] ?? fn,
    contract: `${NAMES[to] ?? "Contract"} ${short(tx.to)}`,
    fn: `${fn}()`,
    rows,
    fee: `${Number(viem.formatEther((gas * price * 13n) / 10n)).toFixed(8)} ETH`,
    gas: String((gas * 13n) / 10n),
  };
}

/** Browser context: the provider bindings, and the app's RPC routed to SIGN_RPC when rehearsing. */
export async function signingContext(ctx, env) {
  const w = env.wallet;
  if (!w) throw new Error("the signing scene needs --live-sign (or SIGN_RPC for a rehearsal)");
  await ctx.exposeBinding("__walletRpc", async (_s, method, params) => {
    const res = await fetch(w.rpc, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params: params ?? [] }),
    });
    const j = await res.json();
    if (j.error) throw new Error(j.error.message);
    return j.result;
  });
  await ctx.exposeBinding("__walletDescribe", async (_s, tx) => describe(w, tx));
  await ctx.exposeBinding("__walletSend", async (_s, tx, gas) => {
    const hash = await w.wallet.sendTransaction({
      to: tx.to,
      data: tx.data,
      value: tx.value ? BigInt(tx.value) : 0n,
      gas: BigInt(gas),
    });
    w.sent.push(hash);
    log(`  signed and sent ${hash}`);
    return hash;
  });
  if (w.rpc !== TESTNET_RPC)
    await ctx.route(new RegExp(`^${TESTNET_RPC.replace(/[.]/g, "\\.")}`), async (route) => {
      const cors = {
        "access-control-allow-origin": "*",
        "access-control-allow-headers": "*",
        "access-control-allow-methods": "POST, OPTIONS",
      };
      if (route.request().method() === "OPTIONS") return route.fulfill({ status: 204, headers: cors });
      const r = await fetch(w.rpc, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: route.request().postData(),
      });
      route.fulfill({
        status: r.status,
        headers: { ...cors, "content-type": "application/json" },
        body: await r.text(),
      });
    });
  await ctx.addInitScript(injectedWallet, { address: w.account.address });
}

/** In the page: window.ethereum, and the confirmation panel (outside <body>, so zooms never move it). */
function injectedWallet({ address }) {
  const listeners = {};
  let confirmResolve = null;
  const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;");
  const css = `
  #__wal{position:fixed;top:60px;right:40px;width:540px;z-index:2147483646;font:500 20px/1.35 "Inter Tight",system-ui,sans-serif;
    color:#f1f0ed;background:#131716;border:1px solid #2c3a39;border-radius:18px;box-shadow:0 30px 90px rgba(0,0,0,.45);
    overflow:hidden;opacity:0;transform:translateY(-10px) scale(.98);transition:opacity .25s ease,transform .25s ease;pointer-events:none}
  #__wal.on{opacity:1;transform:none;pointer-events:auto}
  #__wal .hd{display:flex;align-items:center;gap:12px;padding:16px 20px;background:#0c1010;border-bottom:1px solid #243130}
  #__wal .dot{width:30px;height:30px;border-radius:50%;background:linear-gradient(150deg,#75d0cb,#2f7f7a)}
  #__wal .hd b{font-weight:700;font-size:18px}
  #__wal .hd small{display:block;font-size:13px;color:#8fa3a1;letter-spacing:.02em}
  #__wal .net{margin-left:auto;font-size:12px;letter-spacing:.08em;text-transform:uppercase;color:#0d0d0d;background:#f2c46d;border-radius:99px;padding:5px 10px;font-weight:700}
  #__wal .bd{padding:18px 20px 8px}
  #__wal .req{font-size:13px;letter-spacing:.14em;text-transform:uppercase;color:#75d0cb;font-weight:700}
  #__wal h3{margin:6px 0 4px;font-size:38px;letter-spacing:-.02em;font-weight:800}
  #__wal .ct{color:#aab8b6;font:500 15px/1.3 "JetBrains Mono",ui-monospace,monospace;margin-bottom:12px}
  #__wal dl{margin:0;border-top:1px solid #243130}
  #__wal dl div{display:flex;justify-content:space-between;padding:9px 0;border-bottom:1px solid #1d2726}
  #__wal dt{color:#8fa3a1} #__wal dd{margin:0;font:600 19px/1.3 "JetBrains Mono",ui-monospace,monospace}
  #__wal .ft{display:flex;gap:12px;padding:16px 20px 18px}
  #__wal button{flex:1;font:700 20px/1 "Inter Tight",system-ui,sans-serif;border-radius:99px;padding:15px 0;border:1px solid #3a4a49;background:transparent;color:#f1f0ed;transition:transform .12s ease,background .2s ease}
  #__wal button.ok{background:#75d0cb;border-color:#75d0cb;color:#0d0d0d}
  #__wal button.ok.press{transform:scale(.94);background:#5fbab5}
  #__wal .st{padding:0 20px 16px;font:600 15px/1.3 "JetBrains Mono",ui-monospace,monospace;color:#75d0cb;min-height:20px}
  #__wal .note{padding:10px 20px 14px;font-size:13px;color:#7d8a89;border-top:1px solid #1d2726}`;
  const mount = () => {
    if (document.getElementById("__wal")) return document.getElementById("__wal");
    const st = document.createElement("style");
    st.textContent = css;
    document.documentElement.appendChild(st);
    const el = document.createElement("div");
    el.id = "__wal";
    document.documentElement.appendChild(el);
    return el;
  };
  const show = (d) => {
    const el = mount();
    el.innerHTML = `<div class="hd"><div class="dot"></div><div><b>Test wallet</b><small>${esc(address.slice(0, 6) + "…" + address.slice(-4))} · made for this recording</small></div><span class="net">RH testnet</span></div>
      <div class="bd"><div class="req">Signature request</div><h3>${esc(d.title)}</h3><div class="ct">${esc(d.contract)} · ${esc(d.fn)}</div>
      <dl>${d.rows.map(([k, v]) => `<div><dt>${esc(k)}</dt><dd>${esc(v)}</dd></div>`).join("")}<div><dt>Network fee</dt><dd>${esc(d.fee)}</dd></div></dl></div>
      <div class="st"></div>
      <div class="ft"><button class="no" type="button">Reject</button><button class="ok" type="button">Confirm</button></div>
      <div class="note">Robinhood Chain testnet (46630). A throwaway key, not a real wallet.</div>`;
    el.querySelector(".ok").onclick = () => {
      el.querySelector(".ok").classList.add("press");
      confirmResolve?.();
    };
    requestAnimationFrame(() => el.classList.add("on"));
    return el;
  };
  const provider = {
    isStrikeTestWallet: true,
    async request({ method, params }) {
      switch (method) {
        case "eth_requestAccounts":
        case "eth_accounts":
          return [address];
        case "eth_chainId":
          return "0xb626";
        case "net_version":
          return "46630";
        case "wallet_requestPermissions":
        case "wallet_getPermissions":
          return [{ parentCapability: "eth_accounts" }];
        case "wallet_switchEthereumChain":
        case "wallet_addEthereumChain":
          return null;
        case "eth_sendTransaction": {
          const tx = params[0];
          const d = await window.__walletDescribe(tx);
          const el = show(d);
          window.__walletPending = true;
          await new Promise((r) => (confirmResolve = r));
          window.__walletPending = false;
          el.querySelector(".st").textContent = "Signing…";
          const hash = await window.__walletSend(tx, d.gas);
          el.querySelector(".st").textContent = `Sent ${hash.slice(0, 10)}…${hash.slice(-4)}`;
          setTimeout(() => el.classList.remove("on"), 900);
          return hash;
        }
        default:
          return window.__walletRpc(method, params ?? []);
      }
    },
    on(e, fn) {
      (listeners[e] ??= []).push(fn);
    },
    removeListener(e, fn) {
      listeners[e] = (listeners[e] ?? []).filter((f) => f !== fn);
    },
  };
  window.ethereum = provider;
}

export async function signingPrepare(page, env) {
  const { APP } = await import("../demo.mjs");
  const w = env.wallet;
  // Set up before the clock: the USDG allowance for the bond (so the scene shows two signatures, register and bond,
  // not three), and the wallet connection.
  const bond = 50_000_000n;
  const allowance = await w.client.readContract({
    address: DEP.usdg,
    abi: viem.parseAbi(["function allowance(address,address) view returns (uint256)"]),
    functionName: "allowance",
    args: [w.account.address, DEP.agentRegistry],
  });
  if (allowance < bond) {
    const hash = await w.wallet.writeContract({
      address: DEP.usdg,
      abi: ABI,
      functionName: "approve",
      args: [DEP.agentRegistry, bond],
    });
    await w.client.waitForTransactionReceipt({ hash });
    w.approve = hash;
    log(`  approved the bond beforehand: ${hash}`);
  }
  await page.goto(`${APP}/app/agents`);
  await page.getByText("Leaderboard").first().waitFor({ timeout: 60_000 });
  await page.evaluate(() => document.fonts.ready);
  await page.getByRole("banner").getByRole("button", { name: "Connect wallet" }).click();
  await page
    .getByRole("banner")
    .getByText(/0x4501/i)
    .first()
    .waitFor({ timeout: 20_000 })
    .catch(() => {});
  const section = page.getByRole("region", { name: "Run your own agent" });
  await section.getByRole("heading", { name: "Register" }).waitFor({ timeout: 60_000 });
  const y = await section.evaluate((el) => el.getBoundingClientRect().top + scrollY);
  await page.evaluate((y) => window.__v.scrollTo(y - 110, 0), y);
}

/** Press Confirm on the next signature request, `delay` ms after it shows. */
async function confirmNext(page, delay = 1100) {
  await page.waitForFunction(() => window.__walletPending === true, null, { timeout: 60_000 });
  await sleep(delay);
  await page.locator("#__wal button.ok").click();
}

export async function signingRun(h, env) {
  const page = h.page;
  const section = page.getByRole("region", { name: "Run your own agent" });
  await h.at(0.8);
  await section.getByText("Register an agent", { exact: true }).click();
  const form = section.getByRole("form", { name: "Register an agent" });
  await form.waitFor();
  await h.cue(1, -0.3);
  await h.scrollTo(form, { offset: 90, ms: 900 });
  await page
    .getByText(/Meets the 50 USDG minimum/)
    .first()
    .waitFor({ timeout: 30_000 });
  await h.chunk(1, 1, -0.2);
  await h.zoom(form.getByLabel("Bond", { exact: true }), { scale: 1.6 });
  await h.cue(2, -0.6);
  await h.unzoom(250);
  await form.getByRole("button", { name: /register/i }).click();
  await confirmNext(page, 1300); // register
  // the app's own status line: waiting for the block, then done
  await sleep(500);
  await h.zoom(form.locator("p[data-phase]").first(), { scale: 1.7 });
  await confirmNext(page, 1300); // post bond
  await form.getByText("Post bond: done.").waitFor({ timeout: 90_000 });
  await sleep(700);
  await h.zoom(form.getByText(/is registered and bonded/).first(), { scale: 1.6 });
  await h.at(Math.max(h.now() + 2.2, h.tl.lines[4].end + 0.3));
  // the bond on the explorer
  const hash = env.wallet.sent.at(-1);
  await page.goto(`${env.EXPLORER}/tx/${hash}`, { waitUntil: "domcontentloaded" });
  await page
    .getByText("Tokens transferred")
    .first()
    .waitFor({ timeout: 30_000 })
    .catch(() => {});
  await page.mouse.move(1900, 700);
  await page.evaluate(() => window.__v.init());
  await sleep(600);
  await page.evaluate(() => {
    const v = window.__v;
    const label = v.leaf("^Tokens transferred$", "i");
    if (!label) return;
    const usdg = [...document.querySelectorAll("*")].filter(
      (e) =>
        e.children.length === 0 &&
        e.textContent.trim() === "USDG" &&
        Math.abs(v.rect(e).y - v.rect(label).y) < 30,
    )[0];
    const r = v.union([v.rect(label), v.rect(usdg ?? label)]);
    v.box(r, { pad: 14, dim: 0.3 });
    v.zoomRect(r, 1.4);
  });
}
