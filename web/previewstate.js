// The image index after the previous (-1) or next (+1) button; wraps around at both ends.
export const stepIndex = (index, delta, count) => (count ? (((index + delta) % count) + count) % count : 0);

export const counterText = (index, count) => `${count ? index + 1 : 0} / ${count}`;

// The key of a node's last results in app.nodeOutputs: the id in the root graph, "<subgraph id>:<id>" inside a subgraph.
// Cloned and pasted nodes are configured before they join a graph.
export const outputKey = (node) => {
  if (!node.graph) return null;
  return node.graph.isRootGraph ? String(node.id) : `${node.graph.id}:${node.id}`;
};
