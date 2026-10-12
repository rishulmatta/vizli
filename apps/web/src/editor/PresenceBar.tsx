import { useEffect, useRef, useState } from "react";
import { Copy, Eye, EyeOff, FilePlus2, Link2 } from "lucide-react";
import type { CollabRole } from "@vizli/shared";
import type { CollabStatus, RosterPeer } from "../collab/useCollabDoc";
import { editLink, viewLink } from "../collab/access";

const MAX_AVATARS = 5;
const initials = (name: string) => {
  const words = name.replace(/^guest\s+/i, "").trim().split(/\s+/).filter(Boolean);
  const letters = words.length > 1 ? words[0][0] + words[1][0] : (words[0] ?? "?").slice(0, 2);
  return letters.toUpperCase();
};
export function statusLabel(status: CollabStatus, hasProject = true) {
  if (status === "live") return "Live";
  if (status === "offline") return "Offline";
  return hasProject ? "Connecting…" : "Opening…";
}

type Props = {
  status: CollabStatus;
  peers: RosterPeer[];
  me: { name: string; color: string };
  projectId: string;
  /** Server-assigned role; null until joined. Viewers get a "View only" pill and a "Make a copy" action. */
  role: CollabRole | null;
  followingId: string | null;
  onRename: (name: string) => void;
  onFollow: (clientId: string | null) => void;
  onFork: () => void;
};

/**
 * Compact roster for the floating header: peers, the local (renamable) user, a live/offline pill, the role,
 * share links and follow toggle. Editors can copy an edit link (grants edit rights to whoever opens it) or a
 * view link; viewers can copy the view link or make their own editable copy.
 */
export default function PresenceBar({ status, peers, me, projectId, role, followingId, onRename, onFollow, onFork }: Props) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(me.name);
  const [shared, setShared] = useState<string | null>(null);
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => { if (editing) input.current?.select(); }, [editing]);
  useEffect(() => {
    if (!shared) return;
    const t = setTimeout(() => setShared(null), 6000);
    return () => clearTimeout(t);
  }, [shared]);
  const presenter = peers.find((p) => p.mode === "presenting");
  const following = followingId !== null && peers.some((p) => p.clientId === followingId);
  const viewer = role === "viewer";
  const canShareEdit = !viewer && editLink(projectId) !== null;
  const save = () => {
    setEditing(false);
    if (draft.trim() && draft.trim() !== me.name) onRename(draft.trim());
  };
  const share = async (kind: "edit" | "view") => {
    const edit = kind === "edit" ? editLink(projectId) : null;
    const url = edit ?? viewLink(projectId);
    const label = edit ? "Edit link copied. Anyone who opens it can change this project." : "View link copied";
    try {
      await navigator.clipboard.writeText(url);
      setShared(label);
    } catch {
      setShared(url);
    }
  };
  const shown = peers.slice(0, MAX_AVATARS);
  const label = statusLabel(status);
  return (
    <div className="presence-bar" data-testid="presence-bar">
      <div className="presence-avatars">
        {shown.map((peer) => (
          <span key={peer.clientId} className={`presence-avatar ${peer.mode === "presenting" ? "is-presenting" : ""}`} data-testid="peer-avatar" data-peer-id={peer.clientId} title={peer.name} style={{ background: peer.color }}>
            {initials(peer.name)}
          </span>
        ))}
        {peers.length > MAX_AVATARS && <span className="presence-avatar presence-more" data-testid="peer-overflow">+{peers.length - MAX_AVATARS}</span>}
        {editing ? (
          <input ref={input} className="presence-name-input" data-testid="local-name-input" aria-label="Your name" value={draft} maxLength={80}
            onChange={(e) => setDraft(e.target.value)} onBlur={save}
            onKeyDown={(e) => { if (e.key === "Enter") save(); if (e.key === "Escape") { setDraft(me.name); setEditing(false); } }} />
        ) : (
          <button className="presence-avatar presence-me" data-testid="local-avatar" title={`${me.name} (you). Click to rename`} aria-label={`Your name: ${me.name}. Rename`} style={{ background: me.color }} onClick={() => { setDraft(me.name); setEditing(true); }}>
            {initials(me.name)}
          </button>
        )}
      </div>
      <span className="presence-count" data-testid="room-size" title="People in this project">{peers.length + 1}</span>
      <span className={`presence-status is-${status}`} data-testid="presence-status" aria-live="off">{label}</span>
      {viewer && (
        <span className="presence-role" data-testid="role-pill" title="You can follow this project but not change it. Make a copy to edit.">View only</span>
      )}
      {viewer && (
        <button className="presence-fork" data-testid="fork-project" title="Create your own editable copy of this project" onClick={onFork}>
          <FilePlus2 size={13} /><span>Make a copy</span>
        </button>
      )}
      {presenter && (
        <button className={`icon-button presence-follow ${following ? "active" : ""}`} data-testid="follow-presenter" aria-pressed={following} aria-label={following ? `Stop following ${presenter.name}` : `Follow ${presenter.name}`} title={following ? `Following ${presenter.name}. Click to stop` : `Follow ${presenter.name}`} onClick={() => onFollow(following ? null : presenter.clientId)}>
          {following ? <Eye size={15} /> : <EyeOff size={15} />}
        </button>
      )}
      <button className="icon-button presence-share" data-testid="share-link" aria-label={canShareEdit ? "Copy edit link" : "Copy view link"} title={canShareEdit ? "Copy edit link: anyone who opens it can change this project" : "Copy view link"} onClick={() => void share(canShareEdit ? "edit" : "view")}><Link2 size={15} /></button>
      {canShareEdit && (
        <button className="icon-button presence-share" data-testid="share-view-link" aria-label="Copy view-only link" title="Copy view-only link" onClick={() => void share("view")}><Copy size={14} /></button>
      )}
      {shared && <span className="presence-notice" data-testid="share-notice" aria-live="polite">{shared}</span>}
    </div>
  );
}
