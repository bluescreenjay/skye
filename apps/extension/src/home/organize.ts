export type OrganizeStatus = "idle" | "running" | "failed" | "empty";

export interface OrganizeOutcome {
  status: OrganizeStatus;
  message: string;
  /** Reload workspaces + tab-refs when true (any HTTP 200). */
  shouldRefresh: boolean;
}

export interface ClusterRunBody {
  skipped?: boolean;
  applied?: unknown[];
  error?: string;
  code?: string;
}

/**
 * Map POST /api/cluster/runs HTTP results to Home copy.
 * Never invents workspace names or directory rows.
 */
export function mapClusterHttpResult(httpStatus: number, body: unknown): OrganizeOutcome {
  const parsed = (body && typeof body === "object" ? body : {}) as ClusterRunBody;

  if (httpStatus === 0) {
    return { status: "failed", message: "could not reach the server", shouldRefresh: false };
  }

  if (httpStatus === 200) {
    if (parsed.skipped === true) {
      return { status: "empty", message: "nothing to organize", shouldRefresh: true };
    }
    const applied = Array.isArray(parsed.applied) ? parsed.applied : [];
    if (applied.length === 0) {
      return { status: "empty", message: "nothing to organize", shouldRefresh: true };
    }
    return { status: "idle", message: "", shouldRefresh: true };
  }

  if (httpStatus === 401) {
    return { status: "failed", message: "pairing failed — check your device token", shouldRefresh: false };
  }

  if (httpStatus === 409 && parsed.code === "run_in_progress") {
    return { status: "failed", message: "already organizing", shouldRefresh: false };
  }

  if (httpStatus === 409) {
    return { status: "failed", message: "already organizing", shouldRefresh: false };
  }

  if (httpStatus === 429) {
    return { status: "failed", message: "organization budget used up — try later", shouldRefresh: false };
  }

  if (httpStatus === 502) {
    return { status: "failed", message: "organization service failed — try again", shouldRefresh: false };
  }

  if (httpStatus === 503) {
    return { status: "failed", message: "organization not configured on the server", shouldRefresh: false };
  }

  const detail =
    typeof parsed.error === "string" && parsed.error.trim()
      ? parsed.error.trim().toLowerCase()
      : "organization failed";
  return { status: "failed", message: detail.slice(0, 80), shouldRefresh: false };
}
