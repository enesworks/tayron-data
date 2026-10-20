const fs = require('node:fs/promises')
const path = require('node:path')
const crypto = require('node:crypto')
const zlib = require('node:zlib')
const { computeRevision, readGzipJson } = require('../electron/draft-data-format.cjs')
const { buildDraftDataUpdate } = require('./create-draft-data-update.cjs')

const root = path.resolve(__dirname, '..')
const data = path.join(root, 'data')
const sha256 = bytes => crypto.createHash('sha256').update(bytes).digest('hex')

async function main() {
  const draftPath = path.join(data, 'draft-data-current.json.gz')
  const draftManifestPath = path.join(data, 'draft-data-current.manifest.json')
  const runePath = path.join(data, 'rune-data-current.json.gz')
  const runeManifestPath = path.join(data, 'rune-data-current.manifest.json')
  const draft = readGzipJson(await fs.readFile(draftPath))
  const draftManifest = JSON.parse(await fs.readFile(draftManifestPath, 'utf8'))
  const runeBytes = await fs.readFile(runePath)
  const runeManifest = JSON.parse(await fs.readFile(runeManifestPath, 'utf8'))
  const runeData = readGzipJson(runeBytes)
  if (runeManifest.sha256 !== sha256(runeBytes) || runeManifest.revision !== runeData.revision
    || runeData.patch !== draft.patch || runeData.dataDragonVersion !== draft.dataDragonVersion
    || runeData.champions.length !== draft.champions.length) throw new Error('Rune bundle does not match the current verified draft snapshot')
  draft.runeData = runeData
  draft.revision = computeRevision(draft)
  const compressed = zlib.gzipSync(Buffer.from(JSON.stringify(draft)), { level: 9 })
  const temp = `${draftPath}.${process.pid}.tmp`
  await fs.writeFile(temp, compressed)
  await fs.rename(temp, draftPath)
  Object.assign(draftManifest, { revision: draft.revision, compressedBytes: compressed.length,
    uncompressedBytes: zlib.gunzipSync(compressed).length, sha256: sha256(compressed), runeRevision: runeData.revision,
    runeCoverage: runeData.coverage })
  await fs.writeFile(draftManifestPath, JSON.stringify(draftManifest, null, 2) + '\n')
  const update = await buildDraftDataUpdate({ previousPath: path.join(data, 'draft-data-previous.json.gz'), currentPath: draftPath,
    currentManifestPath: draftManifestPath, outputDirectory: data })
  await fs.unlink(path.join(data, 'draft-data-previous.json.gz')).catch(() => undefined)
  console.log(`Attached rune revision ${runeData.revision}; combined revision ${draft.revision}; update=${update.kind}`)
}

main().catch(error => { console.error(error.stack || error.message); process.exitCode = 1 })
