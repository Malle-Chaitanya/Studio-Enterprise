import { useCallback, useRef, useState, type ReactNode } from 'react';
import { DragDivider } from './DragDivider.tsx';

interface Props {
  left: ReactNode;
  right: ReactNode;
  /** Initial left panel width percentage (default 55) */
  defaultSplit?: number;
  /** Min/max clamp for left panel % */
  minPct?: number;
  maxPct?: number;
}

export function TwoPanelShell({
  left,
  right,
  defaultSplit = 55,
  minPct = 25,
  maxPct = 80,
}: Props) {
  const [splitPct, setSplitPct] = useState(defaultSplit);
  const [dragging, setDragging] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<{ startX: number; startPct: number } | null>(null);

  const onMouseDown = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    dragRef.current = { startX: e.clientX, startPct: splitPct };
    setDragging(true);

    const onMove = (ev: MouseEvent) => {
      if (!dragRef.current || !containerRef.current) return;
      const rect = containerRef.current.getBoundingClientRect();
      const dx = ev.clientX - dragRef.current.startX;
      const deltaPct = (dx / rect.width) * 100;
      const next = Math.min(maxPct, Math.max(minPct, dragRef.current.startPct + deltaPct));
      setSplitPct(next);
    };

    const onUp = () => {
      dragRef.current = null;
      setDragging(false);
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
    };

    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  }, [splitPct, minPct, maxPct]);

  return (
    <div
      ref={containerRef}
      className="two-panel-shell"
      style={{ userSelect: dragging ? 'none' : undefined }}
    >
      {/* Left panel */}
      <div
        className="panel-left"
        style={{ width: `${splitPct}%` }}
      >
        {left}
      </div>

      {/* Drag handle */}
      <DragDivider onMouseDown={onMouseDown} active={dragging} />

      {/* Right panel */}
      <div className="panel-right">
        {right}
      </div>
    </div>
  );
}
