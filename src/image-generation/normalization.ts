import type {
  ImageGenerationIgnoredOverride,
  ImageGenerationNormalization,
  ImageGenerationProvider,
  ImageGenerationResolution,
  ImageGenerationSourceImage,
} from "./types.js";

export type ResolvedImageGenerationOverrides = {
  size?: string;
  aspectRatio?: string;
  resolution?: ImageGenerationResolution;
  ignoredOverrides: ImageGenerationIgnoredOverride[];
  normalization?: ImageGenerationNormalization;
};

function parseSize(value: string): { width: number; height: number } | null {
  const match = value.trim().match(/^(\d{2,5})x(\d{2,5})$/i);
  if (!match) {
    return null;
  }
  return {
    width: Number.parseInt(match[1] ?? "0", 10),
    height: Number.parseInt(match[2] ?? "0", 10),
  };
}

function aspectRatioFromSize(value: string): string | undefined {
  const parsed = parseSize(value);
  if (!parsed || parsed.width <= 0 || parsed.height <= 0) {
    return undefined;
  }
  // Keep the ratio reduced so providers with ratio-only geometry can still accept it.
  const gcd = (a: number, b: number): number => (b === 0 ? a : gcd(b, a % b));
  const divisor = gcd(parsed.width, parsed.height);
  return `${parsed.width / divisor}:${parsed.height / divisor}`;
}

function pickClosestSize(
  requested: string,
  supported: readonly string[] | undefined,
): string | undefined {
  if (!supported?.length) {
    return requested;
  }
  const requestedParsed = parseSize(requested);
  if (!requestedParsed) {
    return supported[0];
  }
  let best = supported[0];
  let bestDistance = Number.POSITIVE_INFINITY;
  for (const candidate of supported) {
    const parsed = parseSize(candidate);
    if (!parsed) {
      continue;
    }
    const distance =
      Math.abs(parsed.width - requestedParsed.width) +
      Math.abs(parsed.height - requestedParsed.height);
    if (distance < bestDistance) {
      bestDistance = distance;
      best = candidate;
    }
  }
  return best;
}

function pickClosestAspectRatio(
  requested: string | undefined,
  supported: readonly string[] | undefined,
  fallbackSize?: string,
): string | undefined {
  if (!supported?.length) {
    return requested ?? aspectRatioFromSize(fallbackSize ?? "");
  }
  const requestedRatio = requested ?? aspectRatioFromSize(fallbackSize ?? "");
  if (!requestedRatio) {
    return supported[0];
  }
  const [requestedW, requestedH] = requestedRatio
    .split(":")
    .map((value) => Number.parseFloat(value));
  if (!Number.isFinite(requestedW) || !Number.isFinite(requestedH) || requestedH === 0) {
    return supported[0];
  }
  const requestedValue = requestedW / requestedH;
  let best = supported[0];
  let bestDistance = Number.POSITIVE_INFINITY;
  for (const candidate of supported) {
    const [width, height] = candidate.split(":").map((value) => Number.parseFloat(value));
    if (!Number.isFinite(width) || !Number.isFinite(height) || height === 0) {
      continue;
    }
    const distance = Math.abs(width / height - requestedValue);
    if (distance < bestDistance) {
      bestDistance = distance;
      best = candidate;
    }
  }
  return best;
}

function pickClosestResolution(
  requested: ImageGenerationResolution,
  supported: readonly ImageGenerationResolution[] | undefined,
): ImageGenerationResolution | undefined {
  if (!supported?.length) {
    return requested;
  }
  const order: Record<ImageGenerationResolution, number> = { "1K": 1, "2K": 2, "4K": 4 };
  let best = supported[0];
  let bestDistance = Number.POSITIVE_INFINITY;
  for (const candidate of supported) {
    const distance = Math.abs(order[candidate] - order[requested]);
    if (distance < bestDistance) {
      bestDistance = distance;
      best = candidate;
    }
  }
  return best;
}

function hasNormalizationEntry(normalization: ImageGenerationNormalization): boolean {
  return Boolean(normalization.size || normalization.aspectRatio || normalization.resolution);
}

export function resolveImageGenerationOverrides(params: {
  provider: ImageGenerationProvider;
  size?: string;
  aspectRatio?: string;
  resolution?: ImageGenerationResolution;
  inputImages?: ImageGenerationSourceImage[];
}): ResolvedImageGenerationOverrides {
  const hasInputImages = (params.inputImages?.length ?? 0) > 0;
  const modeCaps = hasInputImages
    ? params.provider.capabilities.edit
    : params.provider.capabilities.generate;
  const geometry = params.provider.capabilities.geometry;
  const ignoredOverrides: ImageGenerationIgnoredOverride[] = [];
  const normalization: ImageGenerationNormalization = {};
  let size = params.size;
  let aspectRatio = params.aspectRatio;
  let resolution = params.resolution;

  if (size && modeCaps.supportsSize) {
    const normalizedSize = pickClosestSize(size, geometry?.sizes);
    if (normalizedSize && normalizedSize !== size) {
      normalization.size = { requested: size, applied: normalizedSize };
    }
    size = normalizedSize;
  } else if (size) {
    const translatedAspectRatio = modeCaps.supportsAspectRatio
      ? pickClosestAspectRatio(aspectRatio, geometry?.aspectRatios, size)
      : undefined;
    if (translatedAspectRatio) {
      aspectRatio = translatedAspectRatio;
      normalization.aspectRatio = { applied: translatedAspectRatio, derivedFrom: "size" };
    } else {
      ignoredOverrides.push({ key: "size", value: size });
    }
    size = undefined;
  }

  if (aspectRatio && modeCaps.supportsAspectRatio) {
    const normalizedAspectRatio = pickClosestAspectRatio(aspectRatio, geometry?.aspectRatios);
    if (normalizedAspectRatio && normalizedAspectRatio !== aspectRatio) {
      normalization.aspectRatio = { requested: aspectRatio, applied: normalizedAspectRatio };
    }
    aspectRatio = normalizedAspectRatio;
  } else if (aspectRatio) {
    ignoredOverrides.push({ key: "aspectRatio", value: aspectRatio });
    aspectRatio = undefined;
  }

  if (resolution && modeCaps.supportsResolution) {
    const normalizedResolution = pickClosestResolution(resolution, geometry?.resolutions);
    if (normalizedResolution && normalizedResolution !== resolution) {
      normalization.resolution = { requested: resolution, applied: normalizedResolution };
    }
    resolution = normalizedResolution;
  } else if (resolution) {
    ignoredOverrides.push({ key: "resolution", value: resolution });
    resolution = undefined;
  }

  return {
    size,
    aspectRatio,
    resolution,
    ignoredOverrides,
    normalization: hasNormalizationEntry(normalization) ? normalization : undefined,
  };
}
