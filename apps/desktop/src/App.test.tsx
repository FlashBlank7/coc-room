// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { useAppStore } from "./store/app-store";
import { App } from "./App";

afterEach(() => {
  cleanup();
  useAppStore.setState({ activeView: "lobby", currentRoom: undefined });
});

describe("App navigation", () => {
  it("shows a labeled module library entry and opens it", async () => {
    render(<App />);

    const moduleButton = screen.getByRole("button", { name: "模组库" });
    expect(moduleButton).toBeTruthy();
    fireEvent.click(moduleButton);

    expect(await screen.findByRole("heading", { name: "模组资料库" })).toBeTruthy();
  });
});
