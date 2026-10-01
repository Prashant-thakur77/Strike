import { readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test, type Page } from "@playwright/test";
import { createPublicClient, createWalletClient, http, parseAbi, type Address } from "viem";
import { foundry } from "viem/chains";
import { RPC, acknowledge, connectWallet, devnetUp, horizontalOverflow, installMockWallet } from "./helpers";

// "Run your own agent" on /app/agents against a local devnet: a fresh anvil account (not the deployer) registers an
// agent, bonds it and creates a vault it runs, all through the injected mock wallet, and the leaderboard shows it.
// The devnet may run v2 (this repo's contracts) or v3 (Deploy.s.sol and Seed.s.sol from the v3-contracts branch; the
// core addresses on 31337 are the same): v3's AgentRegistry makes a signer key other than the wallet sign an EIP-712
// consent first, and the v3 tests cover that flow. Each test runs only on the matching devnet.

const registryAbi = parseAbi([
  "function REGISTER_TYPEHASH() view returns (bytes32)",
  "function nonces(address) view returns (uint256)",
  "function agentOfSigner(address) view returns (uint256)",
  "function getAgent(uint256) view returns ((address owner, address signer, address payout, uint8 status, uint32 strikes, uint32 accepted, uint32 rejected, uint64 unbondAt, uint256 erc8004Id, uint256 bond, uint256 unbonding))",
]);
const emAbi = parseAbi([
  "function vaultConfig(address) view returns ((address curator, uint256 agentId, bool registered, (uint16 minDeltaBps, uint16 maxDeltaBps, uint16 minPremiumBps, uint16 minYieldBps, uint16 maxShareSoldBps, uint32 minTenor, uint32 maxTenor) mandate))",
]);
const usdgAbi = parseAbi(["function faucet(uint256 amount)"]);

/** anvil's dev accounts #0 (the deployer, signer of agent 1) and #5-#9 (unused by the demo chain). */
const DEPLOYER = "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266";
const FRESH = [
  "0x9965507D1a55bcC2695C58ba16FB37d819B0A4dc",
  "0x976EA74026E726554dB657fA54763abd0C3a0aa9",
  "0x14dC79964da2C08b23698B3D3cc7Ca32193d9955",
  "0x23618e81E3f5cdF7f54C3d65f7FBc0aBf5B21E8f",
  "0xa0Ee7A142d267C1f36714E4a8F75612F20a79720",
] as const;

/** The local deployment's addresses, from the SDK's generated map (as smoke.spec.ts reads the EpochManager). */
function local(key: "agentRegistry" | "usdg" | "epochManager"): Address {
  const src = readFileSync(join(__dirname, "..", "..", "sdk", "src", "deployments.generated.ts"), "utf8");
  const block = src.match(/"31337":\s*\{[\s\S]*?\n {2}\}/)?.[0] ?? "";
  const m = block.match(new RegExp(`"${key}":\\s*"(0x[0-9a-fA-F]{40})"`));
  if (!m) throw new Error(`no 31337 ${key} in the SDK map`);
  return m[1] as Address;
}

const chain = { ...foundry, rpcUrls: { default: { http: [RPC] } } };
const pub = createPublicClient({ chain, transport: http(RPC) });

/** "v3" when the devnet's AgentRegistry takes an EIP-712 signer consent (it has REGISTER_TYPEHASH), else "v2". */
async function registryVersion(): Promise<"v2" | "v3"> {
  try {
    await pub.readContract({
      address: local("agentRegistry"),
      abi: registryAbi,
      functionName: "REGISTER_TYPEHASH",
    });
    return "v3";
  } catch {
    return "v2";
  }
}

/** An anvil account with no agent yet (the spec can re-run on the same devnet), funded with USDG. */
async function freshAccount(skip: Address[] = []): Promise<Address | null> {
  for (const account of FRESH) {
    if (skip.includes(account)) continue;
    const id = await pub.readContract({
      address: local("agentRegistry"),
      abi: registryAbi,
      functionName: "agentOfSigner",
      args: [account],
    });
    if (id !== 0n) continue;
    // anvil's dev accounts are unlocked: eth_sendTransaction from them works without a key.
    const wallet = createWalletClient({ account, chain, transport: http(RPC) });
    const hash = await wallet.writeContract({
      address: local("usdg"),
      abi: usdgAbi,
      functionName: "faucet",
      args: [1_000_000_000n],
    });
    await pub.waitForTransactionReceipt({ hash });
    return account;
  }
  return null;
}

async function openSection(page: Page, mobile: boolean) {
  await page.goto("/app/agents?chain=31337");
  await expect(page.getByRole("button", { name: /about agent/ }).first()).toBeVisible();
  await connectWallet(page, mobile);
  const section = page.getByRole("region", { name: "Run your own agent" });
  await section.scrollIntoViewIfNeeded();
  await expect(section.getByRole("heading", { name: "Register" })).toBeVisible();
  await expect(section.getByRole("heading", { name: "Bond" })).toBeVisible();
  await expect(section.getByRole("heading", { name: "Run a vault" })).toBeVisible();
  await expect(section.getByText(/Post at least 50 USDG/)).toBeVisible();
  // Behind a fold, closed by default on every width.
  const form = section.getByRole("form", { name: "Register an agent" });
  await expect(form).toBeHidden();
  await section.getByText("Register an agent", { exact: true }).click();
  await expect(form).toBeVisible();
  return { section, form };
}

test.beforeEach(async ({ page }) => {
  await acknowledge(page);
  test.skip(!(await devnetUp()), "needs a Strike devnet at E2E_RPC");
});

test("a new account registers an agent, bonds it and creates a vault it runs", async ({ page }, info) => {
  test.skip(info.project.name !== "desktop", "one chain-mutating run is enough");
  test.skip((await registryVersion()) !== "v2", "the devnet runs v3: the v3 tests cover registration");
  const errors: string[] = [];
  page.on("pageerror", (err) => errors.push(err.message));
  // Leave the devnet as we found it (other specs count its vaults): snapshot now, revert at the end.
  const snapshot = (await rpc("evm_snapshot", [])) as string;
  try {
    await registerAndCreate(page, errors);
  } finally {
    await rpc("evm_revert", [snapshot]);
  }
});

async function rpc(method: string, params: unknown[]): Promise<unknown> {
  const res = await fetch(RPC, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  const json = (await res.json()) as { result?: unknown; error?: { message: string } };
  if (json.error) throw new Error(`${method}: ${json.error.message}`);
  return json.result;
}

async function registerAndCreate(page: Page, errors: string[]) {
  const account = await freshAccount();
  test.skip(account === null, "every spare anvil account already has an agent on this devnet");
  await installMockWallet(page, account!);
  const { section, form } = await openSection(page, false);

  // The signer defaults to the connected wallet; a key that already signs for an agent is refused.
  const signer = form.getByLabel("Signer");
  await expect(signer).toHaveValue(account!);
  await expect(form.getByLabel("Payout")).toHaveValue(account!);
  const checks = form.getByRole("list", { name: "Registration checks" });
  await expect(checks.getByText(/is free\. Only this key may propose/)).toBeVisible();
  await signer.fill(DEPLOYER);
  await expect(checks.getByText(/already signs for agent 1\. One agent per signer/)).toBeVisible();
  const submit = form.getByRole("button", { name: /register/i });
  await expect(submit).toBeDisabled();
  await signer.fill(account!);
  await expect(checks.getByText(/is free/)).toBeVisible();

  // The bond defaults to minBond; below it the form warns (without blocking), above the balance it blocks.
  const bond = form.getByLabel("Bond", { exact: true });
  await expect(bond).toHaveValue("50");
  await expect(checks.getByText(/You hold 1,?000 USDG, enough for the bond/)).toBeVisible();
  await bond.fill("10");
  await expect(checks.getByText(/An agent with bond < minBond \(50 USDG\) cannot propose/)).toBeVisible();
  await bond.fill("5000");
  await expect(checks.getByText(/the bond is 5,?000 USDG/)).toBeVisible();
  await expect(submit).toBeDisabled();
  await bond.fill("50");
  await expect(checks.getByText(/Meets the 50 USDG minimum/)).toBeVisible();

  // Approve, register, bond: three transactions through the mock wallet.
  await expect(submit).toHaveText(/approve, register & bond/i);
  await submit.click();
  await expect(form.getByText("Post bond: done.")).toBeVisible({ timeout: 60_000 });
  const agentId = await pub.readContract({
    address: local("agentRegistry"),
    abi: registryAbi,
    functionName: "agentOfSigner",
    args: [account!],
  });
  expect(agentId).toBeGreaterThan(1n);
  const onChain = await pub.readContract({
    address: local("agentRegistry"),
    abi: registryAbi,
    functionName: "getAgent",
    args: [agentId],
  });
  expect(onChain).toMatchObject({ owner: account, signer: account, payout: account, bond: 50_000_000n });
  await expect(
    form.getByText(new RegExp(`Agent ${agentId}\\s*is registered and bonded 50 USDG`)),
  ).toBeVisible();

  // The follow-up: a vault run by this agent, with a mandate that must pass the floors.
  const vault = section.getByRole("region", { name: `Create a vault run by agent ${agentId}` });
  await expect(vault).toBeVisible();
  const vaultForm = vault.getByRole("form", { name: "Create a vault" });
  await vaultForm.getByRole("group", { name: "Stock" }).getByRole("button", { name: "TSLA" }).click();
  await vaultForm
    .getByRole("group", { name: "Kind" })
    .getByRole("button", { name: "Cash-secured put" })
    .click();
  const vaultChecks = vaultForm.getByRole("list", { name: "Vault checks" });
  await expect(vaultChecks.getByText(/Passes the protocol floors/)).toBeVisible();
  const floor = vaultForm.getByLabel("Premium floor");
  await expect(floor).toHaveValue("95");
  await floor.fill("80");
  await expect(vaultChecks.getByText(/minPremiumBps must be at least 9000/)).toBeVisible();
  const create = vaultForm.getByRole("button", { name: "Create vault" });
  await expect(create).toBeDisabled();
  await floor.fill("95");
  await expect(create).toBeEnabled();
  await create.click();
  await expect(vaultForm.getByText("Create vault: done.")).toBeVisible({ timeout: 60_000 });
  const symbol = `sTSLA-CSP-A${agentId}`;
  const link = vaultForm.getByRole("link", { name: new RegExp(symbol) });
  await expect(link).toBeVisible();
  const vaultAddress = (await link.getAttribute("href"))!.split("/").pop() as Address;
  const cfg = await pub.readContract({
    address: local("epochManager"),
    abi: emAbi,
    functionName: "vaultConfig",
    args: [vaultAddress],
  });
  expect(cfg).toMatchObject({ curator: account, agentId, registered: true });
  expect(cfg.mandate).toMatchObject({ minPremiumBps: 9500, maxTenor: 8 * 86_400 });

  // The leaderboard lists the new agent, and its details show the vault it runs.
  const board = page.getByRole("region", { name: "Leaderboard" });
  await board.scrollIntoViewIfNeeded();
  const toggle = board.getByRole("button", { name: new RegExp(`about agent ${agentId}$`) });
  await expect(toggle).toBeVisible();
  if ((await toggle.getAttribute("aria-expanded")) !== "true") await toggle.click();
  await expect(board.locator(`a[href="/app/vault/${vaultAddress}"]`)).toHaveText("TSLA cash-secured put");

  expect(await horizontalOverflow(page)).toBeLessThanOrEqual(0);
  expect(errors).toEqual([]);
}

// ------------------------------------------------------------------ v3: EIP-712 signer consent

/** Run `body` on a v3 devnet at desktop size, leaving the chain as it was. */
async function onV3(info: { project: { name: string } }, body: () => Promise<void>) {
  test.skip(info.project.name !== "desktop", "one chain-mutating run is enough");
  test.skip((await registryVersion()) !== "v3", "needs a v3 devnet (Deploy and Seed from v3-contracts)");
  const snapshot = (await rpc("evm_snapshot", [])) as string;
  try {
    await body();
  } finally {
    await rpc("evm_revert", [snapshot]);
  }
}

const readAgent = async (signer: Address) => {
  const id = await pub.readContract({
    address: local("agentRegistry"),
    abi: registryAbi,
    functionName: "agentOfSigner",
    args: [signer],
  });
  const agent = await pub.readContract({
    address: local("agentRegistry"),
    abi: registryAbi,
    functionName: "getAgent",
    args: [id],
  });
  return { id, agent };
};
const nonceOf = (signer: Address) =>
  pub.readContract({
    address: local("agentRegistry"),
    abi: registryAbi,
    functionName: "nonces",
    args: [signer],
  });

test("v3: a separate signer key signs its consent, then register, approve USDG and post bond", async ({
  page,
}, info) => {
  await onV3(info, async () => {
    const errors: string[] = [];
    page.on("pageerror", (err) => errors.push(err.message));
    const owner = await freshAccount();
    const signer = owner ? await freshAccount([owner]) : null;
    test.skip(!owner || !signer, "needs two spare anvil accounts");
    // The signer key is a second account of the same wallet, so the wallet can sign as it.
    await installMockWallet(page, owner!, [signer!]);
    const { form } = await openSection(page, false);
    await form.getByLabel("Signer").fill(signer!);
    const checks = form.getByRole("list", { name: "Registration checks" });
    await expect(checks.getByText(/is free/)).toBeVisible();
    await expect(
      checks.getByText(/needs the signer's consent: your wallet will be asked to sign it as/),
    ).toBeVisible();
    const steps = form.getByRole("list", { name: "Steps" });
    await expect(steps.getByRole("listitem")).toHaveText([
      /Sign consent/,
      /Register/,
      /Approve USDG/,
      /Post bond/,
    ]);
    const submit = form.getByRole("button", { name: /sign consent/i });
    await expect(submit).toHaveText("Sign consent, register, approve USDG & post bond");
    expect(await nonceOf(signer!)).toBe(0n);
    await submit.click();
    await expect(form.getByText("Post bond: done.")).toBeVisible({ timeout: 60_000 });
    await expect(steps.locator('li[data-state="done"]')).toHaveCount(4);

    const { id, agent } = await readAgent(signer!);
    expect(id).toBeGreaterThan(1n);
    expect(agent).toMatchObject({ owner, signer, payout: owner, bond: 50_000_000n });
    expect(await nonceOf(signer!)).toBe(1n); // the consent was used
    await expect(form.getByText(new RegExp(`Agent ${id}\\s*is registered and bonded 50 USDG`))).toBeVisible();
    expect(errors).toEqual([]);
  });
});

test("v3: the wallet as its own signer registers without a consent signature", async ({ page }, info) => {
  await onV3(info, async () => {
    const account = await freshAccount();
    test.skip(account === null, "every spare anvil account already has an agent on this devnet");
    await installMockWallet(page, account!);
    const { form } = await openSection(page, false);
    const checks = form.getByRole("list", { name: "Registration checks" });
    await expect(
      checks.getByText(/Your wallet is the signer, so this registry \(v3\) needs no consent/),
    ).toBeVisible();
    const steps = form.getByRole("list", { name: "Steps" });
    await expect(steps.getByRole("listitem")).toHaveText([/Register/, /Approve USDG/, /Post bond/]);
    const submit = form.getByRole("button", { name: /register, approve USDG & post bond/i });
    await submit.click();
    await expect(form.getByText("Post bond: done.")).toBeVisible({ timeout: 60_000 });
    const { agent } = await readAgent(account!);
    expect(agent).toMatchObject({ owner: account, signer: account, bond: 50_000_000n });
    expect(await nonceOf(account!)).toBe(0n);
  });
});

test("v3: a pasted consent from the wrong key is refused before sending; the right one registers", async ({
  page,
}, info) => {
  await onV3(info, async () => {
    const owner = await freshAccount();
    const signer = owner ? await freshAccount([owner]) : null;
    const forger = owner && signer ? await freshAccount([owner, signer]) : null;
    test.skip(!owner || !signer || !forger, "needs three spare anvil accounts");
    // The signer key is NOT in this wallet: its consent is pasted.
    await installMockWallet(page, owner!);
    const { form } = await openSection(page, false);
    await form.getByLabel("Signer").fill(signer!);
    await form.getByText("Signer key not in this wallet?").click();
    await form.getByRole("button", { name: "Copy consent message" }).click();
    const message = form.getByRole("textbox", { name: "Consent message" });
    await expect(message).toHaveValue(/"primaryType": "Register"/);
    const td = JSON.parse(await message.inputValue());
    const deadline = await form.getByLabel("Consent deadline").inputValue();
    expect(deadline).toBe(td.message.deadline);
    const typedData = {
      ...td,
      domain: { ...td.domain, chainId: Number(td.domain.chainId) },
      message: {
        ...td.message,
        erc8004Id: BigInt(td.message.erc8004Id),
        nonce: BigInt(td.message.nonce),
        deadline: BigInt(td.message.deadline),
      },
    };
    // anvil signs eth_signTypedData_v4 for its unlocked dev accounts.
    const signAs = (account: Address) =>
      createWalletClient({ account, chain, transport: http(RPC) }).signTypedData(typedData);

    await form.getByLabel("Consent signature").fill(await signAs(forger!));
    await form.getByRole("button", { name: /sign consent/i }).click();
    await expect(form.getByText(/Sign consent failed: .*not by the signer/)).toBeVisible();
    expect((await readAgent(signer!)).id).toBe(0n);

    await form.getByLabel("Consent signature").fill(await signAs(signer!));
    await form.getByRole("button", { name: /sign consent/i }).click();
    await expect(form.getByText("Post bond: done.")).toBeVisible({ timeout: 60_000 });
    expect((await readAgent(signer!)).agent).toMatchObject({ owner, signer });
  });
});

test("the section fits a phone and explains the steps", async ({ page }, info) => {
  test.skip(info.project.name !== "mobile", "the desktop run covers the flow");
  await installMockWallet(page);
  const { form } = await openSection(page, true);
  await expect(form.getByLabel("Signer")).toHaveValue("0x70997970C51812dc3A010C7d01b50e0d17dc79C8");
  await expect(form.getByRole("list", { name: "Registration checks" })).toBeVisible();
  expect(await horizontalOverflow(page)).toBeLessThanOrEqual(0);
});
