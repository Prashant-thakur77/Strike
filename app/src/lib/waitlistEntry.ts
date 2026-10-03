// The mainnet waitlist's sign-up entry (D46): its fields, the form's steps and one validator that both the form
// (app/src/components/waitlist/WaitlistForm.tsx) and the route (app/src/app/api/waitlist/route.ts) use, so a message
// the browser shows is the message the server would send. No imports, so the Playwright specs load it as CommonJS.

/** Bumped when the encrypted entry's shape changes; stored next to the ciphertext. */
export const ENTRY_SCHEMA = 1;

export const NOTE_MAX = 500;
export const NAME_MAX = 80;
export const EMAIL_MAX = 254;

export const INTERESTS = [
  { id: "covered-calls", label: "Depositing: covered calls" },
  { id: "cash-secured-puts", label: "Depositing: cash-secured puts" },
  { id: "buying-options", label: "Buying options" },
  { id: "running-agent", label: "Running an AI agent" },
] as const;

export type InterestId = (typeof INTERESTS)[number]["id"];

/** The consent sentence, stored inside the encrypted entry word for word, so the team knows what each person agreed to. */
export const CONSENT_TEXT = "Contact me about Strike's mainnet launch; I can ask to be removed at any time";
export const NOT_US_TEXT = "I am not a US person";

/** What the form sends. Every field is a string or a boolean, as JSON carries it. */
export interface EntryInput {
  email: string;
  interests: string[];
  name: string;
  telegram: string;
  wallet: string;
  note: string;
  notUsPerson: boolean;
  consent: boolean;
  /** The honeypot: a field people never see. Anything in it marks the sign-up as a bot's. */
  website?: string;
}

/** What is encrypted and stored: the cleaned input plus the consent text it agreed to. */
export interface Entry {
  email: string;
  interests: InterestId[];
  name: string;
  telegram: string;
  wallet: string;
  note: string;
  notUsPerson: true;
  consent: true;
  consentText: string;
  submittedAt: string;
}

export type Field =
  "email" | "interests" | "name" | "telegram" | "wallet" | "note" | "notUsPerson" | "consent";
export type FieldErrors = Partial<Record<Field, string>>;

// A practical email check (the same shape browsers accept for type=email): a local part, an @, and a domain with a dot
// and no spaces. Deliverability is not checked; a typo'd address simply never hears back.
const EMAIL =
  /^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)+$/;
// Telegram usernames: 5 to 32 characters, letters, digits and underscores, starting with a letter. Written with the @.
const TELEGRAM = /^@[A-Za-z][A-Za-z0-9_]{4,31}$/;
const WALLET = /^0x[0-9a-fA-F]{40}$/;
// Control characters other than tab and newline never belong in a name or a note.
const CONTROL = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/;

export const MESSAGES = {
  emailMissing: "Enter your email address.",
  emailInvalid: "That doesn't look like an email address. Check for typos, like name@example.com.",
  interests: "Pick at least one.",
  nameLong: `Keep the name under ${NAME_MAX} characters.`,
  telegram:
    "A Telegram handle starts with @ and has 5 to 32 letters, digits or underscores, like @satoshi_n.",
  wallet: "A wallet address is 0x followed by 40 hexadecimal characters.",
  noteLong: `Keep the note to ${NOTE_MAX} characters or fewer.`,
  control: "Remove the special characters.",
  notUsPerson: "Strike is not available to US persons, so we can only add you if this applies.",
  consent: "We need your permission to contact you about the launch; it is the only thing the list is for.",
} as const;

const str = (v: unknown): string => (typeof v === "string" ? v : "");

/** The email as it is hashed and stored: trimmed and lowercased. */
export function normaliseEmail(email: string): string {
  return email.trim().toLowerCase();
}

/** "satoshi" and "@satoshi" both become "@satoshi"; "" stays "". */
export function normaliseTelegram(handle: string): string {
  const h = handle.trim();
  if (!h) return "";
  return h.startsWith("@") ? h : `@${h}`;
}

export function emailError(email: string): string | undefined {
  const e = normaliseEmail(email);
  if (!e) return MESSAGES.emailMissing;
  if (e.length > EMAIL_MAX || !EMAIL.test(e)) return MESSAGES.emailInvalid;
  return undefined;
}

export function interestsError(interests: readonly string[]): string | undefined {
  return interests.length === 0 ? MESSAGES.interests : undefined;
}

export function detailsErrors(d: { name: string; telegram: string; wallet: string }): FieldErrors {
  const out: FieldErrors = {};
  const name = d.name.trim();
  if (name.length > NAME_MAX) out.name = MESSAGES.nameLong;
  else if (CONTROL.test(name)) out.name = MESSAGES.control;
  const tg = normaliseTelegram(d.telegram);
  if (tg && !TELEGRAM.test(tg)) out.telegram = MESSAGES.telegram;
  const wallet = d.wallet.trim();
  if (wallet && !WALLET.test(wallet)) out.wallet = MESSAGES.wallet;
  return out;
}

export function noteError(note: string): string | undefined {
  const n = note.trim();
  if (n.length > NOTE_MAX) return MESSAGES.noteLong;
  if (CONTROL.test(n)) return MESSAGES.control;
  return undefined;
}

export function confirmErrors(c: { notUsPerson: boolean; consent: boolean }): FieldErrors {
  const out: FieldErrors = {};
  if (c.notUsPerson !== true) out.notUsPerson = MESSAGES.notUsPerson;
  if (c.consent !== true) out.consent = MESSAGES.consent;
  return out;
}

export type Validation = { ok: true; entry: Entry } | { ok: false; errors: FieldErrors };

/** Checks every field of an untrusted body. On success, returns the cleaned entry that gets encrypted. */
export function validateEntry(raw: unknown, now: Date = new Date()): Validation {
  const body = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const errors: FieldErrors = {};

  const email = str(body.email);
  const eErr = emailError(email);
  if (eErr) errors.email = eErr;

  const known = new Set<string>(INTERESTS.map((i) => i.id));
  const rawInterests = Array.isArray(body.interests) ? body.interests : [];
  const interests = INTERESTS.map((i) => i.id).filter((id) => rawInterests.includes(id));
  if (
    rawInterests.some((v) => typeof v !== "string" || !known.has(v)) ||
    rawInterests.length > INTERESTS.length
  )
    errors.interests = MESSAGES.interests;
  else {
    const iErr = interestsError(interests);
    if (iErr) errors.interests = iErr;
  }

  const details = { name: str(body.name), telegram: str(body.telegram), wallet: str(body.wallet) };
  Object.assign(errors, detailsErrors(details));

  const note = str(body.note);
  const nErr = noteError(note);
  if (nErr) errors.note = nErr;

  Object.assign(
    errors,
    confirmErrors({ notUsPerson: body.notUsPerson === true, consent: body.consent === true }),
  );

  if (Object.keys(errors).length) return { ok: false, errors };
  return {
    ok: true,
    entry: {
      email: normaliseEmail(email),
      interests,
      name: details.name.trim(),
      telegram: normaliseTelegram(details.telegram),
      wallet: details.wallet.trim(),
      note: note.trim(),
      notUsPerson: true,
      consent: true,
      consentText: CONSENT_TEXT,
      submittedAt: now.toISOString(),
    },
  };
}

/** True when the hidden honeypot field was filled in (people never see it, so only bots fill it). */
export function isBot(raw: unknown): boolean {
  const body = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  return typeof body.website === "string" && body.website.trim() !== "";
}
