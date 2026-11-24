import zlib from 'node:zlib';
import { promisify } from 'node:util';

const ZSTD_MAGIC = 0xFD2FB528; // 4247762216
const zstdCompressAsync = promisify(zlib.zstdCompress);
const zstdDecompressAsync = promisify(zlib.zstdDecompress);

const CHECKSUM_OPTIONS = Object.freeze({
  params: {
    [zlib.constants.ZSTD_c_checksumFlag]: 1,
  },
});

const INCOMPLETE_FRAME_OPTIONS = Object.freeze({
  finishFlush: zlib.constants.ZSTD_e_flush,
});

/**
 * Encode an arbitrary string as a single safe path segment, matching
 * `@deepseek-ai/dsh-session-persistence-jsonl`'s exact UTF-16 encoding.
 *
 * @param {string} raw
 * @returns {string}
 */
export function encodeSegment(raw) {
  if (typeof raw !== 'string' || raw.length === 0) {
    throw new Error('cannot encode an empty path segment');
  }
  if (raw === '.') return '~002E';
  if (raw === '..') return '~002E~002E';

  let out = '';
  for (let i = 0; i < raw.length; i++) {
    const code = raw.charCodeAt(i);
    const ch = String.fromCharCode(code);
    if (ch !== '~' && /^[A-Za-z0-9._-]$/.test(ch)) {
      out += ch;
    } else {
      out += '~' + code.toString(16).toUpperCase().padStart(4, '0');
    }
  }
  return out;
}

/**
 * Compute DSH's exact readable project directory key for a workspace `cwd`.
 *
 * @param {string} cwd
 * @returns {string}
 */
export function projectKey(cwd) {
  if (typeof cwd !== 'string' || cwd.length === 0) {
    throw new Error('cannot encode an empty project path');
  }

  let readable = '';
  let separatorRun = false;
  for (let i = 0; i < cwd.length; i++) {
    const code = cwd.charCodeAt(i);
    const ch = String.fromCharCode(code);
    if (ch === '/' || ch === '\\' || ch === ':') {
      if (!separatorRun) readable += '-';
      separatorRun = true;
    } else if (ch !== '~' && /^[A-Za-z0-9._-]$/.test(ch)) {
      readable += ch;
      separatorRun = false;
    } else {
      readable += '~' + code.toString(16).toUpperCase().padStart(4, '0');
      separatorRun = false;
    }
  }
  return `--${(readable.replace(/^-+/, '') || 'root').slice(0, 251)}--`;
}

/**
 * Scan concatenated Zstd frames per RFC 8878 without decompressing payloads.
 * Incomplete trailing frame bytes return `tornStart` instead of throwing so
 * power-loss recovery can salvage prior frames and complete trailing lines.
 *
 * @param {Buffer | Uint8Array} input
 * @param {number} [maxFrames]
 * @returns {{ frames: Array<{ start: number, end: number, hasChecksum: boolean }>, tornStart: number | undefined }}
 */
export function scanZstdFrames(input, maxFrames = Number.POSITIVE_INFINITY) {
  const buffer = Buffer.isBuffer(input) ? input : Buffer.from(input);
  const frames = [];
  let offset = 0;

  while (offset < buffer.length) {
    const start = offset;
    if (buffer.length - offset < 4) {
      return { frames, tornStart: start };
    }
    if (buffer.readUInt32LE(offset) !== ZSTD_MAGIC) {
      throw new Error(`corrupt Zstandard session log: invalid frame magic at byte ${offset}`);
    }
    offset += 4;

    if (offset === buffer.length) {
      return { frames, tornStart: start };
    }
    const descriptor = buffer.readUInt8(offset);
    offset += 1;

    if ((descriptor & 24) !== 0) {
      throw new Error(`corrupt Zstandard session log: reserved frame-header bit at byte ${offset - 1}`);
    }

    const contentSizeFlag = descriptor >>> 6;
    const singleSegment = (descriptor & 32) !== 0;
    const hasChecksum = (descriptor & 4) !== 0;
    const dictionaryFlag = descriptor & 3;
    const dictionaryBytes = dictionaryFlag === 3 ? 4 : dictionaryFlag;
    const contentSizeBytes = contentSizeFlag === 0 ? (singleSegment ? 1 : 0) : (1 << contentSizeFlag);
    const remainingHeaderBytes = (singleSegment ? 0 : 1) + dictionaryBytes + contentSizeBytes;

    if (buffer.length - offset < remainingHeaderBytes) {
      return { frames, tornStart: start };
    }
    offset += remainingHeaderBytes;

    for (;;) {
      if (buffer.length - offset < 3) {
        return { frames, tornStart: start };
      }
      const blockHeader = buffer.readUIntLE(offset, 3);
      offset += 3;

      const lastBlock = (blockHeader & 1) !== 0;
      const blockType = (blockHeader >>> 1) & 3;
      const blockSize = blockHeader >>> 3;

      if (blockType === 3) {
        throw new Error(`corrupt Zstandard session log: reserved block type at byte ${offset - 3}`);
      }
      const payloadBytes = blockType === 1 ? 1 : blockSize;
      if (buffer.length - offset < payloadBytes) {
        return { frames, tornStart: start };
      }
      offset += payloadBytes;

      if (lastBlock) break;
    }

    if (hasChecksum) {
      if (buffer.length - offset < 4) {
        return { frames, tornStart: start };
      }
      offset += 4;
    }

    frames.push({ start, end: offset, hasChecksum });
    if (frames.length === maxFrames) {
      return { frames, tornStart: undefined };
    }
  }

  return { frames, tornStart: undefined };
}

/**
 * Compress one independently decodable Zstd frame with content checksum enabled.
 *
 * @param {Buffer | Uint8Array | string} inputBuffer
 * @returns {Promise<Buffer>}
 */
export async function compressZstdFrame(inputBuffer) {
  const buf = typeof inputBuffer === 'string'
    ? Buffer.from(inputBuffer, 'utf8')
    : Buffer.isBuffer(inputBuffer)
      ? inputBuffer
      : Buffer.from(inputBuffer);
  return zstdCompressAsync(buf, CHECKSUM_OPTIONS);
}

/**
 * Encode a DSH V4 session log into concatenated checksummed Zstd frames:
 * Frame 0 contains STRICTLY `JSON.stringify(headerObj) + '\n'`;
 * subsequent frames batch up to `eventsPerFrame` JSONL event lines each.
 *
 * @param {Record<string, any>} headerObj
 * @param {Array<Record<string, any>>} [events]
 * @param {number} [eventsPerFrame]
 * @returns {Promise<Buffer>}
 */
export async function encodeV4SessionLog(headerObj, events = [], eventsPerFrame = 50) {
  if (typeof headerObj !== 'object' || headerObj === null || Array.isArray(headerObj)) {
    throw new TypeError('headerObj must be a plain object');
  }
  if (!Array.isArray(events)) {
    throw new TypeError('events must be an array');
  }
  if (!Number.isSafeInteger(eventsPerFrame) || eventsPerFrame < 1) {
    throw new RangeError('eventsPerFrame must be a positive integer');
  }

  const frameBuffers = [];
  const headerLine = Buffer.from(`${JSON.stringify(headerObj)}\n`, 'utf8');
  frameBuffers.push(await compressZstdFrame(headerLine));

  for (let i = 0; i < events.length; i += eventsPerFrame) {
    const batch = events.slice(i, i + eventsPerFrame);
    const jsonl = batch.map((ev) => `${JSON.stringify(ev)}\n`).join('');
    frameBuffers.push(await compressZstdFrame(Buffer.from(jsonl, 'utf8')));
  }

  return Buffer.concat(frameBuffers);
}

function parseJsonlChunk(chunk, targetEvents, { strictCompleteLines = true } = {}) {
  let lineStart = 0;
  for (let newline = chunk.indexOf(10); newline !== -1; newline = chunk.indexOf(10, lineStart)) {
    const lineBuf = chunk.subarray(lineStart, newline);
    if (lineBuf.length > 0) {
      try {
        targetEvents.push(JSON.parse(lineBuf.toString('utf8')));
      } catch (err) {
        if (strictCompleteLines) {
          throw new Error('corrupt Zstandard session log: invalid JSONL event line', { cause: err });
        }
        // Stop salvaging torn tail on the first unparsable line
        return;
      }
    }
    lineStart = newline + 1;
  }
  if (strictCompleteLines && lineStart < chunk.length) {
    throw new Error('corrupt Zstandard session log: complete frame contains a torn JSONL record');
  }
}

/**
 * Decode a DSH V4 concatenated Zstd session log.
 * Validates Frame 0 single-line header invariant, decompresses all complete frames
 * (verifying Zstd checksums), and salvages complete `\n`-terminated JSON lines from
 * any truncated trailing frame via `ZSTD_e_flush`.
 *
 * @param {Buffer | Uint8Array} input
 * @returns {Promise<{ header: any, events: any[], frameCount: number, hasAllChecksums: boolean, recoveredTornTail: boolean }>}
 */
export async function decodeV4SessionLog(input) {
  const buffer = Buffer.isBuffer(input) ? input : Buffer.from(input);
  const { frames, tornStart } = scanZstdFrames(buffer);

  if (frames.length === 0) {
    throw new Error('empty or header-less Zstandard session log');
  }

  const hasAllChecksums = frames.every((f) => f.hasChecksum);

  let headerPlain;
  try {
    headerPlain = zlib.zstdDecompressSync(buffer.subarray(frames[0].start, frames[0].end));
  } catch (err) {
    throw new Error('corrupt Zstandard session log: frame 0 failed validation', { cause: err });
  }

  if (headerPlain.length === 0 || headerPlain.indexOf(10) !== headerPlain.length - 1) {
    throw new Error('corrupt Zstandard session log: first frame is not exactly one header line');
  }

  let header;
  try {
    header = JSON.parse(headerPlain.subarray(0, -1).toString('utf8'));
  } catch (err) {
    throw new Error('corrupt Zstandard session log: header line is not valid JSON', { cause: err });
  }

  const events = [];
  for (let i = 1; i < frames.length; i++) {
    const frame = frames[i];
    let plain;
    try {
      plain = zlib.zstdDecompressSync(buffer.subarray(frame.start, frame.end));
    } catch (err) {
      throw new Error(`corrupt Zstandard session log: frame ${i} at byte ${frame.start} failed validation`, { cause: err });
    }
    parseJsonlChunk(plain, events, { strictCompleteLines: true });
  }

  let recoveredTornTail = false;
  if (tornStart !== undefined) {
    recoveredTornTail = true;
    let recovered = Buffer.alloc(0);
    try {
      recovered = await zstdDecompressAsync(buffer.subarray(tornStart), INCOMPLETE_FRAME_OPTIONS);
    } catch {
      // Torn prefix may be too short to yield any decompressed bytes (e.g. cut inside header)
    }
    const lastNewline = recovered.lastIndexOf(10);
    if (lastNewline !== -1) {
      parseJsonlChunk(recovered.subarray(0, lastNewline + 1), events, { strictCompleteLines: false });
    }
  }

  return {
    header,
    events,
    frameCount: frames.length,
    hasAllChecksums,
    recoveredTornTail,
  };
}
