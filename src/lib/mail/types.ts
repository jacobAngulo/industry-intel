// The mailbox reader of the newsletter inbox variant. The contract is in
// src/lib/connectors/types.ts (specification §6.2).
export type { MailReader } from "@/lib/connectors/types";

/** One message as MailReader.list returns it. */
export type MailMessage = Awaited<ReturnType<import("@/lib/connectors/types").MailReader["list"]>>["messages"][number];
