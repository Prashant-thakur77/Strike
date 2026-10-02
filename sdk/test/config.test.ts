// strike.config.json: valid against its JSON Schema, every deployment file it lists exists, every address in it is
// checksummed, nothing in it looks like a secret, every secret variable the code reads is named in it, and the copy
// bundled into the SDK and the generated deployments map match it. Plus loadStrikeConfig()'s file search.
import { Ajv } from "ajv";
import { getAddress, isAddress } from "viem";
import { describe, expect, it } from "vitest";
import {
  loadStrikeConfig,
  locateStrikeConfig,
  secretLikeValues,
  validateStrikeConfig,
  type StrikeConfig,
} from "../src/config.js";
import { bundledStrikeConfig } from "../src/config.generated.js";
import { deployments, secondaryDeployments } from "../src/deployments.js";
import fileConfig from "../../strike.config.json" with { type: "json" };
import schema from "../../strike.config.schema.json" with { type: "json" };

interface Fs {
  existsSync(p: string): boolean;
  readFileSync(p: string, enc: "utf8"): string;
  readdirSync(p: string, o: { recursive: true }): string[];
  mkdtempSync(prefix: string): string;
  mkdirSync(p: string, o: { recursive: true }): void;
  writeFileSync(p: string, data: string): void;
  rmSync(p: string, o: { recursive: true; force: true }): void;
}
const proc = (globalThis as unknown as { process: { getBuiltinModule(id: string): unknown; cwd(): string } })
  .process;
const fs = proc.getBuiltinModule("node:fs") as Fs;
const os = proc.getBuiltinModule("node:os") as { tmpdir(): string };
const ROOT = new URL("../../", import.meta.url).pathname;
const read = (rel: string) => JSON.parse(fs.readFileSync(ROOT + rel, "utf8")) as Record<string, unknown>;

const config = fileConfig as unknown as StrikeConfig & { $schema?: string };
const chains = Object.entries(config.chains);

/** Every string in a JSON value, with its path. */
function strings(v: unknown, path = ""): [string, string][] {
  if (typeof v === "string") return [[path, v]];
  if (Array.isArray(v)) return v.flatMap((x, i) => strings(x, `${path}[${i}]`));
  if (v && typeof v === "object")
    return Object.entries(v).flatMap(([k, x]) => strings(x, path ? `${path}.${k}` : k));
  return [];
}

describe("strike.config.json", () => {
  it("is valid against strike.config.schema.json", () => {
    const ajv = new Ajv({ allErrors: true, strict: true });
    const validate = ajv.compile(schema);
    const ok = validate(config);
    expect(validate.errors ?? []).toEqual([]);
    expect(ok).toBe(true);
  });

  it.each([
    ["a secret value instead of a name", (c: any) => (c.secrets.alchemyKey = "abcdefgh12345678")],
    ["an Alchemy URL with a key", (c: any) => (c.chains["46630"].rpc.alchemy += "/abcdefgh12345678")],
    ["an unknown key", (c: any) => (c.chains["46630"].rpcUrl = "https://x.example")],
    ["a deployment outside contracts/deployments", (c: any) => c.chains["46630"].deployments.push("x.json")],
    ["a non-numeric chain id", (c: any) => (c.chains.testnet = c.chains["46630"])],
    ["a missing secret role", (c: any) => delete c.secrets.databaseUrl],
  ])("the schema rejects %s", (_what, change) => {
    const c = structuredClone(config);
    change(c);
    expect(new Ajv({ strict: true }).compile(schema)(c)).toBe(false);
  });

  it("passes the runtime validator", () => {
    expect(() => validateStrikeConfig(structuredClone(config))).not.toThrow();
  });

  it("has the chains, services and secret names the plan's schema names", () => {
    expect(Object.keys(config.chains)).toEqual(expect.arrayContaining(["46630", "421614", "4663", "31337"]));
    expect(config.services).toMatchObject({
      app: expect.any(String),
      mcp: expect.any(String),
      indexer: { port: expect.any(Number) },
      telegramBot: expect.any(String),
    });
    expect(config.secrets).toMatchObject({
      deployerKey: "PRIVATE_KEY",
      agentSignerKey: "AGENT_SIGNER_KEY",
      alchemyKey: "ALCHEMY_API_KEY",
      telegramToken: "TELEGRAM_BOT_TOKEN",
      databaseUrl: "DATABASE_URL",
    });
    expect(config.chains[String(config.defaultChainId)]).toBeDefined();
  });

  it.each(chains)("chain %s: every deployment file it lists exists and is for that chain", (id, chain) => {
    for (const file of chain.deployments) {
      if (chain.local && !fs.existsSync(ROOT + file)) continue; // written by scripts/demo-local.sh, not in git
      expect(fs.existsSync(ROOT + file), `${file} is missing`).toBe(true);
      expect(String(read(file).chainId), `${file} chainId`).toBe(id);
      const vaults = file.replace(/\.json$/, "-vaults.json");
      if (!chain.local) expect(fs.existsSync(ROOT + vaults), `${vaults} is missing`).toBe(true);
    }
  });

  it("names a mainnet feeds chain that has the feeds, for every chain that mirrors", () => {
    for (const [id, chain] of chains) {
      if (!chain.mainnetFeedsChain) continue;
      const source = config.chains[chain.mainnetFeedsChain];
      expect(source?.stocks, `chain ${id}: ${chain.mainnetFeedsChain} has no stocks`).toBeDefined();
    }
  });

  it("has every address EIP-55 checksummed", () => {
    const addresses = strings(config).filter(([, s]) => /^0x[0-9a-fA-F]{40}$/.test(s));
    expect(addresses.length).toBeGreaterThan(0);
    for (const [path, a] of addresses) expect(a, path).toBe(getAddress(a));
  });

  it("lists deployment files whose addresses are valid (mixed case only with a correct checksum)", () => {
    for (const [, chain] of chains) {
      for (const file of chain.deployments) {
        if (!fs.existsSync(ROOT + file)) continue;
        for (const [path, a] of strings(read(file)).filter(([, s]) => /^0x[0-9a-fA-F]{40}$/.test(s)))
          expect(isAddress(a, { strict: true }), `${file} ${path}`).toBe(true);
      }
    }
  });

  it("holds no secret values: the secrets block names environment variables, nothing looks like a key", () => {
    expect(secretLikeValues(config)).toEqual([]);
    for (const [role, name] of Object.entries(config.secrets))
      expect(name, role).toMatch(/^[A-Z][A-Z0-9_]*$/);
  });

  it("names every secret variable the code reads", () => {
    // Variables that look like secrets but are not: step-local aliases of listed secrets in agent.yml, anvil's
    // public dev keys in demo-local.sh, a localStorage key, a contract address, a test placeholder, a number.
    const notSecrets = new Set([
      "KEY",
      "SIGNER_KEY",
      "AGENT2_KEY",
      "DEPLOYER_KEY",
      "BUYER_KEY",
      "ACK_KEY",
      "OPTION_TOKEN",
      "STRIKE_OPTION_TOKEN",
      "FAKE_TOKEN",
      "PER_TOKEN",
      // the indexer's Postgres advisory-lock ids (services/indexer/src/db.ts)
      "MIGRATION_LOCK_KEY",
      "WRITER_LOCK_KEY",
    ]);
    const dirs = [
      "sdk/src",
      "mcp/src",
      "mcp/scripts",
      "bots/telegram/src",
      "agents/example/src",
      "app/src",
      "app/scripts",
      "scripts",
      ".github/workflows",
      "infra",
      "services",
    ];
    const listed = new Set(Object.values(config.secrets));
    const unlisted = new Map<string, string>();
    for (const dir of dirs) {
      if (!fs.existsSync(ROOT + dir)) continue;
      for (const f of fs.readdirSync(ROOT + dir, { recursive: true })) {
        if (!/\.(ts|tsx|mjs|js|sh|ya?ml|json)$/.test(f) || /(^|\/)(abi|node_modules|test|data)\//.test(f))
          continue;
        if (/generated/.test(f)) continue;
        const text = fs.readFileSync(`${ROOT}${dir}/${f}`, "utf8");
        for (const m of text.matchAll(/\b[A-Z][A-Z0-9_]*(?:_KEY|_TOKEN|_SECRET|_PASSWORD|DATABASE_URL)\b/g)) {
          if (!listed.has(m[0]) && !notSecrets.has(m[0])) unlisted.set(m[0], `${dir}/${f}`);
        }
      }
    }
    expect(Object.fromEntries(unlisted)).toEqual({});
  });

  it("matches the copy bundled into the SDK (regenerate: node scripts/export-abis.mjs --skip-abis)", () => {
    const { $schema: _, ...withoutSchema } = config;
    expect(bundledStrikeConfig).toEqual(withoutSchema);
  });

  it("matches the generated deployments map: each chain's files, the primary first", () => {
    const withVaults = (file: string) => {
      const vaults = file.replace(/\.json$/, "-vaults.json");
      return { ...read(file), vaults: fs.existsSync(ROOT + vaults) ? read(vaults) : {} };
    };
    for (const [id, chain] of chains) {
      const files = chain.deployments.filter((f) => fs.existsSync(ROOT + f));
      if (!files.length) {
        if (!chain.local) expect(deployments[id], `chain ${id}`).toBeUndefined();
        continue;
      }
      expect(deployments[id], `chain ${id} primary`).toEqual(withVaults(files[0]!));
      expect(secondaryDeployments[id] ?? [], `chain ${id} secondary`).toEqual(files.slice(1).map(withVaults));
    }
    const listedChains = new Set(chains.filter(([, c]) => c.deployments.length).map(([id]) => id));
    for (const id of Object.keys(deployments))
      expect(listedChains.has(id), `chain ${id} not in config`).toBe(true);
  });
});

describe("secretLikeValues", () => {
  type Plant = [
    what: string,
    path: (c: Record<string, any>) => [Record<string, unknown>, string],
    value: string,
  ];
  const planted: Plant[] = [
    ["a private key", (c) => [c.secrets, "deployerKey"], `0x${"ab".repeat(32)}`],
    [
      "an Alchemy key in a URL",
      (c) => [c.services, "app"],
      "https://robinhood-testnet.g.alchemy.com/v2/AbCdEf123456789",
    ],
    ["a Telegram token", (c) => [c.services, "telegramBot"], "123456789:AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsaw"],
    ["credentials in a URL", (c) => [c.services, "mcp"], "postgres://strike:hunter2@db:5432/strike"],
    ["a key in a query string", (c) => [c.services, "app"], "https://example.org/rpc?apikey=abc123"],
    ["an Anthropic key", (c) => [c.services, "app"], "sk-ant-api03-abcdefghijklmnop"],
    ["a GitHub token", (c) => [c.services, "repository"], "ghp_0123456789abcdefghijABCDEFGHIJ012345"],
    [
      "a long random string",
      (c) => [c.chains["46630"].rpc, "public"],
      "https://rpc.example.org/Zq8xYw2Vb7Nc5Md3Le1Kf9Jg6Hh4Gi0F",
    ],
    [
      "a mnemonic",
      (c) => [c.chains["46630"], "name"],
      "test test test test test test test test test test test junk",
    ],
    ["a value in secrets", (c) => [c.secrets, "alchemyKey"], "abcdefgh12345678"],
  ];
  it.each(planted)("flags %s, by path and without echoing it", (_what, at, value) => {
    const c = structuredClone(bundledStrikeConfig) as unknown as Record<string, any>;
    const [obj, key] = at(c);
    obj[key] = value;
    const found = secretLikeValues(c);
    expect(found.length).toBe(1);
    expect(found[0]).toContain(key);
    expect(found[0]).not.toContain(value);
    expect(() => validateStrikeConfig(c)).toThrow(/looks like a secret/);
    try {
      validateStrikeConfig(c);
    } catch (e) {
      expect((e as Error).message).not.toContain(value);
    }
  });

  it("does not flag addresses, endpoints or variable names", () => {
    expect(secretLikeValues(bundledStrikeConfig)).toEqual([]);
  });
});

describe("loadStrikeConfig", () => {
  const scratch = () => fs.mkdtempSync(`${os.tmpdir()}/strike-config-`);
  const write = (dir: string, c: unknown) => fs.writeFileSync(`${dir}/strike.config.json`, JSON.stringify(c));

  it("reads the repository's strike.config.json from a package directory (walks up)", () => {
    expect(locateStrikeConfig({ cwd: `${ROOT}sdk/src` })).toBe(`${ROOT}strike.config.json`);
    const { $schema: _, ...withoutSchema } = config;
    expect(loadStrikeConfig({ cwd: `${ROOT}sdk` })).toEqual(withoutSchema);
  });

  it("returns the bundled copy without a file or with fs: false", () => {
    const dir = scratch();
    try {
      expect(locateStrikeConfig({ cwd: dir, env: {} })).toBeNull();
      expect(loadStrikeConfig({ cwd: dir, env: {} })).toBe(bundledStrikeConfig);
      expect(loadStrikeConfig({ fs: false })).toBe(bundledStrikeConfig);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("follows STRIKE_CONFIG and reads the file each component would", () => {
    const dir = scratch();
    try {
      const other = structuredClone(bundledStrikeConfig) as StrikeConfig;
      other.chains["46630"]!.rpc.public = "https://rpc.example.org/46630";
      write(dir, other);
      const loaded = loadStrikeConfig({ env: { STRIKE_CONFIG: `${dir}/strike.config.json` } });
      expect(loaded.chains["46630"]!.rpc.public).toBe("https://rpc.example.org/46630");
      expect(loadStrikeConfig({ cwd: dir, env: {} }).chains["46630"]!.rpc.public).toBe(
        "https://rpc.example.org/46630",
      );
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("throws on a file that is invalid or holds a secret, naming the problem", () => {
    const dir = scratch();
    try {
      fs.mkdirSync(`${dir}/a`, { recursive: true });
      write(`${dir}/a`, { ...structuredClone(bundledStrikeConfig), version: 2, defaultChainId: 1 });
      expect(() => loadStrikeConfig({ cwd: `${dir}/a`, env: {} })).toThrow(
        /version must be 1[\s\S]*defaultChainId 1/,
      );
      fs.mkdirSync(`${dir}/b`, { recursive: true });
      const leaked = structuredClone(bundledStrikeConfig) as StrikeConfig;
      leaked.secrets.alchemyKey = "abcdefghijklmnopqrstuvwxyz012345";
      write(`${dir}/b`, leaked);
      expect(() => loadStrikeConfig({ cwd: `${dir}/b`, env: {} })).toThrow(/secrets\.alchemyKey/);
      fs.writeFileSync(`${dir}/c.json`, "{ not json");
      expect(() => loadStrikeConfig({ path: `${dir}/c.json` })).toThrow(/cannot read/);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("scripts/config.sh and scripts/rpc.sh (what keeper.sh and weekly-agent.sh read)", () => {
  const cp = proc.getBuiltinModule("node:child_process") as {
    execFileSync(
      cmd: string,
      args: string[],
      o: { env: Record<string, string | undefined>; encoding: "utf8" },
    ): string;
  };
  const env = (globalThis as unknown as { process: { env: Record<string, string | undefined> } }).process.env;
  const script = [
    `. "${ROOT}scripts/rpc.sh"`,
    'for c in 46630 421614 4663 42161 31337; do echo "$c $(rpc_public_url $c) $(rpc_alchemy_network $c || echo none)"; done',
    "rpc_public_url 1 || echo 'no chain 1'",
    "strike_config_get defaultChainId",
    "strike_config_get chains 46630 mainnetFeedsChain",
    'for s in $(strike_config_keys chains 4663 stocks); do echo "$s $(strike_config_get chains 4663 stocks $s feed)"; done',
    "strike_deployment_files 46630",
    "strike_config_get services repository",
  ].join("\n");
  const run = (reader: string) =>
    cp.execFileSync("bash", ["-c", script], {
      env: { ...env, STRIKE_CONFIG_READER: reader },
      encoding: "utf8",
    });

  it("prints the config's values, the same with jq and with node", async () => {
    const { publicRpcUrl, ALCHEMY_NETWORKS } = await import("../src/rpc.js");
    const byNode = run("node");
    const lines = byNode.trim().split("\n");
    for (const id of [46630, 421614, 4663, 42161, 31337])
      expect(lines).toContain(`${id} ${publicRpcUrl(id)} ${ALCHEMY_NETWORKS[id] ?? "none"}`);
    expect(lines).toContain("no chain 1");
    expect(lines).toContain(String(config.defaultChainId));
    for (const [sym, { feed }] of Object.entries(config.chains["4663"]!.stocks!))
      expect(lines).toContain(`${sym} ${feed}`);
    expect(lines).toContain(`${ROOT}contracts/deployments/46630.json`);
    expect(lines).toContain(`${ROOT}contracts/deployments/46630-v3.json`);
    expect(lines.indexOf(`${ROOT}contracts/deployments/46630.json`)).toBeLessThan(
      lines.indexOf(`${ROOT}contracts/deployments/46630-v3.json`),
    );
    let hasJq = true;
    try {
      cp.execFileSync("bash", ["-c", "command -v jq"], { env, encoding: "utf8" });
    } catch {
      hasJq = false;
    }
    if (hasJq) expect(run("jq")).toBe(byNode);
  });
});
