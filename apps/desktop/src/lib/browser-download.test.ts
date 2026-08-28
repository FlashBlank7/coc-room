// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest";
import { downloadTextInBrowser } from "./browser-download";

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("downloadTextInBrowser", () => {
  it("clicks a temporary anchor and revokes its Blob URL on the next turn", () => {
    vi.useFakeTimers();
    const previousCreate = Object.getOwnPropertyDescriptor(URL, "createObjectURL");
    const previousRevoke = Object.getOwnPropertyDescriptor(URL, "revokeObjectURL");
    const createObjectURL = vi.fn(() => "blob:download-test");
    const revokeObjectURL = vi.fn();
    Object.defineProperty(URL, "createObjectURL", { configurable: true, value: createObjectURL });
    Object.defineProperty(URL, "revokeObjectURL", { configurable: true, value: revokeObjectURL });
    const click = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => undefined);

    try {
      downloadTextInBrowser("记录.md", "蝴蝶", "text/markdown;charset=utf-8");

      expect(createObjectURL).toHaveBeenCalledOnce();
      expect(click).toHaveBeenCalledOnce();
      expect(revokeObjectURL).not.toHaveBeenCalled();
      expect(document.querySelector('a[download="记录.md"]')).toBeNull();

      vi.runAllTimers();
      expect(revokeObjectURL).toHaveBeenCalledWith("blob:download-test");
    } finally {
      if (previousCreate) Object.defineProperty(URL, "createObjectURL", previousCreate);
      else Reflect.deleteProperty(URL, "createObjectURL");
      if (previousRevoke) Object.defineProperty(URL, "revokeObjectURL", previousRevoke);
      else Reflect.deleteProperty(URL, "revokeObjectURL");
    }
  });
});
