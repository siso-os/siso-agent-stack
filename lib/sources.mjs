// The monorepo paths a component pinned to sisodias/siso needs at one commit: its monorepo_path and, for the
// Skills Hub, each registered skill's source_path outside the hub (Agent Zero keeps its own skills in
// agents/zero/.claude/skills). The installer checks these paths out, and `siso-stack release` pins the component to
// the newest main commit touching any of them. `read(path)` returns a file's text at that commit, or null.
export function monorepoPaths(component, read) {
  const paths = [component.monorepo_path];
  if (component.install !== 'skills-registry') return paths;
  const registry = read(`${component.monorepo_path}/registry/skills_registry.json`);
  if (!registry) return paths;
  const outside = JSON.parse(registry).skills.map((entry) => entry.source_path)
    .filter((path) => path && !`${path}/`.startsWith(`${component.monorepo_path}/`));
  return [...paths, ...[...new Set(outside)].sort()];
}
