export function Skeleton({ width = "4em" }: { width?: string }) {
  return <span className="skeleton" style={{ width }} aria-hidden />;
}
