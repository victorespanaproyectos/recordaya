/** Trabajos registrados con after() durante una prueba. */
export const pendingAfter: Promise<unknown>[] = [];

/** Espera a que terminen los trabajos de after() (el webhook procesa ahí). */
export async function flushAfter(): Promise<void> {
  while (pendingAfter.length > 0) {
    await Promise.all(pendingAfter.splice(0));
  }
}
