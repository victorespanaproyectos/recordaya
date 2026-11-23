/**
 * ¿Sigue aceptándose la contraseña compartida (PANEL_LEGACY_LOGIN)? D-02.
 * Sin definir cuenta como activo: es el comportamiento actual, y así un deploy no deja el panel sin acceso.
 * Se apaga poniendo PANEL_LEGACY_LOGIN=false al terminar la Fase 10.
 * Módulo sin dependencias: lo usan el proxy y el servidor.
 */
export function isLegacyLoginEnabled(): boolean {
  return process.env.PANEL_LEGACY_LOGIN !== "false";
}
