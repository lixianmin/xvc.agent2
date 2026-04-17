type LogLevel = 'DEBUG' | 'INFO' | 'WARN' | 'ERROR';

type LogEntry = {
  ts: string;
  level: LogLevel;
  module: string;
  msg: string;
  data?: Record<string, unknown>;
};

function ts(): string {
  return new Date().toLocaleString('sv-SE', { timeZone: 'Asia/Shanghai', fractionalSecondDigits: 3 }).replace(',', '.');
}

function write(level: LogLevel, module: string, msg: string, data?: Record<string, unknown>) {
  const entry: LogEntry = { ts: ts(), level, module, msg };
  if (data) entry.data = data;
  console.log(JSON.stringify(entry));
}

export const log = {
  debug: (module: string, msg: string, data?: Record<string, unknown>) => write('DEBUG', module, msg, data),
  info: (module: string, msg: string, data?: Record<string, unknown>) => write('INFO', module, msg, data),
  warn: (module: string, msg: string, data?: Record<string, unknown>) => write('WARN', module, msg, data),
  error: (module: string, msg: string, data?: Record<string, unknown>) => write('ERROR', module, msg, data),
};
