import { describe, expect, it } from 'vitest';
import { splitUploadDirList } from '../src/config/loadConfig.ts';

describe('MCP_UPLOAD_DIRS 拆分', () => {
    it('Windows 用分号分隔，盘符冒号保留在路径里', () => {
        expect(splitUploadDirList(String.raw`C:\assets;D:\wiki images`, 'win32')).toEqual([
            String.raw`C:\assets`,
            String.raw`D:\wiki images`,
        ]);
    });

    it('其他平台用冒号分隔', () => {
        expect(splitUploadDirList('/srv/assets:/home/me/wiki', 'linux')).toEqual([
            '/srv/assets',
            '/home/me/wiki',
        ]);
        expect(splitUploadDirList('/srv/a:/srv/b', 'darwin')).toEqual(['/srv/a', '/srv/b']);
    });

    it('去掉空白项与首尾空格', () => {
        expect(splitUploadDirList('  /a ;; /b ;', 'win32')).toEqual(['/a', '/b']);
        expect(splitUploadDirList(':/a::/b:', 'linux')).toEqual(['/a', '/b']);
    });

    it('空串得到空数组', () => {
        expect(splitUploadDirList('', 'win32')).toEqual([]);
        expect(splitUploadDirList('  ', 'linux')).toEqual([]);
    });
});
