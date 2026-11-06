/**
 * Remounts on every navigation (unlike the layout), so the page's first
 * blocks rise into place once per route (`.ec-page-arrive` in globals.css).
 * A router refresh, such as the 15 s AutoRefresh, keeps this instance, so the
 * arrival never replays on live data.
 */
export default function AppTemplate({ children }: { children: React.ReactNode }) {
    return <div className="ec-page-arrive">{children}</div>;
}
