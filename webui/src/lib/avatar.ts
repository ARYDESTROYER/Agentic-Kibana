/**
 * avatar — browser-side image crop/resize for profile avatars.
 *
 * The backend only stores a tiny, validated `data:image/...` string, so the heavy
 * lifting happens here: we read the picked file, center-crop it to a square, draw
 * it onto a 256×256 canvas, and export a WebP data URL at q0.85. This keeps the
 * stored payload small (well under the backend's `_MAX_AVATAR_LEN`) without any new
 * dependency — pure Canvas + the File/Image APIs.
 *
 * `resizeAvatar` NEVER throws synchronously; it rejects with an Error so callers
 * can surface a friendly message. WebP is exported when supported (every evergreen
 * browser); we fall back to PNG if the canvas declines WebP.
 */

/** Output size + quality for the exported avatar. */
const AVATAR_SIZE = 256;
const AVATAR_QUALITY = 0.85;
/** Reject files larger than this before we even decode them. */
const MAX_INPUT_BYTES = 8 * 1024 * 1024;

/** Allowed picked-file MIME types (svg is intentionally excluded — backend rejects it). */
const ALLOWED_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif']);

/**
 * Read a picked image File and return a 256×256 center-cropped WebP data URL.
 * Rejects on unsupported type, oversize input, or a decode/encode failure.
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

  const canvas = document.createElement('canvas');
  canvas.width = AVATAR_SIZE;
  canvas.height = AVATAR_SIZE;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('Could not process the image in this browser.');

  // Center-crop the source to a square, then scale to the target.
  const side = Math.min(img.naturalWidth || img.width, img.naturalHeight || img.height);
  const sx = ((img.naturalWidth || img.width) - side) / 2;
  const sy = ((img.naturalHeight || img.height) - side) / 2;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(img, sx, sy, side, side, 0, 0, AVATAR_SIZE, AVATAR_SIZE);

  // Prefer WebP; fall back to PNG if the browser declines it.
  let out = canvas.toDataURL('image/webp', AVATAR_QUALITY);
  if (!out.startsWith('data:image/webp')) {
    out = canvas.toDataURL('image/png');
  }
  if (!out.startsWith('data:image/')) throw new Error('Could not encode the image.');
  return out;
}

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
  if (parts.length >= 2) {
    return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
  }
  return src.slice(0, 2).toUpperCase();
}
