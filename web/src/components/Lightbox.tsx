import { LiquiGlass } from '@liqui-design/glass';
import { useQuery } from '@tanstack/react-query';
import {
  ArrowLeft, Calendar, Camera, ChevronLeft, ChevronRight, CloudCheck, CloudUpload, Download, FileImage, FolderPlus, Info,
  MapPin, RotateCcw, Star, Trash2, TriangleAlert, X,
} from 'lucide-react';
import { AnimatePresence, type DragControls, motion, useDragControls, useIsPresent, usePresence, useReducedMotion } from 'motion/react';
import { type ReactNode, type RefObject, useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Link } from 'wouter';
import { api, type PhotoDetail, type PhotoItem, autoBackup } from '@/api';
import { Tip } from '@/components/IconAction';
import { Toolbar, ToolbarButton, ToolbarGroup } from '@/components/ui/toolbar';
import { preloadPreview, useMedia } from '@/hooks/useMedia';
import { usePhotoActions } from '@/hooks/usePhotoActions';
import { formatBytes, formatExposure, formatMegapixels, fullDate, timeOfDay } from '@/lib/format';
import { type Box, CLOSE, CLOSE_MS, FLIGHT, fitBox, type Pose, poseFromTile, QUICK, REST, type Size, SPRING } from '@/lib/motion';

/** Shown in the browser at full size only below this. Larger ones wait for the person to ask. */
const AUTO_ORIGINAL_BYTES = 50 * 1024 * 1024;
/** Downloading the next photo ahead of time is only worth it when that costs little. */
const PRELOAD_MAX_BYTES = 8 * 1024 * 1024;
const WEB_SAFE = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/gif', 'image/avif']);
const MAX_ZOOM = 8;
const INFO_WIDTH = 360;
const DEFAULT_ASPECT = 1.5;
/** How far a photo travels as it changes places with its neighbour. */
const NAV_OFFSET = 90;
const SWIPE_DISTANCE = 80;
const SWIPE_SPEED = 500;

interface LightboxProps {
  photoId: number;
  items: PhotoItem[];
  mode: 'normal' | 'trash';
  /** True while a dialog is open on top, which then owns the keyboard. */
  keysPaused: boolean;
  onNavigate: (id: number) => void;
  onClose: () => void;
  onAddToAlbum: (ids: number[]) => void;
  onDeleteForever: (ids: number[], after: () => void) => void;
}

const VIEW_DEFAULT = { scale: 1, x: 0, y: 0 };

export function Lightbox({ photoId, items, mode, keysPaused, onNavigate, onClose, onAddToAlbum, onDeleteForever }: LightboxProps) {
  const actions = usePhotoActions();
  const [isPresent, safeToRemove] = usePresence();
  const reducedMotion = useReducedMotion() ?? false;
  const detail = useQuery({ queryKey: ['photo', photoId], queryFn: () => api.photo(photoId) });
  const photo = detail.data;

  const [isWide, setIsWide] = useState(() => matchMedia('(min-width: 900px)').matches);
  const [infoOpen, setInfoOpen] = useState(() => window.innerWidth >= 1180);
  const [stageSize, setStageSize] = useState<Size | null>(null);
  const [view, setView] = useState(VIEW_DEFAULT);
  const [closingTo, setClosingTo] = useState<Pose | null>(null);
  const [originalState, setOriginalState] = useState<'none' | 'loading' | 'ready' | 'failed'>('none');
  const stage = useRef<HTMLDivElement>(null);
  const pan = useRef<{ x: number; y: number } | null>(null);
  const dragControls = useDragControls();

  const index = items.findIndex((item) => item.id === photoId);
  const item = index >= 0 ? items[index] : undefined;
  const previous = index > 0 ? items[index - 1] : undefined;
  const next = index >= 0 ? items[index + 1] : undefined;

  // Known from the grid straight away, so nothing has to wait for the photo's details to load.
  const shapeWidth = item?.width ?? photo?.width;
  const shapeHeight = item?.height ?? photo?.height;
  const aspect = shapeWidth && shapeHeight ? shapeWidth / shapeHeight : DEFAULT_ASPECT;
  const box = stageSize ? fitBox(aspect, stageSize) : null;
  const previewState = item ? (item.noPreview ? 'unavailable' : item.previewComing ? 'missing' : 'ready') : photo?.previewState;

  const lastIndex = useRef(index);
  const direction = index >= lastIndex.current ? 1 : -1;
  useEffect(() => {
    lastIndex.current = index;
  }, [index]);

  // Only the first photo flies out of the grid. After that, photos change places sideways.
  const firstHero = useRef(true);
  useEffect(() => {
    if (stageSize) firstHero.current = false;
  }, [stageSize]);

  useLayoutEffect(() => {
    const el = stage.current;
    if (!el) return;
    const measure = () => setStageSize({ width: el.clientWidth, height: el.clientHeight });
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    const media = matchMedia('(min-width: 900px)');
    const onChange = () => setIsWide(media.matches);
    media.addEventListener('change', onChange);
    return () => media.removeEventListener('change', onChange);
  }, []);

  useEffect(() => {
    setView(VIEW_DEFAULT);
    setOriginalState('none');
  }, [photoId]);

  // The page stays exactly where it was underneath, so closing lands back on the same photo.
  useEffect(() => {
    const root = document.documentElement;
    const before = root.style.overflow;
    root.style.overflow = 'hidden';
    return () => {
      root.style.overflow = before;
    };
  }, []);

  // Closing: fly back to the tile, or simply fade if there is no tile on screen to fly to.
  const removeWhenDone = useRef(safeToRemove);
  removeWhenDone.current = safeToRemove;
  useLayoutEffect(() => {
    if (isPresent) {
      setClosingTo(null);
      return;
    }
    setView(VIEW_DEFAULT);
    const home = !reducedMotion && box && stage.current ? poseFromTile(photoId, box, stage.current) : null;
    setClosingTo(home ?? { ...REST, opacity: 0, scale: 0.96 });
    const timer = setTimeout(() => removeWhenDone.current?.(), CLOSE_MS + 40);
    return () => clearTimeout(timer);
    // Runs once per change of presence. It should use the box and photo of that moment.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isPresent]);

  useEffect(() => {
    for (const neighbor of [previous, next]) {
      if (!neighbor || neighbor.noPreview || neighbor.previewComing) continue;
      void api.photo(neighbor.id).then((info) => {
        if (info.size <= PRELOAD_MAX_BYTES) preloadPreview(neighbor.id);
      }, () => undefined);
    }
  }, [previous, next]);

  const webSafe = photo ? WEB_SAFE.has(photo.mime) : false;
  const isGif = photo?.mime === 'image/gif';

  const loadOriginal = useCallback(() => {
    setOriginalState((state) => (state === 'none' || state === 'failed' ? 'loading' : state));
  }, []);

  // A preview of a GIF would be frozen, so it goes straight to the real thing.
  useEffect(() => {
    if (isGif) loadOriginal();
  }, [isGif, loadOriginal]);

  useEffect(() => {
    if (photo && webSafe && view.scale > 1.2 && photo.size <= AUTO_ORIGINAL_BYTES) loadOriginal();
  }, [photo, webSafe, view.scale, loadOriginal]);

  // Stays asked for once asked for, so it keeps showing after it has finished loading.
  const wantOriginal = originalState === 'loading' || originalState === 'ready';
  const original = useMedia(photoId, 'original', { enabled: wantOriginal });
  useEffect(() => {
    if (originalState !== 'loading' || original.state === 'loading') return;
    setOriginalState(original.url ? 'ready' : 'failed');
  }, [originalState, original.state, original.url]);

  // Null when this device has no preview and making one would mean a very large download.
  const preview = useMedia(photoId, 'preview', { enabled: previewState === 'ready' && originalState !== 'ready' });

  const afterRemoval = useCallback(() => {
    if (next) onNavigate(next.id);
    else if (previous) onNavigate(previous.id);
    else onClose();
  }, [next, previous, onNavigate, onClose]);

  const removeToTrash = () => void actions.trash([photoId]).then(afterRemoval);
  const restore = () => void actions.restore([photoId]).then(afterRemoval);
  const toggleFavorite = () => photo && void actions.setFavorite([photoId], !photo.favorite);
  const toggleInfo = () => {
    setView(VIEW_DEFAULT);
    setInfoOpen((open) => !open);
  };

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (!isPresent || keysPaused || event.metaKey || event.ctrlKey || event.altKey) return;
      if (event.key === 'Escape') onClose();
      else if (event.key === 'ArrowLeft' && previous) onNavigate(previous.id);
      else if (event.key === 'ArrowRight' && next) onNavigate(next.id);
      else if (event.key === 'i') toggleInfo();
      else if (event.key === 'f' && mode === 'normal') toggleFavorite();
      else if ((event.key === 'Delete' || event.key === '#') && mode === 'normal') removeToTrash();
    };
    // Capture phase: otherwise a tooltip left open by returning focus takes the Esc for itself.
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  });

  useEffect(() => {
    const el = stage.current;
    if (!el) return;
    const onWheel = (event: WheelEvent) => {
      event.preventDefault();
      const rect = el.getBoundingClientRect();
      const px = event.clientX - rect.left - rect.width / 2;
      const py = event.clientY - rect.top - rect.height / 2;
      setView((current) => {
        const scale = Math.min(MAX_ZOOM, Math.max(1, current.scale * Math.exp(-event.deltaY * 0.0022)));
        if (scale === 1) return VIEW_DEFAULT;
        const ratio = scale / current.scale;
        return { scale, x: px - (px - current.x) * ratio, y: py - (py - current.y) * ratio };
      });
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, []);

  const closing = !isPresent;
  const zoomed = view.scale > 1;
  const canSwipe = !zoomed && !closing;
  const src = originalState === 'ready' ? original.url : preview.url;
  const fetchingPreview = preview.state === 'loading' && previewState === 'ready' && originalState === 'none';
  const previewTooLarge = preview.state === 'empty' && previewState === 'ready' && originalState === 'none';
  const chrome = { initial: { opacity: 0 }, animate: { opacity: closing ? 0 : 1 }, transition: QUICK };
  const stageKey = stageSize ? `${stageSize.width}/${stageSize.height}` : '';

  const onSwipe = (distance: number, speed: number) => {
    if ((distance < -SWIPE_DISTANCE || speed < -SWIPE_SPEED) && next) onNavigate(next.id);
    else if ((distance > SWIPE_DISTANCE || speed > SWIPE_SPEED) && previous) onNavigate(previous.id);
  };

  // A portal, so nothing on the page can ever become this element's frame of reference or stacking context.
  return createPortal(
    <motion.div
      layoutRoot
      role="dialog"
      aria-modal="true"
      aria-label={photo?.filename ?? 'Photo'}
      data-lightbox
      className="fixed inset-0 z-50 overflow-hidden text-white"
      style={{ pointerEvents: closing ? 'none' : undefined }}
    >
      <motion.div className="absolute inset-0 bg-black" initial={{ opacity: 0 }} animate={{ opacity: closing ? 0 : 1 }} transition={closing ? CLOSE : { duration: 0.22 }} />

      <div
        ref={stage}
        className={`absolute inset-y-0 left-0 touch-none select-none ${zoomed ? 'cursor-grab active:cursor-grabbing' : ''}`}
        style={{ right: infoOpen && isWide ? INFO_WIDTH : 0 }}
        onDoubleClick={(event) => {
          const rect = event.currentTarget.getBoundingClientRect();
          const px = event.clientX - rect.left - rect.width / 2;
          const py = event.clientY - rect.top - rect.height / 2;
          setView((current) => (current.scale > 1 ? VIEW_DEFAULT : { scale: 2.5, x: -px * 1.5, y: -py * 1.5 }));
        }}
        onPointerDown={(event) => {
          if ((event.target as HTMLElement).closest('button, a, [role="toolbar"]')) return;
          if (zoomed) {
            event.currentTarget.setPointerCapture(event.pointerId);
            pan.current = { x: event.clientX, y: event.clientY };
          } else if (canSwipe) {
            // From the stage, not the photo, so a swipe works anywhere on a phone's tall screen.
            dragControls.start(event);
          }
        }}
        onPointerMove={(event) => {
          if (!pan.current) return;
          const dx = event.clientX - pan.current.x;
          const dy = event.clientY - pan.current.y;
          pan.current = { x: event.clientX, y: event.clientY };
          setView((current) => ({ ...current, x: current.x + dx, y: current.y + dy }));
        }}
        onPointerUp={() => {
          pan.current = null;
        }}
      >
        <motion.div className="absolute inset-0" initial={false} animate={view} transition={pan.current ? { duration: 0 } : SPRING}>
          {box && previewState === 'ready' ? (
            <AnimatePresence custom={direction}>
              <Hero
                key={photoId}
                photoId={photoId}
                box={box}
                stage={stage}
                flyFromTile={firstHero.current}
                reducedMotion={reducedMotion}
                direction={direction}
                closingTo={closingTo}
                src={src}
                alt={photo?.filename ?? item?.filename ?? ''}
                dragControls={dragControls}
                canSwipe={canSwipe}
                onSwipe={onSwipe}
              />
            </AnimatePresence>
          ) : null}
        </motion.div>

        {previewState !== 'ready' && photo ? (
          <motion.div key={photoId} {...chrome} className="absolute inset-0">
            <NoPreview photo={photo} onDownload={() => actions.download([photoId])} />
          </motion.div>
        ) : null}

        <motion.div {...chrome} className="pointer-events-none absolute inset-0 z-10">
          <div className="pointer-events-auto absolute top-3 left-3">
            <Tip label="Back to photos">
              <motion.button type="button" aria-label="Back to photos" onClick={onClose} whileHover={{ scale: 1.06 }} whileTap={{ scale: 0.92 }} className="block cursor-pointer rounded-full">
                <RoundGlass size={46}>
                  <ArrowLeft className="size-5 text-white" aria-hidden="true" />
                </RoundGlass>
              </motion.button>
            </Tip>
          </div>
          <motion.div layout="position" layoutDependency={stageKey} className="dark pointer-events-auto absolute top-3 right-3">
            <Toolbar aria-label="Photo actions" className="lq-round" glass={{ radius: 24, frost: 0.45, blur: 1 }}>
              <ToolbarGroup className="flex items-center">
                {mode === 'trash' ? (
                  <>
                    <LightboxAction label="Restore" onClick={restore} icon={<RotateCcw className="size-[18px]" aria-hidden="true" />} />
                    <LightboxAction label="Delete forever" onClick={() => onDeleteForever([photoId], afterRemoval)} icon={<Trash2 className="size-[18px] text-[#ff8a8f]" aria-hidden="true" />} />
                  </>
                ) : (
                  <>
                    <LightboxAction
                      label={photo?.favorite ? 'Remove from favorites (F)' : 'Add to favorites (F)'}
                      onClick={toggleFavorite}
                      icon={
                        <motion.span key={String(photo?.favorite ?? false)} className="block" initial={{ scale: 0.6 }} animate={{ scale: 1 }}>
                          <Star className={`size-[18px] ${photo?.favorite ? 'fill-current text-amber-300' : ''}`} aria-hidden="true" />
                        </motion.span>
                      }
                    />
                    <LightboxAction label="Add to album" onClick={() => onAddToAlbum([photoId])} icon={<FolderPlus className="size-[18px]" aria-hidden="true" />} />
                    <LightboxAction label="Download original" onClick={() => actions.download([photoId])} icon={<Download className="size-[18px]" aria-hidden="true" />} />
                    <LightboxAction label="Move to Trash (Delete)" onClick={removeToTrash} icon={<Trash2 className="size-[18px]" aria-hidden="true" />} />
                  </>
                )}
                <LightboxAction label="Info (I)" onClick={toggleInfo} icon={<Info className={`size-[18px] ${infoOpen ? 'text-[#8fb3ff]' : ''}`} aria-hidden="true" />} />
              </ToolbarGroup>
            </Toolbar>
          </motion.div>

          {previous ? <NavArrow side="left" label="Previous photo" layoutKey={stageKey} onClick={() => onNavigate(previous.id)} /> : null}
          {next ? <NavArrow side="right" label="Next photo" layoutKey={stageKey} onClick={() => onNavigate(next.id)} /> : null}

          {originalState === 'loading' ? <Chip>Loading the original from Telegram…</Chip> : null}
          {fetchingPreview ? <SlowChip>Loading from Telegram…</SlowChip> : null}
          {preview.state === 'failed' && originalState === 'none' ? <Chip>Couldn't reach Telegram. Showing what this device has.</Chip> : null}
          {originalState === 'failed' ? <Chip>Couldn't load the original. Showing the preview.</Chip> : null}
          {originalState === 'none' && photo && webSafe && (previewTooLarge || (view.scale > 1.2 && photo.size > AUTO_ORIGINAL_BYTES)) ? (
            <Chip>
              <button type="button" className="pointer-events-auto cursor-pointer font-semibold underline" onClick={loadOriginal}>
                Load the {formatBytes(photo.size)} original
              </button>
            </Chip>
          ) : null}
        </motion.div>
      </div>

      <AnimatePresence>{infoOpen && !closing ? <InfoPanel key="info" photo={photo} sideways={isWide} onClose={toggleInfo} /> : null}</AnimatePresence>
    </motion.div>,
    document.body,
  );
}

interface HeroProps {
  photoId: number;
  box: Box;
  stage: RefObject<HTMLDivElement | null>;
  flyFromTile: boolean;
  reducedMotion: boolean;
  direction: number;
  closingTo: Pose | null;
  src: string | null;
  alt: string;
  dragControls: DragControls;
  canSwipe: boolean;
  onSwipe: (distance: number, speed: number) => void;
}

/** The photo itself. The thumbnail is usually already here, so it shows at once while the preview loads. */
function Hero({ photoId, box, stage, flyFromTile, reducedMotion, direction, closingTo, src, alt, dragControls, canSwipe, onSwipe }: HeroProps) {
  const isPresent = useIsPresent();
  const thumb = useMedia(photoId, 'thumb');
  const [loaded, setLoaded] = useState(false);
  const [thumbDone, setThumbDone] = useState(false);
  const [start] = useState<Pose>(() => {
    if (!flyFromTile) return { ...REST, opacity: 0, x: direction * NAV_OFFSET };
    const fromTile = !reducedMotion && stage.current ? poseFromTile(photoId, box, stage.current) : null;
    return fromTile ?? { ...REST, opacity: 0, scale: 0.97 };
  });

  return (
    <motion.div
      data-hero
      className="absolute"
      style={{ left: box.left, top: box.top, width: box.width, height: box.height }}
      custom={direction}
      variants={{ leave: (leaving: number) => ({ x: -leaving * NAV_OFFSET, opacity: 0, transition: QUICK }) }}
      initial={start}
      animate={closingTo ?? REST}
      exit="leave"
      transition={{ ...(closingTo ? CLOSE : flyFromTile ? FLIGHT : SPRING), layout: SPRING }}
      // Moves smoothly to its new place when the info panel changes the room available.
      layout
      layoutDependency={`${box.left}/${box.top}/${box.width}/${box.height}`}
      drag={canSwipe && isPresent ? 'x' : false}
      dragListener={false}
      dragControls={dragControls}
      dragSnapToOrigin
      dragMomentum={false}
      dragElastic={0.5}
      onDragEnd={(_, info) => onSwipe(info.offset.x, info.velocity.x)}
    >
      {thumb.url ? <img src={thumb.url} alt="" draggable={false} className={`absolute inset-0 size-full object-cover ${thumbDone ? 'invisible' : ''}`} /> : null}
      {src ? (
        <motion.img
          src={src}
          alt={alt}
          draggable={false}
          className="absolute inset-0 size-full object-contain"
          initial={{ opacity: 0 }}
          animate={{ opacity: loaded ? 1 : 0 }}
          transition={QUICK}
          onLoad={() => setLoaded(true)}
          onAnimationComplete={() => loaded && setThumbDone(true)}
        />
      ) : null}
    </motion.div>
  );
}

function LightboxAction({ label, icon, onClick }: { label: string; icon: ReactNode; onClick: () => void }) {
  return (
    <Tip label={label}>
      <ToolbarButton aria-label={label} onClick={onClick}>
        {icon}
      </ToolbarButton>
    </Tip>
  );
}

function RoundGlass({ size, children }: { size: number; children: ReactNode }) {
  return (
    <LiquiGlass radius={size / 2} blur={1} frost={0.35} refraction={size} bezel={Math.round(size * 0.26)} className="dark lq-round" style={{ width: size, height: size }} contentClassName="grid size-full place-items-center">
      {children}
    </LiquiGlass>
  );
}

function NavArrow({ side, label, layoutKey, onClick }: { side: 'left' | 'right'; label: string; layoutKey: string; onClick: () => void }) {
  const Icon = side === 'left' ? ChevronLeft : ChevronRight;
  return (
    <motion.div layout="position" layoutDependency={layoutKey} className={`pointer-events-auto absolute top-1/2 z-10 hidden -mt-[26px] min-[720px]:block ${side === 'left' ? 'left-3' : 'right-3'}`}>
      <Tip label={label}>
        <motion.button type="button" aria-label={label} onClick={onClick} whileHover={{ scale: 1.06 }} whileTap={{ scale: 0.92 }} className="block cursor-pointer rounded-full">
          <RoundGlass size={52}>
            <Icon className="size-6 text-white" aria-hidden="true" />
          </RoundGlass>
        </motion.button>
      </Tip>
    </motion.div>
  );
}

function Chip({ children }: { children: ReactNode }) {
  return (
    <motion.div role="status" initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={QUICK} className="absolute bottom-5 left-1/2 z-10 -translate-x-1/2 rounded-full bg-black/65 px-4 py-2 text-[13px] whitespace-nowrap text-white backdrop-blur-md">
      {children}
    </motion.div>
  );
}

/** Waits a moment first, so a photo that comes straight from this device's cache shows no flash of text. */
function SlowChip({ children }: { children: ReactNode }) {
  const [show, setShow] = useState(false);
  useEffect(() => {
    const timer = setTimeout(() => setShow(true), 350);
    return () => clearTimeout(timer);
  }, []);
  return show ? <Chip>{children}</Chip> : null;
}

function NoPreview({ photo, onDownload }: { photo: PhotoDetail; onDownload: () => void }) {
  return (
    <div className="absolute inset-0 grid place-items-center p-6 text-center">
      <div className="flex max-w-sm flex-col items-center gap-3">
        <FileImage className="size-14 text-white/60" aria-hidden="true" />
        <p className="text-base font-semibold">{photo.filename}</p>
        <p className="text-[13.5px] text-white/65">
          {photo.previewState === 'missing'
            ? 'A preview is being made from the copy in Telegram.'
            : "This browser can't show this format, but the original is stored safely and unchanged."}
        </p>
        <button type="button" onClick={onDownload} className="mt-1 cursor-pointer rounded-full bg-white px-4 py-2 text-[13.5px] font-semibold text-black">
          Download original ({formatBytes(photo.size)})
        </button>
      </div>
    </div>
  );
}

function Fact({ icon, title, lines }: { icon: ReactNode; title: ReactNode; lines: ReactNode[] }) {
  return (
    <div className="flex gap-3.5">
      <span className="mt-0.5 flex-none text-white/60">{icon}</span>
      <div className="min-w-0">
        <div className="text-[13.5px] font-medium">{title}</div>
        {lines.filter(Boolean).map((line, i) => (
          <div key={i} className="mt-0.5 text-[12.5px] text-white/60">
            {line}
          </div>
        ))}
      </div>
    </div>
  );
}

function storageFact(photo: PhotoDetail) {
  if (photo.status === 'stored') {
    return <Fact icon={<CloudCheck className="size-5" aria-hidden="true" />} title="In your Telegram" lines={['Original quality, unchanged', photo.telegramMessageId ? `Message #${photo.telegramMessageId} in Tele-Photo Library` : null]} />;
  }
  if (photo.status === 'failed') {
    return <Fact icon={<TriangleAlert className="size-5 text-[#ff8a8f]" aria-hidden="true" />} title="Not in Telegram yet" lines={[photo.error, 'Your original is still on your device. Retry from the uploads panel, or add the file again.']} />;
  }
  return <Fact icon={<CloudUpload className="size-5" aria-hidden="true" />} title="Being saved to Telegram" lines={[autoBackup.available ? 'This finishes by itself, even with the app closed.' : 'Keep this tab open until Telegram confirms it.']} />;
}

function InfoPanel({ photo, sideways, onClose }: { photo: PhotoDetail | undefined; sideways: boolean; onClose: () => void }) {
  const camera = photo?.camera;
  const cameraName = [camera?.make, camera?.model]
    .filter(Boolean)
    .join(' ')
    // Many cameras repeat the maker's name in the model: "Canon Canon EOS R5".
    .replace(/^(\S+)\s+\1\b/i, '$1');
  const exposure = [
    camera?.fNumber ? `ƒ/${camera.fNumber}` : null,
    camera?.exposureTime ? formatExposure(camera.exposureTime) : null,
    camera?.focalLength ? `${Math.round(camera.focalLength)} mm` : null,
    camera?.iso ? `ISO ${camera.iso}` : null,
  ].filter(Boolean).join(' · ');

  const hidden = sideways ? { x: '100%' } : { y: '100%' };
  const daysLeft = photo?.purgeAt ? Math.max(0, Math.ceil((photo.purgeAt - Date.now()) / 86_400_000)) : null;

  return (
    <motion.aside
      aria-label="Photo details"
      initial={hidden}
      animate={{ x: 0, y: 0 }}
      exit={{ ...hidden, transition: { duration: 0.2, ease: [0.3, 0.7, 0.2, 1] } }}
      className="dark absolute inset-x-0 bottom-0 z-20 flex max-h-[62dvh] w-full flex-col overflow-y-auto rounded-t-3xl border-l border-white/10 bg-[#15161b] min-[900px]:inset-x-auto min-[900px]:inset-y-0 min-[900px]:right-0 min-[900px]:max-h-none min-[900px]:w-[360px] min-[900px]:rounded-none"
    >
      <div className="flex items-center justify-between px-5 pt-4 pb-2">
        <h2 className="text-[15px] font-semibold">Info</h2>
        <button type="button" aria-label="Close info" onClick={onClose} className="grid size-8 cursor-pointer place-items-center rounded-full hover:bg-white/10">
          <X className="size-4" aria-hidden="true" />
        </button>
      </div>
      {photo ? (
        <div className="flex flex-col gap-5 px-5 pt-2 pb-6">
          {daysLeft !== null ? (
            <p className="rounded-xl bg-amber-400/15 px-3 py-2 text-[12.5px] font-medium text-amber-200">
              In Trash. Deleted forever in {daysLeft} {daysLeft === 1 ? 'day' : 'days'}.
            </p>
          ) : null}
          <Fact
            icon={<Calendar className="size-5" aria-hidden="true" />}
            title={fullDate(photo.takenAt)}
            lines={[timeOfDay(photo.takenAt), photo.takenSource === 'exif' || photo.takenSource === 'telegram' ? null : photo.takenSource === 'file' ? 'Date from the file, as it had no capture date' : 'Date of upload, as it had no capture date']}
          />
          <Fact
            icon={<FileImage className="size-5" aria-hidden="true" />}
            title={photo.filename}
            lines={[
              [photo.width && photo.height ? formatMegapixels(photo.width, photo.height) : null, photo.width && photo.height ? `${photo.width} × ${photo.height}` : null, formatBytes(photo.size)].filter(Boolean).join(' · '),
              photo.mime,
            ]}
          />
          {cameraName || exposure ? <Fact icon={<Camera className="size-5" aria-hidden="true" />} title={cameraName || 'Camera'} lines={[camera?.lens, exposure]} /> : null}
          {photo.location ? (
            <Fact
              icon={<MapPin className="size-5" aria-hidden="true" />}
              title={
                <a className="underline" href={`https://www.openstreetmap.org/?mlat=${photo.location.lat}&mlon=${photo.location.lon}#map=14/${photo.location.lat}/${photo.location.lon}`} target="_blank" rel="noreferrer">
                  View on map
                </a>
              }
              lines={[`${photo.location.lat.toFixed(5)}, ${photo.location.lon.toFixed(5)}`]}
            />
          ) : null}
          {storageFact(photo)}
          {photo.albums.length > 0 ? (
            <div>
              <h3 className="mb-1.5 text-[12px] font-semibold text-white/60">Albums</h3>
              <div className="flex flex-wrap gap-1.5">
                {photo.albums.map((album) => (
                  <Link key={album.id} href={`/albums/${album.id}`} className="rounded-full bg-white/10 px-3 py-1 text-[12.5px] hover:bg-white/15">
                    {album.title}
                  </Link>
                ))}
              </div>
              {photo.albumOnly ? <p className="mt-2 text-[12px] text-white/60">Uploaded here only, so it does not appear in Photos.</p> : null}
            </div>
          ) : null}
        </div>
      ) : null}
    </motion.aside>
  );
}
