import { randomUUID } from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { writeBase64ToFile } from "./nodes-camera.js";
import {
  asBoolean,
  asNumber,
  asRecord,
  asString,
  resolveTempPathParts,
} from "./nodes-media-utils.js";

const MAX_SCREEN_RECORD_CHUNK_BYTES = 1024 * 1024;

type ScreenRecordMetadata = {
  format: string;
  durationMs?: number;
  fps?: number;
  screenIndex?: number;
  appName?: string;
  bundleId?: string;
  windowId?: number;
  hasAudio?: boolean;
};

export type ScreenRecordInlinePayload = ScreenRecordMetadata & {
  base64: string;
};

export type ScreenRecordArtifactPayload = ScreenRecordMetadata & {
  artifactId: string;
  byteLength: number;
  chunkSize: number;
};

export type ScreenRecordPayload = ScreenRecordInlinePayload | ScreenRecordArtifactPayload;

export type ScreenRecordChunkPayload = {
  offset: number;
  byteLength: number;
  base64: string;
  eof: boolean;
};

function parseMetadata(obj: Record<string, unknown>): ScreenRecordMetadata {
  return {
    format: asString(obj.format) ?? "",
    durationMs: typeof obj.durationMs === "number" ? obj.durationMs : undefined,
    fps: typeof obj.fps === "number" ? obj.fps : undefined,
    screenIndex: typeof obj.screenIndex === "number" ? obj.screenIndex : undefined,
    appName: typeof obj.appName === "string" ? obj.appName : undefined,
    bundleId: typeof obj.bundleId === "string" ? obj.bundleId : undefined,
    windowId: typeof obj.windowId === "number" ? obj.windowId : undefined,
    hasAudio: typeof obj.hasAudio === "boolean" ? obj.hasAudio : undefined,
  };
}

export function parseScreenRecordPayload(value: unknown): ScreenRecordPayload {
  const obj = asRecord(value);
  const metadata = parseMetadata(obj);
  const base64 = asString(obj.base64);
  if (metadata.format && base64) {
    // Older nodes return small recordings inline. Keep accepting that shape so
    // a newer CLI can still operate during rolling upgrades.
    return { ...metadata, base64 };
  }

  const artifactId = asString(obj.artifactId);
  const byteLength = asNumber(obj.byteLength);
  const chunkSize = asNumber(obj.chunkSize);
  const opaqueIdIsSafe = artifactId && /^[A-Za-z0-9_-]{16,128}$/.test(artifactId);
  if (
    !metadata.format ||
    !opaqueIdIsSafe ||
    byteLength === undefined ||
    !Number.isSafeInteger(byteLength) ||
    byteLength <= 0 ||
    chunkSize === undefined ||
    !Number.isSafeInteger(chunkSize) ||
    chunkSize <= 0
  ) {
    throw new Error("invalid screen.record payload");
  }
  return { ...metadata, artifactId, byteLength, chunkSize };
}

export function parseScreenRecordChunkPayload(value: unknown): ScreenRecordChunkPayload {
  const obj = asRecord(value);
  const offset = asNumber(obj.offset);
  const byteLength = asNumber(obj.byteLength);
  const base64 = asString(obj.base64);
  const eof = asBoolean(obj.eof);
  if (
    offset === undefined ||
    !Number.isSafeInteger(offset) ||
    offset < 0 ||
    byteLength === undefined ||
    !Number.isSafeInteger(byteLength) ||
    byteLength < 0 ||
    base64 === undefined ||
    eof === undefined
  ) {
    throw new Error("invalid screen.record chunk payload");
  }
  return { offset, byteLength, base64, eof };
}

export function screenRecordTempPath(opts: { ext: string; tmpDir?: string; id?: string }) {
  const { tmpDir, id, ext } = resolveTempPathParts(opts);
  return path.join(tmpDir, `openclaw-screen-record-${id}${ext}`);
}

export async function writeScreenRecordToFile(filePath: string, base64: string) {
  const tempPath = siblingPartialPath(filePath);
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  try {
    // Legacy inline payloads use the same publish rule as chunked artifacts:
    // fully write and fsync a sibling before atomically replacing --out.
    const written = await writeBase64ToFile(tempPath, base64);
    const handle = await fs.open(tempPath, "r+");
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
    await fs.rename(tempPath, filePath);
    return { path: filePath, bytes: written.bytes };
  } catch (err) {
    await fs.unlink(tempPath).catch(() => {});
    throw err;
  }
}

function siblingPartialPath(filePath: string): string {
  return path.join(
    path.dirname(filePath),
    `.${path.basename(filePath)}.partial-${process.pid}-${randomUUID()}`,
  );
}

export async function writeScreenRecordArtifactToFile(params: {
  filePath: string;
  artifact: ScreenRecordArtifactPayload;
  readChunk: (params: { artifactId: string; offset: number; length: number }) => Promise<unknown>;
}): Promise<{ path: string; bytes: number }> {
  const { filePath, artifact, readChunk } = params;
  const tempPath = siblingPartialPath(filePath);
  await fs.mkdir(path.dirname(filePath), { recursive: true });

  // A sibling temporary file keeps the final pathname absent until every
  // remote chunk has been validated. Rename is atomic on the same filesystem,
  // so interruption cannot expose a truncated MP4 as a successful recording.
  const handle = await fs.open(tempPath, "wx");
  let offset = 0;
  let closed = false;
  try {
    while (offset < artifact.byteLength) {
      // Never trust a node-provided recommendation to enlarge a WebSocket
      // frame. The CLI owns the hard ceiling and requests at most 1 MiB decoded.
      const length = Math.min(
        MAX_SCREEN_RECORD_CHUNK_BYTES,
        artifact.chunkSize,
        artifact.byteLength - offset,
      );
      const chunk = parseScreenRecordChunkPayload(
        await readChunk({ artifactId: artifact.artifactId, offset, length }),
      );
      const decoded = Buffer.from(chunk.base64, "base64");
      if (chunk.offset !== offset) {
        throw new Error(
          `screen.record chunk offset mismatch: expected ${offset}, got ${chunk.offset}`,
        );
      }
      if (decoded.length !== chunk.byteLength || decoded.length === 0 || decoded.length > length) {
        throw new Error(
          `screen.record chunk length mismatch at ${offset}: expected at most ${length}, got ${decoded.length}`,
        );
      }
      const nextOffset = offset + decoded.length;
      const expectedEof = nextOffset === artifact.byteLength;
      if (chunk.eof !== expectedEof) {
        throw new Error(
          `screen.record chunk EOF mismatch at ${offset}: expected ${expectedEof}, got ${chunk.eof}`,
        );
      }
      // FileHandle writes may be short. Advance both buffer and file offsets
      // until the entire validated chunk is durable in the partial artifact.
      let chunkWritten = 0;
      while (chunkWritten < decoded.length) {
        const { bytesWritten } = await handle.write(
          decoded,
          chunkWritten,
          decoded.length - chunkWritten,
          offset + chunkWritten,
        );
        if (bytesWritten <= 0) {
          throw new Error(`screen.record local write stalled at ${offset + chunkWritten}`);
        }
        chunkWritten += bytesWritten;
      }
      offset = nextOffset;
    }

    if (offset !== artifact.byteLength) {
      throw new Error(
        `screen.record transfer size mismatch: expected ${artifact.byteLength}, got ${offset}`,
      );
    }
    // Flush before close/rename so success means the complete bytes reached the
    // local filesystem, not merely Node's userspace write buffers.
    await handle.sync();
    await handle.close();
    closed = true;
    await fs.rename(tempPath, filePath);
    return { path: filePath, bytes: offset };
  } catch (err) {
    if (!closed) {
      await handle.close().catch(() => {});
    }
    await fs.unlink(tempPath).catch(() => {});
    throw err;
  }
}

export async function transferScreenRecordArtifactToFile(params: {
  filePath: string;
  artifact: ScreenRecordArtifactPayload;
  invoke: (params: Record<string, unknown>) => Promise<unknown>;
}): Promise<{ path: string; bytes: number }> {
  try {
    return await writeScreenRecordArtifactToFile({
      filePath: params.filePath,
      artifact: params.artifact,
      readChunk: async ({ artifactId, offset, length }) =>
        await params.invoke({ operation: "read", artifactId, offset, length }),
    });
  } finally {
    // Cleanup is best-effort because the atomic local file is authoritative on
    // success, while the node TTL pruner handles disconnects. On failure this
    // finally still runs, but cleanup can never hide the primary transfer error.
    await params
      .invoke({ operation: "cleanup", artifactId: params.artifact.artifactId })
      .catch(() => {});
  }
}
