type LogLevel = 'DEBUG' | 'INFO' | 'WARN' | 'ERROR';

function ts(): string {
  const d = new Date(Date.now() + 8 * 3600 * 1000);
  const iso = d.toISOString();
  return iso.replace('T', ' ').replace('Z', '');
}

const LEVEL_PAD: Record<LogLevel, string> = {
  DEBUG: 'DEBUG',
  INFO:  'INFO ',
  WARN:  'WARN ',
  ERROR: 'ERROR',
};

function write(level: LogLevel, caller: string, msg: string, data?: Record<string, unknown>) {
  const lines: string[] = [];
  lines.push(`${ts()} ${LEVEL_PAD[level]} [${caller}] ${msg}`);
  if (data && Object.keys(data).length > 0) {
    lines.push(JSON.stringify(data, null, 2));
  }
  console.log(lines.join('\n'));
}

export const log = {
  debug: (caller: string, msg: string, data?: Record<string, unknown>) => write('DEBUG', caller, msg, data),
  info: (caller: string, msg: string, data?: Record<string, unknown>) => write('INFO', caller, msg, data),
  warn: (caller: string, msg: string, data?: Record<string, unknown>) => write('WARN', caller, msg, data),
  error: (caller: string, msg: string, data?: Record<string, unknown>) => write('ERROR', caller, msg, data),
};
