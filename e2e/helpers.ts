import { expect, type Page } from "@playwright/test";

export const PASSWORD = "E2e-password-1234";

export function uniqueEmail(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.round(Math.random() * 1e6)}@e2e.dev`;
}

/** Register a fresh host and land on /dashboard. */
export async function registerHost(page: Page): Promise<string> {
  const email = uniqueEmail("host");
  await page.goto("/host/register");
  await page.getByPlaceholder("Your name").fill("E2E Host");
  await page.getByPlaceholder("you@example.com").fill(email);
  await page.getByLabel("Password (min 8 characters)").fill(PASSWORD);
  await page.getByLabel("Confirm password").fill(PASSWORD);
  await page.getByRole("button", { name: "Create account" }).click();
  await page.waitForURL("**/dashboard");
  return email;
}

/** Add one question (Paris is correct) and publish the quiz. Leaves the editor. */
export async function createPublishedQuiz(page: Page, title: string): Promise<void> {
  await page.goto("/quizzes/new");
  await page.getByLabel("Title").fill(title);
  await page.getByRole("button", { name: /Create/ }).click();
  await page.waitForURL("**/edit");

  await page.getByRole("button", { name: "Add question" }).click();
  await page
    .getByPlaceholder("What is the capital of France?")
    .fill("What is the capital of France?");
  await page.getByPlaceholder("Option 1").fill("Paris");
  await page.getByPlaceholder("Option 2").fill("London");
  await page.locator('input[name="correct-0"]').first().check({ force: true });
  await page.getByRole("button", { name: "Create question" }).click();
  await expect(page.getByRole("button", { name: "Save question" })).toBeVisible();

  await page.getByRole("button", { name: "Publish" }).click();
  await expect(page.getByRole("button", { name: "Unpublish" })).toBeVisible();
}

/** From /dashboard, host the quiz and return the 6-letter join code (on /live). */
export async function startQuizFromDashboard(page: Page, title: string): Promise<string> {
  await page.goto("/dashboard");
  const card = page
    .locator("div")
    .filter({ has: page.getByRole("heading", { name: title }) })
    .first();
  await expect(card).toBeVisible();
  await card.getByRole("button", { name: "Host" }).click();
  await page.waitForURL(/\/games\/[^/]+\/live$/);
  const code = (await page.locator("p.font-mono").first().textContent())!.trim();
  expect(code).toHaveLength(6);
  return code;
}

/** Player joins via /join and lands on /play. */
export async function joinAsPlayer(page: Page, code: string, nickname: string): Promise<void> {
  await page.goto("/join");
  await page.getByPlaceholder("ABCDEF").fill(code);
  await page.getByPlaceholder("Ms. Petty").fill(nickname);
  await page.getByRole("button", { name: "Join game" }).click();
  await page.waitForURL("**/play");
  await expect(page.getByText("You're in.")).toBeVisible();
}