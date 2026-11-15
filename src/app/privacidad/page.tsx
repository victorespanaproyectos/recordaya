import type { Metadata } from "next";
import Link from "next/link";
import { LEGAL } from "@/lib/legal";
import styles from "../legal.module.css";

export const metadata: Metadata = {
  title: `Política de privacidad · ${LEGAL.appName}`,
  description: `Cómo ${LEGAL.appName} trata los datos de los recordatorios por WhatsApp.`,
};

export default function PrivacidadPage() {
  const mail = `mailto:${LEGAL.contactEmail}`;

  return (
    <main className={styles.page}>
      <h1>Política de privacidad</h1>
      <p className={styles.meta}>Última actualización: {LEGAL.lastUpdated}</p>

      <p className={styles.notice}>
        {LEGAL.appName} es un <strong>proyecto de demostración</strong> de un portfolio. No es un
        servicio comercial: solo se usa con datos de prueba y con personas que aceptaron
        participar en la demo.
      </p>

      <h2>Qué hace la aplicación</h2>
      <p>
        {LEGAL.appName} envía por WhatsApp confirmaciones y recordatorios de turnos, y permite que
        la persona confirme o cancele su turno respondiendo al mensaje.
      </p>

      <h2>Qué datos tratamos</h2>
      <ul>
        <li>Nombre y número de teléfono de WhatsApp de la persona con turno.</li>
        <li>Datos del turno: fecha, hora, servicio y estado (programado, confirmado, cancelado).</li>
        <li>Mensajes enviados y su estado de entrega (enviado, entregado, leído o fallido).</li>
        <li>Las respuestas que la persona envía al número de WhatsApp de la demo.</li>
      </ul>

      <h2>Para qué los usamos</h2>
      <p>
        Únicamente para enviar los mensajes del turno y registrar la respuesta de la persona. No
        enviamos publicidad, no vendemos ni compartimos los datos con terceros con fines
        comerciales y no los usamos para entrenar modelos ni elaborar perfiles.
      </p>

      <h2>Proveedores que intervienen</h2>
      <ul>
        <li>
          <strong>Meta (WhatsApp Business Platform)</strong>: entrega los mensajes.
        </li>
        <li>
          <strong>Supabase</strong>: base de datos donde se guardan turnos y mensajes.
        </li>
        <li>
          <strong>Vercel</strong>: alojamiento de la aplicación.
        </li>
        <li>
          <strong>Upstash (QStash)</strong>: programa el envío de los recordatorios. Solo recibe un
          identificador interno del mensaje, no datos personales.
        </li>
      </ul>

      <h2>Cuánto tiempo los conservamos</h2>
      <p>
        Mientras la demo esté activa. Los datos de prueba se borran periódicamente y en cualquier
        momento a pedido de la persona.
      </p>

      <h2>Tus derechos</h2>
      <p>
        Puedes pedir acceso, corrección o eliminación de tus datos escribiendo a{" "}
        <a href={mail}>{LEGAL.contactEmail}</a>. Más detalles en{" "}
        <Link href="/eliminacion-de-datos">instrucciones para eliminar tus datos</Link>.
      </p>

      <h2>Contacto</h2>
      <p>
        <a href={mail}>{LEGAL.contactEmail}</a>
      </p>
    </main>
  );
}
