import type { Binding } from "./github";

export const DRIVE_BINDINGS: Binding[] = [
  {
    toolId: "drive_upload_markdown",
    integration: "drive",
    candidates: ["create_file", "drive_upload"],
    what: "file",
    toArguments: (args, dest) => ({
      name: args.filename ?? "summary.md",
      mimeType: "text/markdown",
      content: args.content,
      parents: [dest],
    }),
  },
  {
    toolId: "drive_create_doc_from_summary",
    integration: "drive",
    candidates: ["create_doc", "create_file"],
    what: "document",
    toArguments: (args, dest) => ({
      name: args.title ?? "Summary",
      mimeType: "application/vnd.google-apps.document",
      content: args.content,
      parents: [dest],
    }),
  },
  {
    toolId: "drive_get_share_link",
    integration: "drive",
    candidates: ["get_file", "get_file_metadata"],
    what: "link",
    toArguments: (args) => ({ fileId: args.file }),
  },
];

export const GMAIL_BINDINGS: Binding[] = [
  {
    toolId: "gmail_create_draft",
    integration: "gmail",
    candidates: ["create_draft"],
    what: "draft",
    toArguments: (args) => ({ to: args.to, subject: args.subject, body: args.body }),
  },
  {
    toolId: "gmail_send_message",
    integration: "gmail",
    candidates: ["send_message", "send_email"],
    what: "message",
    toArguments: (args) => ({ to: args.to, subject: args.subject, body: args.body }),
  },
  {
    toolId: "gmail_search_messages",
    integration: "gmail",
    candidates: ["search_messages", "search_threads"],
    what: "search",
    search: true,
    toArguments: (args) => ({ query: args.text, maxResults: 5 }),
  },
];
