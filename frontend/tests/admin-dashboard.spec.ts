import { test, expect } from "@playwright/test";

test("renders session, usage, interviewer, and conversation data in the admin dashboard", async ({ page, request }) => {
  const profileResponse = await request.post("/api/profiles", {
    data: {
      name: "E2E Admin",
      raw_text: "Built a reliable payment reconciliation service with audit-ready reports and measurable recovery improvements.",
    },
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

  await expect(page).toHaveTitle("Beyond the Bullet Admin");
  await expect(page.getByRole("heading", { name: "Admin dashboard" })).toBeVisible();

  await expect(page.getByRole("button", { name: "Sessions table" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Users & progress" })).toBeVisible();

  await expect(page.getByRole("heading", { name: "Session usage" })).toBeVisible();
  await expect(page.locator("#sessions")).toContainText(profile.name);
  await expect(page.locator("#sessions")).toContainText("3");

  await expect(page.getByRole("heading", { name: "LLM calls" })).toBeVisible();
  await expect(page.locator("#usage")).toContainText("mock");
  await expect(page.locator("#usage")).toContainText(/\d+/);

  await expect(page.getByRole("heading", { name: "AI interviewer performance" })).toBeVisible();
  await expect(page.locator("#agent-activities")).toContainText("What tradeoff or constraint");

  await expect(page.getByRole("heading", { name: "Conversation records" })).toBeVisible();
  await expect(page.locator("#conversations")).toContainText("I owned the reconciliation workflow");
  await expect(page.locator("#conversations")).toContainText("agent");

  await page.getByRole("button", { name: "Users & progress" }).click();
  await expect(page.locator("#user-list")).toContainText("E2E Admin");
  await page.locator('[data-user="E2E Admin"]').click();
  await expect(page.locator("#user-detail")).toContainText("Sessions for E2E Admin");
});
