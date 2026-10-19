const fs = require('node:fs')
const crypto = require('node:crypto')
const path = require('node:path')

const root = path.resolve(__dirname, '..')
const update = JSON.parse(fs.readFileSync(path.join(root, 'data', 'draft-data-update-current.json'), 'utf8'))
const tag = `data-${update.revision}`
const assetUrl = name => `https://github.com/enesworks/tayron-data/releases/download/${tag}/${name}`
const payload = {
  formatVersion: 1,
  schemaVersion: 1,
  patch: update.patch,
  generatedAt: update.generatedAt,
  revision: update.revision,
  kind: update.kind,
  baseRevision: update.baseRevision,
  artifactUrl: assetUrl(update.artifact),
  sha256: update.sha256,
  compressedBytes: update.compressedBytes,
  fullArtifactUrl: assetUrl(update.fullArtifact),
  fullSha256: update.fullSha256,
  fullCompressedBytes: update.fullCompressedBytes,
}
const canonical = JSON.stringify(Object.fromEntries(Object.keys(payload).sort().map(key => [key, payload[key]])))
const privateKey = process.env.TAYRON_DATA_SIGNING_KEY
if (!privateKey) throw new Error('TAYRON_DATA_SIGNING_KEY is required')
const signature = crypto.sign(null, Buffer.from(canonical), privateKey).toString('base64')
fs.writeFileSync(path.join(root, 'latest.json'), `${JSON.stringify({ payload, signature }, null, 2)}\n`)
console.log(`Signed latest.json for ${payload.patch} revision ${payload.revision}`)
