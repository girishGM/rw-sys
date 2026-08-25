import { cx } from './internal/cx';

export interface ChartDatum {
  label: string;
  value: number;
}

export interface ChartProps {
  data: ChartDatum[];
  className?: string;
  /** Accessible name for the chart region — required, there is no visual substitute. */
  title: string;
  height?: number;
}

/**
 * T-021 — deliberately thin (04-FRONTEND.md §7 scope: "charts beyond a thin `Chart`
 * wrapper" are out of scope for this task). A dependency-free SVG bar chart, exposed as a
 * data table for assistive tech (`<table>` is visually hidden but present) since an SVG
 * has no meaningful text alternative for a series of values. Feature agents needing
 * richer chart types compose a real charting library behind this same contract later.
 */
export function Chart({ data, className, title, height = 160 }: ChartProps) {
  const max = Math.max(1, ...data.map((d) => d.value));
  const barWidth = data.length > 0 ? 100 / data.length : 100;

  return (
    <figure className={cx('w-full', className)} role="group" aria-label={title}>
      <svg
        viewBox={`0 0 100 ${height}`}
        preserveAspectRatio="none"
        className="h-40 w-full overflow-visible"
        aria-hidden="true"
      >
        {data.map((d, index) => {
          const barHeight = (d.value / max) * (height - 4);
          return (
            <rect
              key={d.label}
              x={index * barWidth + barWidth * 0.15}
              y={height - barHeight}
              width={barWidth * 0.7}
              height={barHeight}
              className="fill-primary-500"
            />
          );
        })}
      </svg>
      <table className="sr-only">
        <caption>{title}</caption>
        <thead>
          <tr>
            <th scope="col">Label</th>
            <th scope="col">Value</th>
          </tr>
        </thead>
        <tbody>
          {data.map((d) => (
            <tr key={d.label}>
              <th scope="row">{d.label}</th>
              <td>{d.value}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </figure>
  );
}
