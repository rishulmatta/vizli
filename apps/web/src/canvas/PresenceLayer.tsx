import { useSyncExternalStore } from "react";
import type { Scene } from "@vizli/shared";
import type { PeerStore } from "../collab/useCollabDoc";
import type { Camera } from "./useBoardCamera";

export type PresenceMode = "all" | "presenter-only" | "none";

type Props = {
  scene: Scene;
  store: PeerStore;
  presenceMode: PresenceMode;
  isBoard: boolean;
  camera: Camera;
  viewportHeight: number;
};

/**
 * Remote collaborators on the current scene: cursor arrow with a name chip and a selection outline.
 * Cursors arrive in scene coordinates (slide logical px, whiteboard world px) and are projected with the
 * same transform as ink. Selection geometry comes from scene objects (no DOM measuring). Never captures input.
 */
export default function PresenceLayer({ scene, store, presenceMode, isBoard, camera, viewportHeight }: Props) {
  const peers = useSyncExternalStore(store.subscribe, store.getPeers);
  if (presenceMode === "none") return null;
  const visible = peers.filter((p) => p.sceneId === scene.id && (presenceMode === "all" || p.mode === "presenting"));
  const zoom = isBoard ? camera.zoom : 1;
  const project = (x: number, y: number) => (isBoard ? { x: (x - camera.x) * zoom, y: (y - camera.y) * zoom } : { x, y });
  return (
    <svg className="viz-presence-layer" data-testid="presence-layer" viewBox={`0 0 1200 ${viewportHeight}`} aria-hidden="true">
      {presenceMode === "all" && (
        <g transform={isBoard ? `translate(${-camera.x * camera.zoom} ${-camera.y * camera.zoom}) scale(${camera.zoom})` : undefined}>
          {visible.map((peer) => {
            const object = peer.selectedId ? scene.objects.find((o) => o.id === peer.selectedId) : undefined;
            if (!object) return null;
            return (
              <rect
                key={`sel-${peer.clientId}`}
                data-peer-selection={peer.clientId}
                x={object.x - 4}
                y={object.y - 4}
                width={object.width + 8}
                height={object.height + 8}
                rx={6}
                fill="none"
                stroke={peer.color}
                strokeWidth={2 / zoom}
                strokeDasharray={`${6 / zoom} ${3 / zoom}`}
              />
            );
          })}
        </g>
      )}
      {visible.map((peer) => {
        if (!peer.cursor) return null;
        const at = project(peer.cursor.x, peer.cursor.y);
        return (
          <g key={`cur-${peer.clientId}`} data-peer-cursor={peer.clientId} transform={`translate(${at.x} ${at.y})`}>
            <path d="M0 0 L0 17 L4.5 13 L8 20 L11 18.6 L7.6 11.8 L13 11.8 Z" fill={peer.color} stroke="#fffef9" strokeWidth="1.2" strokeLinejoin="round" />
            <g transform="translate(12 18)">
              <rect width={Math.min(160, peer.name.length * 7 + 14)} height="18" rx="9" fill={peer.color} />
              <text x="7" y="12.5" fontSize="11" fontWeight="600" fill="#fffef9" data-peer-name={peer.clientId}>{peer.name}</text>
            </g>
          </g>
        );
      })}
    </svg>
  );
}
