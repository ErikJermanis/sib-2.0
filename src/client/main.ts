import { registerSW } from "virtual:pwa-register";
import type { ShoppingItem, TravelItem } from "../shared/protocol";
import {
  commitLocalChanges,
  getShoppingItems,
  getTravelItems,
  makeShoppingItem,
  makeTravelItem,
  subscribeToDb,
} from "./db";
import { createSyncEngine, type SyncStatus } from "./sync";
import "./styles.css";

type Route = "shopping" | "travel";

const appElement = document.querySelector<HTMLDivElement>("#app");
if (!appElement) throw new Error("Nedostaje korijenski element aplikacije.");
const app = appElement;

let route: Route = location.pathname === "/travel" ? "travel" : "shopping";
let shoppingEditId: string | null = null;
let shoppingEditDraft: string | null = null;
let shoppingAddDraft = "";
let travelEditId: string | null = null;
let travelEditDraft: string | null = null;
let travelAddDraft = "";
let travelMenuId: string | null = null;
let travelDeleteConfirm = false;
let focusShoppingHandleId: string | null = null;
let focusShoppingAddInput = false;
let focusNavRoute: Route | null = null;
let renderSequence = 0;
let storageError: string | null = null;
let syncStatus: SyncStatus = { phase: "idle", prominent: false, lastSuccessAt: null };
let mutationQueue = Promise.resolve();

const syncEngine = createSyncEngine({
  onStatus(status) {
    syncStatus = status;
    void render();
  },
});

function element<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className?: string,
  text?: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function button(className: string, label: string): HTMLButtonElement {
  const node = element("button", className, label);
  node.type = "button";
  return node;
}

function icon(name: "cart" | "pin" | "grip" | "check"): SVGSVGElement {
  const namespace = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(namespace, "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("aria-hidden", "true");
  svg.setAttribute("focusable", "false");
  const paths: Record<typeof name, string[]> = {
    cart: [
      "M3 4h2l2.2 10.2a2 2 0 0 0 2 1.6h7.9a2 2 0 0 0 2-1.6L20.5 8H6",
      "M9.5 20a1 1 0 1 0 0-2 1 1 0 0 0 0 2Zm7 0a1 1 0 1 0 0-2 1 1 0 0 0 0 2Z",
    ],
    pin: ["M20 10c0 5-8 11-8 11S4 15 4 10a8 8 0 1 1 16 0Z", "M12 13a3 3 0 1 0 0-6 3 3 0 0 0 0 6Z"],
    grip: ["M8 7h8M8 12h8M8 17h8"],
    check: ["m7 12 3 3 7-7"],
  };
  for (const value of paths[name]) {
    const path = document.createElementNS(namespace, "path");
    path.setAttribute("d", value);
    path.setAttribute("fill", "none");
    path.setAttribute("stroke", "currentColor");
    path.setAttribute("stroke-width", "1.8");
    path.setAttribute("stroke-linecap", "round");
    path.setAttribute("stroke-linejoin", "round");
    svg.append(path);
  }
  return svg;
}

function activeShopping(items: ShoppingItem[]): ShoppingItem[] {
  return items
    .filter((item) => item.deletedAt === null && !item.completed)
    .sort((left, right) => left.position - right.position || left.createdAt.localeCompare(right.createdAt));
}

function boughtShopping(items: ShoppingItem[]): ShoppingItem[] {
  return items
    .filter((item) => item.deletedAt === null && item.completed)
    .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
}

function currentRoute(): Route {
  return location.pathname === "/travel" ? "travel" : "shopping";
}

function navigate(nextRoute: Route): void {
  if (route === nextRoute) return;
  history.pushState(null, "", nextRoute === "shopping" ? "/shopping" : "/travel");
  route = nextRoute;
  closeTransientUi();
  void render();
}

function closeTransientUi(): void {
  shoppingEditId = null;
  shoppingEditDraft = null;
  travelEditId = null;
  travelEditDraft = null;
  travelMenuId = null;
  travelDeleteConfirm = false;
}

function reportStorageError(error: unknown): void {
  storageError = error instanceof Error ? error.message : "Dogodila se pogreška lokalne baze.";
  void render();
}

async function mutate(action: () => Promise<void>): Promise<void> {
  const pending = mutationQueue.then(action);
  mutationQueue = pending.catch(() => undefined);
  try {
    await pending;
    storageError = null;
    void syncEngine.requestSync().catch(reportStorageError);
  } catch (error) {
    reportStorageError(error);
  }
}

function addLongPress(target: HTMLElement, activate: () => void): void {
  let timer: number | undefined;
  let startX = 0;
  let startY = 0;

  const cancel = () => {
    if (timer !== undefined) window.clearTimeout(timer);
    timer = undefined;
    target.classList.remove("is-pressing");
  };

  target.addEventListener("pointerdown", (event) => {
    if (event.button !== 0 || (event.target as HTMLElement).closest("button, input")) return;
    startX = event.clientX;
    startY = event.clientY;
    target.classList.add("is-pressing");
    timer = window.setTimeout(() => {
      timer = undefined;
      target.classList.remove("is-pressing");
      activate();
    }, 500);
  });
  target.addEventListener("pointermove", (event) => {
    if (Math.hypot(event.clientX - startX, event.clientY - startY) > 10) cancel();
  });
  target.addEventListener("pointerup", cancel);
  target.addEventListener("pointercancel", cancel);
  target.addEventListener("contextmenu", cancel);
}

function renderSyncIndicator(): HTMLDivElement {
  const status = element("div", "sync-indicator");
  status.setAttribute("aria-live", "polite");

  if (syncStatus.phase === "syncing") {
    status.classList.add("is-syncing");
    status.append(element("span", "sync-dot"), document.createTextNode("Sinkronizacija..."));
  } else if (syncStatus.phase === "offline") {
    status.classList.add("is-offline");
    status.append(element("span", "sync-dot"), document.createTextNode("Izvan mreže"));
  } else {
    status.hidden = true;
  }
  return status;
}

function renderTopbar(title: string): HTMLElement {
  const header = element("header", "topbar");
  const brand = element("div", "brand-mark", "SiB");
  const heading = element("h1", "page-title", title);
  const status = renderSyncIndicator();
  header.append(brand, heading, status);
  return header;
}

function renderErrorBanner(): HTMLElement | null {
  if (!storageError) return null;
  const banner = element("div", "error-banner");
  banner.setAttribute("role", "alert");
  banner.append(element("strong", "", "Lokalni podaci nisu dostupni"), element("span", "", storageError));
  return banner;
}

function renderNav(): HTMLElement {
  const nav = element("nav", "bottom-nav");
  nav.setAttribute("role", "tablist");
  nav.setAttribute("aria-label", "Glavni izbornik");

  const makeTab = (tabRoute: Route, label: string, tabIcon: "cart" | "pin") => {
    const link = element("a", `nav-tab${route === tabRoute ? " is-active" : ""}`);
    link.href = tabRoute === "shopping" ? "/shopping" : "/travel";
    link.setAttribute("role", "tab");
    link.id = `${tabRoute}-tab`;
    link.setAttribute("aria-selected", String(route === tabRoute));
    link.setAttribute("aria-controls", `${tabRoute}-panel`);
    link.tabIndex = route === tabRoute ? 0 : -1;
    link.append(icon(tabIcon), element("span", "", label));
    link.addEventListener("click", (event) => {
      event.preventDefault();
      navigate(tabRoute);
    });
    link.addEventListener("keydown", (event) => {
      if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
      event.preventDefault();
      focusNavRoute = tabRoute === "shopping" ? "travel" : "shopping";
      navigate(tabRoute === "shopping" ? "travel" : "shopping");
    });
    return link;
  };

  nav.append(makeTab("shopping", "Kupovina", "cart"), makeTab("travel", "Putovanja", "pin"));
  return nav;
}

async function addShopping(text: string): Promise<void> {
  const items = await getShoppingItems();
  const positions = activeShopping(items).map((item) => item.position);
  const position = positions.length === 0 ? 0 : Math.max(...positions) + 1;
  await commitLocalChanges("shopping_item", [makeShoppingItem(text, position)]);
}

async function updateShopping(id: string, update: (item: ShoppingItem) => ShoppingItem): Promise<void> {
  const item = (await getShoppingItems()).find((candidate) => candidate.id === id && candidate.deletedAt === null);
  if (!item) return;
  await commitLocalChanges("shopping_item", [update(item)]);
}

async function reorderShopping(desiredIds: string[]): Promise<void> {
  const current = activeShopping(await getShoppingItems());
  const byId = new Map(current.map((item) => [item.id, item]));
  const orderedIds = [
    ...desiredIds.filter((id) => byId.has(id)),
    ...current.map((item) => item.id).filter((id) => !desiredIds.includes(id)),
  ];
  const now = new Date().toISOString();
  const changed = orderedIds.flatMap((id, position) => {
    const item = byId.get(id);
    return item && item.position !== position ? [{ ...item, position, updatedAt: now }] : [];
  });
  await commitLocalChanges("shopping_item", changed);
}

function beginShoppingDrag(event: PointerEvent, row: HTMLLIElement, list: HTMLUListElement): void {
  if (event.button !== 0) return;
  event.preventDefault();
  const handle = event.currentTarget as HTMLButtonElement;
  const rect = row.getBoundingClientRect();
  const pointerOffset = event.clientY - rect.top;
  const placeholder = element("li", "shopping-placeholder");
  placeholder.style.height = `${rect.height}px`;
  list.insertBefore(placeholder, row);
  document.body.append(row);
  row.classList.add("is-dragging");
  Object.assign(row.style, {
    position: "fixed",
    left: `${rect.left}px`,
    top: `${rect.top}px`,
    width: `${rect.width}px`,
    zIndex: "20",
  });
  handle.setPointerCapture(event.pointerId);

  const move = (moveEvent: PointerEvent) => {
    row.style.top = `${moveEvent.clientY - pointerOffset}px`;
    const candidates = [...list.querySelectorAll<HTMLLIElement>("[data-shopping-row]")];
    const before = candidates.find(
      (candidate) => moveEvent.clientY < candidate.getBoundingClientRect().top + candidate.offsetHeight / 2,
    );
    if (before) list.insertBefore(placeholder, before);
    else list.append(placeholder);
  };

  const finish = () => {
    window.removeEventListener("pointermove", move);
    window.removeEventListener("pointerup", finish);
    window.removeEventListener("pointercancel", cancel);
    row.removeAttribute("style");
    row.classList.remove("is-dragging");
    list.insertBefore(row, placeholder);
    placeholder.remove();
    const order = [...list.querySelectorAll<HTMLElement>("[data-shopping-row]")].flatMap((itemRow) =>
      itemRow.dataset.shoppingRow ? [itemRow.dataset.shoppingRow] : [],
    );
    focusShoppingHandleId = row.dataset.shoppingRow ?? null;
    void mutate(() => reorderShopping(order));
  };

  const cancel = () => {
    window.removeEventListener("pointermove", move);
    window.removeEventListener("pointerup", finish);
    window.removeEventListener("pointercancel", cancel);
    row.removeAttribute("style");
    row.classList.remove("is-dragging");
    list.insertBefore(row, placeholder);
    placeholder.remove();
  };

  window.addEventListener("pointermove", move);
  window.addEventListener("pointerup", finish, { once: true });
  window.addEventListener("pointercancel", cancel, { once: true });
}

function shoppingEditInput(item: ShoppingItem): HTMLInputElement {
  const input = element("input", "inline-edit");
  input.type = "text";
  input.value = shoppingEditDraft ?? item.text;
  input.maxLength = 240;
  input.setAttribute("aria-label", "Uredi stavku");
  input.addEventListener("pointerdown", (event) => event.stopPropagation());
  input.addEventListener("input", () => {
    shoppingEditDraft = input.value;
  });
  input.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
      event.preventDefault();
      shoppingEditId = null;
      shoppingEditDraft = null;
      void render();
    } else if (event.key === "Enter") {
      event.preventDefault();
      const text = input.value.trim();
      shoppingEditId = null;
      shoppingEditDraft = null;
      if (!text || text === item.text) void render();
      else
        void mutate(() =>
          updateShopping(item.id, (fresh) => ({ ...fresh, text, updatedAt: new Date().toISOString() })),
        );
    }
  });
  input.addEventListener("blur", () => {
    if (shoppingEditId === item.id) {
      shoppingEditId = null;
      shoppingEditDraft = null;
      void render();
    }
  });
  queueMicrotask(() => {
    input.focus();
    input.select();
  });
  return input;
}

function renderShoppingRow(item: ShoppingItem, list: HTMLUListElement, allActive: ShoppingItem[]): HTMLLIElement {
  const row = element("li", "shopping-row");
  row.dataset.shoppingRow = item.id;
  const complete = button("complete-button", "");
  complete.setAttribute("aria-label", `Označi kupljenim: ${item.text}`);
  complete.addEventListener("click", () => {
    void mutate(() =>
      updateShopping(item.id, (fresh) => ({ ...fresh, completed: true, updatedAt: new Date().toISOString() })),
    );
  });

  const content = element("div", "shopping-text");
  if (shoppingEditId === item.id) content.append(shoppingEditInput(item));
  else {
    content.textContent = item.text;
    content.title = "Držite za uređivanje";
    addLongPress(content, () => {
      shoppingEditId = item.id;
      shoppingEditDraft = item.text;
      void render();
    });
  }

  const handle = button("drag-handle", "");
  handle.append(icon("grip"));
  handle.setAttribute("aria-label", `Promijeni redoslijed: ${item.text}`);
  handle.addEventListener("pointerdown", (event) => beginShoppingDrag(event, row, list));
  handle.addEventListener("keydown", (event) => {
    if (event.key !== "ArrowUp" && event.key !== "ArrowDown") return;
    event.preventDefault();
    const index = allActive.findIndex((candidate) => candidate.id === item.id);
    const nextIndex = event.key === "ArrowUp" ? index - 1 : index + 1;
    if (index < 0 || nextIndex < 0 || nextIndex >= allActive.length) return;
    const ids = allActive.map((candidate) => candidate.id);
    [ids[index], ids[nextIndex]] = [ids[nextIndex] as string, ids[index] as string];
    focusShoppingHandleId = item.id;
    void mutate(() => reorderShopping(ids));
  });
  row.append(complete, content, handle);
  return row;
}

function renderBoughtRow(item: ShoppingItem): HTMLLIElement {
  const row = element("li", "shopping-row bought-row");
  const complete = button("complete-button is-complete", "");
  complete.append(icon("check"));
  complete.setAttribute("aria-label", `Vrati na popis: ${item.text}`);
  complete.addEventListener("click", () => {
    void mutate(async () => {
      const items = await getShoppingItems();
      const fresh = items.find((candidate) => candidate.id === item.id && candidate.deletedAt === null);
      if (!fresh) return;
      const current = activeShopping(items);
      const position = current.length === 0 ? 0 : Math.max(...current.map((candidate) => candidate.position)) + 1;
      await commitLocalChanges("shopping_item", [
        { ...fresh, completed: false, position, updatedAt: new Date().toISOString() },
      ]);
    });
  });
  row.append(complete, element("div", "shopping-text", item.text));
  return row;
}

function renderShopping(items: ShoppingItem[]): HTMLElement {
  const panel = element("main", "route-panel shopping-panel");
  panel.id = "shopping-panel";
  panel.setAttribute("role", "tabpanel");
  panel.setAttribute("aria-label", "Kupovina");
  panel.setAttribute("aria-labelledby", "shopping-tab");
  const error = renderErrorBanner();
  if (error) panel.append(error);

  const paper = element("section", "paper");
  const paperTitle = element("div", "paper-heading");
  paperTitle.append(element("h2", "", "Za kupiti"), renderSyncIndicator());
  const addRow = element("div", "shopping-add-row");
  addRow.setAttribute("aria-label", "Dodaj na popis");
  const addCircle = element("span", "add-circle");
  const input = element("input", "add-input");
  input.type = "text";
  input.value = shoppingAddDraft;
  input.placeholder = "Dodaj na popis...";
  input.maxLength = 240;
  input.setAttribute("aria-label", "Nova stavka za kupovinu");
  input.addEventListener("input", () => {
    shoppingAddDraft = input.value;
  });
  input.addEventListener("keydown", (event) => {
    if (event.key !== "Enter") return;
    event.preventDefault();
    const text = input.value.trim();
    if (!text) return;
    shoppingAddDraft = "";
    input.value = "";
    focusShoppingAddInput = true;
    void mutate(() => addShopping(text));
  });
  addRow.append(addCircle, input);

  const active = activeShopping(items);
  const list = element("ul", "shopping-list");
  list.setAttribute("aria-label", "Aktivne stavke");
  for (const item of active) list.append(renderShoppingRow(item, list, active));
  if (active.length === 0) list.append(element("li", "paper-empty", "Popis je prazan. Što nam treba?"));
  // Keep the entry field attached to the unbought list, like its empty final row.
  paper.append(paperTitle, list, addRow);

  const bought = boughtShopping(items);
  if (bought.length > 0) {
    const divider = element("div", "bought-heading");
    divider.append(element("h3", "", "Kupljeno"));
    const clear = button("clear-bought", "Obriši kupljeno");
    clear.addEventListener("click", () => {
      void mutate(async () => {
        const now = new Date().toISOString();
        const freshBought = boughtShopping(await getShoppingItems());
        await commitLocalChanges(
          "shopping_item",
          freshBought.map((item) => ({ ...item, deletedAt: now, updatedAt: now })),
        );
      });
    });
    divider.append(clear);
    const boughtList = element("ul", "shopping-list bought-list");
    boughtList.setAttribute("aria-label", "Kupljene stavke");
    for (const item of bought) boughtList.append(renderBoughtRow(item));
    paper.append(divider, boughtList);
  }

  panel.append(paper);
  if (focusShoppingHandleId) {
    const id = focusShoppingHandleId;
    focusShoppingHandleId = null;
    queueMicrotask(() =>
      panel.querySelector<HTMLElement>(`[data-shopping-row="${CSS.escape(id)}"] .drag-handle`)?.focus(),
    );
  }
  if (focusShoppingAddInput) {
    input.autofocus = true;
  }
  return panel;
}

async function addTravel(text: string): Promise<void> {
  await commitLocalChanges("travel_item", [makeTravelItem(text)]);
}

async function updateTravel(id: string, update: (item: TravelItem) => TravelItem): Promise<void> {
  const item = (await getTravelItems()).find((candidate) => candidate.id === id && candidate.deletedAt === null);
  if (!item) return;
  await commitLocalChanges("travel_item", [update(item)]);
}

function travelEditInput(item: TravelItem): HTMLInputElement {
  const input = element("input", "travel-edit");
  input.type = "text";
  input.value = travelEditDraft ?? item.text;
  input.maxLength = 240;
  input.setAttribute("aria-label", "Uredi odredište");
  input.addEventListener("input", () => {
    travelEditDraft = input.value;
  });
  input.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
      event.preventDefault();
      travelEditId = null;
      travelEditDraft = null;
      void render();
    } else if (event.key === "Enter") {
      event.preventDefault();
      const text = input.value.trim();
      travelEditId = null;
      travelEditDraft = null;
      if (!text || text === item.text) void render();
      else
        void mutate(() => updateTravel(item.id, (fresh) => ({ ...fresh, text, updatedAt: new Date().toISOString() })));
    }
  });
  input.addEventListener("blur", () => {
    if (travelEditId === item.id) {
      travelEditId = null;
      travelEditDraft = null;
      void render();
    }
  });
  queueMicrotask(() => {
    input.focus();
    input.select();
  });
  return input;
}

function renderTravelActions(item: TravelItem): HTMLElement {
  const actions = element("div", "travel-actions");
  if (item.visited) {
    const unvisit = button("travel-action action-unvisit", "Označi neposjećenim");
    unvisit.addEventListener("click", () => {
      travelMenuId = null;
      void mutate(() =>
        updateTravel(item.id, (fresh) => ({ ...fresh, visited: false, updatedAt: new Date().toISOString() })),
      );
    });
    actions.append(unvisit);
    return actions;
  }

  if (travelDeleteConfirm) {
    const confirm = button("travel-action action-delete-confirm", "Potvrdi brisanje");
    confirm.addEventListener("click", () => {
      travelMenuId = null;
      travelDeleteConfirm = false;
      const now = new Date().toISOString();
      void mutate(() => updateTravel(item.id, (fresh) => ({ ...fresh, deletedAt: now, updatedAt: now })));
    });
    actions.append(confirm);
    return actions;
  }

  const edit = button("travel-action", "Uredi");
  edit.addEventListener("click", () => {
    travelMenuId = null;
    travelEditId = item.id;
    travelEditDraft = item.text;
    void render();
  });
  const remove = button("travel-action action-delete", "Obriši");
  remove.addEventListener("click", () => {
    travelDeleteConfirm = true;
    void render();
  });
  const visit = button("travel-action action-visit", "Posjećeno");
  visit.addEventListener("click", () => {
    travelMenuId = null;
    void mutate(() =>
      updateTravel(item.id, (fresh) => ({ ...fresh, visited: true, updatedAt: new Date().toISOString() })),
    );
  });
  actions.append(edit, remove, visit);
  return actions;
}

function renderTravelCard(item: TravelItem): HTMLLIElement {
  const card = element(
    "li",
    `travel-card${item.visited ? " is-visited" : ""}${travelMenuId === item.id ? " has-actions" : ""}`,
  );
  card.dataset.travelId = item.id;
  const cardBody = element("div", "travel-card-body");
  const marker = element("span", "travel-marker");
  marker.append(item.visited ? icon("check") : icon("pin"));
  const content = element("div", "travel-card-content");
  if (travelEditId === item.id) content.append(travelEditInput(item));
  else {
    content.append(element("span", "travel-label", item.visited ? "posjećeno" : "želimo posjetiti"));
    content.append(element("p", "travel-name", item.text));
  }
  cardBody.append(marker, content);
  card.append(cardBody);
  if (travelMenuId === item.id) card.append(renderTravelActions(item));
  if (travelEditId !== item.id) {
    addLongPress(cardBody, () => {
      travelMenuId = item.id;
      travelDeleteConfirm = false;
      void render();
    });
  }
  return card;
}

function renderTravel(items: TravelItem[]): HTMLElement {
  const panel = element("main", "route-panel travel-panel");
  panel.id = "travel-panel";
  panel.setAttribute("role", "tabpanel");
  panel.setAttribute("aria-label", "Putovanja");
  panel.setAttribute("aria-labelledby", "travel-tab");
  panel.append(renderTopbar("Naša putovanja"));
  const error = renderErrorBanner();
  if (error) panel.append(error);

  const intro = element("section", "travel-intro");
  const addBox = element("div", "travel-add");
  addBox.append(icon("pin"));
  const input = element("input", "travel-add-input");
  input.type = "text";
  input.value = travelAddDraft;
  input.placeholder = "Dodaj mjesto...";
  input.maxLength = 240;
  input.setAttribute("aria-label", "Novo mjesto za putovanje");
  input.addEventListener("input", () => {
    travelAddDraft = input.value;
  });
  input.addEventListener("keydown", (event) => {
    if (event.key !== "Enter") return;
    event.preventDefault();
    const text = input.value.trim();
    if (!text) return;
    travelAddDraft = "";
    input.value = "";
    void mutate(() => addTravel(text));
  });
  addBox.append(input);
  intro.append(addBox);

  const visible = items.filter((item) => item.deletedAt === null);
  const unvisited = visible.filter((item) => !item.visited).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  const visited = visible.filter((item) => item.visited).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  const list = element("ul", "travel-list");
  list.setAttribute("aria-label", "Mjesta za putovanje");
  for (const item of [...unvisited, ...visited]) list.append(renderTravelCard(item));
  if (visible.length === 0) {
    const empty = element("li", "travel-empty");
    empty.append(icon("pin"), element("p", "", "Dodajte prvo mjesto koje želite zajedno posjetiti."));
    list.append(empty);
  }
  panel.append(intro, list);
  return panel;
}

function renderUnpaired(): HTMLElement {
  const screen = element("main", "unpaired-screen");
  const symbol = element("div", "unpaired-symbol", "SiB");
  const copy = element("div", "unpaired-copy");
  copy.append(element("h1", "", "Uređaj nije povezan"));
  screen.append(symbol, copy);
  return screen;
}

async function render(): Promise<void> {
  const sequence = ++renderSequence;
  const restoreShoppingAddInput =
    focusShoppingAddInput || (route === "shopping" && document.activeElement?.matches(".add-input"));
  try {
    if (syncStatus.phase === "unpaired") {
      app.replaceChildren(renderUnpaired());
      return;
    }
    const content =
      route === "shopping" ? renderShopping(await getShoppingItems()) : renderTravel(await getTravelItems());
    if (sequence !== renderSequence) return;
    app.replaceChildren(content, renderNav());
    if (restoreShoppingAddInput && route === "shopping") {
      focusShoppingAddInput = false;
      requestAnimationFrame(() => {
        const input = document.querySelector<HTMLInputElement>(".add-input");
        input?.focus();
        input?.scrollIntoView({ block: "center" });
      });
    }
    if (focusNavRoute) {
      const tabRoute = focusNavRoute;
      focusNavRoute = null;
      queueMicrotask(() => document.querySelector<HTMLElement>(`#${tabRoute}-tab`)?.focus());
    }
  } catch (error) {
    if (sequence !== renderSequence) return;
    storageError = error instanceof Error ? error.message : "Lokalnu bazu nije moguće učitati.";
    const failure = element("main", "fatal-storage-error");
    failure.setAttribute("role", "alert");
    failure.append(
      element("div", "fatal-mark", "!"),
      element("h1", "", "Podaci nisu dostupni"),
      element("p", "", storageError),
    );
    app.replaceChildren(failure, renderNav());
  }
}

if (location.pathname === "/") history.replaceState(null, "", "/shopping");

window.addEventListener("popstate", () => {
  route = currentRoute();
  closeTransientUi();
  void render();
});

document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible") void syncEngine.markActive().catch(reportStorageError);
});
document.addEventListener("pointerdown", (event) => {
  if (!travelMenuId) return;
  const card = (event.target as HTMLElement).closest<HTMLElement>("[data-travel-id]");
  if (card?.dataset.travelId === travelMenuId) return;
  travelMenuId = null;
  travelDeleteConfirm = false;
  void render();
});

subscribeToDb(() => void render());

async function hasSession(): Promise<boolean | null> {
  try {
    const response = await fetch("/api/session", { credentials: "same-origin" });
    if (response.status === 401) return false;
    return response.ok;
  } catch {
    return null;
  }
}

async function boot(): Promise<void> {
  await render();
  registerSW({ immediate: true });
  if ((await hasSession()) === false) {
    syncEngine.markUnpaired();
    return;
  }
  await syncEngine.markActive();
}

void boot().catch(reportStorageError);
