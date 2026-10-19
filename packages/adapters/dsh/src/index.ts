export { readDshSession, summarizeDshBundle, DSH_AGENT } from './read.ts';
export type { DshEvent, DshHeader, ReadDshOptions } from './read.ts';
export { writeDshSession, printWriteReport, DSH_CAPS } from './write.ts';
export type { DshEventLine, DshExportCaps, DshSessionHeaderLine, WriteDshOptions, WriteDshResult } from './write.ts';
export { verifyDshSession, resumeSmokeDsh, dshAppPaths } from './verify.ts';
export type { DshResumeSmokeOptions, DshResumeSmokeResult, VerifyCheck, VerifyDshOptions, VerifyDshReport } from './verify.ts';
export {
  dshHome,
  dshSessionDir,
  dshSessionFilePath,
  encodeSegment,
  findLogInDir,
  projectDir,
  projectKey,
  readdirSafe,
  resolveDshSessionPath,
  sessionLogFilename,
  sessionsRoot,
} from './paths.ts';
export type { ResolvedDshSession } from './paths.ts';
export { decompressZstdJsonl, readZstdHeaderLine, readZstdJsonl, scanZstdFrames, writeZstdJsonl } from './zstd.ts';
export type { WriteZstdOptions, WriteZstdResult, ZstdFrame, ZstdJsonl, ZstdScan } from './zstd.ts';
