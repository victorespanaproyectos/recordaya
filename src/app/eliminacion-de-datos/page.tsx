import type { Metadata } from "next";
import Link from "next/link";
import { LEGAL } from "@/lib/legal";
import styles from "../legal.module.css";

export const metadata: Metadata = {
  title: `Eliminación de datos · ${LEGAL.appName}`,
  description: `Cómo pedir que ${LEGAL.appName} elimine tus datos.`,
};

export default function EliminacionDeDatosPage() {
  const subject = encodeURIComponent(`Eliminar mis datos de ${LEGAL.appName}`);
  const mail = `mailto:${LEGAL.contactEmail}?subject=${subject}`;

  return (
    <main className={styles.page}>
      <h1>Instrucciones para eliminar tus datos</h1>
      <p className={styles.meta}>Última actualización: {LEGAL.lastUpdated}</p>

      <p>
        {LEGAL.appName} es un proyecto de demostración. Si recibiste mensajes de WhatsApp de la demo
        y quieres que borremos tus datos (nombre, teléfono, turnos, mensajes y respuestas):
      </p>

      <ol style={{ paddingLeft: 22 }}>
        <li>
          Escribe a <a href={mail}>{LEGAL.contactEmail}</a> con el asunto &quot;Eliminar mis datos
          de {LEGAL.appName}&quot;.
        </li>
        <li>Indica el número de teléfono de WhatsApp en el que recibiste los mensajes.</li>
        <li>
          Eliminamos todos los datos asociados a ese número en un plazo máximo de 30 días y te
          confirmamos por correo cuando esté hecho.
        </li>
      </ol>

      <h2>Qué se elimina</h2>
      <p>
        Tu ficha de cliente, tus turnos, los mensajes que te enviamos con sus estados de entrega y
        las respuestas que enviaste. Los mensajes que ya están en tu teléfono los puedes borrar
        desde WhatsApp.
      </p>

      <p style={{ marginTop: 24 }}>
        Consulta también la <Link href="/privacidad">política de privacidad</Link>.
      </p>
    </main>
  );
}
