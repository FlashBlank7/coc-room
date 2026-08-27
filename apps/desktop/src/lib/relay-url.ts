export function validateRelayOrigin(value: string): string {
  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    throw new Error("中继节点必须是有效的 HTTP(S) 根地址");
  }
  const localHost = url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "[::1]";
  if (url.protocol !== "https:" && !(url.protocol === "http:" && localHost)) {
    throw new Error("公网中继必须使用 HTTPS（仅本机开发允许 HTTP）");
  }
  if (url.username || url.password || url.search || url.hash) {
    throw new Error("中继根地址不得包含凭据、查询参数或片段");
  }
  return url.toString().replace(/\/$/, "");
}
