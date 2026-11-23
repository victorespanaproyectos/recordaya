/**
 * QStash simulado: registra lo que se programa y se cancela, sin tocar la red.
 * La firma "válida" de los jobs es la cabecera `upstash-signature: valid-signature`.
 */
export const VALID_QSTASH_SIGNATURE = "valid-signature";

export const qstashFake = {
  scheduled: [] as { scheduleId: string; messageId: string; at: Date }[],
  cancelled: [] as string[],
  jobs: [] as { path: string; body: unknown; options: unknown }[],
  /** Si se define, publishJob falla con este error (para probar el manejo de fallos). */
  publishError: null as Error | null,
  counter: 0,
  reset() {
    this.scheduled = [];
    this.cancelled = [];
    this.jobs = [];
    this.publishError = null;
    this.counter = 0;
  },
  async scheduleReminder(messageId: string, at: Date): Promise<string> {
    const scheduleId = `fake-schedule-${++qstashFake.counter}`;
    qstashFake.scheduled.push({ scheduleId, messageId, at });
    return scheduleId;
  },
  async publishJob(path: string, body: unknown, options: unknown = {}): Promise<string> {
    if (qstashFake.publishError) throw qstashFake.publishError;
    qstashFake.jobs.push({ path, body, options });
    return `fake-job-${++qstashFake.counter}`;
  },
  async cancelScheduled(scheduleId: string): Promise<void> {
    qstashFake.cancelled.push(scheduleId);
  },
  async verifyQStashSignature(request: Request): Promise<boolean> {
    return request.headers.get("upstash-signature") === VALID_QSTASH_SIGNATURE;
  },
};
