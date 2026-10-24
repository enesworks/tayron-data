const fs = require('node:fs')
const path = require('node:path')
const crypto = require('node:crypto')
const { canonical } = require('../electron/draft-data-format.cjs')

const PUBLIC_KEY = `-----BEGIN PUBLIC KEY-----\nMCowBQYDK2VwAyEAGZczEXKGC5vqPHyI4u22XDxlcfQ5VJQxF6OdE8BBYJI=\n-----END PUBLIC KEY-----\n`
const envelope = JSON.parse(fs.readFileSync(path.resolve(__dirname, '..', 'latest.json'), 'utf8'))
if (!envelope.payload || typeof envelope.signature !== 'string'
  || !crypto.verify(null, Buffer.from(canonical(envelope.payload)), PUBLIC_KEY, Buffer.from(envelope.signature, 'base64'))) {
  throw new Error('latest.json signature does not match the public key embedded in Tayron')
}
console.log(`Verified latest.json signature for ${envelope.payload.patch} revision ${envelope.payload.revision}`)
