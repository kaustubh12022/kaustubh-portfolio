import { expect, test } from "@playwright/test";

test("/projects opens a project and the project links back", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("link", { name: "Browse projects" }).click();

  await expect(
    page.getByRole("heading", { level: 1, name: /The work, audited/ }),
  ).toBeVisible();

  await page.getByRole("link", { name: /SmartApply/ }).first().click();

  await expect(page).toHaveURL(/\/projects\/smartapply$/);
  await expect(
    page.getByRole("heading", { level: 1, name: "SmartApply" }),
  ).toBeVisible();

  await page.getByRole("link", { name: "All projects" }).click();

  await expect(page).toHaveURL(/\/projects$/);
  await expect(
    page.getByRole("heading", { level: 1, name: /The work, audited/ }),
  ).toBeVisible();
});
