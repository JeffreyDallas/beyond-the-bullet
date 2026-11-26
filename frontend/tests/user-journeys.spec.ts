import { test, expect } from "@playwright/test";
import path from "node:path";

const resource = (name: string) => path.resolve(__dirname, `../../tests/resources/${name}`);

test("creates a user, uploads a resume, and displays grouped parsed experiences", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("textbox", { name: "Profile name" }).fill("E2E Upload Parser");
  await page.locator('input[type="file"]').setInputFiles(resource("CarloResume.txt"));
  await expect(page.getByRole("textbox", { name: "Paste resume or profile text" })).toContainText("Carlo Morgan");
  await page.getByRole("button", { name: "Parse & save profile" }).click();
  await expect(page.getByText("Parsed experiences")).toBeVisible();
  await expect(page.locator(".bullets .bullet").filter({ hasText: "Firmware Engineer I" }).first()).toBeVisible();
});

test("switches between saved user profiles from the top-right menu", async ({ page }) => {
  const firstUser = "E2E Switch A";
  const secondUser = "E2E Switch B";
  await page.goto("/");

  await page.getByRole("textbox", { name: "Profile name" }).fill(firstUser);
  await page.locator('input[type="file"]').setInputFiles(resource("CarloResume.txt"));
  await page.getByRole("button", { name: "Parse & save profile" }).click();
  await expect(page.getByRole("button", { name: new RegExp(firstUser) })).toBeVisible();

  await page.getByRole("button", { name: new RegExp(firstUser) }).click();
  await page.getByRole("button", { name: /New profile/ }).click();
  await page.getByRole("textbox", { name: "Profile name" }).fill(secondUser);
  await page.locator('input[type="file"]').setInputFiles(resource("Melissa_Parker_Commercial_Real_Estate_Accountant.docx"));
  await page.getByRole("button", { name: "Parse & save profile" }).click();
  await expect(page.getByRole("button", { name: new RegExp(secondUser) })).toBeVisible();

  await page.getByRole("button", { name: new RegExp(secondUser) }).click();
  await page.locator(".popover button").filter({ hasText: firstUser }).last().click();
  await expect(page.getByRole("button", { name: new RegExp(firstUser) })).toBeVisible();
  await expect(page.getByRole("textbox", { name: "Paste resume or profile text" })).toContainText("Carlo Morgan");
});

test("plays back a pre-generated transcript in the conversation area", async ({ page, request }) => {
  const profileResponse = await request.post("/api/profiles", {
    data: { name: "E2E Playback", raw_text: "Designed a resilient data ingestion pipeline processing customer events with measurable reliability improvements." },
  });
  const profile = await profileResponse.json();
  const planResponse = await request.post(`/api/profiles/${profile.id}/plan`, { data: {} });
  const session = (await planResponse.json())[0];
  await request.post(`/api/sessions/${session.id}/start`);
  for (const answer of [
    "I owned the ingestion service and its deployment.",
    "I chose the design to handle retries and preserve ordering.",
    "I measured throughput and failure recovery with integration tests.",
  ]) {
    await request.post(`/api/sessions/${session.id}/answer`, { data: { text: answer } });
  }

  await page.goto("/");
  await page.getByRole("button", { name: "Choose profile" }).click();
  await page.locator(".popover button").filter({ hasText: profile.name }).last().click();
  await page.locator(".session-card").first().click();
  await expect(page.locator(".conversation")).toBeVisible();
  await expect(page.locator(".conversation .turn.agent")).toHaveCount(3);
  await expect(page.locator(".conversation .turn.user")).toHaveCount(3);
  await expect(page.locator(".conversation")).toContainText("I owned the ingestion service");
  await expect(page.getByText("Session reflection")).toBeVisible();
});
