// Vendored from packages/app/src/session/timeline/virtual-items.ts @ 00d179015f (MIT). See own/ledger/vendored.yaml
export function filterVirtualIndexes(indexes: number[], count: number) {
  return indexes.filter((index) => index >= 0 && index < count)
}
