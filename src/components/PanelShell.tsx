import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';

const MOBILE_QUERY = '(max-width: 900px)';
/**
 * Сколько шторки видно в свёрнутом состоянии, читается из CSS-переменной
 * `--peek`: в альбомной ориентации экран низкий и «пик» там меньше, поэтому
 * значением владеют медиазапросы, а не JS.
 */
const PEEK_FALLBACK = 188;

export function readPeek(): number {
  const raw = getComputedStyle(document.documentElement).getPropertyValue('--peek');
  const value = Number.parseFloat(raw);
  return Number.isFinite(value) ? value : PEEK_FALLBACK;
}
/** Порог, после которого жест считается смахиванием, а не дрожанием пальца. */
const SWIPE_PX = 56;

export function useIsMobile(): boolean {
  const [isMobile, setIsMobile] = useState(
    () => typeof window !== 'undefined' && window.matchMedia(MOBILE_QUERY).matches,
  );

  useEffect(() => {
    const mq = window.matchMedia(MOBILE_QUERY);
    const onChange = () => setIsMobile(mq.matches);
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
  }, []);

  return isMobile;
}

interface PanelShellProps {
  children: ReactNode;
}

/**
 * На десктопе — боковая панель слева. На телефоне — нижняя шторка поверх карты:
 * карта важнее списка, поэтому по умолчанию видно только заголовок, а данные
 * вытягиваются пальцем или тапом по ручке.
 */
export default function PanelShell({ children }: PanelShellProps) {
  const isMobile = useIsMobile();
  const sheetRef = useRef<HTMLDivElement>(null);
  const bodyRef = useRef<HTMLDivElement>(null);
  const [expanded, setExpanded] = useState(false);
  /** Высота шторки в пикселях; до замера позицию задаёт CSS. */
  const [sheetH, setSheetH] = useState<number | null>(null);
  const [peek, setPeek] = useState(PEEK_FALLBACK);
  /** Смещение во время перетаскивания; null — шторка стоит на месте. */
  const [dragOffset, setDragOffset] = useState<number | null>(null);
  const dragRef = useRef<{ startY: number; startOffset: number } | null>(null);

  useLayoutEffect(() => {
    const el = sheetRef.current;
    if (!el) {
      setSheetH(null);
      return;
    }
    const measure = () => {
      setSheetH(el.offsetHeight);
      setPeek(readPeek());
    };
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    measure();
    return () => ro.disconnect();
  }, [isMobile]);

  const collapsedOffset = useCallback(
    () => (sheetH == null ? 0 : Math.max(sheetH - peek, 0)),
    [sheetH, peek],
  );

  const onPointerDown = (e: React.PointerEvent) => {
    dragRef.current = { startY: e.clientY, startOffset: expanded ? 0 : collapsedOffset() };
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
    setDragOffset(dragRef.current.startOffset);
  };

  const onPointerMove = (e: React.PointerEvent) => {
    const drag = dragRef.current;
    if (!drag) return;
    const next = drag.startOffset + (e.clientY - drag.startY);
    setDragOffset(Math.min(Math.max(next, 0), collapsedOffset()));
  };

  const onPointerUp = (e: React.PointerEvent) => {
    const drag = dragRef.current;
    dragRef.current = null;
    setDragOffset(null);
    if (!drag) return;

    const dy = e.clientY - drag.startY;
    // Короткий тап по ручке — просто переключение.
    if (Math.abs(dy) < 6) {
      setExpanded((v) => !v);
      return;
    }
    if (dy < -SWIPE_PX) setExpanded(true);
    else if (dy > SWIPE_PX) setExpanded(false);
  };

  // Свёрнутая шторка не должна оставаться прокрученной внутри себя.
  useEffect(() => {
    if (!expanded && bodyRef.current) bodyRef.current.scrollTop = 0;
  }, [expanded]);

  if (!isMobile) return <aside className="sidebar">{children}</aside>;

  // До первого замера позицию держит CSS — иначе шторка мигнёт раскрытой.
  const offset = dragOffset ?? (sheetH == null ? null : expanded ? 0 : collapsedOffset());

  return (
    <div
      ref={sheetRef}
      className={`sheet${expanded ? ' is-expanded' : ''}${dragOffset !== null ? ' is-dragging' : ''}`}
      style={offset == null ? undefined : { transform: `translateY(${offset}px)` }}
    >
      <button
        type="button"
        className="sheet__handle"
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
        aria-expanded={expanded}
        aria-label={expanded ? 'Свернуть панель' : 'Развернуть панель'}
      >
        <span className="sheet__grip" />
      </button>
      <div className="sheet__body" ref={bodyRef}>
        {children}
      </div>
    </div>
  );
}
