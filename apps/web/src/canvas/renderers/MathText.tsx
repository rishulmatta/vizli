import { useMemo } from "react";
import katex from "katex";
import "katex/dist/katex.min.css";
export default function MathText({ text }: { text: string }) {
  const html = useMemo(() => {
    try {
      return katex.renderToString(text.replace(/^\$\$?|\$\$?$/g, ""), {
        throwOnError: false,
        trust: false,
        strict: "ignore",
      });
    } catch {
      return null;
    }
  }, [text]);
  return html ? (
    <span data-motion-item dangerouslySetInnerHTML={{ __html: html }} />
  ) : (
    <span>{text}</span>
  );
}
