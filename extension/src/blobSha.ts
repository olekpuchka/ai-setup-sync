import * as crypto from "crypto";

/**
 * Computes the Git blob SHA-1 for a byte buffer.
 *
 * Git hashes blobs as: sha1("blob " + <byteLength> + "\0" + <content>).
 * The GitHub trees API returns exactly this value as each file entry's `sha`,
 * so recomputing it on disk lets us compare a local file to its remote version
 * without downloading the remote content.
 */
export function gitBlobSha(content: Uint8Array): string {
  // Two update() calls hash the same bytes as one over the concatenation, without copying
  // the file into a new buffer.
  return crypto
    .createHash("sha1")
    .update(`blob ${content.length}\0`, "utf8")
    .update(content)
    .digest("hex");
}
