// ============================================================
// Abstract Semantic Tree (ASemT) — Deterministic Elevation
// Converts syntactic AST nodes into language-agnostic
// business logic nodes using ZERO LLM calls.
//
// Philosophy: The analysis target is the crown jewels.
// COBOL/JCL/DB2 logic encodes how the institution calculates
// risk, prices products, and moves money. This module never
// sends code to an external model. All semantic elevation is
// done via deterministic pattern matching and domain rules.
// ============================================================

import { ASTNode, ASTNodeType } from './types.js';
import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';

// ---- Semantic Node Types ----

export enum SemanticNodeType {
  SYSTEM = 'SYSTEM',
  WORKFLOW = 'WORKFLOW',
  BUSINESS_RULE = 'BUSINESS_RULE',
  DATA_ACCESS = 'DATA_ACCESS',
  DATA_TRANSFORM = 'DATA_TRANSFORM',
  CONTROL_FLOW = 'CONTROL_FLOW',
  EXTERNAL_CALL = 'EXTERNAL_CALL',
  DATA_DEFINITION = 'DATA_DEFINITION',
  TRANSACTION = 'TRANSACTION',
  DEPENDENCY = 'DEPENDENCY',
  GENERAL = 'GENERAL',
}

export enum BusinessDomain {
  TAXATION = 'Taxation',
  PAYMENTS = 'Payments',
  RISK = 'Risk Assessment',
  CUSTOMER = 'Customer Management',
  ACCOUNT = 'Account Management',
  AUDIT = 'Audit & Compliance',
  REPORTING = 'Reporting',
  AUTHENTICATION = 'Authentication',
  PRICING = 'Pricing',
  GENERAL = 'General',
}

export interface SemanticNode {
  /** Unique identifier */
  id: string;
  /** The semantic type */
  type: SemanticNodeType;
  /** Human-readable business description (auto-generated, no LLM) */
  description: string;
  /** Inferred business domain */
  domain: BusinessDomain;
  /** What business concepts this node consumes */
  inputs: string[];
  /** What business concepts this node produces */
  outputs: string[];
  /** Side effects (database writes, file outputs, external calls) */
  sideEffects: string[];
  /** Children in the semantic hierarchy */
  children: SemanticNode[];
  /** Traceability: link back to the original AST node */
  sourceAST: { type: string; name: string; loc: { startLine: number; endLine: number } };
}

// ---- Domain Inference Dictionary ----
// Pure keyword-based classification. No AI needed.

const DOMAIN_KEYWORDS: Record<string, BusinessDomain> = {};

// ---- Config Loading ----

export interface DomainConfig {
  domains: Record<string, string[]>;
  stripPrefixes: string[];
  datasetPrefixes: Record<string, string>;
  symbolOverrides: Record<string, { meaning: string; domain: string }>;
}

let loadedConfig: DomainConfig | null = null;

function loadConfig(): DomainConfig {
  if (loadedConfig) return loadedConfig;

  // Try to load from config file
  try {
    // Support both ESM and CommonJS environments
    let configDir: string;
    if (typeof __dirname !== 'undefined') {
      // CommonJS — __dirname is available natively
      configDir = __dirname;
    } else {
      // ESM — derive __dirname from import.meta.url
      // Use indirect eval to hide import.meta from the CJS compiler
      const getUrl = new Function('return import.meta.url') as () => string;
      configDir = path.dirname(fileURLToPath(getUrl()));
    }
    const configPath = path.resolve(configDir, '../config/domain-dictionary.json');
    const raw = fs.readFileSync(configPath, 'utf-8');
    loadedConfig = JSON.parse(raw) as DomainConfig;

    // Build the keyword map from the config
    for (const [domainName, keywords] of Object.entries(loadedConfig.domains)) {
      for (const keyword of keywords) {
        const bd = Object.values(BusinessDomain).find(d => d === domainName) || BusinessDomain.GENERAL;
        DOMAIN_KEYWORDS[keyword.toUpperCase()] = bd as BusinessDomain;
      }
    }

    return loadedConfig;
  } catch {
    // Fall back to sensible defaults if no config file
    const defaults: DomainConfig = {
      domains: {
        'Taxation': ['TAX', 'GST', 'VAT', 'DUTY', 'LEVY', 'WITHHOLD', 'DEDUCT'],
        'Payments': ['PAY', 'TRANSFER', 'REMIT', 'SETTLE', 'CLEAR', 'SWIFT', 'ACH'],
        'Risk Assessment': ['RISK', 'SCORE', 'CREDIT', 'EXPOSURE', 'LIMIT', 'COLLATERAL'],
        'Customer Management': ['CUST', 'CUSTOMER', 'CLIENT', 'MEMBER', 'KYC'],
        'Account Management': ['ACCT', 'ACCOUNT', 'BALANCE', 'LEDGER', 'DEPOSIT', 'WITHDRAW'],
        'Audit & Compliance': ['AUDIT', 'LOG', 'TRACE', 'COMPLY', 'REGULAT'],
        'Reporting': ['REPORT', 'PRINT', 'SUMMARY', 'EXTRACT'],
        'Authentication': ['AUTH', 'LOGIN', 'PASSWORD', 'TOKEN', 'SESSION'],
        'Pricing': ['PRICE', 'RATE', 'FEE', 'INTEREST', 'PREMIUM', 'DISCOUNT'],
      },
      stripPrefixes: ['WS-', 'LS-', 'GS-', 'IX-', 'CA-', 'LK-', 'WK-'],
      datasetPrefixes: { 'PROD.': 'Production', 'DEV.': 'Development' },
      symbolOverrides: {},
    };

    for (const [domainName, keywords] of Object.entries(defaults.domains)) {
      for (const keyword of keywords) {
        const bd = Object.values(BusinessDomain).find(d => d === domainName) || BusinessDomain.GENERAL;
        DOMAIN_KEYWORDS[keyword.toUpperCase()] = bd as BusinessDomain;
      }
    }

    loadedConfig = defaults;
    return defaults;
  }
}

// ---- Variable Semantics Dictionary ----
// Maps COBOL PIC clauses to business meaning

function inferVariableMeaning(name: string, pic: string): string {
  const upper = name.toUpperCase();

  // Monetary amounts
  if (pic && /9.*V9/.test(pic)) {
    if (upper.includes('AMT') || upper.includes('AMOUNT')) return 'Monetary Amount';
    if (upper.includes('RATE')) return 'Rate/Percentage';
    if (upper.includes('BAL')) return 'Account Balance';
    if (upper.includes('PRICE')) return 'Unit Price';
    if (upper.includes('FEE')) return 'Fee Amount';
    if (upper.includes('TAX')) return 'Tax Amount';
    if (upper.includes('INCOME') || upper.includes('GROSS')) return 'Income Amount';
    return 'Numeric Value';
  }

  // Codes and identifiers
  if (pic && /X\(\d{1,2}\)/.test(pic)) {
    if (upper.includes('CODE')) return 'Classification Code';
    if (upper.includes('ID')) return 'Unique Identifier';
    if (upper.includes('STATUS')) return 'Status Flag';
    if (upper.includes('FLAG') || upper.includes('IND')) return 'Boolean Indicator';
    if (upper.includes('NAME')) return 'Name Field';
    if (upper.includes('PROVINCE') || upper.includes('STATE') || upper.includes('REGION')) return 'Geographic Region Code';
    return 'Text Field';
  }

  // EOF flags
  if (upper.includes('EOF') || upper.includes('END-OF')) return 'End-of-Data Flag';

  return 'Data Field';
}

// ---- SQL Operation Semantics ----

function describeSQLOperation(operation: string, table: string): string {
  const cleanTable = table.replace(/^:/, '');
  switch (operation) {
    case 'SELECT': return `Read records from ${cleanTable}`;
    case 'INSERT': return `Create new record in ${cleanTable}`;
    case 'UPDATE': return `Modify existing record in ${cleanTable}`;
    case 'DELETE': return `Remove record from ${cleanTable}`;
    case 'MERGE': return `Upsert record in ${cleanTable}`;
    case 'DECLARE_CURSOR': return `Declare cursor over ${cleanTable}`;
    case 'OPEN': return `Open cursor for ${cleanTable}`;
    case 'FETCH': return `Fetch cursor data from ${cleanTable}`;
    case 'CLOSE': return `Close cursor for ${cleanTable}`;
    default: return `Database operation on ${cleanTable}`;
  }
}

function normalizeStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((item): item is string => typeof item === 'string')
    .map((item) => item.trim())
    .filter(Boolean);
}

// ---- The Semantic Elevator ----

export class SemanticElevator {
  private idCounter = 0;
  private config: DomainConfig;

  constructor() {
    this.config = loadConfig();
  }

  private nextId(): string {
    return `sem_${++this.idCounter}`;
  }

  /**
   * Elevate a COBOL or JCL AST into an Abstract Semantic Tree.
   * 100% deterministic. Zero LLM calls.
   */
  elevate(ast: ASTNode): SemanticNode {
    switch (ast.type) {
      case ASTNodeType.COBOL_PROGRAM:
        return this.elevateProgram(ast);
      case ASTNodeType.JCL_JOB:
        return this.elevateJob(ast);
      default:
        return this.elevateGeneric(ast);
    }
  }

  // ---- JCL Elevation ----

  private elevateJob(ast: ASTNode): SemanticNode {
    const domain = this.inferDomain(ast.name);
    const children: SemanticNode[] = [];

    for (const step of ast.children) {
      if (step.type === ASTNodeType.JCL_EXEC || step.type === ASTNodeType.JCL_PROC_CALL) {
        children.push(this.elevateExecStep(step));
      }
    }

    return {
      id: this.nextId(),
      type: SemanticNodeType.WORKFLOW,
      description: `Batch workflow: ${this.humanize(ast.name)}`,
      domain,
      inputs: this.collectInputDatasets(ast),
      outputs: this.collectOutputDatasets(ast),
      sideEffects: [],
      children,
      sourceAST: { type: ast.type, name: ast.name, loc: ast.loc },
    };
  }

  private elevateExecStep(step: ASTNode): SemanticNode {
    const target = (step.meta['target'] as string) || step.name;
    const domain = this.inferDomain(target);

    const inputs: string[] = [];
    const outputs: string[] = [];
    const sideEffects: string[] = [];

    for (const dd of step.children) {
      if (dd.type !== ASTNodeType.JCL_DD) continue;
      const dsn = (dd.meta['dsn'] as string) || '';
      const disp = ((dd.meta['disp'] as string) || '').toUpperCase();
      if (!dsn || dd.meta['sysout']) continue;

      const dispStatus = disp.replace(/[()]/g, '').split(',')[0]?.trim() || '';

      if (dispStatus === 'SHR') {
        inputs.push(this.humanizeDataset(dsn));
      } else if (dispStatus === 'OLD') {
        inputs.push(this.humanizeDataset(dsn));
        sideEffects.push(`Modifies ${this.humanizeDataset(dsn)}`);
      } else if (dispStatus === 'NEW' || dispStatus === 'MOD') {
        outputs.push(this.humanizeDataset(dsn));
      }
    }

    return {
      id: this.nextId(),
      type: SemanticNodeType.EXTERNAL_CALL,
      description: `Execute program: ${this.humanize(target)}`,
      domain,
      inputs,
      outputs,
      sideEffects,
      children: [],
      sourceAST: { type: step.type, name: step.name, loc: step.loc },
    };
  }

  // ---- COBOL Elevation ----

  private elevateProgram(ast: ASTNode): SemanticNode {
    const domain = this.inferDomain(ast.name);
    const children: SemanticNode[] = [];

    // Walk all divisions
    for (const div of ast.children) {
      if (div.type === ASTNodeType.COBOL_DIVISION_NODE) {
        if (div.name === 'PROCEDURE') {
          // Elevate each paragraph
          for (const child of div.children) {
            if (child.type === ASTNodeType.COBOL_PARAGRAPH_NODE) {
              children.push(this.elevateParagraph(child, ast.name));
            } else if (child.type === ASTNodeType.COBOL_SECTION_NODE) {
              for (const para of child.children) {
                if (para.type === ASTNodeType.COBOL_PARAGRAPH_NODE) {
                  children.push(this.elevateParagraph(para, ast.name));
                }
              }
            }
          }
        } else if (div.name === 'DATA' || div.name === 'WORKING-STORAGE') {
          // Elevate variable definitions
          for (const child of div.children) {
            if (child.type === ASTNodeType.COBOL_VARIABLE_NODE) {
              children.push(this.elevateVariable(child));
            }
            if (child.type === ASTNodeType.COBOL_REDEFINES_NODE) {
              children.push(this.elevateRedefines(child));
            }
            if (child.type === ASTNodeType.COBOL_SECTION_NODE) {
              for (const v of child.children) {
                if (v.type === ASTNodeType.COBOL_VARIABLE_NODE) {
                  children.push(this.elevateVariable(v));
                }
                if (v.type === ASTNodeType.COBOL_REDEFINES_NODE) {
                  children.push(this.elevateRedefines(v));
                }
              }
            }
          }
        }
      }
    }

    return {
      id: this.nextId(),
      type: SemanticNodeType.SYSTEM,
      description: `Business System: ${this.humanize(ast.name)}`,
      domain,
      inputs: [],
      outputs: [],
      sideEffects: [],
      children,
      sourceAST: { type: ast.type, name: ast.name, loc: ast.loc },
    };
  }

  private elevateParagraph(para: ASTNode, programName: string): SemanticNode {
    const domain = this.inferDomain(para.name);
    const children: SemanticNode[] = [];
    const sideEffects: string[] = [];
    const inputs: string[] = [];
    const outputs: string[] = [];

    for (const stmt of para.children) {
      switch (stmt.type) {
        case ASTNodeType.COBOL_PERFORM_NODE: {
          const target = (stmt.meta['target'] as string) || stmt.name;
          const until = (stmt.meta['until'] as string) || '';
          const desc = until
            ? `Repeat ${this.humanize(target)} until ${this.humanizeCondition(until)}`
            : `Execute ${this.humanize(target)}`;
          children.push({
            id: this.nextId(),
            type: SemanticNodeType.CONTROL_FLOW,
            description: desc,
            domain: this.inferDomain(target),
            inputs: [],
            outputs: [],
            sideEffects: [],
            children: [],
            sourceAST: { type: stmt.type, name: stmt.name, loc: stmt.loc },
          });
          break;
        }

        case ASTNodeType.COBOL_CALL_NODE: {
          const target = (stmt.meta['target'] as string) || stmt.name;
          const params = (stmt.meta['params'] as string[]) || [];
          children.push({
            id: this.nextId(),
            type: SemanticNodeType.EXTERNAL_CALL,
            description: `Call external program: ${this.humanize(target)}`,
            domain: this.inferDomain(target),
            inputs: params.map(p => this.humanizeVariable(p)),
            outputs: [],
            sideEffects: [`Invokes ${target}`],
            children: [],
            sourceAST: { type: stmt.type, name: stmt.name, loc: stmt.loc },
          });
          sideEffects.push(`Calls ${target}`);
          break;
        }

        case ASTNodeType.COBOL_EXEC_SQL_NODE: {
          const operation = (stmt.meta['operation'] as string) || 'UNKNOWN';
          const table = (stmt.meta['table'] as string) || 'UNKNOWN';
          const tables = normalizeStringArray(stmt.meta['tables']);
          const columns = normalizeStringArray(stmt.meta['columns']);
          const hostVariables = normalizeStringArray(stmt.meta['hostVariables']);
          const cleanTables = (tables.length > 0 ? tables : [table])
            .map((value) => value.replace(/^:/, ''))
            .filter((value) => value && value !== 'UNKNOWN');
          const cleanTable = cleanTables[0] ?? table.replace(/^:/, '');
          const desc = describeSQLOperation(operation, cleanTables.join(', ') || table);

          if (operation === 'SELECT' || operation === 'DECLARE_CURSOR' || operation === 'FETCH' || operation === 'OPEN') {
            inputs.push(...cleanTables);
          } else {
            outputs.push(...cleanTables);
          }
          if (operation !== 'SELECT' && operation !== 'DECLARE_CURSOR' && operation !== 'FETCH' && operation !== 'OPEN') {
            sideEffects.push(desc);
          }

          children.push({
            id: this.nextId(),
            type: SemanticNodeType.DATA_ACCESS,
            description: columns.length > 0
              ? `${desc} columns ${columns.join(', ')}`
              : desc,
            domain: this.inferDomain(cleanTable),
            inputs: [
              ...(operation === 'SELECT' || operation === 'DECLARE_CURSOR' || operation === 'FETCH' || operation === 'OPEN' ? cleanTables : []),
              ...hostVariables.map((value) => this.humanizeVariable(value)),
            ],
            outputs: operation !== 'SELECT' && operation !== 'DECLARE_CURSOR' && operation !== 'FETCH' && operation !== 'OPEN'
              ? cleanTables
              : [],
            sideEffects: operation !== 'SELECT' && operation !== 'DECLARE_CURSOR' && operation !== 'FETCH' && operation !== 'OPEN'
              ? [desc]
              : [],
            children: [],
            sourceAST: { type: stmt.type, name: stmt.name, loc: stmt.loc },
          });
          break;
        }

        case ASTNodeType.COBOL_EXEC_CICS_NODE: {
          const command = (stmt.meta['command'] as string) || 'UNKNOWN';
          const target = (stmt.meta['target'] as string) || '';
          const targetType = (stmt.meta['targetType'] as string) || 'UNKNOWN';
          const semanticType = command === 'LINK' || command === 'XCTL'
            ? SemanticNodeType.EXTERNAL_CALL
            : SemanticNodeType.TRANSACTION;
          const description = target
            ? `CICS ${command} ${targetType.toLowerCase()}: ${target}`
            : `CICS Transaction: ${command}`;
          children.push({
            id: this.nextId(),
            type: semanticType,
            description,
            domain: target ? this.inferDomain(target) : BusinessDomain.GENERAL,
            inputs: [],
            outputs: target ? [target] : [],
            sideEffects: [`CICS ${command}`],
            children: [],
            sourceAST: { type: stmt.type, name: stmt.name, loc: stmt.loc },
          });
          sideEffects.push(description);
          break;
        }

        case ASTNodeType.COBOL_COMPUTE_NODE: {
          const target = (stmt.meta['target'] as string) || 'UNKNOWN';
          const expression = (stmt.meta['expression'] as string) || '';
          const exprVars = this.extractVariablesFromExpression(expression);
          children.push({
            id: this.nextId(),
            type: SemanticNodeType.BUSINESS_RULE,
            description: `Calculate ${this.humanizeVariable(target)} = ${this.humanizeExpression(expression)}`,
            domain: this.inferDomain(target),
            inputs: exprVars.map(v => this.humanizeVariable(v)),
            outputs: [this.humanizeVariable(target)],
            sideEffects: [],
            children: [],
            sourceAST: { type: stmt.type, name: stmt.name, loc: stmt.loc },
          });
          break;
        }

        case ASTNodeType.COBOL_MOVE_NODE: {
          const source = (stmt.meta['source'] as string) || '';
          const target = (stmt.meta['target'] as string) || '';
          children.push({
            id: this.nextId(),
            type: SemanticNodeType.DATA_TRANSFORM,
            description: `Assign ${this.humanizeVariable(target)} from ${this.humanizeVariable(source)}`,
            domain: this.inferDomain(target),
            inputs: [this.humanizeVariable(source)],
            outputs: [this.humanizeVariable(target)],
            sideEffects: [],
            children: [],
            sourceAST: { type: stmt.type, name: stmt.name, loc: stmt.loc },
          });
          break;
        }

        case ASTNodeType.COBOL_IF_NODE: {
          const condition = (stmt.meta['condition'] as string) || '';
          const condVars = this.extractVariablesFromExpression(condition);

          // Recursively elevate children inside the IF block
          const ifChildren: SemanticNode[] = [];
          for (const child of stmt.children) {
            if (child.type === ASTNodeType.COBOL_COMPUTE_NODE) {
              const target = (child.meta['target'] as string) || 'UNKNOWN';
              const expression = (child.meta['expression'] as string) || '';
              const exprVars = this.extractVariablesFromExpression(expression);
              ifChildren.push({
                id: this.nextId(),
                type: SemanticNodeType.BUSINESS_RULE,
                description: `Calculate ${this.humanizeVariable(target)} = ${this.humanizeExpression(expression)}`,
                domain: this.inferDomain(target),
                inputs: exprVars.map(v => this.humanizeVariable(v)),
                outputs: [this.humanizeVariable(target)],
                sideEffects: [],
                children: [],
                sourceAST: { type: child.type, name: child.name, loc: child.loc },
              });
            } else if (child.type === ASTNodeType.COBOL_MOVE_NODE) {
              const source = (child.meta['source'] as string) || '';
              const target = (child.meta['target'] as string) || '';
              ifChildren.push({
                id: this.nextId(),
                type: SemanticNodeType.BUSINESS_RULE,
                description: `Set ${this.humanizeVariable(target)} to ${this.humanizeVariable(source)}`,
                domain: this.inferDomain(target),
                inputs: [this.humanizeVariable(source)],
                outputs: [this.humanizeVariable(target)],
                sideEffects: [],
                children: [],
                sourceAST: { type: child.type, name: child.name, loc: child.loc },
              });
            } else if (child.type === ASTNodeType.COBOL_PERFORM_NODE) {
              const target = (child.meta['target'] as string) || child.name;
              ifChildren.push({
                id: this.nextId(),
                type: SemanticNodeType.CONTROL_FLOW,
                description: `Execute ${this.humanize(target)}`,
                domain: this.inferDomain(target),
                inputs: [],
                outputs: [],
                sideEffects: [],
                children: [],
                sourceAST: { type: child.type, name: child.name, loc: child.loc },
              });
            }
          }

          // The IF condition itself is a BUSINESS_RULE (decision point)
          children.push({
            id: this.nextId(),
            type: SemanticNodeType.BUSINESS_RULE,
            description: `Decision: ${this.humanizeCondition(condition)}`,
            domain: condVars.length > 0 ? this.inferDomain(condVars[0]) : domain,
            inputs: condVars.map(v => this.humanizeVariable(v)),
            outputs: [],
            sideEffects: [],
            children: ifChildren,
            sourceAST: { type: stmt.type, name: stmt.name, loc: stmt.loc },
          });
          break;
        }

        case ASTNodeType.COBOL_COPY_NODE: {
          const copybook = (stmt.meta['copybook'] as string) || stmt.name;
          children.push({
            id: this.nextId(),
            type: SemanticNodeType.DEPENDENCY,
            description: `Includes data layout: ${this.humanize(copybook)}`,
            domain: this.inferDomain(copybook),
            inputs: [],
            outputs: [],
            sideEffects: [],
            children: [],
            sourceAST: { type: stmt.type, name: stmt.name, loc: stmt.loc },
          });
          break;
        }

        case ASTNodeType.COBOL_EVALUATE_NODE: {
          const subject = (stmt.meta['subject'] as string) || 'UNKNOWN';
          const whenChildren: SemanticNode[] = [];

          for (const when of stmt.children) {
            if (when.type === ASTNodeType.COBOL_WHEN_NODE) {
              const condition = (when.meta['condition'] as string) || 'UNKNOWN';
              const branchChildren: SemanticNode[] = [];

              // Elevate the statements inside each WHEN branch
              for (const branchStmt of when.children) {
                if (branchStmt.type === ASTNodeType.COBOL_PERFORM_NODE) {
                  const target = (branchStmt.meta['target'] as string) || branchStmt.name;
                  branchChildren.push({
                    id: this.nextId(),
                    type: SemanticNodeType.CONTROL_FLOW,
                    description: `Execute ${this.humanize(target)}`,
                    domain: this.inferDomain(target),
                    inputs: [],
                    outputs: [],
                    sideEffects: [],
                    children: [],
                    sourceAST: { type: branchStmt.type, name: branchStmt.name, loc: branchStmt.loc },
                  });
                } else if (branchStmt.type === ASTNodeType.COBOL_MOVE_NODE) {
                  const source = (branchStmt.meta['source'] as string) || '';
                  const target = (branchStmt.meta['target'] as string) || '';
                  branchChildren.push({
                    id: this.nextId(),
                    type: SemanticNodeType.DATA_TRANSFORM,
                    description: `Assign ${this.humanizeVariable(target)} from ${this.humanizeVariable(source)}`,
                    domain: this.inferDomain(target),
                    inputs: [this.humanizeVariable(source)],
                    outputs: [this.humanizeVariable(target)],
                    sideEffects: [],
                    children: [],
                    sourceAST: { type: branchStmt.type, name: branchStmt.name, loc: branchStmt.loc },
                  });
                }
              }

              whenChildren.push({
                id: this.nextId(),
                type: SemanticNodeType.CONTROL_FLOW,
                description: `When ${this.humanizeCondition(condition)}`,
                domain: this.inferDomain(condition),
                inputs: [],
                outputs: [],
                sideEffects: [],
                children: branchChildren,
                sourceAST: { type: when.type, name: when.name, loc: when.loc },
              });
            }
          }

          children.push({
            id: this.nextId(),
            type: SemanticNodeType.CONTROL_FLOW,
            description: `Dispatch on ${this.humanizeVariable(subject)}`,
            domain: this.inferDomain(subject),
            inputs: [this.humanizeVariable(subject)],
            outputs: [],
            sideEffects: [],
            children: whenChildren,
            sourceAST: { type: stmt.type, name: stmt.name, loc: stmt.loc },
          });
          break;
        }
      }
    }

    // Generate a high-level business description for the paragraph
    const description = this.generateParagraphDescription(para.name, children, inputs, outputs, sideEffects);

    return {
      id: this.nextId(),
      type: SemanticNodeType.BUSINESS_RULE,
      description,
      domain,
      inputs,
      outputs,
      sideEffects,
      children,
      sourceAST: { type: para.type, name: para.name, loc: para.loc },
    };
  }

  private elevateVariable(v: ASTNode): SemanticNode {
    const pic = (v.meta['pic'] as string) || '';
    const meaning = inferVariableMeaning(v.name, pic);

    // Elevate Level 88 condition names as children
    const l88Children: SemanticNode[] = [];
    for (const child of v.children) {
      if (child.type === ASTNodeType.COBOL_CONDITION_88_NODE) {
        const condValue = (child.meta['conditionValue'] as string) || '';
        l88Children.push({
          id: this.nextId(),
          type: SemanticNodeType.DATA_DEFINITION,
          description: `Condition: ${this.humanize(child.name)} = ${condValue}`,
          domain: this.inferDomain(child.name),
          inputs: [],
          outputs: [],
          sideEffects: [],
          children: [],
          sourceAST: { type: child.type, name: child.name, loc: child.loc },
        });
      }
    }

    return {
      id: this.nextId(),
      type: SemanticNodeType.DATA_DEFINITION,
      description: `${meaning}: ${this.humanizeVariable(v.name)}`,
      domain: this.inferDomain(v.name),
      inputs: [],
      outputs: [],
      sideEffects: [],
      children: l88Children,
      sourceAST: { type: v.type, name: v.name, loc: v.loc },
    };
  }

  private elevateRedefines(node: ASTNode): SemanticNode {
    const redefinesTarget = (node.meta['redefinesTarget'] as string) || 'UNKNOWN';
    const pic = (node.meta['pic'] as string) || '';

    // Elevate child sub-fields
    const childNodes: SemanticNode[] = [];
    for (const child of node.children) {
      if (child.type === ASTNodeType.COBOL_VARIABLE_NODE) {
        childNodes.push(this.elevateVariable(child));
      }
    }

    return {
      id: this.nextId(),
      type: SemanticNodeType.DATA_DEFINITION,
      description: `Memory overlay: ${this.humanizeVariable(node.name)} reinterprets ${this.humanizeVariable(redefinesTarget)}${pic ? ` as ${pic}` : ''}`,
      domain: this.inferDomain(node.name),
      inputs: [this.humanizeVariable(redefinesTarget)],
      outputs: [this.humanizeVariable(node.name)],
      sideEffects: [],
      children: childNodes,
      sourceAST: { type: node.type, name: node.name, loc: node.loc },
    };
  }

  // ---- Deterministic Humanization (No LLM) ----
  /**
   * Convert COBOL naming conventions to human-readable text.
   * Uses configurable prefix stripping.
   */
  private humanize(name: string): string {
    let result = name;
    for (const prefix of this.config.stripPrefixes) {
      if (result.toUpperCase().startsWith(prefix)) {
        result = result.substring(prefix.length);
        break;
      }
    }
    for (const [dsPrefix, replacement] of Object.entries(this.config.datasetPrefixes)) {
      if (result.toUpperCase().startsWith(dsPrefix.toUpperCase())) {
        result = replacement + ' ' + result.substring(dsPrefix.length);
        break;
      }
    }
    return result
      .replace(/\./g, ' ')
      .replace(/-/g, ' ')
      .replace(/\b\w/g, (c) => c.toUpperCase())
      .trim();
  }

  private humanizeVariable(name: string): string {
    // Check symbol overrides first
    const override = this.config.symbolOverrides[name.toUpperCase()];
    if (override) return override.meaning;

    let result = name.replace(/^:/, '');
    for (const prefix of this.config.stripPrefixes) {
      if (result.toUpperCase().startsWith(prefix)) {
        result = result.substring(prefix.length);
        break;
      }
    }
    return result
      .replace(/-/g, ' ')
      .replace(/\b\w/g, (c) => c.toUpperCase())
      .trim();
  }

  private humanizeDataset(dsn: string): string {
    let result = dsn;
    for (const [dsPrefix, replacement] of Object.entries(this.config.datasetPrefixes)) {
      if (result.toUpperCase().startsWith(dsPrefix.toUpperCase())) {
        result = replacement + ' ' + result.substring(dsPrefix.length);
        break;
      }
    }
    return result
      .replace(/\./g, ' ')
      .replace(/\b\w/g, (c) => c.toUpperCase())
      .trim();
  }

  private humanizeCondition(cond: string): string {
    let result = cond;
    for (const prefix of this.config.stripPrefixes) {
      result = result.replace(new RegExp(prefix.replace('-', '\\-'), 'gi'), '');
    }
    return result
      .replace(/-/g, ' ')
      .replace(/=/g, ' equals ')
      .replace(/>/g, ' greater than ')
      .replace(/</g, ' less than ')
      .replace(/'/g, '"')
      .toLowerCase()
      .trim();
  }

  private humanizeExpression(expr: string): string {
    let result = expr;
    for (const prefix of this.config.stripPrefixes) {
      result = result.replace(new RegExp(prefix.replace('-', '\\-'), 'gi'), '');
    }
    return result
      .replace(/-/g, ' ')
      .replace(/\*/g, ' × ')
      .replace(/\//g, ' ÷ ')
      .toLowerCase()
      .trim();
  }

  // ---- Domain Inference ----

  private inferDomain(name: string): BusinessDomain {
    // Check symbol overrides first
    const override = this.config.symbolOverrides[name.toUpperCase()];
    if (override) {
      const bd = Object.values(BusinessDomain).find(d => d === override.domain);
      if (bd) return bd;
    }

    const upper = name.toUpperCase().replace(/-/g, '').replace(/\./g, '');
    for (const [keyword, domain] of Object.entries(DOMAIN_KEYWORDS)) {
      if (upper.includes(keyword)) return domain;
    }
    return BusinessDomain.GENERAL;
  }

  // ---- Helpers ----

  private collectInputDatasets(job: ASTNode): string[] {
    const inputs: string[] = [];
    for (const step of job.children) {
      for (const dd of step.children) {
        if (dd.type !== ASTNodeType.JCL_DD) continue;
        const disp = ((dd.meta['disp'] as string) || '').toUpperCase();
        const dsn = (dd.meta['dsn'] as string) || '';
        if (dsn && (disp.includes('SHR') || disp.includes('OLD'))) {
          inputs.push(this.humanizeDataset(dsn));
        }
      }
    }
    return [...new Set(inputs)];
  }

  private collectOutputDatasets(job: ASTNode): string[] {
    const outputs: string[] = [];
    for (const step of job.children) {
      for (const dd of step.children) {
        if (dd.type !== ASTNodeType.JCL_DD) continue;
        const disp = ((dd.meta['disp'] as string) || '').toUpperCase();
        const dsn = (dd.meta['dsn'] as string) || '';
        if (dsn && (disp.includes('NEW') || disp.includes('MOD'))) {
          outputs.push(this.humanizeDataset(dsn));
        }
      }
    }
    return [...new Set(outputs)];
  }

  private extractVariablesFromExpression(expr: string): string[] {
    // Extract COBOL variable references (WS-xxx or alphanumeric tokens)
    const matches = expr.match(/[A-Z][A-Z0-9-]+/g) || [];
    return matches.filter(m => m !== 'OF' && m !== 'IN' && m.length > 2);
  }

  /**
   * Generate a paragraph-level business description
   * by composing the child semantic nodes deterministically.
   */
  private generateParagraphDescription(
    name: string,
    children: SemanticNode[],
    inputs: string[],
    outputs: string[],
    sideEffects: string[],
  ): string {
    const humanName = this.humanize(name);

    // If the paragraph has a clear single purpose, describe it
    const hasSQL = children.some(c => c.type === SemanticNodeType.DATA_ACCESS);
    const hasCompute = children.some(c => c.type === SemanticNodeType.BUSINESS_RULE);
    const hasCall = children.some(c => c.type === SemanticNodeType.EXTERNAL_CALL);
    const hasCICS = children.some(c => c.type === SemanticNodeType.TRANSACTION);

    const parts: string[] = [humanName + ':'];

    if (hasSQL && inputs.length > 0) {
      parts.push(`reads from ${inputs.join(', ')}`);
    }
    if (hasCompute) {
      const computeDescs = children
        .filter(c => c.type === SemanticNodeType.BUSINESS_RULE && c.sourceAST.type === 'COBOL_COMPUTE_NODE')
        .map(c => c.description);
      if (computeDescs.length > 0) parts.push(computeDescs.join('; '));
    }
    if (hasSQL && outputs.length > 0) {
      parts.push(`writes to ${outputs.join(', ')}`);
    }
    if (hasCall) {
      const callDescs = children.filter(c => c.type === SemanticNodeType.EXTERNAL_CALL).map(c => c.description);
      parts.push(callDescs.join('; '));
    }
    if (hasCICS) {
      parts.push('commits CICS transaction');
    }

    return parts.join(' — ');
  }

  private elevateGeneric(ast: ASTNode): SemanticNode {
    return {
      id: this.nextId(),
      type: SemanticNodeType.GENERAL as unknown as SemanticNodeType,
      description: this.humanize(ast.name),
      domain: BusinessDomain.GENERAL,
      inputs: [],
      outputs: [],
      sideEffects: [],
      children: ast.children.map(c => this.elevate(c)),
      sourceAST: { type: ast.type, name: ast.name, loc: ast.loc },
    };
  }
}
