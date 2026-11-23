import type { Metadata } from "next";
import { Suspense } from "react";
import { InboxView } from "./inbox-view";

export const metadata: Metadata = { title: "Conversaciones · RecordaYa" };

export default function InboxPage({ searchParams }: PageProps<"/panel/conversaciones">) {
  return (
    <Suspense fallback={<div className="h-96 animate-pulse rounded-2xl bg-surface-2" />}>
      <InboxView searchParams={searchParams} />
    </Suspense>
  );
}
