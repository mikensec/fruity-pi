import { EventEmitter } from "node:events";

/**
 * Process-wide message bus. Everything emitted as "msg" is fanned out to
 * authenticated dashboard WebSocket clients.
 */
export const bus = new EventEmitter();
bus.setMaxListeners(0);

export type BusMessage =
  | { topic: "instance"; instance: unknown }
  | { topic: "instance-removed"; id: string }
  | { topic: "event"; id: string; event: unknown }
  | { topic: "stderr"; id: string; line: string }
  | { topic: "job"; job: unknown }
  | { topic: "job-log"; id: string; line: string }
  | { topic: "repo"; repo: unknown }
  | { topic: "state" }
  | { topic: "audit"; entry: unknown };

export function publish(msg: BusMessage) {
  bus.emit("msg", msg);
}
