import { useId } from 'react';
import type { Scene, SceneObject } from '@vizli/shared';
import type { Camera } from './useBoardCamera';

export function isNearCamera(object: {x:number;y:number;width:number;height:number}, camera: Camera, viewportHeight = 675) {
  const margin = 200 / camera.zoom;
  return object.x + object.width >= camera.x - margin && object.x <= camera.x + 1200 / camera.zoom + margin && object.y + object.height >= camera.y - margin && object.y <= camera.y + viewportHeight / camera.zoom + margin;
}
export default function BoardBackdrop({ scene, camera, objects, animatedTarget, viewportHeight = 675 }: {scene:Scene;camera:Camera;objects:SceneObject[];animatedTarget?:string;viewportHeight?:number}) {
  const arrow = `board-arrow-${useId().replace(/:/g, '')}`;
  const x = (value:number) => (value - camera.x) * camera.zoom;
  const y = (value:number) => (value - camera.y) * camera.zoom;
  const objectMap = new Map(objects.map(object => [object.id, object]));
  return <svg className="viz-board-backdrop" viewBox={`0 0 1200 ${viewportHeight}`} style={{ height: viewportHeight }} aria-hidden="true">
    <defs><marker id={arrow} viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M 0 0 L 10 5 L 0 10 z" fill="#789581" /></marker></defs>
    {(scene.areas ?? []).filter(area => isNearCamera(area, camera, viewportHeight)).map(area => <g key={area.id} data-area-id={area.id}>
      <rect x={x(area.x)} y={y(area.y)} width={area.width * camera.zoom} height={area.height * camera.zoom} rx="8" fill={area.id === scene.activeAreaId ? '#eef4e329' : 'none'} stroke={area.id === scene.activeAreaId ? '#a9bd96' : '#c7d4bd'} strokeDasharray="7 7" />
      <text x={x(area.x) + 14} y={y(area.y) + 25} className="viz-board-area-label">{area.label}</text>
    </g>)}
    {scene.connections.map(edge => {
      const source = objectMap.get(edge.source), target = objectMap.get(edge.target);
      if (!source || !target || source.hidden || target.hidden) return null;
      const sx = source.x + source.width, sy = source.y + source.height / 2;
      const tx = target.x, ty = target.y + target.height / 2;
      const region = {x: Math.min(sx,tx), y: Math.min(sy,ty), width: Math.abs(tx-sx), height: Math.abs(ty-sy)};
      if (!isNearCamera(region,camera,viewportHeight)) return null;
      const mid = (x(sx) + x(tx)) / 2;
      const d = `M ${x(sx)} ${y(sy)} C ${mid} ${y(sy)}, ${mid} ${y(ty)}, ${x(tx)} ${y(ty)}`;
      return <g key={edge.id} data-connection-id={edge.id}><path d={d} fill="none" stroke="#789581" strokeWidth="2" markerEnd={`url(#${arrow})`} className={animatedTarget && (source.id === animatedTarget || target.id === animatedTarget) ? 'viz-board-edge-animated' : ''} />{edge.label && <text x={mid} y={(y(sy)+y(ty))/2-10} textAnchor="middle" className="viz-board-edge-label">{edge.label}</text>}</g>;
    })}
  </svg>;
}
