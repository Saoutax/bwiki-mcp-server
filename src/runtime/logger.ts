// RFC 5424 的八级日志严重度，与每行 JSON 日志的 level 字段对应。
type LogLevel =
    | 'debug'
    | 'info'
    | 'notice'
    | 'warning'
    | 'error'
    | 'critical'
    | 'alert'
    | 'emergency';

type LogContext = Record<string, unknown>;

const RESERVED_KEYS = new Set<string>(['ts', 'level', 'message']);

const LEVEL_RANK: Record<LogLevel | 'silent', number> = {
    debug: 0,
    info: 1,
    notice: 2,
    warning: 3,
    error: 4,
    critical: 5,
    alert: 6,
    emergency: 7,
    silent: 8,
};

const isThresholdKey = (raw: string): raw is keyof typeof LEVEL_RANK =>
    Object.hasOwn(LEVEL_RANK, raw);

const currentThreshold = (): number => {
    const raw = process.env.MCP_LOG_LEVEL;
    if (raw === undefined || raw === '') {
        return LEVEL_RANK.debug;
    }
    if (!isThresholdKey(raw)) {
        const valid = Object.keys(LEVEL_RANK).join(', ');
        throw new Error(`Invalid MCP_LOG_LEVEL "${raw}". Valid values: ${valid}.`);
    }
    return LEVEL_RANK[raw];
};

const buildLogObject = (
    level: LogLevel,
    message: string,
    data?: LogContext,
): Record<string, unknown> => {
    const obj: Record<string, unknown> = {};
    if (data !== undefined) {
        for (const [key, value] of Object.entries(data)) {
            if (!RESERVED_KEYS.has(key)) {
                obj[key] = value;
            }
        }
    }
    obj.ts = new Date().toISOString();
    obj.level = level;
    if (message !== '') {
        obj.message = message;
    }
    return obj;
};

const emit = (level: LogLevel, message: string, data?: LogContext): void => {
    if (LEVEL_RANK[level] < currentThreshold()) {
        return;
    }
    const line = buildLogObject(level, message, data);
    process.stderr.write(JSON.stringify(line) + '\n');
};

// 输出带 `event` 字段的结构化事件行，用于 tool_call 等遥测。
const emitTelemetryEvent = (level: LogLevel, data: LogContext): void => {
    emit(level, '', data);
};

const logger = {
    debug: (message: string, data?: LogContext): void => emit('debug', message, data),
    info: (message: string, data?: LogContext): void => emit('info', message, data),
    notice: (message: string, data?: LogContext): void => emit('notice', message, data),
    warning: (message: string, data?: LogContext): void => emit('warning', message, data),
    error: (message: string, data?: LogContext): void => emit('error', message, data),
    critical: (message: string, data?: LogContext): void => emit('critical', message, data),
    alert: (message: string, data?: LogContext): void => emit('alert', message, data),
    emergency: (message: string, data?: LogContext): void => emit('emergency', message, data),
};

type Logger = typeof logger;
type LogMeta = LogContext;

export { logger, emitTelemetryEvent };
export type { LogLevel, LogContext, Logger, LogMeta };
