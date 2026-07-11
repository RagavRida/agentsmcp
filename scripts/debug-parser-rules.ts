/**
 * Debug script: show what rules the parser extracts from each banking program.
 */
import { COBOLParser } from "../parser/src/cobol-parser";
import { SemanticElevator } from "../parser/src/semantic-elevator";
import { COBOL_BANKING_CORPUS } from "../src/eval/datasets/cobol-banking";

function collectSemanticNodes(node: any, type: string): any[] {
  const result: any[] = [];
  if (node.type === type) result.push(node);
  if (node.children) {
    for (const child of node.children) {
      result.push(...collectSemanticNodes(child, type));
    }
  }
  return result;
}

for (const entry of COBOL_BANKING_CORPUS) {
  console.log(`\n═══ ${entry.programId} ═══`);
  const parser = new COBOLParser();
  const ast = parser.parse(entry.source);
  const elevator = new SemanticElevator();
  const semantic = elevator.elevate(ast);

  const rules = collectSemanticNodes(semantic, "BUSINESS_RULE");
  console.log(`  Extracted ${rules.length} rules:`);
  for (const r of rules) {
    const id = r.description?.split(":")[0]?.trim() || r.description || "unknown";
    console.log(`    - [${r.sourceAST?.type || "?"}] id="${id}" desc="${r.description}"`);
  }

  console.log(`  Expected ${entry.expectedRules.length} rules:`);
  for (const r of entry.expectedRules) {
    console.log(`    - [${r.type}] id="${r.id}" desc="${r.description}"`);
  }
}
