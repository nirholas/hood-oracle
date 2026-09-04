/**
 * Hold the Node event loop open while a long chain read is in flight.
 *
 * src/chain/client.ts unrefs its backoff timers on purpose: inside the
 * engine the sequencer feed and the watchers keep the process alive, and a
 * retry sleep must never be the thing that does. A bare script has no such
 * handles, so the first rate-limit backoff would drain the loop and Node
 * would exit with code 0 in the middle of an await, printing nothing. Every
 * oracle script and every scheduled job run holds one of these until it
 * finishes.
 */
export function holdEventLoop(): () => void {
  const handle = setInterval(() => {}, 60_000)
  return () => clearInterval(handle)
}
