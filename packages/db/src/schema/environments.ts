import { sql } from "drizzle-orm";
import { index, jsonb, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { companies } from "./companies.js";

export const environments = pgTable(
  "environments",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    description: text("description"),
    driver: text("driver").notNull().default("local"),
    status: text("status").notNull().default("active"),
    config: jsonb("config").$type<Record<string, unknown>>().notNull().default({}),
    metadata: jsonb("metadata").$type<Record<string, unknown>>(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    companyStatusIdx: index("environments_company_status_idx").on(table.companyId, table.status),
    companyDriverIdx: uniqueIndex("environments_company_driver_idx")
      .on(table.companyId, table.driver)
      .where(sql`${table.driver} = 'local'`),
    // One managed Kubernetes sandbox environment per company. Marker lives in
    // metadata (driver "sandbox" is shared with tenant-created sandboxes), so the
    // predicate is on the marker, not just the driver.
    companyManagedK8sIdx: uniqueIndex("environments_company_managed_k8s_idx")
      .on(table.companyId)
      .where(sql`${table.driver} = 'sandbox' AND ${table.metadata} ->> 'managedKubernetesSandbox' = 'true'`),
    companyNameIdx: index("environments_company_name_idx").on(table.companyId, table.name),
  }),
);
