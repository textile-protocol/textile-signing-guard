// Strict EIP-712 typed data: parse an untrusted `content` object into a
// normalized form, pin its `types` to one of the shapes Stitch produces, and
// hash it exactly the way the signer will.
//
// Fail closed is the rule everywhere here. A field that is missing, has the
// wrong JSON type, is not canonical (an address that is not 40 hex chars, a
// uint with a sign or a decimal point, bytes32 of the wrong length) or is not
// declared in the pinned type set is a reject, not a best effort.
//
// The pinned type sets are copied from Stitch's `src/protocol/typed_data.rs`
// (github.com/textile-protocol/textile-stitch). Field order matters: it is part of the EIP-712 type hash,
// and the fixtures in `test/fixtures/` (dumped from that Rust code) prove the
// hash below lands on the digest Stitch computes.

import { getAddress, hashTypedData, isAddress, maxUint256 } from 'viem'
import { err, errorMessage, isRecord, ok, type Address, type Hex, type Result } from '../types.js'

export type TypeField = { name: string; type: string }
export type TypeSet = Record<string, readonly TypeField[]>

/** The raw document as it arrives, keys checked but values still untyped. */
export type RawTypedData = {
  types: TypeSet
  primaryType: string
  domain: Record<string, unknown>
  message: Record<string, unknown>
}

/** Values decoded per their declared Solidity type. */
export type Normalized =
  | bigint
  | Address
  | Hex
  | string
  | boolean
  | Normalized[]
  | { [field: string]: Normalized }

export type NormalizedStruct = { [field: string]: Normalized }

export type NormalizedTypedData = {
  types: TypeSet
  primaryType: string
  domain: NormalizedStruct
  message: NormalizedStruct
}

// --- Pinned type sets (from typed_data.rs) ---------------------------------

const f = (name: string, type: string): TypeField => ({ name, type })

export const PERMIT2_ORDER_TYPES: TypeSet = {
  EIP712Domain: [f('name', 'string'), f('chainId', 'uint256'), f('verifyingContract', 'address')],
  PermitWitnessTransferFrom: [
    f('permitted', 'TokenPermissions'),
    f('spender', 'address'),
    f('nonce', 'uint256'),
    f('deadline', 'uint256'),
    f('witness', 'LimitOrder'),
  ],
  TokenPermissions: [f('token', 'address'), f('amount', 'uint256')],
  LimitOrder: [
    f('info', 'OrderInfo'),
    f('inputToken', 'address'),
    f('inputAmount', 'uint256'),
    f('outputs', 'OutputToken[]'),
  ],
  OrderInfo: [
    f('reactor', 'address'),
    f('swapper', 'address'),
    f('nonce', 'uint256'),
    f('deadline', 'uint256'),
    f('additionalValidationContract', 'address'),
    f('additionalValidationData', 'bytes'),
  ],
  OutputToken: [f('token', 'address'), f('amount', 'uint256'), f('recipient', 'address')],
}

export const MAKER_SESSION_TYPES: TypeSet = {
  EIP712Domain: [f('name', 'string'), f('version', 'string')],
  MakerSession: [
    f('makerId', 'string'),
    f('signingAddress', 'address'),
    f('challenge', 'bytes32'),
    f('issuedAt', 'uint256'),
  ],
}

export const MAKER_ENROLL_TYPES: TypeSet = {
  EIP712Domain: [f('name', 'string'), f('version', 'string'), f('chainId', 'uint256')],
  MakerEnroll: [
    f('signingAddress', 'address'),
    f('fundingWallet', 'address'),
    f('chainId', 'uint256'),
    f('issuedAt', 'uint256'),
  ],
}

export const SIGNER_CHECK_TYPES: TypeSet = {
  EIP712Domain: [f('name', 'string'), f('version', 'string')],
  SignerCheck: [f('nonce', 'bytes32')],
}

export type MessageKind = 'permit2_order' | 'maker_session' | 'maker_enroll' | 'signer_check'

const KINDS: ReadonlyArray<{ kind: MessageKind; primaryType: string; types: TypeSet }> = [
  { kind: 'permit2_order', primaryType: 'PermitWitnessTransferFrom', types: PERMIT2_ORDER_TYPES },
  { kind: 'maker_session', primaryType: 'MakerSession', types: MAKER_SESSION_TYPES },
  { kind: 'maker_enroll', primaryType: 'MakerEnroll', types: MAKER_ENROLL_TYPES },
  { kind: 'signer_check', primaryType: 'SignerCheck', types: SIGNER_CHECK_TYPES },
]

// --- Parsing ----------------------------------------------------------------

const parseField = (struct: string, field: unknown): Result<TypeField> => {
  if (!isRecord(field)) return err(`types.${struct} has a non-object field`)
  const keys = Object.keys(field).sort()
  if (keys.length !== 2 || keys[0] !== 'name' || keys[1] !== 'type') {
    return err(`types.${struct} has a field with keys other than name and type`)
  }
  const { name, type } = field
  if (typeof name !== 'string' || typeof type !== 'string') {
    return err(`types.${struct} has a field whose name or type is not a string`)
  }
  return ok({ name, type })
}

const parseTypeSet = (v: unknown): Result<TypeSet> => {
  if (!isRecord(v)) return err('types is not an object')
  const structs: [string, TypeField[]][] = []
  for (const [name, fields] of Object.entries(v)) {
    if (!Array.isArray(fields)) return err(`types.${name} is not an array`)
    const parsed: TypeField[] = []
    for (const field of fields) {
      const f = parseField(name, field)
      if (!f.ok) return f
      parsed.push(f.value)
    }
    structs.push([name, parsed])
  }
  // fromEntries defines own properties, so a struct named `__proto__` stays an
  // ordinary key (and fails the pin) instead of replacing the prototype.
  return ok(Object.fromEntries(structs))
}

/** Shape check only: four keys, right JSON types, nothing extra. */
export function parseTypedData(content: unknown): Result<RawTypedData> {
  if (!isRecord(content)) return err('typed data is not an object')
  const keys = Object.keys(content).sort()
  const expected = ['domain', 'message', 'primaryType', 'types']
  if (keys.length !== 4 || keys.some((k, i) => k !== expected[i])) {
    return err(`typed data keys must be exactly ${expected.join(', ')}; got ${keys.join(', ')}`)
  }
  const types = parseTypeSet(content['types'])
  if (!types.ok) return types
  const primaryType = content['primaryType']
  if (typeof primaryType !== 'string' || primaryType.length === 0) return err('primaryType is not a string')
  const domain = content['domain']
  if (!isRecord(domain)) return err('domain is not an object')
  const message = content['message']
  if (!isRecord(message)) return err('message is not an object')
  return ok({ types: types.value, primaryType, domain, message })
}

// --- Type-set pinning --------------------------------------------------------

const fieldsEqual = (a: readonly TypeField[], b: readonly TypeField[]): boolean =>
  a.length === b.length && a.every((x, i) => x.name === b[i]?.name && x.type === b[i]?.type)

/** Same struct names, same fields in the same order. Struct order is free. */
export function typeSetsEqual(a: TypeSet, b: TypeSet): boolean {
  const an = Object.keys(a).sort()
  const bn = Object.keys(b).sort()
  if (an.length !== bn.length || an.some((n, i) => n !== bn[i])) return false
  return an.every((n) => fieldsEqual(a[n] ?? [], b[n] ?? []))
}

/**
 * Which of the four allowed shapes this is, or `null`. Pinned on the exact
 * `types` map (including `EIP712Domain`), not just the primary type name, so
 * a `PermitWitnessTransferFrom` with an extra field or a domain that declares
 * a `version` is not an order.
 */
export function identifyKind(td: RawTypedData): MessageKind | null {
  const hit = KINDS.find((k) => k.primaryType === td.primaryType && typeSetsEqual(k.types, td.types))
  return hit?.kind ?? null
}

// --- Value decoding ----------------------------------------------------------

export function normalizeAddress(v: unknown): Result<Address> {
  // Non-strict `isAddress` is the 40-hex-char shape check; `getAddress` checksums.
  if (typeof v !== 'string' || !isAddress(v, { strict: false })) return err('not a 20-byte hex address')
  return ok(getAddress(v))
}

/** 2^256 - 1 has 78 decimal digits; longer strings are refused before BigInt parses them. */
const MAX_UINT256_DIGITS = 78

/** uint256 as a JSON integer (safe range) or a canonical decimal string. */
export function normalizeUint(v: unknown): Result<bigint> {
  if (typeof v === 'number') {
    if (!Number.isSafeInteger(v) || v < 0) return err('uint is not a non-negative safe integer')
    return ok(BigInt(v))
  }
  if (typeof v === 'string') {
    if (v.length > MAX_UINT256_DIGITS) return err('uint exceeds 256 bits')
    if (!/^(0|[1-9][0-9]*)$/.test(v)) return err('uint string is not canonical decimal')
    const n = BigInt(v)
    if (n > maxUint256) return err('uint exceeds 256 bits')
    return ok(n)
  }
  return err('uint is neither a number nor a string')
}

const normalizeBytesN = (v: unknown, n: number): Result<Hex> => {
  if (typeof v !== 'string' || !new RegExp(`^0x[0-9a-fA-F]{${n * 2}}$`).test(v)) {
    return err(`not a ${n}-byte hex string`)
  }
  return ok(v.toLowerCase() as Hex)
}

const normalizeBytes = (v: unknown): Result<Hex> => {
  if (typeof v !== 'string' || !/^0x([0-9a-fA-F]{2})*$/.test(v)) return err('not an even-length hex string')
  return ok(v.toLowerCase() as Hex)
}

const normalizeString = (v: unknown): Result<string> =>
  typeof v === 'string' ? ok(v) : err('not a string')

const normalizeBool = (v: unknown): Result<boolean> =>
  typeof v === 'boolean' ? ok(v) : err('not a boolean')

const normalizeScalar = (type: string, v: unknown): Result<Normalized> => {
  switch (type) {
    case 'address':
      return normalizeAddress(v)
    case 'uint256':
      return normalizeUint(v)
    case 'bytes32':
      return normalizeBytesN(v, 32)
    case 'bytes':
      return normalizeBytes(v)
    case 'string':
      return normalizeString(v)
    case 'bool':
      return normalizeBool(v)
    default:
      return err(`unsupported field type ${type}`)
  }
}

/** The only array in the pinned types is an order's outputs, and Stitch sends
 * one. Refusing long arrays here keeps a padded request from costing a hash. */
const MAX_ARRAY_LENGTH = 8

const normalizeValue = (type: string, v: unknown, types: TypeSet, path: string): Result<Normalized> => {
  if (type.endsWith('[]')) {
    if (!Array.isArray(v)) return err(`${path} is not an array`)
    if (v.length > MAX_ARRAY_LENGTH) return err(`${path} has ${v.length} entries; at most ${MAX_ARRAY_LENGTH} are accepted`)
    const inner = type.slice(0, -2)
    const out: Normalized[] = []
    for (const [i, item] of v.entries()) {
      const r = normalizeValue(inner, item, types, `${path}[${i}]`)
      if (!r.ok) return r
      out.push(r.value)
    }
    return ok(out)
  }
  if (Object.hasOwn(types, type)) return normalizeStruct(type, v, types, path)
  const scalar = normalizeScalar(type, v)
  return scalar.ok ? scalar : err(`${path}: ${scalar.error}`)
}

/** Decode every declared field, refuse undeclared ones. */
function normalizeStruct(
  structName: string,
  v: unknown,
  types: TypeSet,
  path = structName
): Result<NormalizedStruct> {
  const fields = Object.hasOwn(types, structName) ? types[structName] : undefined
  if (!fields) return err(`${path}: unknown struct ${structName}`)
  if (!isRecord(v)) return err(`${path} is not an object`)
  const declared = new Set(fields.map((x) => x.name))
  const extra = Object.keys(v).filter((k) => !declared.has(k))
  if (extra.length > 0) return err(`${path} has undeclared fields: ${extra.join(', ')}`)
  const out: NormalizedStruct = {}
  for (const field of fields) {
    if (!Object.hasOwn(v, field.name)) return err(`${path}.${field.name} is missing`)
    const r = normalizeValue(field.type, v[field.name], types, `${path}.${field.name}`)
    if (!r.ok) return r
    out[field.name] = r.value
  }
  return ok(out)
}

/** Domain and message decoded against the declared types. */
export function normalizeTypedData(td: RawTypedData): Result<NormalizedTypedData> {
  const domain = normalizeStruct('EIP712Domain', td.domain, td.types, 'domain')
  if (!domain.ok) return domain
  const message = normalizeStruct(td.primaryType, td.message, td.types, 'message')
  if (!message.ok) return message
  return ok({ types: td.types, primaryType: td.primaryType, domain: domain.value, message: message.value })
}

// --- Hashing ----------------------------------------------------------------

/**
 * The digest the signer produces: `keccak256(0x1901 ‖ domainSeparator ‖
 * hashStruct(message))`, with the domain hashed over the `EIP712Domain` type
 * exactly as declared in `types` (viem uses the declared one when present).
 */
export function digestOf(td: NormalizedTypedData): Result<Hex> {
  try {
    const hash = hashTypedData({
      domain: td.domain,
      types: td.types,
      primaryType: td.primaryType,
      message: td.message,
    } as unknown as Parameters<typeof hashTypedData>[0])
    return ok(hash)
  } catch (e) {
    return err(`typed data does not hash: ${errorMessage(e)}`)
  }
}

// --- Typed accessors for the policy modules ----------------------------------

export const asStruct = (v: Normalized | undefined): NormalizedStruct | null =>
  typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as NormalizedStruct) : null
export const asArray = (v: Normalized | undefined): Normalized[] | null => (Array.isArray(v) ? v : null)
export const asBigint = (v: Normalized | undefined): bigint | null => (typeof v === 'bigint' ? v : null)
export const asString = (v: Normalized | undefined): string | null => (typeof v === 'string' ? v : null)

export const sameAddress = (a: string | null | undefined, b: string | null | undefined): boolean =>
  typeof a === 'string' && typeof b === 'string' && a.toLowerCase() === b.toLowerCase()
