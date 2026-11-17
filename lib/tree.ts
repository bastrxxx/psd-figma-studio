import type { Layer } from './types';

export function childrenOf(layers: Layer[], parentId: string | null): Layer[] {
  return layers.filter((l) => l.parentId === parentId).sort((a, b) => a.position - b.position);
}

export function descendantIds(layers: Layer[], id: string): Set<string> {
  const out = new Set<string>();
  const stack = [id];
  while (stack.length) {
    const cur = stack.pop()!;
    for (const l of layers) if (l.parentId === cur && !out.has(l.id)) { out.add(l.id); stack.push(l.id); }
  }
  return out;
}

export function ancestorIds(layers: Layer[], id: string): string[] {
  const byId = new Map(layers.map((l) => [l.id, l]));
  const out: string[] = [];
  let cur = byId.get(id)?.parentId ?? null;
  while (cur) { out.push(cur); cur = byId.get(cur)?.parentId ?? null; }
  return out;
}

/** Re-number positions inside every parent so they are 0..n-1 */
export function normalize(layers: Layer[]): Layer[] {
  const groups = new Map<string | null, Layer[]>();
  for (const l of layers) {
    const k = l.parentId;
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k)!.push(l);
  }
  const out: Layer[] = [];
  for (const list of groups.values()) {
    list.sort((a, b) => a.position - b.position).forEach((l, i) => out.push(l.position === i ? l : { ...l, position: i }));
  }
  return out;
}

/** Global render order, bottom → top (depth-first). */
export function renderOrder(layers: Layer[]): Layer[] {
  const out: Layer[] = [];
  const visit = (pid: string | null) => {
    for (const c of childrenOf(layers, pid)) { out.push(c); if (c.kind === 'group') visit(c.id); }
  };
  visit(null);
  return out;
}

/** Remove ids whose ancestor is also in the set. */
export function topMostSelection(layers: Layer[], ids: string[]): string[] {
  const set = new Set(ids);
  return ids.filter((id) => !ancestorIds(layers, id).some((a) => set.has(a)));
}

export type DropWhere = 'above' | 'below' | 'inside';

/**
 * Move `ids` relative to `targetId`. "above" = visually above in the panel = higher position.
 */
export function moveLayers(layers: Layer[], ids: string[], targetId: string | null, where: DropWhere): Layer[] {
  const moving = topMostSelection(layers, ids).filter((id) => id !== targetId);
  if (!moving.length) return layers;
  const target = layers.find((l) => l.id === targetId);
  // Forbid dropping a group into itself / its descendants
  if (target) {
    for (const id of moving) {
      if (descendantIds(layers, id).has(target.id)) return layers;
    }
  }
  const movingSet = new Set(moving);
  // keep panel order of moved items (top → bottom)
  const order = renderOrder(layers).map((l) => l.id);
  const movedSorted = [...moving].sort((a, b) => order.indexOf(a) - order.indexOf(b)); // bottom → top

  let parentId: string | null;
  let siblings: Layer[];
  let insertIndex: number;
  if (!target) {
    parentId = null;
    siblings = childrenOf(layers, null).filter((l) => !movingSet.has(l.id));
    insertIndex = siblings.length;
  } else if (where === 'inside' && target.kind === 'group') {
    parentId = target.id;
    siblings = childrenOf(layers, parentId).filter((l) => !movingSet.has(l.id));
    insertIndex = siblings.length; // top of the group
  } else {
    parentId = target.parentId;
    siblings = childrenOf(layers, parentId).filter((l) => !movingSet.has(l.id));
    const ti = siblings.findIndex((l) => l.id === target.id);
    insertIndex = where === 'above' ? ti + 1 : ti;
  }
  const byId = new Map(layers.map((l) => [l.id, l]));
  const newSiblings = [...siblings];
  newSiblings.splice(insertIndex, 0, ...movedSorted.map((id) => byId.get(id)!));
  const updates = new Map<string, Layer>();
  newSiblings.forEach((l, i) => updates.set(l.id, { ...l, parentId, position: i }));
  const result = layers.map((l) => updates.get(l.id) ?? l);
  return normalize(result);
}

export function deleteLayers(layers: Layer[], ids: string[]): Layer[] {
  const remove = new Set<string>();
  for (const id of ids) { remove.add(id); descendantIds(layers, id).forEach((d) => remove.add(d)); }
  return normalize(layers.filter((l) => !remove.has(l.id)));
}

export function newId(prefix = 'm') {
  return `${prefix}${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;
}
