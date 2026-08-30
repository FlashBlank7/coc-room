import { unzipSync } from "fflate";

import type { ParserSourceAttachment } from "./module-parser";

const MAX_ARCHIVE_BYTES = 25 * 1024 * 1024;
const MAX_ARCHIVE_ENTRIES = 128;
const MAX_EXPANDED_BYTES = 50 * 1024 * 1024;
const MAX_ENTRY_BYTES = 25 * 1024 * 1024;
const MAX_COMPRESSION_RATIO = 500;
const IMAGE_EXTENSION = /\.(?:gif|jpe?g|png|webp)$/iu;

export interface ExtractedSourceArchiveImage {
  readonly source: ParserSourceAttachment;
  readonly bytes: Uint8Array;
}

/**
 * Recovers image bytes from the exact ZIP that the Python input boundary has
 * already validated. Archive names never leave this function and are never
 * used as filesystem paths: images are matched only by the parser-provided
 * SHA-256, length, and MIME metadata.
 */
export async function extractValidatedSourceArchiveImages(
  archiveBytes: Uint8Array,
  expectedCandidates: readonly ParserSourceAttachment[],
): Promise<ExtractedSourceArchiveImage[]> {
  if (archiveBytes.byteLength < 1 || archiveBytes.byteLength > MAX_ARCHIVE_BYTES) {
    throw new Error("源 ZIP 为空或超过 25 MiB 上限");
  }
  const expected = uniqueExpectedImages(expectedCandidates);
  if (expected.length === 0) return [];

  let entryCount = 0;
  let expandedBytes = 0;
  const names = new Set<string>();
  let files: Record<string, Uint8Array>;
  try {
    files = unzipSync(copyBytes(archiveBytes), {
      filter: (entry) => {
        entryCount += 1;
        if (entryCount > MAX_ARCHIVE_ENTRIES) throw new Error("源 ZIP 条目过多");
        assertSafeArchiveName(entry.name);
        const folded = entry.name.toLocaleLowerCase("en-US");
        if (names.has(folded)) throw new Error("源 ZIP 含有重复路径");
        names.add(folded);
        if (entry.originalSize < 0 || entry.originalSize > MAX_ENTRY_BYTES) {
          throw new Error("源 ZIP 条目超过安全大小");
        }
        expandedBytes += entry.originalSize;
        if (expandedBytes > MAX_EXPANDED_BYTES) throw new Error("源 ZIP 解压后超过 50 MiB 上限");
        if (entry.originalSize > 0 && entry.size === 0) throw new Error("源 ZIP 压缩信息无效");
        if (entry.size > 0 && entry.originalSize / entry.size > MAX_COMPRESSION_RATIO) {
          throw new Error("源 ZIP 压缩比异常");
        }
        return !isMetadataFile(entry.name) && !entry.name.endsWith("/") && IMAGE_EXTENSION.test(entry.name);
      },
    });
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("源 ZIP")) throw error;
    throw new Error("无法安全读取源 ZIP 中的图片", { cause: error });
  }

  const expectedByHash = new Map(expected.map((item) => [item.sha256.toLowerCase(), item]));
  const recovered = new Map<string, ExtractedSourceArchiveImage>();
  for (const bytesCandidate of Object.values(files)) {
    const bytes = copyBytes(bytesCandidate);
    const hash = await sha256Hex(bytes);
    const source = expectedByHash.get(hash);
    if (!source) throw new Error("源 ZIP 图片与刚才的解析结果不一致，请重新选择原文件");
    if (bytes.byteLength !== source.byteLength || !matchesMediaType(bytes, source.mediaType)) {
      throw new Error("源 ZIP 图片的长度或格式与解析结果不一致");
    }
    recovered.set(hash, { source, bytes });
  }

  const missing = expected.filter((item) => !recovered.has(item.sha256.toLowerCase()));
  if (missing.length > 0 || recovered.size !== expected.length) {
    throw new Error("源 ZIP 没有包含解析时确认过的全部图片，请重新选择原文件");
  }
  return expected.map((item) => recovered.get(item.sha256.toLowerCase())!);
}

function uniqueExpectedImages(candidates: readonly ParserSourceAttachment[]): ParserSourceAttachment[] {
  const unique = new Map<string, ParserSourceAttachment>();
  for (const candidate of candidates) {
    if (
      candidate.kind !== "image"
      || !/^[a-f0-9]{64}$/iu.test(candidate.sha256)
      || !Number.isInteger(candidate.byteLength)
      || candidate.byteLength < 1
      || candidate.byteLength > MAX_ENTRY_BYTES
      || !Number.isInteger(candidate.width)
      || candidate.width < 1
      || !Number.isInteger(candidate.height)
      || candidate.height < 1
      || !/^image\/(?:gif|jpeg|png|webp)$/u.test(candidate.mediaType)
    ) throw new Error("解析器返回的源图片元数据无效");
    const hash = candidate.sha256.toLowerCase();
    const current = unique.get(hash);
    if (current && (
      current.byteLength !== candidate.byteLength
      || current.mediaType !== candidate.mediaType
      || current.width !== candidate.width
      || current.height !== candidate.height
    )) throw new Error("解析器返回了冲突的源图片元数据");
    unique.set(hash, { ...candidate, sha256: hash });
  }
  return [...unique.values()];
}

function assertSafeArchiveName(name: string): void {
  if (
    name.length < 1
    || name.length > 512
    || name.includes("\\")
    || name.includes("\0")
    || name.startsWith("/")
    || /^[A-Za-z]:/u.test(name)
    || name.split("/").some((part) => part === "." || part === "..")
  ) throw new Error("源 ZIP 含有不安全路径");
}

function isMetadataFile(name: string): boolean {
  const parts = name.split("/");
  const leaf = parts.at(-1) ?? "";
  return parts.includes("__MACOSX") || leaf === ".DS_Store" || leaf.startsWith("._");
}

function matchesMediaType(bytes: Uint8Array, mediaType: string): boolean {
  switch (mediaType) {
    case "image/png":
      return bytes.byteLength >= 8 && bytes[0] === 0x89 && asciiAt(bytes, 1, "PNG\r\n\x1a\n");
    case "image/jpeg":
      return bytes.byteLength >= 4 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes.at(-2) === 0xff && bytes.at(-1) === 0xd9;
    case "image/gif":
      return asciiAt(bytes, 0, "GIF87a") || asciiAt(bytes, 0, "GIF89a");
    case "image/webp":
      return bytes.byteLength >= 12 && asciiAt(bytes, 0, "RIFF") && asciiAt(bytes, 8, "WEBP");
    default:
      return false;
  }
}

function asciiAt(bytes: Uint8Array, offset: number, text: string): boolean {
  if (offset + text.length > bytes.byteLength) return false;
  for (let index = 0; index < text.length; index += 1) {
    if (bytes[offset + index] !== text.charCodeAt(index)) return false;
  }
  return true;
}

function copyBytes(bytes: Uint8Array): Uint8Array {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return copy;
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const copy = copyBytes(bytes);
  const digest = await globalThis.crypto.subtle.digest("SHA-256", copy.buffer as ArrayBuffer);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}
