import type { OpenClawConfig } from "../../config/config.js";

type TypingLease = { refresh: () => Promise<void>; stop: () => void };

export type TelegramWorkingPresenceStart = {
  ownerId: string;
  to: string;
  accountId?: string;
  cfg?: OpenClawConfig;
  messageThreadId?: number;
};

/** Coalesces unfinished workers in one Telegram conversation onto one lease. */
export function createTelegramWorkingPresenceManager(params: {
  startTyping: (params: Omit<TelegramWorkingPresenceStart, "ownerId">) => Promise<TypingLease>;
}) {
  type Route = { lease: TypingLease; owners: Set<string> };
  const owners = new Map<string, string>();
  // Publish provider creation before awaiting it so concurrent starts share one
  // lease and terminal cleanup can attach while the first pulse is in flight.
  const routes = new Map<string, Promise<Route>>();
  let generation = 0;

  const routeKey = (input: Omit<TelegramWorkingPresenceStart, "ownerId">) =>
    [input.accountId ?? "default", input.to, input.messageThreadId ?? "root"].join(":");

  const releaseRouteIfEmpty = (key: string, promise: Promise<Route>, route: Route) => {
    if (route.owners.size === 0 && routes.get(key) === promise) {
      route.lease.stop();
      routes.delete(key);
    }
  };

  const stop = (ownerId: string) => {
    const key = owners.get(ownerId);
    if (!key) {
      return;
    }
    owners.delete(ownerId);
    const promise = routes.get(key);
    if (!promise) {
      return;
    }
    void promise.then(
      (route) => {
        route.owners.delete(ownerId);
        releaseRouteIfEmpty(key, promise, route);
      },
      () => undefined,
    );
  };

  return {
    start: async (input: TelegramWorkingPresenceStart) => {
      const ownerId = input.ownerId.trim();
      if (!ownerId) {
        throw new Error("Telegram working-presence ownerId is required");
      }
      const { ownerId: _ownerId, ...routeInput } = input;
      const key = routeKey(routeInput);
      const existingOwnerRoute = owners.get(ownerId);
      if (existingOwnerRoute === key) {
        await (await routes.get(key))?.lease.refresh();
        return;
      }
      stop(ownerId);
      owners.set(ownerId, key);
      const startGeneration = generation;
      let promise = routes.get(key);
      const created = !promise;
      if (!promise) {
        promise = params.startTyping(routeInput).then((lease) => ({ lease, owners: new Set() }));
        routes.set(key, promise);
      }
      let route: Route;
      try {
        route = await promise;
      } catch (error) {
        if (routes.get(key) === promise) {
          routes.delete(key);
        }
        if (owners.get(ownerId) === key) {
          owners.delete(ownerId);
        }
        throw error;
      }
      // A terminal event or gateway stop may win while the first provider pulse
      // is pending. Never resurrect presence after that boundary.
      if (generation !== startGeneration || owners.get(ownerId) !== key) {
        releaseRouteIfEmpty(key, promise, route);
        return;
      }
      if (!created) {
        await route.lease.refresh();
      }
      // A shared-lease refresh is still an async provider boundary. The worker
      // may finish while that pulse is in flight, so repeat the ownership check
      // before publishing it into the route's ref-counted owner set.
      if (generation !== startGeneration || owners.get(ownerId) !== key) {
        releaseRouteIfEmpty(key, promise, route);
        return;
      }
      route.owners.add(ownerId);
    },
    refresh: async (ownerId: string) => {
      const key = owners.get(ownerId);
      if (key) {
        await (await routes.get(key))?.lease.refresh();
      }
    },
    stop,
    stopAll: () => {
      generation += 1;
      for (const promise of routes.values()) {
        // Provider startup can fail while shutdown is concurrently clearing
        // ownership. Consume that already-reported rejection here so cleanup
        // never creates a second unhandled child promise.
        void promise.then(
          (route) => route.lease.stop(),
          () => undefined,
        );
      }
      routes.clear();
      owners.clear();
    },
  };
}
