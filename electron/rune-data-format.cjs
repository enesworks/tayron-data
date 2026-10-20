const crypto = require('node:crypto')

const STAT_MOD_IDS = new Set([5001, 5002, 5003, 5005, 5007, 5008, 5010, 5011, 5013, 5016, 5017, 5018, 5019])
const LANES = [
  ['Top', 'top'], ['Jungle', 'jungle'], ['Mid', 'middle'], ['Bot', 'bottom'], ['Support', 'support'],
]

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical)
  if (!value || typeof value !== 'object') return value
  return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])]))
}

function semanticBundle(bundle) {
  return {
    schemaVersion: bundle.schemaVersion,
    patch: bundle.patch,
    dataDragonVersion: bundle.dataDragonVersion,
    selectionBasis: bundle.selectionBasis,
    minimumGames: bundle.minimumGames,
    champions: bundle.champions,
    styles: bundle.styles,
    perks: bundle.perks,
    statModIds: bundle.statModIds,
    builds: Object.fromEntries(Object.keys(bundle.builds || {}).sort((a, b) => Number(a) - Number(b)).map(championId => [championId,
      Object.fromEntries(Object.keys(bundle.builds[championId] || {}).sort().map(lane => {
        const cell = bundle.builds[championId][lane]
        return [lane, { status: cell?.status, page: cell?.page }]
      }))])),
  }
}

function revisionOf(bundle) {
  return crypto.createHash('sha256').update(JSON.stringify(canonical(semanticBundle(bundle)))).digest('hex')
}

function makeStyleAndPerkIndex(runeTrees) {
  const styles = {}
  const perks = {}
  for (const tree of runeTrees) {
    if (!Number.isSafeInteger(tree.id) || !Array.isArray(tree.slots) || !tree.slots.length) continue
    styles[tree.id] = { name: tree.name, slots: tree.slots.map(slot => (slot.runes || []).map(rune => rune.id)) }
    for (const slot of tree.slots) for (const rune of slot.runes || []) perks[rune.id] = tree.id
  }
  return { styles, perks }
}

function validatePage(set, styleIndex, perkIndex) {
  if (!set || !Array.isArray(set.pri) || set.pri.length !== 4 || !Array.isArray(set.sec) || set.sec.length !== 2
    || !Array.isArray(set.mod) || set.mod.length !== 3) return null
  const selectedPerkIds = [...set.pri, ...set.sec, ...set.mod].map(Number)
  if (selectedPerkIds.some(id => !Number.isSafeInteger(id) || id < 1) || new Set(selectedPerkIds.slice(0, 6)).size !== 6) return null
  const primaryStyleId = perkIndex[selectedPerkIds[0]]
  const subStyleId = perkIndex[selectedPerkIds[4]]
  if (!primaryStyleId || !subStyleId || primaryStyleId === subStyleId || !styleIndex[primaryStyleId] || !styleIndex[subStyleId]) return null
  const primarySlots = styleIndex[primaryStyleId].slots
  const secondarySlots = styleIndex[subStyleId].slots
  if (set.pri.some((id, index) => perkIndex[Number(id)] !== primaryStyleId || !primarySlots[index]?.includes(Number(id)))) return null
  if (set.sec.some(id => perkIndex[Number(id)] !== subStyleId)) return null
  const secondaryRows = set.sec.map(id => secondarySlots.findIndex(slot => slot.includes(Number(id))))
  if (secondaryRows.some(index => index < 1 || index > 3) || secondaryRows[0] === secondaryRows[1]) return null
  if (set.mod.some(id => !STAT_MOD_IDS.has(Number(id)))) return null
  return { primaryStyleId, subStyleId, selectedPerkIds }
}

module.exports = { LANES, STAT_MOD_IDS, makeStyleAndPerkIndex, revisionOf, semanticBundle, validatePage }
