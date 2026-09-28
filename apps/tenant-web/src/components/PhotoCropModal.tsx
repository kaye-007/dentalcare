import { humanError } from '../lib/api';
import { useEffect, useRef, useState, type PointerEvent } from 'react';
import { Modal } from './ui';
import { cropRect, cropSquare, loadImage, type SquareCrop } from '../lib/image';

/**
 * Crop a square profile picture: drag to move, slide to zoom. The preview is
 * the circle the picture will be shown in; the saved image is the square
 * around it, so nothing is lost if the avatar shape ever changes.
 */
export default function PhotoCropModal({
  file,
  onClose,
  onSave,
}: {
  file: File;
  onClose: () => void;
  onSave: (image: Blob) => Promise<void>;
}) {
  const [img, setImg] = useState<HTMLImageElement | null>(null);
  const [src, setSrc] = useState<string | null>(null);
  const [crop, setCrop] = useState<SquareCrop>({ cx: 0.5, cy: 0.5, size: 1 });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const drag = useRef<{ x: number; y: number; start: SquareCrop } | null>(null);
  const VIEW = 280;

  useEffect(() => {
    const url = URL.createObjectURL(file);
    setSrc(url);
    loadImage(file)
      .then(setImg)
      .catch((e) => setError(humanError(e)));
    return () => URL.revokeObjectURL(url);
  }, [file]);

  // The whole image scaled so the crop square fills the view.
  const rect = img ? cropRect(img.naturalWidth, img.naturalHeight, crop) : null;
  const scale = rect ? VIEW / rect.side : 1;

  function onPointerDown(e: PointerEvent<HTMLDivElement>) {
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
    drag.current = { x: e.clientX, y: e.clientY, start: crop };
  }
  function onPointerMove(e: PointerEvent<HTMLDivElement>) {
    if (!drag.current || !img) return;
    const dx = (e.clientX - drag.current.x) / scale;
    const dy = (e.clientY - drag.current.y) / scale;
    const next = {
      ...drag.current.start,
      cx: drag.current.start.cx - dx / img.naturalWidth,
      cy: drag.current.start.cy - dy / img.naturalHeight,
    };
    // Keep the centre where the clamped rectangle actually is, so the next
    // drag does not start from a point outside the image.
    const r = cropRect(img.naturalWidth, img.naturalHeight, next);
    setCrop({
      ...next,
      cx: (r.x + r.side / 2) / img.naturalWidth,
      cy: (r.y + r.side / 2) / img.naturalHeight,
    });
  }

  async function save() {
    if (!img) return;
    setBusy(true);
    setError(null);
    try {
      await onSave(await cropSquare(img, crop));
    } catch (e) {
      setError(humanError(e));
      setBusy(false);
    }
  }

  return (
    <Modal
      title="Profile photo"
      subtitle="Drag to position, slide to zoom."
      onClose={onClose}
    >
      <div className="modal__body">
        <div
          className="cropper"
          style={{ width: VIEW, height: VIEW }}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={() => (drag.current = null)}
          role="img"
          aria-label="Crop area"
        >
          {src && img && rect && (
            <img
              src={src}
              alt=""
              draggable={false}
              style={{
                width: img.naturalWidth * scale,
                height: img.naturalHeight * scale,
                transform: `translate(${-rect.x * scale}px, ${-rect.y * scale}px)`,
              }}
            />
          )}
          <span className="cropper__mask" aria-hidden />
        </div>
        <label className="field">
          <span>Zoom</span>
          <input
            type="range"
            min={0.2}
            max={1}
            step={0.01}
            value={1.2 - crop.size}
            onChange={(e) =>
              setCrop((c) => ({ ...c, size: 1.2 - Number(e.target.value) }))
            }
          />
        </label>
        {error && <p className="formerror">{error}</p>}
        <div className="modal__foot">
          <div className="modal__foot-right">
            <button
              type="button"
              className="btn btn--ghost"
              onClick={onClose}
              disabled={busy}
            >
              Cancel
            </button>
            <button
              type="button"
              className="btn btn--primary"
              onClick={save}
              disabled={busy || !img}
            >
              {busy ? 'Saving…' : 'Save photo'}
            </button>
          </div>
        </div>
      </div>
    </Modal>
  );
}
