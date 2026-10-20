const crypto = require('node:crypto')
const zlib = require('node:zlib')

function stable(value) {
  if (Array.isArray(value)) return value.map(stable)
  if (!value || typeof value !== 'object') return value
  return Object.fromEntries(Object.keys(value).sort().map(key => [key, stable(value[key])]))
}

function canonical(value) {
  return JSON.stringify(stable(value))
}

function semanticBundle(bundle) {
  const meta = Object.fromEntries(Object.keys(bundle.meta || {}).sort().map(rank => {
    const entry = bundle.meta[rank]
    const rows = [...(entry.rows || [])].sort((a, b) => a[0] - b[0] || a[1].localeCompare(b[1]))
    const missing = [...(entry.missing || [])].sort((a, b) => a[0] - b[0] || a[1].localeCompare(b[1]))
    return [rank, { rows, missing }]
  }))
  const matchups = {}
  for (const rank of Object.keys(bundle.matchups || {}).sort()) {
    matchups[rank] = {}
    for (const lane of Object.keys(bundle.matchups[rank] || {}).sort()) {
      matchups[rank][lane] = {}
      for (const championId of Object.keys(bundle.matchups[rank][lane] || {}).sort((a, b) => Number(a) - Number(b))) {
        const cell = bundle.matchups[rank][lane][championId]
        const rows = [...(cell.rows || [])].sort((a, b) => a[0].localeCompare(b[0]))
        matchups[rank][lane][championId] = { status: cell.status, rows }
      }
    }
  }
  const itemBuilds = {}
  for (const lane of Object.keys(bundle.itemBuilds || {}).sort()) {
    itemBuilds[lane] = {}
    for (const championId of Object.keys(bundle.itemBuilds[lane] || {}).sort((a, b) => Number(a) - Number(b))) {
      const cell = bundle.itemBuilds[lane][championId]
      itemBuilds[lane][championId] = {
        status: cell.status, games: cell.games, winRate: cell.winRate,
        blocks: (cell.blocks || []).map(block => ({ type: block.type, items: [...(block.items || [])].map(item => ({ id: item.id, name: item.name })) })),
      }
    }
  }
  const semantic = {
    schemaVersion: bundle.schemaVersion,
    patch: bundle.patch,
    dataDragonVersion: bundle.dataDragonVersion,
    champions: bundle.champions,
    meta,
    matchups,
  }
  if (bundle.itemBuilds) semantic.itemBuilds = itemBuilds
  return semantic
}

function computeRevision(bundle) {
  return crypto.createHash('sha256').update(canonical(semanticBundle(bundle))).digest('hex')
}

function readGzipJson(bytes) {
  return JSON.parse(zlib.gunzipSync(bytes).toString('utf8'))
}

function applyDraftDataDelta(baseBundle, delta) {
  if (!delta || delta.formatVersion !== 1 || delta.kind !== 'delta') throw new Error('Unsupported draft-data delta format')
  const baseRevision = computeRevision(baseBundle)
  if (baseRevision !== delta.baseRevision) throw new Error('Delta base revision does not match the installed snapshot')
  if (baseBundle.patch !== delta.patch) throw new Error('A delta cannot cross a game patch boundary')
  const next = structuredClone(baseBundle)
  next.generatedAt = delta.generatedAt
  next.revision = delta.targetRevision
  next.coverage = delta.coverage
  if (delta.itemBuildCoverage) next.itemBuildCoverage = delta.itemBuildCoverage
  for (const [rank, snapshot] of Object.entries(delta.metaReplacements || {})) next.meta[rank] = snapshot
  for (const replacement of delta.matchupReplacements || []) {
    const [rank, lane, championId, cell] = replacement
    if (!next.matchups?.[rank]?.[lane]) throw new Error(`Delta references unknown grid ${rank}/${lane}`)
    next.matchups[rank][lane][championId] = cell
  }
  for (const replacement of delta.itemBuildReplacements || []) {
    const [lane, championId, cell] = replacement
    if (!next.itemBuilds?.[lane]) throw new Error(`Delta references unknown item-build lane ${lane}`)
    next.itemBuilds[lane][championId] = cell
  }
  if (computeRevision(next) !== delta.targetRevision) throw new Error('Applied delta does not produce the declared target revision')
  return next
}

module.exports = { applyDraftDataDelta, canonical, computeRevision, readGzipJson, semanticBundle }
