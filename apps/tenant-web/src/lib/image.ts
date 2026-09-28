/**
 * Image preparation in the browser, before anything is uploaded.
 *
 * Re-encoding through a canvas does three jobs at once: it resizes to what the
 * picture is for, it produces the one format the server expects for that
 * purpose, and it drops the camera's metadata — including the GPS position a
 * phone writes into every photo, which has no business in a clinic's bucket.
 */

export function loadImage(file: Blob): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      URL.revokeObjectURL(url);
      resolve(img);
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error('That file could not be read as an image.'));
    };
    img.src = url;
  });
}

function toJpeg(canvas: HTMLCanvasElement, quality: number): Promise<Blob> {
  return new Promise((resolve, reject) =>
    canvas.toBlob(
      (b) => (b ? resolve(b) : reject(new Error('Could not encode the image.'))),
      'image/jpeg',
      quality,
    ),
  );
}

/**
 * A logo for invoices: at most 600×240, on white — a transparent PNG would
 * otherwise print with a black background, because JPEG has no alpha.
 */
export async function prepareLogo(file: File): Promise<Blob> {
  const img = await loadImage(file);
  const scale = Math.min(600 / img.naturalWidth, 240 / img.naturalHeight, 1);
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(img.naturalWidth * scale));
  canvas.height = Math.max(1, Math.round(img.naturalHeight * scale));
  const ctx = canvas.getContext('2d')!;
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
  return toJpeg(canvas, 0.9);
}

export interface SquareCrop {
  /** Centre of the crop, as a fraction of the image's width and height. */
  cx: number;
  cy: number;
  /** Side of the crop as a fraction of the image's shorter side (0.2–1). */
  size: number;
}

/** The pixel rectangle a crop selects, clamped inside the image. */
export function cropRect(width: number, height: number, crop: SquareCrop) {
  const side = Math.min(width, height) * Math.min(1, Math.max(0.2, crop.size));
  const x = Math.min(Math.max(crop.cx * width - side / 2, 0), width - side);
  const y = Math.min(Math.max(crop.cy * height - side / 2, 0), height - side);
  return { x, y, side };
}

/** A square profile picture, 512 px. */
export async function cropSquare(
  img: HTMLImageElement,
  crop: SquareCrop,
  output = 512,
): Promise<Blob> {
  const { x, y, side } = cropRect(img.naturalWidth, img.naturalHeight, crop);
  const canvas = document.createElement('canvas');
  canvas.width = output;
  canvas.height = output;
  const ctx = canvas.getContext('2d')!;
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, output, output);
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(img, x, y, side, side, 0, 0, output, output);
  return toJpeg(canvas, 0.88);
}
