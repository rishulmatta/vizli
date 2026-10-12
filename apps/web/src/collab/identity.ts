/**
 * Local collaborator identity. `userId`, `name` and `color` persist per browser
 * (`localStorage['vizli.identity.v1']`); `clientId` is per tab (`sessionStorage['vizli.client.v1']`).
 * Nothing here is authenticated: it only labels presence and edits.
 */
export type Identity = { userId: string; name: string; color: string; clientId: string };

const IDENTITY_KEY = 'vizli.identity.v1';
const CLIENT_KEY = 'vizli.client.v1';
export const PEER_COLORS = ['#d2432f', '#2f6c56', '#3b5bdb', '#b7791f', '#8e44ad', '#0f8b8d', '#c2185b', '#5d6d1e'] as const;
const ADJECTIVES = ['Amber', 'Brisk', 'Calm', 'Daring', 'Eager', 'Gentle', 'Lucky', 'Quiet', 'Swift', 'Witty', 'Bright', 'Merry'];
const ANIMALS = ['Otter', 'Heron', 'Fox', 'Lynx', 'Panda', 'Robin', 'Seal', 'Wren', 'Badger', 'Koala', 'Falcon', 'Moose'];
const ID = /^[a-zA-Z0-9_-]{1,120}$/;
const COLOR = /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/;

const newId = (prefix: string) => `${prefix}-${crypto.randomUUID().replace(/-/g, '').slice(0, 20)}`;
const pick = <T,>(items: readonly T[]) => items[Math.floor(Math.random() * items.length)]!;
const guestName = () => `Guest ${pick(ADJECTIVES)} ${pick(ANIMALS)}`;

export function colorFor(userId: string): string {
  let hash = 0;
  for (let i = 0; i < userId.length; i++) hash = (hash * 31 + userId.charCodeAt(i)) | 0;
  return PEER_COLORS[Math.abs(hash) % PEER_COLORS.length]!;
}

type Stored = { userId: string; name: string; color: string };
function readStored(): Stored | null {
  try {
    const raw = JSON.parse(localStorage.getItem(IDENTITY_KEY) ?? 'null');
    if (raw && typeof raw === 'object' && typeof raw.userId === 'string' && ID.test(raw.userId))
      return {
        userId: raw.userId,
        name: typeof raw.name === 'string' && raw.name.trim() ? raw.name.trim().slice(0, 80) : guestName(),
        color: typeof raw.color === 'string' && COLOR.test(raw.color) ? raw.color : colorFor(raw.userId),
      };
  } catch { /* fall through to a fresh identity */ }
  return null;
}
function writeStored(value: Stored) {
  try { localStorage.setItem(IDENTITY_KEY, JSON.stringify(value)); } catch { /* identity is best effort */ }
}
function clientId(): string {
  try {
    const existing = sessionStorage.getItem(CLIENT_KEY);
    if (existing && ID.test(existing)) return existing;
    const created = newId('c');
    sessionStorage.setItem(CLIENT_KEY, created);
    return created;
  } catch { return (memoryClient ??= newId('c')); }
}
let memoryClient: string | undefined;

export function getIdentity(): Identity {
  let stored = readStored();
  if (!stored) {
    const userId = newId('u');
    stored = { userId, name: guestName(), color: colorFor(userId) };
    writeStored(stored);
  }
  return { ...stored, clientId: clientId() };
}

/** Updates the persisted name/color. `userId` and `clientId` are not editable. */
export function saveIdentity(patch: Partial<Pick<Identity, 'name' | 'color'>>): Identity {
  const current = getIdentity();
  const next: Stored = {
    userId: current.userId,
    name: patch.name?.trim() ? patch.name.trim().slice(0, 80) : current.name,
    color: patch.color && COLOR.test(patch.color) ? patch.color : current.color,
  };
  writeStored(next);
  return { ...next, clientId: current.clientId };
}
