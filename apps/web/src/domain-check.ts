// Compile-time proof that the web app consumes the shared domain model
// instead of redeclaring it.
import type { TabEvent, TabRef, Workspace } from "@ai-browser/shared";

export type DomainCheck = {
  workspace: Workspace;
  tab: TabRef;
  event: TabEvent;
};
