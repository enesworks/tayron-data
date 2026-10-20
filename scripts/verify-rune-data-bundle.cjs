const fs = require('node:fs')
const path = require('node:path')
const crypto = require('node:crypto')
const zlib = require('node:zlib')
const { LANES, revisionOf, validatePage } = require('../electron/rune-data-format.cjs')
const root = path.resolve(__dirname, '..')
const draftBundle = JSON.parse(zlib.gunzipSync(fs.readFileSync(path.join(root, 'data', 'draft-data-current.json.gz'))).toString('utf8'))
const compressed = fs.readFileSync(path.join(root, 'data', 'rune-data-current.json.gz'))
const manifest = JSON.parse(fs.readFileSync(path.join(root, 'data', 'rune-data-current.manifest.json'), 'utf8'))
const digest = crypto.createHash('sha256').update(compressed).digest('hex')
const bundle = JSON.parse(zlib.gunzipSync(compressed).toString('utf8'))
const fail = message => { throw new Error(message) }

if (manifest.schemaVersion !== 1 || bundle.schemaVersion !== 1 || manifest.sha256 !== digest) fail('Rün paketi şeması veya checksum doğrulanamadı.')
if (bundle.patch !== manifest.patch || bundle.patch !== draftBundle.patch || bundle.selectionBasis !== 'most-picked' || manifest.selectionBasis !== bundle.selectionBasis || bundle.dataDragonVersion !== manifest.dataDragonVersion
  || bundle.dataDragonVersion !== draftBundle.dataDragonVersion || bundle.revision !== manifest.revision || revisionOf(bundle) !== bundle.revision) fail('Rün paketi ve şampiyon kataloğu sürümü eşleşmiyor.')
if (bundle.minimumGames !== manifest.minimumGames || bundle.minimumGames < 1 || JSON.stringify(manifest.lanes) !== JSON.stringify(LANES.map(([lane]) => lane))) fail('Rün paketi koridor veya örnek sayısı filtresi yanlış.')
if (!Array.isArray(bundle.champions) || bundle.champions.length !== draftBundle.champions.length || manifest.championCount !== bundle.champions.length) fail(`Şampiyon kataloğu eşleşmiyor: oyun verisi ${draftBundle.champions.length}, rün verisi ${bundle.champions?.length ?? 0}.`)
const ids = new Set(bundle.champions.map(champion => champion.key))
if (ids.size !== bundle.champions.length) fail('Şampiyon kimlikleri tekrarlanıyor.')
const catalogIds = new Set(draftBundle.champions.map(champion => champion.key))
if (ids.size !== catalogIds.size || [...catalogIds].some(id => !ids.has(id))) fail('Rün şampiyon kataloğu oyun kataloğuyla aynı değil.')
let ready = 0
let insufficient = 0
let unavailable = 0
let readyChampions = 0
for (const champion of bundle.champions) {
  const byLane = bundle.builds?.[String(champion.key)]
  if (!byLane) fail(`Rün kaydı yok: ${champion.name}`)
  let championHasReady = false
  for (const [lane] of LANES) {
    const cell = byLane[lane]
    if (!cell || !['ready', 'insufficient', 'unavailable'].includes(cell.status)) fail(`Koridor kaydı yok: ${champion.name}/${lane}`)
    if (cell.status === 'ready') {
      if (!Number.isSafeInteger(cell.games) || cell.games < bundle.minimumGames || !Number.isFinite(cell.winRate) || cell.winRate < 0 || cell.winRate > 1) fail(`Geçersiz örnek sayısı/oran: ${champion.name}/${lane}`)
      if (!cell.sourceUrl) fail(`Kaynak adresi yok: ${champion.name}/${lane}`)
      const source = new URL(cell.sourceUrl)
      if (source.hostname !== 'a1.lolalytics.com' || source.searchParams.get('tier') !== 'all' || source.searchParams.get('region') !== 'all'
        || source.searchParams.get('queue') !== '420' || source.searchParams.get('patch') !== bundle.patch || source.searchParams.get('lane') !== cell.laneSlug) {
        fail(`Kaynak filtreleri eşleşmiyor: ${champion.name}/${lane}`)
      }
      if (!validatePage({
        pri: cell.page.selectedPerkIds.slice(0, 4),
        sec: cell.page.selectedPerkIds.slice(4, 6),
        mod: cell.page.selectedPerkIds.slice(6),
      }, bundle.styles, bundle.perks)) fail(`Rün dizilimi geçersiz: ${champion.name}/${lane}`)
      if (cell.page.primaryStyleId !== bundle.perks[cell.page.selectedPerkIds[0]] || cell.page.subStyleId !== bundle.perks[cell.page.selectedPerkIds[4]]) fail(`Rün ağacı eşleşmiyor: ${champion.name}/${lane}`)
      ready += 1
      championHasReady = true
    } else if (cell.status === 'insufficient') {
      if (!Number.isSafeInteger(cell.games) || cell.games < 0 || cell.games >= bundle.minimumGames) fail(`Düşük örnek kaydı tutarsız: ${champion.name}/${lane}`)
      insufficient += 1
    } else {
      unavailable += 1
    }
  }
  if (championHasReady) readyChampions += 1
}
if (readyChampions !== bundle.champions.length || ready !== manifest.coverage.readyLaneCells || readyChampions !== manifest.coverage.championCoverage
  || manifest.coverage.champions !== bundle.champions.length || manifest.coverage.laneCells !== bundle.champions.length * LANES.length
  || bundle.coverage?.champions !== bundle.champions.length || bundle.coverage?.laneCells !== bundle.champions.length * LANES.length) fail('Rün veri kapsamı manifest ile uyuşmuyor.')
console.log(`Doğrulandı: yama ${bundle.patch}, ${bundle.champions.length} şampiyon, ${manifest.coverage.laneCells} şampiyon-koridor kaydı.`)
console.log(`Uygulanabilir: ${ready}; düşük örneklem: ${insufficient}; kaynak verisi yok: ${unavailable}; her şampiyonda en az bir uygulanabilir koridor mevcut.`)
console.log(`Tüm ranklar · Dünya · Ranked Solo/Duo · en az ${bundle.minimumGames} maç · sha256=${digest}`)
