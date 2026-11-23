import type { Metadata } from "next";
import Link from "next/link";
import { LEGAL } from "@/lib/legal";
import styles from "../legal.module.css";

export const metadata: Metadata = {
  title: `Política de privacidad · ${LEGAL.appName}`,
  description: `Cómo ${LEGAL.appName} trata los datos de los recordatorios y del asistente con inteligencia artificial por WhatsApp.`,
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
        la persona confirme o cancele su turno respondiendo al mensaje. Además, cuando el negocio lo
        activa, un <strong>asistente con inteligencia artificial</strong> responde por WhatsApp las
        preguntas de los clientes (horarios, precios, ubicación…) y, si hace falta o la persona lo
        pide, la conversación pasa a una persona del equipo del negocio.
      </p>

      <h2>Qué datos tratamos</h2>
      <ul>
        <li>Nombre y número de teléfono de WhatsApp de la persona con turno.</li>
        <li>Datos del turno: fecha, hora, servicio y estado (programado, confirmado, cancelado).</li>
        <li>Mensajes enviados y su estado de entrega (enviado, entregado, leído o fallido).</li>
        <li>Las respuestas que la persona envía al número de WhatsApp de la demo.</li>
        <li>
          Si hablas con el asistente: el nombre de tu perfil de WhatsApp, el texto de tus mensajes y
          las respuestas que recibes, ya sean del asistente o de una persona del equipo.
        </li>
      </ul>

      <h2>Para qué los usamos</h2>
      <p>
        Para enviar los mensajes del turno, registrar la respuesta de la persona y, si usa el
        asistente, contestar sus consultas y permitir que el equipo del negocio continúe la
        conversación. No enviamos publicidad, no vendemos ni compartimos los datos con terceros con
        fines comerciales y nosotros no los usamos para entrenar modelos ni elaborar perfiles. Los
        proveedores de inteligencia artificial se rigen por sus propias condiciones; ver la sección
        siguiente.
      </p>

      <h2>Asistente con inteligencia artificial</h2>
      <ul>
        <li>
          Las respuestas del asistente las genera un modelo de inteligencia artificial y pueden
          contener errores. Para trámites o datos importantes, pide hablar con una persona: puedes
          pedirlo en cualquier momento (por ejemplo, escribiendo que quieres hablar con una persona).
        </li>
        <li>
          Para responder, enviamos al proveedor del modelo el texto de tus últimos mensajes (hasta
          12), un resumen de la conversación, los datos del negocio y, si tienes un turno
          próximo, su fecha y servicio. <strong>No enviamos tu número de teléfono ni tu nombre.</strong>
        </li>
        <li>
          Para buscar la información correcta, el texto de tu consulta se convierte en un vector
          numérico en otro proveedor, que también recibe los documentos que el negocio carga como
          base de conocimiento.
        </li>
        <li>
          Este proyecto usa planes gratuitos de esos proveedores. En ellos, el proveedor puede
          utilizar el contenido recibido para mejorar sus productos, según sus propias condiciones.
          Por eso te pedimos que <strong>no escribas datos sensibles</strong> (documentos de
          identidad, datos de salud, tarjetas o contraseñas) en la conversación con el asistente.
        </li>
        <li>
          Las personas del equipo del negocio pueden ver el historial de la conversación cuando la
          atienden.
        </li>
      </ul>

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
          <strong>Google (Gemini)</strong>: genera las respuestas del asistente a partir de los datos
          descritos arriba.
        </li>
        <li>
          <strong>Voyage AI</strong>: convierte textos (tu consulta y los documentos del negocio) en
          vectores para buscar información.
        </li>
        <li>
          <strong>Upstash (QStash)</strong>: programa el envío de los recordatorios. Solo recibe un
          identificador interno del mensaje, no datos personales.
        </li>
      </ul>

      <h2>Cuánto tiempo los conservamos</h2>
      <p>
        Mientras la demo esté activa. Las conversaciones con el asistente y las preguntas que no
        pudo responder se borran automáticamente a los 12 meses, y los registros técnicos de los
        mensajes recibidos, a los 30 días. Los datos de prueba se borran periódicamente y en
        cualquier momento a pedido de la persona; el propietario del negocio puede borrar todos los
        datos de un contacto desde el panel.
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
