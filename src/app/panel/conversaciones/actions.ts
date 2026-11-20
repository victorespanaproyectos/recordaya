"use server";

import { refresh } from "next/cache";
import { ServiceError } from "@/lib/appointments/service";
import { requireMember } from "@/lib/auth/session";
import {
  claimConversation, closeConversation, declineHandoffByMember, handoffConversation, markRead, reassignConversation, releaseConversation,
  resolveConversation, returnToBot, sendAgentMessage, sendReopenTemplate,
} from "@/lib/chatbot/conversations/operator";
import type { ActionResult } from "../actions";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Cada acción exige sesión de miembro, valida los ids y delega en el servicio, que vuelve a comprobar rol, negocio y
 * versión. `business_id` nunca viene del cliente.
 */
async function run(scope: string, min: "operator" | "admin", id: string, fn: (member: Awaited<ReturnType<typeof requireMember>>) => Promise<string>): Promise<ActionResult> {
  const member = await requireMember(min);
  if (!UUID.test(id)) return { ok: false, error: "Conversación inválida" };
  try {
    const message = await fn(member);
    refresh();
    return { ok: true, id, message };
  } catch (error) {
    if (error instanceof ServiceError) return { ok: false, error: error.message };
    console.error(`[panel/conversaciones/${scope}]`, error instanceof Error ? error.message : "error");
    return { ok: false, error: "Algo salió mal. Intenta de nuevo en unos segundos." };
  }
}

export async function claimConversationAction(id: string, version?: number): Promise<ActionResult> {
  return run("claim", "operator", id, async (m) => (await claimConversation(m, id, version), "Conversación tomada"));
}

export async function releaseConversationAction(id: string, version?: number): Promise<ActionResult> {
  return run("release", "operator", id, async (m) => (await releaseConversation(m, id, version), "Conversación liberada: vuelve a la cola"));
}

export async function returnToBotAction(id: string, notify: boolean, version?: number): Promise<ActionResult> {
  return run("return", "operator", id, async (m) => (await returnToBot(m, id, { notify, expectedVersion: version }), "Devuelta al asistente"));
}

export async function resolveConversationAction(id: string, notify: boolean, version?: number): Promise<ActionResult> {
  return run("resolve", "operator", id, async (m) => (await resolveConversation(m, id, { notify, expectedVersion: version }), "Conversación resuelta"));
}

export async function closeConversationAction(id: string, version?: number): Promise<ActionResult> {
  return run("close", "operator", id, async (m) => (await closeConversation(m, id, version), "Conversación cerrada"));
}

export async function handoffConversationAction(id: string, version?: number): Promise<ActionResult> {
  return run("handoff", "operator", id, async (m) => (await handoffConversation(m, id, version), "Enviada a la cola de atención humana"));
}

export async function declineHandoffAction(id: string, version?: number): Promise<ActionResult> {
  return run("decline", "operator", id, async (m) => (await declineHandoffByMember(m, id, version), "Devuelta al asistente"));
}

export async function reassignConversationAction(id: string, memberId: string, version?: number): Promise<ActionResult> {
  return run("reassign", "admin", id, async (m) => {
    if (!UUID.test(memberId)) throw new ServiceError("Miembro inválido");
    await reassignConversation(m, id, memberId, version);
    return "Conversación reasignada";
  });
}

export async function markReadAction(id: string): Promise<ActionResult> {
  return run("read", "operator", id, async (m) => (await markRead(m, id), "Marcada como leída"));
}

export async function sendAgentMessageAction(id: string, body: string, clientRequestId: string): Promise<ActionResult> {
  return run("send", "operator", id, async (m) => (await sendAgentMessage(m, id, String(body ?? ""), String(clientRequestId ?? "")), "Mensaje enviado"));
}

export async function sendReopenTemplateAction(id: string, clientRequestId: string): Promise<ActionResult> {
  return run("template", "operator", id, async (m) => (await sendReopenTemplate(m, id, String(clientRequestId ?? "")), "Plantilla enviada"));
}
