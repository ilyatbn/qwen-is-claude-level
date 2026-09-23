export interface ObjectManifestEntry {
  pack?: string
}
export interface ObjectManifest {
  objects?: ObjectManifestEntry[]
}
export interface ShippingManifest {
  vendorPacks?: string[]
}
export const SPRITE_PACK_SECTION: string
export function packSources(
  manifest: ObjectManifest | null | undefined,
  shippingManifest?: ShippingManifest | null,
): Map<string, string>
export function packsInManifest(
  manifest: ObjectManifest | null | undefined,
  shippingManifest?: ShippingManifest | null,
): string[]
export function packsInReadme(text: string): Set<string>
export function readmeRows(text: string): Array<[string, string[]]>
export function incompleteProvenance(
  manifest: ObjectManifest | null | undefined,
  readmeText: string,
  shippingManifest?: ShippingManifest | null,
): string[]
export function missingProvenance(
  manifest: ObjectManifest | null | undefined,
  readmeText: string,
  shippingManifest?: ShippingManifest | null,
): string[]
