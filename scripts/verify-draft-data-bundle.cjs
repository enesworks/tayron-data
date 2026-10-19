const fs = require('node:fs')
const path = require('node:path')
const crypto = require('node:crypto')
const zlib = require('node:zlib')
const { computeRevision } = require('../electron/draft-data-format.cjs')

const root = path.resolve(__dirname, '..')
const bundlePath = path.join(root, 'data', 'draft-data-current.json.gz')
const manifestPath = path.join(root, 'data', 'draft-data-current.manifest.json')
const ranksExpected = ['IRON', 'BRONZE', 'SILVER', 'GOLD', 'PLATINUM', 'EMERALD', 'EMERALD+', 'DIAMOND', 'DIAMOND+', 'MASTER', 'MASTER+', 'GRANDMASTER', 'CHALLENGER']
const lanesExpected = ['Top', 'Mid', 'Bot']
const fail = message => { throw new Error(message) }
const isUnavailableSourceCell = cell => cell?.status === 'unavailable' && Array.isArray(cell.rows) && cell.rows.length === 0
  && (/^HTTP 500\b/.test(cell.reason || '') || cell.reason === 'source_server_error_no_data' || cell.reason === 'explicitly_omitted_after_source_500')

function main() {
  const compressed = fs.readFileSync(bundlePath)
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'))
  const actualHash = crypto.createHash('sha256').update(compressed).digest('hex')
  if (manifest.schemaVersion !== 1 || manifest.sha256 !== actualHash) fail('Bundle checksum or schema version does not match the manifest')
  const bundle = JSON.parse(zlib.gunzipSync(compressed).toString('utf8'))
  const ids = new Set()
  const slugs = new Set()
  if (bundle.schemaVersion !== 1 || bundle.patch !== manifest.patch || bundle.dataDragonVersion !== manifest.dataDragonVersion) fail('Bundle and manifest patch metadata differ')
  if (bundle.revision !== computeRevision(bundle) || manifest.revision !== bundle.revision) fail('Bundle content revision does not match its manifest')
  if (!Array.isArray(bundle.champions) || bundle.champions.length !== manifest.championCount || bundle.champions.length < 100) fail('Champion catalog is missing or inconsistent')
  for (const champion of bundle.champions) {
    if (!Number.isSafeInteger(champion.key) || !champion.id || !champion.slug || ids.has(champion.key) || slugs.has(champion.slug)) fail(`Invalid or duplicate champion ${champion?.id}`)
    ids.add(champion.key)
    slugs.add(champion.slug)
  }
  if (JSON.stringify(manifest.ranks) !== JSON.stringify(ranksExpected)) fail('Rank coverage does not match the supported rank list')
  const expectedPages = bundle.champions.length * ranksExpected.length * lanesExpected.length
  if (manifest.coverage?.planned !== expectedPages
    || manifest.coverage.complete + manifest.coverage.lowSample + manifest.coverage.unavailable !== expectedPages
    || manifest.coverage.invalid !== 0) fail('Matchup grid is incomplete or contains invalid/unavailable pages')

  let checkedCells = 0
  for (const rank of ranksExpected) {
    const meta = bundle.meta?.[rank]
    if (!meta || !Array.isArray(meta.rows) || !Array.isArray(meta.missing)) fail(`Missing role metadata for ${rank}`)
    const roleCells = new Set()
    for (const row of meta.rows) {
      if (!ids.has(row[0]) || !['Top', 'Mid', 'Bot', 'Jungle', 'Support', 'All roles'].includes(row[1])
        || !Number.isSafeInteger(row[2]) || row[2] < 0 || !Number.isFinite(row[3]) || row[3] < 0 || row[3] > 1) fail(`Invalid role metadata row for ${rank}`)
      roleCells.add(`${row[0]}:${row[1]}`)
    }
    const missing = new Set(meta.missing.map(([id, lane]) => `${id}:${lane}`))
    if (roleCells.size + missing.size !== bundle.champions.length * 6 || [...roleCells].some(cell => missing.has(cell))) fail(`Role metadata missing-cell accounting failed for ${rank}`)
    for (const lane of lanesExpected) {
      for (const champion of bundle.champions) {
        const cell = bundle.matchups?.[rank]?.[lane]?.[champion.key]
        if (!cell || !['complete', 'low_sample', 'unavailable'].includes(cell.status) || !Array.isArray(cell.rows)) fail(`Missing matchup cell ${rank}/${lane}/${champion.id}`)
        if (cell.status === 'unavailable' && !isUnavailableSourceCell(cell)) fail(`Unexpected unavailable matchup cell: ${rank}/${lane}/${champion.id}`)
        if (!cell.sourceUrl) fail(`Matchup cell has no source URL: ${rank}/${lane}/${champion.id}`)
        const source = new URL(cell.sourceUrl)
        if (!source.hostname.endsWith('lolalytics.com') || source.searchParams.get('patch') !== bundle.patch) fail(`Source URL filters mismatch: ${rank}/${lane}/${champion.id}`)
        const seen = new Set()
        for (const [slug, targetWinRate, games] of cell.rows) {
          if (!slugs.has(slug) || slug === champion.slug || seen.has(slug) || !Number.isFinite(targetWinRate) || targetWinRate < 0 || targetWinRate > 1 || !Number.isSafeInteger(games) || games < 1) fail(`Invalid matchup row: ${rank}/${lane}/${champion.id}/${slug}`)
          seen.add(slug)
        }
        if (cell.status !== 'complete' && cell.rows.length !== 0) fail(`Unavailable/low-sample cell has rows: ${rank}/${lane}/${champion.id}`)
        checkedCells += 1
      }
    }
  }
  if (checkedCells !== expectedPages) fail(`Expected ${expectedPages} matchup cells, found ${checkedCells}`)
  if (bundle.itemBuilds) {
    const lanes = ['Top', 'Jungle', 'Mid', 'Bot', 'Support']
    const coverage = manifest.itemBuildCoverage
    const expectedItems = bundle.champions.length * lanes.length
    if (!coverage || coverage.planned !== expectedItems
      || coverage.ready + coverage.insufficient + coverage.unavailable !== expectedItems || coverage.invalid !== 0) fail('Item-build coverage is incomplete')
    let ready = 0
    for (const lane of lanes) for (const champion of bundle.champions) {
      const cell = bundle.itemBuilds[lane]?.[champion.key]
      if (!cell || !['ready', 'insufficient', 'unavailable'].includes(cell.status) || !Number.isSafeInteger(cell.games) || cell.games < 0
        || cell.winRate != null && (!Number.isFinite(cell.winRate) || cell.winRate < 0 || cell.winRate > 1) || !Array.isArray(cell.blocks)) fail(`Invalid item build ${lane}/${champion.id}`)
      if (cell.status === 'ready' && cell.games < 100) fail(`Item-build sample is below minimum for ${lane}/${champion.id}`)
      if (cell.status === 'ready') ready += 1
      const source = new URL(cell.sourceUrl)
      const expectedLane = ({ Top: 'top', Jungle: 'jungle', Mid: 'middle', Bot: 'bottom', Support: 'support' })[lane]
      if (source.hostname !== 'lolalytics.com' || source.searchParams.get('patch') !== bundle.patch
        || source.searchParams.get('lane') !== expectedLane || source.searchParams.get('tier') !== 'all') fail(`Item-build source filters mismatch: ${lane}/${champion.id}`)
      for (const block of cell.blocks) {
        if (!block.type || !Array.isArray(block.items) || block.items.some(item => !Number.isSafeInteger(item.id) || item.id < 1 || !item.name)) fail(`Invalid item block ${lane}/${champion.id}`)
      }
    }
    if (ready !== coverage.ready) fail('Item-build ready count differs from its manifest')
  }
  console.log(`Verified patch ${bundle.patch}: ${bundle.champions.length} champions, ${ranksExpected.length} rank scopes, ${lanesExpected.join('/')} matchups (${checkedCells} cells).`)
  console.log(`Complete=${manifest.coverage.complete}; low-sample (explicit)=${manifest.coverage.lowSample}; role-metadata missing source cells=${ranksExpected.reduce((sum, rank) => sum + bundle.meta[rank].missing.length, 0)}.`)
  console.log(`Compressed size=${manifest.compressedBytes} bytes; sha256=${actualHash}`)
}

try { main() } catch (error) {
  console.error(error.stack || error.message)
  process.exitCode = 1
}
