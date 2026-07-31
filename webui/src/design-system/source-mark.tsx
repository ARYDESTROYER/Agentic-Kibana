import * as React from 'react';

import { cn } from '@/lib/cn';
import {
  FALLBACK_SOURCE_MARK,
  SOURCE_MARK_BY_TYPE,
  type SourceMarkDefinition,
} from './assets/source-marks';

export interface SourceMarkProps extends Omit<React.SVGAttributes<SVGSVGElement>, 'children'> {
  /** Wire-compatible connector/source type. Unknown values use the generic mark. */
  sourceType: string;
  /** Hide the mark from assistive technology when adjacent text already names it. */
  decorative?: boolean;
  /** Optional accessible override for plugin-defined connector names. */
  label?: string;
}

function MarkGeometry({ definition }: { definition: SourceMarkDefinition }) {
  return (
    <>
      {definition.paths?.map((path, index) => (
        <path
          key={`p-${index}`}
          d={path.d}
          fill={path.fill ? 'currentColor' : 'none'}
          stroke={path.fill ? 'none' : 'currentColor'}
          strokeWidth={path.strokeWidth}
          opacity={path.opacity}
        />
      ))}
      {definition.circles?.map((circle, index) => (
        <circle
          key={`c-${index}`}
          cx={circle.cx}
          cy={circle.cy}
          r={circle.r}
          fill={circle.fill ? 'currentColor' : 'none'}
          stroke={circle.fill ? 'none' : 'currentColor'}
          opacity={circle.opacity}
        />
      ))}
      {definition.rects?.map((rect, index) => (
        <rect
          key={`r-${index}`}
          x={rect.x}
          y={rect.y}
          width={rect.width}
          height={rect.height}
          rx={rect.rx}
          fill={rect.fill ? 'currentColor' : 'none'}
          stroke={rect.fill ? 'none' : 'currentColor'}
          opacity={rect.opacity}
        />
      ))}
      {definition.lines?.map((line, index) => (
        <line
          key={`l-${index}`}
          x1={line.x1}
          y1={line.y1}
          x2={line.x2}
          y2={line.y2}
          opacity={line.opacity}
        />
      ))}
    </>
  );
}

/** Theme-adaptive custom vector identity for a connector/source type. */
export const SourceMark = React.forwardRef<SVGSVGElement, SourceMarkProps>(
  ({ sourceType, decorative = false, label, className, ...props }, ref) => {
    const definition = SOURCE_MARK_BY_TYPE.get(sourceType) ?? FALLBACK_SOURCE_MARK;
    const accessibleLabel = label || definition.label;
    return (
      <svg
        ref={ref}
        viewBox="0 0 24 24"
        className={cn('size-5 shrink-0', className)}
        fill="none"
        stroke="currentColor"
        strokeWidth="1.65"
        strokeLinecap="round"
        strokeLinejoin="round"
        role={decorative ? undefined : 'img'}
        aria-hidden={decorative ? true : undefined}
        aria-label={decorative ? undefined : accessibleLabel}
        data-source-mark={definition.id}
        data-source-type={sourceType}
        {...props}
      >
        <MarkGeometry definition={definition} />
      </svg>
    );
  },
);
SourceMark.displayName = 'SourceMark';

