import type { Binding } from "./github";

export const SLACK_BINDINGS: Binding[] = [
  {
    toolId: "slack_post_message",
    integration: "slack",
    candidates: ["conversations_add_message", "slack_post_message"],
    what: "message",
    toArguments: (args, dest) => ({ channel_id: dest, text: args.text }),
  },
  {
    toolId: "slack_upload_snippet",
    integration: "slack",
    candidates: ["files_upload", "slack_upload_snippet"],
    what: "snippet",
    toArguments: (args, dest) => ({ channels: dest, filename: args.filename, content: args.content, title: args.title ?? "" }),
  },
];
