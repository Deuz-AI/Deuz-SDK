/**
 * Fenced code blocks in the skill's Markdown, for the two gates. A fence whose
 * info string carries `no-verify` is a deliberate fragment (or another
 * library's code shown as the thing being replaced): both gates skip it.
 */

/**
 * Every fenced block of `text`: `{ info, lang, noVerify, line, code }`, where
 * `line` is the 1-based line of the first code line and `code` ends with a
 * newline when it has any lines. An unclosed fence runs to the end.
 */
export function parseFences(text) {
  const lines = text.split(/\r?\n/);
  const blocks = [];
  for (let i = 0; i < lines.length; i++) {
    const open = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(lines[i]);
    if (!open || (open[1][0] === '`' && open[2].includes('`'))) continue;
    const marker = open[1];
    const info = open[2].trim();
    const close = new RegExp(`^ {0,3}${marker[0] === '`' ? '`' : '~'}{${marker.length},}\\s*$`);
    let end = i + 1;
    while (end < lines.length && !close.test(lines[end])) end++;
    const body = lines.slice(i + 1, end);
    blocks.push({
      info,
      lang: info.split(/\s+/)[0] ?? '',
      noVerify: /(?:^|\s)no-verify(?:\s|$)/.test(info),
      line: i + 2,
      code: body.length > 0 ? `${body.join('\n')}\n` : '',
    });
    i = end;
  }
  return blocks;
}

/** `text` with the body of every no-verify fence blanked, line numbers kept. */
export function maskNoVerify(text) {
  const lines = text.split('\n');
  for (const block of parseFences(text)) {
    if (!block.noVerify) continue;
    const count = block.code === '' ? 0 : block.code.split('\n').length - 1;
    for (let line = block.line - 1; line < block.line - 1 + count; line++) lines[line] = '';
  }
  return lines.join('\n');
}
