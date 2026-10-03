"use client";

import { useCallback, useEffect, useRef, useState, type FormEvent, type KeyboardEvent } from "react";
import Link from "next/link";
import { ArrowLeft, ArrowRight, ArrowUpRight, Check, RotateCcw } from "lucide-react";
import {
  CONSENT_TEXT,
  INTERESTS,
  NAME_MAX,
  NOTE_MAX,
  NOT_US_TEXT,
  confirmErrors,
  detailsErrors,
  emailError,
  interestsError,
  noteError,
  type Field,
  type FieldErrors,
} from "@/lib/waitlistEntry";
import styles from "./waitlistForm.module.css";

// The mainnet waitlist's sign-up (D46): one question per step, Enter to go on, Back to go back, each step's field
// focused as it appears, and every answer checked here with the same rules the route applies. Steps slide in with CSS
// (none under prefers-reduced-motion); an aria-live line announces each step. POSTs to /api/waitlist.

const STEPS = [
  { id: "email", title: "What's your email?" },
  { id: "interests", title: "What interests you?" },
  { id: "details", title: "A few details, if you like" },
  { id: "note", title: "Anything you'd like us to know?" },
  { id: "confirm", title: "Two confirmations" },
] as const;

const FIELD_STEP: Record<Field, number> = {
  email: 0,
  interests: 1,
  name: 2,
  telegram: 2,
  wallet: 2,
  note: 3,
  notUsPerson: 4,
  consent: 4,
};

interface Answers {
  email: string;
  interests: string[];
  name: string;
  telegram: string;
  wallet: string;
  note: string;
  notUsPerson: boolean;
  consent: boolean;
  website: string;
}

const EMPTY: Answers = {
  email: "",
  interests: [],
  name: "",
  telegram: "",
  wallet: "",
  note: "",
  notUsPerson: false,
  consent: false,
  website: "",
};

type Phase =
  | { kind: "editing" }
  | { kind: "sending" }
  | { kind: "done"; status: "created" | "updated" }
  | { kind: "failed"; message: string };

function stepErrors(step: number, a: Answers): FieldErrors {
  switch (step) {
    case 0: {
      const e = emailError(a.email);
      return e ? { email: e } : {};
    }
    case 1: {
      const e = interestsError(a.interests);
      return e ? { interests: e } : {};
    }
    case 2:
      return detailsErrors(a);
    case 3: {
      const e = noteError(a.note);
      return e ? { note: e } : {};
    }
    default:
      return confirmErrors(a);
  }
}

export function WaitlistForm({ telegramBot }: { telegramBot: string }) {
  const [step, setStep] = useState(0);
  const [dir, setDir] = useState<"forward" | "back">("forward");
  const [a, setA] = useState<Answers>(EMPTY);
  const [errors, setErrors] = useState<FieldErrors>({});
  const [phase, setPhase] = useState<Phase>({ kind: "editing" });
  const [count, setCount] = useState<number | null>(null);
  const [announce, setAnnounce] = useState("");
  const stepRef = useRef<HTMLDivElement>(null);
  const doneRef = useRef<HTMLHeadingElement>(null);
  const moved = useRef(false);

  const set = <K extends keyof Answers>(k: K, v: Answers[K]) => {
    setA((prev) => ({ ...prev, [k]: v }));
    setErrors((prev) => {
      if (!(k in prev)) return prev;
      const next = { ...prev };
      delete next[k as Field];
      return next;
    });
  };

  const focusStep = useCallback((preventScroll = false) => {
    const root = stepRef.current;
    if (!root) return;
    const invalid = root.querySelector<HTMLElement>('[aria-invalid="true"]');
    const first = invalid ?? root.querySelector<HTMLElement>("input:not([tabindex='-1']), textarea");
    first?.focus({ preventScroll });
  }, []);

  // The count of people on the list (cached by the route for a minute). Shown only when there is one.
  useEffect(() => {
    let live = true;
    fetch("/api/waitlist/count")
      .then((r) => (r.ok ? r.json() : null))
      .then((j: { count?: number | null } | null) => {
        if (live && typeof j?.count === "number") setCount(j.count);
      })
      .catch(() => {});
    return () => {
      live = false;
    };
  }, []);

  // Autofocus: each new step's first field (or the first one with an error), but not on page load, so the page opens
  // at its top. Arriving at /waitlist#join, or pressing a link to #join, focuses the email field.
  useEffect(() => {
    if (!moved.current) return;
    focusStep();
  }, [step, focusStep]);

  useEffect(() => {
    const toForm = () => window.setTimeout(() => focusStep(true), 350);
    if (window.location.hash === "#join") toForm();
    const onClick = (e: MouseEvent) => {
      const link = (e.target as Element | null)?.closest?.('a[href="#join"]');
      if (link) toForm();
    };
    document.addEventListener("click", onClick);
    return () => document.removeEventListener("click", onClick);
  }, [focusStep]);

  useEffect(() => {
    if (phase.kind === "done") doneRef.current?.focus();
  }, [phase.kind]);

  const go = (to: number) => {
    moved.current = true;
    setDir(to > step ? "forward" : "back");
    setErrors({});
    setPhase({ kind: "editing" });
    setStep(to);
    setAnnounce(`Step ${to + 1} of ${STEPS.length}: ${STEPS[to].title}`);
  };

  const submit = async () => {
    setPhase({ kind: "sending" });
    setAnnounce("Sending your sign-up.");
    let res: Response;
    try {
      res = await fetch("/api/waitlist", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(a),
      });
    } catch {
      const message = "Couldn't reach Strike. Check your connection and try again.";
      setPhase({ kind: "failed", message });
      setAnnounce(message);
      return;
    }
    const body = (await res.json().catch(() => null)) as {
      ok?: boolean;
      status?: "created" | "updated";
      error?: string;
      fields?: FieldErrors;
    } | null;
    if (res.ok && body?.ok) {
      setPhase({ kind: "done", status: body.status === "updated" ? "updated" : "created" });
      if (body.status !== "updated") setCount((c) => (c === null ? c : c + 1));
      setAnnounce(body.status === "updated" ? "You're already on the list." : "You're on the list.");
      return;
    }
    if (res.status === 400 && body?.fields && Object.keys(body.fields).length) {
      // Back to the first step with a problem, with the server's message under the field.
      const first = Math.min(...(Object.keys(body.fields) as Field[]).map((f) => FIELD_STEP[f] ?? 0));
      setPhase({ kind: "editing" });
      moved.current = true;
      setDir("back");
      setStep(first);
      setErrors(body.fields);
      setAnnounce(`Step ${first + 1} of ${STEPS.length}: please check your answer.`);
      return;
    }
    const message =
      body?.error ??
      (res.status === 429
        ? "Too many sign-ups from this connection. Please wait a few minutes and try again."
        : "Your sign-up could not be saved just now. Please try again.");
    setPhase({ kind: "failed", message });
    setAnnounce(message);
  };

  const next = () => {
    if (phase.kind === "sending") return;
    const errs = stepErrors(step, a);
    if (Object.keys(errs).length) {
      setErrors(errs);
      setAnnounce(Object.values(errs)[0] ?? "");
      window.setTimeout(() => focusStep(), 0);
      return;
    }
    if (step < STEPS.length - 1) go(step + 1);
    else void submit();
  };

  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    next();
  };

  // Enter goes on from anywhere in a step, checkboxes and the note included (Shift+Enter is a new line in the note).
  const onKeyDown = (e: KeyboardEvent<HTMLFormElement>) => {
    if (e.key !== "Enter" || e.nativeEvent.isComposing) return;
    const t = e.target as HTMLElement;
    const checkbox = t instanceof HTMLInputElement && t.type === "checkbox";
    const textarea = t instanceof HTMLTextAreaElement;
    if (checkbox || (textarea && !e.shiftKey)) {
      e.preventDefault();
      next();
    }
  };

  const err = (f: Field) =>
    errors[f] ? (
      <p id={`wl-${f}-error`} className={styles.error} data-testid={`error-${f}`}>
        {errors[f]}
      </p>
    ) : null;
  const described = (f: Field, hint?: string) =>
    [hint, errors[f] ? `wl-${f}-error` : null].filter(Boolean).join(" ") || undefined;

  if (phase.kind === "done") {
    const again = phase.status === "updated";
    return (
      <div className={styles.done} data-testid="waitlist-done" data-status={phase.status}>
        <span className={styles.doneMark} aria-hidden>
          <Check strokeWidth={2.5} />
        </span>
        <h3 ref={doneRef} tabIndex={-1} className={styles.doneTitle}>
          {again ? "You're already on the list" : "You're on the list"}
        </h3>
        <p className={styles.doneText}>
          {again ? "We've updated your answers. " : "Thanks for signing up. "}
          We&apos;ll write to {a.email.trim().toLowerCase()} when the audit report is out and when the first
          mainnet vault opens, and for nothing else.
        </p>
        <div className={styles.doneLinks}>
          <a href={telegramBot} target="_blank" rel="noopener noreferrer" className="pill pill-accent">
            Launch alerts on Telegram <ArrowUpRight aria-hidden />
            <span className="sr-only"> (opens in a new tab)</span>
          </a>
          <Link href="/app" className="pill pill-ghost">
            Try it on testnet <ArrowRight aria-hidden />
          </Link>
        </div>
        <p className={styles.live} aria-live="polite" role="status">
          {announce}
        </p>
      </div>
    );
  }

  const current = STEPS[step];
  const sending = phase.kind === "sending";
  const last = step === STEPS.length - 1;
  const detailsEmpty = !a.name.trim() && !a.telegram.trim() && !a.wallet.trim();

  return (
    <form
      className={styles.form}
      onSubmit={onSubmit}
      onKeyDown={onKeyDown}
      noValidate
      aria-label="Mainnet waitlist sign-up"
      data-testid="waitlist-form"
      data-step={current.id}
    >
      <div className={styles.progressRow}>
        <span className="micro" data-testid="waitlist-progress">
          Step {step + 1} of {STEPS.length}
        </span>
        {count !== null && count > 0 ? (
          <span className={`micro ${styles.count}`} data-testid="waitlist-count">
            {count.toLocaleString("en-US")} {count === 1 ? "person" : "people"} on the list
          </span>
        ) : null}
      </div>
      <div className={styles.bar} aria-hidden>
        <span style={{ transform: `scaleX(${(step + 1) / STEPS.length})` }} />
      </div>

      {/* Clipped sideways, so a step sliding in never widens the page. The first step does not slide in. */}
      <div className={styles.stage}>
        <div key={current.id} ref={stepRef} className={styles.step} data-dir={moved.current ? dir : "none"}>
          {step === 0 ? (
            <div className={styles.question}>
              <label htmlFor="wl-email" className={styles.title}>
                {current.title}
              </label>
              <p id="wl-email-hint" className={styles.hint}>
                We use it only to tell you when Strike launches on mainnet.
              </p>
              <input
                id="wl-email"
                className={styles.input}
                type="email"
                inputMode="email"
                autoComplete="email"
                autoCapitalize="none"
                autoCorrect="off"
                spellCheck={false}
                enterKeyHint="next"
                maxLength={254}
                placeholder="you@example.com"
                value={a.email}
                onChange={(e) => set("email", e.target.value)}
                aria-required="true"
                aria-invalid={errors.email ? true : undefined}
                aria-describedby={described("email", "wl-email-hint")}
              />
              {err("email")}
            </div>
          ) : null}

          {step === 1 ? (
            <fieldset
              className={styles.question}
              aria-describedby={described("interests", "wl-interests-hint")}
            >
              <legend className={styles.title}>{current.title}</legend>
              <p id="wl-interests-hint" className={styles.hint}>
                Pick any that apply.
              </p>
              <div className={styles.chips}>
                {INTERESTS.map((i) => {
                  const on = a.interests.includes(i.id);
                  return (
                    <label key={i.id} className={styles.chip} data-on={on || undefined}>
                      <input
                        type="checkbox"
                        name="interests"
                        value={i.id}
                        checked={on}
                        aria-invalid={errors.interests ? true : undefined}
                        onChange={() =>
                          set(
                            "interests",
                            on ? a.interests.filter((x) => x !== i.id) : [...a.interests, i.id],
                          )
                        }
                      />
                      <span className={styles.chipBox} aria-hidden>
                        <Check strokeWidth={3} />
                      </span>
                      <span>{i.label}</span>
                    </label>
                  );
                })}
              </div>
              {err("interests")}
            </fieldset>
          ) : null}

          {step === 2 ? (
            <fieldset className={styles.question}>
              <legend className={styles.title}>{current.title}</legend>
              <p id="wl-details-hint" className={styles.hint}>
                All optional. A Telegram handle or wallet helps us reach you if email fails.
              </p>
              <div className={styles.fields}>
                <div className={styles.field}>
                  <label htmlFor="wl-name" className="micro">
                    Name <span className={styles.optional}>optional</span>
                  </label>
                  <input
                    id="wl-name"
                    className={styles.inputSmall}
                    autoComplete="name"
                    enterKeyHint="next"
                    maxLength={NAME_MAX + 20}
                    value={a.name}
                    onChange={(e) => set("name", e.target.value)}
                    aria-invalid={errors.name ? true : undefined}
                    aria-describedby={described("name")}
                  />
                  {err("name")}
                </div>
                <div className={styles.field}>
                  <label htmlFor="wl-telegram" className="micro">
                    Telegram handle <span className={styles.optional}>optional</span>
                  </label>
                  <input
                    id="wl-telegram"
                    className={styles.inputSmall}
                    autoComplete="off"
                    autoCapitalize="none"
                    autoCorrect="off"
                    spellCheck={false}
                    enterKeyHint="next"
                    placeholder="@yourhandle"
                    maxLength={40}
                    value={a.telegram}
                    onChange={(e) => set("telegram", e.target.value)}
                    aria-invalid={errors.telegram ? true : undefined}
                    aria-describedby={described("telegram")}
                  />
                  {err("telegram")}
                </div>
                <div className={styles.field}>
                  <label htmlFor="wl-wallet" className="micro">
                    Wallet address <span className={styles.optional}>optional</span>
                  </label>
                  <input
                    id="wl-wallet"
                    className={`${styles.inputSmall} ${styles.mono}`}
                    autoComplete="off"
                    autoCapitalize="none"
                    autoCorrect="off"
                    spellCheck={false}
                    enterKeyHint="next"
                    placeholder="0x…"
                    maxLength={42}
                    value={a.wallet}
                    onChange={(e) => set("wallet", e.target.value)}
                    aria-invalid={errors.wallet ? true : undefined}
                    aria-describedby={described("wallet")}
                  />
                  {err("wallet")}
                </div>
              </div>
            </fieldset>
          ) : null}

          {step === 3 ? (
            <div className={styles.question}>
              <label htmlFor="wl-note" className={styles.title}>
                {current.title}
              </label>
              <p id="wl-note-hint" className={styles.hint}>
                Optional. A question, the stock you&apos;d want a vault for, anything. Shift+Enter for a new
                line.
              </p>
              <textarea
                id="wl-note"
                className={styles.textarea}
                rows={4}
                maxLength={NOTE_MAX}
                enterKeyHint="next"
                value={a.note}
                onChange={(e) => set("note", e.target.value)}
                aria-invalid={errors.note ? true : undefined}
                aria-describedby={described("note", "wl-note-hint wl-note-count")}
              />
              <p id="wl-note-count" className={styles.counter}>
                {a.note.length} / {NOTE_MAX}
              </p>
              {err("note")}
            </div>
          ) : null}

          {step === 4 ? (
            <fieldset className={styles.question}>
              <legend className={styles.title}>{current.title}</legend>
              <p className={styles.hint}>Both are needed to join.</p>
              <div className={styles.checks}>
                <label className={styles.check}>
                  <input
                    type="checkbox"
                    checked={a.notUsPerson}
                    onChange={(e) => set("notUsPerson", e.target.checked)}
                    aria-invalid={errors.notUsPerson ? true : undefined}
                    aria-describedby={described("notUsPerson")}
                    aria-required="true"
                  />
                  <span className={styles.chipBox} aria-hidden>
                    <Check strokeWidth={3} />
                  </span>
                  <span>{NOT_US_TEXT}</span>
                </label>
                {err("notUsPerson")}
                <label className={styles.check}>
                  <input
                    type="checkbox"
                    checked={a.consent}
                    onChange={(e) => set("consent", e.target.checked)}
                    aria-invalid={errors.consent ? true : undefined}
                    aria-describedby={described("consent")}
                    aria-required="true"
                  />
                  <span className={styles.chipBox} aria-hidden>
                    <Check strokeWidth={3} />
                  </span>
                  <span>{CONSENT_TEXT}</span>
                </label>
                {err("consent")}
              </div>
            </fieldset>
          ) : null}
        </div>
      </div>

      {/* The honeypot: hidden from people and screen readers; a bot that fills it is answered but not stored. */}
      <div className={styles.trap} aria-hidden>
        <label htmlFor="wl-website">Website</label>
        <input
          id="wl-website"
          name="website"
          tabIndex={-1}
          autoComplete="off"
          value={a.website}
          onChange={(e) => setA((p) => ({ ...p, website: e.target.value }))}
        />
      </div>

      {phase.kind === "failed" ? (
        <div className={styles.failed} role="alert" data-testid="waitlist-failed">
          <p>{phase.message}</p>
          <p className={styles.failedAlt}>
            You can also get launch alerts from the{" "}
            <a href={telegramBot} target="_blank" rel="noopener noreferrer" className="text-link">
              Telegram bot
              <span className="sr-only"> (opens in a new tab)</span>
            </a>
            .
          </p>
        </div>
      ) : null}

      <div className={styles.nav}>
        {step > 0 ? (
          <button
            type="button"
            className={`pill pill-ghost ${styles.back}`}
            onClick={() => go(step - 1)}
            disabled={sending}
          >
            <ArrowLeft aria-hidden /> Back
          </button>
        ) : null}
        <button
          type="submit"
          className={`pill ${styles.next}`}
          disabled={sending}
          data-testid="waitlist-next"
        >
          {last ? (
            phase.kind === "failed" ? (
              <>
                Try again <RotateCcw aria-hidden />
              </>
            ) : sending ? (
              "Sending…"
            ) : (
              <>
                Join the waitlist <ArrowRight aria-hidden />
              </>
            )
          ) : (
            <>
              {step === 2 && detailsEmpty ? "Skip" : step === 3 && !a.note.trim() ? "Skip" : "Next"}{" "}
              <ArrowRight aria-hidden />
            </>
          )}
        </button>
        <span className={styles.enterHint} aria-hidden>
          or press Enter ↵
        </span>
      </div>

      <p className={styles.live} aria-live="polite" role="status" data-testid="waitlist-live">
        {announce}
      </p>
    </form>
  );
}
