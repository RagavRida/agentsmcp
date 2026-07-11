// ============================================================
// Neo4j Property Graph — Sync & Query Layer
//
// Syncs the local knowledge graph (from EdgeExtractor) to Neo4j
// for Cypher-powered traversal, impact analysis, and training
// data generation.
//
// Nodes: Program, Job, Paragraph, Dataset, Copybook, plus TABLE/
//   TRANSACTION/FILE/MAP/QUEUE (currently mapped to generic Node)
// Edges: EXECUTES, PERFORMS, CALLS, READS, WRITES, MODIFIES,
//   DATA_ACCESS, EXTERNAL_CALL, INCLUDES, TRANSACTS
// ============================================================

import neo4j, { Driver, Session } from "neo4j-driver";

export interface Neo4jConfig {
  uri: string;      // bolt://localhost:7687 or neo4j+s://xxx.neo4j.io
  user: string;
  password: string;
}

export interface ImpactResult {
  target: string;
  directImpact: Array<{ name: string; type: string; relationship: string }>;
  indirectImpact: Array<{ name: string; type: string; depth: number }>;
  affectedDatasets: string[];
  affectedJobs: string[];
  totalAffected: number;
}

export interface DependencyChain {
  path: Array<{ name: string; type: string }>;
  relationships: string[];
}

export class Neo4jSync {
  private driver: Driver;

  constructor(config: Neo4jConfig) {
    this.driver = neo4j.driver(
      config.uri,
      neo4j.auth.basic(config.user, config.password),
    );
  }

  /**
   * Create indexes and constraints for optimal query performance.
   */
  async initialize(): Promise<void> {
    const session = this.driver.session();
    try {
      // Unique constraints
      await session.run(
        "CREATE CONSTRAINT IF NOT EXISTS FOR (p:Program) REQUIRE p.name IS UNIQUE"
      );
      await session.run(
        "CREATE CONSTRAINT IF NOT EXISTS FOR (d:Dataset) REQUIRE d.name IS UNIQUE"
      );
      // Indexes for fast lookup
      await session.run(
        "CREATE INDEX IF NOT EXISTS FOR (n:Paragraph) ON (n.name)"
      );
      await session.run(
        "CREATE INDEX IF NOT EXISTS FOR (n:Variable) ON (n.name)"
      );
      await session.run(
        "CREATE INDEX IF NOT EXISTS FOR (n:Copybook) ON (n.name)"
      );
    } finally {
      await session.close();
    }
  }

  /**
   * Sync a parsed COBOL program's graph into Neo4j.
   * Uses MERGE to be idempotent — safe to run repeatedly.
   */
  async syncCobol(result: {
    programName: string;
    graph: {
      nodes: Array<{ id: string; label: string; type: string }>;
      edges: Array<{ source: string; target: string; type: string }>;
    };
    semanticTree: { description: string; domain: string };
    businessRules: Array<{ id: string; description: string; domain: string }>;
    stats: { paragraphs: number; variables: number };
  }): Promise<{ nodesCreated: number; edgesCreated: number }> {
    const session = this.driver.session();
    let nodesCreated = 0;
    let edgesCreated = 0;

    try {
      // Transaction for atomicity
      await session.executeWrite(async (tx) => {
        // Create the program node
        await tx.run(
          `MERGE (p:Program {name: $name})
           SET p.paragraphs = $paragraphs,
               p.variables = $variables,
               p.domain = $domain,
               p.description = $description,
               p.updatedAt = datetime()`,
          {
            name: result.programName,
            paragraphs: result.stats.paragraphs,
            variables: result.stats.variables,
            domain: result.semanticTree.domain,
            description: result.semanticTree.description,
          },
        );
        nodesCreated++;

        // Create graph nodes
        for (const node of result.graph.nodes) {
          const label = this.sanitizeLabel(node.type);
          await tx.run(
            `MERGE (n:${label} {name: $name})
             SET n.label = $label, n.sourceProgram = $program`,
            { name: node.id, label: node.label, program: result.programName },
          );
          nodesCreated++;
        }

        // Create graph edges
        for (const edge of result.graph.edges) {
          const relType = edge.type.toUpperCase().replace(/[^A-Z_]/g, "_");
          await tx.run(
            `MATCH (a {name: $source}), (b {name: $target})
             MERGE (a)-[:${relType}]->(b)`,
            { source: edge.source, target: edge.target },
          );
          edgesCreated++;
        }

        // Store business rules as Rule nodes linked to the program
        for (const rule of result.businessRules) {
          await tx.run(
            `MERGE (r:BusinessRule {id: $id})
             SET r.description = $description, r.domain = $domain, r.name = $name
             WITH r
             MATCH (p:Program {name: $program})
             MERGE (p)-[:HAS_RULE]->(r)`,
            {
              id: `${result.programName}:${rule.id}`,
              description: rule.description,
              name: rule.description.substring(0, 100),
              domain: rule.domain,
              program: result.programName,
            },
          );
          nodesCreated++;
        }
      });
    } finally {
      await session.close();
    }

    return { nodesCreated, edgesCreated };
  }

  /**
   * Sync a parsed JCL job's graph into Neo4j.
   */
  async syncJcl(result: {
    jobName: string;
    graph: {
      nodes: Array<{ id: string; label: string; type: string }>;
      edges: Array<{ source: string; target: string; type: string }>;
    };
  }): Promise<{ nodesCreated: number; edgesCreated: number }> {
    const session = this.driver.session();
    let nodesCreated = 0;
    let edgesCreated = 0;

    try {
      await session.executeWrite(async (tx) => {
        // Create the JCL Job node
        await tx.run(
          `MERGE (j:Job {name: $name}) SET j.updatedAt = datetime()`,
          { name: result.jobName },
        );
        nodesCreated++;

        for (const node of result.graph.nodes) {
          const label = this.sanitizeLabel(node.type);
          await tx.run(
            `MERGE (n:${label} {name: $name})
             SET n.label = $label, n.sourceJob = $job`,
            { name: node.id, label: node.label, job: result.jobName },
          );
          nodesCreated++;
        }

        for (const edge of result.graph.edges) {
          const relType = edge.type.toUpperCase().replace(/[^A-Z_]/g, "_");
          await tx.run(
            `MATCH (a {name: $source}), (b {name: $target})
             MERGE (a)-[:${relType}]->(b)`,
            { source: edge.source, target: edge.target },
          );
          edgesCreated++;
        }
      });
    } finally {
      await session.close();
    }

    return { nodesCreated, edgesCreated };
  }

  // ── Query Methods ──────────────────────────────────────────

  /**
   * Impact analysis: Find everything affected by changing a target.
   * Uses variable-length path matching to find indirect dependencies.
   */
  async impactAnalysis(target: string, maxDepth = 5): Promise<ImpactResult> {
    const session = this.driver.session();
    try {
      // Direct impact: nodes directly connected
      const directResult = await session.run(
        `MATCH (source {name: $target})-[r]->(affected)
         RETURN affected.name AS name, labels(affected)[0] AS type, type(r) AS relationship`,
        { target },
      );
      const directImpact = directResult.records.map((r) => ({
        name: r.get("name") as string,
        type: r.get("type") as string,
        relationship: r.get("relationship") as string,
      }));

      // Indirect impact: nodes reachable within maxDepth hops
      const indirectResult = await session.run(
        `MATCH path = (source {name: $target})-[*2..${maxDepth}]->(affected)
         WHERE NOT (source)-[]->(affected)
         RETURN DISTINCT affected.name AS name, labels(affected)[0] AS type,
                length(path) AS depth
         ORDER BY depth`,
        { target },
      );
      const indirectImpact = indirectResult.records.map((r) => ({
        name: r.get("name") as string,
        type: r.get("type") as string,
        depth: (r.get("depth") as { toNumber(): number }).toNumber(),
      }));

      // Affected datasets
      const datasetResult = await session.run(
        `MATCH (source {name: $target})-[*1..${maxDepth}]->(d:Dataset)
         RETURN DISTINCT d.name AS name`,
        { target },
      );
      const affectedDatasets = datasetResult.records.map((r) => r.get("name") as string);

      // Affected JCL jobs
      const jobResult = await session.run(
        `MATCH (source {name: $target})-[*1..${maxDepth}]->(j:Job)
         RETURN DISTINCT j.name AS name`,
        { target },
      );
      const affectedJobs = jobResult.records.map((r) => r.get("name") as string);

      return {
        target,
        directImpact,
        indirectImpact,
        affectedDatasets,
        affectedJobs,
        totalAffected: directImpact.length + indirectImpact.length,
      };
    } finally {
      await session.close();
    }
  }

  /**
   * Find the full dependency chain from a starting node.
   * Returns all paths: JCL → COBOL → DB2 → downstream.
   */
  async dependencyChain(
    startNode: string,
    maxDepth = 10,
  ): Promise<DependencyChain[]> {
    const session = this.driver.session();
    try {
      const result = await session.run(
        `MATCH path = (start {name: $start})-[*1..${maxDepth}]->(end)
         WHERE NOT (end)-->()
         RETURN [n IN nodes(path) | {name: n.name, type: labels(n)[0]}] AS nodes,
                [r IN relationships(path) | type(r)] AS rels
         LIMIT 20`,
        { start: startNode },
      );

      return result.records.map((r) => ({
        path: r.get("nodes") as Array<{ name: string; type: string }>,
        relationships: r.get("rels") as string[],
      }));
    } finally {
      await session.close();
    }
  }

  /**
   * Generate synthetic Q&A pairs from the graph for fine-tuning (Pillar 5).
   */
  async generateTrainingPairs(limit = 1000): Promise<Array<{
    question: string;
    answer: string;
  }>> {
    const session = this.driver.session();
    const pairs: Array<{ question: string; answer: string }> = [];

    try {
      // Pattern 1: "What does program X do?"
      const programs = await session.run(
        `MATCH (p:Program)-[:HAS_RULE]->(r:BusinessRule)
         RETURN p.name AS program, collect(r.description) AS rules
         LIMIT $limit`,
        { limit: neo4j.int(limit) },
      );
      for (const rec of programs.records) {
        const prog = rec.get("program") as string;
        const rules = rec.get("rules") as string[];
        pairs.push({
          question: `What does the program ${prog} do?`,
          answer: `${prog} implements the following business logic:\n${rules.map((r, i) => `${i + 1}. ${r}`).join("\n")}`,
        });
      }

      // Pattern 2: "What datasets does X read?"
      const reads = await session.run(
        `MATCH (p:Program)-[:READS]->(d:Dataset)
         RETURN p.name AS program, collect(d.name) AS datasets
         LIMIT $limit`,
        { limit: neo4j.int(limit) },
      );
      for (const rec of reads.records) {
        const prog = rec.get("program") as string;
        const datasets = rec.get("datasets") as string[];
        pairs.push({
          question: `What datasets does ${prog} read?`,
          answer: `${prog} reads the following datasets: ${datasets.join(", ")}.`,
        });
      }

      // Pattern 3: "What programs call X?"
      const calls = await session.run(
        `MATCH (caller:Program)-[:CALLS]->(callee:Program)
         RETURN callee.name AS callee, collect(caller.name) AS callers
         LIMIT $limit`,
        { limit: neo4j.int(limit) },
      );
      for (const rec of calls.records) {
        const callee = rec.get("callee") as string;
        const callers = rec.get("callers") as string[];
        pairs.push({
          question: `What programs call ${callee}?`,
          answer: `${callee} is called by: ${callers.join(", ")}.`,
        });
      }

      // Pattern 4: "What paragraphs does program X perform?"
      // Uses the PERFORMS edge + Paragraph label that the parser actually
      // emits (the previous USES/CONTAINS/Variable query matched nothing).
      const performs = await session.run(
        `MATCH (prog:Program)-[:PERFORMS]->(para:Paragraph)
         RETURN prog.name AS program, collect(DISTINCT para.name) AS paragraphs
         LIMIT $limit`,
        { limit: neo4j.int(limit) },
      );
      for (const rec of performs.records) {
        const program = rec.get("program") as string;
        const paragraphs = rec.get("paragraphs") as string[];
        pairs.push({
          question: `What paragraphs does ${program} perform?`,
          answer: `${program} performs the following paragraphs: ${paragraphs.join(", ")}.`,
        });
      }
    } finally {
      await session.close();
    }

    return pairs;
  }

  // ── Helpers ────────────────────────────────────────────────

  private sanitizeLabel(type: string): string {
    // Neo4j labels must be valid identifiers
    const labelMap: Record<string, string> = {
      PROGRAM: "Program",
      PARAGRAPH: "Paragraph",
      DATASET: "Dataset",
      COPYBOOK: "Copybook",
      VARIABLE: "Variable",
      JOB: "Job",
      STEP: "Step",
    };
    return labelMap[type.toUpperCase()] || "Node";
  }

  /**
   * Delete all graph nodes and relationships for a specific program.
   * Uses DETACH DELETE to cascade through all connected nodes.
   * Returns the number of nodes deleted.
   */
  async deleteProgram(programName: string): Promise<number> {
    const session = this.driver.session();
    try {
      const result = await session.executeWrite(async (tx) => {
        // Delete every node that belongs to this program. Structural nodes
        // (Paragraph/Dataset/Copybook/…) are tagged with `sourceProgram`
        // (COBOL) or `sourceJob` (JCL) at sync time; the Program node itself
        // matches by `name`; BusinessRule nodes are keyed `<program>:<ruleId>`.
        // NOTE: structural nodes are keyed by bare name and can be shared
        // across programs (last-writer wins on `sourceProgram`), so a shared
        // dataset/copybook may be removed here — full per-program isolation
        // would require namespacing node ids by program.
        const res = await tx.run(
          `MATCH (n)
           WHERE n.name = $programName
              OR n.sourceProgram = $programName
              OR n.sourceJob = $programName
              OR n.id STARTS WITH $rulePrefix
           DETACH DELETE n
           RETURN count(n) as deleted`,
          { programName, rulePrefix: `${programName}:` }
        );
        return res.records[0]?.get("deleted")?.toNumber() ?? 0;
      });
      return result;
    } finally {
      await session.close();
    }
  }

  async close(): Promise<void> {
    await this.driver.close();
  }
}
