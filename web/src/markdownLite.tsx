import type { ReactNode } from 'react';

/**
 * Minimal chat-bubble markdown: bold, links, numbered/bulleted lists,
 * paragraphs. Builds React nodes directly instead of dangerouslySetInnerHTML,
 * so there's no raw HTML to sanitize — this only ever needs to render LLM
 * chat replies, not arbitrary user HTML.
 */
export function renderMarkdownLite(text: string): ReactNode {
  const lines = text.split('\n');
  const blocks: ReactNode[] = [];
  let i = 0;
  let key = 0;

  while (i < lines.length) {
    const line = lines[i];

    if (line.trim() === '') {
      i++;
      continue;
    }

    const isOrdered = /^\s*\d+\.\s+/.test(line);
    const isBulleted = /^\s*[-*]\s+/.test(line);

    if (isOrdered || isBulleted) {
      const marker = isOrdered ? /^\s*\d+\.\s+/ : /^\s*[-*]\s+/;
      const items: ReactNode[] = [];
      while (i < lines.length && marker.test(lines[i])) {
        items.push(<li key={key++}>{renderInline(lines[i].replace(marker, ''))}</li>);
        i++;
      }
      blocks.push(isOrdered ? <ol key={key++}>{items}</ol> : <ul key={key++}>{items}</ul>);
      continue;
    }

    const para: string[] = [];
    while (i < lines.length && lines[i].trim() !== '' && !/^\s*(\d+\.|[-*])\s+/.test(lines[i])) {
      para.push(lines[i]);
      i++;
    }
    blocks.push(
      <p key={key++}>
        {para.map((l, idx) => (
          <span key={idx}>
            {renderInline(l)}
            {idx < para.length - 1 && <br />}
          </span>
        ))}
      </p>,
    );
  }

  return <>{blocks}</>;
}

/** Bold (**text**) and links ([text](url)) within a single line. */
function renderInline(line: string): ReactNode[] {
  const nodes: ReactNode[] = [];
  const re = /\*\*(.+?)\*\*|\[(.+?)\]\((https?:\/\/[^\s)]+)\)/g;
  let last = 0;
  let key = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(line))) {
    if (m.index > last) nodes.push(line.slice(last, m.index));
    if (m[1] !== undefined) {
      nodes.push(<strong key={key++}>{m[1]}</strong>);
    } else {
      nodes.push(
        <a key={key++} href={m[3]} target="_blank" rel="noreferrer noopener">
          {m[2]}
        </a>,
      );
    }
    last = re.lastIndex;
  }
  if (last < line.length) nodes.push(line.slice(last));
  return nodes;
}
