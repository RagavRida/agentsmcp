import { ASTNode, ASTNodeType } from './types.js';
import { BusinessDomain, SemanticNode, SemanticNodeType } from './semantic-elevator.js';

export class PLISemanticElevator {
  private idCounter = 0;

  elevate(ast: ASTNode): SemanticNode {
    const children = ast.children.map((child) => this.elevateNode(child));
    return {
      id: this.nextId(),
      type: SemanticNodeType.SYSTEM,
      description: `PL/I program: ${humanize(ast.name)}`,
      domain: inferDomain(ast.name),
      inputs: children.flatMap((child) => child.inputs),
      outputs: children.flatMap((child) => child.outputs),
      sideEffects: children.flatMap((child) => child.sideEffects),
      children,
      sourceAST: { type: ast.type, name: ast.name, loc: ast.loc },
    };
  }

  private elevateNode(node: ASTNode): SemanticNode {
    switch (node.type) {
      case ASTNodeType.PLI_PROC_NODE:
        return this.node(node, SemanticNodeType.WORKFLOW, `Procedure: ${humanize(node.name)}`);

      case ASTNodeType.PLI_DECLARE_NODE: {
        const declarations = Array.isArray(node.meta.declarations)
          ? node.meta.declarations as Array<{ name?: string; type?: string }>
          : [];
        return this.node(
          node,
          SemanticNodeType.DATA_DEFINITION,
          `Declare ${declarations.map((item) => item.name).filter(Boolean).join(', ') || humanize(node.name)}`,
          [],
          declarations.map((item) => humanizeVariable(item.name ?? 'UNKNOWN')),
        );
      }

      case ASTNodeType.PLI_CALL_NODE: {
        const target = typeof node.meta.target === 'string' ? node.meta.target : node.name;
        const args = Array.isArray(node.meta.arguments)
          ? (node.meta.arguments as unknown[]).filter((item): item is string => typeof item === 'string')
          : [];
        return this.node(
          node,
          SemanticNodeType.EXTERNAL_CALL,
          `Call external procedure: ${humanize(target)}`,
          args.map(humanizeVariable),
          [],
          [`Invokes ${target}`],
        );
      }

      case ASTNodeType.PLI_IF_NODE:
      case ASTNodeType.PLI_SELECT_NODE:
        return this.node(
          node,
          SemanticNodeType.CONTROL_FLOW,
          node.type === ASTNodeType.PLI_IF_NODE
            ? `Conditional branch: ${String(node.meta.condition ?? '')}`
            : 'SELECT decision block',
        );

      case ASTNodeType.PLI_EXEC_SQL_NODE: {
        const operation = String(node.meta.operation ?? 'UNKNOWN');
        const tables = normalizeStringArray(node.meta.tables);
        const table = tables.join(', ') || String(node.meta.table ?? 'UNKNOWN');
        const columns = normalizeStringArray(node.meta.columns);
        return this.node(
          node,
          SemanticNodeType.DATA_ACCESS,
          `${describeSQLOperation(operation, table)}${columns.length > 0 ? ` columns ${columns.join(', ')}` : ''}`,
          isReadOperation(operation) ? tables : [],
          isReadOperation(operation) ? [] : tables,
          isReadOperation(operation) ? [] : [`${operation} ${table}`],
        );
      }

      default:
        return this.node(node, SemanticNodeType.GENERAL, humanize(node.name));
    }
  }

  private node(
    ast: ASTNode,
    type: SemanticNodeType,
    description: string,
    inputs: string[] = [],
    outputs: string[] = [],
    sideEffects: string[] = [],
  ): SemanticNode {
    return {
      id: this.nextId(),
      type,
      description,
      domain: inferDomain(description),
      inputs,
      outputs,
      sideEffects,
      children: ast.children.map((child) => this.elevateNode(child)),
      sourceAST: { type: ast.type, name: ast.name, loc: ast.loc },
    };
  }

  private nextId(): string {
    return `pli_sem_${++this.idCounter}`;
  }
}

function describeSQLOperation(operation: string, table: string): string {
  switch (operation) {
    case 'SELECT': return `Read records from ${table}`;
    case 'INSERT': return `Create records in ${table}`;
    case 'UPDATE': return `Modify records in ${table}`;
    case 'DELETE': return `Delete records from ${table}`;
    case 'DECLARE_CURSOR': return `Declare cursor over ${table}`;
    case 'FETCH': return `Fetch cursor data from ${table}`;
    default: return `Database operation ${operation} on ${table}`;
  }
}

function isReadOperation(operation: string): boolean {
  return operation === 'SELECT' || operation === 'DECLARE_CURSOR' || operation === 'FETCH' || operation === 'OPEN';
}

function normalizeStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((item): item is string => typeof item === 'string')
    .map((item) => item.trim())
    .filter(Boolean);
}

function humanize(value: string): string {
  return value.replace(/[_-]+/g, ' ').toLowerCase().replace(/\b\w/g, (char) => char.toUpperCase());
}

function humanizeVariable(value: string): string {
  return value.replace(/^:/, '').replace(/[_-]+/g, ' ');
}

function inferDomain(value: string): BusinessDomain {
  const upper = value.toUpperCase();
  if (upper.includes('PAY') || upper.includes('SETTLE')) return BusinessDomain.PAYMENTS;
  if (upper.includes('RISK') || upper.includes('LIMIT')) return BusinessDomain.RISK;
  if (upper.includes('ACCOUNT') || upper.includes('BALANCE')) return BusinessDomain.ACCOUNT;
  if (upper.includes('AUDIT') || upper.includes('COMPLIANCE')) return BusinessDomain.AUDIT;
  return BusinessDomain.GENERAL;
}
