export type ConceptGraphNode = {
  id: string;
  label: string;
  kind: "domain" | "concept";
  domainId: string;
  summary: string;
  relatedChapterIds?: string[];
  keywords?: string[];
  examWeight?: number;
  [key: string]: unknown;
};

export type ConceptGraphEdge = {
  source: string;
  target: string;
  type: string;
  weight: number;
  rationale: string;
  [key: string]: unknown;
};

export type ConceptGraph = {
  schemaVersion?: string;
  graphId?: string;
  title?: string;
  description?: string;
  nodes: ConceptGraphNode[];
  edges: ConceptGraphEdge[];
  [key: string]: unknown;
};

export const validateConceptGraph = (value: unknown): ConceptGraph => {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Concept graph must be a JSON object.");
  const graph = value as Record<string, unknown>;
  if (!Array.isArray(graph.nodes) || !Array.isArray(graph.edges)) throw new Error("Concept graph must include nodes and edges arrays.");
  if (!graph.nodes.length) throw new Error("Concept graph must include at least one node.");

  const nodeIds = new Set<string>();
  for (const [index, rawNode] of graph.nodes.entries()) {
    if (!rawNode || typeof rawNode !== "object" || Array.isArray(rawNode)) throw new Error(`Concept graph node ${index} must be an object.`);
    const node = rawNode as Record<string, unknown>;
    for (const field of ["id", "label", "kind", "domainId", "summary"] as const) {
      if (typeof node[field] !== "string" || !node[field].trim()) throw new Error(`Concept graph node ${index} requires ${field}.`);
    }
    if (node.kind !== "domain" && node.kind !== "concept") throw new Error(`Concept graph node ${String(node.id)} has an invalid kind.`);
    if (nodeIds.has(String(node.id))) throw new Error(`Concept graph node ID ${String(node.id)} is duplicated.`);
    nodeIds.add(String(node.id));
  }

  const edgeKeys = new Set<string>();
  for (const [index, rawEdge] of graph.edges.entries()) {
    if (!rawEdge || typeof rawEdge !== "object" || Array.isArray(rawEdge)) throw new Error(`Concept graph edge ${index} must be an object.`);
    const edge = rawEdge as Record<string, unknown>;
    for (const field of ["source", "target", "type", "rationale"] as const) {
      if (typeof edge[field] !== "string" || !edge[field].trim()) throw new Error(`Concept graph edge ${index} requires ${field}.`);
    }
    if (!nodeIds.has(String(edge.source)) || !nodeIds.has(String(edge.target))) throw new Error(`Concept graph edge ${index} has a missing endpoint.`);
    if (edge.source === edge.target) throw new Error(`Concept graph edge ${index} cannot connect a node to itself.`);
    if (typeof edge.weight !== "number" || !Number.isFinite(edge.weight) || edge.weight < 0 || edge.weight > 1) throw new Error(`Concept graph edge ${index} weight must be between 0 and 1.`);
    const key = `${String(edge.source)}\u0000${String(edge.target)}\u0000${String(edge.type)}`;
    if (edgeKeys.has(key)) throw new Error(`Concept graph edge ${index} is duplicated.`);
    edgeKeys.add(key);
  }

  return value as ConceptGraph;
};
