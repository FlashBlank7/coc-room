/**
 * Starts a browser download and keeps the Blob URL alive through the current
 * event loop turn. Revoking it synchronously after click() races navigation in
 * some browser engines and can produce an empty download.
 */
export function downloadTextInBrowser(name: string, content: string, type: string): void {
  downloadBlobInBrowser(name, new Blob([content], { type }));
}

export function downloadBytesInBrowser(name: string, content: Uint8Array, type: string): void {
  // Copy into an ArrayBuffer owned by this Blob. Some DOM type definitions do
  // not accept a Uint8Array backed by SharedArrayBuffer even though browsers do.
  const bytes = new Uint8Array(content);
  downloadBlobInBrowser(name, new Blob([bytes.buffer], { type }));
}

function downloadBlobInBrowser(name: string, blob: Blob): void {
  const url = URL.createObjectURL(blob);
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
