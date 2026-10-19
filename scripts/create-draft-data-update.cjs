const fs = require('node:fs/promises')
const path = require('node:path')
const crypto = require('node:crypto')
const zlib = require('node:zlib')
const { canonical, computeRevision, readGzipJson } = require('../electron/draft-data-format.cjs')

function sameMatchupData(left, right) {
  const sortedRows = rows => [...(rows || [])].sort((a, b) => a[0].localeCompare(b[0]))
  return canonical({ status: left?.status, rows: sortedRows(left?.rows) }) === canonical({ status: right?.status, rows: sortedRows(right?.rows) })
}

function makeDelta(previous, current) {
  if (!previous || previous.schemaVersion !== current.schemaVersion || previous.patch !== current.patch
    || canonical(previous.champions) !== canonical(current.champions)) return null
  const delta = {
    formatVersion: 1,
    kind: 'delta',
    baseRevision: computeRevision(previous),
    targetRevision: computeRevision(current),
    patch: current.patch,
    generatedAt: current.generatedAt,
    coverage: current.coverage,
    metaReplacements: {},
    matchupReplacements: [],
  }
  for (const rank of Object.keys(current.meta).sort()) {
    const before = previous.meta?.[rank]
    const after = current.meta[rank]
    if (!before || canonical({ rows: before.rows, missing: before.missing }) !== canonical({ rows: after.rows, missing: after.missing })) {
      delta.metaReplacements[rank] = after
    }
  }
  for (const rank of Object.keys(current.matchups).sort()) {
    for (const lane of Object.keys(current.matchups[rank]).sort()) {
      for (const [championId, cell] of Object.entries(current.matchups[rank][lane])) {
        const before = previous.matchups?.[rank]?.[lane]?.[championId]
        if (!before || !sameMatchupData(before, cell)) delta.matchupReplacements.push([rank, lane, Number(championId), cell])
      }
    }
  }
  if (delta.targetRevision === delta.baseRevision) return { kind: 'unchanged', delta: null }
  return { kind: 'delta', delta }
}

async function writeAtomic(file, bytes) {
  await fs.mkdir(path.dirname(file), { recursive: true })
  const temporary = `${file}.${process.pid}.tmp`
  await fs.writeFile(temporary, bytes)
  await fs.rename(temporary, file)
}

async function buildDraftDataUpdate({ previousPath, currentPath, currentManifestPath, outputDirectory, deltaThreshold = 0.65 }) {
  const currentBytes = await fs.readFile(currentPath)
  const currentManifest = JSON.parse(await fs.readFile(currentManifestPath, 'utf8'))
  const current = readGzipJson(currentBytes)
  const currentRevision = computeRevision(current)
  if (current.revision !== currentRevision || currentManifest.revision !== currentRevision) throw new Error('Current snapshot revision is inconsistent')

  let previous = null
  try { previous = readGzipJson(await fs.readFile(previousPath)) } catch { /* First release or no compatible base. */ }
  const comparison = makeDelta(previous, current)
  if (comparison?.kind === 'unchanged') {
    const unchanged = { formatVersion: 1, kind: 'unchanged', patch: current.patch, generatedAt: current.generatedAt, revision: currentRevision, changedCells: 0 }
    await writeAtomic(path.join(outputDirectory, 'draft-data-update-current.json'), Buffer.from(JSON.stringify(unchanged, null, 2)))
    return unchanged
  }
  const fullName = 'draft-data-current.json.gz'
  const fullSha256 = crypto.createHash('sha256').update(currentBytes).digest('hex')
  let artifact = fullName
  let artifactBytes = currentBytes
  let kind = 'full'
  let baseRevision = null
  let changedCells = 0
  if (comparison?.kind === 'delta') {
    const deltaBytes = zlib.gzipSync(Buffer.from(JSON.stringify(comparison.delta)), { level: 9 })
    if (deltaBytes.length < currentBytes.length * deltaThreshold) {
      kind = 'delta'
      artifact = 'draft-data-delta-current.json.gz'
      artifactBytes = deltaBytes
      baseRevision = comparison.delta.baseRevision
      changedCells = comparison.delta.matchupReplacements.length
    }
  }
  await writeAtomic(path.join(outputDirectory, artifact), artifactBytes)
  const updateManifest = {
    formatVersion: 1,
    kind,
    patch: current.patch,
    generatedAt: current.generatedAt,
    baseRevision,
    revision: currentRevision,
    artifact,
    sha256: crypto.createHash('sha256').update(artifactBytes).digest('hex'),
    compressedBytes: artifactBytes.length,
    fullArtifact: fullName,
    fullSha256,
    fullCompressedBytes: currentBytes.length,
  }
  await writeAtomic(path.join(outputDirectory, 'draft-data-update-current.json'), Buffer.from(JSON.stringify(updateManifest, null, 2)))
  return { ...updateManifest, changedCells }
}

if (require.main === module) {
  const root = path.resolve(__dirname, '..')
  buildDraftDataUpdate({
    previousPath: process.argv[2] || path.join(root, 'data', 'draft-data-previous.json.gz'),
    currentPath: process.argv[3] || path.join(root, 'data', 'draft-data-current.json.gz'),
    currentManifestPath: process.argv[4] || path.join(root, 'data', 'draft-data-current.manifest.json'),
    outputDirectory: process.argv[5] || path.join(root, 'data'),
  }).then(result => console.log(JSON.stringify(result, null, 2))).catch(error => {
    console.error(error.stack || error.message)
    process.exitCode = 1
  })
}

module.exports = { buildDraftDataUpdate, makeDelta }
