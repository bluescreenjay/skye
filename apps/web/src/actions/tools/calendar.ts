// Looking at the owner's calendar. The result is shown to the owner once, in the click's own response, and is never
// stored, never given to the AI, and never used by another tool (spec FR-051, the same rule as mail).
import { CALENDAR_RESULTS_MAX, CALENDAR_TITLE_CHARS } from "../limits";
import { badInput } from "../errors";
import { bindingFor } from "../integrations/bindings";
import { getConnector } from "../integrations/connector";
import { EventInputError } from "../integrations/calendar-time";
import type { ToolExecuteContext, ToolExecuteResult } from "../registry";

export interface CalendarEventRow {
  title: string;
  start: string;
  end: string;
  allDay: boolean;
}

export async function executeCalendarList(ctx: ToolExecuteContext): Promise<ToolExecuteResult & { calendar?: CalendarEventRow[] }> {
  let mapped: Record<string, unknown>;
  try {
    mapped = bindingFor("calendar_list_events")!.toArguments(ctx.args, "");
  } catch (error) {
    if (error instanceof EventInputError) throw badInput(error.message);
    throw error;
  }
  const answer = await getConnector().call("calendar_list_events", mapped, ctx.signal);
  const calendar = (answer.events ?? []).slice(0, CALENDAR_RESULTS_MAX).map((event) => ({
    title: event.title.slice(0, CALENDAR_TITLE_CHARS),
    start: event.start,
    end: event.end,
    allDay: event.allDay,
  }));
  return { result: { kind: "calendar_events", shown: calendar.length }, calendar };
}
