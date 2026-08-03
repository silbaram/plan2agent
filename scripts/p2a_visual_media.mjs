/** Strict PNG media validation kept outside the artifact contract validator. */

import { lstatSync, readFileSync } from 'node:fs';
import { inflateSync } from 'node:zlib';

class PngValidationError extends Error {}
const PNG_MAX_FILE_BYTES = 25 * 1024 * 1024;

function pngCrc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

const PNG_COLOR_TYPE_CHANNELS = new Map([
  [0, 1],
  [2, 3],
  [3, 1],
  [4, 2],
  [6, 4],
]);

const PNG_COLOR_TYPE_BIT_DEPTHS = new Map([
  [0, new Set([1, 2, 4, 8, 16])],
  [2, new Set([8, 16])],
  [3, new Set([1, 2, 4, 8])],
  [4, new Set([8, 16])],
  [6, new Set([8, 16])],
]);

const PNG_ADAM7_PASSES = [
  [0, 0, 8, 8],
  [4, 0, 8, 8],
  [0, 4, 4, 8],
  [2, 0, 4, 4],
  [0, 2, 2, 4],
  [1, 0, 2, 2],
  [0, 1, 1, 2],
];

const PNG_MAX_DIMENSION = 16_384;
const PNG_MAX_PIXELS = 64 * 1024 * 1024;
const PNG_MAX_DECOMPRESSED_BYTES = 256 * 1024 * 1024;

function pngPassDimension(size, start, step) {
  return size <= start ? 0 : Math.ceil((size - start) / step);
}

function pngImageLayout(dimensions, format, label) {
  if (
    !format
    || format.compressionMethod !== 0
    || format.filterMethod !== 0
    || ![0, 1].includes(format.interlaceMethod)
  ) {
    throw new PngValidationError(`${label} has an unsupported PNG image format`);
  }
  const channels = PNG_COLOR_TYPE_CHANNELS.get(format.colorType);
  if (!channels || !PNG_COLOR_TYPE_BIT_DEPTHS.get(format.colorType)?.has(format.bitDepth)) {
    throw new PngValidationError(`${label} has an invalid PNG color type or bit depth`);
  }
  if (dimensions.width > PNG_MAX_DIMENSION || dimensions.height > PNG_MAX_DIMENSION) {
    throw new PngValidationError(`${label} PNG dimensions exceed the ${PNG_MAX_DIMENSION}px limit`);
  }
  if (dimensions.width * dimensions.height > PNG_MAX_PIXELS) {
    throw new PngValidationError(`${label} PNG pixel count exceeds the ${PNG_MAX_PIXELS} pixel limit`);
  }
  const bitsPerPixel = channels * format.bitDepth;
  const passes = format.interlaceMethod === 0
    ? [[0, 0, 1, 1]]
    : PNG_ADAM7_PASSES;
  let decompressedBytes = 0;
  for (const [startX, startY, stepX, stepY] of passes) {
    const passWidth = pngPassDimension(dimensions.width, startX, stepX);
    const passHeight = pngPassDimension(dimensions.height, startY, stepY);
    if (!passWidth || !passHeight) continue;
    const rowBytes = Math.ceil((passWidth * bitsPerPixel) / 8);
    decompressedBytes += passHeight * (rowBytes + 1);
  }
  if (decompressedBytes > PNG_MAX_DECOMPRESSED_BYTES) {
    throw new PngValidationError(
      `${label} PNG decompressed image data exceeds the ${PNG_MAX_DECOMPRESSED_BYTES} byte limit`,
    );
  }
  return { bitsPerPixel, passes, decompressedBytes };
}

function validatePngImageData(imageData, dimensions, format, label, layout = null) {
  const { bitsPerPixel, passes } = layout ?? pngImageLayout(dimensions, format, label);
  const bytesPerPixel = Math.max(1, Math.ceil(bitsPerPixel / 8));
  let offset = 0;
  for (const [startX, startY, stepX, stepY] of passes) {
    const passWidth = pngPassDimension(dimensions.width, startX, stepX);
    const passHeight = pngPassDimension(dimensions.height, startY, stepY);
    if (!passWidth || !passHeight) continue;
    const rowBytes = Math.ceil((passWidth * bitsPerPixel) / 8);
    let previousRow = Buffer.alloc(rowBytes);
    for (let row = 0; row < passHeight; row += 1) {
      if (offset >= imageData.length) {
        throw new PngValidationError(`${label} PNG pixel data is shorter than its declared dimensions`);
      }
      const filter = imageData[offset];
      if (filter > 4) {
        throw new PngValidationError(`${label} contains an invalid PNG scanline filter`);
      }
      offset += 1;
      const filteredRow = imageData.subarray(offset, offset + rowBytes);
      offset += rowBytes;
      if (offset > imageData.length) {
        throw new PngValidationError(`${label} PNG pixel data is shorter than its declared dimensions`);
      }
      const reconstructedRow = Buffer.alloc(rowBytes);
      for (let column = 0; column < rowBytes; column += 1) {
        const left = column >= bytesPerPixel ? reconstructedRow[column - bytesPerPixel] : 0;
        const above = previousRow[column] ?? 0;
        const upperLeft = column >= bytesPerPixel ? previousRow[column - bytesPerPixel] : 0;
        let predictor = 0;
        if (filter === 1) predictor = left;
        else if (filter === 2) predictor = above;
        else if (filter === 3) predictor = Math.floor((left + above) / 2);
        else if (filter === 4) {
          const estimate = left + above - upperLeft;
          const leftDistance = Math.abs(estimate - left);
          const aboveDistance = Math.abs(estimate - above);
          const upperLeftDistance = Math.abs(estimate - upperLeft);
          predictor = leftDistance <= aboveDistance && leftDistance <= upperLeftDistance
            ? left
            : (aboveDistance <= upperLeftDistance ? above : upperLeft);
        }
        reconstructedRow[column] = (filteredRow[column] + predictor) & 0xff;
      }
      if (format.colorType === 3) {
        for (let pixel = 0; pixel < passWidth; pixel += 1) {
          const bitOffset = pixel * format.bitDepth;
          const byte = reconstructedRow[Math.floor(bitOffset / 8)];
          const shift = 8 - format.bitDepth - (bitOffset % 8);
          const paletteIndex = (byte >>> shift) & ((1 << format.bitDepth) - 1);
          if (paletteIndex >= format.paletteEntries) {
            throw new PngValidationError(`${label} contains a PNG palette index without a PLTE entry`);
          }
        }
      }
      previousRow = reconstructedRow;
    }
  }
  if (offset !== imageData.length) {
    throw new PngValidationError(`${label} PNG pixel data length does not match its declared dimensions`);
  }
}

export function validatedPngDimensions(filePath, label) {
  const fileSize = lstatSync(filePath).size;
  if (fileSize > PNG_MAX_FILE_BYTES) {
    throw new PngValidationError(`${label} PNG file size exceeds the ${PNG_MAX_FILE_BYTES} byte limit`);
  }
  const buffer = readFileSync(filePath);
  const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  if (buffer.length < 45 || !buffer.subarray(0, 8).equals(signature)) {
    throw new PngValidationError(`${label} must be a valid PNG image`);
  }
  let offset = 8;
  let dimensions = null;
  let imageFormat = null;
  let hasImageData = false;
  let hasEnd = false;
  let hasPalette = false;
  let idatSequenceEnded = false;
  const imageDataChunks = [];
  while (offset + 12 <= buffer.length) {
    const length = buffer.readUInt32BE(offset);
    const chunkEnd = offset + 12 + length;
    if (chunkEnd > buffer.length) throw new PngValidationError(`${label} contains a truncated PNG chunk`);
    const type = buffer.toString('ascii', offset + 4, offset + 8);
    if (!/^[A-Za-z]{4}$/.test(type) || !/[A-Z]/.test(type[2])) {
      throw new PngValidationError(`${label} contains an invalid PNG chunk type`);
    }
    const expectedCrc = buffer.readUInt32BE(offset + 8 + length);
    const actualCrc = pngCrc32(buffer.subarray(offset + 4, offset + 8 + length));
    if (expectedCrc !== actualCrc) throw new PngValidationError(`${label} contains an invalid PNG chunk checksum`);
    if (!['IHDR', 'PLTE', 'IDAT', 'IEND'].includes(type) && /[A-Z]/.test(type[0])) {
      throw new PngValidationError(`${label} contains unknown critical PNG chunk ${type}`);
    }
    if (hasImageData && type !== 'IDAT') idatSequenceEnded = true;
    if (type === 'IHDR') {
      if (dimensions || offset !== 8 || length !== 13) throw new PngValidationError(`${label} has an invalid PNG header`);
      dimensions = {
        width: buffer.readUInt32BE(offset + 8),
        height: buffer.readUInt32BE(offset + 12),
      };
      if (!dimensions.width || !dimensions.height) throw new PngValidationError(`${label} has invalid PNG dimensions`);
      imageFormat = {
        bitDepth: buffer[offset + 16],
        colorType: buffer[offset + 17],
        compressionMethod: buffer[offset + 18],
        filterMethod: buffer[offset + 19],
        interlaceMethod: buffer[offset + 20],
      };
    } else if (type === 'PLTE') {
      if (!dimensions || hasPalette || hasImageData || length < 3 || length > 768 || length % 3 !== 0) {
        throw new PngValidationError(`${label} has an invalid PNG palette`);
      }
      hasPalette = true;
      imageFormat.paletteEntries = length / 3;
    } else if (type === 'IDAT') {
      if (!dimensions || idatSequenceEnded) {
        throw new PngValidationError(`${label} has invalid PNG image-data chunk ordering`);
      }
      hasImageData = true;
      imageDataChunks.push(buffer.subarray(offset + 8, offset + 8 + length));
    } else if (type === 'IEND') {
      if (!hasImageData || length !== 0 || chunkEnd !== buffer.length) throw new PngValidationError(`${label} has an invalid PNG terminator`);
      hasEnd = true;
      break;
    }
    offset = chunkEnd;
  }
  if (!dimensions || !hasImageData || !hasEnd) {
    throw new PngValidationError(`${label} must contain PNG header, image data, and terminator chunks`);
  }
  if (imageFormat.colorType === 3) {
    if (!hasPalette) throw new PngValidationError(`${label} indexed-color PNG must contain a PLTE chunk`);
    if (imageFormat.paletteEntries > (1 << imageFormat.bitDepth)) {
      throw new PngValidationError(`${label} PNG palette has more entries than its indexed bit depth allows`);
    }
  } else if ([0, 4].includes(imageFormat.colorType) && hasPalette) {
    throw new PngValidationError(`${label} PNG color type must not contain a PLTE chunk`);
  }
  const layout = pngImageLayout(dimensions, imageFormat, label);
  let imageData;
  try {
    imageData = inflateSync(Buffer.concat(imageDataChunks), {
      maxOutputLength: layout.decompressedBytes,
    });
  } catch (error) {
    throw new PngValidationError(`${label} contains invalid compressed PNG image data: ${error.message}`);
  }
  validatePngImageData(imageData, dimensions, imageFormat, label, layout);
  return dimensions;
}
