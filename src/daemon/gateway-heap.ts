/** Adaptive Node heap policy for the managed Gateway service. */
import os from "node:os";

const MEBIBYTE_BYTES = 1024 * 1024;
const GATEWAY_HEAP_FLOOR_MIB = 2048;
const GATEWAY_HEAP_CAP_MIB = 8192;

type GatewayHeapMemoryInputs = {
  constrainedMemoryBytes?: number;
  physicalMemoryBytes?: number;
};

function readAvailableMemory(params: GatewayHeapMemoryInputs): number {
  const constrainedMemoryBytes = params.constrainedMemoryBytes ?? process.constrainedMemory();
  const physicalMemoryBytes = params.physicalMemoryBytes ?? os.totalmem();
  if (
    Number.isFinite(constrainedMemoryBytes) &&
    constrainedMemoryBytes > 0 &&
    constrainedMemoryBytes <= physicalMemoryBytes
  ) {
    return constrainedMemoryBytes;
  }
  return physicalMemoryBytes;
}

function resolveGatewayHeapLimitMiB(params: GatewayHeapMemoryInputs = {}): number {
  const availableMemoryMiB = Math.floor(readAvailableMemory(params) / MEBIBYTE_BYTES);
  const halfMemoryMiB = Math.floor(availableMemoryMiB / 2);
  // Old space is only part of Gateway RSS. Bound the nominal floor so smaller
  // hosts retain room for young-generation, native, and buffer allocations.
  const headroomCapMiB = Math.floor(availableMemoryMiB * 0.75);
  return Math.min(
    GATEWAY_HEAP_CAP_MIB,
    Math.max(GATEWAY_HEAP_FLOOR_MIB, halfMemoryMiB),
    headroomCapMiB,
  );
}

export function resolveGatewayHeapNodeOptions(memory: GatewayHeapMemoryInputs = {}): string {
  return `--max-old-space-size=${resolveGatewayHeapLimitMiB(memory)}`;
}
