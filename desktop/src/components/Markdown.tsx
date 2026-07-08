import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import styles from './Markdown.module.css';

interface MarkdownProps {
  children: string;
  /** Optional extra class on the wrapper for local variants. */
  className?: string;
}

/**
 * Renders agent / LLM Markdown as formatted, theme-styled content.
 *
 * The analysts and portfolio manager emit Markdown (headings, bold, lists,
 * tables, rules); rendering it as plain text showed the raw syntax. react-
 * markdown builds a React element tree and does NOT inject raw HTML (we do not
 * enable rehype-raw), so it is XSS-safe for model output by default. GFM adds
 * tables / strikethrough / task lists. Links open in the external browser.
 */
function Markdown({ children, className }: MarkdownProps) {
  return (
    <div className={`${styles.markdown} ${className ?? ''}`.trim()}>
      <ReactMarkdown
        // singleTilde:false — the analysts write "~$53.50" / "~45%" to mean
        // "approximately". With GFM's default single-tilde strikethrough, a
        // pair of those tildes on a line renders everything between them struck
        // out. Requiring a double tilde (~~) keeps "approximately" literal.
        remarkPlugins={[[remarkGfm, { singleTilde: false }]]}
        components={{
          a(props) {
            return (
              <a href={props.href} target="_blank" rel="noreferrer noopener">
                {props.children}
              </a>
            );
          },
        }}
      >
        {children}
      </ReactMarkdown>
    </div>
  );
}

export default Markdown;
