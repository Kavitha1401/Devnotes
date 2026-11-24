export type TextAnchor = { text: string; prefix: string; suffix: string }

function editDistanceWithin(left: string, right: string, limit: number): number {
  if (Math.abs(left.length - right.length) > limit) return limit + 1
  let previous = Array.from({ length: right.length + 1 }, (_, index) => index)
  for (let row = 1; row <= left.length; row++) {
    const current = [row]
    let min = row
    for (let col = 1; col <= right.length; col++) {
      const value = Math.min(current[col - 1] + 1, previous[col] + 1, previous[col - 1] + (left[row - 1] === right[col - 1] ? 0 : 1))
      current[col] = value
      min = Math.min(min, value)
    }
    if (min > limit) return limit + 1
    previous = current
  }
  return previous[right.length]
}

export function findBestAnchor(pageText: string, item: TextAnchor): number {
  const scoreContext = (index: number) => {
    const before = pageText.slice(Math.max(0, index - item.prefix.length), index)
    const after = pageText.slice(index + item.text.length, index + item.text.length + item.suffix.length)
    let prefixScore = 0
    while (prefixScore < before.length && prefixScore < item.prefix.length && before[before.length - 1 - prefixScore] === item.prefix[item.prefix.length - 1 - prefixScore]) prefixScore++
    let suffixScore = 0
    while (suffixScore < after.length && suffixScore < item.suffix.length && after[suffixScore] === item.suffix[suffixScore]) suffixScore++
    return prefixScore + suffixScore
  }
  let best = -1
  let bestScore = -1
  let index = pageText.indexOf(item.text)
  while (index >= 0) {
    const score = scoreContext(index)
    if (score > bestScore) { best = index; bestScore = score }
    index = pageText.indexOf(item.text, index + 1)
  }
  if (best >= 0 || item.text.length > 1000) return best
  const tolerance = Math.max(2, Math.floor(item.text.length * 0.08))
  const sampleSize = Math.min(18, item.text.length)
  const candidates = new Set<number>()
  for (const sampleStart of [0, Math.floor((item.text.length - sampleSize) / 2), item.text.length - sampleSize]) {
    const sample = item.text.slice(sampleStart, sampleStart + sampleSize)
    let found = pageText.indexOf(sample)
    let count = 0
    while (found >= 0 && count++ < 40) {
      const candidate = found - sampleStart
      if (candidate >= 0 && candidate + item.text.length <= pageText.length) candidates.add(candidate)
      found = pageText.indexOf(sample, found + 1)
    }
  }
  let bestDistance = tolerance + 1
  for (const candidate of candidates) {
    const distance = editDistanceWithin(item.text, pageText.slice(candidate, candidate + item.text.length), tolerance)
    if (distance > tolerance) continue
    const score = scoreContext(candidate) - distance * 2
    if (score > bestScore || (score === bestScore && distance < bestDistance)) {
      best = candidate
      bestScore = score
      bestDistance = distance
    }
  }
  return best
}
