import { describe, expect, expectTypeOf, it } from "vitest";
import type { ModelCatalogEntry as RuntimeModelCatalogEntry } from "../agents/model-catalog.js";
import { GATEWAY_EVENT_UPDATE_AVAILABLE as gatewayUpdateEvent } from "../gateway/events.js";
import type { SessionsUsageResult as GatewaySessionsUsageResult } from "../gateway/server-methods/usage.js";
import type { UpdateAvailable as RuntimeUpdateAvailable } from "../infra/update-startup.js";
import type { ModelCatalogEntry } from "./model-catalog-contract.js";
import { GATEWAY_EVENT_UPDATE_AVAILABLE as contractUpdateEvent } from "./update-contract.js";
import type { UpdateAvailable } from "./update-contract.js";
import type { SessionsUsageResult } from "./usage-types.js";

describe("shared UI contracts", () => {
  it("keeps the update event wire value stable", () => {
    expect(contractUpdateEvent).toBe("update.available");
    expect(gatewayUpdateEvent).toBe(contractUpdateEvent);
  });

  it("keeps compatibility export paths mutually assignable", () => {
    expectTypeOf<UpdateAvailable>().toEqualTypeOf<RuntimeUpdateAvailable>();
    expectTypeOf<ModelCatalogEntry>().toEqualTypeOf<RuntimeModelCatalogEntry>();
    expectTypeOf<SessionsUsageResult>().toEqualTypeOf<GatewaySessionsUsageResult>();
  });
});
