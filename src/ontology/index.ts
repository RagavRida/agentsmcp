/**
 * Ontology Engine — auto-discover domain ontologies from parsed COBOL.
 *
 * Inspired by Cognee's modules/ontology/.
 * Instead of hardcoded domain lists, this module discovers:
 *   - Entities (programs, paragraphs, data items)
 *   - Relationships (CALL, PERFORM, COPY, data flow)
 *   - Domain clusters (group related rules by co-occurrence)
 *
 * The ontology evolves as more COBOL is parsed — no manual config.
 */

// ── Ontology Models ────────────────────────────────────────

export interface OntologyEntity {
  id: string;
  name: string;
  type: "PROGRAM" | "PARAGRAPH" | "DATA_ITEM" | "COPYBOOK" | "RULE" | "DOMAIN";
  properties: Record<string, unknown>;
  /** Programs this entity appears in */
  programs: Set<string>;
}

export interface OntologyRelationship {
  source: string;  // entity id
  target: string;  // entity id
  type: "CALLS" | "PERFORMS" | "COPIES" | "READS" | "WRITES" | "DEPENDS_ON" | "BELONGS_TO";
  weight: number;  // how often this relationship appears
}

export interface DomainCluster {
  id: string;
  name: string;
  entities: string[];  // entity ids
  /** Auto-discovered label based on common verbs and data items */
  label: string;
  confidence: number;
}

export interface Ontology {
  entities: Map<string, OntologyEntity>;
  relationships: OntologyRelationship[];
  domains: DomainCluster[];
  version: number;
  lastUpdated: number;
}

// ── Ontology Generator ─────────────────────────────────────

/**
 * Auto-generates an ontology from parsed COBOL results.
 * Call this after each remember() to evolve the ontology.
 */
export class OntologyGenerator {
  private ontology: Ontology = {
    entities: new Map(),
    relationships: [],
    domains: [],
    version: 0,
    lastUpdated: Date.now(),
  };

  /**
   * Ingest a parsed COBOL result and update the ontology.
   */
  ingest(parsed: {
    programId?: string;
    semanticNodes: Array<{
      id: string;
      type: string;
      description: string;
      domain?: string;
    }>;
    controlFlow?: Array<{
      from: string;
      to: string;
      type: string;
    }>;
    copybooks?: string[];
    dataItems?: Array<{
      name: string;
      type: string;
      usage?: string;
    }>;
  }): void {
    const programName = parsed.programId ?? "UNKNOWN";

    // 1. Add program entity
    this.upsertEntity({
      id: `prog::${programName}`,
      name: programName,
      type: "PROGRAM",
      properties: { nodeCount: parsed.semanticNodes.length },
      programs: new Set([programName]),
    });

    // 2. Add semantic nodes as entities
    for (const node of parsed.semanticNodes) {
      this.upsertEntity({
        id: `rule::${programName}::${node.id}`,
        name: node.id,
        type: "RULE",
        properties: {
          nodeType: node.type,
          description: node.description,
          domain: node.domain,
        },
        programs: new Set([programName]),
      });

      // BELONGS_TO relationship
      this.addRelationship({
        source: `rule::${programName}::${node.id}`,
        target: `prog::${programName}`,
        type: "BELONGS_TO",
        weight: 1,
      });
    }

    // 3. Add control flow relationships
    if (parsed.controlFlow) {
      for (const edge of parsed.controlFlow) {
        const relType = edge.type === "CALL" ? "CALLS"
          : edge.type === "PERFORM" ? "PERFORMS"
          : "DEPENDS_ON";

        this.addRelationship({
          source: `rule::${programName}::${edge.from}`,
          target: `rule::${programName}::${edge.to}`,
          type: relType as OntologyRelationship["type"],
          weight: 1,
        });
      }
    }

    // 4. Add copybook entities
    if (parsed.copybooks) {
      for (const copybook of parsed.copybooks) {
        this.upsertEntity({
          id: `copy::${copybook}`,
          name: copybook,
          type: "COPYBOOK",
          properties: {},
          programs: new Set([programName]),
        });

        this.addRelationship({
          source: `prog::${programName}`,
          target: `copy::${copybook}`,
          type: "COPIES",
          weight: 1,
        });
      }
    }

    // 5. Add data items
    if (parsed.dataItems) {
      for (const item of parsed.dataItems) {
        this.upsertEntity({
          id: `data::${programName}::${item.name}`,
          name: item.name,
          type: "DATA_ITEM",
          properties: { dataType: item.type, usage: item.usage },
          programs: new Set([programName]),
        });
      }
    }

    // 6. Auto-cluster domains
    this.clusterDomains();

    this.ontology.version++;
    this.ontology.lastUpdated = Date.now();
  }

  /**
   * Auto-discover domain clusters based on entity co-occurrence.
   * Groups rules that share common verbs, data items, or descriptions.
   */
  private clusterDomains(): void {
    const rulesByDomain = new Map<string, string[]>();

    for (const [id, entity] of this.ontology.entities) {
      if (entity.type !== "RULE") continue;
      const domain = (entity.properties.domain as string) ?? "unknown";

      if (!rulesByDomain.has(domain)) rulesByDomain.set(domain, []);
      rulesByDomain.get(domain)!.push(id);
    }

    // Also cluster by description keywords
    const verbClusters = new Map<string, string[]>();
    const BANKING_VERBS = ["COMPUTE", "ADD", "SUBTRACT", "MULTIPLY", "DIVIDE",
      "CHECK", "VERIFY", "VALIDATE", "CALL", "WRITE", "READ", "PERFORM"];

    for (const [id, entity] of this.ontology.entities) {
      if (entity.type !== "RULE") continue;
      const desc = (entity.properties.description as string ?? "").toUpperCase();

      for (const verb of BANKING_VERBS) {
        if (desc.includes(verb)) {
          if (!verbClusters.has(verb)) verbClusters.set(verb, []);
          verbClusters.get(verb)!.push(id);
        }
      }
    }

    // Merge domain and verb clusters
    this.ontology.domains = [];

    for (const [domain, entityIds] of rulesByDomain) {
      if (entityIds.length < 2) continue;

      this.ontology.domains.push({
        id: `domain::${domain}`,
        name: domain,
        entities: entityIds,
        label: this.inferDomainLabel(entityIds),
        confidence: entityIds.length / Math.max(this.ontology.entities.size, 1),
      });
    }
  }

  /** Infer a human-readable label for a domain cluster */
  private inferDomainLabel(entityIds: string[]): string {
    const descriptions = entityIds
      .map(id => this.ontology.entities.get(id))
      .filter(Boolean)
      .map(e => (e!.properties.description as string) ?? "")
      .filter(Boolean);

    if (descriptions.length === 0) return "Unknown Domain";

    // Find the most common meaningful words
    const wordCounts = new Map<string, number>();
    const stopWords = new Set(["the", "a", "an", "is", "in", "to", "of", "and", "for", "with", "from"]);

    for (const desc of descriptions) {
      const words = desc.toLowerCase().split(/\s+/).filter(w => w.length > 3 && !stopWords.has(w));
      for (const word of words) {
        wordCounts.set(word, (wordCounts.get(word) ?? 0) + 1);
      }
    }

    const topWords = [...wordCounts.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 3)
      .map(([w]) => w);

    return topWords.length > 0
      ? topWords.map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(" / ")
      : "General";
  }

  // ── Helpers ────────────────────────────────────────────

  private upsertEntity(entity: OntologyEntity) {
    const existing = this.ontology.entities.get(entity.id);
    if (existing) {
      // Merge programs
      for (const p of entity.programs) existing.programs.add(p);
      // Merge properties
      Object.assign(existing.properties, entity.properties);
    } else {
      this.ontology.entities.set(entity.id, entity);
    }
  }

  private addRelationship(rel: OntologyRelationship) {
    const existing = this.ontology.relationships.find(
      r => r.source === rel.source && r.target === rel.target && r.type === rel.type
    );
    if (existing) {
      existing.weight++;
    } else {
      this.ontology.relationships.push(rel);
    }
  }

  // ── Public API ─────────────────────────────────────────

  getOntology(): Ontology { return this.ontology; }

  getEntity(id: string): OntologyEntity | undefined {
    return this.ontology.entities.get(id);
  }

  getDomains(): DomainCluster[] { return this.ontology.domains; }

  /** Get cross-program dependencies (shared copybooks, data items) */
  getCrossProgramDeps(): Array<{ program1: string; program2: string; sharedEntities: string[] }> {
    const programEntities = new Map<string, Set<string>>();

    for (const [id, entity] of this.ontology.entities) {
      if (entity.programs.size > 1) {
        for (const prog of entity.programs) {
          if (!programEntities.has(prog)) programEntities.set(prog, new Set());
          programEntities.get(prog)!.add(id);
        }
      }
    }

    const deps: Array<{ program1: string; program2: string; sharedEntities: string[] }> = [];
    const programs = [...programEntities.keys()];

    for (let i = 0; i < programs.length; i++) {
      for (let j = i + 1; j < programs.length; j++) {
        const shared = [...programEntities.get(programs[i])!]
          .filter(e => programEntities.get(programs[j])!.has(e));
        if (shared.length > 0) {
          deps.push({ program1: programs[i], program2: programs[j], sharedEntities: shared });
        }
      }
    }

    return deps;
  }

  getStats(): {
    entities: number;
    relationships: number;
    domains: number;
    programs: number;
    version: number;
  } {
    const programs = new Set<string>();
    for (const entity of this.ontology.entities.values()) {
      for (const p of entity.programs) programs.add(p);
    }

    return {
      entities: this.ontology.entities.size,
      relationships: this.ontology.relationships.length,
      domains: this.ontology.domains.length,
      programs: programs.size,
      version: this.ontology.version,
    };
  }
}
