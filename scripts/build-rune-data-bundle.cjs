const fs = require('node:fs/promises')
const path = require('node:path')
const crypto = require('node:crypto')
const zlib = require('node:zlib')
const { LANES, STAT_MOD_IDS, makeStyleAndPerkIndex, revisionOf, validatePage } = require('../electron/rune-data-format.cjs')

const ROOT = path.resolve(__dirname, '..')
const OUTPUT = path.join(ROOT, 'data')
const STAGING = process.env.TAYRON_DATA_STAGING_DIR
  ? path.join(path.resolve(process.env.TAYRON_DATA_STAGING_DIR), 'runes')
  : path.join(process.env.LOCALAPPDATA || path.join(ROOT, '.cache'), 'Tayron', 'rune-data-staging')
const SOURCE = 'https://a1.lolalytics.com/mega/'
const QUEUE = '420'
const REGION = 'all'
const TIER = 'all'
const MIN_GAMES = 100
const CONCURRENCY = 6
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

async function fetchJson(url, attempts = 5) {
  let lastError
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      const response = await fetch(url, {
        headers: { Accept: 'application/json', 'User-Agent': 'Tayron-Rune-Data/1.0' },
        signal: AbortSignal.timeout(20000),
      })
      if (response.status === 429 || response.status >= 500) {
        lastError = new Error(`HTTP ${response.status}`)
        await response.body?.cancel().catch(() => undefined)
        await sleep(Math.min(30000, 1000 * (attempt + 1) ** 2))
        continue
      }
      if (!response.ok) throw new Error(`HTTP ${response.status}`)
      return await response.json()
    } catch (error) {
      lastError = error
      if (attempt < attempts - 1) await sleep(Math.min(30000, 1000 * (attempt + 1) ** 2))
    }
  }
  throw lastError || new Error('JSON request failed')
}

async function writeJsonAtomic(file, value) {
  await fs.mkdir(path.dirname(file), { recursive: true })
  const temporary = `${file}.${process.pid}.tmp`
  await fs.writeFile(temporary, JSON.stringify(value))
  await fs.rename(temporary, file)
}

function normalizeResponse(data, expected, context) {
  if (!data || data.response?.valid !== true || data.header?.lane !== expected.laneSlug) {
    return { ...expected, status: 'unavailable', games: 0, sourceUrl: expected.sourceUrl, fetchedAt: new Date().toISOString(), reason: 'Kaynak bu koridor için geçerli veri döndürmedi.' }
  }
  // Cache the provider's most-picked full page. The separate "win" branch
  // can recommend a different page selected by win rate.
  const mostPicked = data.summary?.runes?.pick
  const games = Number(mostPicked?.n)
  const winRatePercent = Number(mostPicked?.wr)
  const page = validatePage(mostPicked?.set, context.styleIndex, context.perkIndex)
  if (!Number.isSafeInteger(games) || games < 0 || !Number.isFinite(winRatePercent) || winRatePercent < 0 || winRatePercent > 100 || !page) {
    return { ...expected, status: 'unavailable', games: 0, sourceUrl: expected.sourceUrl, fetchedAt: new Date().toISOString(), reason: 'Kaynak verisi rün sayfası doğrulamasından geçmedi.' }
  }
  if (games < MIN_GAMES) {
    return { ...expected, status: 'insufficient', games, sourceUrl: expected.sourceUrl, fetchedAt: new Date().toISOString(), reason: `Güvenilir rün sayfası için en az ${MIN_GAMES} maç gerekir.` }
  }
  return {
    ...expected,
    status: 'ready',
    games,
    winRate: winRatePercent / 100,
    page,
    sourceUrl: expected.sourceUrl,
    fetchedAt: new Date().toISOString(),
    reason: null,
  }
}

function sourceUrlFor(champion, patch, laneSlug) {
  const url = new URL(SOURCE)
  url.search = new URLSearchParams({
    ep: 'rune', p: 'd', v: '1', patch, c: champion.slug,
    lane: laneSlug, tier: TIER, queue: QUEUE, region: REGION,
  }).toString()
  return url.toString()
}

async function loadCell(champion, lane, patch, context) {
  const [laneName, laneSlug] = lane
  const expected = { championId: champion.key, lane: laneName, laneSlug, sourceUrl: sourceUrlFor(champion, patch, laneSlug),
    ...(process.env.TAYRON_SCRAPE_ID ? { scrapeId: process.env.TAYRON_SCRAPE_ID } : {}) }
  const checkpoint = path.join(STAGING, patch, laneSlug, `${champion.key}.json`)
  try {
    const record = JSON.parse(await fs.readFile(checkpoint, 'utf8'))
    if (record.patch === patch && record.championId === champion.key && record.lane === laneName
      && (expected.scrapeId === undefined || record.scrapeId === expected.scrapeId)
      && ['ready', 'insufficient'].includes(record.status)) return record
    if (record.patch === patch && record.championId === champion.key && record.lane === laneName
      && (expected.scrapeId === undefined || record.scrapeId === expected.scrapeId)
      && record.status === 'unavailable' && record.reason !== 'Kaynak verisi rün sayfası doğrulamasından geçmedi.') return record
  } catch { /* Fetch missing or stale cells. */ }
  let record
  try {
    const data = await fetchJson(expected.sourceUrl)
    record = normalizeResponse(data, { ...expected, patch }, context)
  } catch (error) {
    record = { ...expected, patch, status: 'unavailable', games: 0, sourceUrl: expected.sourceUrl, fetchedAt: new Date().toISOString(), reason: error.message }
  }
  await writeJsonAtomic(checkpoint, record)
  return record
}

async function main() {
  const draftBundlePath = path.join(OUTPUT, 'draft-data-current.json.gz')
  const draftBundle = JSON.parse(zlib.gunzipSync(await fs.readFile(draftBundlePath)).toString('utf8'))
  const ddragonVersion = draftBundle.dataDragonVersion
  const patch = draftBundle.patch
  const runeTrees = await fetchJson(`https://ddragon.leagueoflegends.com/cdn/${ddragonVersion}/data/en_US/runesReforged.json`)
  const { styles, perks } = makeStyleAndPerkIndex(runeTrees)
  if (!Object.keys(styles).length || !Object.keys(perks).length) throw new Error('Current rune catalog is empty')
  const context = { styleIndex: styles, perkIndex: perks }
  const jobs = draftBundle.champions.flatMap(champion => LANES.map(lane => ({ champion, lane })))
  const records = new Map()
  let cursor = 0
  let completed = 0
  const workers = Array.from({ length: CONCURRENCY }, async () => {
    while (true) {
      const index = cursor++
      if (index >= jobs.length) return
      const { champion, lane } = jobs[index]
      const record = await loadCell(champion, lane, patch, context)
      records.set(`${champion.key}:${lane[0]}`, record)
      completed += 1
      if (completed % 25 === 0 || completed === jobs.length) {
        const counts = [...records.values()].reduce((acc, row) => { acc[row.status] += 1; return acc }, { ready: 0, insufficient: 0, unavailable: 0 })
        console.log(`Rün verisi ${completed}/${jobs.length}; hazır=${counts.ready}, düşük örnek=${counts.insufficient}, bulunamadı=${counts.unavailable}`)
      }
      await sleep(180)
    }
  })
  await Promise.all(workers)

  const builds = Object.fromEntries(draftBundle.champions.map(champion => [String(champion.key), Object.fromEntries(LANES.map(([lane]) => {
    const record = records.get(`${champion.key}:${lane}`)
    const { championId: _championId, lane: _lane, ...cell } = record
    return [lane, cell]
  }))]))
  const readyChampions = Object.keys(builds).filter(id => LANES.some(([lane]) => builds[id][lane].status === 'ready')).length
  const readyLanes = Object.values(builds).reduce((sum, byLane) => sum + LANES.filter(([lane]) => byLane[lane].status === 'ready').length, 0)
  if (readyChampions !== draftBundle.champions.length) throw new Error(`Only ${readyChampions}/${draftBundle.champions.length} champions have a verified rune build`)
  const bundle = {
    schemaVersion: 1,
    patch,
    dataDragonVersion: ddragonVersion,
    selectionBasis: 'most-picked',
    generatedAt: new Date().toISOString(),
    source: 'LoLalytics',
    sourceFilters: { region: REGION, queue: 'Ranked Solo/Duo', tier: TIER, patch },
    minimumGames: MIN_GAMES,
    champions: draftBundle.champions.map(({ key, id, name, slug }) => ({ key, id, name, slug })),
    styles,
    perks,
    statModIds: [...STAT_MOD_IDS].sort((a, b) => a - b),
    builds,
    coverage: { champions: draftBundle.champions.length, championCoverage: readyChampions, laneCells: jobs.length, readyLaneCells: readyLanes },
  }
  bundle.revision = revisionOf(bundle)
  const json = Buffer.from(JSON.stringify(bundle))
  const compressed = zlib.gzipSync(json, { level: 9 })
  await fs.mkdir(OUTPUT, { recursive: true })
  const bundlePath = path.join(OUTPUT, 'rune-data-current.json.gz')
  const manifestPath = path.join(OUTPUT, 'rune-data-current.manifest.json')
  const temporary = `${bundlePath}.${process.pid}.tmp`
  await fs.writeFile(temporary, compressed)
  await fs.rename(temporary, bundlePath)
  const manifest = {
    schemaVersion: bundle.schemaVersion,
    patch,
    dataDragonVersion: ddragonVersion,
    selectionBasis: bundle.selectionBasis,
    generatedAt: bundle.generatedAt,
    championCount: bundle.champions.length,
    lanes: LANES.map(([lane]) => lane),
    minimumGames: MIN_GAMES,
    coverage: bundle.coverage,
    revision: bundle.revision,
    uncompressedBytes: json.length,
    compressedBytes: compressed.length,
    sha256: crypto.createHash('sha256').update(compressed).digest('hex'),
  }
  await writeJsonAtomic(manifestPath, manifest)
  console.log(`Yazıldı: ${bundlePath} (${compressed.length} byte), ${readyLanes}/${jobs.length} koridor kaydı, ${readyChampions}/${draftBundle.champions.length} şampiyon.`)
  console.log(`Yama ${patch}, tüm ranklar, Dünya, Ranked Solo/Duo; revision=${bundle.revision}`)
}

if (require.main === module) main().catch(error => { console.error(error.stack || error.message); process.exitCode = 1 })

module.exports = { LANES, MIN_GAMES, STAT_MOD_IDS, makeStyleAndPerkIndex, normalizeResponse, revisionOf, validatePage }
