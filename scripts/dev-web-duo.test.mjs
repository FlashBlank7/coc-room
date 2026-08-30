import assert from "node:assert/strict";
import test from "node:test";
import {
  assertSupportedNodeVersion,
  createDuoProcessSpecs,
  duoHelpText,
  parseDuoArguments,
} from "./dev-web-duo.mjs";

test("fails early with a useful message on an unsupported Node runtime", () => {
  assert.doesNotThrow(() => assertSupportedNodeVersion("22.0.0"));
  assert.throws(() => assertSupportedNodeVersion("18.20.8"), /需要 Node\.js 22\+/);
  assert.throws(() => assertSupportedNodeVersion("unknown"), /未知版本/);
});

test("uses the documented KP, player, and relay defaults", () => {
  assert.deepEqual(parseDuoArguments([]), {
    help: false,
    smoke: false,
    open: true,
    kpPort: 1420,
    playerPort: 1421,
    relayPort: 8787,
  });
});

test("parses cross-platform options without shell environment syntax", () => {
  assert.deepEqual(parseDuoArguments([
    "--",
    "--no-open",
    "--kp-port=1520",
    "--player-port",
    "1521",
    "--relay-port",
    "9787",
  ]), {
    help: false,
    smoke: false,
    open: false,
    kpPort: 1520,
    playerPort: 1521,
    relayPort: 9787,
  });
});

test("rejects ambiguous and unsafe port combinations", () => {
  assert.throws(() => parseDuoArguments(["--kp-port", "1421"]), /三个不同端口/);
  assert.throws(() => parseDuoArguments(["--relay-port", "0"]), /between 1 and 65535/);
  assert.throws(() => parseDuoArguments(["--smoke", "--kp-port", "1500"]), /isolated ports/);
  assert.throws(() => parseDuoArguments(["--wat"]), /unknown option/);
});

test("builds four direct Node services and no Tauri or AI command", () => {
  const options = parseDuoArguments(["--no-open"]);
  const specs = createDuoProcessSpecs("/workspace", options, "/node");
  assert.equal(specs.services.length, 4);
  assert.deepEqual(specs.services.map((service) => service.label), ["protocol", "relay", "KP", "player"]);
  assert.equal(specs.services[2].env.COC_ROOM_WEB_PORT, "1420");
  assert.equal(specs.services[3].env.COC_ROOM_WEB_PORT, "1421");
  assert.equal(specs.services[2].env.COC_ROOM_LOCAL_AI_BRIDGE, "enabled");
  assert.equal(specs.services[3].env.COC_ROOM_LOCAL_AI_BRIDGE, "disabled");
  assert.equal(specs.services[2].env.VITE_RELAY_URL, "http://127.0.0.1:8787");
  const commandText = JSON.stringify(specs).toLowerCase();
  assert.doesNotMatch(commandText, /tauri|codex|deepseek|parse-module/);
});

test("documents process cleanup and isolated browser storage", () => {
  const help = duoHelpText();
  assert.match(help, /Ctrl\+C/);
  assert.match(help, /独立 IndexedDB/);
  assert.match(help, /只有 KP 页启用/);
  assert.match(help, /玩家的角色草稿请求经房间交给 KP/);
  assert.match(help, /启动器本身不会调用模型/);
});
