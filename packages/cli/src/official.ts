/** 薄封装：核心逻辑在 @sessionport/core 的 official.ts，这里补 CLI 特有的「打开 app」 */
import { spawnSync } from 'node:child_process';

export {
  OFFICIAL_IMPORTS,
  officialSupport,
  planOfficialImport,
  verifyOfficialImport,
} from '@sessionport/core';
export type {
  OfficialImportOptions,
  OfficialImportResult,
  OfficialSupport,
  OfficialTarget,
  OfficialVerifyResult,
} from '@sessionport/core';

/** 打开目标 app（仅 CLI 使用；桌面端走自己的 shell.openPath） */
export function openTargetApp(target: 'zcode' | 'qoder' | 'cursor'): boolean {
  const appName = target === 'zcode' ? 'ZCode' : target === 'qoder' ? 'Qoder CN' : 'Cursor';
  const result = spawnSync('open', ['-a', appName], { stdio: 'ignore' });
  return result.status === 0;
}
