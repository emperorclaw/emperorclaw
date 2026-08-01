export default function AuthLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  // Auth pages have their own self-contained dark visual identity
  // (canvas background, dark cards) — they render correctly in both themes.
  return <>{children}</>;
}
