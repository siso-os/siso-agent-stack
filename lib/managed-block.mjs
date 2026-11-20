// The stack's block in an instruction file (a seat's CLAUDE.md, ~/.codex/AGENTS.md). The text outside the markers
// belongs to the file's owner (compose-brain, a person); the stack only ever replaces what sits between them.
export const BLOCK_BEGIN = '<!-- BEGIN SISO AGENT STACK -->';
export const BLOCK_END = '<!-- END SISO AGENT STACK -->';
const blockPattern = () => new RegExp(`${BLOCK_BEGIN}[\\s\\S]*?${BLOCK_END}\\n?`, 'g');

// `text` with exactly one stack block holding `block`, after the owner's text.
export function withManagedBlock(text, block) {
  const retained = text.replace(blockPattern(), '').trimEnd();
  return `${retained}${retained ? '\n\n' : ''}${BLOCK_BEGIN}\n${block.trim()}\n${BLOCK_END}\n`;
}

// The stack blocks in `text`, markers included.
export function managedBlocks(text) {
  return (text.match(blockPattern()) || []).map((block) => block.trimEnd());
}

// An owner's freshly generated text with the stack blocks of the file it replaces carried over, so regenerating the
// file never drops the stack's block (withManagedBlock on the result then changes nothing).
export function keepManagedBlocks(generated, previous) {
  const blocks = managedBlocks(previous);
  return blocks.length ? `${generated.trimEnd()}\n\n${blocks.join('\n\n')}\n` : generated;
}
