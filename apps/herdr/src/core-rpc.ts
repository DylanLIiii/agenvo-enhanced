import { connect, type Socket } from "node:net";
import { bytes, Fault } from "@agenvo/protocol";

// Match Core's framed-message ceiling, including subscription snapshots.
const MAX_MESSAGE = 16 * 1024 * 1024;

// One plain JSON-RPC connection per call; never start the native core.
export function request(
  endpoint: string,
  method: string,
  params: unknown,
  readOnly: boolean,
): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const socket = connect(endpoint);
    let sent = false;
    let settled = false;
    let buffer = "";
    const finish = (error?: Fault, result?: unknown) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      if (error) reject(error);
      else resolve(result);
    };
    socket.setEncoding("utf8");
    socket.setTimeout(8500, () => socket.destroy());
    socket.on("connect", () => {
      sent = true;
      socket.write(
        JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) + "\n",
      );
    });
    socket.on("data", (chunk) => {
      buffer += chunk;
      if (bytes(buffer) > MAX_MESSAGE)
        return finish(
          new Fault(
            "result_too_large",
            "Herdr Core response exceeds the connector limit; use narrower reads (offset/limit, lines).",
            readOnly ? "rejected" : "unknown",
          ),
        );
      const end = buffer.indexOf("\n");
      if (end < 0) return;
      try {
        const packet = JSON.parse(buffer.slice(0, end));
        if (packet.id !== 1 || packet.jsonrpc !== "2.0")
          throw Error("invalid response");
        if (packet.error) {
          // Core uses unavailable for both pre-dispatch failures and lost remote
          // replies; internal failures and spawn timeouts may also follow a write.
          const uncertain =
            !readOnly &&
            ["unavailable", "internal", "spawn_failed"].includes(
              packet.error.data?.kind,
            );
          return finish(
            new Fault(
              uncertain ? "execution_unknown" : "native_error",
              packet.error.message,
              uncertain ? "unknown" : "rejected",
              packet.error,
            ),
          );
        }
        if (!Object.hasOwn(packet, "result")) throw Error("missing result");
        finish(undefined, packet.result);
      } catch {
        finish(
          new Fault(
            "execution_unknown",
            "Invalid Herdr Core response; inspect native state before retrying.",
            "unknown",
          ),
        );
      }
    });
    socket.on("error", () => {});
    socket.on("close", () =>
      finish(
        sent
          ? new Fault(
              "execution_unknown",
              "Herdr Core did not confirm the request; inspect native state before retrying.",
              "unknown",
            )
          : new Fault("runtime_unavailable", "Cannot connect to Herdr Core."),
      ),
    );
  });
}

export function subscribe(
  endpoint: string,
  receive: (packet: any) => void,
  closed: () => void,
): Socket {
  const socket = connect(endpoint);
  let buffer = "";
  socket.setEncoding("utf8");
  socket.setTimeout(8000, () => socket.destroy());
  socket.on("connect", () =>
    socket.write(
      JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "events.subscribe",
        params: {},
      }) + "\n",
    ),
  );
  socket.on("data", (chunk) => {
    buffer += chunk;
    let end: number;
    while ((end = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, end);
      buffer = buffer.slice(end + 1);
      if (bytes(line) > MAX_MESSAGE) return socket.destroy();
      try {
        const packet = JSON.parse(line);
        if (packet.jsonrpc !== "2.0" || packet.error)
          throw Error("invalid subscription");
        if (packet.id === 1 && packet.result) socket.setTimeout(0);
        receive(packet);
      } catch {
        socket.destroy();
        return;
      }
    }
    if (bytes(buffer) > MAX_MESSAGE) socket.destroy();
  });
  socket.on("error", () => {});
  socket.on("close", closed);
  return socket;
}
