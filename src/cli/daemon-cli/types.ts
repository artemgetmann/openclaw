import type { FindExtraGatewayServicesOptions } from "../../daemon/inspect.js";
import type { GatewayLifecycleServiceEnvRefresh } from "../../infra/gateway-lifecycle-lease.js";

export type GatewayRpcOpts = {
  url?: string;
  token?: string;
  password?: string;
  timeout?: string;
  json?: boolean;
};

export type DaemonStatusOptions = {
  rpc: GatewayRpcOpts;
  probe: boolean;
  requireRpc: boolean;
  json: boolean;
} & FindExtraGatewayServicesOptions;

export type DaemonInstallOptions = {
  port?: string | number;
  runtime?: string;
  token?: string;
  force?: boolean;
  allowSharedServiceTakeover?: boolean;
  json?: boolean;
};

export type DaemonLifecycleOptions = {
  json?: boolean;
  refreshServiceEnv?: GatewayLifecycleServiceEnvRefresh;
};
