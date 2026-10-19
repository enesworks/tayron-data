const fs = require('node:fs/promises')
const path = require('node:path')
const crypto = require('node:crypto')
const zlib = require('node:zlib')
const { computeRevision, readGzipJson } = require('../electron/draft-data-format.cjs')
const { buildDraftDataUpdate, retainSubthresholdWinRates, WIN_RATE_PUBLISH_THRESHOLD } = require('./create-draft-data-update.cjs')

const ROOT = path.resolve(__dirname, '..')
const STAGING = process.env.TAYRON_DATA_STAGING_DIR
  ? path.resolve(process.env.TAYRON_DATA_STAGING_DIR)
  : path.join(process.env.LOCALAPPDATA || path.join(ROOT, '.cache'), 'Tayron', 'draft-data-staging')
const OUTPUT = path.join(ROOT, 'data')
const SCHEMA_VERSION = 1
const TIERS = [
  ['IRON', 'iron'], ['BRONZE', 'bronze'], ['SILVER', 'silver'], ['GOLD', 'gold'],
  ['PLATINUM', 'platinum'], ['EMERALD', 'emerald'], ['EMERALD+', 'emerald_plus'],
  ['DIAMOND', 'diamond'], ['DIAMOND+', 'diamond_plus'], ['MASTER', 'master'],
  ['MASTER+', 'master_plus'], ['GRANDMASTER', 'grandmaster'], ['CHALLENGER', 'challenger'],
]
const LANES = [['Top', 'top'], ['Mid', 'middle'], ['Bot', 'bottom']]
const LANE_TO_ROLE = { Top: 'TOP', Mid: 'MIDDLE', Bot: 'BOTTOM', Jungle: 'JUNGLE', Support: 'UTILITY', 'All roles': 'ALL' }
const ROLE_TO_LANE = Object.fromEntries(Object.entries(LANE_TO_ROLE).map(([lane, role]) => [role, lane]))
const SLUG_OVERRIDES = { monkeyking: 'wukong', nunu: 'nunu', nunuandwillump: 'nunu', renata: 'renata', renataglasc: 'renata' }
const REQUEST_GAP_MS = 1000
const MAX_RETRIES = 5
// This one page returned a server-error document during the current 16.20
// crawl. Keep its matchup cell explicitly unavailable; draft will use lane WR.
const OMITTED_MATCHUP_CELLS = new Set(['16.20:MASTER:Bot:876'])
const isOmittedMatchup = ({ patch, rank, lane, championId }) => OMITTED_MATCHUP_CELLS.has(`${patch}:${rank}:${lane}:${championId}`)

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
const safeSlug = value => {
  const normalized = String(value).toLowerCase().replace(/[^a-z0-9]/g, '')
  return SLUG_OVERRIDES[normalized] || normalized
}
const normalizeText = value => String(value).replace(/<[^>]*>/g, ' ').replace(/&amp;/g, '&').replace(/&nbsp;/g, ' ').replace(/&#39;|&#x27;/gi, "'").replace(/&quot;/g, '"').replace(/\s+/g, ' ').trim()

async function fetchResponse(url, accept = 'text/html') {
  let lastError
  for (let attempt = 0; attempt < MAX_RETRIES; attempt += 1) {
    try {
      const response = await fetch(url, {
        headers: { Accept: accept, 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/130.0.0.0 Safari/537.36' },
        signal: AbortSignal.timeout(20000),
      })
      if (response.ok) return response
      await response.body?.cancel().catch(() => undefined)
      lastError = new Error(`HTTP ${response.status}`)
      if (response.status === 404) throw Object.assign(lastError, { permanent: true })
      if (response.status === 429) await sleep(Math.min(60000, 5000 * (attempt + 1)))
    } catch (error) {
      if (error?.permanent) throw error
      lastError = error
    }
    if (attempt < MAX_RETRIES - 1) await sleep(Math.min(30000, 1500 * (attempt + 1)))
  }
  throw lastError || new Error('Request failed')
}

function parseMatchups(html, targetSlug) {
  const rows = []
  const seen = new Set()
  const anchors = /<a\b([^>]*\bhref="([^"]+)"[^>]*)>([\s\S]*?)<\/a>/gi
  let match
  while ((match = anchors.exec(html))) {
    const href = match[2].replace(/&amp;/g, '&')
    const link = href.match(/\/lol\/([^/?#]+)\/vs\/([^/?#]+)\/build\//i)
    if (!link || safeSlug(link[1]) !== targetSlug) continue
    const candidateSlug = safeSlug(link[2])
    if (!candidateSlug || candidateSlug === targetSlug || seen.has(candidateSlug)) continue
    const text = normalizeText(match[3])
    const games = text.match(/([\d,]+)\s+Games\b/i)
    const winRate = text.match(/(\d{1,2}(?:\.\d+)?)\s*%\s*VS\b/i)
    if (!games || !winRate) continue
    const sampleCount = Number(games[1].replace(/,/g, ''))
    const targetWinRate = Number(winRate[1]) / 100
    if (!Number.isSafeInteger(sampleCount) || sampleCount < 1 || targetWinRate < 0 || targetWinRate > 1) continue
    seen.add(candidateSlug)
    rows.push([candidateSlug, targetWinRate, sampleCount])
  }
  return rows
}

function pageMetadata(html) {
  const title = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] || ''
  const description = html.match(/<meta\s+name="description"\s+content="([^"]*)"/i)?.[1] || ''
  return { title: normalizeText(title), description: normalizeText(description), text: normalizeText(html) }
}

function classifyMatchupPage(html, request) {
  const metadata = pageMetadata(html)
  const patchOk = new RegExp(`Patch\\s+${request.patch.replace('.', '\\.')}(?:\\D|$)`, 'i').test(metadata.description)
  const normalizeComparable = value => String(value).toLowerCase().replace(/[^a-z0-9]/g, '')
  const titleOk = normalizeComparable(metadata.title).includes(`${normalizeComparable(request.championName)}${request.laneSlug}versus${request.laneSlug}`)
  const tierLabel = request.tier.replace('_plus', '+').toUpperCase()
  const tierOk = metadata.text.toUpperCase().includes(tierLabel)
  if (/404 Resource Not Found|Just a moment\.\.\./i.test(metadata.title)) return { status: 'unavailable', reason: 'source_page_not_found', metadata }
  if (!patchOk || !titleOk || !tierOk) return { status: 'invalid', reason: 'page_filters_do_not_match_request', metadata }
  const rows = parseMatchups(html, request.slug)
  const allowedCandidates = request.candidateSlugs ? new Set(request.candidateSlugs) : null
  const unknownCandidates = allowedCandidates ? rows.map(row => row[0]).filter(slug => !allowedCandidates.has(slug)) : []
  if (unknownCandidates.length) return { status: 'invalid', reason: `unknown_candidate_slugs:${[...new Set(unknownCandidates)].join(',')}`, metadata, rows }
  const hasInsufficientMarker = /insufficent games played|insufficient games played/i.test(html)
  if (!rows.length && hasInsufficientMarker) return { status: 'low_sample', rows, metadata }
  if (!rows.length) return { status: 'invalid', reason: 'no_rows_without_low_sample_marker', metadata }
  return { status: 'complete', rows, metadata }
}

async function readCheckpoint(file, expected) {
  try {
    const record = JSON.parse(await fs.readFile(file, 'utf8'))
    const reusableStatuses = ['complete', 'low_sample']
    if (record.patch === expected.patch && record.rank === expected.rank && record.lane === expected.lane && record.championId === expected.championId
      && (expected.scrapeId === undefined || record.scrapeId === expected.scrapeId)
      && (reusableStatuses.includes(record.status) || (record.status === 'unavailable' && isOmittedMatchup(expected)))) return record
  } catch { /* Rebuild missing or invalid checkpoints. */ }
  return null
}

async function writeJsonAtomic(file, value) {
  await fs.mkdir(path.dirname(file), { recursive: true })
  const temporary = `${file}.${process.pid}.tmp`
  await fs.writeFile(temporary, JSON.stringify(value), 'utf8')
  await fs.rename(temporary, file)
}

async function buildMeta(champions, patch) {
  const meta = {}
  const metaCoverage = {}
  for (const [rank, tier] of TIERS) {
    const url = new URL('https://data.v2.iesdev.com/api/v1/query_objects/prod/lol/champion_postmatch_stats')
    url.search = new URLSearchParams({ queue_id: 'RANKED_SOLO_5X5', region: 'WORLD', tier: rank }).toString()
    const response = await fetchResponse(url, 'application/json')
    const body = await response.json()
    if (!Array.isArray(body.data) || !body.data.length) throw new Error(`IESDev returned no role data for ${rank}`)
    const patchSet = [...new Set(body.data.map(row => String(row.patch)))]
    if (patchSet.length !== 1 || patchSet[0] !== patch) throw new Error(`IESDev patch mismatch for ${rank}: ${patchSet.join(',')}`)
    const championIds = new Set(champions.map(champion => champion.key))
    const rows = body.data.flatMap(row => {
      const championId = Number(row.champion_id)
      const lane = ROLE_TO_LANE[String(row.individual_position || '').toUpperCase()]
      const games = Number(row.games)
      const winRate = Number(row.win_rate)
      const roleShare = Number(row.role_pct_games)
      if (!championIds.has(championId) || !lane || !Number.isSafeInteger(games) || games < 0 || !Number.isFinite(winRate) || winRate < 0 || winRate > 1) return []
      const ids = value => Array.isArray(value) ? value.map(Number).filter(id => championIds.has(id)) : []
      return [[championId, lane, games, winRate, Number.isFinite(roleShare) ? roleShare : 0, row.is_most_popular_role === true,
        Number.isFinite(Number(row.champion_role_tier_filtered ?? row.champion_role_tier)) ? Number(row.champion_role_tier_filtered ?? row.champion_role_tier) : null,
        ids(row.strong_against), ids(row.weak_against)]]
    })
    if (!rows.length) throw new Error(`IESDev produced no usable role rows for ${rank}`)
    const present = new Set(rows.map(row => `${row[0]}:${row[1]}`))
    const roleLanes = Object.values(ROLE_TO_LANE)
    const missing = champions.flatMap(champion => roleLanes
      .filter(lane => !present.has(`${champion.key}:${lane}`))
      .map(lane => [champion.key, lane]))
    meta[rank] = { generatedAt: body.meta?.generated_at || null, rows, missing }
    metaCoverage[rank] = { expected: champions.length * roleLanes.length, present: present.size, missing: missing.length }
    console.log(`Meta ${rank}: ${present.size}/${champions.length * roleLanes.length} role cells (${missing.length} without source sample)`)
  }
  return { meta, metaCoverage }
}

async function main() {
  await fs.mkdir(OUTPUT, { recursive: true })
  const previousPath = path.join(OUTPUT, 'draft-data-previous.json.gz')
  const previousSource = process.env.TAYRON_PREVIOUS_BUNDLE || path.join(OUTPUT, 'draft-data-current.json.gz')
  if (previousSource !== previousPath) {
    try {
      const oldBytes = await fs.readFile(previousSource)
      await fs.writeFile(previousPath, oldBytes)
    } catch { /* First snapshot has no delta base and will publish a full bundle. */ }
  }
  let previousBundle = null
  try { previousBundle = readGzipJson(await fs.readFile(previousPath)) } catch { /* First snapshot. */ }

  const versions = await (await fetchResponse('https://ddragon.leagueoflegends.com/api/versions.json', 'application/json')).json()
  const ddragonVersion = versions[0]
  const patch = ddragonVersion.split('.').slice(0, 2).join('.')
  const championDocument = await (await fetchResponse(`https://ddragon.leagueoflegends.com/cdn/${ddragonVersion}/data/en_US/champion.json`, 'application/json')).json()
  const champions = Object.values(championDocument.data).map(champion => ({
    key: Number(champion.key), id: champion.id, slug: safeSlug(champion.id), name: champion.name, title: champion.title, tags: champion.tags,
  })).sort((a, b) => a.key - b.key)
  if (champions.length < 100 || champions.some(champion => !Number.isSafeInteger(champion.key) || !champion.slug)) throw new Error('Data Dragon champion catalog failed validation')
  const candidateSlugs = champions.map(champion => champion.slug)
  console.log(`Patch ${patch} (${ddragonVersion}), ${champions.length} champions, ${TIERS.length} rank scopes`)

  const roleData = await buildMeta(champions, patch)
  const bundle = {
    schemaVersion: SCHEMA_VERSION,
    patch,
    dataDragonVersion: ddragonVersion,
    generatedAt: new Date().toISOString(),
    providers: { matchups: 'LoLalytics', roleMeta: 'IESDev' },
    champions,
    meta: roleData.meta,
    metaCoverage: roleData.metaCoverage,
    matchups: {},
    coverage: { planned: TIERS.length * LANES.length * champions.length, complete: 0, lowSample: 0, unavailable: 0, invalid: 0 },
  }

  let completed = 0
  for (const [rank, tier] of TIERS) {
    bundle.matchups[rank] = {}
    for (const [lane, laneSlug] of LANES) {
      bundle.matchups[rank][lane] = {}
      for (const champion of champions) {
        const expected = { patch, rank, lane, championId: champion.key, ...(process.env.TAYRON_SCRAPE_ID ? { scrapeId: process.env.TAYRON_SCRAPE_ID } : {}) }
        const checkpoint = path.join(STAGING, patch, rank, lane, `${champion.key}.json`)
        let record = await readCheckpoint(checkpoint, expected)
        if (!record && isOmittedMatchup(expected)) {
          record = {
            ...expected,
            status: 'unavailable',
            rows: [],
            sourceUrl: `https://lolalytics.com/lol/${champion.slug}/counters/?${new URLSearchParams({ patch, tier, lane: laneSlug, vslane: laneSlug })}`,
            fetchedAt: new Date().toISOString(),
            reason: 'explicitly_omitted_after_source_500',
          }
          await writeJsonAtomic(checkpoint, record)
        }
        if (!record) {
          const url = new URL(`https://lolalytics.com/lol/${champion.slug}/counters/`)
          url.search = new URLSearchParams({ patch, tier, lane: laneSlug, vslane: laneSlug }).toString()
          const sourceUrl = url.toString()
          try {
            const response = await fetchResponse(url)
            const html = await response.text()
            if (Buffer.byteLength(html) > 5 * 1024 * 1024) throw new Error('source_response_too_large')
            const result = classifyMatchupPage(html, { ...expected, slug: champion.slug, championName: champion.name, candidateSlugs, laneSlug, tier })
            record = {
              ...expected,
              status: result.status,
              rows: result.rows || [],
              sourceUrl,
              sourceTitle: result.metadata.title,
              sourceDescription: result.metadata.description,
              fetchedAt: new Date().toISOString(),
              reason: result.reason || null,
            }
            if (record.status === 'invalid') record.error = result.reason
          } catch (error) {
            record = { ...expected, status: 'unavailable', rows: [], sourceUrl, fetchedAt: new Date().toISOString(), reason: error.message }
          }
          await writeJsonAtomic(checkpoint, record)
          await sleep(REQUEST_GAP_MS)
        }
        bundle.matchups[rank][lane][champion.key] = {
          status: record.status,
          rows: record.rows || [],
          fetchedAt: record.fetchedAt,
          sourceUrl: record.sourceUrl,
          reason: record.reason || null,
        }
        bundle.coverage[record.status === 'low_sample' ? 'lowSample' : record.status === 'complete' ? 'complete' : record.status === 'invalid' ? 'invalid' : 'unavailable'] += 1
        completed += 1
        if (completed % 25 === 0 || completed === bundle.coverage.planned) {
          console.log(`Pages ${completed}/${bundle.coverage.planned}; complete=${bundle.coverage.complete}, lowSample=${bundle.coverage.lowSample}, unavailable=${bundle.coverage.unavailable}, invalid=${bundle.coverage.invalid}`)
        }
      }
    }
  }

  const allowedOmissions = [...OMITTED_MATCHUP_CELLS].filter(key => key.startsWith(`${patch}:`)).length
  if (bundle.coverage.invalid > 0 || bundle.coverage.unavailable > allowedOmissions) throw new Error(`Refusing to publish: ${bundle.coverage.invalid} pages failed source/filter validation and ${bundle.coverage.unavailable} pages were unavailable; only ${allowedOmissions} explicitly omitted matchup cells are allowed.`)
  const retainedWinRates = retainSubthresholdWinRates(previousBundle, bundle, WIN_RATE_PUBLISH_THRESHOLD)
  if (retainedWinRates) console.log(`Retained ${retainedWinRates} same-patch win-rate values below the 1.0 percentage-point publication threshold.`)
  bundle.revision = computeRevision(bundle)
  const json = Buffer.from(JSON.stringify(bundle))
  const compressed = zlib.gzipSync(json, { level: 9 })
  const output = path.join(OUTPUT, 'draft-data-current.json.gz')
  await fs.mkdir(OUTPUT, { recursive: true })
  const temporary = `${output}.${process.pid}.tmp`
  await fs.writeFile(temporary, compressed)
  await fs.rename(temporary, output)
  for (const entry of await fs.readdir(OUTPUT, { withFileTypes: true })) {
    if (entry.isFile() && /^draft-data-.*(?:\.json\.gz|\.manifest\.json)$/.test(entry.name) && !['draft-data-current.json.gz', 'draft-data-current.manifest.json', 'draft-data-previous.json.gz'].includes(entry.name)) {
      await fs.unlink(path.join(OUTPUT, entry.name)).catch(() => undefined)
    }
  }
  const manifest = {
    schemaVersion: SCHEMA_VERSION,
    patch,
    dataDragonVersion: ddragonVersion,
    generatedAt: bundle.generatedAt,
    championCount: champions.length,
    ranks: TIERS.map(([rank]) => rank),
    metaCoverage: bundle.metaCoverage,
    coverage: bundle.coverage,
    revision: bundle.revision,
    uncompressedBytes: json.length,
    compressedBytes: compressed.length,
    sha256: crypto.createHash('sha256').update(compressed).digest('hex'),
  }
  await writeJsonAtomic(path.join(OUTPUT, 'draft-data-current.manifest.json'), manifest)
  const update = await buildDraftDataUpdate({
    previousPath,
    currentPath: output,
    currentManifestPath: path.join(OUTPUT, 'draft-data-current.manifest.json'),
    outputDirectory: OUTPUT,
  })
  await fs.unlink(previousPath).catch(() => undefined)
  console.log(`Wrote ${output}: ${compressed.length} bytes; sha256=${manifest.sha256}`)
  console.log(`Update ${update.kind}: ${update.changedCells} changed matchup cells; revision=${manifest.revision}`)
  console.log(JSON.stringify(manifest))
}

if (require.main === module) {
  main().catch(error => {
    console.error(error.stack || error.message)
    process.exitCode = 1
  })
}

module.exports = { classifyMatchupPage, parseMatchups }
