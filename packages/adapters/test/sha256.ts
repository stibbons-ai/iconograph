/** Hex SHA-256 of test bytes, as the model lock records it. */
export const sha256 = (input: Bun.BlobOrStringOrBuffer) =>
  Bun.CryptoHasher.hash("sha256", input, "hex");
