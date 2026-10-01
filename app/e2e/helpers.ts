import type { Page } from "@playwright/test";

export const RPC = process.env.E2E_RPC ?? "http://127.0.0.1:8545";
/** anvil account #1: the demo depositor (unlocked on anvil, so the mock wallet can send from it). */
export const ACCOUNT = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8";
export const LOCAL = 31337;

/** Same key as EligibilityGate's ACK_KEY. */
export const ACK_KEY = "strike.ack.v1";

/** Pre-acknowledge the app's first-visit eligibility notice, so tests land straight on the page. */
export async function acknowledge(page: Page) {
  await page.addInitScript((key) => {
    try {
      window.localStorage.setItem(key, "1");
    } catch {
      // opaque origin (about:blank): nothing to do
    }
  }, ACK_KEY);
}

/** Real layout width: lift the body's overflow-x safety clip, then compare. */
export async function horizontalOverflow(page: Page): Promise<number> {
  return page.evaluate(() => {
    document.body.style.overflowX = "visible";
    const extra = document.documentElement.scrollWidth - document.documentElement.clientWidth;
    document.body.style.overflowX = "";
    return extra;
  });
}

/** Is a Strike devnet reachable at RPC? Local-data tests skip without one. */
export async function devnetUp(): Promise<boolean> {
  try {
    const res = await fetch(RPC, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_chainId", params: [] }),
    });
    const json = (await res.json()) as { result?: string };
    return json.result === "0x7a69";
  } catch {
    return false;
  }
}

/** A minimal EIP-1193 wallet: accounts and chain answered locally, everything else forwarded to anvil. `account`
 *  must be one of anvil's unlocked dev accounts (default: #1). `extra` accounts are connected too (after the
 *  selected one), so the app can ask them for signatures (anvil signs `eth_signTypedData_v4` for its dev accounts). */
export async function installMockWallet(page: Page, account: string = ACCOUNT, extra: string[] = []) {
  await page.addInitScript(
    ({ rpc, account, extra, chainId }) => {
      let id = 0;
      const listeners: Record<string, ((...args: unknown[]) => void)[]> = {};
      const forward = async (method: string, params: unknown) => {
        const res = await fetch(rpc, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ jsonrpc: "2.0", id: ++id, method, params: params ?? [] }),
        });
        const json = await res.json();
        if (json.error) {
          const err = new Error(json.error.message) as Error & { code?: number; data?: unknown };
          err.code = json.error.code;
          err.data = json.error.data;
          throw err;
        }
        return json.result;
      };
      const provider = {
        isMockWallet: true,
        async request({ method, params }: { method: string; params?: unknown[] }) {
          switch (method) {
            case "eth_requestAccounts":
            case "eth_accounts":
              return [account, ...extra];
            case "eth_chainId":
              return `0x${chainId.toString(16)}`;
            case "net_version":
              return String(chainId);
            case "wallet_requestPermissions":
            case "wallet_getPermissions":
              return [{ parentCapability: "eth_accounts" }];
            case "wallet_switchEthereumChain": {
              const target = parseInt((params?.[0] as { chainId: string }).chainId, 16);
              if (target === chainId) return null;
              const err = new Error("Unrecognized chain") as Error & { code?: number };
              err.code = 4902;
              throw err;
            }
            case "wallet_addEthereumChain":
              return null;
            default:
              return forward(method, params);
          }
        },
        on(event: string, fn: (...args: unknown[]) => void) {
          (listeners[event] ??= []).push(fn);
        },
        removeListener(event: string, fn: (...args: unknown[]) => void) {
          listeners[event] = (listeners[event] ?? []).filter((f) => f !== fn);
        },
      };
      (window as unknown as { ethereum: unknown }).ethereum = provider;
    },
    { rpc: RPC, account, extra, chainId: LOCAL },
  );
}

export async function connectWallet(page: Page, mobile: boolean) {
  if (mobile) {
    await page.getByRole("button", { name: "Menu" }).click();
    await page.getByRole("dialog").getByRole("button", { name: "Connect wallet" }).click();
    await page.getByRole("dialog").getByRole("button", { name: "Close" }).click();
  } else {
    await page.getByRole("banner").getByRole("button", { name: "Connect wallet" }).click();
  }
}

/** Make every scroll-reveal element visible (for full-page captures). */
export async function revealAll(page: Page) {
  await page.evaluate(() =>
    document.querySelectorAll("[data-reveal]").forEach((el) => el.classList.add("is-in")),
  );
}

export async function settle(page: Page, ms = 900) {
  await page.waitForTimeout(ms);
}
