/** Input modalities advertised by a model-catalog entry. */
export type ModelInputType = "text" | "image" | "document";

/** Stable model DTO returned by the gateway model-catalog endpoint. */
export type ModelCatalogEntry = {
  id: string;
  name: string;
  provider: string;
  contextWindow?: number;
  reasoning?: boolean;
  input?: ModelInputType[];
};
