import { sessionEnded } from "../api";
import { toUserError } from "./parseErrors";

export { toUserError };

// Run a Parse SDK call; on failure send an ended session to login (same as api.ts)
// and throw an Error with a readable message instead of a raw Parse error.
export async function run<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    const { message, sessionEnded: ended } = toUserError(err);
    if (ended) sessionEnded();
    throw new Error(message);
  }
}
