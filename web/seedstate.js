const MAX_RANDOM = 2 ** 50;

export const randomSeed = () => Math.floor(Math.random() * MAX_RANDOM);

// Only -1 means "random each time"; other negative values are not seeds.
export const validSeed = (value) => Number.isSafeInteger(value) && value >= -1;

export function afterRun({ seed, mode }, used) {
  if (seed === -1) return -1;
  if (mode === "increment") return used + 1;
  if (mode === "decrement") return Math.max(0, used - 1);
  if (mode === "randomize") return randomSeed();
  return seed;
}

// The serialized node for a prompt id such as "12" or "12:34" (node 34 inside the subgraph of node 12).
export function savedNode(workflow, id) {
  const parts = String(id).split(":");
  let nodes = workflow?.nodes;
  for (const part of parts.slice(0, -1)) {
    const holder = nodes?.find((node) => String(node.id) === part);
    nodes = workflow.definitions?.subgraphs?.find((subgraph) => subgraph.id === holder?.type)?.nodes;
  }
  return nodes?.find((node) => String(node.id) === parts.at(-1));
}
