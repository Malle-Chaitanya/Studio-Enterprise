import type { MouseEvent } from 'react';

interface Props {
  onMouseDown: (e: MouseEvent<HTMLDivElement>) => void;
  active?: boolean;
}

const dots = [0, 1, 2, 3, 4, 5] as const;

export function DragDivider({ onMouseDown, active = false }: Props) {
  return (
    <div
      className={`drag-divider${active ? ' active' : ''}`}
      onMouseDown={onMouseDown}
      title="Drag to resize panels"
    >
      <svg width="8" height="24" viewBox="0 0 8 24" fill="none">
        {dots.map((i) => {
          const row = Math.floor(i / 2);
          const col = i % 2;
          return (
            <circle
              key={i}
              cx={col === 0 ? 2 : 6}
              cy={4 + row * 8}
              r="1.5"
              fill="currentColor"
            />
          );
        })}
      </svg>
    </div>
  );
}
