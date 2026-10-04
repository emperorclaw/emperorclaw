export default function AuthLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  // Auth pages have their own dark visual identity (canvas background, dark
  // cards). Scope them to the dark palette so a light-theme user doesn't get
  // the light (inverted) grays on that dark canvas, which made text vanish.
  return <div className="dark min-h-screen bg-[#050507] text-foreground" style={{ colorScheme: "dark" }}>{children}</div>;
}
