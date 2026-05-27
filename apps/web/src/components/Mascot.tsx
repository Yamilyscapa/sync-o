import {
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type PointerEvent,
  type RefObject,
} from "react";

type Resting = { kind: "home" } | { kind: "top"; t: number };

type Props = {
  homeRef: RefObject<HTMLElement | null>;
};

const MASCOT = 56;
const PEEK = 30;
const SNAP_PAD = 80;

export function Mascot({ homeRef }: Props) {
  const [resting, setResting] = useState<Resting>({ kind: "home" });
  const [dragPos, setDragPos] = useState<{ x: number; y: number } | null>(null);
  const [rect, setRect] = useState<DOMRect | null>(null);
  const startRef = useRef<{
    px: number;
    py: number;
    bx: number;
    by: number;
  } | null>(null);

  useLayoutEffect(() => {
    const el = homeRef.current;
    if (!el) return;
    const update = () => setRect(el.getBoundingClientRect());
    update();
    const ro = new ResizeObserver(update);
    ro.observe(el);
    window.addEventListener("scroll", update, true);
    window.addEventListener("resize", update);
    return () => {
      ro.disconnect();
      window.removeEventListener("scroll", update, true);
      window.removeEventListener("resize", update);
    };
  }, [homeRef]);

  const restPos = useMemo(() => {
    if (!rect) return { left: 0, top: -MASCOT + PEEK };
    return positionFor(resting, rect, MASCOT, PEEK);
  }, [resting, rect]);

  function onPointerDown(e: PointerEvent<HTMLImageElement>) {
    e.preventDefault();
    (e.target as Element).setPointerCapture(e.pointerId);
    startRef.current = {
      px: e.clientX,
      py: e.clientY,
      bx: restPos.left,
      by: restPos.top,
    };
    setDragPos({ x: restPos.left, y: restPos.top });
  }

  function onPointerMove(e: PointerEvent<HTMLImageElement>) {
    const s = startRef.current;
    if (!s) return;
    setDragPos({
      x: s.bx + (e.clientX - s.px),
      y: s.by + (e.clientY - s.py),
    });
  }

  function onPointerUp(e: PointerEvent<HTMLImageElement>) {
    const s = startRef.current;
    if (!s) return;
    startRef.current = null;
    const r = homeRef.current?.getBoundingClientRect();
    setDragPos(null);
    if (!r) {
      setResting({ kind: "home" });
      return;
    }
    const px = e.clientX - r.left;
    const py = e.clientY - r.top;
    setResting(snapTo(px, py, r));
  }

  const isDragging = dragPos !== null;
  const left = dragPos ? dragPos.x : restPos.left;
  const top = dragPos ? dragPos.y : restPos.top;

  return (
    <img
      src="/mascot.webp"
      alt=""
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
      draggable={false}
      style={{
        position: "absolute",
        left: `${left}px`,
        top: `${top}px`,
        width: MASCOT,
        height: MASCOT,
        transition: isDragging
          ? "none"
          : "left 320ms cubic-bezier(0.4, 1.4, 0.5, 1), top 320ms cubic-bezier(0.4, 1.4, 0.5, 1)",
        touchAction: "none",
        zIndex: 20,
      }}
      className={`select-none drop-shadow-[0_4px_12px_rgba(244,114,182,0.25)] ${
        isDragging ? "cursor-grabbing" : "cursor-grab"
      }`}
    />
  );
}

function positionFor(
  r: Resting,
  rect: DOMRect,
  m: number,
  peek: number,
): { left: number; top: number } {
  const topY = -m + peek;
  if (r.kind === "home") return { left: rect.width - m, top: topY };
  const tClamped = Math.max(0, Math.min(1, r.t));
  return { left: tClamped * rect.width - m / 2, top: topY };
}

function snapTo(px: number, py: number, rect: DOMRect): Resting {
  const inHorizontal = px >= -SNAP_PAD && px <= rect.width + SNAP_PAD;
  const inVertical = py >= -SNAP_PAD && py <= rect.height + SNAP_PAD;
  if (!inHorizontal || !inVertical) return { kind: "home" };
  const cx = Math.max(0, Math.min(rect.width, px));
  return { kind: "top", t: cx / rect.width };
}
