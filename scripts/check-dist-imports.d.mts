export interface MissingDistImport {
  importer: string;
  specifier: string;
  missing: string;
}

export function findMissingDistImports(distDir?: string): MissingDistImport[];

export function formatMissingDistImports(missing: MissingDistImport[]): string;
