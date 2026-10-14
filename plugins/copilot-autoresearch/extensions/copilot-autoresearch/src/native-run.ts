import { Type, type Static } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";

const Spec = Type.Object({
  executable: Type.String(), argv: Type.Array(Type.String()), cwd: Type.String(),
  env: Type.Array(Type.String()), path: Type.String(), input: Type.Boolean(), cancelled: Type.Boolean(),
});

const Completion = Type.Object({
  exitCode: Type.Union([Type.Number(), Type.Null()]), killed: Type.Boolean(),
});

const Failure = Type.Object({
  name: Type.String(), message: Type.String(), stage: Type.String(), win32Code: Type.Number(),
  pid: Type.Optional(Type.Number()), cleanupStage: Type.Optional(Type.String()),
});

const Notification = Type.Union([
  Type.Object({ kind: Type.Literal("started"), pid: Type.Number() }),
  Type.Object({ kind: Type.Literal("io"), channel: Type.Literal(0) }),
  Type.Object({
    kind: Type.Literal("io"), channel: Type.Union([Type.Literal(1), Type.Literal(2)]),
    data: Type.Union([Type.Uint8Array(), Type.Null()]),
  }),
  Type.Object({ kind: Type.Literal("closed"), result: Completion }),
  Type.Object({ kind: Type.Literal("failed"), error: Failure }),
]);

const Control = Type.Object({
  read: Type.Function([Type.Number()], Type.Void()),
  write: Type.Function([Type.Uint8Array()], Type.Void()),
  endInput: Type.Function([], Type.Void()),
  stop: Type.Function([], Type.Void()), discard: Type.Function([], Type.Void()),
});

export const NativeAddon = Type.Object({
  nodeApiVersion: Type.Literal(8), protocolVersion: Type.Literal(2),
  begin: Type.Function([Spec, Type.Function([Type.Unknown()], Type.Void())], Control),
});

export function createNativeRun(api: Static<typeof NativeAddon>, spec: Static<typeof Spec>) {
  const started = Promise.withResolvers<number | null>();
  const closed = Promise.withResolvers<Static<typeof Completion>>();

  const pending: [
    PromiseWithResolvers<void> | undefined,
    PromiseWithResolvers<Uint8Array | null> | undefined,
    PromiseWithResolvers<Uint8Array | null> | undefined,
  ] = [undefined, undefined, undefined];

  let done = false;
  let error: Error | undefined;
  let pid: number | null = null;
  let control: Static<typeof Control> | undefined;

  const finish = (outcome: { result: Static<typeof Completion> } | { error: Error }) => {
    if (done) return;
    done = true;
    error = "error" in outcome ? outcome.error : undefined;

    if ("error" in outcome) {
      started.reject(outcome.error);
      closed.reject(outcome.error);

      for (const request of pending) request?.reject(outcome.error);
    } else {
      started.resolve(pid);
      closed.resolve(outcome.result);
      pending[0]?.resolve();
      pending[1]?.resolve(null);
      pending[2]?.resolve(null);
    }

    pending.fill(undefined);
  };

  const notify: Parameters<Static<typeof NativeAddon>["begin"]>[1] = (event) => {
    if (!Value.Check(Notification, event)) {
      finish({ error: Object.assign(new Error("Native protocol mismatch; ownership cleanup is unconfirmed. Restart the host."), { pid }) });
      control?.discard();

      return;
    }

    if (done) return;

    if (event.kind === "started") {
      pid = event.pid;
      started.resolve(pid);
    } else if (event.kind === "failed") finish({ error: event.error });
    else if (event.kind === "closed") finish({ result: event.result });
    else if (event.channel === 0) {
      pending[0]?.resolve();
      pending[0] = undefined;
    } else {
      pending[event.channel]?.resolve(event.data);
      pending[event.channel] = undefined;
    }
  };

  control = api.begin(spec, notify);
  const resource = control;

  if (error) resource.discard();

  const input = (operation: () => void) => {
    if (pending[0]) throw Object.assign(new Error("Outstanding input credit"), { stage: "OutstandingIoCredit" });

    if (done) return error ? Promise.reject(error) : Promise.resolve();
    const request = Promise.withResolvers<void>();
    pending[0] = request;

    try { operation(); }
    catch (failure) { pending[0] = undefined; throw failure; }

    return request.promise;
  };

  return {
    started: started.promise, closed: closed.promise,
    read(channel: number) {
      if (channel !== 1 && channel !== 2) throw new RangeError("Output channel must be 1 or 2");

      if (pending[channel]) throw Object.assign(new Error("Outstanding output credit"), { stage: "OutstandingIoCredit" });

      if (done) return error ? Promise.reject<Uint8Array | null>(error) : Promise.resolve(null);
      const request = Promise.withResolvers<Uint8Array | null>();
      pending[channel] = request;

      try { resource.read(channel); }
      catch (failure) { pending[channel] = undefined; throw failure; }

      return request.promise;
    },
    write(bytes: Uint8Array) { return input(() => resource.write(bytes)); },
    endInput() { return input(() => resource.endInput()); },
    stop() { resource.stop(); }, discard() { resource.discard(); },
  };
}
