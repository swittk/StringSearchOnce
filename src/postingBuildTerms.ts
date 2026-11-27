import { postingNameKey, type PostingName } from './postingFormat';
import { caseSensitivePostingPrefix, lowercasePostingText, appendPostingGrams } from './postingText';

const symbolCharacter = /^\p{S}$/u;

function addNameTerms(terms: Set<string>, kind: string, text: string): void {
  terms.add(postingNameKey(kind, text));
  for (const token of text.split(/\s+/u)) if (token) terms.add('w|' + token);
  const chars = Array.from(text);
  appendPostingGrams(terms, chars, 2);
  appendPostingGrams(terms, chars, 3);
  for (const char of chars) if (symbolCharacter.test(char)) terms.add('g1|' + char);
}

/** Shared by both builders so each source contributes an ordinal only once per key. */
export function collectPostingTerms(names: readonly PostingName[], kinds: ReadonlySet<string>): Set<string> {
  const terms = new Set<string>();
  for (const name of names) {
    if (!kinds.has(name.kind)) throw new Error('POSTING_UNKNOWN_NAME_KIND');
    const lower = lowercasePostingText(name.text.normalize('NFC'));
    const composed = lower.normalize('NFC');
    const text = composed.trim();
    if (!text) continue;
    addNameTerms(terms, name.kind, text);
    if (lower !== composed) {
      // Keep only the extra keys needed to nominate case-sensitive matches.
      const additional = new Set<string>();
      addNameTerms(additional, name.kind, lower.trim());
      for (const term of additional)
        if (!terms.has(term)) terms.add(caseSensitivePostingPrefix + term);
    }
  }
  return terms;
}
