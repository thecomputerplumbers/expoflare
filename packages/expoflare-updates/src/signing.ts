// Expo code signing: RSASSA-PKCS1-v1_5 with SHA-256 over the exact bytes of
// the manifest or directive part, sent back as a structured-field dictionary.

const keys = new Map<string, Promise<CryptoKey>>()

/** Signs `body` and returns the value for the part's `expo-signature` header. */
export async function signatureHeader(
  body: string,
  privateKeyPem: string,
  keyId: string
): Promise<string> {
  const key = await importPrivateKey(privateKeyPem)
  const signature = await crypto.subtle.sign(
    "RSASSA-PKCS1-v1_5",
    key,
    new TextEncoder().encode(body)
  )
  return `sig="${toBase64(new Uint8Array(signature))}", keyid="${keyId}"`
}

function importPrivateKey(pem: string): Promise<CryptoKey> {
  let key = keys.get(pem)
  if (!key) {
    key = crypto.subtle.importKey(
      "pkcs8",
      pkcs8FromPem(pem),
      { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
      false,
      ["sign"]
    )
    keys.set(pem, key)
  }
  return key
}

/**
 * WebCrypto only imports PKCS#8. `expo-updates codesigning:generate` writes a
 * PKCS#1 key (`BEGIN RSA PRIVATE KEY`), so that form is wrapped here.
 */
export function pkcs8FromPem(pem: string): Uint8Array<ArrayBuffer> {
  const match =
    /-----BEGIN ((?:RSA )?PRIVATE KEY)-----([\s\S]+?)-----END \1-----/.exec(pem)
  if (!match) {
    throw new Error(
      "The signing key must be a PEM private key (PKCS#8 or RSA PKCS#1)."
    )
  }
  const der = fromBase64(match[2]!.replace(/\s+/g, ""))
  return match[1] === "RSA PRIVATE KEY" ? wrapPkcs1(der) : der
}

// PrivateKeyInfo ::= SEQUENCE { version 0, rsaEncryption, OCTET STRING key }
const RSA_ALGORITHM = [
  0x30, 0x0d, 0x06, 0x09, 0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x01, 0x01,
  0x05, 0x00,
]

function wrapPkcs1(pkcs1: Uint8Array): Uint8Array<ArrayBuffer> {
  const octets = [0x04, ...derLength(pkcs1.length)]
  const contentLength = 3 + RSA_ALGORITHM.length + octets.length + pkcs1.length
  const header = [
    0x30,
    ...derLength(contentLength),
    0x02,
    0x01,
    0x00,
    ...RSA_ALGORITHM,
    ...octets,
  ]
  const out = new Uint8Array(header.length + pkcs1.length)
  out.set(header)
  out.set(pkcs1, header.length)
  return out
}

function derLength(length: number): number[] {
  if (length < 0x80) return [length]
  const bytes: number[] = []
  for (let rest = length; rest > 0; rest >>= 8) bytes.unshift(rest & 0xff)
  return [0x80 | bytes.length, ...bytes]
}

function fromBase64(value: string): Uint8Array<ArrayBuffer> {
  const binary = atob(value)
  const out = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i)
  return out
}

function toBase64(bytes: Uint8Array): string {
  let binary = ""
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary)
}

/** Unpadded base64url, the encoding Expo uses for asset hashes. */
export function toBase64Url(bytes: Uint8Array): string {
  return toBase64(bytes)
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/, "")
}
