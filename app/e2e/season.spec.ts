import { expect, test } from "@playwright/test";
import { acknowledge, horizontalOverflow } from "./helpers";

// The Season 0 banner on /app/agents: the checklist and links, and a dismissal that survives a reload.
test.beforeEach(async ({ page }) => {
  await acknowledge(page);
});

test("shows the Season 0 banner and remembers its dismissal", async ({ page }) => {
  await page.goto("/app/agents?chain=46630");
  const banner = page.getByRole("complementary", { name: "Season 0" });
  await expect(banner).toBeVisible();
  await expect(banner.getByText("Testnet agents welcome.")).toBeVisible();
  const steps = banner.getByRole("list", { name: "Season 0 checklist" }).getByRole("listitem");
  await expect(steps).toHaveText([/Register/, /Bond/, /Run one epoch/, /File feedback/]);
  await expect(banner.getByRole("link", { name: /Run your own agent/ })).toHaveAttribute(
    "href",
    "#run-your-own-agent",
  );
  await expect(banner.getByRole("link", { name: /Feedback form/ })).toHaveAttribute(
    "href",
    /issues\/new\?template=testnet-feedback\.yml$/,
  );
  expect(await horizontalOverflow(page)).toBeLessThanOrEqual(0);

  await banner.getByRole("button", { name: "Dismiss Season 0 banner" }).click();
  await expect(banner).toHaveCount(0);
  await page.reload();
  await expect(page.getByRole("heading", { level: 1, name: /agents/i })).toBeVisible();
  await expect(page.getByRole("complementary", { name: "Season 0" })).toBeHidden();
});
