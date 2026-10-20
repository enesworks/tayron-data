const fs = require('node:fs/promises')
const path = require('node:path')
const crypto = require('node:crypto')
const zlib = require('node:zlib')
const { canonical, computeRevision, readGzipJson } = require('../electron/draft-data-format.cjs')
const WIN_RATE_PUBLISH_THRESHOLD = 0.02
const MIN_CHANGED_CHAMPIONS_TO_PUBLISH = 30

function metaRowMap(snapshot) {
  return new Map((snapshot?.rows || []).map(row => [`${row[0]}:${row[1]}`, row]))
}

function matchupRowMap(cell) {
  return new Map((cell?.rows || []).map(row => [row[0], row]))
}

function sameItemBuild(left, right) {
  const project = cell => ({ status: cell?.status, blocks: cell?.blocks || [] })
  return canonical(project(left)) === canonical(project(right))
}

function semanticRuneCell(cell) { return { status: cell?.status, page: cell?.page } }

function hasSignificantDataChange(previous, current, threshold = WIN_RATE_PUBLISH_THRESHOLD, minChangedChampions = MIN_CHANGED_CHAMPIONS_TO_PUBLISH) {
  if (!previous || previous.schemaVersion !== current.schemaVersion || previous.patch !== current.patch
    || canonical(previous.champions) !== canonical(current.champions)) return true

  const changedWinRateChampions = new Set()
  const changedMetadataChampions = new Set()
  const ranks = new Set([...Object.keys(previous.meta || {}), ...Object.keys(current.meta || {})])
  for (const rank of ranks) {
    const before = previous.meta?.[rank]
    const after = current.meta?.[rank]
    if (!before || !after) return true
    const beforeMissing = new Set((before.missing || []).map(([id, lane]) => `${id}:${lane}`))
    const afterMissing = new Set((after.missing || []).map(([id, lane]) => `${id}:${lane}`))
    for (const key of new Set([...beforeMissing, ...afterMissing])) {
      if (beforeMissing.has(key) !== afterMissing.has(key)) changedMetadataChampions.add(Number(key.split(':')[0]))
    }
    const oldRows = metaRowMap(before)
    const newRows = metaRowMap(after)
    for (const key of new Set([...oldRows.keys(), ...newRows.keys()])) {
      if (oldRows.has(key) !== newRows.has(key)) changedMetadataChampions.add(Number(key.split(':')[0]))
    }
    for (const [key, row] of newRows) {
      const old = oldRows.get(key)
      if (!old) continue
      if (Math.abs(row[3] - old[3]) >= threshold) changedWinRateChampions.add(Number(row[0]))
      // Changes to role, tier, or strong/weak matchup metadata remain publishable;
      // a games-count-only refresh does not trigger a release.
      if (canonical([row[1], row[4], row[5], row[6], row[7], row[8]])
        !== canonical([old[1], old[4], old[5], old[6], old[7], old[8]])) changedMetadataChampions.add(Number(row[0]))
    }
  }

  const matchupRanks = new Set([...Object.keys(previous.matchups || {}), ...Object.keys(current.matchups || {})])
  for (const rank of matchupRanks) {
    const lanes = new Set([...Object.keys(previous.matchups?.[rank] || {}), ...Object.keys(current.matchups?.[rank] || {})])
    for (const lane of lanes) {
      const oldCells = previous.matchups?.[rank]?.[lane] || {}
      const newCells = current.matchups?.[rank]?.[lane] || {}
      const championIds = new Set([...Object.keys(oldCells), ...Object.keys(newCells)])
      for (const championId of championIds) {
        const oldCell = oldCells[championId]
        const newCell = newCells[championId]
        if (!oldCell || !newCell || oldCell.status !== newCell.status) {
          changedMetadataChampions.add(Number(championId))
          continue
        }
        const oldRows = matchupRowMap(oldCell)
        const newRows = matchupRowMap(newCell)
        if (oldRows.size !== newRows.size) changedMetadataChampions.add(Number(championId))
        for (const [slug, row] of newRows) {
          const old = oldRows.get(slug)
          if (old && Math.abs(row[1] - old[1]) >= threshold) changedWinRateChampions.add(Number(championId))
        }
      }
    }
  }
  if (changedWinRateChampions.size >= minChangedChampions) return true

  const changedItemBuildChampions = new Set()
  const previousItemIds = new Set()
  const currentItemIds = new Set()
  for (const lane of new Set([...Object.keys(previous.itemBuilds || {}), ...Object.keys(current.itemBuilds || {})])) {
    const before = previous.itemBuilds?.[lane] || {}
    const after = current.itemBuilds?.[lane] || {}
    for (const championId of new Set([...Object.keys(before), ...Object.keys(after)])) {
      for (const block of before[championId]?.blocks || []) for (const item of block.items || []) previousItemIds.add(Number(item.id))
      for (const block of after[championId]?.blocks || []) for (const item of block.items || []) currentItemIds.add(Number(item.id))
      if (!sameItemBuild(before[championId], after[championId])) changedItemBuildChampions.add(Number(championId))
    }
  }
  if ([...currentItemIds].some(id => !previousItemIds.has(id)) || changedItemBuildChampions.size >= minChangedChampions) return true

  const previousRunes = previous.runeData
  const currentRunes = current.runeData
  if (Boolean(previousRunes) !== Boolean(currentRunes)) return true
  if (currentRunes) {
    if (canonical({ styles: previousRunes.styles, perks: previousRunes.perks, statModIds: previousRunes.statModIds })
      !== canonical({ styles: currentRunes.styles, perks: currentRunes.perks, statModIds: currentRunes.statModIds })) return true
    const changedRuneChampions = new Set()
    for (const championId of new Set([...Object.keys(previousRunes.builds || {}), ...Object.keys(currentRunes.builds || {})])) {
      if (canonical(Object.fromEntries(Object.keys(previousRunes.builds?.[championId] || {}).map(lane => [lane, semanticRuneCell(previousRunes.builds[championId][lane])]).sort()))
        !== canonical(Object.fromEntries(Object.keys(currentRunes.builds?.[championId] || {}).map(lane => [lane, semanticRuneCell(currentRunes.builds[championId][lane])]).sort()))) changedRuneChampions.add(Number(championId))
    }
    if (changedRuneChampions.size >= minChangedChampions) return true
  }

  return changedMetadataChampions.size >= minChangedChampions
}

function retainSubthresholdWinRates(previous, current, threshold = WIN_RATE_PUBLISH_THRESHOLD) {
  if (!previous || previous.schemaVersion !== current.schemaVersion || previous.patch !== current.patch
    || canonical(previous.champions) !== canonical(current.champions)) return 0
  let retained = 0
  for (const [rank, snapshot] of Object.entries(current.meta || {})) {
    const oldRows = metaRowMap(previous.meta?.[rank])
    for (const row of snapshot.rows || []) {
      const old = oldRows.get(`${row[0]}:${row[1]}`)
      if (old && Math.abs(row[3] - old[3]) < threshold) {
        if (row[3] !== old[3]) retained += 1
        row[3] = old[3]
      }
    }
  }
  for (const [rank, lanes] of Object.entries(current.matchups || {})) {
    for (const [lane, cells] of Object.entries(lanes || {})) {
      const oldCells = previous.matchups?.[rank]?.[lane] || {}
      for (const [championId, cell] of Object.entries(cells || {})) {
        const oldRows = matchupRowMap(oldCells[championId])
        for (const row of cell.rows || []) {
          const old = oldRows.get(row[0])
          if (old && Math.abs(row[1] - old[1]) < threshold) {
            if (row[1] !== old[1]) retained += 1
            row[1] = old[1]
          }
        }
      }
    }
  }
  return retained
}

function sameMatchupData(left, right) {
  const sortedRows = rows => [...(rows || [])].sort((a, b) => a[0].localeCompare(b[0]))
  return canonical({ status: left?.status, rows: sortedRows(left?.rows) }) === canonical({ status: right?.status, rows: sortedRows(right?.rows) })
}

function sameItemBuildData(left, right) {
  const project = cell => ({ status: cell?.status, games: cell?.games, winRate: cell?.winRate, blocks: cell?.blocks || [] })
  return canonical(project(left)) === canonical(project(right))
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
    itemBuildCoverage: current.itemBuildCoverage,
    metaReplacements: {},
    matchupReplacements: [],
    itemBuildReplacements: [],
    runeDataReplacement: null,
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
  for (const lane of Object.keys(current.itemBuilds || {}).sort()) {
    for (const [championId, cell] of Object.entries(current.itemBuilds[lane])) {
      const before = previous.itemBuilds?.[lane]?.[championId]
      if (!before || !sameItemBuildData(before, cell)) delta.itemBuildReplacements.push([lane, Number(championId), cell])
    }
  }
  if (current.runeData && canonical(previous.runeData) !== canonical(current.runeData)) delta.runeDataReplacement = current.runeData
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
  if (previous && previous.patch === current.patch && !hasSignificantDataChange(previous, current)) {
    const unchanged = {
      formatVersion: 1,
      kind: 'unchanged',
      patch: current.patch,
      generatedAt: current.generatedAt,
      revision: previous.revision || computeRevision(previous),
      changedCells: 0,
      reason: 'significant_same_patch_change_threshold_not_met',
    }
    await writeAtomic(path.join(outputDirectory, 'draft-data-update-current.json'), Buffer.from(JSON.stringify(unchanged, null, 2)))
    return unchanged
  }
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
      changedCells = comparison.delta.matchupReplacements.length + comparison.delta.itemBuildReplacements.length
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

module.exports = {
  WIN_RATE_PUBLISH_THRESHOLD,
  buildDraftDataUpdate,
  hasSignificantDataChange,
  makeDelta,
  retainSubthresholdWinRates,
}
