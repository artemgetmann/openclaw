import { DEFAULT_PROVIDER } from "../../agents/defaults.js";
import { buildAllowedModelSet } from "../../agents/model-selection.js";
import { applyConsumerAuth, listConsumerAuthOptions } from "../../commands/models/consumer-auth.js";
import {
  applyConsumerModel,
  listConsumerModelOptions,
} from "../../commands/models/consumer-models.js";
import { resolveModelsReadiness } from "../../commands/models/readiness.js";
import { setDefaultModel } from "../../commands/models/set.js";
import { loadConfig } from "../../config/config.js";
import { resolveAgentModelPrimaryValue } from "../../config/model-input.js";
import {
  ErrorCodes,
  errorShape,
  formatValidationErrors,
  validateModelsAuthApplyParams,
  validateModelsAuthListParams,
  validateModelsListParams,
  validateModelsReadinessParams,
  validateModelsSetParams,
} from "../protocol/index.js";
import type { GatewayRequestHandlers } from "./types.js";

export const modelsHandlers: GatewayRequestHandlers = {
  "models.auth.list": async ({ params, respond }) => {
    if (!validateModelsAuthListParams(params)) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          `invalid models.auth.list params: ${formatValidationErrors(validateModelsAuthListParams.errors)}`,
        ),
      );
      return;
    }
    try {
      respond(true, { options: await listConsumerAuthOptions() }, undefined);
    } catch (err) {
      respond(false, undefined, errorShape(ErrorCodes.UNAVAILABLE, String(err)));
    }
  },
  "models.auth.apply": async ({ params, respond }) => {
    if (!validateModelsAuthApplyParams(params)) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          `invalid models.auth.apply params: ${formatValidationErrors(validateModelsAuthApplyParams.errors)}`,
        ),
      );
      return;
    }
    try {
      const rawOptionId = (params as { optionId?: unknown }).optionId;
      const optionId = typeof rawOptionId === "string" ? rawOptionId : "";
      const rawSecret = (params as { secret?: unknown }).secret;
      const secret = typeof rawSecret === "string" ? rawSecret : undefined;
      respond(
        true,
        await applyConsumerAuth({
          optionId,
          secret,
        }),
        undefined,
      );
    } catch (err) {
      respond(false, undefined, errorShape(ErrorCodes.UNAVAILABLE, String(err)));
    }
  },
  "models.consumer.list": async ({ params, respond }) => {
    if (!validateModelsAuthListParams(params)) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          `invalid models.consumer.list params: ${formatValidationErrors(validateModelsAuthListParams.errors)}`,
        ),
      );
      return;
    }
    try {
      respond(true, await listConsumerModelOptions(), undefined);
    } catch (err) {
      respond(false, undefined, errorShape(ErrorCodes.UNAVAILABLE, String(err)));
    }
  },
  "models.consumer.apply": async ({ params, respond }) => {
    if (!validateModelsSetParams(params)) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          `invalid models.consumer.apply params: ${formatValidationErrors(validateModelsSetParams.errors)}`,
        ),
      );
      return;
    }
    try {
      const rawModel = (params as { model?: unknown }).model;
      const model = typeof rawModel === "string" ? rawModel : "";
      const updated = await applyConsumerModel({ model });
      respond(
        true,
        {
          ok: true,
          model: updated.defaultModel,
        },
        undefined,
      );
    } catch (err) {
      respond(false, undefined, errorShape(ErrorCodes.UNAVAILABLE, String(err)));
    }
  },
  "models.list": async ({ params, respond, context }) => {
    if (!validateModelsListParams(params)) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          `invalid models.list params: ${formatValidationErrors(validateModelsListParams.errors)}`,
        ),
      );
      return;
    }
    try {
      const catalog = await context.loadGatewayModelCatalog();
      const cfg = loadConfig();
      const includeAll = Boolean((params as { all?: unknown }).all);
      const models = includeAll
        ? catalog
        : (() => {
            const { allowedCatalog } = buildAllowedModelSet({
              cfg,
              catalog,
              defaultProvider: DEFAULT_PROVIDER,
            });
            return allowedCatalog.length > 0 ? allowedCatalog : catalog;
          })();
      respond(true, { models }, undefined);
    } catch (err) {
      respond(false, undefined, errorShape(ErrorCodes.UNAVAILABLE, String(err)));
    }
  },
  "models.set": async ({ params, respond }) => {
    if (!validateModelsSetParams(params)) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          `invalid models.set params: ${formatValidationErrors(validateModelsSetParams.errors)}`,
        ),
      );
      return;
    }
    try {
      const rawModel = (params as { model?: unknown }).model;
      const model = typeof rawModel === "string" ? rawModel : "";
      const updated = await setDefaultModel(model);
      respond(
        true,
        {
          ok: true,
          model: resolveAgentModelPrimaryValue(updated.agents?.defaults?.model) ?? model,
        },
        undefined,
      );
    } catch (err) {
      respond(false, undefined, errorShape(ErrorCodes.UNAVAILABLE, String(err)));
    }
  },
  "models.readiness": async ({ params, respond }) => {
    if (!validateModelsReadinessParams(params)) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          `invalid models.readiness params: ${formatValidationErrors(validateModelsReadinessParams.errors)}`,
        ),
      );
      return;
    }
    try {
      respond(true, await resolveModelsReadiness(), undefined);
    } catch (err) {
      respond(false, undefined, errorShape(ErrorCodes.UNAVAILABLE, String(err)));
    }
  },
};
