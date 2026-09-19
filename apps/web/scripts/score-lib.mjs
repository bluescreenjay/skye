// The one SC-001 scoring function (specs/004-ai-clustering/spec.md): "at least 80% of
// the tabs are in the workspace a person hand-labeling them would choose, or in Other
// for the one-offs". The live test and the CLI both import this, so they cannot drift.
//
//   labels          { [url]: "trip" | "coding" | ... | null }   null = belongs in Other
//   ambiguous       urls that a person could go either way on; they are not scored
//   workspaceByUrl  { [url]: workspaceId | null }               what the run actually did
//
// Only URLs present in workspaceByUrl are scored, so one answer key serves both the
// 30-tab and the 50-tab fixture.
//
// A label is matched to the workspace most of its tabs ended up in, and a workspace
// can be claimed by only one label: merging two topics into one workspace must not
// count as getting both right.

export function scoreClusters(labels, ambiguous, workspaceByUrl) {
  const skip = new Set(ambiguous);
  const scored = Object.keys(labels).filter((url) => url in workspaceByUrl && !skip.has(url));

  // counts[label][workspaceId] = how many of that label's tabs are in that workspace
  const counts = new Map();
  for (const url of scored) {
    const label = labels[url];
    const workspace = workspaceByUrl[url];
    if (label === null || workspace === null) continue;
    if (!counts.has(label)) counts.set(label, new Map());
    const row = counts.get(label);
    row.set(workspace, (row.get(workspace) ?? 0) + 1);
  }

  // Greedy one-to-one matching, biggest overlaps first.
  const pairs = [];
  for (const [label, row] of counts) for (const [workspace, n] of row) pairs.push({ label, workspace, n });
  pairs.sort((a, b) => b.n - a.n);
  const expected = new Map(); // label -> workspaceId
  const claimed = new Set();
  for (const { label, workspace } of pairs) {
    if (expected.has(label) || claimed.has(workspace)) continue;
    expected.set(label, workspace);
    claimed.add(workspace);
  }

  const mismatches = [];
  let correct = 0;
  for (const url of scored) {
    const label = labels[url];
    const actual = workspaceByUrl[url];
    const want = label === null ? null : (expected.get(label) ?? null);
    const ok = label === null ? actual === null : want !== null && actual === want;
    if (ok) correct += 1;
    else mismatches.push({ url, label, expectedWorkspace: want, actualWorkspace: actual });
  }
  const total = scored.length;
  return { percent: total === 0 ? 0 : (100 * correct) / total, correct, total, mismatches };
}
