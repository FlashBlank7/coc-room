declare namespace Cloudflare {
  interface Env {
    ROOMS: DurableObjectNamespace<import("./room").RelayRoom>;
  }

  interface GlobalProps {
    mainModule: typeof import("./index");
    durableNamespaces: "RelayRoom";
  }
}
