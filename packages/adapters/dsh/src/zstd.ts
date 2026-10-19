/**
 * DSH 会话日志的 Zstandard 多帧容器读写。
 *
 * 格式事实（2026-10-19 实测本机 ~/.dsh + 反编译 app.asar 内
 * @deepseek-ai/dsh-session-persistence-jsonl/lib/index.js 的 scanZstdFrames 确认）：
 * - session.v4.jsonl.zstd 是多个独立 zstd 帧的简单拼接；
 * - 第一帧必须恰好是一行 JSONL 会话头（assertIndependentHeaderFrame），
 *   之后每一帧是应用一次（或一批）追加的 JSONL 行；
 * - Node 24 的 zlib.zstdDecompressSync 只解第一帧（实测 912KB → 224B），
 *   所以读端必须按帧头结构自行切分；
 * - 写端每帧都带 checksum（ZSTD_c_checksumFlag=1），与官方实现一致；
 * - 末尾允许存在"撕裂帧"（进程崩溃时写了一半）：官方 restore 会用
 *   ZSTD_e_flush 尽力恢复出完整行，当前代验证则拒绝。这里读端容忍并记录。
 */
import { mkdir, open, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { constants, zstdCompressSync, zstdDecompressSync } from 'node:zlib';

const ZSTD_MAGIC = 0xfd2fb528; // 字节序列 28 B5 2F FD
const SKIPPABLE_MASK = 0xfffffff0;
const SKIPPABLE_MAGIC = 0x184d2a50;
const CHECKSUM_OPTIONS = { params: { [constants.ZSTD_c_checksumFlag]: 1 } };
const INCOMPLETE_FRAME_OPTIONS = { finishFlush: constants.ZSTD_e_flush } as const;

export interface ZstdFrame {
  /** 帧起始偏移（含 magic） */
  start: number;
  /** 帧结束偏移（不含） */
  end: number;
}

export interface ZstdScan {
  frames: ZstdFrame[];
  /** 末尾不完整帧的起始偏移；无撕裂帧时为 undefined */
  tornStart?: number;
}

/**
 * 按官方实现逐字节扫描帧结构，不依赖解压。
 * 遇到非法 magic / 保留位 / 保留 block 类型时抛错（损坏日志）。
 */
export function scanZstdFrames(buffer: Buffer): ZstdScan {
  const frames: ZstdFrame[] = [];
  let offset = 0;
  while (offset < buffer.length) {
    const start = offset;
    if (buffer.length - offset < 4) return { frames, tornStart: start };
    const magic = buffer.readUInt32LE(offset);
    if ((magic & SKIPPABLE_MASK) === SKIPPABLE_MAGIC) {
      if (buffer.length - offset < 8) return { frames, tornStart: start };
      const size = buffer.readUInt32LE(offset + 4);
      if (buffer.length - offset - 8 < size) return { frames, tornStart: start };
      offset += 8 + size;
      continue;
    }
    if (magic !== ZSTD_MAGIC) {
      throw new Error('corrupt Zstandard session log: invalid frame magic at byte ' + offset);
    }
    offset += 4;
    if (offset === buffer.length) return { frames, tornStart: start };
    const descriptor = buffer.readUInt8(offset);
    offset += 1;
    if ((descriptor & 24) !== 0) {
      throw new Error('corrupt Zstandard session log: reserved frame-header bit at byte ' + (offset - 1));
    }
    const contentSizeFlag = descriptor >>> 6;
    const singleSegment = (descriptor & 32) !== 0;
    const checksum = (descriptor & 4) !== 0;
    const dictionaryFlag = descriptor & 3;
    const dictionaryBytes = dictionaryFlag === 3 ? 4 : dictionaryFlag;
    const contentSizeBytes = contentSizeFlag === 0 ? (singleSegment ? 1 : 0) : 1 << contentSizeFlag;
    const remainingHeaderBytes = (singleSegment ? 0 : 1) + dictionaryBytes + contentSizeBytes;
    if (buffer.length - offset < remainingHeaderBytes) return { frames, tornStart: start };
    offset += remainingHeaderBytes;
    for (;;) {
      if (buffer.length - offset < 3) return { frames, tornStart: start };
      const blockHeader = buffer.readUIntLE(offset, 3);
      offset += 3;
      const lastBlock = (blockHeader & 1) !== 0;
      const blockType = (blockHeader >>> 1) & 3;
      const blockSize = blockHeader >>> 3;
      if (blockType === 3) {
        throw new Error('corrupt Zstandard session log: reserved block type at byte ' + (offset - 3));
      }
      const payloadBytes = blockType === 1 ? 1 : blockSize;
      if (buffer.length - offset < payloadBytes) return { frames, tornStart: start };
      offset += payloadBytes;
      if (lastBlock) break;
    }
    if (checksum) {
      if (buffer.length - offset < 4) return { frames, tornStart: start };
      offset += 4;
    }
    frames.push({ start, end: offset });
  }
  return { frames };
}

export interface ZstdJsonl {
  /** 解出的 JSONL 文本（撕裂帧只保留到最后一个完整换行） */
  text: string;
  /** 非空行 */
  lines: string[];
  frames: ZstdFrame[];
  /** 存在未完整写入的尾帧时为该帧起点 */
  tornStart?: number;
  /** 文件字节数 */
  bytes: number;
}

/** 从内存 buffer 解出多帧 JSONL；容忍尾部撕裂帧。 */
export function decompressZstdJsonl(buffer: Buffer): ZstdJsonl {
  const scan = scanZstdFrames(buffer);
  if (scan.frames.length === 0) {
    throw new Error('empty or header-less Zstandard session log');
  }
  const chunks: Buffer[] = [];
  for (const frame of scan.frames) {
    chunks.push(zstdDecompressSync(buffer.subarray(frame.start, frame.end)));
  }
  let text = Buffer.concat(chunks).toString('utf8');
  if (scan.tornStart !== undefined) {
    let recovered: Buffer | undefined;
    try {
      recovered = zstdDecompressSync(buffer.subarray(scan.tornStart), INCOMPLETE_FRAME_OPTIONS);
    } catch {
      recovered = undefined;
    }
    if (recovered !== undefined && recovered.length > 0) {
      const recoveredText = recovered.toString('utf8');
      const newline = recoveredText.lastIndexOf('\n');
      if (newline !== -1) text += recoveredText.slice(0, newline + 1);
    }
  }
  const lines = text.split('\n').filter((line) => line.trim().length > 0);
  return { text, lines, frames: scan.frames, tornStart: scan.tornStart, bytes: buffer.length };
}

/** 读取并解压一个 DSH JSONL.ZSTD 文件。 */
export async function readZstdJsonl(path: string): Promise<ZstdJsonl> {
  return decompressZstdJsonl(await readFile(path));
}

/**
 * 只读文件头部第一帧（会话头）的原始文本，避免为发现子会话解压整个大文件。
 * 先尝试读取前 16KB；若首帧更大再回退整文件读取。
 */
export async function readZstdHeaderLine(path: string): Promise<string> {
  const handle = await open(path, 'r');
  try {
    const stat = await handle.stat();
    const size = Math.min(stat.size, 16384);
    const buffer = Buffer.alloc(size);
    const { bytesRead } = await handle.read(buffer, 0, size, 0);
    const head = buffer.subarray(0, bytesRead);
    const scan = scanZstdFrames(head);
    if (scan.frames.length > 0) {
      const first = zstdDecompressSync(head.subarray(scan.frames[0]!.start, scan.frames[0]!.end));
      const text = first.toString('utf8');
      const newline = text.indexOf('\n');
      return (newline === -1 ? text : text.slice(0, newline)).trim();
    }
  } finally {
    await handle.close();
  }
  const jsonl = await readZstdJsonl(path);
  const firstLine = jsonl.lines[0];
  if (firstLine === undefined) throw new Error('empty Zstandard session log: ' + path);
  return firstLine;
}

export interface WriteZstdOptions {
  /** 会话头占几行（DSH v4 必须为 1，单独一帧） */
  headerLines?: number;
  /** 之后每帧装几行（默认 1，与官方"一次追加一帧"一致） */
  batchSize?: number;
  /** 压缩级别（默认 zstd 默认级别） */
  level?: number;
}

export interface WriteZstdResult {
  frames: number;
  bytes: number;
}

/** 把 JSONL 行写成多帧 zstd 容器（首帧单独放会话头）。 */
export async function writeZstdJsonl(path: string, lines: string[], options: WriteZstdOptions = {}): Promise<WriteZstdResult> {
  const headerLines = options.headerLines ?? 1;
  const batchSize = Math.max(1, options.batchSize ?? 1);
  const compressed: Buffer[] = [];
  let index = 0;
  if (headerLines > 0 && lines.length > 0) {
    const head = lines.slice(0, headerLines).join('\n') + '\n';
    compressed.push(zstdCompressSync(Buffer.from(head, 'utf8'), CHECKSUM_OPTIONS));
    index = headerLines;
  }
  while (index < lines.length) {
    const batch = lines.slice(index, index + batchSize);
    const chunk = batch.join('\n') + '\n';
    compressed.push(zstdCompressSync(Buffer.from(chunk, 'utf8'), CHECKSUM_OPTIONS));
    index += batch.length;
  }
  const body = Buffer.concat(compressed);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, body);
  return { frames: compressed.length, bytes: body.length };
}
