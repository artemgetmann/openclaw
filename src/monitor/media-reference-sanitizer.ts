export const MEDIA_REFERENCE_PLACEHOLDER = "[media reference omitted]";
const IMAGE_EXTENSIONS = "(?:png|jpe?g|gif|webp|bmp|tiff?|heic|heif|avif|svg|ico)";
const DATA_IMAGE_REGEX = /data:image\/[a-z0-9.+-]+(?:;[^,\s]*)?,[^\s"'`<>]*/giu;
const WHOLE_DATA_IMAGE_REGEX = /^\s*data:image\//iu;
const QUOTED_DATA_IMAGE_REGEX = /(["'`])data:image\/[a-z0-9.+-]+(?:;[^,\r\n]*)?,[\s\S]*?\1/giu;
const TEXTUAL_SVG_DATA_IMAGE_REGEX = /data:image\/svg\+xml(?:;[^,\r\n]*)?,[\s\S]*?<\/svg\s*>/giu;
const WRAPPED_DATA_IMAGE_REGEX = /data:image\/[a-z0-9.+-]+(?:;[^,\r\n]*)?,[^\r\n]*[\r\n]/iu;
// Match the prompt runner's file-URL grammar exactly: spaces are valid until the image extension,
// while closing markers and ordinary prose after the extension remain untouched.
const FILE_URL_IMAGE_REGEX = new RegExp("file://[^<>\"'`\\]]+?\\." + IMAGE_EXTENSIONS, "giu");
const QUOTED_IMAGE_PATH_REGEX = new RegExp(
  "([\"'`])((?:\\.\\.?/|[~/])[^\"'`\\r\\n]*?\\." + IMAGE_EXTENSIONS + ")\\1",
  "giu",
);
const IMAGE_REFERENCE_REGEX = new RegExp(
  `(?:(?:file|https?):\\/\\/|[a-z]:[\\\\/]|\\\\\\\\|~|\\.\\.?\\/|\\/)[^\\s"'<>\\]\\[(){}]*?\\.${IMAGE_EXTENSIONS}(?:[?#][^\\s"'<>\\]\\[(){}]*)?`,
  "giu",
);
const WHOLE_IMAGE_REFERENCE_REGEX = new RegExp(
  `^\\s*(?:(?:file|https?):\\/\\/|[a-z]:[\\\\/]|\\\\\\\\|~\\/|\\.\\.?\\/|\\/)[\\s\\S]*\\.${IMAGE_EXTENSIONS}(?:[?#][^\\s]*)?\\s*$`,
  "iu",
);
const STRUCTURED_IMAGE_REFERENCE_REGEX = new RegExp(
  `\\[(?:Image:\\s*source:|media attached(?:\\s+\\d+\\/\\d+)?:)\\s*[^\\]\\r\\n]*?\\.${IMAGE_EXTENSIONS}[^\\]\\r\\n]*\\]`,
  "giu",
);

/**
 * Remove prompt text that the embedded image scanner could reinterpret as an image attachment.
 *
 * This intentionally preserves the semantic prose around inline references. Whole-value and
 * multiline data-image matches fail closed because their payload boundary cannot be trusted.
 */
export function sanitizePromptMediaReferences(value: string): string {
  // Whole-value matching catches paths containing spaces. Inline matching keeps useful prose around
  // ordinary path/URL tokens while removing anything a prompt-image scanner could rehydrate.
  if (WHOLE_IMAGE_REFERENCE_REGEX.test(value) || WHOLE_DATA_IMAGE_REGEX.test(value)) {
    return MEDIA_REFERENCE_PLACEHOLDER;
  }
  const boundedMediaSafe = value
    // Structured markers must be removed before token matching because their paths may contain
    // spaces that the scanner deliberately accepts inside the surrounding marker.
    .replace(STRUCTURED_IMAGE_REFERENCE_REGEX, MEDIA_REFERENCE_PLACEHOLDER)
    // Quotes and the closing SVG tag are reliable inline boundaries. Consume through them before
    // deciding whether any remaining multiline data URI makes the whole string unsafe.
    .replace(TEXTUAL_SVG_DATA_IMAGE_REGEX, MEDIA_REFERENCE_PLACEHOLDER)
    .replace(QUOTED_DATA_IMAGE_REGEX, MEDIA_REFERENCE_PLACEHOLDER);
  if (WRAPPED_DATA_IMAGE_REGEX.test(boundedMediaSafe)) {
    return MEDIA_REFERENCE_PLACEHOLDER;
  }
  return (
    boundedMediaSafe
      .replace(DATA_IMAGE_REGEX, MEDIA_REFERENCE_PLACEHOLDER)
      .replace(FILE_URL_IMAGE_REGEX, MEDIA_REFERENCE_PLACEHOLDER)
      // Quoted paths need a separate pass so spaces are accepted only inside an explicit boundary;
      // otherwise ordinary prose next to an unquoted path could be consumed accidentally.
      .replace(QUOTED_IMAGE_PATH_REGEX, MEDIA_REFERENCE_PLACEHOLDER)
      .replace(IMAGE_REFERENCE_REGEX, MEDIA_REFERENCE_PLACEHOLDER)
  );
}
