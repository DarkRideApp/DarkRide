

interface SkeletonLineProps {
  width?: string;
  height?: number;
}

export function SkeletonLine({ width = '100%', height = 14 }: SkeletonLineProps) {
  return (
    <div
      className="skeleton skeleton-line"
      style={{ width, height }}
    />
  );
}

export function SkeletonCard() {
  return (
    <div className="skeleton-card">
      <SkeletonLine width="100%" />
      <SkeletonLine width="75%" />
      <SkeletonLine width="50%" />
    </div>
  );
}

interface SkeletonTableProps {
  rows?: number;
  columns?: number;
}

export function SkeletonTable({ rows = 5, columns = 4 }: SkeletonTableProps) {
  return (
    <div className="skeleton-table">
      <div className="skeleton-table-header">
        {Array.from({ length: columns }).map((_, i) => (
          <div key={i} style={{ flex: 1 }}>
            <SkeletonLine height={12} />
          </div>
        ))}
      </div>
      {Array.from({ length: rows }).map((_, rowIdx) => (
        <div key={rowIdx} className="skeleton-table-row">
          {Array.from({ length: columns }).map((_, colIdx) => (
            <div key={colIdx} style={{ flex: 1 }}>
              <SkeletonLine height={14} />
            </div>
          ))}
        </div>
      ))}
    </div>
  );
}
