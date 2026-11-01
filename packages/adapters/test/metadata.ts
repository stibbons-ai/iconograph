import { expect } from "bun:test";
import { readFile } from "node:fs/promises";
import sharp from "sharp";

/** Whether an EXIF block's IFD0 points to a GPS IFD (tag 0x8825). */
function hasGpsIfd(exif: Buffer): boolean {
  // sharp returns the APP1 payload: "Exif\0\0" then a TIFF header.
  const tiff = exif.subarray(6);
  const little = tiff.toString("latin1", 0, 2) === "II";
  const u16 = (offset: number) => (little ? tiff.readUInt16LE(offset) : tiff.readUInt16BE(offset));
  const u32 = (offset: number) => (little ? tiff.readUInt32LE(offset) : tiff.readUInt32BE(offset));
  const ifd0 = u32(4);
  for (let entry = 0; entry < u16(ifd0); entry++) {
    if (u16(ifd0 + 2 + entry * 12) === 0x8825) return true;
  }
  return false;
}

/** The GPS/XMP/IPTC/ICC fixture really carries every kind of metadata the store must drop. */
export async function expectFullMetadata(path: string): Promise<void> {
  const before = await sharp(path).metadata();
  expect(before.exif).toBeDefined();
  expect(hasGpsIfd(before.exif!)).toBe(true);
  expect(before.xmp).toBeDefined();
  expect(before.iptc).toBeDefined();
  expect(before.icc).toBeDefined();
  expect(before.orientation).toBe(6);
}

/** A stored Reference Photo is an upright JPEG with no EXIF, GPS, XMP, IPTC or ICC data. */
export async function expectStripped(path: string): Promise<void> {
  const bytes = await readFile(path);
  const after = await sharp(bytes).metadata();
  expect(after.format).toBe("jpeg");
  expect(after.exif).toBeUndefined();
  expect(after.xmp).toBeUndefined();
  expect(after.iptc).toBeUndefined();
  expect(after.icc).toBeUndefined();
  expect(after.orientation).toBeUndefined();
  for (const marker of ["Exif", "synthetic test", "http://ns.adobe.com/xap", "Photoshop"]) {
    expect(bytes.includes(Buffer.from(marker))).toBe(false);
  }
}
