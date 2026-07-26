import { getSchema } from "better-auth/db";
import { apiKey } from "@better-auth/api-key";
const schema = getSchema({ plugins: [apiKey()] });
for (const [table, def] of Object.entries(schema)) {
  console.log(`\n## table key=${table} modelName=${def.modelName} order=${def.order}`);
  for (const [f, a] of Object.entries(def.fields)) {
    console.log(`  ${f}: type=${JSON.stringify(a.type)} required=${a.required} unique=${a.unique||false} fieldName=${a.fieldName} defaultValue=${typeof a.defaultValue} onUpdate=${typeof a.onUpdate} ref=${a.references?JSON.stringify(a.references):"-"} bigint=${a.bigint||false}`);
  }
}
