import { test, expect } from "@playwright/test";
import path from "node:path";

test("uploads Carlo resume and parses grouped experiences", async ({ page }) => {
  await page.goto("/");
  await page.locator('input[type="file"]').setInputFiles(path.resolve(__dirname, "../../tests/resources/CarloResume.txt"));
  await expect(page.locator("textarea")).toContainText("Carlo Morgan");
  await page.getByRole("button", { name: "Parse & save profile" }).click();
  await expect(page.getByText("Parsed experiences")).toBeVisible();
  const firmware = page.locator(".bullets .bullet").filter({ hasText: "Firmware Engineer I" });
  await expect(firmware).toBeVisible();
  await expect(firmware).toContainText("reducing RAM consumption");
});

test("runs a complete mock text interview and records agent activity", async ({ page, request }) => {
  await page.goto("/");
  await page.getByRole("textbox", { name: "Profile name" }).fill("E2E Carlo");
  await page.locator('input[type="file"]').setInputFiles(path.resolve(__dirname, "../../tests/resources/CarloResume.txt"));
  await page.getByRole("button", { name: "Parse & save profile" }).click();
  await expect(page.locator(".conversation .turn.agent").first()).toBeVisible();

  for (const [index, answer] of [
    "I implemented the embedded firmware and owned the testing approach.",
    "I chose the design because of the real-time constraint and validated it with integration tests.",
    "I measured reliability and documented the tradeoffs for the team.",
  ].entries()) {
    await page.locator(".composer textarea").fill(answer);
    const send = page.getByRole("button", { name: "Send answer" });
    await expect(send).toBeEnabled();
    await send.click();
    if (index < 2) await expect(page.getByText(`Round ${index + 2} of 5`)).toBeVisible();
  }

  await expect(page.locator(".anchor span")).toContainText("Round 1 of 5");
  await expect(page.getByText("Choose a bullet to explore")).not.toBeVisible();
  await expect(page.locator(".conversation")).toContainText("Now let's move on to");
  const performance = await request.get("http://127.0.0.1:8001/api/admin/agent-performance");
  expect(performance.ok()).toBeTruthy();
  expect((await performance.json()).summary.questions).toBeGreaterThanOrEqual(3);
});

test("runs the mock workflow for the additional PDF and DOCX resumes", async ({ page }) => {
  const fixtures = [
    { file: "Daniel_Chen_Senior_Database_Engineer.pdf", name: "Daniel Chen" },
    { file: "Melissa_Parker_Commercial_Real_Estate_Accountant.docx", name: "Melissa Parker" },
  ];

  for (const fixture of fixtures) {
    await page.goto("/");
    await page.getByRole("textbox", { name: "Profile name" }).fill(`E2E ${fixture.file.startsWith("Daniel") ? "Daniel" : "Melissa"}`);
    await page.locator('input[type="file"]').setInputFiles(path.resolve(__dirname, `../../tests/resources/${fixture.file}`));
    await expect(page.locator("textarea")).toContainText(fixture.name);
    await page.getByRole("button", { name: "Parse & save profile" }).click();
    await expect(page.locator(".bullets .bullet").first()).toBeVisible();
    await expect(page.locator(".conversation .turn.agent").first()).toBeVisible();

    for (const [index, answer] of [
      "I owned the implementation and documented the process.",
      "I validated the result against the operational constraints and reviewed alternatives.",
      "I measured the outcome and captured the lessons for future work.",
    ].entries()) {
      await page.locator(".composer textarea").fill(answer);
      const send = page.getByRole("button", { name: "Send answer" });
      await expect(send).toBeEnabled();
      await send.click();
      if (index < 2) await expect(page.getByText(`Round ${index + 2} of 5`)).toBeVisible();
    }
    await expect(page.locator(".anchor span")).toContainText("Round 1 of 5");
    await expect(page.getByText("Choose a bullet to explore")).not.toBeVisible();
    await expect(page.locator(".conversation")).toContainText("Now let's move on to");
  }
});
