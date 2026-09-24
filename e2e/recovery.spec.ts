import { expect, test } from "@playwright/test";
import {
  createPublishedQuiz,
  joinAsPlayer,
  registerHost,
  startQuizFromDashboard,
} from "./helpers";

const TITLE = "E2E Recovery Quiz";

test("player refresh mid-paper restores answers and keeps the paper active", async ({
  browser,
}) => {
  const hostCtx = await browser.newContext();
  const playerCtx = await browser.newContext();
  const host = await hostCtx.newPage();
  const player = await playerCtx.newPage();

  try {
    await registerHost(host);
    await createPublishedQuiz(host, TITLE);
    const joinCode = await startQuizFromDashboard(host, TITLE);
    await joinAsPlayer(player, joinCode, "Recovery Player");

    await host.getByRole("button", { name: /Start paper/ }).click();
    await expect(player.getByRole("button", { name: "Submit paper" })).toBeVisible();

    // Answer, then kill the tab (simulates a flaky mobile device).
    const parisButton = player.getByRole("button", { name: /Paris/ });
    await parisButton.click();
    await expect(parisButton).toHaveClass(/border-violet-500/);

    // Refresh: the cookie re-identifies the player, the socket re-syncs, and
    // the server-side selection is restored.
    await player.reload();
    await expect(player.getByRole("button", { name: "Submit paper" })).toBeVisible();
    const restored = player.getByRole("button", { name: /Paris/ });
    await expect(restored).toHaveClass(/border-violet-500/);

    // The rest of the paper still works after recovery.
    await player.getByRole("button", { name: "Submit paper" }).click();
    await player.getByRole("button", { name: "Submit", exact: true }).click();
    await expect(player.getByText(`${TITLE} is over!`)).toBeVisible();
    await expect(player.getByText("Recovery Player (you)")).toBeVisible();
  } finally {
    await playerCtx.close();
    await hostCtx.close();
  }
});