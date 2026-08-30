import { webcrypto } from "node:crypto";

// Node 18 does not expose Web Crypto inside every Vitest VM context. The
// desktop runtime always has Web Crypto, so mirror that runtime contract here.
if (globalThis.crypto === undefined || globalThis.crypto.subtle === undefined) {
  Object.defineProperty(globalThis, "crypto", {
    configurable: true,
    value: webcrypto,
  });
}
