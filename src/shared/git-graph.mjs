// Real parent topology, with input/output lanes as in VSCode's SCM graph.
// Independent implementation; no VSCode runtime or source code is bundled.
export const GRAPH_ROW_HEIGHT = 24;
export const GRAPH_LANE_WIDTH = 12;
const GRAPH_MARGIN = 8;
const GRAPH_COLOR_COUNT = 6;
const MAX_GRAPH_LANES = 128;
/**
 * Commits must be topologically ordered, children before parents. SVG units are px.
 * @param {Array<{id: string, parentIds: string[]}>} commits
 * @param {string} head
 */
export function layoutGitGraph(commits, head) {
  let lanes = [],
    nextColor = 1,
    width = GRAPH_MARGIN * 2 + GRAPH_LANE_WIDTH;
  const pointX = (index) => GRAPH_MARGIN + index * GRAPH_LANE_WIDTH;
  const rows = [];
  for (const commit of commits) {
    const input = lanes;
    const inputIndex = input.findIndex((lane) => lane.id === commit.id);
    const index = inputIndex < 0 ? input.length : inputIndex;
    const color =
      commit.id === head
        ? 0
        : inputIndex >= 0
          ? input[inputIndex].color
          : nextColor++ % GRAPH_COLOR_COUNT;
    const output = input.filter((lane) => lane.id !== commit.id);
    const parents = commit.parentIds.map((id, parentIndex) => ({
      id,
      color: parentIndex === 0 ? color : nextColor++ % GRAPH_COLOR_COUNT,
    }));
    if (parents.length)
      output.splice(Math.min(index, output.length), 0, parents[0]);
    output.push(...parents.slice(1));
    if (Math.max(input.length, output.length) > MAX_GRAPH_LANES)
      throw new Error(`提交图超过 ${MAX_GRAPH_LANES} 条并行轨道，无法完整显示`);
    const edges = [];
    const edge = (kind, from, to, color) => {
      const middle = (from.y + to.y) / 2;
      edges.push({
        kind,
        color,
        path:
          from.x === to.x
            ? `M ${from.x} ${from.y} V ${to.y}`
            : `M ${from.x} ${from.y} C ${from.x} ${middle} ${to.x} ${middle} ${to.x} ${to.y}`,
      });
    };
    const node = { x: pointX(index), y: GRAPH_ROW_HEIGHT / 2, color };
    input.forEach((lane, column) => {
      if (lane.id === commit.id)
        edge("incoming", { x: pointX(column), y: 0 }, node, lane.color);
      else
        edge(
          "pass",
          { x: pointX(column), y: 0 },
          { x: pointX(output.indexOf(lane)), y: GRAPH_ROW_HEIGHT },
          lane.color,
        );
    });
    for (const parent of parents)
      edge(
        "parent",
        node,
        { x: pointX(output.indexOf(parent)), y: GRAPH_ROW_HEIGHT },
        parent.color,
      );
    width = Math.max(
      width,
      pointX(Math.max(index, input.length - 1, output.length - 1)) +
        GRAPH_MARGIN,
    );
    rows.push({
      id: commit.id,
      kind:
        commit.id === head
          ? "head"
          : commit.parentIds.length > 1
            ? "merge"
            : "commit",
      node,
      edges,
      input,
      output,
    });
    lanes = output;
  }
  return { rows, width, height: GRAPH_ROW_HEIGHT };
}
