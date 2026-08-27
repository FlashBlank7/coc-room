import { describe, expect, it } from "vitest";
import { validateRelayOrigin } from "./relay-url";

describe("relay origin validation", () => {
  it("normalizes HTTPS and local development origins", () => {
    expect(validateRelayOrigin(" https://relay.example.test/ ")).toBe("https://relay.example.test");
    expect(validateRelayOrigin("http://127.0.0.1:8787/")).toBe("http://127.0.0.1:8787");
  });

  it("rejects insecure public origins and URL credentials", () => {
    expect(() => validateRelayOrigin("http://relay.example.test")).toThrow(/HTTPS/);
    expect(() => validateRelayOrigin("https://name:secret@relay.example.test")).toThrow(/凭据/);
  });
});
