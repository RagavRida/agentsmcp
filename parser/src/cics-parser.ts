export type CICSOperation =
  | 'SEND'
  | 'RECEIVE'
  | 'READ'
  | 'WRITE'
  | 'REWRITE'
  | 'DELETE'
  | 'LINK'
  | 'XCTL'
  | 'START'
  | 'RETURN'
  | 'SYNCPOINT'
  | 'ABEND'
  | 'UNKNOWN';

export interface CICSCommand {
  operation: CICSOperation;
  target?: string;
  targetType?: 'PROGRAM' | 'TRANSACTION' | 'FILE' | 'MAP' | 'QUEUE' | 'TERMINAL' | 'UNKNOWN';
  program?: string;
  transid?: string;
  file?: string;
  map?: string;
  mapset?: string;
  queue?: string;
  channel?: string;
  commarea?: string;
  options: Record<string, string>;
  raw: string;
}

const KNOWN_OPERATIONS: CICSOperation[] = [
  'SEND',
  'RECEIVE',
  'READ',
  'WRITE',
  'REWRITE',
  'DELETE',
  'LINK',
  'XCTL',
  'START',
  'RETURN',
  'SYNCPOINT',
  'ABEND',
];

export function parseCICS(rawCommand: string): CICSCommand {
  const raw = rawCommand
    .replace(/\bEXEC\s+CICS\b/i, '')
    .replace(/\bEND-EXEC\b\.?/i, '')
    .trim();
  const normalized = raw.replace(/\s+/g, ' ').trim();
  const upper = normalized.toUpperCase();
  const operation = detectOperation(upper);
  const options = extractOptions(normalized);

  const program = firstOption(options, ['PROGRAM']);
  const transid = firstOption(options, ['TRANSID']);
  const file = firstOption(options, ['FILE', 'DATASET']);
  const map = firstOption(options, ['MAP']);
  const mapset = firstOption(options, ['MAPSET']);
  const queue = firstOption(options, ['QUEUE', 'QNAME', 'TDQUEUE', 'TSQUEUE']);
  const channel = firstOption(options, ['CHANNEL']);
  const commarea = firstOption(options, ['COMMAREA']);
  const targetInfo = resolveTarget(operation, { program, transid, file, map, queue });

  return {
    operation,
    target: targetInfo.target,
    targetType: targetInfo.targetType,
    program,
    transid,
    file,
    map,
    mapset,
    queue,
    channel,
    commarea,
    options,
    raw,
  };
}

function detectOperation(command: string): CICSOperation {
  const firstToken = command.split(/\s+/)[0] as CICSOperation | undefined;
  if (firstToken && KNOWN_OPERATIONS.includes(firstToken)) return firstToken;
  return 'UNKNOWN';
}

function extractOptions(command: string): Record<string, string> {
  const options: Record<string, string> = {};
  const pattern = /\b([A-Z][A-Z0-9-]*)\s*(?:\(\s*(?:"([^"]*)"|'([^']*)'|([^)]*?))\s*\))?/gi;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(command)) !== null) {
    const key = match[1].toUpperCase();
    if (KNOWN_OPERATIONS.includes(key as CICSOperation)) continue;
    const value = (match[2] ?? match[3] ?? match[4] ?? '').trim();
    options[key] = value;
  }
  return options;
}

function firstOption(options: Record<string, string>, names: string[]): string | undefined {
  for (const name of names) {
    const value = options[name];
    if (value) return value.replace(/^:/, '').trim();
  }
  return undefined;
}

function resolveTarget(
  operation: CICSOperation,
  values: {
    program?: string;
    transid?: string;
    file?: string;
    map?: string;
    queue?: string;
  }
): Pick<CICSCommand, 'target' | 'targetType'> {
  if ((operation === 'LINK' || operation === 'XCTL') && values.program) {
    return { target: values.program, targetType: 'PROGRAM' };
  }
  if ((operation === 'START' || operation === 'RETURN') && values.transid) {
    return { target: values.transid, targetType: 'TRANSACTION' };
  }
  if (['READ', 'WRITE', 'REWRITE', 'DELETE'].includes(operation) && values.file) {
    return { target: values.file, targetType: 'FILE' };
  }
  if ((operation === 'SEND' || operation === 'RECEIVE') && values.map) {
    return { target: values.map, targetType: 'MAP' };
  }
  if (values.queue) {
    return { target: values.queue, targetType: 'QUEUE' };
  }
  return { targetType: 'UNKNOWN' };
}
