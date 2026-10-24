const fs = require('node:fs')
const path = require('node:path')
const crypto = require('node:crypto')
const { canonical } = require('../electron/draft-data-format.cjs')

const latestPath = path.resolve(__dirname, '..', 'latest.json')
const envelope = JSON.parse(fs.readFileSync(latestPath, 'utf8'))
if (!envelope.payload || typeof envelope.payload !== 'object') {
  throw new Error('latest.json does not contain a valid payload')
}

const privateKey = process.env.TAYRON_DATA_SIGNING_KEY
if (!privateKey) throw new Error('TAYRON_DATA_SIGNING_KEY is required')

const signature = crypto.sign(null, Buffer.from(canonical(envelope.payload)), privateKey).toString('base64')
fs.writeFileSync(latestPath, `${JSON.stringify({ payload: envelope.payload, signature }, null, 2)}\n`)
console.log(`Re-signed latest.json for ${envelope.payload.patch} revision ${envelope.payload.revision}`)
