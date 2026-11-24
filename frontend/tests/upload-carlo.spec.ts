import { test, expect } from "@playwright/test";
import path from "node:path";

test("uploads Carlo resume and parses experience bullets", async ({ page }) => {
  await page.goto("/");
  await page.locator('input[type="file"]').setInputFiles(path.resolve(__dirname, "../../docs/CarloResume.txt"));
  await expect(page.locator("textarea")).toContainText("Carlo Morgan");
  await page.getByRole("button", { name: "Parse & save profile" }).click();
  await expect(page.getByText("Parsed bullets")).toBeVisible();
  await expect(page.locator(".bullets .bullet").filter({ hasText: "Senior Engineer, Bitpanda" })).toBeVisible();
});
