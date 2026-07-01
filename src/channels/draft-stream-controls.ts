import { createDraftStreamLoop } from "./draft-stream-loop.js";

export type FinalizableDraftStreamState = {
  stopped: boolean;
  final: boolean;
};

type StopAndClearMessageIdParams<T> = {
  stopForClear: (options?: { waitForInFlight?: boolean }) => Promise<void>;
  readMessageId: () => T | undefined;
  clearMessageId: () => void;
};

type ClearFinalizableDraftMessageParams<T> = StopAndClearMessageIdParams<T> & {
  isValidMessageId: (value: unknown) => value is T;
  deleteMessage: (messageId: T) => Promise<void | boolean>;
  onDeleteSuccess?: (messageId: T) => void;
  warn?: (message: string) => void;
  warnPrefix: string;
};

type FinalizableDraftLifecycleParams<T> = Omit<
  ClearFinalizableDraftMessageParams<T>,
  "stopForClear"
> & {
  throttleMs: number;
  state: FinalizableDraftStreamState;
  sendOrEditStreamMessage: (text: string) => Promise<boolean>;
};

export function createFinalizableDraftStreamControls(params: {
  throttleMs: number;
  isStopped: () => boolean;
  isFinal: () => boolean;
  markStopped: () => void;
  markFinal: () => void;
  sendOrEditStreamMessage: (text: string) => Promise<boolean>;
}) {
  const loop = createDraftStreamLoop({
    throttleMs: params.throttleMs,
    isStopped: params.isStopped,
    sendOrEditStreamMessage: params.sendOrEditStreamMessage,
  });

  const update = (text: string) => {
    if (params.isStopped() || params.isFinal()) {
      return;
    }
    loop.update(text);
  };

  const stop = async (): Promise<void> => {
    params.markFinal();
    await loop.flush();
  };

  const stopForClear = async (options?: { waitForInFlight?: boolean }): Promise<void> => {
    params.markStopped();
    loop.stop();
    if (options?.waitForInFlight !== false) {
      await loop.waitForInFlight();
    }
  };

  return {
    loop,
    update,
    stop,
    stopForClear,
  };
}

export function createFinalizableDraftStreamControlsForState(params: {
  throttleMs: number;
  state: FinalizableDraftStreamState;
  sendOrEditStreamMessage: (text: string) => Promise<boolean>;
}) {
  return createFinalizableDraftStreamControls({
    throttleMs: params.throttleMs,
    isStopped: () => params.state.stopped,
    isFinal: () => params.state.final,
    markStopped: () => {
      params.state.stopped = true;
    },
    markFinal: () => {
      params.state.final = true;
    },
    sendOrEditStreamMessage: params.sendOrEditStreamMessage,
  });
}

export async function takeMessageIdAfterStop<T>(
  params: StopAndClearMessageIdParams<T>,
  options?: { waitForInFlight?: boolean },
): Promise<T | undefined> {
  await params.stopForClear(options);
  const messageId = params.readMessageId();
  params.clearMessageId();
  return messageId;
}

export async function clearFinalizableDraftMessage<T>(
  params: ClearFinalizableDraftMessageParams<T>,
  options?: { waitForInFlight?: boolean },
): Promise<void> {
  const messageId = await takeMessageIdAfterStop(
    {
      stopForClear: params.stopForClear,
      readMessageId: params.readMessageId,
      clearMessageId: params.clearMessageId,
    },
    options,
  );
  if (!params.isValidMessageId(messageId)) {
    return;
  }
  try {
    const didDelete = await params.deleteMessage(messageId);
    if (didDelete !== false) {
      params.onDeleteSuccess?.(messageId);
    }
  } catch (err) {
    params.warn?.(`${params.warnPrefix}: ${err instanceof Error ? err.message : String(err)}`);
  }
}

export function createFinalizableDraftLifecycle<T>(params: FinalizableDraftLifecycleParams<T>) {
  const controls = createFinalizableDraftStreamControlsForState({
    throttleMs: params.throttleMs,
    state: params.state,
    sendOrEditStreamMessage: params.sendOrEditStreamMessage,
  });

  const clear = async (options?: { waitForInFlight?: boolean }) => {
    await clearFinalizableDraftMessage(
      {
        stopForClear: controls.stopForClear,
        readMessageId: params.readMessageId,
        clearMessageId: params.clearMessageId,
        isValidMessageId: params.isValidMessageId,
        deleteMessage: params.deleteMessage,
        onDeleteSuccess: params.onDeleteSuccess,
        warn: params.warn,
        warnPrefix: params.warnPrefix,
      },
      options,
    );
  };

  return {
    ...controls,
    clear,
  };
}
