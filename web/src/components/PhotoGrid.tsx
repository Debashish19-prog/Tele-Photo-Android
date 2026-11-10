import { Check, CheckCircle2, Circle, CloudUpload, FileImage, FileVideo, Play, Star, TriangleAlert } from 'lucide-react';
import { AnimatePresence, motion } from 'motion/react';
import { memo, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { PhotoItem } from '@/api';
import { Scrubber } from '@/components/Scrubber';
import type { Selection } from '@/hooks/useSelection';
import { useMedia } from '@/hooks/useMedia';
import { extensionOf } from '@/lib/format';
import { buildLayout, firstRowAt, type Layout, type Tile } from '@/lib/layout';
import { QUICK } from '@/lib/motion';

const GAP = 4;
const HEADER_HEIGHT = 44;
const SECTION_GAP = 12;
/** Rows kept alive above and below the screen, as a multiple of its height, so fast scrolling stays filled. */
const OVERSCAN = 1.5;
const LONG_PRESS_MS = 450;

function targetRowHeight(width: number): number {
  if (width < 520) return 118;
  if (width < 900) return 170;
  return 224;
}

interface TileViewProps {
  tile: Tile;
  height: number;
  selected: boolean;
  selecting: boolean;
  /** True while this photo is open in the viewer, so the grid does not show a second copy of it. */
  hidden: boolean;
  onOpen: (id: number) => void;
  onToggle: (id: number, range: boolean) => void;
}

/** Only rows near the screen exist, so mounting one of these is what asks for its thumbnail. */
function TileImage({ id, alt, selected }: { id: number; alt: string; selected: boolean }) {
  const { url } = useMedia(id, 'thumb');
  if (!url) return null;
  return (
    <motion.img
      src={url}
      alt={alt}
      decoding="async"
      draggable={false}
      initial={false}
      animate={{ scale: selected ? 0.86 : 1, borderRadius: selected ? 10 : 0 }}
    />
  );
}

const TileView = memo(function TileView({ tile, height, selected, selecting, hidden, onOpen, onToggle }: TileViewProps) {
  const { item, x, width } = tile;
  const press = useRef<{ timer: number; x: number; y: number; fired: boolean } | null>(null);

  const cancelPress = () => {
    if (press.current) window.clearTimeout(press.current.timer);
  };

  return (
    <motion.div className="tile" data-selected={selected} data-photo-id={item.id} whileTap={{ scale: 0.985 }} style={{ left: x, width, height, visibility: hidden ? 'hidden' : undefined }}>
      {item.noPreview || item.previewComing ? (
        <div className={`grid size-full place-items-center p-2 text-center text-[var(--lq-text-dim)] ${item.previewComing ? 'shimmer' : ''}`}>
          <div className="flex flex-col items-center gap-1">
            {item.isVideo ? <FileVideo className="size-7" aria-hidden="true" /> : <FileImage className="size-7" aria-hidden="true" />}
            <span className="text-[11px] font-bold tracking-wide">{extensionOf(item.filename)}</span>
          </div>
        </div>
      ) : (
        <TileImage id={item.id} alt={item.filename} selected={selected} />
      )}
      <div className="tile-scrim" />
      {item.isVideo ? (
        <span className="pointer-events-none absolute top-1.5 right-1.5 grid size-6 place-items-center rounded-full bg-black/55 text-white">
          <Play className="size-3 fill-current" aria-label="Video" />
        </span>
      ) : null}
      <button
        type="button"
        aria-label={`Open ${item.filename}`}
        className="absolute inset-0 cursor-pointer outline-none"
        onClick={(event) => {
          if (press.current?.fired) {
            press.current = null;
            return;
          }
          if (selecting || event.shiftKey || event.ctrlKey || event.metaKey) onToggle(item.id, event.shiftKey);
          else onOpen(item.id);
        }}
        onPointerDown={(event) => {
          if (event.pointerType !== 'touch') return;
          const current = { x: event.clientX, y: event.clientY, fired: false, timer: 0 };
          current.timer = window.setTimeout(() => {
            current.fired = true;
            onToggle(item.id, false);
            navigator.vibrate?.(12);
          }, LONG_PRESS_MS);
          press.current = current;
        }}
        onPointerMove={(event) => {
          const current = press.current;
          if (current && Math.hypot(event.clientX - current.x, event.clientY - current.y) > 10) cancelPress();
        }}
        onPointerUp={cancelPress}
        onPointerCancel={cancelPress}
        onContextMenu={(event) => {
          // A long press would otherwise open the browser's image menu on a phone.
          if (press.current) event.preventDefault();
        }}
      />
      <button
        type="button"
        role="checkbox"
        aria-checked={selected}
        aria-label={`Select ${item.filename}`}
        className="tile-check cursor-pointer"
        onClick={(event) => {
          event.stopPropagation();
          onToggle(item.id, event.shiftKey);
        }}
      >
        <Circle className="size-[22px] drop-shadow" aria-hidden="true" />
        {/* initial={false}: a row scrolling back into view should not replay this for its selected tiles. */}
        <AnimatePresence initial={false}>
          {selected ? (
            <motion.span
              key="on"
              initial={{ scale: 0.3, opacity: 0 }}
              animate={{ scale: 1, opacity: 1 }}
              exit={{ scale: 0.3, opacity: 0, transition: QUICK }}
              className="absolute grid size-[22px] place-items-center rounded-full bg-[var(--lq-accent)] text-white"
            >
              <Check className="size-3.5" strokeWidth={3} aria-hidden="true" />
            </motion.span>
          ) : null}
        </AnimatePresence>
      </button>
      <div className="pointer-events-none absolute right-1.5 bottom-1.5 left-1.5 flex items-center justify-between">
        <span className="block size-4">
          <AnimatePresence initial={false}>
            {item.favorite ? (
              <motion.span key="star" className="block" initial={{ scale: 0.3, opacity: 0 }} animate={{ scale: 1, opacity: 1 }} exit={{ scale: 0.3, opacity: 0, transition: QUICK }}>
                <Star className={`size-4 drop-shadow ${selected ? 'fill-[var(--lq-accent)] text-[var(--lq-accent)]' : 'fill-white text-white'}`} aria-label="Favorite" />
              </motion.span>
            ) : null}
          </AnimatePresence>
        </span>
        {item.failed ? (
          <span title="Could not reach Telegram" className="grid size-5 place-items-center rounded-full bg-[var(--lq-danger)] text-white">
            <TriangleAlert className="size-3" aria-label="Upload failed" />
          </span>
        ) : item.pending ? (
          <span title="Being saved to Telegram" className="grid size-5 place-items-center rounded-full bg-black/55 text-white">
            <CloudUpload className="size-3 shimmer" aria-label="Being saved to Telegram" />
          </span>
        ) : null}
      </div>
    </motion.div>
  );
});

interface PhotoGridProps {
  items: PhotoItem[];
  selection: Selection;
  onOpen: (id: number) => void;
  /** The photo open in the viewer. The grid follows it, so closing lands on the right tile. */
  revealId?: number | null;
  /** The photo whose tile stays hidden while the viewer is showing it. */
  hiddenId?: number | null;
}

export function PhotoGrid({ items, selection, onOpen, revealId = null, hiddenId = null }: PhotoGridProps) {
  const container = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);
  const [range, setRange] = useState<[number, number]>([0, 40]);

  useLayoutEffect(() => {
    const el = container.current;
    if (!el) return;
    setWidth(el.clientWidth);
    const observer = new ResizeObserver(() => setWidth(el.clientWidth));
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  const layout: Layout = useMemo(
    () => buildLayout(items, { width, targetRowHeight: targetRowHeight(width), gap: GAP, headerHeight: HEADER_HEIGHT, sectionGap: SECTION_GAP }),
    [items, width],
  );

  useEffect(() => {
    let frame = 0;
    const update = () => {
      frame = 0;
      const el = container.current;
      if (!el) return;
      const top = el.getBoundingClientRect().top;
      const viewport = window.innerHeight;
      const from = firstRowAt(layout.rows, -top - viewport * OVERSCAN);
      const to = firstRowAt(layout.rows, -top + viewport * (1 + OVERSCAN));
      // Only re-render when the set of rows actually changes, not on every scrolled pixel.
      setRange((current) => (current[0] === from && current[1] === to ? current : [from, to]));
    };
    const schedule = () => {
      if (!frame) frame = requestAnimationFrame(update);
    };
    update();
    window.addEventListener('scroll', schedule, { passive: true });
    window.addEventListener('resize', schedule);
    return () => {
      if (frame) cancelAnimationFrame(frame);
      window.removeEventListener('scroll', schedule);
      window.removeEventListener('resize', schedule);
    };
  }, [layout]);

  // Hidden behind the viewer, so this can jump. Programmatic scrolling still works with the page locked.
  useEffect(() => {
    const el = container.current;
    if (revealId === null || !el) return;
    const row = layout.rows.find((r) => r.kind === 'photos' && r.tiles.some((t) => t.item.id === revealId));
    if (!row) return;
    const rowTop = el.getBoundingClientRect().top + row.y;
    if (rowTop + row.height <= 0 || rowTop >= window.innerHeight) {
      window.scrollBy({ top: rowTop - (window.innerHeight - row.height) / 2, behavior: 'instant' });
    }
  }, [revealId, layout]);

  const visible = layout.rows.slice(range[0], range[1] + 1);
  const selecting = selection.count > 0;

  return (
    <>
      <div ref={container} className="relative w-full" style={{ height: layout.height }} data-selecting={selecting}>
        {visible.map((row) =>
          row.kind === 'header' ? (
            <DayHeader key={`d${row.day}`} y={row.y} height={row.height} label={row.label} items={row.items} selection={selection} />
          ) : (
            <div key={`r${row.tiles[0]!.item.id}`} className="absolute inset-x-0" style={{ top: row.y, height: row.height }}>
              {row.tiles.map((tile) => (
                <TileView
                  key={tile.item.id}
                  tile={tile}
                  height={row.height}
                  selected={selection.selected.has(tile.item.id)}
                  selecting={selecting}
                  hidden={hiddenId === tile.item.id}
                  onOpen={onOpen}
                  onToggle={selection.toggle}
                />
              ))}
            </div>
          ),
        )}
      </div>
      <Scrubber layout={layout} container={container} />
    </>
  );
}

function DayHeader({ y, height, label, items, selection }: { y: number; height: number; label: string; items: PhotoItem[]; selection: Selection }) {
  const allSelected = items.every((item) => selection.selected.has(item.id));
  return (
    <div className="group/day absolute inset-x-0 flex items-end gap-2 pb-2.5" style={{ top: y, height }}>
      <h2 className="text-[15px] font-semibold tracking-[-0.01em]">{label}</h2>
      <button
        type="button"
        role="checkbox"
        aria-checked={allSelected}
        aria-label={`Select all photos from ${label}`}
        onClick={() => selection.toggleGroup(items)}
        className={`cursor-pointer text-[var(--lq-text-dim)] transition-opacity group-hover/day:opacity-100 focus-visible:opacity-100 ${
          allSelected || selection.count > 0 ? 'opacity-100' : 'opacity-0'
        }`}
      >
        {allSelected ? <CheckCircle2 className="size-[18px] text-[var(--lq-accent)]" aria-hidden="true" /> : <Circle className="size-[18px]" aria-hidden="true" />}
      </button>
    </div>
  );
}
