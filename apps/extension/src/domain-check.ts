// Compile-time proof that the extension consumes the shared domain model
// instead of redeclaring it.
import type { TabEvent, TabRef, Workspace } from "@ai-browser/shared";

export type DomainCheck = {
  workspace: Workspace;
  tab: TabRef;
  event: TabEvent;
};
