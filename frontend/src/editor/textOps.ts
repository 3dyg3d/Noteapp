/**
 * Plain-text list editing for the note editor.
 *
 * The editor is a plain multiline TextInput, so it cannot render bold or
 * italic. The old Bold/Italic/Heading buttons appended literal `**bold**` to the
 * END of the note regardless of the cursor, which was worse than having no
 * button. These operations do what a plain-text editor CAN do well: lists,
 * applied to the lines the selection actually touches, plus continuation on
 * Enter.
 *
 * Everything here is a pure function of (text, selection) so it can be tested
 * without a device.
 */

export interface Sel {
  start: number;
  end: number;
}

export interface Edit {
  text: string;
  selection: Sel;
}

export const BULLET = '• ';
const NUMBERED = /^(\s*)(\d+)\. /;
const BULLETED = /^(\s*)• /;

/** [start, end) offsets of the lines touched by a selection. */
function lineSpan(text: string, sel: Sel): { from: number; to: number } {
  const from = text.lastIndexOf('\n', Math.max(0, sel.start - 1)) + 1;
  // A selection ending exactly at the start of a line doesn't touch that line.
  const endProbe = sel.end > sel.start && text[sel.end - 1] === '\n' ? sel.end - 1 : sel.end;
  const nl = text.indexOf('\n', endProbe);
  return { from: sel.start === 0 ? 0 : from, to: nl === -1 ? text.length : nl };
}

/**
 * Toggle a list style on every line the selection touches. If every touched
 * line already has that style it is removed; otherwise it is applied, replacing
 * the other list style where present. Numbered lists are renumbered from 1.
 */
export function toggleList(text: string, sel: Sel, kind: 'bullet' | 'numbered'): Edit {
  const { from, to } = lineSpan(text, sel);
  const lines = text.slice(from, to).split('\n');
  const has = kind === 'bullet' ? BULLETED : NUMBERED;
  // "Already a list" needs at least one real list line: otherwise an empty
  // line counted as already-formatted, and the button did nothing in an empty
  // note.
  const allHave =
    lines.some((l) => has.test(l)) && lines.every((l) => l.trim() === '' || has.test(l));

  let n = 0;
  const next = lines.map((l) => {
    const stripped = l.replace(BULLETED, '$1').replace(NUMBERED, '$1');
    if (allHave) return stripped;
    if (l.trim() === '' && lines.length > 1) return l; // leave blank lines alone in a block
    const indent = /^\s*/.exec(stripped)![0];
    const body = stripped.slice(indent.length);
    return kind === 'bullet' ? `${indent}${BULLET}${body}` : `${indent}${++n}. ${body}`;
  });

  const replaced = next.join('\n');
  const out = text.slice(0, from) + replaced + text.slice(to);
  const delta = replaced.length - (to - from);
  // Keep the caret on the same character it was on, shifted by the prefix.
  if (sel.start === sel.end) {
    const firstDelta = next[0].length - lines[0].length;
    const caret = Math.max(from, sel.start + firstDelta);
    return { text: out, selection: { start: caret, end: caret } };
  }
  return { text: out, selection: { start: from, end: to + delta } };
}

/**
 * Called on every edit. If the change was a single newline typed at the end of
 * a list line, continue the list; if it was typed on an EMPTY list item, end the
 * list instead (the usual behaviour in every notes app). Returns null when the
 * edit should be left exactly as typed.
 */
export function continueList(prev: string, next: string, caret: number): Edit | null {
  // Only a single inserted "\n".
  if (next.length !== prev.length + 1 || next[caret - 1] !== '\n') return null;
  if (next.slice(0, caret - 1) + next.slice(caret) !== prev) return null;

  const lineStart = next.lastIndexOf('\n', caret - 2) + 1;
  const line = next.slice(lineStart, caret - 1);

  const b = BULLETED.exec(line);
  const m = NUMBERED.exec(line);
  if (!b && !m) return null;

  const prefixLen = (b ?? m)![0].length;
  const isEmptyItem = line.slice(prefixLen).trim() === '';

  if (isEmptyItem) {
    // Remove the empty marker and the newline: Enter on "• " ends the list.
    const text = next.slice(0, lineStart) + next.slice(caret);
    return { text, selection: { start: lineStart, end: lineStart } };
  }

  const prefix = b ? `${b[1]}${BULLET}` : `${m![1]}${Number(m![2]) + 1}. `;
  const text = next.slice(0, caret) + prefix + next.slice(caret);
  const pos = caret + prefix.length;
  return { text, selection: { start: pos, end: pos } };
}
