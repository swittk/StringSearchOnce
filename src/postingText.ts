// Additional case-sensitive lookup keys sort after the regular terms.
export const caseSensitivePostingPrefix = 'x|';

/** Lowercase NFC input without composing across substring boundaries. */
export function lowercasePostingText(nfcText: string): string {
  // Lowercasing capital sigma depends on word position; search keys use one form.
  const lower = nfcText.toLowerCase();
  return lower.includes('ς') ? lower.replaceAll('ς', 'σ') : lower;
}

/** Append into the caller's existing set while preserving first-occurrence order. */
export function appendPostingGrams(values: Set<string>, chars: readonly string[], width: number): void {
  if (width === 2) {
    for (let index = 0; index + 1 < chars.length; index++)
      values.add('g2|' + chars[index]! + chars[index + 1]!);
  } else if (width === 3) {
    for (let index = 0; index + 2 < chars.length; index++)
      values.add('g3|' + chars[index]! + chars[index + 1]! + chars[index + 2]!);
  } else {
    for (let index = 0; index + width <= chars.length; index++)
      values.add('g' + width + '|' + chars.slice(index, index + width).join(''));
  }
}
