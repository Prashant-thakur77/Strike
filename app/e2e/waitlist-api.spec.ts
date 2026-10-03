import { expect, test } from "@playwright/test";
import {
  ALG,
  decryptJson,
  encryptJson,
  entryPath,
  hmacHex,
  keyId,
  pemToDer,
  type StoredEntry,
} from "../src/lib/waitlistCrypto";
import {
  CONSENT_TEXT,
  ENTRY_SCHEMA,
  INTERESTS,
  MESSAGES,
  NOTE_MAX,
  isBot,
  validateEntry,
  type Entry,
} from "../src/lib/waitlistEntry";
import { WAITLIST_PUBLIC_KEY_ID, WAITLIST_PUBLIC_KEY_PEM } from "../src/lib/waitlistKey";
import {
  COUNT_TTL_MS,
  CountCache,
  MAX_BODY_BYTES,
  MemoryStore,
  RATE_LIMIT,
  RateLimiter,
  UNAVAILABLE,
  clientIp,
  handleSignup,
  type SignupDeps,
} from "../src/lib/waitlistServer";

// POST /api/waitlist's logic (D46), run in the test process with an in-memory store and a fake clock: no network, no
// Blob token. The key pair is generated here at runtime and never written anywhere; the salt is made up. The last
// group calls the built route, which has no WAITLIST_SALT or Blob token in CI and so must refuse (fail closed).

const SALT = "spec-salt-not-a-secret-0123456789abcdef";

async function testKeys() {
  const kp = await crypto.subtle.generateKey(
    { name: "RSA-OAEP", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
    true,
    ["encrypt", "decrypt"],
  );
  const pem = (der: ArrayBuffer, label: string) =>
    `-----BEGIN ${label}-----\n${Buffer.from(der).toString("base64")}\n-----END ${label}-----\n`;
  return {
    publicPem: pem(await crypto.subtle.exportKey("spki", kp.publicKey), "PUBLIC KEY"),
    // Built from parts so no PEM header for a private key appears in the source.
    privatePem: pem(await crypto.subtle.exportKey("pkcs8", kp.privateKey), ["PRIVATE", "KEY"].join(" ")),
  };
}

let keys: Awaited<ReturnType<typeof testKeys>>;
test.beforeAll(async () => {
  keys = await testKeys();
});

const VALID = {
  email: "  Ada.Lovelace@Example.com ",
  interests: ["covered-calls", "running-agent"],
  name: " Ada ",
  telegram: "ada_lovelace",
  wallet: "0x70997970C51812dc3A010C7d01b50e0d17dc79C8",
  note: " Would love a NVDA vault. ",
  notUsPerson: true,
  consent: true,
  website: "",
};

function deps(over: Partial<SignupDeps> = {}) {
  let t = Date.parse("2026-10-03T12:00:00Z");
  const clock = {
    advance: (ms: number) => {
      t += ms;
    },
    now: () => t,
  };
  const store = new MemoryStore();
  const errors: string[] = [];
  const d: SignupDeps = {
    salt: SALT,
    publicKeyPem: keys.publicPem,
    store,
    limiter: new RateLimiter(RATE_LIMIT.max, RATE_LIMIT.windowMs, clock.now),
    now: () => new Date(clock.now()),
    onError: (stage, err) => errors.push(`${stage}: ${String(err)}`),
    ...over,
  };
  return { d, store, clock, errors };
}

const send = (body: unknown, d: SignupDeps, ip = "203.0.113.7") => handleSignup(JSON.stringify(body), ip, d);

test.describe("validation", () => {
  test("a full entry is cleaned: email trimmed and lowercased, handle given its @, interests in a fixed order", () => {
    const now = new Date("2026-10-03T12:00:00Z");
    const r = validateEntry({ ...VALID, interests: ["running-agent", "covered-calls"] }, now);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.entry satisfies Entry).toEqual({
      email: "ada.lovelace@example.com",
      interests: ["covered-calls", "running-agent"],
      name: "Ada",
      telegram: "@ada_lovelace",
      wallet: "0x70997970C51812dc3A010C7d01b50e0d17dc79C8",
      note: "Would love a NVDA vault.",
      notUsPerson: true,
      consent: true,
      consentText: CONSENT_TEXT,
      submittedAt: now.toISOString(),
    });
  });

  test("only email, one interest and the two confirmations are required", () => {
    const r = validateEntry({
      email: "a@b.co",
      interests: ["buying-options"],
      notUsPerson: true,
      consent: true,
    });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.entry).toMatchObject({ name: "", telegram: "", wallet: "", note: "" });
  });

  test("emails: missing, malformed and too long are refused with a plain message", () => {
    for (const email of ["", "   ", undefined, 42]) {
      const r = validateEntry({ ...VALID, email });
      expect(r.ok ? null : r.errors.email).toBe(MESSAGES.emailMissing);
    }
    for (const email of [
      "ada",
      "ada@",
      "@example.com",
      "ada@example",
      "ada @example.com",
      "ada@exa mple.com",
      "a@b..co",
    ]) {
      const r = validateEntry({ ...VALID, email });
      expect(r.ok ? `${email} passed` : r.errors.email).toBe(MESSAGES.emailInvalid);
    }
    const long = `${"a".repeat(250)}@example.com`;
    const r = validateEntry({ ...VALID, email: long });
    expect(r.ok ? null : r.errors.email).toBe(MESSAGES.emailInvalid);
  });

  test("interests: at least one, and only the four known ones", () => {
    for (const interests of [[], undefined, "covered-calls", ["covered-calls", "free-money"], [1]]) {
      const r = validateEntry({ ...VALID, interests });
      expect(r.ok ? "passed" : r.errors.interests).toBe(MESSAGES.interests);
    }
    const all = validateEntry({ ...VALID, interests: INTERESTS.map((i) => i.id) });
    expect(all.ok).toBe(true);
  });

  test("Telegram handles: @ and 5 to 32 letters, digits or underscores, starting with a letter", () => {
    for (const telegram of ["@satoshi_n", "satoshi_n", "@abcde", `@a${"b".repeat(31)}`]) {
      expect(validateEntry({ ...VALID, telegram }).ok, telegram).toBe(true);
    }
    for (const telegram of [
      "@abc",
      "@1abcde",
      "@has space",
      "@dash-name",
      `@a${"b".repeat(32)}`,
      "@@double",
    ]) {
      const r = validateEntry({ ...VALID, telegram });
      expect(r.ok ? `${telegram} passed` : r.errors.telegram).toBe(MESSAGES.telegram);
    }
  });

  test("wallets: 0x and exactly 40 hex characters", () => {
    for (const wallet of [
      "0x" + "a".repeat(39),
      "0x" + "g".repeat(40),
      "70997970C51812dc3A010C7d01b50e0d17dc79C8",
      "0x" + "a".repeat(41),
    ]) {
      const r = validateEntry({ ...VALID, wallet });
      expect(r.ok ? `${wallet} passed` : r.errors.wallet).toBe(MESSAGES.wallet);
    }
  });

  test("the note: up to 500 characters, no control characters; names up to 80", () => {
    expect(validateEntry({ ...VALID, note: "x".repeat(NOTE_MAX) }).ok).toBe(true);
    const long = validateEntry({ ...VALID, note: "x".repeat(NOTE_MAX + 1) });
    expect(long.ok ? null : long.errors.note).toBe(MESSAGES.noteLong);
    const ctrl = validateEntry({ ...VALID, note: "hi\u0007there" });
    expect(ctrl.ok ? null : ctrl.errors.note).toBe(MESSAGES.control);
    expect(validateEntry({ ...VALID, note: "two\nlines" }).ok).toBe(true);
    const name = validateEntry({ ...VALID, name: "n".repeat(81) });
    expect(name.ok ? null : name.errors.name).toBe(MESSAGES.nameLong);
  });

  test("both confirmations must be true (the boolean, not a truthy string)", () => {
    const r = validateEntry({ ...VALID, notUsPerson: "true", consent: false });
    expect(r.ok ? null : r.errors).toEqual({ notUsPerson: MESSAGES.notUsPerson, consent: MESSAGES.consent });
  });

  test("a body that is not an object fails every required field", () => {
    for (const body of [null, "x", 1, []]) {
      const r = validateEntry(body);
      expect(r.ok ? [] : Object.keys(r.errors).sort()).toEqual([
        "consent",
        "email",
        "interests",
        "notUsPerson",
      ]);
    }
  });
});

test.describe("the route's logic", () => {
  test("a sign-up is stored once, encrypted, at waitlist/<hmac>.json, and decrypts to the cleaned entry", async () => {
    const { d, store } = deps();
    const res = await send(VALID, d);
    expect(res).toEqual({ status: 200, body: { ok: true, status: "created" } });
    expect([...store.blobs.keys()]).toEqual([await entryPath("ada.lovelace@example.com", SALT)]);
    const [path, raw] = [...store.blobs.entries()][0];
    expect(path).toMatch(/^waitlist\/[0-9a-f]{64}\.json$/);

    // Nothing in the path or the stored file is in plain text.
    for (const plain of [
      "lovelace",
      "example.com",
      "NVDA vault",
      "0x70997970",
      "covered-calls",
      "Contact me",
    ]) {
      expect(path).not.toContain(plain);
      expect(raw).not.toContain(plain);
    }
    const stored = JSON.parse(raw) as StoredEntry;
    expect(Object.keys(stored).sort()).toEqual([
      "alg",
      "created",
      "data",
      "iv",
      "key",
      "kid",
      "updated",
      "v",
    ]);
    expect(stored).toMatchObject({
      v: ENTRY_SCHEMA,
      alg: ALG,
      kid: await keyId(keys.publicPem),
      created: "2026-10-03T12:00:00.000Z",
      updated: "2026-10-03T12:00:00.000Z",
    });
    const entry = await decryptJson<Entry>(stored, keys.privatePem);
    expect(entry).toMatchObject({
      email: "ada.lovelace@example.com",
      telegram: "@ada_lovelace",
      consent: true,
    });
  });

  test("the same email, in any case, lands on the same path: 'updated', the first sign-up time kept", async () => {
    const { d, store, clock } = deps();
    expect((await send(VALID, d)).body).toEqual({ ok: true, status: "created" });
    clock.advance(60_000);
    const again = await send(
      { ...VALID, email: "ADA.LOVELACE@example.COM", note: "Changed my mind: TSLA." },
      d,
    );
    expect(again.body).toEqual({ ok: true, status: "updated" });
    expect(store.blobs.size).toBe(1);
    const stored = (await store.read(await entryPath("ada.lovelace@example.com", SALT)))!;
    expect(stored.created).toBe("2026-10-03T12:00:00.000Z");
    expect(stored.updated).toBe("2026-10-03T12:01:00.000Z");
    expect((await decryptJson<Entry>(stored, keys.privatePem)).note).toBe("Changed my mind: TSLA.");

    expect((await send({ ...VALID, email: "grace@example.com" }, d)).body).toEqual({
      ok: true,
      status: "created",
    });
    expect(store.blobs.size).toBe(2);
  });

  test("the path is a keyed hash: another salt gives another path, the same salt the same one", async () => {
    const a = await entryPath("ada@example.com", SALT);
    expect(await entryPath(" ADA@example.com ", SALT)).toBe(a);
    expect(await entryPath("ada@example.com", `${SALT}x`)).not.toBe(a);
    // HMAC-SHA256, checked against Node's own implementation.
    const { createHmac } = await import("node:crypto");
    expect(a).toBe(`waitlist/${createHmac("sha256", SALT).update("ada@example.com").digest("hex")}.json`);
    expect(await hmacHex("x", SALT)).toHaveLength(64);
  });

  test("the honeypot: a filled hidden field is answered like a sign-up and stores nothing", async () => {
    const { d, store } = deps();
    expect(isBot({ website: "https://spam.example" })).toBe(true);
    expect(isBot({ website: "  " })).toBe(false);
    expect(isBot(null)).toBe(false);
    const res = await send({ ...VALID, website: "https://spam.example" }, d);
    expect(res).toEqual({ status: 200, body: { ok: true, status: "created" } });
    expect(store.blobs.size).toBe(0);
  });

  test("the rate limit: 5 attempts per IP per 10 minutes, then 429 with Retry-After; other IPs unaffected", async () => {
    expect(RATE_LIMIT).toEqual({ max: 5, windowMs: 600_000 });
    const { d, clock } = deps();
    for (let i = 0; i < 5; i++) {
      expect((await send({ ...VALID, email: `p${i}@example.com` }, d)).status).toBe(200);
      clock.advance(1_000);
    }
    const blocked = await send(VALID, d);
    expect(blocked.status).toBe(429);
    expect(blocked.body).toMatchObject({ ok: false, retryAfter: 595 });
    expect(blocked.headers).toEqual({ "Retry-After": "595" });
    // Another IP has its own allowance.
    expect((await send(VALID, d, "198.51.100.9")).status).toBe(200);
    // The first attempt leaves the window 10 minutes after it was made, so one more is allowed.
    clock.advance(595_000);
    expect((await send(VALID, d)).status).toBe(200);
    expect((await send(VALID, d)).status).toBe(429);
  });

  test("the limiter itself: sliding window, independent keys", () => {
    let t = 0;
    const l = new RateLimiter(2, 1_000, () => t);
    expect(l.hit("a")).toEqual({ ok: true });
    expect(l.hit("a")).toEqual({ ok: true });
    expect(l.hit("a")).toEqual({ ok: false, retryAfter: 1 });
    expect(l.hit("b")).toEqual({ ok: true });
    t = 1_000;
    expect(l.hit("a")).toEqual({ ok: true });
  });

  test("fail closed: no salt, a short salt or no store answers 503 and stores nothing", async () => {
    for (const over of [{ salt: undefined }, { salt: "" }, { salt: "short-salt" }, { store: null }]) {
      const { d, store } = deps(over);
      const res = await send(VALID, d);
      expect(res).toEqual({ status: 503, body: { ok: false, error: UNAVAILABLE } });
      expect(store.blobs.size).toBe(0);
    }
    expect(UNAVAILABLE).toMatch(/^Sign-up is temporarily unavailable/);
  });

  test("bad requests: field errors (400), unreadable JSON (400), too large (413)", async () => {
    const { d, store } = deps();
    const bad = await send({ ...VALID, email: "nope", wallet: "0x12" }, d);
    expect(bad.status).toBe(400);
    expect(bad.body).toMatchObject({
      ok: false,
      fields: { email: MESSAGES.emailInvalid, wallet: MESSAGES.wallet },
    });
    expect((await handleSignup("{not json", "1.1.1.1", d)).status).toBe(400);
    expect((await handleSignup("x".repeat(MAX_BODY_BYTES + 1), "1.1.1.2", d)).status).toBe(413);
    expect((await handleSignup(null, "1.1.1.3", d)).status).toBe(413);
    expect(store.blobs.size).toBe(0);
  });

  test("a store that fails answers 502 with a retry message, and the log names the stage, not the email", async () => {
    const broken = new MemoryStore();
    broken.write = async () => {
      throw new Error("BlobServiceNotAvailable");
    };
    const { d, errors } = deps({ store: broken });
    const res = await send(VALID, d);
    expect(res.status).toBe(502);
    expect(res.body).toMatchObject({ ok: false, error: expect.stringMatching(/try again/) });
    expect(errors).toEqual(["write: Error: BlobServiceNotAvailable"]);
    expect(errors.join(" ")).not.toContain("example.com");
  });

  test("the count is cached for 60 s", async () => {
    let t = 0;
    const store = new MemoryStore();
    let lists = 0;
    const count = store.count.bind(store);
    store.count = async () => {
      lists++;
      return count();
    };
    const cache = new CountCache(COUNT_TTL_MS, () => t);
    expect(await cache.get(store)).toBe(0);
    store.blobs.set("waitlist/a.json", "{}");
    t = 59_999;
    expect(await cache.get(store)).toBe(0);
    t = 60_000;
    expect(await cache.get(store)).toBe(1);
    expect(lists).toBe(2);
  });

  test("the client IP is the first x-forwarded-for hop, else x-real-ip", () => {
    expect(clientIp(new Headers({ "x-forwarded-for": "203.0.113.7, 10.0.0.1" }))).toBe("203.0.113.7");
    expect(clientIp(new Headers({ "x-real-ip": "198.51.100.2" }))).toBe("198.51.100.2");
    expect(clientIp(new Headers())).toBe("unknown");
  });
});

test.describe("encryption", () => {
  test("round trip: encrypt with the public key, decrypt with the private key; a fresh key and nonce each time", async () => {
    const value = { email: "ada@example.com", note: "ünïcödé ✓" };
    const meta = { v: 1, created: "c", updated: "u" };
    const a = await encryptJson(value, keys.publicPem, meta);
    const b = await encryptJson(value, keys.publicPem, meta);
    expect(a.data).not.toBe(b.data);
    expect(a.iv).not.toBe(b.iv);
    expect(a.key).not.toBe(b.key);
    expect(Buffer.from(a.iv, "base64")).toHaveLength(12);
    expect(Buffer.from(a.key, "base64")).toHaveLength(256);
    expect(await decryptJson(a, keys.privatePem)).toEqual(value);
    expect(await decryptJson(b, keys.privatePem)).toEqual(value);
  });

  test("another key, a changed byte or an unknown algorithm does not decrypt", async () => {
    const stored = await encryptJson({ x: 1 }, keys.publicPem, { v: 1, created: "c", updated: "u" });
    const other = await testKeys();
    await expect(decryptJson(stored, other.privatePem)).rejects.toThrow();
    const bytes = Buffer.from(stored.data, "base64");
    bytes[0] ^= 1;
    await expect(
      decryptJson({ ...stored, data: bytes.toString("base64") }, keys.privatePem),
    ).rejects.toThrow();
    await expect(decryptJson({ ...stored, alg: "none" as typeof ALG }, keys.privatePem)).rejects.toThrow(
      /unknown algorithm/,
    );
  });

  test("the committed key is a 3072-bit RSA public key, and its id matches", async () => {
    expect(WAITLIST_PUBLIC_KEY_PEM).toContain("-----BEGIN PUBLIC KEY-----");
    expect(WAITLIST_PUBLIC_KEY_PEM).not.toMatch(/PRIVATE/);
    expect(await keyId(WAITLIST_PUBLIC_KEY_PEM)).toBe(WAITLIST_PUBLIC_KEY_ID);
    const key = await crypto.subtle.importKey(
      "spki",
      pemToDer(WAITLIST_PUBLIC_KEY_PEM),
      { name: "RSA-OAEP", hash: "SHA-256" },
      true,
      ["encrypt"],
    );
    expect((key.algorithm as RsaHashedKeyAlgorithm).modulusLength).toBe(3072);
    // It encrypts (the route's path), even though this test cannot decrypt.
    const stored = await encryptJson({ ok: 1 }, WAITLIST_PUBLIC_KEY_PEM, {
      v: 1,
      created: "c",
      updated: "u",
    });
    expect(stored.kid).toBe(WAITLIST_PUBLIC_KEY_ID);
    expect(Buffer.from(stored.key, "base64")).toHaveLength(384);
  });
});

test.describe("the built route", () => {
  test("POST /api/waitlist without WAITLIST_SALT answers 503, and the count without a store is null", async ({
    request,
  }) => {
    test.skip(!!process.env.WAITLIST_SALT, "the server under test has a salt");
    const res = await request.post("/api/waitlist", { data: VALID });
    expect(res.status()).toBe(503);
    expect(await res.json()).toEqual({ ok: false, error: UNAVAILABLE });
    expect(res.headers()["cache-control"]).toBe("no-store");
    expect(res.headers()["access-control-allow-origin"]).toBeUndefined();

    const count = await request.get("/api/waitlist/count");
    expect(count.status()).toBe(200);
    expect(await count.json()).toEqual({ count: null });
    expect(count.headers()["cache-control"]).toBe("no-store");
  });

  test("POST only, and JSON only", async ({ request }) => {
    expect((await request.get("/api/waitlist")).status()).toBe(405);
    const form = await request.post("/api/waitlist", { form: { email: "a@b.co" } });
    expect(form.status()).toBe(415);
  });
});
