import { expect, test } from "@playwright/test";
import { registerHost } from "./helpers";

test.describe("quiz editor", () => {
  test("saving one of several unsaved questions does not duplicate or drop the rest", async ({ page }) => {
    await registerHost(page);

    await page.goto("/quizzes/new");
    await page.getByLabel("Title").fill("No-dup quiz");
    await page.getByRole("button", { name: /Create/ }).click();
    await page.waitForURL("**/edit");

    // Two brand-new, unsaved questions.
    await page.getByRole("button", { name: "Add question" }).click();
    await page.getByRole("button", { name: "Add question" }).click();
    const qInputs = page.locator('input[placeholder="What is the capital of France?"]');
    const option1 = page.locator('input[placeholder="Option 1"]');
    const option2 = page.locator('input[placeholder="Option 2"]');
    await qInputs.nth(0).fill("Alpha?");
    await option1.nth(0).fill("Paris");
    await option2.nth(0).fill("London");
    await page.locator('input[name="correct-0"]').first().check({ force: true });
    await qInputs.nth(1).fill("Beta?");
    await option1.nth(1).fill("Rome");
    await option2.nth(1).fill("Berlin");
    await page.locator('input[name="correct-1"]').first().check({ force: true });
    await expect(page.getByRole("button", { name: "Create question" })).toHaveCount(2);

    // Save only the first. The second must stay unsaved (Create question) and
    // nothing may be duplicated: exactly one Save + one Create afterwards.
    await page.getByRole("button", { name: "Create question" }).first().click();
    await expect(page.getByRole("button", { name: "Save question" })).toHaveCount(1);
    await expect(page.getByRole("button", { name: "Create question" })).toHaveCount(1);

    // Both texts survive the reload merge.
    await expect(qInputs.nth(0)).toHaveValue("Alpha?");
    await expect(qInputs.nth(1)).toHaveValue("Beta?");
  });
});