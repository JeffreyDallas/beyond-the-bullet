import { test, expect } from "@playwright/test";
import path from "node:path";

const resource = (name: string) => path.resolve(__dirname, `../../tests/resources/${name}`);

test("creates a user, uploads a resume, and displays backend-parsed bullets", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("textbox", { name: "Profile name" }).fill("Upload Parse User");
  await page.locator('input[type="file"]').setInputFiles(resource("CarloResume.txt"));
  await expect(page.getByRole("textbox", { name: "Paste resume or profile text" })).toContainText("Carlo Morgan");
  await page.getByRole("button", { name: "Parse & save profile" }).click();
  await expect(page.getByText("Parsed bullets")).toBeVisible();
  await expect(page.locator(".bullets .bullet").filter({ hasText: "Junior Firmware Engineer" }).first()).toBeVisible();
});

test("switches between saved user profiles from the top-right menu", async ({ page }) => {
  const suffix = Date.now();
  const firstUser = `Switch User A ${suffix}`;
  const secondUser = `Switch User B ${suffix}`;
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
  await page.getByRole("button", { name: firstUser, exact: true }).click();
  await expect(page.getByRole("button", { name: new RegExp(firstUser) })).toBeVisible();
  await expect(page.getByRole("textbox", { name: "Paste resume or profile text" })).toContainText("Carlo Morgan");
});

test("plays back a pre-generated transcript in the conversation area", async ({ page, request }) => {
  const profileResponse = await request.post("/api/profiles", {
    data: { name: `Playback User ${Date.now()}`, raw_text: "Designed a resilient data ingestion pipeline processing customer events with measurable reliability improvements." },
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
  await page.getByRole("button", { name: profile.name, exact: true }).click();
  await page.locator(".session-card").first().click();
  await expect(page.locator(".conversation")).toBeVisible();
  await expect(page.locator(".conversation .turn.agent")).toHaveCount(3);
  await expect(page.locator(".conversation .turn.user")).toHaveCount(3);
  await expect(page.locator(".conversation")).toContainText("I owned the ingestion service");
  await expect(page.getByText("Session reflection")).toBeVisible();
});

test("shows expected token, session, agent, and conversation results in admin dashboard", async ({ page, request }) => {
  const profileResponse = await request.post("/api/profiles", {
    data: { name: `Admin E2E User ${Date.now()}`, raw_text: "Built a reliable payment reconciliation service with audit-ready reports and measurable recovery improvements." },
  });
  const profile = await profileResponse.json();
  const planResponse = await request.post(`/api/profiles/${profile.id}/plan`, { data: {} });
  const session = (await planResponse.json())[0];
  await request.post(`/api/sessions/${session.id}/start`);
  for (const answer of [
    "I owned the reconciliation workflow and its audit trail.",
    "I handled retries and designed the process around the reporting constraints.",
    "I measured recovery behavior with integration tests and operational metrics.",
  ]) {
    await request.post(`/api/sessions/${session.id}/answer`, { data: { text: answer } });
  }

  await page.goto("http://127.0.0.1:8001/");
  await expect(page.getByText("Session usage")).toBeVisible();
  await expect(page.locator("#sessions")).toContainText(profile.name);
  await expect(page.locator("#sessions")).toContainText("3");
  await expect(page.locator("#usage")).toContainText("mock");
  await expect(page.locator("#usage")).toContainText(/\d+/);
  await expect(page.getByText("AI interviewer performance")).toBeVisible();
  await expect(page.locator("#agent-activities")).toContainText("What tradeoff or constraint");
  await expect(page.getByText("Conversation records")).toBeVisible();
  await expect(page.locator("#conversations")).toContainText("I owned the reconciliation workflow");
  await expect(page.locator("#conversations")).toContainText("agent");
});
