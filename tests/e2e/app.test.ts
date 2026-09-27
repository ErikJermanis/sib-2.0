import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { expect, test, type Page } from "@playwright/test";

const baseUrl = "http://127.0.0.1:4173";

function createPairingLink(deviceName: string): string {
  return execFileSync(path.resolve("app"), ["create-pairing-link", "--name", deviceName], {
    cwd: process.cwd(),
    encoding: "utf8",
    env: {
      ...process.env,
      DATABASE_PATH: process.env.DATABASE_PATH,
      PUBLIC_BASE_URL: baseUrl,
      NODE_ENV: "production",
    },
  }).trim();
}

async function outboxCount(page: Page): Promise<number> {
  return page.evaluate(
    () =>
      new Promise<number>((resolve, reject) => {
        const open = indexedDB.open("sib-2.0");
        open.onerror = () => reject(open.error);
        open.onsuccess = () => {
          const database = open.result;
          const transaction = database.transaction("sync_outbox", "readonly");
          const count = transaction.objectStore("sync_outbox").count();
          count.onerror = () => reject(count.error);
          count.onsuccess = () => resolve(count.result);
          transaction.oncomplete = () => database.close();
        };
      }),
  );
}

async function longPress(page: Page, selector: string): Promise<void> {
  const target = page.locator(selector).first();
  await target.scrollIntoViewIfNeeded();
  await expect(target).toBeVisible();
  const box = await target.boundingBox();
  if (!box) throw new Error(`Cannot long press ${selector}`);
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.waitForTimeout(550);
  await page.mouse.up();
}

test("pairs a device and supports local-first shopping and travel", async ({ page, context }, testInfo) => {
  await page.goto("/shopping");
  await expect(page.getByRole("heading", { name: "Uređaj nije povezan" })).toBeVisible();

  await page.goto(createPairingLink(`E2E ${testInfo.project.name} ${randomUUID()}`));
  await expect(page).toHaveURL(/\/shopping$/);
  await expect(page.getByRole("heading", { name: "Za kupiti" })).toBeVisible();

  const suffix = randomUUID().slice(0, 8);
  const milk = `Mlijeko ${suffix}`;
  const editedMilk = `Zobeno mlijeko ${suffix}`;
  const bread = `Kruh ${suffix}`;

  await page.getByLabel("Nova stavka za kupovinu").fill(milk);
  await page.getByLabel("Nova stavka za kupovinu").press("Enter");
  await expect(page.getByLabel("Nova stavka za kupovinu")).toBeFocused();
  await page.getByLabel("Nova stavka za kupovinu").fill(bread);
  await page.getByLabel("Nova stavka za kupovinu").press("Enter");
  await expect(page.locator(".shopping-row", { hasText: milk })).toBeVisible();
  await expect.poll(() => outboxCount(page)).toBe(0);

  await longPress(page, `.shopping-row:has-text("${milk}") .shopping-text`);
  const edit = page.getByLabel("Uredi stavku");
  await expect(edit).toBeVisible();
  await edit.fill(editedMilk);
  await edit.press("Enter");
  await expect(page.locator(".shopping-row", { hasText: editedMilk })).toBeVisible();

  const breadRow = page.locator(".shopping-row", { hasText: bread });
  await breadRow.getByRole("button", { name: /Promijeni redoslijed/ }).press("ArrowUp");
  await expect
    .poll(async () => {
      const rows = await page.locator(".shopping-list").first().locator(".shopping-row").allTextContents();
      return rows.findIndex((text) => text.includes(bread)) < rows.findIndex((text) => text.includes(editedMilk));
    })
    .toBe(true);

  const editedRow = page.locator(".shopping-row", { hasText: editedMilk });
  await editedRow.getByRole("button", { name: /Označi kupljenim/ }).click();
  await expect(page.getByRole("heading", { name: "Kupljeno" })).toBeVisible();
  await expect
    .poll(() =>
      page.locator(".paper").evaluate((paper) => {
        const activeList = paper.querySelector('[aria-label="Aktivne stavke"]');
        const addRow = paper.querySelector('[aria-label="Dodaj na popis"]');
        const boughtList = paper.querySelector('[aria-label="Kupljene stavke"]');
        if (!activeList || !addRow || !boughtList) return false;
        return Boolean(
          activeList.compareDocumentPosition(addRow) & Node.DOCUMENT_POSITION_FOLLOWING &&
            addRow.compareDocumentPosition(boughtList) & Node.DOCUMENT_POSITION_FOLLOWING,
        );
      }),
    )
    .toBe(true);
  await page.getByRole("button", { name: `Vrati na popis: ${editedMilk}` }).click();
  await expect(page.locator(".shopping-list").first()).toContainText(editedMilk);

  await page.getByRole("tab", { name: "Putovanja" }).click();
  await expect(page).toHaveURL(/\/travel$/);
  const destination = `Lisabon ${suffix}`;
  await page.getByLabel("Novo mjesto za putovanje").fill(destination);
  await page.getByLabel("Novo mjesto za putovanje").press("Enter");
  await expect(page.locator(".travel-card", { hasText: destination })).toBeVisible();
  await longPress(page, `.travel-card:has-text("${destination}") .travel-card-body`);
  await page.getByRole("button", { name: "Posjećeno" }).click();
  const visitedCard = page.locator(".travel-card", { hasText: destination });
  await expect(visitedCard).toHaveClass(/is-visited/);
  await longPress(page, `.travel-card:has-text("${destination}") .travel-card-body`);
  await page.getByRole("button", { name: "Označi neposjećenim" }).click();
  await expect(visitedCard).not.toHaveClass(/is-visited/);

  await page.evaluate(() => navigator.serviceWorker.ready.then(() => undefined));
  await page.reload();
  await expect.poll(() => page.evaluate(() => Boolean(navigator.serviceWorker.controller))).toBe(true);
  await context.setOffline(true);
  await page.reload();
  await expect(page.getByRole("heading", { name: "Naša putovanja" })).toBeVisible();
  const offlineDestination = `Offline ${suffix}`;
  await page.getByLabel("Novo mjesto za putovanje").fill(offlineDestination);
  await page.getByLabel("Novo mjesto za putovanje").press("Enter");
  await expect(page.locator(".travel-card", { hasText: offlineDestination })).toBeVisible();
  await expect.poll(() => outboxCount(page)).toBeGreaterThan(0);

  await context.setOffline(false);
  await page.reload();
  await expect.poll(() => outboxCount(page), { timeout: 10_000 }).toBe(0);
});

test("pairs a fresh installed-app context by pasting a one-use link", async ({ page }, testInfo) => {
  await page.goto("/shopping");
  const field = page.getByRole("textbox", { name: "Poveznica za povezivanje" });
  await expect(field).toBeVisible();

  const previouslyUsed = createPairingLink(`Browser ${testInfo.project.name} ${randomUUID()}`);
  await page.goto(previouslyUsed);
  await expect(page.getByRole("heading", { name: "Za kupiti" })).toBeVisible();
  await page.context().clearCookies(); // A home-screen installation starts without Safari's session.
  await page.reload();
  await expect(field).toBeVisible();
  await field.fill(previouslyUsed);
  await page.getByRole("button", { name: "Poveži uređaj" }).click();
  await expect(page.getByRole("alert")).toContainText("već iskorištena");
  await expect(field).toHaveValue(previouslyUsed);

  const installedLink = createPairingLink(`Installed ${testInfo.project.name} ${randomUUID()}`);
  await field.fill(installedLink);
  await page.getByRole("button", { name: "Poveži uređaj" }).click();
  await expect(page.getByRole("heading", { name: "Za kupiti" })).toBeVisible();
  await expect.poll(() => page.evaluate(async () => (await fetch("/api/session")).status)).toBe(200);
});

test("keeps add and edit fields mounted while sync updates the UI", async ({ page }, testInfo) => {
  await page.goto(createPairingLink(`Focus ${testInfo.project.name} ${randomUUID()}`));
  const shoppingAdd = page.getByLabel("Nova stavka za kupovinu");
  await expect(shoppingAdd).toBeVisible();
  const item = `Focus ${randomUUID()}`;
  await shoppingAdd.fill(item);
  await shoppingAdd.press("Enter");
  await expect(page.locator(".shopping-row", { hasText: item })).toBeVisible();

  async function syncWhileTyping(selector: string): Promise<void> {
    const field = page.locator(selector);
    await expect.poll(() => outboxCount(page)).toBe(0);
    const selection = await field.evaluate((element) => {
      const input = element as HTMLInputElement;
      input.dataset.focusMarker = "original";
      return [input.selectionStart, input.selectionEnd];
    });
    await Promise.all([
      page.waitForResponse((response) => response.url().endsWith("/api/sync") && response.request().method() === "POST"),
      page.evaluate(() => document.dispatchEvent(new Event("visibilitychange"))),
    ]);
    await expect(page.locator(".sync-indicator").first()).toBeHidden();
    await expect(field).toBeFocused();
    await expect(field).toHaveAttribute("data-focus-marker", "original");
    await expect.poll(() => field.evaluate((element) => {
      const input = element as HTMLInputElement;
      return [input.selectionStart, input.selectionEnd];
    })).toEqual(selection);
  }

  await shoppingAdd.fill("Shopping draft");
  await syncWhileTyping(".add-input");
  await expect(shoppingAdd).toHaveValue("Shopping draft");
  await shoppingAdd.fill("");

  await longPress(page, `.shopping-row:has-text("${item}") .shopping-text`);
  const shoppingEdit = page.getByLabel("Uredi stavku");
  await shoppingEdit.fill("Shopping edit draft");
  await syncWhileTyping(".inline-edit");
  await expect(shoppingEdit).toHaveValue("Shopping edit draft");
  await shoppingEdit.press("Enter");
  await expect(page.locator(".shopping-row", { hasText: "Shopping edit draft" })).toBeVisible();

  await page.getByRole("tab", { name: "Putovanja" }).click();
  const travelAdd = page.getByLabel("Novo mjesto za putovanje");
  await travelAdd.fill("Travel draft");
  await syncWhileTyping(".travel-add-input");
  await expect(travelAdd).toHaveValue("Travel draft");
  await travelAdd.press("Enter");
  await expect(page.locator(".travel-card", { hasText: "Travel draft" })).toBeVisible();

  await longPress(page, ".travel-card:has-text('Travel draft') .travel-card-body");
  await page.getByRole("button", { name: "Uredi" }).click();
  const travelEdit = page.getByLabel("Uredi odredište");
  await travelEdit.fill("Travel edit draft");
  await syncWhileTyping(".travel-edit");
  await expect(travelEdit).toHaveValue("Travel edit draft");
  await travelEdit.press("Enter");
  await expect(page.locator(".travel-card", { hasText: "Travel edit draft" })).toBeVisible();
});
