"use client";

import { Trash2 } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { Modal } from "@/components/modal";
import { useToast } from "@/components/toaster";
import { buttonStyles } from "@/lib/panel/ui";
import { eraseContactDataAction } from "../actions";

/** Solo para el propietario (el servidor lo vuelve a exigir). Borra el contacto y todo lo asociado; no se puede deshacer. */
export function EraseContact({ id }: { id: string }) {
  const toast = useToast();
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [pending, startTransition] = useTransition();

  const erase = () =>
    startTransition(async () => {
      const r = await eraseContactDataAction(id);
      if (r.ok) {
        toast({ kind: "success", title: r.message ?? "Listo" });
        setOpen(false);
        router.push("/panel/conversaciones");
      } else toast({ kind: "error", title: "No se pudo borrar", description: r.error });
    });

  return (
    <section className="space-y-2 border-t border-border pt-4">
      <h3 className="font-medium">Privacidad</h3>
      <button type="button" className={buttonStyles.danger} onClick={() => setOpen(true)}>
        <Trash2 className="size-4" />
        Borrar datos de este contacto
      </button>
      <Modal
        open={open}
        onClose={() => setOpen(false)}
        title="¿Borrar los datos de este contacto?"
        description="Se eliminan sus conversaciones, mensajes, preguntas sin respuesta y los registros de WhatsApp que contengan su teléfono. No se puede deshacer."
      >
        <div className="flex justify-end gap-2">
          <button type="button" className={buttonStyles.secondary} onClick={() => setOpen(false)}>
            Cancelar
          </button>
          <button type="button" className={buttonStyles.danger} disabled={pending} onClick={erase}>
            Borrar todo
          </button>
        </div>
      </Modal>
    </section>
  );
}
