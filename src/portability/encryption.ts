import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
  scryptSync,
} from "node:crypto";
import { z } from "zod";
import { RepoMindError } from "../errors.js";

const FORMAT = "repomind-encrypted-archive";
const FORMAT_VERSION = 1;
const CIPHER = "aes-256-gcm";
const KDF = "scrypt";
const SCRYPT_N = 32_768;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const KEY_LENGTH = 32;
const SALT_LENGTH = 16;
const IV_LENGTH = 12;
const TAG_LENGTH = 16;
const SCRYPT_MAX_MEMORY = 64 * 1024 * 1024;
const MINIMUM_PASSPHRASE_BYTES = 12;

export type EncryptedArchivePurpose = "repository-export" | "sqlite-backup";

const base64Schema = z.string().min(1).regex(/^[A-Za-z0-9+/]+={0,2}$/u);

const encryptedArchiveSchema = z.object({
  format: z.literal(FORMAT),
  formatVersion: z.literal(FORMAT_VERSION),
  purpose: z.enum(["repository-export", "sqlite-backup"]),
  createdAt: z.number().int().nonnegative(),
  plaintext: z.object({
    format: z.string().min(1),
    formatVersion: z.number().int().positive(),
    sizeBytes: z.number().int().nonnegative(),
    sha256: z.string().regex(/^[a-f0-9]{64}$/u),
  }).strict(),
  kdf: z.object({
    name: z.literal(KDF),
    salt: base64Schema,
    N: z.literal(SCRYPT_N),
    r: z.literal(SCRYPT_R),
    p: z.literal(SCRYPT_P),
    keyLength: z.literal(KEY_LENGTH),
  }).strict(),
  cipher: z.object({
    name: z.literal(CIPHER),
    iv: base64Schema,
    tag: base64Schema,
  }).strict(),
  ciphertext: base64Schema,
}).strict();

export type EncryptedArchive = z.infer<typeof encryptedArchiveSchema>;

type EncryptedArchiveHeader = Omit<EncryptedArchive, "ciphertext" | "cipher"> & {
  cipher: Omit<EncryptedArchive["cipher"], "tag">;
};

export interface EncryptedArchiveMetadata {
  format: typeof FORMAT;
  formatVersion: typeof FORMAT_VERSION;
  purpose: EncryptedArchivePurpose;
  createdAt: number;
  plaintext: EncryptedArchive["plaintext"];
  kdf: Omit<EncryptedArchive["kdf"], "salt">;
  cipher: { name: typeof CIPHER };
}

function sha256(value: Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function requirePassphrase(passphrase: string | undefined, operation: "encrypt" | "decrypt"): string {
  if (!passphrase) {
    throw new RepoMindError("INVALID_INPUT", `A passphrase is required to ${operation} this archive; provide it through the configured environment variable`);
  }
  if (Buffer.byteLength(passphrase, "utf8") < MINIMUM_PASSPHRASE_BYTES) {
    throw new RepoMindError("INVALID_INPUT", `Archive passphrases must contain at least ${MINIMUM_PASSPHRASE_BYTES} UTF-8 bytes`);
  }
  return passphrase;
}

function decodeBase64(value: string, field: string, expectedLength?: number): Buffer {
  const decoded = Buffer.from(value, "base64");
  if (decoded.toString("base64") !== value || (expectedLength !== undefined && decoded.length !== expectedLength)) {
    throw new RepoMindError("INVALID_INPUT", `Invalid encrypted archive ${field}`);
  }
  return decoded;
}

function header(archive: EncryptedArchiveHeader | EncryptedArchive): EncryptedArchiveHeader {
  return {
    format: archive.format,
    formatVersion: archive.formatVersion,
    purpose: archive.purpose,
    createdAt: archive.createdAt,
    plaintext: archive.plaintext,
    kdf: archive.kdf,
    cipher: { name: archive.cipher.name, iv: archive.cipher.iv },
  };
}

function deriveKey(passphrase: string, salt: Buffer): Buffer {
  return scryptSync(passphrase, salt, KEY_LENGTH, {
    N: SCRYPT_N,
    r: SCRYPT_R,
    p: SCRYPT_P,
    maxmem: SCRYPT_MAX_MEMORY,
  });
}

export function createEncryptedArchive(
  plaintext: Buffer,
  input: {
    purpose: EncryptedArchivePurpose;
    plaintextFormat: string;
    plaintextFormatVersion: number;
    passphrase: string;
    createdAt?: number;
  },
): EncryptedArchive {
  const passphrase = requirePassphrase(input.passphrase, "encrypt");
  const salt = randomBytes(SALT_LENGTH);
  const iv = randomBytes(IV_LENGTH);
  const archiveHeader: EncryptedArchiveHeader = {
    format: FORMAT,
    formatVersion: FORMAT_VERSION,
    purpose: input.purpose,
    createdAt: input.createdAt ?? Date.now(),
    plaintext: {
      format: input.plaintextFormat,
      formatVersion: input.plaintextFormatVersion,
      sizeBytes: plaintext.length,
      sha256: sha256(plaintext),
    },
    kdf: {
      name: KDF,
      salt: salt.toString("base64"),
      N: SCRYPT_N,
      r: SCRYPT_R,
      p: SCRYPT_P,
      keyLength: KEY_LENGTH,
    },
    cipher: { name: CIPHER, iv: iv.toString("base64") },
  };
  const cipher = createCipheriv(CIPHER, deriveKey(passphrase, salt), iv);
  cipher.setAAD(Buffer.from(JSON.stringify(archiveHeader), "utf8"));
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return {
    ...archiveHeader,
    cipher: { ...archiveHeader.cipher, tag: cipher.getAuthTag().toString("base64") },
    ciphertext: ciphertext.toString("base64"),
  };
}

export function parseEncryptedArchive(value: unknown): EncryptedArchive | null {
  if (!value || typeof value !== "object" || Array.isArray(value)
    || (value as Record<string, unknown>).format !== FORMAT) return null;
  const parsed = encryptedArchiveSchema.safeParse(value);
  if (!parsed.success) {
    throw new RepoMindError("INVALID_INPUT", "Invalid encrypted archive", { issues: parsed.error.issues });
  }
  decodeBase64(parsed.data.kdf.salt, "salt", SALT_LENGTH);
  decodeBase64(parsed.data.cipher.iv, "IV", IV_LENGTH);
  decodeBase64(parsed.data.cipher.tag, "authentication tag", TAG_LENGTH);
  decodeBase64(parsed.data.ciphertext, "ciphertext");
  return parsed.data;
}

export function decryptEncryptedArchive(
  archive: EncryptedArchive,
  passphrase: string | undefined,
  expectedPurpose: EncryptedArchivePurpose,
): Buffer {
  if (archive.purpose !== expectedPurpose) {
    throw new RepoMindError("INVALID_INPUT", `Encrypted archive purpose ${archive.purpose} cannot be used as ${expectedPurpose}`);
  }
  const secret = requirePassphrase(passphrase, "decrypt");
  const salt = decodeBase64(archive.kdf.salt, "salt", SALT_LENGTH);
  const iv = decodeBase64(archive.cipher.iv, "IV", IV_LENGTH);
  const tag = decodeBase64(archive.cipher.tag, "authentication tag", TAG_LENGTH);
  const ciphertext = decodeBase64(archive.ciphertext, "ciphertext");
  let plaintext: Buffer;
  try {
    const decipher = createDecipheriv(CIPHER, deriveKey(secret, salt), iv);
    decipher.setAAD(Buffer.from(JSON.stringify(header(archive)), "utf8"));
    decipher.setAuthTag(tag);
    plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  } catch {
    throw new RepoMindError("INVALID_INPUT", "Encrypted archive authentication failed; the passphrase is incorrect or the archive was modified");
  }
  if (plaintext.length !== archive.plaintext.sizeBytes || sha256(plaintext) !== archive.plaintext.sha256) {
    throw new RepoMindError("INVALID_INPUT", "Encrypted archive plaintext metadata does not match");
  }
  return plaintext;
}

export function encryptedArchiveMetadata(archive: EncryptedArchive): EncryptedArchiveMetadata {
  return {
    format: archive.format,
    formatVersion: archive.formatVersion,
    purpose: archive.purpose,
    createdAt: archive.createdAt,
    plaintext: archive.plaintext,
    kdf: {
      name: archive.kdf.name,
      N: archive.kdf.N,
      r: archive.kdf.r,
      p: archive.kdf.p,
      keyLength: archive.kdf.keyLength,
    },
    cipher: { name: archive.cipher.name },
  };
}
