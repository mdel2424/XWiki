// Strongly suppress the archive's large under-five-linker tail, while retaining
// a small discovery chance. Above five, favor broad HN interest with a soft cap.
export function discoveryWeight(linkers = 0) {
  const count = Math.min(100, Math.max(0, Number(linkers) || 0));
  return count < 5 ? .02 * Math.sqrt(Math.max(1, count)) : Math.pow(count / 5, .65);
}

export function randomValue(id, seed) {
  let hash = 2166136261;
  for (const char of `${seed}:${id}`) hash = Math.imul(hash ^ char.charCodeAt(0), 16777619);
  hash ^= hash >>> 16; hash = Math.imul(hash, 0x7feb352d);
  hash ^= hash >>> 15; hash = Math.imul(hash, 0x846ca68b);
  // Strictly between zero and one, including for extreme hash values.
  return (((hash ^ hash >>> 16) >>> 0) + .5) / 4294967296;
}

export function discoveryOrder(linkers, seed) {
  const keys = new Float64Array(linkers.length);
  const order = new Uint32Array(linkers.length);
  for (let index = 0; index < linkers.length; index++) {
    order[index] = index;
    // An exponential race samples proportionally to weight, without replacement.
    keys[index] = -Math.log(randomValue(index, `discovery:${seed}`)) / discoveryWeight(linkers[index]);
  }
  return order.sort((a, b) => keys[a] - keys[b] || a - b);
}
