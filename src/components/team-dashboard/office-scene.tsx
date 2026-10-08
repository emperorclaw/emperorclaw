"use client";

import Link from "next/link";
import { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { IconPlus, IconZoomIn, IconZoomOut, IconArrowsMaximize } from "@tabler/icons-react";
import {
    arcPath, CHARACTER_SCALE, hashString, iso, labelLifts, WALL_H,
    requiresHumanAction, agentMotion, centerOn, fitCamera, panCamera, worldTransform, zoomAtPoint,
    type CameraState, type CollaborationLink, type OfficeLayout, type PlacedAgent, type SceneActivity, type ZoneId, type ZoneLayout,
} from "@/lib/team-scene";
import { resolveAppearance } from "@/lib/character/model";
import { cn } from "@/lib/utils";
import { CharacterFigureView, moodForStatus } from "@/components/character/character-avatar";
import type { CharacterExpression } from "@/lib/character/draw";
import { ActivityCue } from "./character-activity";
import { AgentAvatar, STATUS_COLOR } from "./agent-character";
import {
    Box, Chair, CoffeeCounter, DeskFront, FloorEllipse, FloorLamp, Plant, PlaneGroup, RoundTable, Shelf, SofaArm, SofaBack, pts,
} from "./office-props";

const MAX_SCENE_HEIGHT = 600;
const LABEL_BOX = { full: { w: 168, h: 54 }, name: { w: 132, h: 36 }, dot: { w: 22, h: 22 } } as const;

interface OfficeSceneProps {
    layout: OfficeLayout;
    links: CollaborationLink[];
    selectedKey: string | null;
    hoveredKey: string | null;
    isActive: (agent: PlacedAgent) => boolean;
    reducedMotion: boolean;
    onSelect: (key: string) => void;
    onHover: (key: string | null) => void;
    onOverflow: (zone: ZoneId) => void;
    emptyState?: ReactNode;
}

type Node = { row: number; depth: number; key: string; el: ReactNode };

const clamp01 = (v: number) => Math.min(1, Math.max(0, v));

export function OfficeScene({ layout, links, selectedKey, hoveredKey, isActive, reducedMotion, onSelect, onHover, onOverflow, emptyState }: OfficeSceneProps) {
    const uid = useId().replace(/:/g, "");
    const { viewBox: vb, width: W, depth: D } = layout;
    const frameRef = useRef<HTMLDivElement>(null);
    const worldRef = useRef<HTMLDivElement>(null);

    const [frameWidth, setFrameWidth] = useState(1000);
    useEffect(() => {
        const el = frameRef.current;
        if (!el) return;
        const observer = new ResizeObserver(([entry]) => setFrameWidth(Math.max(1, entry.contentRect.width)));
        observer.observe(el);
        return () => observer.disconnect();
    }, []);

    // Camera: fit-all by default, then pan/zoom via gestures + controls.
    const [camera, setCamera] = useState<CameraState>(() => fitCamera(vb));
    const cameraRef = useRef(camera);
    const applyTransform = useCallback((cam: CameraState, animate: boolean) => {
        const el = worldRef.current;
        if (!el) return;
        el.style.transition = animate ? "transform 320ms cubic-bezier(0.2, 0.8, 0.2, 1)" : "none";
        el.style.transform = worldTransform(cam, vb, el.clientWidth || 1);
    }, [vb]);
    const setCameraSmooth = useCallback((next: CameraState) => setCamera(next), []);
    const mountedRef = useRef(false);
    useLayoutEffect(() => {
        cameraRef.current = camera;
        applyTransform(camera, mountedRef.current && !reducedMotion);
        mountedRef.current = true;
    }, [camera, applyTransform, reducedMotion]);
    useEffect(() => {
        // Re-apply on resize without animating.
        applyTransform(cameraRef.current, false);
    }, [frameWidth, applyTransform]);

    // Pan-to-selection (list / attention panel) keeps the chosen agent in view.
    // Only a *change* of selection moves the camera; panning or zooming afterwards
    // must not snap back, so the current camera is read from the ref, not deps.
    const lastSelectionRef = useRef(selectedKey);
    useEffect(() => {
        if (selectedKey === lastSelectionRef.current) return;
        lastSelectionRef.current = selectedKey;
        const agent = layout.agents.find((a) => a.member.key === selectedKey);
        // Selection originates in the list/attention panel; keep the chosen agent in frame.
        if (agent) setCameraSmooth(centerOn(cameraRef.current, { x: agent.anchor.x, y: agent.anchor.y }, vb));
    }, [selectedKey, layout.agents, vb, setCameraSmooth]);

    const lifts = useMemo(() => labelLifts(layout.agents, vb.w / frameWidth, LABEL_BOX[layout.labelMode]), [layout.agents, layout.labelMode, vb.w, frameWidth]);
    const agentsByKey = new Map(layout.agents.map((a) => [a.member.key, a]));
    const lite = layout.agents.length > 16;
    const talkingKeys = useMemo(() => new Set(links.flatMap((l) => [l.from.member.key, l.to.member.key])), [links]);

    // Pause every activity animation when the floor is off-screen or the tab is
    // hidden, so a background dashboard costs nothing.
    const [visible, setVisible] = useState(true);
    const [hidden, setHidden] = useState(false);
    useEffect(() => {
        const el = frameRef.current;
        if (!el) return;
        const observer = new IntersectionObserver(([entry]) => setVisible(entry.isIntersecting), { threshold: 0.05 });
        observer.observe(el);
        const onVisibility = () => setHidden(document.hidden);
        document.addEventListener("visibilitychange", onVisibility);
        onVisibility();
        return () => {
            observer.disconnect();
            document.removeEventListener("visibilitychange", onVisibility);
        };
    }, []);
    const paused = !visible || hidden;

    /* ── Camera gestures (pointer pan + pinch, wheel zoom, keyboard) ── */
    const pointersRef = useRef(new Map<number, { x: number; y: number }>());
    const dragRef = useRef<{ x: number; y: number; cam: CameraState } | null>(null);
    const pinchRef = useRef<{ dist: number; cam: CameraState; fx: number; fy: number } | null>(null);
    const movedRef = useRef(false);
    const [dragging, setDragging] = useState(false);

    const onPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
        if (e.pointerType === "mouse" && e.button !== 0) return;
        // Capture only once a gesture starts (see onPointerMove): capturing on
        // down would retarget a plain click away from the agent under it.
        pointersRef.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
        if (pointersRef.current.size === 1) {
            movedRef.current = false;
            dragRef.current = { x: e.clientX, y: e.clientY, cam: cameraRef.current };
        } else if (pointersRef.current.size === 2) {
            dragRef.current = null;
            const [a, b] = [...pointersRef.current.values()];
            const rect = frameRef.current!.getBoundingClientRect();
            pinchRef.current = {
                dist: Math.hypot(a.x - b.x, a.y - b.y) || 1,
                cam: cameraRef.current,
                fx: clamp01(((a.x + b.x) / 2 - rect.left) / rect.width),
                fy: clamp01(((a.y + b.y) / 2 - rect.top) / rect.height),
            };
        }
    };

    const onPointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
        if (!pointersRef.current.has(e.pointerId)) return;
        pointersRef.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
        if (pinchRef.current && pointersRef.current.size === 2) {
            const [a, b] = [...pointersRef.current.values()];
            const rect = frameRef.current!.getBoundingClientRect();
            const factor = Math.hypot(a.x - b.x, a.y - b.y) / pinchRef.current.dist;
            const fx = clamp01(((a.x + b.x) / 2 - rect.left) / rect.width);
            const fy = clamp01(((a.y + b.y) / 2 - rect.top) / rect.height);
            if (!movedRef.current) e.currentTarget.setPointerCapture(e.pointerId);
            const next = zoomAtPoint(pinchRef.current.cam, fx, fy, factor, vb);
            cameraRef.current = next;
            applyTransform(next, false);
            movedRef.current = true;
        } else if (dragRef.current && pointersRef.current.size === 1) {
            const dx = e.clientX - dragRef.current.x;
            const dy = e.clientY - dragRef.current.y;
            if (!movedRef.current && Math.hypot(dx, dy) > 4) {
                movedRef.current = true;
                e.currentTarget.setPointerCapture(e.pointerId);
                setDragging(true);
            }
            if (movedRef.current) {
                const frameW = frameRef.current?.clientWidth ?? 1;
                const unit = vb.w / frameW; // scene units per rendered px (both axes)
                const next = panCamera(dragRef.current.cam, -dx * unit, -dy * unit, vb);
                cameraRef.current = next;
                applyTransform(next, false);
            }
        }
    };

    const onPointerUp = (e: React.PointerEvent<HTMLDivElement>) => {
        pointersRef.current.delete(e.pointerId);
        if (pointersRef.current.size < 2) pinchRef.current = null;
        if (pointersRef.current.size === 0) {
            dragRef.current = null;
            setDragging(false);
            setCamera(cameraRef.current);
        } else if (pointersRef.current.size === 1) {
            const [p] = [...pointersRef.current.values()];
            movedRef.current = false;
            setDragging(false);
            dragRef.current = { x: p.x, y: p.y, cam: cameraRef.current };
        }
    };

    useEffect(() => {
        const el = frameRef.current;
        if (!el) return;
        const onWheel = (e: WheelEvent) => {
            e.preventDefault();
            const rect = el.getBoundingClientRect();
            const fx = clamp01((e.clientX - rect.left) / rect.width);
            const fy = clamp01((e.clientY - rect.top) / rect.height);
            const factor = e.deltaY < 0 ? 1.12 : 1 / 1.12;
            setCameraSmooth(zoomAtPoint(cameraRef.current, fx, fy, factor, vb));
        };
        el.addEventListener("wheel", onWheel, { passive: false });
        return () => el.removeEventListener("wheel", onWheel);
    }, [vb, setCameraSmooth]);

    const nudge = (dx: number, dy: number) => {
        const step = (vb.w / cameraRef.current.scale) * 0.08;
        setCameraSmooth(panCamera(cameraRef.current, dx * step, dy * step, vb));
    };
    const onKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
        switch (e.key) {
            case "ArrowUp": e.preventDefault(); nudge(0, -1); break;
            case "ArrowDown": e.preventDefault(); nudge(0, 1); break;
            case "ArrowLeft": e.preventDefault(); nudge(-1, 0); break;
            case "ArrowRight": e.preventDefault(); nudge(1, 0); break;
            case "+": case "=": e.preventDefault(); setCameraSmooth(zoomAtPoint(cameraRef.current, 0.5, 0.5, 1.15, vb)); break;
            case "-": e.preventDefault(); setCameraSmooth(zoomAtPoint(cameraRef.current, 0.5, 0.5, 1 / 1.15, vb)); break;
            case "0": e.preventDefault(); setCameraSmooth(fitCamera(vb)); break;
        }
    };
    const zoomBy = (factor: number) => setCameraSmooth(zoomAtPoint(cameraRef.current, 0.5, 0.5, factor, vb));
    const fitAll = () => setCameraSmooth(fitCamera(vb));

    // Click-vs-drag: a pan that moved is never also an agent click.
    const centerOnAgent = (agent: PlacedAgent) => setCameraSmooth(centerOn(camera, { x: agent.anchor.x, y: agent.anchor.y }, vb));

    const nodes: Node[] = [];
    for (const zone of layout.zones) {
        if (zone.signWall === "partition") nodes.push({ row: zone.row, depth: zone.gx + zone.gy, key: `part-${zone.meta.id}`, el: <Partition zone={zone} /> });
        if (zone.meta.id === "lounge") {
            nodes.push(...loungeNodes(zone, agentsByKey, { selectedKey, hoveredKey, isActive, onSelect, onHover, onCenter: centerOnAgent, talkingKeys, lite, reducedMotion }));
        } else {
            nodes.push(...zoneDecorNodes(zone));
            zone.desks.forEach((desk, i) => {
                const agent = desk.occupant ? agentsByKey.get(desk.occupant.member.key) ?? null : null;
                const seed = hashString(`${zone.meta.id}-${i}`);
                const seatHue = agent ? resolveAppearance({ id: agent.member.id, avatarUrl: agent.member.avatarUrl, avatarAppearance: agent.member.avatarAppearance }).hue : 215;
                nodes.push({
                    row: zone.row,
                    depth: desk.gx + desk.gy + 2,
                    key: `desk-${zone.meta.id}-${i}`,
                    el: (
                        <g opacity={agent && !isActive(agent) ? 0.32 : 1} className="transition-opacity duration-300">
                            <Chair gx={desk.gx + 2.55} gy={desk.gy + 1.05} hue={seatHue} />
                            {agent && <SceneCharacter agent={agent} selected={agent.member.key === selectedKey} hovered={agent.member.key === hoveredKey} onSelect={onSelect} onHover={onHover} onCenter={centerOnAgent} talking={talkingKeys.has(agent.member.key)} lite={lite} reducedMotion={reducedMotion} />}
                            <DeskFront gx={desk.gx} gy={desk.gy} status={agent?.status ?? null} occupied={Boolean(agent)} seed={seed} />
                        </g>
                    ),
                });
            });
        }
    }
    for (const [i, cell] of layout.emptyCells.entries()) {
        const row = layout.zones.find((z) => z.gy === cell.gy)?.row ?? 0;
        nodes.push({ row, depth: cell.gx + cell.gy + cell.d / 2, key: `empty-${i}`, el: <MeetingCorner cell={cell} /> });
    }
    nodes.sort((a, b) => a.row - b.row || a.depth - b.depth);

    const backZones = layout.zones.filter((z) => z.signWall === "back");
    const leftZones = layout.zones.filter((z) => z.signWall === "left");
    const firstRowDepth = layout.zones.find((z) => z.row === 0)?.d ?? D;
    const aspect = vb.w / vb.h;
    const pct = (p: { x: number; y: number }) => ({ left: `${((p.x - vb.x) / vb.w) * 100}%`, top: `${((p.y - vb.y) / vb.h) * 100}%` });

    return (
        <div ref={frameRef} tabIndex={0} aria-label="Live office. Drag to pan, scroll to zoom."
            onKeyDown={onKeyDown}
            onPointerDown={onPointerDown} onPointerMove={onPointerMove} onPointerUp={onPointerUp} onPointerCancel={onPointerUp}
            onClickCapture={(e) => { if (movedRef.current) { e.preventDefault(); e.stopPropagation(); } }}
            className={cn(
                "office-scene @container relative overflow-hidden rounded-xl bg-[radial-gradient(ellipse_at_50%_35%,#10213a_0%,#070d18_60%,#04070e_100%)] outline-none focus-visible:ring-2 focus-visible:ring-cyan-400/60 [touch-action:pan-y] md:[touch-action:none]",
                dragging ? "cursor-grabbing" : "cursor-grab",
                (paused || reducedMotion) && "office-paused", lite && "office-lite",
            )}
            style={{ aspectRatio: `${vb.w} / ${vb.h}`, width: `min(100%, ${Math.round(MAX_SCENE_HEIGHT * aspect)}px)` }}
        >
            <div ref={worldRef} className="absolute inset-0" style={{ transformOrigin: "0 0" }}>
                <svg viewBox={`${vb.x} ${vb.y} ${vb.w} ${vb.h}`} className="absolute inset-0 h-full w-full select-none" role="img" aria-label={`Office floor with ${layout.agents.length} team member${layout.agents.length === 1 ? "" : "s"}`}>
                    <SceneDefs />

                    {/* walls */}
                    <Box gx={0} gy={-0.35} w={W} d={0.35} h={WALL_H} colors={{ top: "#1d2b45", left: "url(#office-wall-back)", right: "#0a1322" }} />
                    <Box gx={-0.35} gy={-0.35} w={0.35} d={D + 0.35} h={WALL_H} colors={{ top: "#1d2b45", left: "#0a1322", right: "url(#office-wall-left)" }} />
                    {Array.from({ length: Math.floor(W / 2) }, (_, i) => (i + 1) * 2).map((gx) => (
                        <line key={`bw${gx}`} x1={iso(gx, 0, 0).x} y1={iso(gx, 0, 0).y} x2={iso(gx, 0, WALL_H).x} y2={iso(gx, 0, WALL_H).y} stroke="#1e3a5f" strokeOpacity={0.35} />
                    ))}
                    {Array.from({ length: Math.floor(D / 2) }, (_, i) => (i + 1) * 2).map((gy) => (
                        <line key={`lw${gy}`} x1={iso(0, gy, 0).x} y1={iso(0, gy, 0).y} x2={iso(0, gy, WALL_H).x} y2={iso(0, gy, WALL_H).y} stroke="#1e3a5f" strokeOpacity={0.35} />
                    ))}
                    <polyline points={pts(iso(0, D, 5), iso(0, 0, 5), iso(W, 0, 5))} fill="none" stroke="#22d3ee" strokeOpacity={0.45} strokeWidth={2} className="office-neon-cyan" />
                    <polyline points={pts(iso(0, D, WALL_H - 6), iso(0, 0, WALL_H - 6), iso(W, 0, WALL_H - 6))} fill="none" stroke="#a78bfa" strokeOpacity={0.25} strokeWidth={1.5} />

                    {backZones.map((z) => <WallSign key={z.meta.id} zone={z} axis="x" at={iso(z.gx + 1.4, 0, 146)} />)}
                    {backZones.filter((z) => z.w >= 10).map((z) => <WallBoard key={`wb-${z.meta.id}`} at={iso(z.gx + z.w - 3.4, 0, 132)} seed={hashString(z.meta.id)} />)}
                    {leftZones.map((z) => <WallSign key={z.meta.id} zone={z} axis="y" at={iso(0, z.gy + z.d - 0.8, 146)} />)}
                    <LogoWall at={iso(0, firstRowDepth + 0.4, 150)} span={firstRowDepth - 0.6} />

                    {/* floor */}
                    <polygon points={pts(iso(0, D, 0), iso(W, D, 0), iso(W, D, -16), iso(0, D, -16))} fill="#0a1322" />
                    <polygon points={pts(iso(W, 0, 0), iso(W, D, 0), iso(W, D, -16), iso(W, 0, -16))} fill="#060c17" />
                    <polygon points={pts(iso(0, 0), iso(W, 0), iso(W, D), iso(0, D))} fill="url(#office-floor)" />
                    <path d={floorGrid(W, D)} stroke="#94a3b8" strokeOpacity={0.055} strokeWidth={1} fill="none" />
                    <polyline points={pts(iso(0, D, 0), iso(W, D, 0), iso(W, 0, 0))} fill="none" stroke="#38bdf8" strokeOpacity={0.3} strokeWidth={1.5} />
                    {layout.zones.map((z) => (
                        <polygon key={`zf-${z.meta.id}`} points={pts(iso(z.gx, z.gy), iso(z.gx + z.w, z.gy), iso(z.gx + z.w, z.gy + z.d), iso(z.gx, z.gy + z.d))}
                            fill={z.meta.id === "lounge" ? "hsl(28 45% 40% / 0.16)" : `hsl(${z.meta.hue} 60% 50% / 0.06)`}
                            stroke={`hsl(${z.meta.hue} 85% 65% / 0.22)`} strokeWidth={1.2} />
                    ))}

                    {/* pools of light under each team */}
                    {layout.zones.map((z) => (
                        <ellipse key={`lp-${z.meta.id}`} cx={iso(z.gx + z.w / 2, z.gy + z.d / 2).x} cy={iso(z.gx + z.w / 2, z.gy + z.d / 2).y}
                            rx={(z.w + z.d) * 13} ry={(z.w + z.d) * 6.5} fill={`url(#office-pool-${z.meta.id === "lounge" ? "warm" : "cool"})`} />
                    ))}
                    {layout.zones.filter((z) => z.desks.length > 0).map((z) => {
                        const x0 = z.desks[0].gx + 0.2, y0 = z.desks[0].gy + 0.3;
                        const x1 = z.desks[z.desks.length - 1].gx + 3.8, y1 = z.desks[z.desks.length - 1].gy + 3.3;
                        return <polygon key={`rug-${z.meta.id}`} points={pts(iso(x0, y0), iso(x1, y0), iso(x1, y1), iso(x0, y1))} fill={`hsl(${z.meta.hue} 55% 45% / 0.07)`} stroke={`hsl(${z.meta.hue} 80% 65% / 0.12)`} strokeDasharray="4 6" />;
                    })}

                    {nodes.map((n) => <g key={n.key}>{n.el}</g>)}

                    {/* collaboration paths */}
                    {links.map((link, i) => <LinkPath key={link.id} link={link} id={`${uid}-link-${i}`} reducedMotion={reducedMotion} dim={!isActive(link.from) && !isActive(link.to)} />)}
                </svg>

                {/* Floating labels are HTML so they stay sharp and readable at any scale. */}
                {layout.agents.map((agent) => (
                    <AgentLabel key={agent.member.key} agent={agent} mode={layout.labelMode} position={pct({ x: agent.anchor.x, y: agent.anchor.y - (lifts.get(agent.member.key) ?? 0) })}
                        selected={agent.member.key === selectedKey} hovered={agent.member.key === hoveredKey} active={isActive(agent)}
                        onSelect={onSelect} onHover={onHover} />
                ))}
                {layout.zones.filter((z) => z.overflow.length > 0).map((z) => (
                    <button key={`ov-${z.meta.id}`} type="button" onClick={() => onOverflow(z.meta.id)}
                        style={pct(iso(z.gx + z.w / 2, z.gy + z.d - 0.5, 0))}
                        className="absolute z-20 -translate-x-1/2 -translate-y-1/2 inline-flex items-center gap-1 rounded-full border border-white/15 bg-[#0b1426]/85 px-2.5 py-1 text-[11px] font-semibold text-slate-100 shadow-lg shadow-black/40 backdrop-blur-md transition hover:border-cyan-300/60 hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cyan-300">
                        <IconPlus className="h-3 w-3" />{z.overflow.length} more in {z.meta.label}
                    </button>
                ))}
            </div>

            {/* Camera controls sit outside the transformed world so they stay fixed. */}
            <div className="absolute right-3 top-3 z-30 flex flex-col gap-1">
                <CameraButton label="Zoom in" onClick={() => zoomBy(1.2)}><IconZoomIn className="h-4 w-4" /></CameraButton>
                <CameraButton label="Zoom out" onClick={() => zoomBy(1 / 1.2)}><IconZoomOut className="h-4 w-4" /></CameraButton>
                <CameraButton label="Fit all" onClick={fitAll}><IconArrowsMaximize className="h-4 w-4" /></CameraButton>
            </div>

            {emptyState && <div className="absolute inset-0 z-30 grid place-items-center p-6">{emptyState}</div>}
        </div>
    );
}

function CameraButton({ label, onClick, children }: { label: string; onClick: () => void; children: ReactNode }) {
    return (
        <button type="button" aria-label={label} title={label} onClick={onClick}
            className="grid h-11 w-11 place-items-center rounded-lg border border-white/15 bg-[#0b1426]/85 text-slate-200 shadow-lg shadow-black/40 backdrop-blur-md transition hover:border-cyan-300/60 hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cyan-300">
            {children}
        </button>
    );
}

/* ── pieces ─────────────────────────────────────────────────────────── */

function SceneDefs() {
    return (
        <defs>
            <linearGradient id="office-screen" x1="0" y1="0" x2="1" y2="1">
                <stop offset="0" stopColor="#22d3ee" />
                <stop offset="1" stopColor="#2563eb" />
            </linearGradient>
            <linearGradient id="office-screen-amber" x1="0" y1="0" x2="1" y2="1">
                <stop offset="0" stopColor="#fbbf24" />
                <stop offset="1" stopColor="#ea580c" />
            </linearGradient>
            <linearGradient id="office-wall-back" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0" stopColor="#0b1526" />
                <stop offset="1" stopColor="#13233b" />
            </linearGradient>
            <linearGradient id="office-wall-left" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0" stopColor="#0d192c" />
                <stop offset="1" stopColor="#172a45" />
            </linearGradient>
            <radialGradient id="office-pool-cool">
                <stop offset="0" stopColor="#38bdf8" stopOpacity={0.10} />
                <stop offset="1" stopColor="#38bdf8" stopOpacity={0} />
            </radialGradient>
            <radialGradient id="office-pool-warm">
                <stop offset="0" stopColor="#f59e0b" stopOpacity={0.10} />
                <stop offset="1" stopColor="#f59e0b" stopOpacity={0} />
            </radialGradient>
            <radialGradient id="office-floor" cx="0.5" cy="0.45" r="0.7">
                <stop offset="0" stopColor="#15253d" />
                <stop offset="1" stopColor="#0c1628" />
            </radialGradient>
        </defs>
    );
}

function floorGrid(W: number, D: number): string {
    const parts: string[] = [];
    for (let gx = 1; gx < W; gx++) {
        const a = iso(gx, 0), b = iso(gx, D);
        parts.push(`M${a.x} ${a.y}L${b.x} ${b.y}`);
    }
    for (let gy = 1; gy < D; gy++) {
        const a = iso(0, gy), b = iso(W, gy);
        parts.push(`M${a.x} ${a.y}L${b.x} ${b.y}`);
    }
    return parts.join("");
}

function SignPlate({ zone }: { zone: ZoneLayout }) {
    const text = zone.meta.sign;
    const width = text.length * 13.5 + 26;
    const color = `hsl(${zone.meta.hue} 95% 68%)`;
    return (
        <g>
            <rect x={0} y={0} width={width} height={32} rx={5} fill="#060b16" fillOpacity={0.82} stroke={color} strokeOpacity={0.55} strokeWidth={1.5} style={{ filter: `drop-shadow(0 0 6px ${color})` }} />
            <text x={13} y={22} fill={color} fontSize={17} letterSpacing={1.5} style={{ fontFamily: "var(--font-silkscreen), monospace", filter: `drop-shadow(0 0 4px ${color})` }}>{text}</text>
        </g>
    );
}

function WallSign({ zone, axis, at }: { zone: ZoneLayout; axis: "x" | "y"; at: { x: number; y: number } }) {
    return <PlaneGroup at={at} axis={axis}><SignPlate zone={zone} /></PlaneGroup>;
}

function Partition({ zone }: { zone: ZoneLayout }) {
    const gy = zone.gy + 0.15;
    return (
        <g>
            <Box gx={zone.gx + 0.4} gy={gy} w={zone.w - 0.8} d={0.16} h={26} colors={{ top: "#2a3c5c", left: "#14243c", right: "#0d1a2e" }} />
            <polyline points={pts(iso(zone.gx + 0.4, gy + 0.16, 26), iso(zone.gx + zone.w - 0.4, gy + 0.16, 26))} stroke={`hsl(${zone.meta.hue} 90% 65%)`} strokeOpacity={0.5} strokeWidth={1.5} />
            {/* In the lounge the counter stands in front of the left end, so the sign moves right. */}
            <PlaneGroup at={iso(zone.gx + (zone.meta.id === "lounge" ? 5.4 : 0.8), gy + 0.16, 62)} axis="x"><SignPlate zone={zone} /></PlaneGroup>
        </g>
    );
}

function WallBoard({ at, seed }: { at: { x: number; y: number }; seed: number }) {
    const notes = ["#fde68a", "#a5f3fc", "#f9a8d4", "#bbf7d0", "#c4b5fd"];
    return (
        <PlaneGroup at={at} axis="x">
            <rect x={0} y={0} width={78} height={44} rx={3} fill="#0b1220" stroke="#334155" />
            {Array.from({ length: 9 }, (_, i) => (
                <rect key={i} x={6 + (i % 3) * 24} y={6 + Math.floor(i / 3) * 12.5} width={18} height={9} rx={1.5} fill={notes[(seed + i) % notes.length]} opacity={(seed >> i) & 1 ? 0.85 : 0.35} />
            ))}
        </PlaneGroup>
    );
}

function LogoWall({ at, span }: { at: { x: number; y: number }; span: number }) {
    const width = Math.min(250, span * 32);
    return (
        <PlaneGroup at={at} axis="y">
            <rect x={0} y={0} width={width} height={86} rx={6} fill="#060b16" fillOpacity={0.6} stroke="#22d3ee" strokeOpacity={0.25} />
            <g transform="translate(18 16)" style={{ filter: "drop-shadow(0 0 6px #22d3ee)" }}>
                <path d="M 14 0 L 28 14 L 14 28 L 0 14 Z" fill="none" stroke="#22d3ee" strokeWidth={2.5} />
                <path d="M 14 7 L 21 14 L 14 21 L 7 14 Z" fill="#22d3ee" />
            </g>
            <text x={56} y={34} fill="#67e8f9" fontSize={19} letterSpacing={2} style={{ fontFamily: "var(--font-silkscreen), monospace", filter: "drop-shadow(0 0 5px #22d3ee)" }}>EMPEROR</text>
            <text x={56} y={56} fill="#c4b5fd" fontSize={19} letterSpacing={2} style={{ fontFamily: "var(--font-silkscreen), monospace", filter: "drop-shadow(0 0 5px #a78bfa)" }}>CLAW</text>
            <text x={18} y={76} fill="#94a3b8" fontSize={8.5} letterSpacing={1.6} style={{ fontFamily: "var(--font-silkscreen), monospace" }}>AGENTS WORK · PEOPLE ACHIEVE</text>
        </PlaneGroup>
    );
}

function zoneDecorNodes(zone: ZoneLayout): Node[] {
    const seed = hashString(zone.meta.id);
    const out: Node[] = [];
    const front = zone.gy + zone.d - 0.7;
    out.push({ row: zone.row, depth: zone.gx + 0.7 + front, key: `pl1-${zone.meta.id}`, el: <Plant gx={zone.gx + 0.7} gy={front} hue={140 + (seed % 30)} /> });
    out.push({ row: zone.row, depth: zone.gx + zone.w - 0.7 + front, key: `pl2-${zone.meta.id}`, el: <Plant gx={zone.gx + zone.w - 0.7} gy={front} scale={0.8} hue={150} /> });
    if (zone.signWall !== "partition") {
        // Bookcase against the wall, past the sign.
        const gx = zone.gx + zone.w - 2.2;
        const gy = zone.signWall === "back" ? 0.05 : zone.gy + 0.25;
        out.push({ row: zone.row, depth: gx + gy + 0.5, key: `sh-${zone.meta.id}`, el: <Shelf gx={gx} gy={gy} seed={seed} /> });
    }
    return out;
}

interface CharacterHandlers {
    selectedKey: string | null;
    hoveredKey: string | null;
    isActive: (agent: PlacedAgent) => boolean;
    onSelect: (key: string) => void;
    onHover: (key: string | null) => void;
    onCenter: (agent: PlacedAgent) => void;
    talkingKeys: Set<string>;
    lite: boolean;
    reducedMotion: boolean;
}

function loungeNodes(zone: ZoneLayout, agentsByKey: Map<string, PlacedAgent>, h: CharacterHandlers): Node[] {
    const { gx, gy, w, d, row } = zone;
    const sofaGx = gx + w - 4.0;
    const out: Node[] = [];
    const add = (depth: number, key: string, el: ReactNode) => out.push({ row, depth, key: `lg-${key}`, el });
    add(gx + gy, "rug", <polygon points={pts(iso(gx + 4.4, gy + 2.3), iso(gx + w - 0.5, gy + 2.3), iso(gx + w - 0.5, gy + 7.4), iso(gx + 4.4, gy + 7.4))} fill="#3b2a4d" fillOpacity={0.55} stroke="#a78bfa" strokeOpacity={0.25} />);
    add(gx + gy + 1.5, "counter", <CoffeeCounter gx={gx + 0.6} gy={gy + 0.4} />);
    add(gx + w - 1 + gy + 1.4, "lamp", <FloorLamp gx={gx + w - 1} gy={gy + 1.4} />);
    add(sofaGx + gy + 2.8, "sofa", <SofaBack gx={sofaGx} gy={gy + 2.8} d={3.2} />);
    add(sofaGx + 1 + gy + 6, "sofa-arm", <SofaArm gx={sofaGx} gy={gy + 6.0} />);
    add(gx + w - 1.3 + gy + 4.4, "table", <RoundTable gx={gx + w - 1.3} gy={gy + 4.4} />);
    add(gx + 0.8 + gy + d - 1, "plant-a", <Plant gx={gx + 0.8} gy={gy + d - 1} />);
    add(gx + w - 0.8 + gy + d - 0.8, "plant-b", <Plant gx={gx + w - 0.8} gy={gy + d - 0.8} scale={0.9} hue={160} />);
    for (const seat of zone.seats) {
        const agent = seat.occupant ? agentsByKey.get(seat.occupant.member.key) : undefined;
        if (!agent) continue;
        add(seat.gx + seat.gy + 0.01, `seat-${agent.member.key}`, (
            <g opacity={h.isActive(agent) ? 1 : 0.32} className="transition-opacity duration-300">
                <SceneCharacter agent={agent} selected={agent.member.key === h.selectedKey} hovered={agent.member.key === h.hoveredKey} onSelect={h.onSelect} onHover={h.onHover} onCenter={h.onCenter} talking={h.talkingKeys.has(agent.member.key)} lite={h.lite} reducedMotion={h.reducedMotion} />
            </g>
        ));
    }
    return out;
}

function MeetingCorner({ cell }: { cell: { gx: number; gy: number; w: number; d: number } }) {
    // A huddle table for the gap an uneven zone count leaves on the floor.
    const tx = cell.gx + cell.w / 2 - 1.6;
    const ty = cell.gy + cell.d / 2 - 0.9;
    const chair = { top: "#334155", left: "#1e293b", right: "#172033" };
    return (
        <g>
            <polygon points={pts(iso(tx - 1.2, ty - 1.4), iso(tx + 4.4, ty - 1.4), iso(tx + 4.4, ty + 3.2), iso(tx - 1.2, ty + 3.2))} fill="#1e3a5f" fillOpacity={0.3} stroke="#38bdf8" strokeOpacity={0.15} />
            {[0.3, 1.5, 2.7].map((dx) => <Box key={`c${dx}`} gx={tx + dx} gy={ty - 0.75} w={0.6} d={0.5} h={16} colors={chair} />)}
            <Box gx={tx} gy={ty} w={3.2} d={1.8} h={22} colors={{ top: "#7a5034", left: "#6a4530", right: "#4c3020" }} />
            <Box gx={tx - 0.05} gy={ty - 0.05} z={22} w={3.3} d={1.9} h={4} colors={{ top: "#a8744a", left: "#7a5034", right: "#5e3c26", edge: "#c48c5c" }} />
            <Box gx={tx + 0.6} gy={ty + 0.6} z={26} w={0.8} d={0.55} h={2} colors={{ top: "#cbd5e1", left: "#94a3b8", right: "#64748b" }} />
            {[0.3, 1.5, 2.7].map((dx) => <Box key={`f${dx}`} gx={tx + dx} gy={ty + 2.05} w={0.6} d={0.5} h={16} colors={chair} />)}
            <Plant gx={cell.gx + cell.w - 0.9} gy={cell.gy + 1.2} scale={0.9} />
            <Plant gx={cell.gx + 0.9} gy={cell.gy + cell.d - 0.9} />
        </g>
    );
}

/** Bodies stay still; the eyes carry the state. */
function expressionFor(kind: SceneActivity): CharacterExpression {
    switch (kind) {
        case "typing": case "writing": case "presenting": case "thinking": return "focused";
        case "reviewing": return "scanning";
        case "talking": case "celebrate": case "coffee": case "stretch": return "happy";
        case "waiting": case "blocked": return "worried";
        case "nap": case "offline": return "sleepy";
        default: return "neutral";
    }
}

function SceneCharacter({ agent, selected, hovered, onSelect, onHover, onCenter, talking, lite, reducedMotion }: {
    agent: PlacedAgent;
    selected: boolean;
    hovered: boolean;
    onSelect: (key: string) => void;
    onHover: (key: string | null) => void;
    onCenter: (agent: PlacedAgent) => void;
    talking: boolean;
    lite: boolean;
    reducedMotion: boolean;
}) {
    const z = agent.pose === "sofa" ? 12 : 0;
    const at = iso(agent.gx, agent.gy, z);
    const appearance = resolveAppearance({ id: agent.member.id, avatarUrl: agent.member.avatarUrl, avatarAppearance: agent.member.avatarAppearance });
    const mood = moodForStatus(agent.status);
    const behavior = agent.behavior;
    const kind: SceneActivity = talking && /huddle|discuss|meeting|collaborat/i.test(agent.member.activity ?? "") ? "talking" : behavior.kind;
    const motion = agentMotion(agent.member.id);
    const glow = selected ? "drop-shadow(0 0 7px #22d3ee) drop-shadow(0 0 2px #a5f3fc)" : hovered ? "drop-shadow(0 0 5px rgba(165,243,252,0.7))" : undefined;

    const vars = {
        "--bob-d": `${motion.bob.delay}ms`, "--bob-t": `${motion.bob.duration}ms`,
        "--blink-d": `${motion.blink.delay}ms`, "--blink-t": `${motion.blink.duration}ms`,
        "--antenna-d": `${motion.antenna.delay}ms`, "--antenna-t": `${motion.antenna.duration}ms`,
        "--chest-d": `${motion.chest.delay}ms`, "--chest-t": `${motion.chest.duration}ms`,
        "--cue-d": `${motion.cue.delay}ms`, "--cue-t": `${motion.cue.duration}ms`,
        "--typing-d": `${motion.typing.delay}ms`, "--typing-t": `${motion.typing.duration}ms`,
        "--screen-d": `${motion.screen.delay}ms`, "--screen-t": `${motion.screen.duration}ms`,
        "--routine-d": `${motion.routine.delay}ms`, "--routine-t": `${motion.routine.duration}ms`,
        "--celebrate-d": `${motion.celebrate.delay}ms`, "--celebrate-t": `${motion.celebrate.duration}ms`,
        "--wave-d": `${motion.wave.delay}ms`, "--wave-t": `${motion.wave.duration}ms`,
    } as CSSProperties;

    return (
        <g className="cursor-pointer" onClick={() => onSelect(agent.member.key)} onDoubleClick={() => onCenter(agent)}
            onMouseEnter={() => onHover(agent.member.key)} onMouseLeave={() => onHover(null)}>
            {selected && <FloorEllipse gx={agent.gx} gy={agent.gy} z={z} r={0.85} fill="#22d3ee" opacity={0.18} stroke="#67e8f9" strokeWidth={1.5} className="office-ring" />}
            <g transform={`translate(${at.x.toFixed(1)} ${at.y.toFixed(1)})`}>
                <g style={vars}>
                    <g style={{ filter: glow }} className="transition-[filter] duration-200">
                        <g transform={`scale(${CHARACTER_SCALE})`}>
                            <CharacterFigureView appearance={appearance} mood={mood} expression={reducedMotion && kind === "reviewing" ? "neutral" : expressionFor(kind)} seated={agent.pose !== "standing"} salt={agent.member.id.slice(0, 6)} />
                            <ActivityCue activity={kind} hue={appearance.hue} lite={lite} reducedMotion={reducedMotion} variant={behavior.variant} />
                        </g>
                    </g>
                </g>
            </g>
        </g>
    );
}

function LinkPath({ link, id, reducedMotion, dim }: { link: CollaborationLink; id: string; reducedMotion: boolean; dim: boolean }) {
    const head = (a: PlacedAgent) => iso(a.gx, a.gy, (a.pose === "sofa" ? 12 : 0) + 34 * CHARACTER_SCALE);
    const a = head(link.from);
    const b = head(link.to);
    const d = arcPath(a, b);
    const color = link.kind === "review" ? "#a78bfa" : "#22d3ee";
    // Quadratic midpoint, for the static document when motion is reduced.
    const lift = Math.min(90, Math.hypot(b.x - a.x, b.y - a.y) * 0.22);
    const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 - lift / 2 };
    return (
        <g opacity={dim ? 0.25 : 1} className="pointer-events-none transition-opacity duration-300">
            <title>{`${link.from.member.name} → ${link.to.member.name}: ${link.taskTitle}`}</title>
            <path d={d} fill="none" stroke={color} strokeOpacity={0.22} strokeWidth={7} strokeLinecap="round" style={{ filter: `blur(3px)` }} />
            <path id={id} d={d} fill="none" stroke={color} strokeWidth={2.2} strokeDasharray="7 7" strokeLinecap="round" className="office-dash" style={{ filter: `drop-shadow(0 0 3px ${color})` }} />
            <circle cx={a.x} cy={a.y} r={3} fill={color} />
            <circle cx={b.x} cy={b.y} r={3} fill={color} />
            <g transform={reducedMotion ? `translate(${mid.x} ${mid.y})` : undefined}>
                <g style={{ filter: `drop-shadow(0 0 5px ${color})` }}>
                    <path d="M -7 -9 L 4 -9 L 7 -6 L 7 9 L -7 9 Z" fill="#f8fafc" />
                    <path d="M 4 -9 L 4 -6 L 7 -6" fill="#cbd5e1" />
                    <rect x={-4} y={-3} width={8} height={1.4} fill={color} />
                    <rect x={-4} y={1} width={8} height={1.4} fill="#94a3b8" />
                    <rect x={-4} y={4.6} width={5} height={1.4} fill="#94a3b8" />
                </g>
                {!reducedMotion && (
                    <animateMotion dur="1.8s" repeatCount="1" fill="freeze" rotate="0" keyPoints="0;1" keyTimes="0;1" calcMode="linear">
                        <mpath href={`#${id}`} />
                    </animateMotion>
                )}
            </g>
        </g>
    );
}

function AgentLabel({ agent, mode, position, selected, hovered, active, onSelect, onHover }: {
    agent: PlacedAgent;
    mode: OfficeLayout["labelMode"];
    position: { left: string; top: string };
    selected: boolean;
    hovered: boolean;
    active: boolean;
    onSelect: (key: string) => void;
    onHover: (key: string | null) => void;
}) {
    const blocked = Boolean(agent.notices?.some((entry) => requiresHumanAction(entry)));
    const expanded = selected || hovered;
    const showName = mode !== "dot" || expanded || blocked;
    const showActivity = mode === "full" || expanded;
    return (
        <button type="button"
            onClick={() => onSelect(agent.member.key)}
            onMouseEnter={() => onHover(agent.member.key)}
            onMouseLeave={() => onHover(null)}
            onFocus={() => onHover(agent.member.key)}
            onBlur={() => onHover(null)}
            aria-pressed={selected}
            aria-label={`${agent.member.name}: ${agent.behavior.caption}`}
            style={position}
            className={cn(
                "absolute -translate-x-1/2 -translate-y-full text-left transition-[opacity,transform,border-color,box-shadow] duration-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cyan-300",
                expanded ? "z-20" : blocked ? "z-10" : "z-0",
                active ? "opacity-100" : "opacity-35",
                showName
                    ? cn("min-h-11 max-w-[12.5rem] rounded-lg border bg-[#0a1324]/80 px-2.5 py-1.5 shadow-[0_10px_30px_-10px_rgba(0,0,0,0.8)] backdrop-blur-md",
                        selected ? "border-cyan-300/70 shadow-[0_0_0_1px_rgba(103,232,249,0.25),0_10px_30px_-8px_rgba(34,211,238,0.45)]" : "border-white/12 hover:border-white/25")
                    : "grid h-11 w-11 place-items-center rounded-full border border-white/20 bg-[#0a1324]/80",
            )}>
            {showName ? (
                <>
                    <span className="flex items-center gap-1.5">
                        <span className={cn("h-2 w-2 shrink-0 rounded-full", agent.status === "working" && "office-dot-pulse")} style={{ background: STATUS_COLOR[agent.status] }} />
                        <AgentAvatar id={agent.member.id} kind={agent.member.kind} name={agent.member.name} avatarUrl={agent.member.avatarUrl} avatarAppearance={agent.member.avatarAppearance} size={24} />
                        <span className="truncate text-[12px] font-semibold leading-4 text-slate-50">{agent.member.name}</span>
                    </span>
                    {showActivity && <span className="mt-0.5 block truncate text-[11px] leading-4 text-slate-300">{agent.behavior.caption}</span>}
                    {blocked && (
                        <span aria-hidden className="office-alert absolute -right-2 -top-2 grid h-[18px] w-[18px] place-items-center rounded-full bg-amber-400 text-[11px] font-black text-amber-950 shadow-[0_0_10px_rgba(251,191,36,0.8)]">!</span>
                    )}
                </>
            ) : (
                <span className="h-2 w-2 rounded-full" style={{ background: STATUS_COLOR[agent.status] }} />
            )}
            {/* small tail pointing at the character */}
            {showName && <span aria-hidden className="absolute left-1/2 top-full h-2 w-px -translate-x-1/2 bg-gradient-to-b from-white/30 to-transparent" />}
        </button>
    );
}

export function SceneEmptyState() {
    return (
        <div className="max-w-sm rounded-2xl border border-white/10 bg-[#0a1324]/85 p-6 text-center shadow-2xl shadow-black/50 backdrop-blur-md">
            <div className="text-base font-semibold text-slate-50">Your office is ready</div>
            <p className="mt-1.5 text-sm text-slate-300">Hire an agent and it takes a desk here. You will see what it works on, live.</p>
            <Link href="/agents" className="mt-4 inline-flex min-h-9 items-center gap-1.5 rounded-lg bg-cyan-400 px-4 text-sm font-semibold text-cyan-950 transition hover:bg-cyan-300 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cyan-200">
                <IconPlus className="h-4 w-4" />Hire your first agent
            </Link>
        </div>
    );
}
