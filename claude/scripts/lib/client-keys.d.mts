export declare const SKINS_TS: string
export declare function parseKeys(source: string): Map<string, string>
/** Throws if `skins.ts` exports no such `*_KEY`. */
export declare function key(name: string): string
