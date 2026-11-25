// Additional case-sensitive lookup keys sort after the regular terms.
export const caseSensitivePostingPrefix = 'x|';

/** Lowercase NFC input without composing across substring boundaries. */
export function lowercasePostingText(nfcText: string): string {
  // Lowercasing capital sigma depends on word position; search keys use one form.
  const lower = nfcText.toLowerCase();
  return lower.includes('ς') ? lower.replaceAll('ς', 'σ') : lower;
}
