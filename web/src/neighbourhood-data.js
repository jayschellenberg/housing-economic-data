// Pure helpers for the Neighbourhood (Experimental) tab: narrative blocks →
// editable sections, saved edits laid over the generated text, and the
// plain-text / Word shapes. No DOM, so it is unit-tested directly.

export const NOTES_HEADING = 'Appraiser notes (to complete)';

/** Narrative blocks → [{ heading, text }]; bullets join as "• " lines. */
export function sectionsOf(blocks = []) {
  const out = [];
  let cur = null;
  for (const b of blocks) {
    if (b.type === 'heading') { cur = { heading: b.text, text: '' }; out.push(cur); continue; }
    if (!cur || (b.type !== 'para' && b.type !== 'bullet')) continue;
    const line = b.type === 'bullet' ? `• ${b.text}` : b.text;
    cur.text = cur.text ? `${cur.text}${b.type === 'bullet' ? '\n' : '\n\n'}${line}` : line;
  }
  return out.filter(s => s.text);
}

/**
 * Generated sections with a saved edit laid over them. Each section gets
 * `edited` (text differs from generated) and `stale` (the generated text has
 * changed since the edit was made, so the edit may need another look).
 */
export function applyEdit(sections, edit) {
  return sections.map(s => {
    const mine = edit?.sections?.[s.heading];
    if (mine == null || mine === s.text) return { ...s, generated: s.text, edited: false, stale: false };
    const base = edit.base?.[s.heading];
    return { heading: s.heading, text: mine, generated: s.text, edited: true, stale: base != null && base !== s.text };
  });
}

/** 'generated' | 'edited' | 'stale' for the whole write-up. */
export function editStatus(applied) {
  if (applied.some(s => s.stale)) return 'stale';
  return applied.some(s => s.edited) ? 'edited' : 'generated';
}

/** The edit record to save: only sections that differ from the generated text. */
export function editRecord(id, name, applied, currentText, by = '') {
  const sections = {}; const base = {};
  applied.forEach((s, i) => {
    const t = String(currentText[i] ?? '').replace(/\r\n/g, '\n').trim();
    if (t && t !== s.generated) { sections[s.heading] = t; base[s.heading] = s.generated; }
  });
  return Object.keys(sections).length ? { id, name, sections, base, by: String(by || '').trim() } : null;
}

/** Copy-ready text: heading line, then its text, blank line between. */
export function plainText(title, sections) {
  return [title, ...sections.map(s => `${s.heading}\n${s.text}`)].filter(Boolean).join('\n\n');
}

/** Word-export blocks (word-export.js has no bullet type: "•" lines stay paras). */
export function wordBlocks(title, sections, { notes = true } = {}) {
  const blocks = [{ type: 'heading', text: title }];
  for (const s of sections) {
    if (!notes && s.heading === NOTES_HEADING) continue;
    blocks.push({ type: 'heading', text: s.heading });
    for (const p of s.text.split(/\n+/).map(t => t.trim()).filter(Boolean)) blocks.push({ type: 'para', text: p });
  }
  return blocks;
}

/** Areas for the first drop-down, grouped: Winnipeg clusters, then municipalities. */
export function areaGroups(data) {
  const groups = data?.groups || [];
  return [
    { label: 'Winnipeg — neighbourhood clusters', areas: groups.filter(g => g.kind === 'wpg') },
    { label: 'Manitoba municipalities', areas: groups.filter(g => g.kind !== 'wpg') },
  ].filter(g => g.areas.length);
}
