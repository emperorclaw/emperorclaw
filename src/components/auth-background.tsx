"use client";

import { useEffect, useRef } from "react";

export function AuthBackground() {
    const canvasRef = useRef<HTMLCanvasElement>(null);

    useEffect(() => {
        const canvas = canvasRef.current;
        if (!canvas) return;
        const ctx = canvas.getContext("2d");
        if (!ctx) return;
        const c = ctx;

        let animId: number;
        let w = 0, h = 0;
        let time = 0;

        function resize() {
            w = canvas!.width = window.innerWidth;
            h = canvas!.height = window.innerHeight;
        }
        resize();
        window.addEventListener("resize", resize);

        // ─── Hex grid nodes ──────────────────────────
        const hexSize = 90;
        const nodes: { x: number; y: number; ox: number; oy: number }[] = [];
        const cols = Math.ceil(w / hexSize) + 2;
        const rows = Math.ceil(h / (hexSize * 0.75)) + 2;
        for (let row = -1; row < rows; row++) {
            for (let col = -1; col < cols; col++) {
                const offsetX = (row % 2) * (hexSize / 2);
                nodes.push({
                    x: col * hexSize + offsetX,
                    y: row * hexSize * 0.75,
                    ox: col * hexSize + offsetX,
                    oy: row * hexSize * 0.75,
                });
            }
        }

        // ─── Light rays ──────────────────────────────
        const rays: { angle: number; speed: number; alpha: number; length: number }[] = [];
        for (let i = 0; i < 5; i++) {
            rays.push({
                angle: (Math.PI / 6) + (i * Math.PI / 12) - (Math.PI / 12),
                speed: 0.0003 + Math.random() * 0.0004,
                alpha: 0.015 + Math.random() * 0.025,
                length: h * (1.5 + Math.random()),
            });
        }

        function draw() {
            time += 1;
            c.clearRect(0, 0, w, h);

            // ─── Light rays from top-center ────────────
            for (const ray of rays) {
                ray.angle += ray.speed;
                const cx = w / 2;
                const cy = h * 0.15;
                const endX = cx + Math.cos(ray.angle) * ray.length;
                const endY = cy + Math.sin(ray.angle) * ray.length;

                const grad = c.createLinearGradient(cx, cy, endX, endY);
                grad.addColorStop(0, `rgba(6, 182, 212, ${ray.alpha})`);
                grad.addColorStop(0.5, `rgba(6, 182, 212, ${ray.alpha * 0.3})`);
                grad.addColorStop(1, "rgba(6, 182, 212, 0)");
                c.fillStyle = grad;
                c.beginPath();
                c.moveTo(cx - 60, cy);
                c.lineTo(endX + 40, endY + 40);
                c.lineTo(endX - 40, endY + 40);
                c.closePath();
                c.fill();
            }

            // ─── Hex grid with breathing glow ──────────
            const breathe = 1 + Math.sin(time * 0.008) * 0.3;
            for (const node of nodes) {
                const dx = node.x - w / 2;
                const dy = node.y - h * 0.35;
                const dist = Math.sqrt(dx * dx + dy * dy);
                const maxDist = Math.sqrt(w * w + h * h) / 1.8;
                const fade = Math.max(0, 1 - dist / maxDist);
                const alpha = fade * fade * 0.12 * breathe;

                if (alpha < 0.005) continue;

                c.fillStyle = `rgba(6, 182, 212, ${alpha})`;
                c.beginPath();
                c.arc(node.x, node.y, 1.6, 0, Math.PI * 2);
                c.fill();

                // Connect to neighbors
                for (const other of nodes) {
                    const ddx = node.x - other.x;
                    const ddy = node.y - other.y;
                    const d = Math.sqrt(ddx * ddx + ddy * ddy);
                    if (d < hexSize * 1.1 && d > hexSize * 0.85) {
                        const edgeAlpha = alpha * 0.25 * (1 - Math.abs(d - hexSize) / (hexSize * 0.25));
                        if (edgeAlpha > 0.002) {
                            c.strokeStyle = `rgba(6, 182, 212, ${edgeAlpha})`;
                            c.lineWidth = 0.5;
                            c.beginPath();
                            c.moveTo(node.x, node.y);
                            c.lineTo(other.x, other.y);
                            c.stroke();
                        }
                    }
                }
            }

            // ─── Floating accent dots ──────────────────
            const dotTime = time * 0.0006;
            for (let i = 0; i < 12; i++) {
                const angle = dotTime + (i / 12) * Math.PI * 2;
                const radius = Math.min(w, h) * (0.2 + Math.sin(dotTime * 2 + i) * 0.1);
                const dx = w / 2 + Math.cos(angle) * radius;
                const dy = h * 0.4 + Math.sin(angle * 1.3) * radius * 0.6;
                const dotAlpha = 0.08 + Math.sin(time * 0.01 + i) * 0.04;
                const glow = c.createRadialGradient(dx, dy, 0, dx, dy, 30);
                glow.addColorStop(0, `rgba(34, 211, 238, ${dotAlpha})`);
                glow.addColorStop(0.3, `rgba(6, 182, 212, ${dotAlpha * 0.3})`);
                glow.addColorStop(1, "rgba(6, 182, 212, 0)");
                c.fillStyle = glow;
                c.beginPath();
                c.arc(dx, dy, 30, 0, Math.PI * 2);
                c.fill();

                // Gold accent every 3rd dot
                if (i % 3 === 0) {
                    c.fillStyle = `rgba(251, 191, 36, ${dotAlpha * 0.6})`;
                    c.beginPath();
                    c.arc(dx, dy, 2, 0, Math.PI * 2);
                    c.fill();
                }
            }

            animId = requestAnimationFrame(draw);
        }

        draw();

        return () => {
            cancelAnimationFrame(animId);
            window.removeEventListener("resize", resize);
        };
    }, []);

    return (
        <div className="absolute inset-0 overflow-hidden pointer-events-none z-0 bg-[#020617]">
            {/* Deep radial vignette */}
            <div className="absolute inset-0 bg-[radial-gradient(ellipse_80%_60%_at_50%_25%,_rgba(6,182,212,0.04)_0%,_transparent_55%,_rgba(2,6,23,0.95)_100%)] z-[6]" />

            {/* Canvas layer */}
            <canvas ref={canvasRef} className="absolute inset-0 z-[1]" />

            {/* Large ambient orbs — premium multi-color */}
            <div className="absolute top-[-30%] left-[-15%] w-[800px] h-[800px] bg-gradient-to-br from-cyan-500/6 via-cyan-600/3 to-transparent rounded-full blur-[200px] animate-[pulse_12s_ease-in-out_infinite] z-[2]" />
            <div className="absolute top-[20%] right-[-20%] w-[700px] h-[700px] bg-gradient-to-bl from-amber-500/3 via-amber-600/2 to-transparent rounded-full blur-[180px] animate-[pulse_14s_ease-in-out_infinite_3s] z-[2]" />
            <div className="absolute bottom-[-20%] left-[30%] w-[600px] h-[600px] bg-gradient-to-tr from-teal-500/4 via-emerald-500/2 to-transparent rounded-full blur-[160px] animate-[pulse_16s_ease-in-out_infinite_6s] z-[2]" />

            {/* Subtle grain overlay */}
            <div
                className="absolute inset-0 z-[4] opacity-[0.025] mix-blend-overlay"
                style={{
                    backgroundImage: `url("data:image/svg+xml,%3Csvg viewBox='0 0 256 256' xmlns='http://www.w3.org/2000/svg'%3E%3Cfilter id='n'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.85' numOctaves='4' stitchTiles='stitch'/%3E%3C/filter%3E%3Crect width='100%25' height='100%25' filter='url(%23n)'/%3E%3C/svg%3E")`,
                    backgroundSize: "200px 200px",
                }}
            />
        </div>
    );
}
