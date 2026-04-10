import { pathToFileURL } from "node:url";
import { copyBundledPluginMetadata } from "./copy-bundled-plugin-metadata.mjs";
import { copyPluginSdkRootAlias } from "./copy-plugin-sdk-root-alias.mjs";
import { ensureMatrixCryptoDarwinArtifacts } from "./ensure-matrix-sdk-crypto-darwin.mjs";

export async function runRuntimePostBuild(params = {}) {
  copyPluginSdkRootAlias(params);
  copyBundledPluginMetadata(params);
  await ensureMatrixCryptoDarwinArtifacts();
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  await runRuntimePostBuild();
}
