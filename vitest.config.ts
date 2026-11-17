import { defineConfig } from 'vitest/config';

export default defineConfig({
    test: {
        include: ['tests/unit/**/*.test.ts'],
        environment: 'node',
        // 编辑摘要的部分用例会触发 config 警告，别混进测试输出。
        env: { MCP_LOG_LEVEL: 'silent' },
        restoreMocks: true,
    },
});
