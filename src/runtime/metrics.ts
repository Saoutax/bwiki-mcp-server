/**
 * 工具调用指标。本项目仅 stdio 传输，无 /metrics 端点，故为空实现。
 */

interface RecordToolCallInput {
    readonly tool: string;
    readonly wiki: string;
    readonly outcome: string;
    readonly durationMs: number;
    readonly upstreamStatus: number | undefined;
}

const isMetricsEnabled = (): boolean => false;

const initMetrics = (): void => {
    // 无 /metrics 端点，空实现。
};

const recordToolCall = (_input: RecordToolCallInput): void => {
    // 空实现，见文件头。
};

const recordReadyFailure = (): void => {
    // 空实现：/ready 属 HTTP 传输。
};

const recordRateLimited = (_caller: 'caller' | 'anonymous'): void => {
    // 空实现：限流属 HTTP 传输。
};

const setInFlightProvider = (_fn: () => number): void => {
    // 空实现：在途统计属 HTTP 传输。
};

const setSubscriptionStreamsProvider = (_fn: () => number): void => {
    // 空实现：订阅流属 HTTP 传输。
};

const recordStoreFlush = (_durationMs: number): void => {
    // 空实现：OAuth 相关，本构建不含。
};

const recordStoreFlushFailure = (): void => {
    // 空实现：OAuth 相关，本构建不含。
};

const setProxyStoreStatsProvider = (
    _fn: () => { readonly upstreamTokens: number; readonly clients: number },
): void => {
    // 空实现：OAuth 相关，本构建不含。
};

const __resetMetricsForTesting = (): void => {
    // 空实现：保留以兼容上游测试接缝。
};

export {
    isMetricsEnabled,
    initMetrics,
    recordToolCall,
    recordReadyFailure,
    recordRateLimited,
    setInFlightProvider,
    setSubscriptionStreamsProvider,
    recordStoreFlush,
    recordStoreFlushFailure,
    setProxyStoreStatsProvider,
    __resetMetricsForTesting,
};
export type { RecordToolCallInput };
