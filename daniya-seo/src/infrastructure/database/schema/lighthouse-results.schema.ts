/**
 * Legacy compatibility file. The physical table is now declared only in
 * lighthouse-reports.schema.ts. This file intentionally exports no table so
 * Drizzle Kit does not discover the same PostgreSQL table twice.
 */
export {};
