import type { Metadata } from "next";
import Link from "next/link";
import { Logo } from "@/components/logo";
import { ConfirmSession } from "./confirm-session";

export const metadata: Metadata = {
  title: "Verificando enlace · RecordaYa",
  robots: { index: false },
};

export default function ConfirmPage() {
  return (
    <main className="flex min-h-dvh items-center justify-center px-4 py-12 sm:px-8">
      <div className="animate-rise w-full max-w-sm">
        <Link href="/" className="mb-10 inline-block">
          <Logo />
        </Link>
        <ConfirmSession />
      </div>
    </main>
  );
}
