import { describe, expect, it } from "vitest";
import {
  computeSeatProof,
  randomSeatCredential,
  registerHostSeatVerifier,
  saveLocalSeatSecret,
  verifySeatProof,
} from "./seat-credentials";

describe("V2 seat credentials", () => {
  it("authenticates a stable seat without persisting its plaintext secret in room data", async () => {
    const roomId = "room_abcdefghijklmnop";
    const seatId = "investigator-one";
    const secret = randomSeatCredential();
    const nonce = randomSeatCredential(24);
    expect(secret).toMatch(/^[A-Za-z0-9_-]{32,}$/);

    await saveLocalSeatSecret(roomId, seatId, secret);
    await registerHostSeatVerifier(roomId, seatId, secret);
    const proof = await computeSeatProof(roomId, seatId, nonce);

    expect(proof).toMatch(/^[0-9a-f]{64}$/);
    expect(await verifySeatProof(roomId, seatId, nonce, proof)).toBe(true);
    expect(await verifySeatProof(roomId, seatId, `${nonce}x`, proof)).toBe(false);
  });
});
