/**
 * 在途工具调用计数，进程级单例。
 *
 * dispatcher 在每次调用开始/结束时增减，shutdown 在关闭 stdio 传输前读取并
 * 等待归零，避免打断正在提交的写操作。
 */
let inFlightCount = 0;

const begin = (): void => {
    inFlightCount += 1;
};

const end = (): void => {
    // 下溢说明配对错误，保持在 0 而不是变成负数，免得排空判断永远为真。
    if (inFlightCount > 0) {
        inFlightCount -= 1;
    }
};

const count = (): number => inFlightCount;

/** 供 shutdown 的 InFlightCounterReader 使用的只读视图。 */
const inFlight = { count };

export { begin, end, count, inFlight };
