// Remounts on every navigation, so each page settles in (.page-in).
export default function Template({ children }: { children: React.ReactNode }) {
  return <div className="page-in">{children}</div>;
}
