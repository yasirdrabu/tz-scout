export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs" && process.env.JOBS_DISABLED !== "true") {
    const { startWorker } = await import("./jobs/worker");
    await startWorker().catch((e) => console.error("[jobs] failed to start:", e));
  }
}
