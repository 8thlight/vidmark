type Task = { status: "queued" | "running" | "complete" | "failed" };

// A generation invalidates in-flight responses on restart/navigation. Empty and
// terminal results stop the timer; starting a new task explicitly restarts it.
export function createAgentTaskPoller<T extends Task>(read: () => Promise<T | null>, onJob: (job: T | null) => void | Promise<void>, onError: (error: unknown) => void, delay = 1500) {
  let generation = 0, disposed = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const refresh = async (current: number) => {
    let again = true;
    try {
      const job = await read();
      if (disposed || current !== generation) return;
      again = job?.status === "queued" || job?.status === "running";
      await onJob(job);
    } catch (error) { if (!disposed && current === generation) onError(error); }
    if (!disposed && current === generation && again) timer = setTimeout(() => void refresh(current), delay);
  };
  return {
    restart() { if (!disposed) { clearTimeout(timer); void refresh(++generation); } },
    stop() { disposed = true; generation++; clearTimeout(timer); },
  };
}
