// Minimal safe markdown renderer for reports/briefs/plans.
// Escapes ALL html first, then applies markdown transforms — output is safe to v-html.

function escapeHtml(s) {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function inline(s) {
  return s
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/(^|[^*])\*([^*\n]+)\*(?!\*)/g, '$1<em>$2</em>')
    .replace(/\[([^\]]+)\]\((https?:[^)\s]+)\)/g,
      '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>');
}

export function renderMarkdown(text) {
  if (!text) return '';
  const src = escapeHtml(String(text).replace(/\r\n/g, '\n'));
  const lines = src.split('\n');
  const out = [];
  let i = 0;

  const listStack = []; // 'ul' | 'ol'
  const closeLists = (depth = 0) => {
    while (listStack.length > depth) out.push(`</${listStack.pop()}>`);
  };

  while (i < lines.length) {
    const line = lines[i];

    // fenced code block
    const fence = line.match(/^```(\w*)\s*$/);
    if (fence) {
      closeLists();
      const buf = [];
      i++;
      while (i < lines.length && !/^```\s*$/.test(lines[i])) { buf.push(lines[i]); i++; }
      i++; // skip closing fence
      out.push(`<pre><code>${buf.join('\n')}</code></pre>`);
      continue;
    }

    // heading
    const h = line.match(/^(#{1,4})\s+(.*)$/);
    if (h) {
      closeLists();
      const lvl = h[1].length;
      out.push(`<h${lvl}>${inline(h[2])}</h${lvl}>`);
      i++;
      continue;
    }

    // horizontal rule
    if (/^\s*([-*_])\s*\1\s*\1[\s\-*_]*$/.test(line)) {
      closeLists();
      out.push('<hr>');
      i++;
      continue;
    }

    // table (header row + separator row)
    if (line.includes('|') && i + 1 < lines.length && /^\s*\|?[\s:|-]+\|[\s:|-]*$/.test(lines[i + 1])) {
      closeLists();
      const cells = (row) => row.replace(/^\s*\|/, '').replace(/\|\s*$/, '').split('|').map((c) => inline(c.trim()));
      const head = cells(line);
      i += 2;
      const rows = [];
      while (i < lines.length && lines[i].includes('|')) { rows.push(cells(lines[i])); i++; }
      out.push('<table><thead><tr>' + head.map((c) => `<th>${c}</th>`).join('') + '</tr></thead><tbody>' +
        rows.map((r) => '<tr>' + r.map((c) => `<td>${c}</td>`).join('') + '</tr>').join('') + '</tbody></table>');
      continue;
    }

    // blockquote
    const bq = line.match(/^&gt;\s?(.*)$/);
    if (bq) {
      closeLists();
      const buf = [bq[1]];
      i++;
      while (i < lines.length) {
        const m = lines[i].match(/^&gt;\s?(.*)$/);
        if (!m) break;
        buf.push(m[1]);
        i++;
      }
      out.push(`<blockquote>${inline(buf.join(' '))}</blockquote>`);
      continue;
    }

    // list item (one nesting level per 2 spaces, max 3 deep)
    const li = line.match(/^(\s*)([-*+]|\d+[.)])\s+(.*)$/);
    if (li) {
      const depth = Math.min(3, Math.floor(li[1].length / 2)) + 1;
      const type = /^\d/.test(li[2]) ? 'ol' : 'ul';
      while (listStack.length > depth) out.push(`</${listStack.pop()}>`);
      while (listStack.length < depth) { out.push(`<${type}>`); listStack.push(type); }
      // checkbox items
      const task = li[3].match(/^\[([ xX])\]\s+(.*)$/);
      const body = task
        ? `<input type="checkbox" disabled${task[1] !== ' ' ? ' checked' : ''}> ${inline(task[2])}`
        : inline(li[3]);
      out.push(`<li>${body}</li>`);
      i++;
      continue;
    }

    // blank line
    if (!line.trim()) {
      closeLists();
      i++;
      continue;
    }

    // paragraph (merge consecutive plain lines)
    closeLists();
    const buf = [line];
    i++;
    while (i < lines.length && lines[i].trim() &&
      !/^(#{1,4}\s|```|\s*([-*+]|\d+[.)])\s|&gt;)/.test(lines[i]) && !lines[i].includes('|')) {
      buf.push(lines[i]);
      i++;
    }
    out.push(`<p>${inline(buf.join(' '))}</p>`);
  }

  closeLists();
  return out.join('\n');
}
