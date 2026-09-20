import { CALENDAR_WINDOW_DAYS } from "../../limits";
import { eventFromArgs, listWindow } from "../calendar-time";
import type { Binding } from "./github";

// Google's Calendar MCP server (https://calendarmcp.googleapis.com/mcp/v1): tools `create_event` and `list_events`,
// argument names from Google's tool reference. Two rules are enforced HERE and cannot be overridden by anything a
// button carries: no guests (`attendees`, `attendeeEmails`, Meet links, and recurrence are never sent, and
// notifications are forced to NONE), and only the owner's primary calendar (`calendarId` is never sent).
export const CALENDAR_BINDINGS: Binding[] = [
  {
    toolId: "calendar_create_event",
    integration: "calendar",
    candidates: ["create_event"],
    what: "event",
    toArguments: (args) => {
      const event = eventFromArgs(args);
      const out: Record<string, unknown> = {
        summary: event.title,
        startTime: event.start,
        endTime: event.end,
        allDay: event.allDay,
        notificationLevel: "NONE",
      };
      if (event.notes) out.description = event.notes;
      if (event.location) out.location = event.location;
      return out;
    },
  },
  {
    toolId: "calendar_list_events",
    integration: "calendar",
    candidates: ["list_events"],
    what: "calendar",
    search: true,
    toArguments: (args) => {
      const window = listWindow(args.day, CALENDAR_WINDOW_DAYS);
      return { startTime: window.start, endTime: window.end, pageSize: 10, orderBy: "startTime" };
    },
  },
];
