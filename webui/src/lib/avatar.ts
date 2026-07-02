/**
 * avatar — browser-side image crop/resize for profile avatars.
 *
 * The backend only stores a tiny, validated `data:image/...` string, so the heavy
 * lifting happens here: we read the picked file, center-crop it to a square, draw
 * it onto a 256×256 canvas, and export the smallest backend-acceptable data URL
 * that fits under the size cap — WebP first (tiny at q0.85), then JPEG at
 * descending quality, and a lossless PNG only if it happens to fit. This keeps the
 * stored payload under the backend's `MAX_AVATAR_LEN` even on browsers whose canvas
 * declines WebP (historically Safari), without any new dependency — pure Canvas +
 * the File/Image APIs.
 *
 * `resizeAvatar` NEVER throws synchronously; it rejects with an Error so callers
 * can surface a friendly message. If no encoding fits (a pathological browser that
 * only emits large PNGs), it rejects with a specific message rather than letting
 * the backend reject the oversized payload opaquely.
 */

/** Output size + quality for the exported avatar. */
const AVATAR_SIZE = 256;
const AVATAR_QUALITY = 0.85;
/** Reject files larger than this before we even decode them. */
const MAX_INPUT_BYTES = 8 * 1024 * 1024;

/**
 * Hard cap the backend enforces on the stored data-URL string
 * (`MAX_AVATAR_LEN` in backend/app/models.py). We keep the exported avatar under a
 * slightly tighter SAFE limit so a valid upload never round-trips into a backend
 * "avatar too large" rejection.
 */
const AVATAR_MAX_LEN = 64_000;
const AVATAR_SAFE_LEN = 60_000;

/** Allowed picked-file MIME types (svg is intentionally excluded — backend rejects it). */
const ALLOWED_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif']);

/**
 * Read a picked image File and return a 256×256 center-cropped data URL that is
 * guaranteed to fit under the backend size cap. Rejects on unsupported type,
 * oversize input, a decode/encode failure, or if the image cannot be compressed
 * small enough in this browser.
 */
export async function resizeAvatar(file: File): Promise<string> {
  if (!file) throw new Error('No file selected.');
  if (file.type && !ALLOWED_TYPES.has(file.type)) {
    throw new Error('Use a PNG, JPEG, WebP or GIF image.');
  }
  if (file.size > MAX_INPUT_BYTES) {
    throw new Error('Image is too large (max 8 MB). Pick a smaller file.');
  }

  const dataUrl = await readFileAsDataUrl(file);
  const img = await loadImage(dataUrl);

  // Encode at the target size; if even the smallest lossy encoding at 256px is
  // over the cap (a pathological browser that only produces large PNGs), shrink
  // the canvas and retry before giving up with a specific message.
  for (const size of [AVATAR_SIZE, 192, 128]) {
    const out = encodeAvatarUnderLimit(drawSquare(img, size));
    if (out) return out;
  }
  throw new Error(
    'Your browser could not compress this photo small enough. Pick a smaller or simpler image.',
  );
}

/** Draw the source image center-cropped to a square of `size`px on a fresh canvas. */
function drawSquare(img: HTMLImageElement, size: number): HTMLCanvasElement {
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('Could not process the image in this browser.');
  const w = img.naturalWidth || img.width;
  const h = img.naturalHeight || img.height;
  const side = Math.min(w, h);
  const sx = (w - side) / 2;
  const sy = (h - side) / 2;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(img, sx, sy, side, side, 0, 0, size, size);
  return canvas;
}

/**
 * Encode the canvas to the smallest backend-acceptable (`png|webp|jpeg`) data URL
 * whose full length is at or under `maxLen`. Tries lossy formats first (WebP, then
 * JPEG — both stay tiny for photographic images) at descending quality, and only
 * accepts a lossless PNG if it happens to fit. Returns `null` when nothing fits so
 * the caller can shrink-and-retry or fail with a specific message.
 *
 * Exported for unit testing; `canvas` only needs `toDataURL(type, quality)`.
 */
export function encodeAvatarUnderLimit(
  canvas: Pick<HTMLCanvasElement, 'toDataURL'>,
  maxLen: number = AVATAR_SAFE_LEN,
): string | null {
  const attempts: ReadonlyArray<readonly [string, number | undefined]> = [
    ['image/webp', AVATAR_QUALITY],
    ['image/webp', 0.7],
    ['image/webp', 0.5],
    ['image/jpeg', AVATAR_QUALITY],
    ['image/jpeg', 0.7],
    ['image/jpeg', 0.5],
    ['image/png', undefined],
  ];
  for (const [type, quality] of attempts) {
    const out = canvas.toDataURL(type, quality);
    // The backend accepts only png/webp/jpeg; a browser may decline a requested
    // format and hand back a different one, so trust the ACTUAL emitted prefix.
    if (!/^data:image\/(png|webp|jpeg);base64,/.test(out)) continue;
    if (out.length <= maxLen) return out;
  }
  return null;
}

/** The hard backend cap on a stored avatar data-URL (exported for callers/tests). */
export { AVATAR_MAX_LEN };

function readFileAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error('Could not read the file.'));
    reader.onload = () => {
      const result = reader.result;
      if (typeof result === 'string') resolve(result);
      else reject(new Error('Could not read the file.'));
    };
    reader.readAsDataURL(file);
  });
}

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('That file is not a valid image.'));
    img.src = src;
  });
}

/** Derive up-to-two uppercase initials from a display name / username. */
export function initialsFrom(name?: string | null, fallback?: string | null): string {
  const src = (name || fallback || '').trim();
  if (!src) return '?';
  const parts = src.split(/\s+/).filter(Boolean);
  // Index by code POINT, not UTF-16 code unit, so an emoji / astral-plane glyph
  // (e.g. a stylized 𝕏) is never split into a lone surrogate that renders broken.
  if (parts.length >= 2) {
    const first = firstCodePoint(parts[0]);
    const last = firstCodePoint(parts[parts.length - 1]);
    return (first + last).toUpperCase();
  }
  return Array.from(parts[0] ?? '').slice(0, 2).join('').toUpperCase();
}

/** First whole code point of a string (empty string when `s` is empty). */
function firstCodePoint(s: string): string {
  for (const ch of s) return ch;
  return '';
}
