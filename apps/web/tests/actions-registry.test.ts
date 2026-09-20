import { describe, expect, it } from "vitest";
import { allTools, getTool, HELPER_IDS } from "@/src/actions/registry";

describe("action tool registry", () => {
  it("contains every catalog tool with a schema and effect class", () => {
    const ids = allTools().map((tool) => tool.id);
    expect(ids).toEqual([
      "list_workspace_tabs",
      "read_public_pages",
      "write_summary",
      "export_summary_markdown",
      "export_summary_pdf",
      "open_related_tabs",
      "open_google_searches",
      "save_search_queries",
      "append_plan_items",
      "save_refs",
      "copy_text",
      "compose_share_link",
      "github_create_issue",
      "github_create_gist",
      "github_search",
      "github_comment_on_issue",
      "jira_create_issue",
      "jira_search",
      "jira_add_comment",
      "notion_create_page",
      "notion_append_blocks",
      "notion_search",
      "slack_post_message",
      "slack_upload_snippet",
      "drive_upload_markdown",
      "drive_create_doc_from_summary",
      "drive_get_share_link",
      "gmail_create_draft",
      "gmail_send_message",
      "gmail_search_messages",
    ]);
    expect(ids).toHaveLength(30);
    for (const tool of allTools()) {
      expect(tool.inputSchema.type).toBe("object");
      expect(tool.inputSchema.additionalProperties).toBe(false);
      expect(["read", "write", "send"]).toContain(tool.effect);
      expect(typeof tool.description).toBe("string");
      expect(tool.description.length).toBeGreaterThan(8);
    }
  });

  it("pins the helper set to the five read-only tools", () => {
    expect([...HELPER_IDS]).toEqual([
      "list_workspace_tabs",
      "read_public_pages",
      "github_search",
      "jira_search",
      "notion_search",
    ]);
    for (const id of HELPER_IDS) {
      const tool = getTool(id);
      expect(tool?.helper).toBe(true);
      expect(tool?.effect).toBe("read");
    }
    expect(getTool("gmail_search_messages")?.helper).toBe(false);
    expect(allTools().filter((tool) => tool.helper).map((tool) => tool.id)).toEqual([...HELPER_IDS]);
  });

  it("has no computer-use or mouse-control tools", () => {
    for (const tool of allTools()) {
      expect(tool.id).not.toMatch(/computer|mouse/i);
      expect(tool.description).not.toMatch(/computer-use|mouse/i);
    }
  });

  it("flags Drive and Gmail as owner-only", () => {
    for (const id of [
      "drive_upload_markdown",
      "drive_create_doc_from_summary",
      "drive_get_share_link",
      "gmail_create_draft",
      "gmail_send_message",
      "gmail_search_messages",
    ]) {
      expect(getTool(id)?.ownerOnly).toBe(true);
    }
    expect(getTool("github_create_issue")?.ownerOnly).toBe(false);
  });

  it("marks opened addresses and the send recipient as visible/prefill-only", () => {
    expect(getTool("open_related_tabs")?.argFlags.urls).toMatchObject({ visible: true, prefillOnly: true });
    expect(getTool("gmail_send_message")?.argFlags.to).toMatchObject({ visible: true, prefillOnly: true });
  });
});
