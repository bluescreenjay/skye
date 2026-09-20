import type { Binding } from "./github";

/** Notion rejects a rich_text longer than this, and more blocks than MAX_BLOCKS in one request. */
const MAX_TEXT = 2_000;
const MAX_BLOCKS = 100;

/** Splits one long line into pieces of at most MAX_TEXT characters, at a space when there is one. */
function pieces(line: string): string[] {
  const out: string[] = [];
  let rest = line;
  while (rest.length > MAX_TEXT) {
    const space = rest.lastIndexOf(" ", MAX_TEXT);
    const soft = space >= MAX_TEXT / 2;
    out.push(rest.slice(0, soft ? space : MAX_TEXT));
    rest = soft ? rest.slice(space + 1) : rest.slice(MAX_TEXT);
  }
  if (rest) out.push(rest);
  return out;
}

/** One paragraph per line; only when there are too many lines are short ones packed together. Nothing is dropped. */
function paragraphs(content: string): unknown[] {
  const lines = String(content).split(/\n+/).filter(Boolean).flatMap(pieces);
  let blocks = lines;
  if (lines.length > MAX_BLOCKS) {
    blocks = [];
    for (const line of lines) {
      const last = blocks.length - 1;
      if (last >= 0 && blocks[last].length + 1 + line.length <= MAX_TEXT) blocks[last] += `\n${line}`;
      else blocks.push(line);
    }
  }
  return blocks.map((text) => ({ type: "paragraph", paragraph: { rich_text: [{ type: "text", text: { content: text } }] } }));
}

export const NOTION_BINDINGS: Binding[] = [
  {
    toolId: "notion_create_page",
    integration: "notion",
    candidates: ["API-post-page", "create_page"],
    what: "page",
    toArguments: (args, dest) => ({
      parent: { page_id: dest },
      properties: { title: { title: [{ text: { content: args.title } }] } },
      children: paragraphs(String(args.content ?? "")),
    }),
  },
  {
    toolId: "notion_append_blocks",
    integration: "notion",
    candidates: ["API-patch-block-children", "append_blocks"],
    what: "blocks",
    toArguments: (args) => ({ block_id: args.page, children: paragraphs(String(args.content ?? "")) }),
  },
  {
    toolId: "notion_search",
    integration: "notion",
    candidates: ["API-post-search", "search"],
    what: "search",
    search: true,
    toArguments: (args) => ({ query: args.text }),
  },
];
