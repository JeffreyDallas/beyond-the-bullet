import { test, expect } from "@playwright/test";

test("renders session, usage, interviewer, and conversation data in the admin dashboard", async ({ page, request }) => {
  const profileResponse = await request.post("/api/profiles", {
    data: {
      name: "E2E Admin",
      raw_text: "Built a reliable payment reconciliation service with audit-ready reports and measurable recovery improvements.\nDesigned a resilient ingestion workflow that preserved ordering during retries and deployments.\nImproved operational recovery by measuring failure behavior with integration tests and dashboards.",
    },
  });
  const profile = await profileResponse.json();
  const planResponse = await request.post(`/api/profiles/${profile.id}/plan`, { data: {} });
  const sessions = await planResponse.json();
  for (const [index, session] of sessions.entries()) {
    await request.post(`/api/sessions/${session.id}/start`);
    await request.post(`/api/sessions/${session.id}/answer`, { data: { text: `I owned session ${index + 1} and documented its operational outcome.` } });
  }

  await page.goto("http://127.0.0.1:8001/");

  await expect(page).toHaveTitle("Beyond the Bullet Admin");
  await expect(page.getByRole("heading", { name: "Admin dashboard" })).toBeVisible();

  await expect(page.getByRole("button", { name: "Sessions table" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Users & progress" })).toBeVisible();

  await expect(page.getByRole("heading", { name: "Session usage" })).toBeVisible();
  await expect(page.locator("#sessions")).toContainText(profile.name);
  await expect(page.locator("#sessions tr")).toHaveCount(3);

  await expect(page.getByRole("heading", { name: "LLM calls" })).toBeVisible();
  await expect(page.locator("#usage")).toContainText("mock");
  await expect(page.locator("#usage")).toContainText(/\d+/);

  await expect(page.getByRole("heading", { name: "AI interviewer performance" })).toBeVisible();
  await expect(page.locator("#agent-activities")).toContainText("What is the most important detail");

  await expect(page.getByRole("heading", { name: "Conversation records" })).not.toBeVisible();

  await page.getByRole("button", { name: "Users & progress" }).click();
  await expect(page.locator("#user-list")).toContainText("E2E Admin");
  await page.locator('[data-user="E2E Admin"]').click();
  await expect(page.locator("#user-detail")).toContainText("Sessions for E2E Admin");
  await expect(page.locator("#user-detail")).toContainText("I owned session 3");
  await expect(page.locator("#session-select")).toHaveCount(1);
  await expect(page.locator("#session-select option")).toHaveCount(3);
  await page.locator("#session-select").selectOption(sessions[1].id);
  await expect(page.locator("#user-detail")).toContainText("I owned session 2");
  await expect(page.locator("#user-detail")).not.toContainText("I owned session 1");
});
