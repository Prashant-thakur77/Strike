import { expect, test } from "@playwright/test";
import { horizontalOverflow } from "./helpers";

// The app (not the landing page) opens with a notice: not for US persons, unaudited testnet software. It must be
// keyboard operable with focus kept inside it, and once acknowledged it stays dismissed.

test("eligibility notice appears on the first visit to the app and dismisses", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (err) => errors.push(err.message));
  page.on("console", (msg) => {
    if (msg.type() === "error") errors.push(msg.text());
  });

  await page.goto("/");
  await expect(
    page.getByRole("heading", { level: 1, name: /stock tokens that pay every week/i }),
  ).toBeAttached();
  await expect(page.getByRole("dialog", { name: /not for us persons/i })).toHaveCount(0);

  await page.goto("/app?chain=46630");
  const gate = page.getByRole("dialog", { name: /not for us persons/i });
  await expect(gate).toBeVisible();
  await expect(gate).toBeFocused();
  expect(await horizontalOverflow(page)).toBeLessThanOrEqual(0);

  const box = gate.getByRole("checkbox", {
    name: /I am not a US person and understand this is experimental/i,
  });
  const go = gate.getByRole("button", { name: /continue/i });
  await expect(go).toBeDisabled();

  // Tab cycles inside the notice: checkbox, then the way out, then back to the checkbox.
  await page.keyboard.press("Tab");
  await expect(box).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(gate.getByRole("link", { name: /back to the home page/i })).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(box).toBeFocused();
  await page.keyboard.press("Shift+Tab");
  expect(await gate.evaluate((el) => el.contains(document.activeElement))).toBe(true);

  // Keyboard only: tick the box, move to Continue, press Enter.
  await box.focus();
  await page.keyboard.press("Space");
  await expect(box).toBeChecked();
  await expect(go).toBeEnabled();
  await page.keyboard.press("Tab");
  await expect(go).toBeFocused();
  await page.keyboard.press("Enter");

  await expect(gate).toHaveCount(0);
  await expect(page.getByRole("heading", { level: 1, name: /vaults/i })).toBeVisible();
  expect(await page.evaluate(() => window.localStorage.getItem("strike.ack.v1"))).toBe("1");

  // Remembered: not shown again after a reload or on another app page.
  await page.reload();
  await expect(page.getByRole("heading", { level: 1, name: /vaults/i })).toBeVisible();
  await expect(gate).toHaveCount(0);
  await page.goto("/app/faucet?chain=46630");
  await expect(page.getByRole("heading", { level: 1, name: /faucet/i })).toBeVisible();
  await expect(gate).toHaveCount(0);
  expect(errors).toEqual([]);
});

test("eligibility notice comes back on every visit when storage can't be written", async ({ page }) => {
  await page.addInitScript(() => {
    Storage.prototype.setItem = () => {
      throw new DOMException("storage is blocked", "QuotaExceededError");
    };
  });
  await page.goto("/app?chain=46630");
  const gate = page.getByRole("dialog", { name: /not for us persons/i });
  await expect(gate).toBeFocused();
  await gate.getByRole("checkbox").check();
  await gate.getByRole("button", { name: /continue/i }).click();
  await expect(gate).toHaveCount(0);
  await page.reload();
  await expect(gate).toBeVisible();
});
