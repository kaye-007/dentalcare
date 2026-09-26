import { useCallback, useEffect, useRef, useState } from 'react';
import { Camera, RefreshCw, SwitchCamera } from 'lucide-react';
import { Modal } from './ui';

/**
 * Take a picture with the device's camera, in the page.
 *
 * A reception desk has a webcam and a tablet has two cameras; both are reached
 * through getUserMedia. What comes out is a JPEG drawn from the video frame
 * onto a canvas, so it carries no EXIF block at all — no GPS position, no
 * device serial — before anything is uploaded.
 *
 * Where the browser cannot open the camera (an old WebView, a refused
 * permission, a page served over plain http) the modal says why and offers
 * the device's own camera app instead, through a file input with `capture`.
 * On a phone that is the native camera; on a desktop it is a file picker.
 */

export type CaptureFrame = 'square' | 'card' | 'free';

const MAX_SIDE = 2048;

function describe(err: unknown): string {
  const name = (err as { name?: string } | null)?.name;
  if (name === 'NotAllowedError' || name === 'SecurityError') {
    return 'Camera access was refused. Allow the camera for this site in the browser settings, or use the device camera below.';
  }
  if (name === 'NotFoundError' || name === 'OverconstrainedError') {
    return 'No camera was found on this device.';
  }
  if (name === 'NotReadableError') {
    return 'The camera is in use by another application.';
  }
  return 'The camera could not be started.';
}

export default function CameraCaptureModal({
  title = 'Take a photo',
  subtitle,
  frame = 'free',
  facing = 'environment',
  onClose,
  onCapture,
}: {
  title?: string;
  subtitle?: string;
  /** A guide drawn over the preview: a circle for a profile photo, a card outline for an ID. */
  frame?: CaptureFrame;
  /** Which camera to start with: the back one for documents and teeth, the front one for a selfie. */
  facing?: 'user' | 'environment';
  onClose: () => void;
  onCapture: (file: File) => void;
}) {
  const video = useRef<HTMLVideoElement>(null);
  const stream = useRef<MediaStream | null>(null);
  const fallback = useRef<HTMLInputElement>(null);
  const [mode, setMode] = useState<'user' | 'environment'>(facing);
  const [cameras, setCameras] = useState(0);
  const [live, setLive] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [shot, setShot] = useState<{ blob: Blob; url: string } | null>(null);

  const supported =
    typeof navigator !== 'undefined' && Boolean(navigator.mediaDevices?.getUserMedia);

  const stop = useCallback(() => {
    stream.current?.getTracks().forEach((t) => t.stop());
    stream.current = null;
    setLive(false);
  }, []);

  const start = useCallback(
    async (which: 'user' | 'environment') => {
      stop();
      setError(null);
      if (!supported) {
        setError(
          window.isSecureContext
            ? 'This browser cannot open the camera from a web page.'
            : 'The camera is only available on a secure (https) connection.',
        );
        return;
      }
      try {
        const s = await navigator.mediaDevices.getUserMedia({
          audio: false,
          video: {
            facingMode: { ideal: which },
            width: { ideal: 1920 },
            height: { ideal: 1080 },
          },
        });
        stream.current = s;
        if (video.current) {
          video.current.srcObject = s;
          await video.current.play().catch(() => undefined);
        }
        setLive(true);
        const devices = await navigator.mediaDevices.enumerateDevices().catch(() => []);
        setCameras(devices.filter((d) => d.kind === 'videoinput').length);
      } catch (err) {
        setError(describe(err));
      }
    },
    [stop, supported],
  );

  useEffect(() => {
    void start(mode);
    return stop;
    // The camera restarts only when the facing mode changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode]);

  useEffect(
    () => () => {
      if (shot) URL.revokeObjectURL(shot.url);
    },
    [shot],
  );

  function capture() {
    const v = video.current;
    if (!v || !v.videoWidth) return;
    const scale = Math.min(1, MAX_SIDE / Math.max(v.videoWidth, v.videoHeight));
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(v.videoWidth * scale);
    canvas.height = Math.round(v.videoHeight * scale);
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    // The preview of a front camera is mirrored for the person in front of
    // it; the saved picture is not, so text on an ID reads the right way.
    ctx.drawImage(v, 0, 0, canvas.width, canvas.height);
    canvas.toBlob(
      (blob) => {
        if (!blob) {
          setError('The picture could not be encoded.');
          return;
        }
        stop();
        setShot({ blob, url: URL.createObjectURL(blob) });
      },
      'image/jpeg',
      0.9,
    );
  }

  function accept() {
    if (!shot) return;
    const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
    onCapture(new File([shot.blob], `camera-${stamp}.jpg`, { type: 'image/jpeg' }));
  }

  function retake() {
    setShot(null);
    void start(mode);
  }

  return (
    <Modal
      wide
      title={title}
      subtitle={subtitle}
      onClose={() => {
        stop();
        onClose();
      }}
    >
      <div className="modal__body">
        <div className={`camera camera--${frame}`}>
          {shot ? (
            <img src={shot.url} alt="The captured picture" />
          ) : (
            <video
              ref={video}
              playsInline
              muted
              className={
                mode === 'user' ? 'camera__video camera__video--mirror' : 'camera__video'
              }
              aria-label="Camera preview"
            />
          )}
          {!shot && live && frame !== 'free' && (
            <span className="camera__guide" aria-hidden />
          )}
          {!live && !shot && !error && (
            <p className="camera__status">Starting the camera…</p>
          )}
        </div>

        {error && (
          <p className="formerror" role="alert">
            {error}
          </p>
        )}

        <input
          ref={fallback}
          type="file"
          accept="image/jpeg,image/png,image/webp"
          capture={mode}
          hidden
          onChange={(e) => {
            const f = e.target.files?.[0];
            e.target.value = '';
            if (f) {
              stop();
              onCapture(f);
            }
          }}
        />

        <div className="modal__foot">
          <div className="inline-row">
            {!shot && cameras > 1 && (
              <button
                type="button"
                className="btn btn--ghost btn--sm"
                onClick={() => setMode((m) => (m === 'user' ? 'environment' : 'user'))}
              >
                <SwitchCamera size={14} aria-hidden /> Switch camera
              </button>
            )}
            {!shot && (
              <button
                type="button"
                className="btn btn--ghost btn--sm"
                onClick={() => fallback.current?.click()}
              >
                Use device camera app
              </button>
            )}
          </div>
          <div className="modal__foot-right">
            {shot ? (
              <>
                <button type="button" className="btn btn--ghost" onClick={retake}>
                  <RefreshCw size={14} aria-hidden /> Retake
                </button>
                <button type="button" className="btn btn--primary" onClick={accept}>
                  Use this photo
                </button>
              </>
            ) : (
              <button
                type="button"
                className="btn btn--primary"
                onClick={capture}
                disabled={!live}
              >
                <Camera size={15} aria-hidden /> Capture
              </button>
            )}
          </div>
        </div>
      </div>
    </Modal>
  );
}
