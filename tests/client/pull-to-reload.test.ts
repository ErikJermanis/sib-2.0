// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest";
import { enablePullToReload } from "../../src/client/pull-to-reload";

function touch(id: number, x: number, y: number): Touch {
  return { identifier: id, clientX: x, clientY: y } as Touch;
}

function dispatchTouch(target: Element, type: string, touches: Touch[], changedTouches = touches): void {
  const event = new Event(type, { bubbles: true });
  Object.defineProperties(event, {
    touches: { value: touches },
    changedTouches: { value: changedTouches },
  });
  target.dispatchEvent(event);
}

describe("pull to reload", () => {
  let disable: (() => void) | undefined;

  afterEach(() => {
    disable?.();
    document.body.replaceChildren();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("reloads once after a sufficiently long downward pull from the top", () => {
    const reload = vi.fn();
    disable = enablePullToReload(reload);
    const surface = document.createElement("div");
    document.body.append(surface);

    dispatchTouch(surface, "touchstart", [touch(1, 30, 100)]);
    dispatchTouch(surface, "touchmove", [touch(1, 30, 140)]);
    expect(document.querySelector(".pull-to-reload-cue")?.textContent).toBe("Povucite za osvježavanje");
    dispatchTouch(surface, "touchmove", [touch(1, 30, 190)]);
    expect(document.querySelector(".pull-to-reload-cue")?.textContent).toBe("Otpustite za osvježavanje");
    dispatchTouch(surface, "touchend", [], [touch(1, 30, 190)]);
    expect(reload).toHaveBeenCalledOnce();
    expect(document.querySelector(".pull-to-reload-cue")?.hasAttribute("hidden")).toBe(true);

    dispatchTouch(surface, "touchstart", [touch(2, 30, 100)]);
    dispatchTouch(surface, "touchmove", [touch(2, 30, 200)]);
    dispatchTouch(surface, "touchend", [], [touch(2, 30, 200)]);
    expect(reload).toHaveBeenCalledOnce();
  });

  it("ignores short pulls, controls, non-top scrolling, horizontal swipes and multitouch", () => {
    const reload = vi.fn();
    disable = enablePullToReload(reload);
    const surface = document.createElement("div");
    const input = document.createElement("input");
    document.body.append(surface, input);

    dispatchTouch(surface, "touchstart", [touch(1, 30, 100)]);
    dispatchTouch(surface, "touchmove", [touch(1, 30, 150)]);
    dispatchTouch(surface, "touchend", [], [touch(1, 30, 150)]);

    dispatchTouch(input, "touchstart", [touch(2, 30, 100)]);
    dispatchTouch(input, "touchmove", [touch(2, 30, 200)]);
    dispatchTouch(input, "touchend", [], [touch(2, 30, 200)]);

    vi.stubGlobal("scrollY", 50);
    dispatchTouch(surface, "touchstart", [touch(3, 30, 100)]);
    dispatchTouch(surface, "touchmove", [touch(3, 30, 200)]);
    dispatchTouch(surface, "touchend", [], [touch(3, 30, 200)]);
    vi.unstubAllGlobals();

    dispatchTouch(surface, "touchstart", [touch(4, 30, 100)]);
    dispatchTouch(surface, "touchmove", [touch(4, 110, 120)]);
    dispatchTouch(surface, "touchmove", [touch(4, 110, 220)]);
    dispatchTouch(surface, "touchend", [], [touch(4, 110, 220)]);

    dispatchTouch(surface, "touchstart", [touch(5, 30, 100)]);
    dispatchTouch(surface, "touchstart", [touch(5, 30, 120), touch(6, 40, 120)], [touch(6, 40, 120)]);
    dispatchTouch(surface, "touchmove", [touch(5, 30, 220)]);
    dispatchTouch(surface, "touchend", [], [touch(5, 30, 220)]);
    expect(reload).not.toHaveBeenCalled();
  });
});
