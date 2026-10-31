import postgres from "postgres";
import { config } from "./config.ts";

export const sql = postgres(config.databaseUrl, {
  max: 10,
  onnotice: () => {},
  types: {
    // Keep `date` columns as YYYY-MM-DD strings instead of JS Dates (no TZ surprises).
    date: { to: 1082, from: [1082], serialize: (x: string) => x, parse: (x: string) => x },
    // numeric -> JS number (fine for money amounts and quantities).
    numeric: { to: 1700, from: [1700], serialize: (x: number) => String(x), parse: (x: string) => Number(x) },
  },
});

export type Sql = typeof sql;
/** A transaction handle or the pool; both support tagged-template queries. */
export type Tx = postgres.TransactionSql<{}> | Sql;
