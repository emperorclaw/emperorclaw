import React from "react";
// Native owns navigation. No Next router or network access in the transcript.
export default function Link({ href, children, prefetch: _prefetch, ...props }: React.AnchorHTMLAttributes<HTMLAnchorElement> & { href: string; prefetch?: boolean }) {
    void _prefetch;
    return <a href={href} {...props}>{children}</a>;
}
