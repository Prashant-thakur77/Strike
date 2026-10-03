import { expect, test, type Page, type Route } from "@playwright/test";
import { CONSENT_TEXT, INTERESTS, MESSAGES, NOT_US_TEXT } from "../src/lib/waitlistEntry";
import { TELEGRAM_BOT } from "../src/lib/waitlist";
import { horizontalOverflow } from "./helpers";

// The /waitlist sign-up form (D46), step by step, with /api/waitlist and its count mocked in the browser (nothing is
// sent anywhere): navigation forward and back, the validation messages, a keyboard-only run, the success and
// "already on the list" screens, errors with a retry, a phone at 360 px and reduced motion.

type Reply = { status: number; body: unknown } | "abort";

/** Mocks the two routes. `replies` answers successive POSTs (the last one repeats); `posts` records what was sent. */
async function mockApi(page: Page, replies: Reply[], count: number | null = 0) {
  const posts: Record<string, unknown>[] = [];
  await page.route("**/api/waitlist/count", (route) => route.fulfill({ status: 200, json: { count } }));
  await page.route("**/api/waitlist", async (route: Route) => {
    if (route.request().method() !== "POST") return route.fallback();
    posts.push(route.request().postDataJSON() as Record<string, unknown>);
    const reply = replies[Math.min(posts.length - 1, replies.length - 1)];
    if (reply === "abort") return route.abort("internetdisconnected");
    return route.fulfill({ status: reply.status, json: reply.body });
  });
  return posts;
}

const OK = { status: 200, body: { ok: true, status: "created" } };

async function open(page: Page) {
  await page.goto("/waitlist");
  const form = page.getByTestId("waitlist-form");
  await form.scrollIntoViewIfNeeded();
  return form;
}

const next = (page: Page) => page.getByTestId("waitlist-next");
const step = (page: Page) => page.getByTestId("waitlist-form");

/** Fills every step with valid answers by clicking, ending on the confirmations step. */
async function fillToConfirm(page: Page, email = "ada@example.com") {
  await page.getByLabel("What's your email?").fill(email);
  await next(page).click();
  await step(page).getByText(INTERESTS[0].label).click();
  await next(page).click();
  await page.getByLabel(/Telegram handle/).fill("@ada_lovelace");
  await next(page).click();
  await page.getByRole("textbox", { name: "Anything you'd like us to know?" }).fill("Hello");
  await next(page).click();
  await expect(step(page)).toHaveAttribute("data-step", "confirm");
}

test("steps: progress, Next and Back keep the answers, each step's field is focused and announced", async ({
  page,
}) => {
  await mockApi(page, [OK], 0);
  await open(page);
  const progress = page.getByTestId("waitlist-progress");
  await expect(progress).toHaveText("Step 1 of 5");
  await expect(step(page)).toHaveAttribute("data-step", "email");
  // No count while the list is empty.
  await expect(page.getByTestId("waitlist-count")).toHaveCount(0);
  // The page opens at its top: nothing is focused until the visitor moves.
  await expect(page.getByLabel("What's your email?")).not.toBeFocused();

  await page.getByLabel("What's your email?").fill("ada@example.com");
  await next(page).click();
  await expect(progress).toHaveText("Step 2 of 5");
  await expect(page.getByTestId("waitlist-live")).toHaveText("Step 2 of 5: What interests you?");
  await expect(page.getByRole("checkbox", { name: INTERESTS[0].label })).toBeFocused();
  for (const i of INTERESTS) await expect(page.getByRole("checkbox", { name: i.label })).toBeVisible();

  await page.getByRole("button", { name: "Back" }).click();
  await expect(progress).toHaveText("Step 1 of 5");
  await expect(page.getByLabel("What's your email?")).toHaveValue("ada@example.com");
  await expect(page.getByLabel("What's your email?")).toBeFocused();

  await next(page).click();
  await step(page).getByText(INTERESTS[1].label).click();
  await next(page).click();
  await expect(step(page)).toHaveAttribute("data-step", "details");
  // All optional: the button says Skip until something is typed.
  await expect(next(page)).toHaveText(/Skip/);
  await page.getByLabel(/Name/).fill("Ada");
  await expect(next(page)).toHaveText(/Next/);
  await next(page).click();
  await expect(step(page)).toHaveAttribute("data-step", "note");
  await expect(page.getByText("0 / 500")).toBeVisible();
  await page.getByRole("textbox", { name: "Anything you'd like us to know?" }).fill("Hi");
  await expect(page.getByText("2 / 500")).toBeVisible();
  await next(page).click();
  await expect(progress).toHaveText("Step 5 of 5");
  await expect(next(page)).toHaveText(/Join the waitlist/);
  await page.getByRole("button", { name: "Back" }).click();
  await expect(page.getByRole("textbox", { name: "Anything you'd like us to know?" })).toHaveValue("Hi");
});

test("validation: a plain message under each field, focus on it, and nothing sent until it is fixed", async ({
  page,
}) => {
  const posts = await mockApi(page, [OK]);
  await open(page);
  const email = page.getByLabel("What's your email?");

  await next(page).click();
  await expect(page.getByTestId("error-email")).toHaveText(MESSAGES.emailMissing);
  await expect(email).toHaveAttribute("aria-invalid", "true");
  await expect(email).toBeFocused();
  await expect(email).toHaveAttribute("aria-describedby", /wl-email-error/);

  await email.fill("ada@example");
  await email.press("Enter");
  await expect(page.getByTestId("error-email")).toHaveText(MESSAGES.emailInvalid);
  await email.fill("ada@example.com");
  // Typing clears the message.
  await expect(page.getByTestId("error-email")).toHaveCount(0);
  await email.press("Enter");

  await next(page).click();
  await expect(page.getByTestId("error-interests")).toHaveText(MESSAGES.interests);
  await step(page).getByText(INTERESTS[2].label).click();
  await expect(page.getByTestId("error-interests")).toHaveCount(0);
  await next(page).click();

  await page.getByLabel(/Telegram handle/).fill("@abc");
  await page.getByLabel(/Wallet address/).fill("0x1234");
  await next(page).click();
  await expect(page.getByTestId("error-telegram")).toHaveText(MESSAGES.telegram);
  await expect(page.getByTestId("error-wallet")).toHaveText(MESSAGES.wallet);
  await expect(page.getByLabel(/Telegram handle/)).toBeFocused();
  await page.getByLabel(/Telegram handle/).fill("satoshi_n");
  await page.getByLabel(/Wallet address/).fill("0x70997970C51812dc3A010C7d01b50e0d17dc79C8");
  await next(page).click();
  await next(page).click();

  await next(page).click();
  await expect(page.getByTestId("error-notUsPerson")).toHaveText(MESSAGES.notUsPerson);
  await expect(page.getByTestId("error-consent")).toHaveText(MESSAGES.consent);
  await step(page).getByText(NOT_US_TEXT).click();
  await next(page).click();
  await expect(page.getByTestId("error-notUsPerson")).toHaveCount(0);
  await expect(page.getByTestId("error-consent")).toHaveText(MESSAGES.consent);
  expect(posts).toHaveLength(0);
});

test("keyboard only: Enter goes on from every step, Space ticks, Shift+Enter is a new line; the answers are sent", async ({
  page,
}) => {
  const posts = await mockApi(page, [OK], 41);
  await page.goto("/waitlist");
  // The hero's button: Enter on it scrolls to the form and focuses the email field.
  await page.getByTestId("waitlist-primary").focus();
  await page.keyboard.press("Enter");
  const email = page.getByLabel("What's your email?");
  await expect(email).toBeFocused();
  await expect(page.getByTestId("waitlist-count")).toHaveText("41 people on the list");

  await page.keyboard.type("Ada@Example.com");
  await page.keyboard.press("Enter");
  await expect(page.getByRole("checkbox", { name: INTERESTS[0].label })).toBeFocused();
  await page.keyboard.press("Space");
  await page.keyboard.press("Tab");
  await page.keyboard.press("Tab");
  await page.keyboard.press("Tab");
  await page.keyboard.press("Space");
  await expect(page.getByRole("checkbox", { name: INTERESTS[3].label })).toBeChecked();
  await page.keyboard.press("Enter");

  await expect(page.getByLabel(/Name/)).toBeFocused();
  await page.keyboard.type("Ada");
  await page.keyboard.press("Tab");
  await page.keyboard.type("ada_lovelace");
  await page.keyboard.press("Enter");

  const note = page.getByRole("textbox", { name: "Anything you'd like us to know?" });
  await expect(note).toBeFocused();
  await page.keyboard.type("Line one");
  await page.keyboard.press("Shift+Enter");
  await page.keyboard.type("Line two");
  await expect(note).toHaveValue("Line one\nLine two");
  await page.keyboard.press("Enter");

  await expect(page.getByRole("checkbox", { name: NOT_US_TEXT })).toBeFocused();
  await page.keyboard.press("Space");
  await page.keyboard.press("Tab");
  await page.keyboard.press("Space");
  await expect(page.getByRole("checkbox", { name: CONSENT_TEXT })).toBeChecked();
  await page.keyboard.press("Enter");

  await expect(page.getByRole("heading", { name: "You're on the list" })).toBeFocused();
  expect(posts).toEqual([
    {
      email: "Ada@Example.com",
      interests: [INTERESTS[0].id, INTERESTS[3].id],
      name: "Ada",
      telegram: "ada_lovelace",
      wallet: "",
      note: "Line one\nLine two",
      notUsPerson: true,
      consent: true,
      website: "",
    },
  ]);
});

test("success: 'You're on the list' with the Telegram bot and the testnet app; a duplicate says 'already'", async ({
  page,
}) => {
  await mockApi(page, [OK], 3);
  await open(page);
  await fillToConfirm(page);
  await step(page).getByText(NOT_US_TEXT).click();
  await step(page).getByText(CONSENT_TEXT).click();
  await next(page).click();
  const done = page.getByTestId("waitlist-done");
  await expect(done).toHaveAttribute("data-status", "created");
  await expect(done.getByRole("heading", { level: 3 })).toHaveText("You're on the list");
  await expect(done).toContainText("ada@example.com");
  await expect(done.getByRole("link", { name: /Launch alerts on Telegram/ })).toHaveAttribute(
    "href",
    TELEGRAM_BOT,
  );
  await expect(done.getByRole("link", { name: /Try it on testnet/ })).toHaveAttribute("href", "/app");

  const page2 = await page.context().newPage();
  await mockApi(page2, [{ status: 200, body: { ok: true, status: "updated" } }], 3);
  await open(page2);
  await fillToConfirm(page2);
  await step(page2).getByText(NOT_US_TEXT).click();
  await step(page2).getByText(CONSENT_TEXT).click();
  await next(page2).click();
  await expect(page2.getByTestId("waitlist-done")).toHaveAttribute("data-status", "updated");
  await expect(page2.getByRole("heading", { name: "You're already on the list" })).toBeVisible();
  await expect(page2.getByTestId("waitlist-done")).toContainText("We've updated your answers.");
  await page2.close();
});

test("errors: unavailable, rate-limited and offline each show a plain message and a retry that works", async ({
  page,
}) => {
  const posts = await mockApi(page, [
    {
      status: 503,
      body: { ok: false, error: "Sign-up is temporarily unavailable. Please try again later." },
    },
    {
      status: 429,
      body: {
        ok: false,
        error: "Too many sign-ups from this connection. Please wait a few minutes and try again.",
        retryAfter: 60,
      },
    },
    "abort",
    OK,
  ]);
  await open(page);
  await fillToConfirm(page);
  await step(page).getByText(NOT_US_TEXT).click();
  await step(page).getByText(CONSENT_TEXT).click();

  const failed = page.getByTestId("waitlist-failed");
  await next(page).click();
  await expect(failed).toContainText("Sign-up is temporarily unavailable");
  await expect(failed).toHaveAttribute("role", "alert");
  await expect(failed.getByRole("link", { name: /Telegram bot/ })).toHaveAttribute("href", TELEGRAM_BOT);
  await expect(next(page)).toHaveText(/Try again/);
  await next(page).click();
  await expect(failed).toContainText("Too many sign-ups");
  await next(page).click();
  await expect(failed).toContainText("Couldn't reach Strike");
  await next(page).click();
  await expect(page.getByRole("heading", { name: "You're on the list" })).toBeVisible();
  expect(posts).toHaveLength(4);
});

test("a field the server refuses sends the visitor back to its step with the server's message", async ({
  page,
}) => {
  await mockApi(page, [
    {
      status: 400,
      body: { ok: false, error: "Some answers need another look.", fields: { email: MESSAGES.emailInvalid } },
    },
  ]);
  await open(page);
  await fillToConfirm(page);
  await step(page).getByText(NOT_US_TEXT).click();
  await step(page).getByText(CONSENT_TEXT).click();
  await next(page).click();
  await expect(step(page)).toHaveAttribute("data-step", "email");
  await expect(page.getByTestId("error-email")).toHaveText(MESSAGES.emailInvalid);
  await expect(page.getByLabel("What's your email?")).toBeFocused();
});

test("the honeypot is out of sight and out of the tab order", async ({ page }) => {
  await mockApi(page, [OK]);
  await open(page);
  const trap = page.locator("#wl-website");
  await expect(trap).toHaveAttribute("tabindex", "-1");
  const box = (await trap.boundingBox())!;
  expect(box.x + box.width).toBeLessThan(0);
  await expect(page.locator('[aria-hidden="true"]:has(#wl-website)')).toHaveCount(1);
});

test("phone at 360 px: every step fits without horizontal scroll, 16 px inputs, 44 px targets", async ({
  page,
}) => {
  await page.setViewportSize({ width: 360, height: 740 });
  await mockApi(page, [OK], 12);
  await open(page);

  const check = async () => {
    expect(await horizontalOverflow(page)).toBeLessThanOrEqual(0);
    const small = await step(page).evaluate((form) => {
      const out: string[] = [];
      for (const el of form.querySelectorAll<HTMLInputElement>("input:not([tabindex='-1']), textarea")) {
        const fs = parseFloat(getComputedStyle(el).fontSize);
        if (fs < 16) out.push(`${el.id} font ${fs}px`);
        const target = el.type === "checkbox" ? el.closest("label")! : el;
        const h = target.getBoundingClientRect().height;
        if (h < 44) out.push(`${el.id || el.getAttribute("value")} ${Math.round(h)}px tall`);
      }
      for (const b of form.querySelectorAll<HTMLElement>("button")) {
        const r = b.getBoundingClientRect();
        if (r.height < 44) out.push(`${b.textContent} ${Math.round(r.height)}px tall`);
        if (r.right > window.innerWidth) out.push(`${b.textContent} off screen`);
      }
      return out;
    });
    expect(small).toEqual([]);
  };

  await check();
  await page.getByLabel("What's your email?").fill("ada@example.com");
  await next(page).click();
  await check();
  await step(page).getByText(INTERESTS[1].label).click();
  await next(page).click();
  await check();
  await next(page).click();
  await check();
  await next(page).click();
  await check();
  await step(page).getByText(NOT_US_TEXT).click();
  await step(page).getByText(CONSENT_TEXT).click();
  await next(page).click();
  await expect(page.getByTestId("waitlist-done")).toBeVisible();
  expect(await horizontalOverflow(page)).toBeLessThanOrEqual(0);
  const links = await page
    .getByTestId("waitlist-done")
    .locator("a")
    .evaluateAll((as) => as.map((a) => Math.round(a.getBoundingClientRect().height)));
  for (const h of links) expect(h).toBeGreaterThanOrEqual(44);
});

test("motion: steps slide in normally, and not at all under prefers-reduced-motion", async ({ page }) => {
  await mockApi(page, [OK]);
  await open(page);
  const anim = () =>
    page.locator("[data-dir]").evaluate((el) => {
      const s = getComputedStyle(el);
      return { name: s.animationName, ms: parseFloat(s.animationDuration) * 1000 };
    });
  await page.getByLabel("What's your email?").fill("ada@example.com");
  await next(page).click();
  expect((await anim()).name).toMatch(/step-in-forward/);
  expect((await anim()).ms).toBeGreaterThan(100);
  await page.getByRole("button", { name: "Back" }).click();
  expect((await anim()).name).toMatch(/step-in-back/);

  await page.emulateMedia({ reducedMotion: "reduce" });
  await next(page).click();
  const reduced = await anim();
  expect(reduced.name === "none" || reduced.ms < 1).toBe(true);
});
