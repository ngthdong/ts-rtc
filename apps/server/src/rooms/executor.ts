// Run task on at a time, in submission order.
// Every change to a room goes through its executor,
// so joinso join/leave/disconnect never interleave.
// A failing task does not stall the queue.
export class SerialExecutor {
  private tail: Promise<unknown> = Promise.resolve();

  run<T>(task: () => T | Promise<T>): Promise<T> {
    const result = this.tail.then(task);
    this.tail = result.catch(() => undefined);
    return result;
  }
}
