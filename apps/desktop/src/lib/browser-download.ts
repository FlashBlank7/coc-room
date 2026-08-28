/**
 * Starts a browser download and keeps the Blob URL alive through the current
 * event loop turn. Revoking it synchronously after click() races navigation in
 * some browser engines and can produce an empty download.
 */
export function downloadTextInBrowser(name: string, content: string, type: string): void {
  const url = URL.createObjectURL(new Blob([content], { type }));
  const revoke = URL.revokeObjectURL.bind(URL);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = name;
  anchor.hidden = true;
  document.body.append(anchor);
  try {
    anchor.click();
  } finally {
    anchor.remove();
    globalThis.setTimeout(() => revoke(url), 0);
  }
}
