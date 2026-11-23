import { beforeEach, describe, expect, it, vi } from "vitest";

const { publishJob } = vi.hoisted(() => ({ publishJob: vi.fn() }));
vi.mock("@/lib/scheduler/qstash", () => ({ publishJob }));

import { enqueueChatbotReply, enqueueIngest } from "@/lib/chatbot/jobs";

describe("jobs del chatbot", () => {
  beforeEach(() => {
    publishJob.mockReset();
    publishJob.mockResolvedValue("q-1");
  });

  it("enqueueChatbotReply: ruta, cuerpo, demora y deduplicación por wamid", async () => {
    await enqueueChatbotReply({ conversationId: "c", triggerMessageId: "t", waMessageId: "wamid.X" });
    expect(publishJob).toHaveBeenCalledWith(
      "/api/jobs/chatbot-reply",
      { conversationId: "c", triggerMessageId: "t" },
      { delaySeconds: 2.5, deduplicationId: "chat-wamid.X", retries: 3 },
    );
  });

  it("enqueueIngest: ruta y deduplicación por documento e intento", async () => {
    await enqueueIngest("doc-1", 2);
    expect(publishJob).toHaveBeenCalledWith("/api/jobs/knowledge-ingest", { documentId: "doc-1" }, { deduplicationId: "ingest-doc-1-2", retries: 3 });
  });
});
