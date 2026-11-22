// The services layer: the only layer that pages and Server Actions call
// (specification §18).
//
// Error pattern (feeds, sources, add-source, settings, rejudge, activity):
// - Reads never throw for a missing row: they return null or an empty list.
// - Mutations validate their input with zod again (the caps of §14) and
//   throw a ServiceError for an expected failure. Its `code` is one of the
//   failure codes of ActionResult: 'validation' (with `fieldErrors`), 'not_found', 'conflict', or
//   'limit'. Any other error is a bug or an infrastructure failure.
// - A Server Action catches the error and returns `serviceFailure(error)`:
//     try { await createFeed(input, actor); return ok(undefined); }
//     catch (error) { return serviceFailure(error); }
//   serviceFailure maps a ServiceError to { ok: false, message, code,
//   fieldErrors } and throws any other error again.
export * from "./types";
export { ServiceError, isServiceError, serviceFailure, type ServiceErrorCode } from "./_manage-errors";
export * from "./feeds";
export * from "./sources";
export * from "./add-source";
export * from "./stories";
export * from "./feedback";
export * from "./analyses";
export * from "./digests";
export * from "./settings";
export * from "./keys";
export * from "./rejudge";
export * from "./status";
export * from "./activity";
export * from "./users";
