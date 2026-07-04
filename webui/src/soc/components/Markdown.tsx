/**
 * Markdown — a tiny, dependency-free, HTML-injection-safe renderer.
 *
 * Supports **bold**, `code`, bullet lists (`- ` / `* `), numbered lists
 * (`1.` / `1)`), and paragraph breaks. EVERYTHING is a React node — there is no HTML
 * string anywhere, so even untrusted content can never inject live markup. Shared by
 * the chat transcript and the case Timeline reasoning step.
 */
import * as React from 'react';

/**
 * Parse a SINGLE line into React nodes with light inline markdown: `code` spans first
 * (so their contents are not further formatted), then **bold**.
 */
function renderInline(text: string, keyBase: string): React.ReactNode[] {
  const nodes: React.ReactNode[] = [];
  const codeParts = text.split(/`([^`]+)`/g);
  codeParts.forEach((part, i) => {
    if (i % 2 === 1) {
      nodes.push(
        <code
          key={`${keyBase}-c${i}`}
          className="rounded border border-border bg-muted px-1 py-0.5 font-mono text-xs text-foreground"
        >
          {part}
        </code>,
      );
      return;
    }
    const boldParts = part.split(/\*\*([^*]+)\*\*/g);
    boldParts.forEach((bp, j) => {
      if (!bp) return;
      if (j % 2 === 1) {
        nodes.push(
          <strong key={`${keyBase}-b${i}-${j}`} className="font-semibold text-foreground">
            {bp}
          </strong>,
        );
      } else {
        nodes.push(<React.Fragment key={`${keyBase}-t${i}-${j}`}>{bp}</React.Fragment>);
      }
    });
  });
  return nodes;
}

export const Markdown: React.FC<{ text: string; className?: string }> = ({ text, className }) => {
  const blocks: React.ReactNode[] = [];
  const lines = text.split('\n');
  let buf: string[] = [];
  let listType: 'ul' | 'ol' | null = null;

  const flush = (key: string) => {
    if (!buf.length) return;
    const items = buf;
    const t = listType;
    buf = [];
    listType = null;
    const Tag = t === 'ol' ? 'ol' : 'ul';
    blocks.push(
      <Tag key={key} className={t === 'ol' ? 'my-1 list-decimal space-y-0.5 pl-5' : 'my-1 list-disc space-y-0.5 pl-5'}>
        {items.map((li, i) => (
          <li key={i}>{renderInline(li, `${key}-${i}`)}</li>
        ))}
      </Tag>,
    );
  };

  lines.forEach((line, idx) => {
    const ol = /^\s*\d+[.)]\s+(.*)$/.exec(line);
    const ul = /^\s*[-*]\s+(.*)$/.exec(line);
    if (ol) {
      if (listType && listType !== 'ol') flush(`l-${idx}`);
      listType = 'ol';
      buf.push(ol[1]);
      return;
    }
    if (ul) {
      if (listType && listType !== 'ul') flush(`l-${idx}`);
      listType = 'ul';
      buf.push(ul[1]);
      return;
    }
    flush(`l-${idx}`);
    if (line.trim() === '') {
      blocks.push(<div key={`sp-${idx}`} className="h-2" aria-hidden />);
    } else {
      blocks.push(
        <p key={`p-${idx}`} className="leading-relaxed">
          {renderInline(line, `p-${idx}`)}
        </p>,
      );
    }
  });
  flush('l-end');

  return <div className={className ?? 'space-y-0.5 text-md'}>{blocks}</div>;
};

export default Markdown;
