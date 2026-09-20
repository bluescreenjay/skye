import type { Binding } from "./github";

function paragraphs(content: string): unknown[] {
  return String(content)
    .split(/\n+/)
    .filter(Boolean)
    .map((text) => ({ type: "paragraph", paragraph: { rich_text: [{ type: "text", text: { content: text } }] } }));
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
