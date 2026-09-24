import { expect, test } from "@playwright/test";
import {
  createPublishedQuiz,
  joinAsPlayer,
  registerHost,
  startQuizFromDashboard,
} from "./helpers";

const TITLE = "E2E Capitals Quiz";

test("host runs a live paper and the player submits end to end", async ({ browser }) => {
  const hostCtx = await browser.newContext();
  const playerCtx = await browser.newContext();
  const host = await hostCtx.newPage();
  const player = await playerCtx.newPage();

  try {
    await registerHost(host);
    await createPublishedQuiz(host, TITLE);
    const joinCode = await startQuizFromDashboard(host, TITLE);

    await joinAsPlayer(player, joinCode, "E2E Player");

    // Start the paper; the player should transition to ACTIVE.
    await host.getByRole("button", { name: /Start paper/ }).click();
    await expect(player.getByRole("button", { name: "Submit paper" })).toBeVisible();

    // Player answers correctly and submits; the paper auto-finishes once the
    // only participant has submitted (natural end).
    await player.getByRole("button", { name: /Paris/ }).click();
    await player.getByRole("button", { name: "Submit paper" }).click();
    await player.getByRole("button", { name: "Submit", exact: true }).click();

    // Player reaches the finished leaderboard with full marks.
    await expect(player.getByText(`${TITLE} is over!`)).toBeVisible();
    await expect(player.getByText("E2E Player (you)")).toBeVisible();
    await expect(player.getByText(/You finished #1 with 1000 points/)).toBeVisible();

    // Host sees the same finished paper + leaderboard.
    await expect(host.getByText("Paper finished!")).toBeVisible();
    await expect(host.getByText("E2E Player")).toBeVisible();
  } finally {
    await playerCtx.close();
    await hostCtx.close();
  }
});